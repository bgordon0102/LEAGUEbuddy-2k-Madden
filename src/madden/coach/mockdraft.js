import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { getEffectiveFirstRoundOverrides } from '../pick_overrides_store.js';
import { buildLiveDraftContext } from './draft_live_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';

let currentCalendarYear = 2025;
const DRAFT_CLASS_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const CURRENT_CLASS_ID = 'CUS02';
// Utility: pick latest league snapshot
function getLatestLeagueFile() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files.length ? path.join(dir, files[0].f) : null;
}

// Build strength of schedule from schedule + standings
function buildSoS(league) {
  const teamInfo = league.teams?.leagueTeamInfoList || [];
  const standings = league.standings?.teamStandingInfoList || [];
  const schedule = league.schedule?.schedules || [];
  const weekly = league.weeklyStats || [];
  const teamById = Object.fromEntries(teamInfo.map(t => [t.teamId, t]));
  const record = Object.fromEntries(
    standings.map(t => [t.teamId, {
      w: t.totalWins,
      l: t.totalLosses,
      t: t.totalTies
    }])
  );

  const regGames = schedule.filter(g => g.status === 1 && g.stageIndex === 1); // regular season
  const gamesByTeam = {};
  for (const g of regGames) {
    const { homeTeamId: h, awayTeamId: a, homeScore: hs, awayScore: as } = g;
    gamesByTeam[h] = gamesByTeam[h] || [];
    gamesByTeam[a] = gamesByTeam[a] || [];
    gamesByTeam[h].push({ opp: a, result: hs > as ? 'W' : hs < as ? 'L' : 'T' });
    gamesByTeam[a].push({ opp: h, result: as > hs ? 'W' : as < hs ? 'L' : 'T' });
  }

  const sos = {};
  for (const tid of Object.keys(teamById).map(Number)) {
    const games = gamesByTeam[tid] || [];
    let oppW = 0, oppL = 0, oppT = 0;
    for (const g of games) {
      const rec = record[g.opp] || { w: 0, l: 0, t: 0 };
      let w = rec.w, l = rec.l, t = rec.t;
      // remove the head-to-head game
      if (g.result === 'W') l -= 1;
      else if (g.result === 'L') w -= 1;
      else t -= 1;
      oppW += w; oppL += l; oppT += t;
    }
    const denom = oppW + oppL + oppT;
    sos[tid] = denom ? oppW / denom : 0;
  }
  return sos;
}

// ---------- Playoff results derivation (mirrors creategamethreads logic) ----------
function scoreFromStats(weeklyEntry) {
  if (!weeklyEntry) return {};
  const scores = {};
  const add = (teamId, val) => {
    if (!teamId) return;
    scores[teamId] = (scores[teamId] || 0) + val;
  };
  const teamStats = weeklyEntry.teamstats?.teamStatInfoList || [];
  teamStats.forEach(ts => {
    if (!ts.teamId) return;
    if (ts.ptsFor !== undefined) add(ts.teamId, Number(ts.ptsFor));
    else if (ts.offPts !== undefined) add(ts.teamId, Number(ts.offPts));
  });
  const addList = (list, fn) => (list || []).forEach(p => fn(p));
  addList(weeklyEntry.rushing?.playerRushingStatInfoList, p => add(p.teamId, (Number(p.rushTDs || 0) * 6)));
  addList(weeklyEntry.receiving?.playerReceivingStatInfoList, p => add(p.teamId, (Number(p.recTDs || 0) * 6)));
  addList(weeklyEntry.defense?.playerDefensiveStatInfoList, p => add(p.teamId, (Number(p.defTDs || 0) * 6)));
  addList(weeklyEntry.kicking?.playerKickingStatInfoList, p => {
    add(p.teamId, (Number(p.fGMade || 0) * 3));
    add(p.teamId, (Number(p.xPMade || 0) * 1));
  });
  return scores;
}

function bestWeeklyEntry(weeklyStats, weekIdx) {
  const matches = (weeklyStats || []).filter(w =>
    Number(w.weekIndex ?? -1) === Number(weekIdx) &&
    Number(w.stage ?? w.stageIndex ?? 1) === 1
  );
  if (!matches.length) return null;
  return matches.reduce((best, curr) => {
    const currCount = curr.playerCount ?? 0;
    const bestCount = best?.playerCount ?? -1;
    return currCount > bestCount ? curr : best;
  }, null);
}

function scoresForWeek(weeklyStats, weekIdx) {
  const entry = bestWeeklyEntry(weeklyStats, weekIdx);
  return scoreFromStats(entry);
}

function wildcardPairs(seeds) {
  const s = [...seeds].sort((a, b) => a.seed - b.seed);
  if (s.length < 7) return [];
  return [
    { homeTeamId: s[1].teamId, awayTeamId: s[6].teamId },
    { homeTeamId: s[2].teamId, awayTeamId: s[5].teamId },
    { homeTeamId: s[3].teamId, awayTeamId: s[4].teamId },
  ];
}

function winnerFromPair(pair, scores, seedMap) {
  const h = pair.homeTeamId, a = pair.awayTeamId;
  const hs = scores[h]; const as = scores[a];
  if (hs != null || as != null) {
    if ((hs ?? -1) === (as ?? -1)) {
      const hsSeed = seedMap[h] ?? 99; const asSeed = seedMap[a] ?? 99;
      return hsSeed <= asSeed ? h : a;
    }
    return (hs ?? -Infinity) >= (as ?? -Infinity) ? h : a;
  }
  const hsSeed = seedMap[h] ?? 99; const asSeed = seedMap[a] ?? 99;
  return hsSeed <= asSeed ? h : a;
}

function losersFromPairs(pairs, scores, seedMap) {
  const out = [];
  for (const p of pairs) {
    const winner = winnerFromPair(p, scores, seedMap);
    const loser = (winner === p.homeTeamId) ? p.awayTeamId : p.homeTeamId;
    out.push(loser);
  }
  return out;
}

function buildDivisionalPairs(confSeeds, wcWinners) {
  const seedsSorted = [...confSeeds].sort((a, b) => a.seed - b.seed);
  const oneSeed = seedsSorted.find(s => s.seed === 1);
  const participants = [oneSeed, ...wcWinners.filter(Boolean)].filter(Boolean);
  for (const s of seedsSorted) {
    if (participants.length >= 4) break;
    if (!participants.find(p => p.teamId === s.teamId)) participants.push(s);
  }
  const sorted = participants.sort((a, b) => a.seed - b.seed);
  const pairs = [];
  while (sorted.length > 1) {
    const low = sorted.shift();
    const high = sorted.pop();
    if (!low || !high) break;
    pairs.push({ homeTeamId: high.teamId, awayTeamId: low.teamId });
  }
  return pairs;
}

function buildConferencePair(divWinners) {
  const sorted = [...divWinners].sort((a, b) => a.seed - b.seed);
  if (sorted.length < 2) return [];
  const high = sorted[0];
  const low = sorted[sorted.length - 1];
  return [{ homeTeamId: high.teamId, awayTeamId: low.teamId }];
}

function buildSuperBowlPair(afcChamp, nfcChamp) {
  if (!afcChamp || !nfcChamp) return [];
  return [{ homeTeamId: afcChamp.teamId, awayTeamId: nfcChamp.teamId }];
}

// Compute playoff seeds (1-7 per conference) from standings; falls back to record sorting when playoffStatus not set.
function computeSeedsByConference(standings) {
  const seedMap = {};
  const cmpRecord = (a, b) => {
    const wpA = (a.totalWins + a.totalLosses + a.totalTies) ? a.totalWins / (a.totalWins + a.totalLosses + a.totalTies) : 0;
    const wpB = (b.totalWins + b.totalLosses + b.totalTies) ? b.totalWins / (b.totalWins + b.totalLosses + b.totalTies) : 0;
    return wpB - wpA
      || b.totalWins - a.totalWins
      || a.totalLosses - b.totalLosses
      || (b.netPts || 0) - (a.netPts || 0)
      || (b.ptsFor || 0) - (a.ptsFor || 0);
  };

  const computeSeeds = (confName) => {
    const list = standings.filter(s => (s.conferenceName || '').toLowerCase().includes(confName));
    const playoffList = list.filter(s => (s.playoffStatus || s.playoff || 0) > 0);
    const pool = playoffList.length >= 7 ? playoffList : list;
    if (!list.length) return [];
    const byDiv = {};
    pool.forEach(t => {
      const div = t.divisionId || t.divisionName || 'div';
      byDiv[div] = byDiv[div] || [];
      byDiv[div].push(t);
    });
    const divWinners = Object.values(byDiv).map(arr => [...arr].sort(cmpRecord)[0]).filter(Boolean);
    const nonWinners = pool.filter(t => !divWinners.find(w => w.teamId === t.teamId));
    divWinners.sort(cmpRecord);
    nonWinners.sort(cmpRecord);
    const seeds = [...divWinners.slice(0, 4), ...nonWinners.slice(0, 3)].map((s, idx) => {
      seedMap[s.teamId] = idx + 1;
      return { teamId: s.teamId, seed: idx + 1, name: s.teamName };
    });
    return seeds;
  };

  const seedsByConf = {
    afc: computeSeeds('afc'),
    nfc: computeSeeds('nfc'),
  };
  return { seedsByConf, seedMap };
}

function loadPersistedPlayoffBuckets(league) {
  const file = path.join(process.cwd(), 'data', 'madden', 'playoff_results.json');
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const entry = raw?.[league?.leagueId] || raw?.[league?.info?.leagueId];
  if (!entry) return null;
  const standings = league?.standings?.teamStandingInfoList || [];
  const teamById = Object.fromEntries(standings.map(t => [t.teamId, t]));
  const buckets = { non: [], wc: [], div: [], conf: [], sbl: [], sbw: [] };
  (entry.wcLosers || []).forEach(id => teamById[id] && buckets.wc.push(teamById[id]));
  (entry.divLosers || []).forEach(id => teamById[id] && buckets.div.push(teamById[id]));
  (entry.confLosers || []).forEach(id => teamById[id] && buckets.conf.push(teamById[id]));
  if (entry.sbLoser && teamById[entry.sbLoser]) buckets.sbl.push(teamById[entry.sbLoser]);
  if (entry.sbWinner && teamById[entry.sbWinner]) buckets.sbw.push(teamById[entry.sbWinner]);
  const assigned = new Set([...buckets.wc, ...buckets.div, ...buckets.conf, ...buckets.sbl, ...buckets.sbw].map(t => t.teamId));
  standings.forEach(t => {
    if (!assigned.has(t.teamId)) buckets.non.push(t);
  });
  // minimal validity check
  const playoffCount = buckets.wc.length + buckets.div.length + buckets.conf.length + buckets.sbl.length + buckets.sbw.length;
  if (playoffCount === 0) return null;
  return buckets;
}

// Attempt to derive playoff buckets from seeds + weekly stats. Returns null if insufficient data.
function computePlayoffBuckets(league) {
  const standings = league?.standings?.teamStandingInfoList || [];
  const weeklyStats = league?.weeklyStats || [];
  if (!standings.length) return null;

  const { seedsByConf, seedMap } = computeSeedsByConference(standings);
  if (process.env.MOCK_DEBUG === 'true') {
    console.log('[PLAYOFF DEBUG] AFC seeds:', seedsByConf.afc.map(s => `${s.seed}:${s.name}`).join(', '));
    console.log('[PLAYOFF DEBUG] NFC seeds:', seedsByConf.nfc.map(s => `${s.seed}:${s.name}`).join(', '));
  }
  if (seedsByConf.afc.length < 7 || seedsByConf.nfc.length < 7) return null;

  const wcScores = scoresForWeek(weeklyStats, 19);
  const divScores = scoresForWeek(weeklyStats, 20);
  const confScores = scoresForWeek(weeklyStats, 21);
  const sbScores = scoresForWeek(weeklyStats, 22);
  const noScores = [wcScores, divScores, confScores, sbScores].every(s => !s || Object.keys(s).length === 0);
  const scoredTeams = new Set([
    ...Object.keys(wcScores || {}),
    ...Object.keys(divScores || {}),
    ...Object.keys(confScores || {}),
    ...Object.keys(sbScores || {}),
  ].map(Number));
  if (noScores || scoredTeams.size < 6) return null;

  const buckets = { non: [], wc: [], div: [], conf: [], sbl: [], sbw: [] };
  const wcPairsAFC = wildcardPairs(seedsByConf.afc);
  const wcPairsNFC = wildcardPairs(seedsByConf.nfc);
  const wcLosers = [
    ...losersFromPairs(wcPairsAFC, wcScores, seedMap),
    ...losersFromPairs(wcPairsNFC, wcScores, seedMap),
  ];
  const wcWinnersAFC = wcPairsAFC.map(p => winnerFromPair(p, wcScores, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));
  const wcWinnersNFC = wcPairsNFC.map(p => winnerFromPair(p, wcScores, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));

  const divPairsAFC = buildDivisionalPairs(seedsByConf.afc, wcWinnersAFC);
  const divPairsNFC = buildDivisionalPairs(seedsByConf.nfc, wcWinnersNFC);
  const divLosers = [
    ...losersFromPairs(divPairsAFC, divScores, seedMap),
    ...losersFromPairs(divPairsNFC, divScores, seedMap),
  ];
  const divWinnersAFC = divPairsAFC.map(p => winnerFromPair(p, divScores, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));
  const divWinnersNFC = divPairsNFC.map(p => winnerFromPair(p, divScores, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));

  const confPairAFC = buildConferencePair(divWinnersAFC);
  const confPairNFC = buildConferencePair(divWinnersNFC);
  const confLosers = [
    ...losersFromPairs(confPairAFC, confScores, seedMap),
    ...losersFromPairs(confPairNFC, confScores, seedMap),
  ];
  const afcChampId = confPairAFC.length ? winnerFromPair(confPairAFC[0], confScores, seedMap) : null;
  const nfcChampId = confPairNFC.length ? winnerFromPair(confPairNFC[0], confScores, seedMap) : null;

  const sbPair = buildSuperBowlPair(
    afcChampId ? { teamId: afcChampId, seed: seedMap[afcChampId] } : null,
    nfcChampId ? { teamId: nfcChampId, seed: seedMap[nfcChampId] } : null
  );
  const sbWinner = sbPair.length ? winnerFromPair(sbPair[0], sbScores, seedMap) : null;
  const sbLoser = sbPair.length ? (sbPair[0].homeTeamId === sbWinner ? sbPair[0].awayTeamId : sbPair[0].homeTeamId) : null;

  const playoffIds = new Set([
    ...seedsByConf.afc.map(s => s.teamId),
    ...seedsByConf.nfc.map(s => s.teamId),
  ]);
  const teamById = Object.fromEntries(standings.map(t => [t.teamId, t]));

  // Fill buckets
  for (const t of standings) {
    if (!playoffIds.has(t.teamId)) buckets.non.push(t);
  }
  wcLosers.forEach(id => teamById[id] && buckets.wc.push(teamById[id]));
  divLosers.forEach(id => teamById[id] && buckets.div.push(teamById[id]));
  confLosers.forEach(id => teamById[id] && buckets.conf.push(teamById[id]));
  if (sbLoser && teamById[sbLoser]) buckets.sbl.push(teamById[sbLoser]);
  if (sbWinner && teamById[sbWinner]) buckets.sbw.push(teamById[sbWinner]);

  // Any playoff team not bucketed goes to WC bucket as lowest confidence fallback
  const assigned = new Set([...buckets.wc, ...buckets.div, ...buckets.conf, ...buckets.sbl, ...buckets.sbw].map(t => t.teamId));
  const leftovers = standings.filter(t => playoffIds.has(t.teamId) && !assigned.has(t.teamId));
  leftovers.forEach(t => buckets.wc.push(t));

  return buckets;
}

// Regular-season fallback: build projected playoff buckets using current seeds (higher seeds advance each round).
function computeSeedBracketBuckets(league) {
  const standings = league?.standings?.teamStandingInfoList || [];
  if (!standings.length) return null;
  const { seedsByConf, seedMap } = computeSeedsByConference(standings);
  if (seedsByConf.afc.length < 7 || seedsByConf.nfc.length < 7) return null;

  const buckets = { non: [], wc: [], div: [], conf: [], sbl: [], sbw: [] };
  const playoffIds = new Set([
    ...seedsByConf.afc.map(s => s.teamId),
    ...seedsByConf.nfc.map(s => s.teamId),
  ]);
  const teamById = Object.fromEntries(standings.map(t => [t.teamId, t]));
  standings.forEach(t => { if (!playoffIds.has(t.teamId)) buckets.non.push(t); });

  const wcPairsAFC = wildcardPairs(seedsByConf.afc);
  const wcPairsNFC = wildcardPairs(seedsByConf.nfc);
  const wcLosers = [
    ...losersFromPairs(wcPairsAFC, {}, seedMap),
    ...losersFromPairs(wcPairsNFC, {}, seedMap),
  ];
  const wcWinnersAFC = wcPairsAFC.map(p => winnerFromPair(p, {}, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));
  const wcWinnersNFC = wcPairsNFC.map(p => winnerFromPair(p, {}, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));

  const divPairsAFC = buildDivisionalPairs(seedsByConf.afc, wcWinnersAFC);
  const divPairsNFC = buildDivisionalPairs(seedsByConf.nfc, wcWinnersNFC);
  const divLosers = [
    ...losersFromPairs(divPairsAFC, {}, seedMap),
    ...losersFromPairs(divPairsNFC, {}, seedMap),
  ];
  const divWinnersAFC = divPairsAFC.map(p => winnerFromPair(p, {}, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));
  const divWinnersNFC = divPairsNFC.map(p => winnerFromPair(p, {}, seedMap)).filter(Boolean).map(id => ({ teamId: id, seed: seedMap[id] }));

  const confPairAFC = buildConferencePair(divWinnersAFC);
  const confPairNFC = buildConferencePair(divWinnersNFC);
  const confLosers = [
    ...losersFromPairs(confPairAFC, {}, seedMap),
    ...losersFromPairs(confPairNFC, {}, seedMap),
  ];
  const afcChampId = confPairAFC.length ? winnerFromPair(confPairAFC[0], {}, seedMap) : null;
  const nfcChampId = confPairNFC.length ? winnerFromPair(confPairNFC[0], {}, seedMap) : null;

  const sbPair = buildSuperBowlPair(
    afcChampId ? { teamId: afcChampId, seed: seedMap[afcChampId] } : null,
    nfcChampId ? { teamId: nfcChampId, seed: seedMap[nfcChampId] } : null
  );
  const sbWinner = sbPair.length ? winnerFromPair(sbPair[0], {}, seedMap) : null;
  const sbLoser = sbPair.length ? (sbPair[0].homeTeamId === sbWinner ? sbPair[0].awayTeamId : sbPair[0].homeTeamId) : null;

  wcLosers.forEach(id => teamById[id] && buckets.wc.push(teamById[id]));
  divLosers.forEach(id => teamById[id] && buckets.div.push(teamById[id]));
  confLosers.forEach(id => teamById[id] && buckets.conf.push(teamById[id]));
  if (sbLoser && teamById[sbLoser]) buckets.sbl.push(teamById[sbLoser]);
  if (sbWinner && teamById[sbWinner]) buckets.sbw.push(teamById[sbWinner]);

  return buckets;
}

export function draftOrder(league) {
  const standings = league.standings?.teamStandingInfoList || [];
  const schedule = league.schedule?.schedules || [];
  const weekly = league.weeklyStats || [];

  const teams = standings.map(t => ({
    id: t.teamId,
    name: t.teamName,
    nick: t.teamNickName,
    w: t.totalWins,
    l: t.totalLosses,
    ties: t.totalTies,
    net: t.netPts || 0,
    pf: t.ptsFor || 0,
    playoff: t.playoffStatus || 0,
  }));
  const teamByName = Object.fromEntries(teams.map(t => [(t.name || '').toLowerCase(), t]));
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};

  // Derive playoff participation from weeklyStats when schedule is missing postseason games
  const weekTeams = {};
  for (const w of weekly.filter(w => (w.stage ?? w.stageIndex) > 1)) {
    const wk = w.weekIndex;
    const collect = (arr, key) => {
      (arr || []).forEach(p => {
        const tid = p[key];
        if (tid === undefined || tid === null) return;
        weekTeams[wk] = weekTeams[wk] || new Set();
        weekTeams[wk].add(Number(tid));
      });
    };
    collect(w.passing?.playerPassingStatInfoList, 'teamId');
    collect(w.rushing?.playerRushingStatInfoList, 'teamId');
    collect(w.receiving?.playerReceivingStatInfoList, 'teamId');
    collect(w.defense?.playerDefensiveStatInfoList, 'teamId');
  }
  const wcWeek = Math.min(...Object.keys(weekTeams).map(Number) || [Infinity]);
  const divWeek = wcWeek === Infinity ? Infinity : wcWeek + 1;

  // Base buckets from playoffStatus as fallback
  const elimBucket = Object.fromEntries(teams.map(t => [t.id, t.playoff || 0]));

  // Overlay with weeklyStats evidence (WC/Div)
  for (const t of teams) {
    const playedWc = wcWeek !== Infinity && weekTeams[wcWeek]?.has(Number(t.id));
    const playedDiv = divWeek !== Infinity && weekTeams[divWeek]?.has(Number(t.id));
    if (playedWc && !playedDiv) elimBucket[t.id] = 2;      // WC exit
    else if (playedDiv) elimBucket[t.id] = Math.max(elimBucket[t.id], 3); // alive past WC
  }

  // Prefer persisted playoff results (written by creategamethreads); else stats-derived; else fallback.
  let buckets = loadPersistedPlayoffBuckets(league);
  if (!buckets) {
    // Try stats-derived playoff buckets (may be null if postseason stats missing)
    buckets = computePlayoffBuckets(league);
  }
  // Regular-season fallback: project playoff bracket from current seeds so late picks use current playoff picture.
  const seasonWeekType = seasonInfo.seasonWeekType ?? league?.info?.seasonWeekType ?? league?.stage ?? 0;
  const isRegularSeason = Number(seasonWeekType) === 1;
  if (!buckets && isRegularSeason) {
    buckets = computeSeedBracketBuckets(league);
  }

  if (!buckets) {
    buckets = {
      non: [],
      wc: [],
      div: [],
      conf: [],
      sbl: [],
      sbw: [],
    };

    for (const t of teams) {
      const stage = elimBucket[t.id] || 0;
      if (stage === 0) buckets.non.push(t);
      else if (stage === 2) buckets.wc.push(t);
      else if (stage === 4) buckets.conf.push(t);      // conference losers (data marks 4)
      else if (stage === 3) buckets.div.push(t);       // div losers + (we will peel SB teams out next)
      else buckets.non.push(t); // fallback
    }

    // Split SB loser / winner out of DIV bucket (status=3) using best records as proxies.
    const divSortedBySeed = [...buckets.div].sort((a, b) => b.w - a.w || b.net - a.net || b.pf - a.pf);
    const sbTeams = divSortedBySeed.splice(0, 2); // top two = Super Bowl teams (ordering decided below)
    const sbSorted = sbTeams.sort((a, b) => {
      if (a.w !== b.w) return b.w - a.w;        // higher wins first -> SB loser
      if (a.net !== b.net) return b.net - a.net;
      return b.pf - a.pf;
    });
    buckets.sbl = sbSorted[0] ? [sbSorted[0]] : [];
    buckets.sbw = sbSorted[1] ? [sbSorted[1]] : [];
    buckets.div = divSortedBySeed; // remaining div losers
  }

  // Normalize bucket entries to the same team object shape (id/name/w/l/net/pf)
  const teamMapById = Object.fromEntries(teams.map(t => [Number(t.id), t]));
  const normalize = (arr) => arr
    .map(item => {
      if (!item) return null;
      if (item.id && teamMapById[item.id]) return teamMapById[item.id];
      if (item.teamId && teamMapById[item.teamId]) return teamMapById[item.teamId];
      return null;
    })
    .filter(Boolean);
  buckets = {
    non: normalize(buckets.non || []),
    wc: normalize(buckets.wc || []),
    div: normalize(buckets.div || []),
    conf: normalize(buckets.conf || []),
    sbl: normalize(buckets.sbl || []),
    sbw: normalize(buckets.sbw || []),
  };

  // Strength of schedule for tie-breaks
  const sos = buildSoS(league);
  const sortWithTies = (arr) => arr.sort((a, b) => {
    if (a.w !== b.w) return a.w - b.w;
    if (a.l !== b.l) return b.l - a.l;
    const sa = sos[a.id] ?? 0, sb = sos[b.id] ?? 0;
    if (sa !== sb) return sa - sb;
    if (a.net !== b.net) return a.net - b.net;
    if (a.pf !== b.pf) return a.pf - b.pf;
    return (a.name || '').localeCompare(b.name || '');
  });

  // Order: non -> WC -> DIV -> CONF -> SB loser -> SB winner
  const order = [
    ...sortWithTies(buckets.non),
    ...sortWithTies(buckets.wc),
    ...sortWithTies(buckets.div),
    ...sortWithTies(buckets.conf),
    ...buckets.sbl,
    ...buckets.sbw,
  ];

  return order.slice(0, 32);
}

// Pick trades/forfeitures (manual overrides)
function normalizeTeamKey(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function loadPickOverridesList(seasonYear) {
  const file = path.join(process.cwd(), 'data', 'madden', 'pick_overrides.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.overrides) ? raw.overrides : [];
    return list.filter(o =>
      (!o.year || Number(o.year) === Number(seasonYear)) &&
      (!o.round || Number(o.round) === 1) // only care about R1 for mock
    );
  } catch {
    return [];
  }
}

// Pick trades/forfeitures (manual overrides)
function applyPickTrades(order, seasonYear = currentCalendarYear) {
  const overrides = getEffectiveFirstRoundOverrides(seasonYear);
  const map = new Map();
  overrides.forEach(o => {
    const key = normalizeTeamKey(o.from || o.owner || '');
    if (!key) return;
    map.set(key, { owner: o.to || o.owner, via: o.via || (o.from && o.from.slice(0,3).toUpperCase()) });
  });

  return order.map(pick => {
    const key = normalizeTeamKey(pick.name || pick.nick || '');
    const o = map.get(key);
    return o ? { ...pick, name: o.owner, via: o.via } : pick;
  });
}

function loadDraftClass() {
  if (!fs.existsSync(DRAFT_CLASS_DIR)) return [];
  const files = fs.readdirSync(DRAFT_CLASS_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  if (!files.length) return [];

  const target = files
    .filter(f => f.toLowerCase().includes(CURRENT_CLASS_ID.toLowerCase()) && f.toLowerCase().includes('big board'))
    .sort()[0];
  if (!target) return [];

  const data = JSON.parse(fs.readFileSync(path.join(DRAFT_CLASS_DIR, target), 'utf8'));
  const players = Object.values(data).filter(p => p && p.name);
  players.sort((a, b) => (a.RNK || a.rank || a.order || 9999) - (b.RNK || b.rank || b.order || 9999));
  return players;
}

function normalizeName(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function seededRand(seedStr, salt, max) {
  const str = `${seedStr}|${salt}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % max;
}

function teamKey(name, nick) {
  if (nick) return normalizeName(nick);
  const parts = (name || '').trim().split(/\s+/);
  return normalizeName(parts[parts.length - 1] || name || '');
}

function resolveTeamNeedsMock(teamName, needsMap, altName) {
  const clean = (s) => normalizeName((s || '').replace(/\(via.*$/i, '').trim());
  const norm = clean(teamName);
  const mascotOnly = norm.split(/city|town|club/)[0] || norm;
  const variants = new Set([norm, mascotOnly]);
  if (altName) variants.add(clean(altName));

  const aliasMap = {
    patriots: 'newenglandpatriots',
    nepatriots: 'newenglandpatriots',
    ne: 'newenglandpatriots',
    '49ers': 'sanfrancisco49ers',
    sf49ers: 'sanfrancisco49ers',
    sf: 'sanfrancisco49ers',
    niners: 'sanfrancisco49ers',
    giants: 'newyorkgiants',
    nyg: 'newyorkgiants',
    buccaneers: 'tampabaybuccaneers',
    tb: 'tampabaybuccaneers',
    tbbuccaneers: 'tampabaybuccaneers',
    bucs: 'tampabaybuccaneers',
    vikings: 'minnesotavikings',
    min: 'minnesotavikings',
    dolphins: 'miamidolphins',
    mia: 'miamidolphins',
    jaguars: 'jacksonvillejaguars',
    jax: 'jacksonvillejaguars',
    chargers: 'losangeleschargers',
    lac: 'losangeleschargers',
  };
  for (const v of [...variants]) {
    const alias = aliasMap[v];
    if (alias) variants.add(alias);
  }

  for (const v of variants) {
    if (needsMap[v]) return needsMap[v];
  }
  for (const v of variants) {
    const entry = Object.entries(needsMap).find(([k]) => k.includes(v) || v.includes(k));
    if (entry) return entry[1];
  }
  // As a final fallback, try matching by mascot (last token)
  const mascot = clean(teamName).split(/[^a-z0-9]+/).filter(Boolean).pop();
  if (mascot) {
    const entry = Object.entries(needsMap).find(([k]) => k.endsWith(mascot) || k.includes(mascot));
    if (entry) return entry[1];
  }
  console.warn('[mockdraft] Needs fallback to BPA for', teamName, 'variants:', Array.from(variants));
  return ['BPA'];
}

function resolveTeamNeedProfileMock(teamName, profileMap, altName) {
  const clean = (s) => normalizeName((s || '').replace(/\(via.*$/i, '').trim());
  const norm = clean(teamName);
  const variants = new Set([norm]);
  if (altName) variants.add(clean(altName));

  const aliasMap = {
    patriots: 'newenglandpatriots',
    nepatriots: 'newenglandpatriots',
    ne: 'newenglandpatriots',
    '49ers': 'sanfrancisco49ers',
    sf49ers: 'sanfrancisco49ers',
    sf: 'sanfrancisco49ers',
    niners: 'sanfrancisco49ers',
    giants: 'newyorkgiants',
    nyg: 'newyorkgiants',
    buccaneers: 'tampabaybuccaneers',
    tb: 'tampabaybuccaneers',
    tbbuccaneers: 'tampabaybuccaneers',
    bucs: 'tampabaybuccaneers',
    vikings: 'minnesotavikings',
    min: 'minnesotavikings',
    dolphins: 'miamidolphins',
    mia: 'miamidolphins',
    jaguars: 'jacksonvillejaguars',
    jax: 'jacksonvillejaguars',
    chargers: 'losangeleschargers',
    lac: 'losangeleschargers',
  };
  for (const v of [...variants]) {
    const alias = aliasMap[v];
    if (alias) variants.add(alias);
  }
  for (const v of variants) {
    if (profileMap[v]) return profileMap[v];
  }
  for (const v of variants) {
    const entry = Object.entries(profileMap).find(([k]) => k.includes(v) || v.includes(k));
    if (entry) return entry[1];
  }
  const mascot = clean(teamName).split(/[^a-z0-9]+/).filter(Boolean).pop();
  if (mascot) {
    const entry = Object.entries(profileMap).find(([k]) => k.endsWith(mascot) || k.includes(mascot));
    if (entry) return entry[1];
  }
  return { needs: ['BPA'], scores: { BPA: 0 } };
}

function loadTeamEmojis() {
  const file = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

function formatTeamEmoji(teamName, emojiMap) {
  const parts = (teamName || '').toLowerCase().split(' ');
  const mascot = parts[parts.length - 1];
  const nick = parts.slice(1).join(' '); // handles things like "Green Bay Pack"
  const aliasMap = {
    'bolts': 'chargers',
    'phins': 'dolphins',
    'pack': 'packers',
    'jags': 'jaguars'
  };
  const keyList = [
    mascot,
    teamName?.toLowerCase(),
    nick,
    nick.replace(/\s+/g, ''),
    aliasMap[mascot],
    aliasMap[nick]
  ];
  const id = keyList.map(k => k && emojiMap[k]).find(Boolean);
  if (!id) return '';
  const name = mascot.replace(/[^a-z0-9]/g, '');
  return `<:${name}:${id}>`;
}

// --- Team needs heuristics ---
function deriveTeamNeedsDetailed(league) {
  const rosters = league.rosters?.teams || {};
  const teamInfo = league.teams?.leagueTeamInfoList || [];
  const teamInfoById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), t]));
  const nameById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), getFullTeamName(t, `Team ${t.teamId}`)]));
  const normNameById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), normalizeName(getFullTeamName(t, `Team ${t.teamId}`))]));
  const live = buildLiveDraftContext(league);
  const statsByTeamId = new Map(Object.entries(live.teamStatsByTeamId || {}).map(([k, v]) => [Number(k), v]));
  const statsByName = new Map(Object.entries(live.teamStatsByName || {}));
  const getTeamStat = (tid, teamName) => {
    const hit = statsByTeamId.get(Number(tid));
    if (hit) return hit;
    const norm = normalizeName(teamName || '');
    return statsByName.get(norm);
  };
  const standings = league.standings?.teamStandingInfoList || [];
  const pfMap = Object.fromEntries(standings.map(s => [Number(s.teamId), s.ptsFor || 0]));
  const netMap = Object.fromEntries(standings.map(s => [Number(s.teamId), s.netPts || 0]));
  const paMap = Object.fromEntries(standings.map(s => [Number(s.teamId), (s.ptsFor || 0) - (s.netPts || 0)]));
  const pfRank = Object.fromEntries([...standings]
    .sort((a, b) => (a.ptsFor || 0) - (b.ptsFor || 0))
    .map((t, i) => [Number(t.teamId), i + 1]));
  const paRank = Object.fromEntries([...standings]
    .sort((a, b) => ((b.ptsFor || 0) - (b.netPts || 0)) - ((a.ptsFor || 0) - (a.netPts || 0))) // highest PA worst
    .map((t, i) => [Number(t.teamId), i + 1]));
  // No more QB_FORCE_LIST or QB_LOCKED_LIST; all teams use dynamic QB need logic

  const needsByTeam = {};
  const baseByGroup = {
    QB: [82],               // keep QB special logic below; base used lightly
    OT: [84, 80],
    IOL: [82, 78, 74],
    EDGE: [85, 80],
    DT: [83, 78],
    LB: [82, 78],
    CB: [86, 82, 78],
    S: [83, 78],
    WR: [86, 82, 78],
    TE: [80],
    RB: [80],
  };
  const depthTarget = {
    QB: 2,
    RB: 3,
    WR: 5,
    CB: 5,
    TE: 3,
    OT: 4,
    IOL: 5,
    EDGE: 4,
    DT: 4,
    LB: 4,
    S: 4,
    OTHER: 0,
  };
  const positionGroup = (pos = '') => {
    const p = pos.toUpperCase();
    if (p === 'QB') return 'QB';
    if (['LT', 'RT'].includes(p)) return 'OT';
    if (['LG', 'C', 'RG'].includes(p)) return 'IOL';
    if (p.includes('EDGE') || ['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'LEDGE', 'REDGE', 'DE', 'RDE', 'LDE'].includes(p)) return 'EDGE';
    if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(p)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(p)) return 'LB';
    if (['CB'].includes(p)) return 'CB';
    if (['FS', 'SS'].includes(p)) return 'S';
    if (['TE'].includes(p)) return 'TE';
    if (['WR'].includes(p)) return 'WR';
    if (['HB', 'RB', 'FB'].includes(p)) return 'RB';
    return 'OTHER';
  };
  const getMetricOvr = (p) => p.playerBestOvr ?? p.teamSchemeOvr ?? p.overallRating ?? p.playerSchemeOvr ?? 0;
  const getYearsLeft = (p) => p.contractYearsLeft ?? p.contractLength ?? 0;
  const getYearsPro = (p) => p.yearsPro ?? p.experience ?? p.playerExperience ?? p.playerYearsPro ?? 0;
  const getAge = (p) => p.age ?? p.playerAge ?? 99;

  for (const [tidStr, roster] of Object.entries(rosters)) {
    const tid = Number(tidStr);
    const players = roster?.rosterInfoList || [];
    const byGroup = {};
    for (const p of players) {
      const g = positionGroup(p.position);
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(p);
    }
    const teamNameKey = nameById[tid] || tidStr;
    // Calculate average OVR or depth for each group
    const groupStats = {};
    const topCache = {}; // store top metrics per group for later need suppression
    const getTop = (group, n = 2) => {
      if (topCache[group]) return topCache[group];
      const arr = (byGroup[group] || []).map(p => ({
        ovr: getMetricOvr(p),
        age: getAge(p),
        yearsPro: getYearsPro(p),
        yearsLeft: getYearsLeft(p),
      }));
      const top = arr.sort((a, b) => b.ovr - a.ovr).slice(0, n);
      topCache[group] = top;
      return top;
    };
    const allGroups = ['QB', 'OT', 'IOL', 'EDGE', 'DT', 'LB', 'CB', 'S', 'WR', 'TE', 'RB'];
    for (const group of allGroups) {
      const groupPlayers = byGroup[group] || [];
      if (group === 'OL') {
        // For OL, combine all OL positions
        const olPositions = ['LT', 'LG', 'C', 'RG', 'RT'];
        const olPlayers = players.filter(p => olPositions.includes((p.position || '').toUpperCase()));
        groupStats['OL'] = {
          count: olPlayers.length,
          avgOvr: olPlayers.length ? olPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / olPlayers.length : 0
        };
        continue;
      }
      if (group === 'RB') {
        // For RB, include HB, RB, FB
        const rbPlayers = players.filter(p => ['HB', 'RB', 'FB'].includes((p.position || '').toUpperCase()));
        groupStats['RB'] = {
          count: rbPlayers.length,
          avgOvr: rbPlayers.length ? rbPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / rbPlayers.length : 0
        };
        continue;
      }
      groupStats[group] = {
        count: groupPlayers.length,
        avgOvr: groupPlayers.length ? groupPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / groupPlayers.length : 0
      };
      // cache top for later
      getTop(group);
    }

    // Dynamic QB need logic (consider starter quality, depth, age, contract)
    let qbNeed = false;
    let qbSeverity = 0; // 0 = no need, 30-59 = depth/mid, 60+ = glaring
    const qbPlayers = (byGroup['QB'] || []).sort((a, b) => getMetricOvr(b) - getMetricOvr(a));
    const bestQB = qbPlayers[0];
    const secondQB = qbPlayers[1];
    const bestOvr = bestQB ? getMetricOvr(bestQB) : 0;
    const secondOvr = secondQB ? getMetricOvr(secondQB) : 0;
    const qbCount = qbPlayers.length;
    const bestYearsPro = bestQB ? getYearsPro(bestQB) : 99;
    if (qbCount === 0) {
      qbNeed = true; qbSeverity = 100;
    } else {
      const yearsLeft = bestQB ? getYearsLeft(bestQB) : 0;
      const age = bestQB?.age ?? 0;
      const isRookieOrSoph = bestYearsPro <= 2;

      // Rookie/sophomore guard: if top QB is young (<=2 years pro) and at least 70 OVR, treat QB as depth-only (avoid 1R QB).
      if (isRookieOrSoph && bestOvr >= 70) {
        qbNeed = false; qbSeverity = 25; // depth flag only
      } else {

      // Franchise lockouts (young/prime starters with term)
      if (bestOvr >= 88 && yearsLeft >= 2 && age <= 31) {
        qbNeed = false; qbSeverity = 0;
      } else if (bestOvr >= 85 && yearsLeft >= 2 && age <= 30 && secondOvr >= 68) {
        qbNeed = false; qbSeverity = 20; // depth only
      } else if (bestOvr >= 83 && yearsLeft >= 2 && age <= 31 && secondOvr >= 70) {
        qbNeed = false; qbSeverity = 30; // depth only
      } else if (bestOvr >= 82 && yearsLeft >= 2 && age <= 33 && secondOvr >= 72) {
        qbNeed = false; qbSeverity = 35; // depth only
      } else if (bestOvr >= 80 && yearsLeft >= 2 && age <= 33 && secondOvr >= 70) {
        qbNeed = false; qbSeverity = 40; // depth only
      } else if (bestOvr >= 78 && yearsLeft >= 3 && age <= 25 && secondOvr >= 68) {
        qbNeed = false; qbSeverity = 25; // young starter with runway; depth only
      } else {
        // Solid starter but thin depth (keep QB as depth need, not top)
        if (bestOvr >= 82 && yearsLeft >= 2 && age <= 30) {
          qbNeed = false; qbSeverity = 45; // depth flag
        } else {
        // Needs or aging/weak depth scenarios
        qbNeed = true;
        qbSeverity = 70;
        if (bestOvr < 75) qbSeverity += 20;
        if (secondOvr < 70) qbSeverity += 15;
        if (yearsLeft <= 1) qbSeverity += 25; // expiring deal elevates urgency
        if (age >= 32) qbSeverity += 10;
        qbSeverity = Math.min(100, qbSeverity);
        }
      }
      }
    }

    // For each group, create a "need score" (higher score = higher need)
    const needScores = allGroups.map(group => {
      const stat = groupStats[group];
      const top = getTop(group, 5);
      const top1 = top[0] || { ovr: 0, age: 99 };
      const top2 = top[1] || { ovr: 0, age: 99 };
      const bases = baseByGroup[group] || [];
      let score = 0;

      // Slot-based baselines (starters)
      bases.forEach((base, idx) => {
        const slot = top[idx];
        if (!slot) score += 30 + base * 0.5; // missing starter
        else {
          const diff = base - (slot.ovr || 0);
          if (diff > 0) score += diff * 2;
        }
      });

      // Depth pressure toward target room size
      const depthGoal = depthTarget[group] ?? 0;
      if (depthGoal && (stat.count || 0) < depthGoal) {
        score += (depthGoal - (stat.count || 0)) * 6;
      }

      // Light cushion for very weak rooms
      if ((stat.avgOvr || 0) < 72) score += 8;
      if ((stat.avgOvr || 0) < 68) score += 8;

      // QB special handling
      if (group === 'QB') {
        const topOvr = top1.ovr || 0;
        const top2 = top[1] || { ovr: 0, age: 99 };
        const topYears = top1 ? (top1.yearsPro ?? top1.yp ?? 99) : 99;
        const topAge = top1 ? (top1.age ?? 99) : 99;
        const rookieGuard = (topYears <= 2 || topAge <= 24) && topOvr >= 70; // keep rookie/soph (or young) 70+ as depth-only

        if (stat.count === 0) {
          score += 200; // no QBs: high urgency
        } else {
          if (topOvr < 78) {
            score += 120 + (78 - topOvr) * 2 + Math.max(0, 70 - top2.ovr);
          } else if (topOvr < 82 && top2.ovr < 75) {
            score += 100 + (82 - topOvr) + Math.max(0, 75 - top2.ovr);
          } else if (topOvr < 80) {
            score += 60 + (80 - topOvr);
          } else {
            score -= 200; // strong enough room
          }
        }
        if (qbNeed) score += 40;
        if (qbSeverity >= 30 && !qbNeed) score -= 40; // depth-only
        if (rookieGuard) score -= 200; // rookie/soph 70+ starter guard
        // Cap QB score to avoid dominating when roster isn't empty
        if (stat.count > 0 && score > 120) score = 120;
      }

      // RB rushing performance nudge
      if (group === 'RB') {
        const ts = getTeamStat(tid, teamNameKey) || {};
        const rushYds = ts.rush?.yds ?? ts.rushYds;
        const rushAtt = ts.rush?.att ?? ts.rushAtt;
        const rushTD = ts.rush?.td ?? ts.rushTDs;
        const ypc = rushAtt ? (rushYds || 0) / Math.max(1, rushAtt) : null;
        if (rushYds !== undefined && rushYds < 1400) score += 8;
        if (ypc !== null && ypc < 3.9) score += 10;
        if (rushTD !== undefined && rushTD < 10) score += 6;
        if ((stat.avgOvr || 0) < 73) score += 10;
        if ((stat.count || 0) < 2) score += 6;
      }

      // DT depth expectations
      if (group === 'DT') {
        const depth = stat.count || 0;
        const startersAvg = (top1.ovr + top2.ovr) / (top1.ovr && top2.ovr ? 2 : 1);
        // prioritize starter quality first
        if (startersAvg >= 82) score -= 16;
        else if (startersAvg >= 78) score -= 8;
        else if (startersAvg < 75) score += 20;
        // slight baseline push so DT needs still surface
        score += 8;
        // depth: expect 3 DTs active, 4 is great
        if (depth < 2) score += 26;
        else if (depth === 2) score += 12;
        else if (depth === 3) score += 6;
        const paR = paRank[tid];
        if (paR && paR <= 10) score += 8;
        else if (paR && paR >= 24) score -= 6;
      }

      // EDGE production dampening
      if (group === 'EDGE') {
        const depth = stat.count || 0;
        const startersAvg = (top1.ovr + top2.ovr) / (top1.ovr && top2.ovr ? 2 : 1);
        // soften previous dampening; focus on starter quality
        if (startersAvg >= 82) score -= 15;
        else if (startersAvg >= 78) score -= 8;
        else if (startersAvg < 74) score += 16;
        // depth expectations: 4 EDGE is healthy
        if (depth >= 5) score -= 10;
        else if (depth === 4) score -= 4;
        else if (depth === 3) score += 8;
        else if (depth <= 2) score += 18;
        const ts = getTeamStat(tid, teamNameKey);
        const teamSacks = ts?.def?.sacks;
        const leadSacks = ts?.leaders?.defSacks?.val;
        if (teamSacks !== undefined) {
          if (teamSacks >= 42) score -= 12;
          else if (teamSacks >= 36) score -= 6;
          else if (teamSacks <= 28) score += 8;
        }
        if (leadSacks !== undefined && leadSacks >= 10) score -= 8;
      }

      // Young-core suppression: established young starters should not keep surfacing as needs.
      const top1YearsLeft = top1.yearsLeft ?? 0;
      const top2YearsLeft = top2.yearsLeft ?? 0;
      const top1YearsPro = top1.yearsPro ?? 99;
      const top2YearsPro = top2.yearsPro ?? 99;
      const youngStar = top1.ovr >= 88 && top1.age <= 28 && top1YearsLeft >= 2;
      const youngDuo = top1.ovr >= 82 && top2.ovr >= 78 && top1.age <= 27 && top2.age <= 27 && top1YearsLeft >= 2 && top2YearsLeft >= 2;
      const establishedYoungStarter = top1.ovr >= 76 && top1.age <= 24 && top1YearsPro <= 2 && top1YearsLeft >= 2;
      const establishedPrimeStarter = top1.ovr >= 82 && top1.age <= 29 && top1YearsLeft >= 2;
      const stableStarter = top1.ovr >= 80 && top1.age <= 30 && top1YearsLeft >= 2;
      if (group === 'OT') {
        if (youngDuo) score -= 999;
        else if (youngStar && top2.ovr >= 75) score -= 400;
      }
      if (group === 'IOL') {
        if (youngDuo) score -= 300;
        else if (youngStar) score -= 180;
      }
      if (group === 'WR' || group === 'CB' || group === 'EDGE') {
        if (youngDuo) score -= 220;
        else if (youngStar) score -= 140;
      }
      if (group === 'DT' || group === 'LB' || group === 'S' || group === 'TE') {
        if (youngDuo) score -= 160;
        else if (youngStar) score -= 110;
      }
      if (group === 'RB') {
        if (top1.ovr >= 82 && top1.age <= 27) score -= 200;
      }
      if (group === 'TE') {
        if (establishedYoungStarter) score -= 260;
        else if (stableStarter) score -= 180;
      }
      if (group === 'RB') {
        if (establishedYoungStarter) score -= 180;
      }
      if (group === 'WR' || group === 'CB' || group === 'S') {
        if (establishedPrimeStarter && top2.ovr >= 74) score -= 90;
      }
      if (group === 'LB' || group === 'DT') {
        if (establishedPrimeStarter && top2.ovr >= 72) score -= 70;
      }

      // Depth-aware bump for CB/WR (carry ~5, start 3)
      if (group === 'CB' || group === 'WR') {
        const depth = stat.count || 0;
        const starts = 3, room = 5;
        if (depth < starts) score += 25;
        else if (depth < room) score += (room - depth) * 6;
      }
      // Premium position emphasis: elevate OT and EDGE slightly; modest nudge for DT so it still surfaces
      if (group === 'OT') score += 10;
      if (group === 'EDGE') score += 10;
      if (group === 'DT') score += 4;

      return { group, score };
    });
    // Sort by highest need (lowest avgOvr, lowest count, QB lockout)
    needScores.sort((a, b) => b.score - a.score);
    // Take top 5 needs
  let needs = needScores.slice(0, 5).map(n => n.group);
  // If QB is present but not #1 and QB score is close to top, consider moving it up (avoid QB buried by edge depth tweaks)
  const qbEntry = needScores.find(n => n.group === 'QB');
  if (qbEntry && needs[0] !== 'QB') {
    const topScore = needScores[0].score;
    if (qbEntry.score >= topScore - 8) {
      // promote QB to top
      const filtered = needs.filter(n => n !== 'QB');
      filtered.unshift('QB');
      while (filtered.length < 5) filtered.push('BPA');
      needs.length = 0;
      needs.push(...filtered.slice(0,5));
    }
  }
    // Normalize team name for consistent lookup
    const teamNameNorm = (nameById[tid] || tidStr).toLowerCase().replace(/[^a-z0-9]/g, '');
    const info = teamInfoById[tid] || {};
    const aliasKeys = new Set([
      teamNameNorm,
      normalizeName(info.nickName || ''),
      normalizeName(info.cityName || ''),
      normalizeName(info.displayName || ''),
      normalizeName(info.abbrName || ''),
    ].filter(Boolean));
    const scoreMap = Object.fromEntries(needScores.map(({ group, score }) => [group, score]));
    const profile = {
      needs: [...needs],
      scores: scoreMap,
    };
    aliasKeys.forEach(k => { if (k) needsByTeam[k] = profile; });
  }
  return needsByTeam;
}

function deriveTeamNeeds(league) {
  const profiles = deriveTeamNeedsDetailed(league);
  return Object.fromEntries(Object.entries(profiles).map(([key, profile]) => [key, profile?.needs || ['BPA']]));
}

function prospectGroup(player) {
  const pos = (player.position || player.position_1 || '').toUpperCase().trim();
  if (pos === 'QB') return 'QB';
  if (['LT', 'RT'].includes(pos)) return 'OT';
  if (['LG', 'RG', 'C'].includes(pos)) return 'IOL';
  if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(pos)) return 'EDGE';
  if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
  if (pos === 'CB') return 'CB';
  if (['FS', 'SS'].includes(pos)) return 'S';
  if (pos === 'TE') return 'TE';
  if (pos === 'WR') return 'WR';
  if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
  return 'BPA';
}

function premiumPositionValue(group) {
  const values = {
    QB: 10,
    OT: 8,
    EDGE: 8,
    CB: 7,
    WR: 7,
    IOL: 5,
    DT: 5,
    S: 5,
    LB: 4,
    TE: 2,
    RB: 1,
    BPA: 0,
  };
  return values[group] || 0;
}

export const data = new SlashCommandBuilder()
  .setName('madden-mockdraft')
  .setDescription('Show a mock draft for the top 32 picks using current standings and the active draft class');

export async function execute(interaction) {
  // Defer immediately to avoid interaction timeout; use flags for ephemeral-like behavior
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const leagueFile = getLatestLeagueFile();
  if (!leagueFile) {
    const payload = { content: 'No league snapshot found in data/madden/leagues.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const league = JSON.parse(fs.readFileSync(leagueFile, 'utf8'));
  currentCalendarYear = league?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || league?.info?.calendarYear
    || league?.calendarYear
    || 2025;
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  const isRegularOrPost = weekType === 1 || weekType === 2;
  const draftYear = isRegularOrPost
    ? Number(currentCalendarYear) + 1
    : Number(currentCalendarYear || 2025);
  const rawOrder = draftOrder(league);
  const order = applyPickTrades(rawOrder, draftYear);
  const needProfiles = deriveTeamNeedsDetailed(league);
  const needs = Object.fromEntries(Object.entries(needProfiles).map(([key, profile]) => [key, profile?.needs || ['BPA']]));
  const prospects = loadDraftClass();
  if (!prospects.length) {
    const payload = { content: 'No Madden draft class found.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const emojis = loadTeamEmojis();

  // Assign players based on team needs with light reach logic
  const available = [...prospects];
  const picks = [];
  let pickNumber = 1;
  let qbTop5Count = 0;
  const unmetNeedsMap = new Map(); // track remaining needs per team across multiple 1st-rounders
   // Track positions already taken in R1 for each team to avoid double-dip unless forced
  const pickedGroupsMap = new Map();
  for (const team of order) {
    const teamNameNorm = normalizeName(team.name || '');
    const teamKeyNorm = teamKey(team.name, team.nick);
    const remainingPicksForTeam = order.slice(pickNumber).filter(t => teamKey(t.name, t.nick) === teamKeyNorm).length;
    const teamProfile = resolveTeamNeedProfileMock(team.name || '', needProfiles, team.nick);
    let teamNeeds = teamProfile?.needs || resolveTeamNeedsMock(team.name || '', needs, team.nick);
    if (!teamNeeds.length) teamNeeds = ['BPA'];
    const needScoreMap = teamProfile?.scores || {};
    const needSeverity = (group) => Math.max(0, Number(needScoreMap[group] || 0));

    let hasQBNeed = teamNeeds.includes('QB');
    // Persistent unmet needs (avoid double-dipping when a team owns multiple R1 picks)
    let unmetNeeds = unmetNeedsMap.get(teamKeyNorm) || unmetNeedsMap.get(teamNameNorm);
    if (!unmetNeeds) {
      unmetNeeds = new Set(teamNeeds.filter(n => n !== 'BPA'));
      unmetNeedsMap.set(teamKeyNorm, unmetNeeds);
    }
    let pickedGroups = pickedGroupsMap.get(teamKeyNorm) || pickedGroupsMap.get(teamNameNorm);
    if (!pickedGroups) {
      pickedGroups = new Set();
      pickedGroupsMap.set(teamKeyNorm, pickedGroups);
    }

    let bestIdx = -1;
    let bestScore = Infinity;

    // If QB is the top need, heavily bias to take the best available QB very early.
    const qbTopNeed = hasQBNeed && teamNeeds[0] === 'QB';

    // Candidate pool within board window and needs
    const bpaOnly = teamNeeds.length === 1 && teamNeeds[0] === 'BPA';
    const boardWindow =
      pickNumber <= 5 ? 15 :
      pickNumber <= 10 ? 18 :
      pickNumber <= 16 ? 22 :
      pickNumber <= 24 ? 28 :
      32;

    const candidateIndices = [];
    const firstQBIndex = available.findIndex(p => prospectGroup(p) === 'QB');
    const bestQBIndexAny = firstQBIndex;
    const effectiveNeeds = unmetNeeds.size ? unmetNeeds : null;
    const openSlots = effectiveNeeds?.size || (teamNeeds.length > 1 && !bpaOnly);
    for (let i = 0; i < available.length; i++) {
      if (i >= boardWindow + 10) break;
      const p = available[i];
      const g = prospectGroup(p);
      const tempOv = Number(p.overall ?? p.ovr ?? p.rating ?? p.OVR ?? 0);
      if (g === 'QB' && !hasQBNeed) continue;
      if (g === 'QB' && qbTop5Count >= 2 && pickNumber <= 5) continue;
      const severity = needSeverity(g);
      const isTopNeed = teamNeeds.slice(0, 3).includes(g);
      const eliteTalent = i < 6 || tempOv >= 84;
      const inPrimaryWindow = i < boardWindow;
      if (!inPrimaryWindow && !(isTopNeed && severity >= 65) && !(g === 'QB' && qbTopNeed && severity >= 75) && !eliteTalent) continue;
      if (pickNumber <= 12 && !inPrimaryWindow && !eliteTalent) continue;
      if (pickNumber <= 10 && ['RB', 'TE'].includes(g) && severity < 85 && tempOv < 82) continue;
      if (g !== 'QB' && pickedGroups.has(g) && openSlots) continue;
      candidateIndices.push(i);
    }
    if (qbTopNeed && firstQBIndex !== -1 && pickNumber <= 10 && !candidateIndices.includes(firstQBIndex)) {
      candidateIndices.push(firstQBIndex);
    }
    if (!hasQBNeed) {
      for (let k = candidateIndices.length - 1; k >= 0; k--) {
        if (prospectGroup(available[candidateIndices[k]]) === 'QB') {
          candidateIndices.splice(k, 1);
        }
      }
    }

    // Soft preference handled in scoring; no hard lock

    for (const i of candidateIndices) {
      const p = available[i];
      const g = prospectGroup(p);
      const overallVal = Number(p.overall ?? p.ovr ?? p.rating ?? p.OVR ?? 0);
      const severity = needSeverity(g);
      const needRank = teamNeeds.indexOf(g);
      const needRankBonus = needRank === 0 ? 22 : needRank === 1 ? 16 : needRank === 2 ? 10 : needRank >= 0 ? 4 : 0;
      const premiumBonus = premiumPositionValue(g) * 2.5;
      const boardValue = i * 6;
      const slideValue = Math.max(0, pickNumber - (i + 1)) * 8;
      let score = boardValue - slideValue - needRankBonus - (severity * 0.7) - premiumBonus;

      if (effectiveNeeds?.has(g)) score -= 18;
      else if (effectiveNeeds?.size) score += overallVal >= 84 && i < 6 ? 4 : 22;

      if (g !== 'QB' && pickedGroups.has(g) && effectiveNeeds?.size > 1) score += 30;
      if (remainingPicksForTeam > 0 && effectiveNeeds?.size > 1 && teamNeeds[0] === g) score -= 8;
      if (remainingPicksForTeam > 0 && effectiveNeeds?.size > 1 && !effectiveNeeds.has(g)) score += 12;

      if (pickNumber <= 12 && ['RB', 'TE'].includes(g)) {
        score += overallVal >= 84 && severity >= 90 ? 8 : 38;
      }
      if (pickNumber <= 8 && g === 'IOL' && severity < 85) score += 16;
      if (pickNumber <= 8 && g === 'LB' && severity < 82) score += 12;

      if (g === 'QB') {
        if (qbTopNeed) score -= 34;
        else score += pickNumber <= 12 ? 18 : 8;
        if (!hasQBNeed) score += 1000;
      }

      if (overallVal >= 80) score -= 22;
      if (overallVal >= 84) score -= 10;
      if (overallVal < 74 && !effectiveNeeds?.has(g)) score += 18;
      if (g === 'DT' && effectiveNeeds?.has('DT') && overallVal < 74) score += 10;

      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const qbEliteCandidate = (() => {
      const qbIndices = candidateIndices.filter(idx => prospectGroup(available[idx]) === 'QB');
      if (!qbIndices.length && qbTopNeed && firstQBIndex !== -1) qbIndices.push(firstQBIndex);
      if (!qbIndices.length) return { idx: undefined, ovr: 0 };
      qbIndices.sort((a, b) => {
        const ovrA = Number(available[a].overall ?? available[a].ovr ?? 0);
        const ovrB = Number(available[b].overall ?? available[b].ovr ?? 0);
        if (ovrB !== ovrA) return ovrB - ovrA;
        return a - b;
      });
      const idx = qbIndices[0];
      const ovr = Number(available[idx].overall ?? available[idx].ovr ?? 0);
      return { idx, ovr };
    })();
    const qbOverrideOvrReq = 83;
    if (qbTopNeed && hasQBNeed && pickNumber <= 8 && qbEliteCandidate.ovr >= qbOverrideOvrReq && qbEliteCandidate.idx !== undefined) {
      bestIdx = qbEliteCandidate.idx;
      bestScore = -999;
    }

    // If no candidate (e.g., thin needs), allow BPA or best QB if still needed
    if (bestIdx === -1 && available.length) {
      if (hasQBNeed && bestQBIndexAny !== -1) bestIdx = bestQBIndexAny;
      else bestIdx = 0;
    }

    // If no valid pick found (e.g., all QBs but team doesn't need QB), pick first non-QB
    let chosen;
    if (bestIdx !== -1) {
      chosen = available.splice(bestIdx, 1)[0];
    } else {
      // fallback: pick first available non-QB
      const fallbackIdx = available.findIndex(p => prospectGroup(p) !== 'QB');
      chosen = fallbackIdx !== -1 ? available.splice(fallbackIdx, 1)[0] : available.shift();
      // If still none and team still needs QB, take best QB available
      if (!chosen && hasQBNeed && bestQBIndexAny !== -1) {
        chosen = available.splice(bestQBIndexAny, 1)[0];
      }
    }
    if (chosen && pickNumber <= 5 && prospectGroup(chosen) === 'QB') {
      qbTop5Count += 1;
    }
    // Need-rescue: if we picked outside unmet needs and a need candidate is close, swap
    if (effectiveNeeds && chosen) {
      const chosenGroup = prospectGroup(chosen);
      if (!effectiveNeeds.has(chosenGroup)) {
        const rescueIdx = available.findIndex((p, idx) =>
          idx < 35 && effectiveNeeds.has(prospectGroup(p)));
        if (rescueIdx !== -1) {
          const swapIn = available.splice(rescueIdx, 1)[0];
          available.splice(bestIdx >= 0 ? bestIdx : 0, 0, chosen); // put chosen back near previous slot
          chosen = swapIn;
        }
      }
    }
    // Mark need as satisfied to prevent double-dip on later R1 picks
    const chosenGroup = prospectGroup(chosen);
    if (chosenGroup && unmetNeeds.has(chosenGroup)) unmetNeeds.delete(chosenGroup);
    if (chosenGroup) pickedGroups.add(chosenGroup);

    const emoji = formatTeamEmoji(team.name, emojis);
    const pos = chosen?.position || chosen?.position_1 || '';
    const school = chosen?.school || chosen?.College || chosen?.college || 'N/A';
    const via = team.via ? ` (via ${team.via})` : '';
    const line = `${picks.length + 1}. ${emoji ? emoji + ' ' : ''}${team.name}${via} — ${pos || 'POS'} ${chosen?.name || 'TBD'} — ${school}`;
      picks.push(line);
      pickNumber += 1;

    }

  const embed = new EmbedBuilder()
    .setTitle('Madden Mock Draft (Picks 1–32)')
    .setDescription(picks.join('\n'))
    .setColor(0x1e90ff)
    .setFooter({ text: `Snapshot: ${path.basename(leagueFile)}` });

  const payload = { embeds: [embed] };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, flags: 64 });
}

export { deriveTeamNeeds, loadTeamEmojis, formatTeamEmoji, applyPickTrades };
export default { data, execute };
