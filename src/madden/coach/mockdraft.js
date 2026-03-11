import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { loadPickOverrides as loadPickOverridesFile } from '../pick_overrides_store.js';

let currentCalendarYear = 2025;
let staffClassOverride = null;
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
    if (process.env.MOCK_DEBUG === 'true') {
      console.log(`[PLAYOFF DEBUG] ${confName.toUpperCase()} playoffStatus>0:`, playoffList.map(t => t.teamName).join(', '));
    }
    const pool = playoffList.length >= 7 ? playoffList : list;
    if (!list.length) return [];
    const byDiv = {};
    pool.forEach(t => {
      const div = t.divisionId || t.divisionName || 'div';
      byDiv[div] = byDiv[div] || [];
      byDiv[div].push(t);
    });
    const divWinners = Object.values(byDiv).map(arr => [...arr].sort(cmpRecord)[0]);
    const nonWinners = pool.filter(t => !divWinners.find(w => w.teamId === t.teamId));
    if (process.env.MOCK_DEBUG === 'true') {
      console.log(`[PLAYOFF DEBUG] ${confName.toUpperCase()} div winners:`, divWinners.map(t => t.teamName).join(', '));
      console.log(`[PLAYOFF DEBUG] ${confName.toUpperCase()} non winners:`, nonWinners.map(t => t.teamName).join(', '));
    }
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

  // Hardwire 2026 (calendarYear 2025 offseason) draft order provided by user
  const hardwire2026 = [
    'Chargers','Jets','Buccaneers','Panthers','Browns','Dolphins','Steelers','Titans',
    'Lions','Raiders','Vikings','Cowboys','Chiefs','Commanders','49ers','Jaguars',
    'Rams','Saints','Texans','Eagles','Bengals','Patriots','Bears','Giants',
    'Packers','Broncos','Bills','Cardinals','Seahawks','Colts','Falcons','Ravens'
  ];
  if (seasonInfo?.calendarYear === 2025 && hardwire2026.length === 32) {
    const fixed = hardwire2026.map(name => {
      const hit = teamByName[name.toLowerCase()];
      return hit ? hit : { id: null, name, w: 0, l: 0, net: 0, pf: 0 };
    });
    return fixed.slice(0, 32);
  }

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

  // Debug log playoff bucket placement
  console.log('--- PLAYOFF BUCKETS (stage/lost) ---');
  for (const [name, list] of Object.entries({
    non: buckets.non,
    wc: buckets.wc,
    div: buckets.div,
    conf: buckets.conf,
    sbl: buckets.sbl,
    sbw: buckets.sbw
  })) {
    console.log(`${name.toUpperCase()}: ${list.map(t => `${t.name}`).join(', ')}`);
  }

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
  // Load persisted overrides; fall back to legacy hardcoded list
  const fileOverrides = loadPickOverridesList(seasonYear).concat(loadPickOverridesFile());
  // Legacy overrides for current cycle (R1 only)
  const legacy = [
    { from: 'Cardinals', to: 'Detroit Lions', via: 'ARI' },   // ARI -> DET
    { from: 'Packers', to: 'Dallas Cowboys', via: 'GB' },     // GB -> DAL
    { from: 'Colts', to: 'New York Jets', via: 'IND' },       // IND -> NYJ
    { from: 'Cowboys', to: 'New York Jets', via: 'DAL' },     // DAL -> NYJ
  ];
  const overrides = [...fileOverrides, ...legacy];
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
  const dir = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
  if (!fs.existsSync(dir)) return [];
  const calendarYear = staffClassOverride?.season || currentCalendarYear;
  const yearShort = Number(String(calendarYear || 2025).slice(-2));
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json'));
  if (!files.length) return [];

  const parsed = files.map(f => {
    const m = f.match(/madden(\d+)_cus(\d+)/i);
    const mYear = m ? Number(m[1]) : null;
    return { f, mYear, cus: m?.[2] || null, time: fs.statSync(path.join(dir, f)).mtimeMs };
  });

  // Prefer the file whose Madden year is the closest at/above the current cycle; fallback to newest
  const ranked = parsed
    .filter(p => p.mYear !== null)
    .sort((a, b) => {
      const diffA = Math.abs((a.mYear || 0) - yearShort);
      const diffB = Math.abs((b.mYear || 0) - yearShort);
      return diffA - diffB || (b.time - a.time);
    });
  const pickFile = (ranked[0]?.f) || parsed.sort((a,b)=>b.time-a.time)[0].f;
  const data = JSON.parse(fs.readFileSync(path.join(dir, pickFile), 'utf8'));
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
  const norm = normalizeName(teamName);
  if (needsMap[norm]) return needsMap[norm];
  if (altName) {
    const normAlt = normalizeName(altName);
    if (needsMap[normAlt]) return needsMap[normAlt];
  }
  const entry = Object.entries(needsMap).find(([k]) => k.includes(norm) || norm.includes(k));
  if (entry) return entry[1];
  if (altName) {
    const normAlt = normalizeName(altName);
    const altEntry = Object.entries(needsMap).find(([k]) => k.includes(normAlt) || normAlt.includes(k));
    if (altEntry) return altEntry[1];
  }
  return ['BPA'];
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
function deriveTeamNeeds(league) {
  const rosters = league.rosters?.teams || {};
  const teamInfo = league.teams?.leagueTeamInfoList || [];
  const nameById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), `${t.cityName || ''} ${t.nickName || ''}`.trim()]));
  const normNameById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), normalizeName(`${t.cityName || ''} ${t.nickName || ''}`)]));
  // Optional team stats for production-based tuning
  const TEAM_STATS_PATH = path.join(process.cwd(), 'data', 'madden', 'team_stats.json');
  const teamStats = fs.existsSync(TEAM_STATS_PATH) ? JSON.parse(fs.readFileSync(TEAM_STATS_PATH, 'utf8')) : {};
  const statsByTeamId = new Map(Object.entries(teamStats).map(([k,v]) => [Number(k), v]));
  const statsByName = new Map(Object.values(teamStats).map(v => [normalizeName(v.teamName || ''), v]));
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
  // Teams with a highlighted need at RB (manual nudge for low rushing)
  const RB_MANUAL = new Set(['Kansas City Chiefs'].map(s => s.toLowerCase()));

  const needsByTeam = {};
  const positionGroup = (pos = '') => {
    const p = pos.toUpperCase();
    if (p === 'QB') return 'QB';
    if (['LT', 'RT'].includes(p)) return 'OT';
    if (['LG', 'C', 'RG'].includes(p)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(p)) return 'EDGE';
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

    if (qbCount === 0) {
      qbNeed = true; qbSeverity = 100;
    } else {
      const yearsLeft = bestQB ? getYearsLeft(bestQB) : 0;
      const age = bestQB?.age ?? 0;

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

    // For each group, create a "need score" (higher score = higher need)
    const needScores = allGroups.map(group => {
      const stat = groupStats[group];
      // Penalize for low count and low OVR
      let score = 100 - (stat.avgOvr || 0) + (stat.count < 2 ? 10 : 0);
      // QB special handling
      if (group === 'QB') {
        if (qbNeed) {
          score += qbSeverity + 40; // raise if real need
        } else if (qbSeverity >= 30) {
          // depth-only: allow mid-board placement (slots 2-5)
          score += qbSeverity;
        } else {
          score -= 250; // strong lockout, bury QB
        }
      }
      if (group === 'RB') {
        const normTeam = normNameById[tid] || normalizeName(teamNameKey);
        const ts = getTeamStat(tid, teamNameKey) || {};
        const rushYds = ts.rush?.yds ?? ts.rushYds;
        const rushAtt = ts.rush?.att ?? ts.rushAtt;
        const rushTD = ts.rush?.td ?? ts.rushTDs;
        const ypc = rushAtt ? (rushYds || 0) / Math.max(1, rushAtt) : null;
        // Pull back RB urgency; only boost when clearly poor
        if (rushYds !== undefined && rushYds < 1400) score += 8;
        if (ypc !== null && ypc < 3.9) score += 10;
        if (rushTD !== undefined && rushTD < 10) score += 6;
        if ((stat.avgOvr || 0) < 73) score += 10;
        if ((stat.count || 0) < 2) score += 6;
        // Manual nudge list (smaller)
        if (RB_MANUAL.has(normTeam)) score += 10;
      }
      if (group === 'DT') {
        // Many fronts play two DTs; treat sub-3 depth as a real need
        const depth = stat.count || 0;
        if (depth < 4) score += 10; // want at least a rotation piece
        if (depth < 3) score += 18; // no true backup for 2-starter fronts
        if (depth < 2) score += 28; // glaring hole
        if ((stat.avgOvr || 0) < 76) score += 10; // middling talent bumps urgency
        const paR = paRank[tid];
        if (paR && paR <= 10) score += 8; // bottom-10 scoring defense → shore up interior
        else if (paR && paR >= 24) score -= 6; // strong defense can deprioritize slightly
      }
      // EDGE tuning: avoid over-flagging if room is already deep/solid
      if (group === 'EDGE') {
        if ((stat.count || 0) >= 5) score -= 25;
        else if ((stat.count || 0) >= 4) score -= 18;
        if ((stat.avgOvr || 0) >= 78) score -= 12;
        const ts = getTeamStat(tid, teamNameKey);
        const teamSacks = ts?.def?.sacks;
        const leadSacks = ts?.leaders?.defSacks?.val;
        if (teamSacks !== undefined) {
          if (teamSacks >= 42) score -= 20;
          else if (teamSacks >= 36) score -= 12;
        }
        if (leadSacks !== undefined && leadSacks >= 10) score -= 8;
      }
      return { group, score };
    });
    // Sort by highest need (lowest avgOvr, lowest count, QB lockout)
    needScores.sort((a, b) => b.score - a.score);
    // Take top 5 needs
  let needs = needScores.slice(0, 5).map(n => n.group);
  const teamNormForRB = normalizeName(teamNameKey);
  if (RB_MANUAL.has(teamNormForRB) && !needs.includes('RB')) {
    needs[needs.length - 1] = 'RB';
  }
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
    needsByTeam[teamNameNorm] = needs;
  }
  return needsByTeam;
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

export const data = new SlashCommandBuilder()
  .setName('madden-mockdraft')
  .setDescription('Show a mock draft for the top 32 picks using current standings and the latest draft class')
  .addIntegerOption(opt =>
    opt.setName('season')
      .setDescription('[Staff] Override calendar year (e.g., 2026)')
      .setMinValue(2025)
      .setMaxValue(2035)
      .setRequired(false));

export async function execute(interaction) {
  // Defer immediately to avoid interaction timeout; use flags for ephemeral-like behavior
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
  // Staff-only overrides
  const staff = interaction.member?.permissions?.has?.('Administrator') || false;
  const seasonOverride = staff ? interaction.options.getInteger('season') : null;
  staffClassOverride = {
    season: seasonOverride || null,
  };

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
  const rawOrder = draftOrder(league);
  const order = applyPickTrades(rawOrder, currentCalendarYear);
  const needs = deriveTeamNeeds(league);
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
  const priority = ['QB', 'OL_T', 'OL_I', 'OL', 'EDGE', 'LB', 'CB', 'WR', 'TE', 'RB', 'BPA'];
  const needBonusByIndex = [9, 7, 5, 3, 2];
  // Madden weighting: WR/CB/S/LB prioritized for users; pass rush/OT/DT elevated
  const posWeight = { QB: 5, OL: 3, EDGE: 4, LB: 4, CB: 5, WR: 5, TE: 2, RB: 1, S: 4, DT: 3, IOL: 3, OL_T: 3, OL_I: 3 };

  // Force specific QB destinations per user request (normalized team name -> QB name)
const forcedQbPick = {
    [normalizeName('Los Angeles Chargers')]: 'LaRon Williams',
    [normalizeName('LA Chargers')]: 'LaRon Williams',
    [normalizeName('Chargers')]: 'LaRon Williams',
    [normalizeName('Miami Dolphins')]: 'Jake Osborn',
    [normalizeName('Dolphins')]: 'Jake Osborn',
    [normalizeName('Los Angeles Rams')]: 'Cam Thompson',
    [normalizeName('LA Rams')]: 'Cam Thompson',
    [normalizeName('Rams')]: 'Cam Thompson',
};

const firstRoundQBs = new Set(['LaRon Williams', 'Jake Osborn', 'Jaylen Kelly', 'Cam Thompson']);
const MOCK_DEBUG = process.env.MOCK_DEBUG === 'true';
const template = [
  ['losangeleschargers','laron williams'],
  ['newyorkjets','hali’a nalani'],
  ['carolinapanthers','micah howard'],
  ['tampabaybuccaneers','malik muhammad'],
  ['miamidolphins','jake osborn'],
  ['tennesseetitans','kaden washington jr.'],
  ['clevelandbrowns','qu’wan smith'], // already handled via ranks
  ['lasvegasraiders','brandon williams'],
  ['minnesotavikings','devonte jones'],
  ['detroitlions','hokuaonani alohilani'],
  ['washingtoncommanders','jayvon moss'],
  ['kansascitychiefs','jahdae brown'],
  ['chiefs','jahdae brown'],
  ['kcchiefs','jahdae brown'],
  ['losangelesrams','cam thompson'],
  ['rams','cam thompson'],
  ['larams','cam thompson'],
  ['dallascowboys','nick mulligan'],
    ['sanfrancisco49ers','keon davis'],
    ['losangelesrams','mckinley jennings'],
    ['clevelandbrowns','demonte stokes'],
    ['neworleanssaints','kareem reynolds'],
    ['houstontexans','trevon williams'],
    ['philadelphiaeagles','nico desroches'],
    ['cincinnatibengals','ryan andrade'],
    ['dallascowboys','kaden reed'],
    ['newenglandpatriots','kadrick richards jr.'],
    ['newyorkgiants','jalen farnsworth'],
    ['chicagobears','jaronte poole'],
    ['arizonacardinals','jaxtyn chandler'],
    ['denverbroncos','bo williamson'],
    ['buffalobills','brandyn edwards'],
    ['baltimoreravens','malik hall'],
    ['losangelesrams','cam thompson'],
    ['seattleseahawks','ben montague'],
    ['newyorkjets','jonathan gunnarsson'],
  ];
  const templateRank = Object.fromEntries(template.map(([_, player], idx) => [player, idx + 1]));
  const templateTeamPlayer = Object.fromEntries(template.map(([team, player]) => [team, player]));

  let pickNumber = 1;
  let qbTop5Count = 0;
  const unmetNeedsMap = new Map(); // track remaining needs per team across multiple 1st-rounders
   // Track positions already taken in R1 for each team to avoid double-dip unless forced
  const pickedGroupsMap = new Map();
  for (const team of order) {
    const teamNameNorm = normalizeName(team.name || '');
    const teamKeyNorm = teamKey(team.name, team.nick);
    let teamNeeds = resolveTeamNeedsMock(team.name || '', needs, team.nick);
    if (!teamNeeds.length) teamNeeds = ['BPA'];

    const forcedNameForNeed = forcedQbPick[teamNameNorm];
    if (forcedNameForNeed && !teamNeeds.includes('QB')) {
      teamNeeds = ['QB', ...teamNeeds.filter(n => n !== 'QB')].slice(0, 5);
    }

    let hasQBNeed = teamNeeds.includes('QB');
    // Persistent unmet needs (avoid double-dipping when a team owns multiple R1 picks)
    let unmetNeeds = unmetNeedsMap.get(teamKeyNorm) || unmetNeedsMap.get(teamNameNorm);
    if (!unmetNeeds) {
      unmetNeeds = new Set(teamNeeds.filter(n => n !== 'BPA'));
      unmetNeedsMap.set(teamKeyNorm, unmetNeeds);
    }
    const isSteelers = teamNameNorm.includes('steelers');
    if (isSteelers && pickNumber <= 12) {
      hasQBNeed = false;
      teamNeeds = teamNeeds.filter(n => n !== 'QB');
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

    // Force-map specific QBs to teams when available
    const forcedName = forcedQbPick[teamNameNorm];
    if (forcedName && hasQBNeed) {
      let idx = available.findIndex(p => p.name === forcedName);
      if (idx === -1) {
        // fall back only to remaining first-round QBs, not any QB
        idx = available.findIndex(p => prospectGroup(p) === 'QB' && firstRoundQBs.has(p.name));
      }
      if (idx >= 0) {
        bestIdx = idx;
        bestScore = -Infinity;
      }
    }

    // If QB is the top need, heavily bias to take the best available QB very early.
    const qbTopNeed = teamNeeds[0] === 'QB';

    // Candidate pool within board window and needs
    const bpaOnly = teamNeeds.length === 1 && teamNeeds[0] === 'BPA';
    const boardWindow =
      pickNumber <= 5 ? 8 :
      pickNumber <= 8 ? 12 :
      pickNumber <= 16 ? 18 :
      pickNumber <= 24 ? 25 :
      30;

    const candidateIndices = [];
    const isRams = teamNameNorm.includes('rams');
    const effectiveNeeds = unmetNeeds.size ? unmetNeeds : null;
    const openSlots = effectiveNeeds?.size || (teamNeeds.length > 1 && !bpaOnly);
    for (let i = 0; i < available.length; i++) {
      if (i >= boardWindow) break; // limit reach
      const p = available[i];
      const nameLower = (p.name || '').toLowerCase();
      const g = prospectGroup(p);
      const isKeonDavis = nameLower === 'keon davis';
      // Always allow top-5 board into first 10 picks regardless of needs
      const eliteBoard = (i < 5 && pickNumber <= 10);
      if (eliteBoard) {
        candidateIndices.push(i);
        continue;
      }
      // DTs often start two; don't let a first-round DT like Keon Davis fall out of window
      if (isKeonDavis && pickNumber <= 32) {
        candidateIndices.push(i);
        continue;
      }
      const isCamThompson = (p.name || '').toLowerCase().includes('cam thompson');
      if (g === 'QB' && !hasQBNeed && !(isRams && isCamThompson && pickNumber >= 14 && pickNumber <= 20)) continue;
      if (g === 'QB' && qbTop5Count >= 2 && pickNumber <= 5) continue;
      if (g === 'QB' && !firstRoundQBs.has(p.name) && pickNumber < 20) continue; // protect board slotting
      if (!bpaOnly && effectiveNeeds) {
        if (!effectiveNeeds.has(g)) continue;
      } else if (!bpaOnly && !effectiveNeeds) {
        // all needs filled; allow any need-listed positions, otherwise BPA
        if (teamNeeds.length && !teamNeeds.includes(g)) continue;
      }
      // prevent double-dip on same position when other needs remain (QB allowed once; others avoid repeats)
      if (g !== 'QB' && pickedGroups.has(g) && openSlots) continue;
      candidateIndices.push(i);
    }

    // Soft preference handled in scoring; no hard lock

    const debugRows = [];

    // Score only within candidates
    for (const i of candidateIndices) {
      const p = available[i];
      const g = prospectGroup(p);
      const pos = (p.position || p.position_1 || '').toUpperCase();
      const needIdx = teamNeeds.indexOf(g);
      const needBonus = needIdx >= 0 && needIdx < needBonusByIndex.length ? needBonusByIndex[needIdx] : 0;
      let score = i * 2 - needBonus; // board position weighted more
      const nameLower = (p.name || '').toLowerCase();
      const tRank = templateRank[nameLower];
      if (tRank) score -= Math.max(8, 40 - tRank * 3.5); // stronger template pull
      if (templateTeamPlayer[teamNameNorm] === nameLower) score -= 80; // bias to specific team-player fit (tempered to allow better-ranked peers)
      if (g === 'EDGE') {
        // push higher-ranked edges slightly; keep modest to avoid overfitting
        const edgeRankBonus = Math.max(0, 6 - i * 2);
        score -= edgeRankBonus;
      }
      if ((g === 'WR' || g === 'CB' || g === 'S' || g === 'LB' || g === 'EDGE' || g === 'OT' || g === 'IOL' || g === 'DT') && i <= 12)
        score -= 12; // slightly toned boost
      // Extra shove for true OL needs early
      const olNeed = teamNeeds.includes('OT') || teamNeeds.includes('IOL');
      if (olNeed && (g === 'OT' || g === 'IOL') && pickNumber <= 20) score -= 18;
      // Additional BPA shove: top-5 board players get extra boost inside top 10 picks
      if (i < 5 && pickNumber <= 10) score -= 50;
      // Keep top WR Hali'a Nalani from falling outside top 10
      if ((p.name || '').toLowerCase().includes("hali'a nalani") && pickNumber <= 10) {
        score -= 120;
      }
      // Rams favor Cam Thompson in the teens
      if (isRams && (p.name || '').toLowerCase().includes('cam thompson') && pickNumber >= 14 && pickNumber <= 20) {
        score -= 120;
      }
      // Elevate DTs (especially Keon Davis) to reflect 2-starter interiors
      if (g === 'DT') {
        if (effectiveNeeds?.has('DT') || teamNeeds.includes('DT')) score -= 18;
        if (pickNumber <= 24 && i <= 25) score -= 8;
        if (nameLower === 'keon davis') score -= 40;
      }

      debugRows.push({ idx: i, name: p.name, pos: g, score });

      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
      if (i > 70 && bestIdx !== -1) break;
    }

    // Hard failsafe: keep Keon Davis inside Round 1 even if board/needs got weird
    if (pickNumber >= 28 && pickNumber <= 32 && bestIdx !== -1) {
      const keonIdx = available.findIndex(p => (p.name || '').toLowerCase() === 'keon davis');
      if (keonIdx !== -1) bestIdx = keonIdx;
    }

    // If no candidate (e.g., thin needs), allow BPA
    if (bestIdx === -1 && available.length) {
      bestIdx = 0;
    }

    // If no valid pick found (e.g., all QBs but team doesn't need QB), pick first non-QB
    let chosen;
    if (bestIdx !== -1) {
      chosen = available.splice(bestIdx, 1)[0];
    } else {
      // fallback: pick first available non-QB
      const fallbackIdx = available.findIndex(p => prospectGroup(p) !== 'QB');
      chosen = fallbackIdx !== -1 ? available.splice(fallbackIdx, 1)[0] : available.shift();
    }
    if (chosen && pickNumber <= 5 && prospectGroup(chosen) === 'QB') {
      qbTop5Count += 1;
    }
    // Mark need as satisfied to prevent double-dip on later R1 picks
    const chosenGroup = prospectGroup(chosen);
    if (chosenGroup && unmetNeeds.has(chosenGroup)) unmetNeeds.delete(chosenGroup);
    if (chosenGroup) pickedGroups.add(chosenGroup);

    if (MOCK_DEBUG) {
      const topCandidates = debugRows.sort((a,b)=>a.score-b.score).slice(0,3);
      console.log(`[MOCK DEBUG] Pick ${pickNumber} ${team.name} needs=${teamNeeds.join(',')} unmet=${Array.from(unmetNeeds).join(',') || 'none'} picked=${Array.from(pickedGroups).join(',') || 'none'} window=${boardWindow} candidates=${candidateIndices.length}`);
      topCandidates.forEach(c=> console.log(`  idx ${c.idx} score ${c.score.toFixed(2)} ${c.pos} ${c.name}`));
      console.log(`  chosen: ${chosen?.name} (${prospectGroup(chosen)})`);
    }
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
