import { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function normalizeName(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'pack' || lower === 'packers') return 'Packers';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs' || lower === 'buccaneers') return 'Buccaneers';
  if (lower === 'pats' || lower === 'patriots') return 'Patriots';
  if (lower === 'bolts' || lower === 'chargers') return 'Chargers';
  return name;
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function teamMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const nick = normalizeName(t.nickName || t.displayName);
    const city = t.cityName;
    map[t.teamId] = nick || city || `Team ${t.teamId}`;
  });
  return map;
}

function buildThreadName(game, teams, weekLabel) {
  const away = teams[game.awayTeamId] || 'Away';
  const home = teams[game.homeTeamId] || 'Home';
  return `${away} vs ${home} - ${weekLabel}`;
}

function teamMentions(game, teams, roleMap) {
  const names = [
    teams[game.awayTeamId],
    teams[game.homeTeamId],
  ].filter(Boolean);
  const ids = names.map(n => roleMap[`${n} Coach`]).filter(Boolean);
  return ids.map(id => `<@&${id}>`).join(' ');
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return Number(obj[k]);
  }
  return null;
}

function pointsFromSchedule(snapshot) {
  const out = {};
  const games = (snapshot?.schedule?.schedules || []).filter(g => Number(g.stageIndex ?? g.stage ?? 1) === 1);
  games.forEach(g => {
    const away = g.awayTeamId, home = g.homeTeamId;
    const ascore = Number(g.awayScore ?? 0);
    const hscore = Number(g.homeScore ?? 0);
    if (!out[away]) out[away] = { for: 0, against: 0, games: 0 };
    if (!out[home]) out[home] = { for: 0, against: 0, games: 0 };
    out[away].for += ascore; out[away].against += hscore; out[away].games += 1;
    out[home].for += hscore; out[home].against += ascore; out[home].games += 1;
  });
  return out;
}

function buildRankMaps(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const gp = (s) => pickField(s, ['gamesPlayed']) ?? ((s.totalWins || 0) + (s.totalLosses || 0) + (s.totalTies || 0));
  const byTeam = Object.fromEntries(standings.map(s => [s.teamId, s]));
  const schedulePts = pointsFromSchedule(snapshot);

  const metrics = {
    offPtsPerG: {
      getter: s => {
        const pts = pickField(s, ['pointsFor', 'totalPointsFor', 'offPts', 'ptsFor']);
        const games = gp(s) || 0;
        return pts != null ? (games ? pts / games : pts) : null;
      },
      rankKey: 'ptsForRank',
      desc: true,
    },
    offPassYds: { getter: s => pickField(s, ['offPassYds', 'offPassYards', 'passYdsFor']), rankKey: 'offPassYdsRank', desc: true },
    offRushYds: { getter: s => pickField(s, ['offRushYds', 'offRushYards', 'rushYdsFor']), rankKey: 'offRushYdsRank', desc: true },
    defPtsPerG: {
      getter: s => {
        const pts = pickField(s, ['pointsAgainst', 'ptsAllowed', 'defPtsAllowed', 'ptsAgainst']);
        const games = gp(s) || 0;
        return pts != null ? (games ? pts / games : pts) : null;
      },
      rankKey: 'ptsAgainstRank',
      desc: false,
    },
    defPassYds: { getter: s => pickField(s, ['defPassYds', 'defPassYdsAllowed', 'defPassYardsAllowed', 'passYdsAllowed', 'oppPassYds']), rankKey: 'defPassYdsRank', desc: false },
    defRushYds: { getter: s => pickField(s, ['defRushYds', 'defRushYdsAllowed', 'defRushYardsAllowed', 'rushYdsAllowed', 'oppRushYds']), rankKey: 'defRushYdsRank', desc: false },
  };

  const values = {};
  const ranks = {};

  for (const [key, cfg] of Object.entries(metrics)) {
    const list = standings.map(s => {
      const val = cfg.getter(s);
      const rank = cfg.rankKey ? s[cfg.rankKey] : null;
      return { teamId: s.teamId, val, rank };
    }).filter(x => x.val !== null && x.val !== undefined || x.rank !== null && x.rank !== undefined);
    list.sort((a, b) => {
      const av = a.val ?? 0;
      const bv = b.val ?? 0;
      return cfg.desc ? (bv - av) : (av - bv);
    });
    list.forEach((x, idx) => {
      if (!ranks[key]) ranks[key] = {};
      ranks[key][x.teamId] = x.rank || (idx + 1);
      if (!values[x.teamId]) values[x.teamId] = {};
      values[x.teamId][key] = x.val;
    });
  }

  // Fill missing points per game from schedule aggregates if possible
  Object.keys(byTeam).forEach(tid => {
    const v = values[tid] = values[tid] || {};
    const sched = schedulePts[tid];
    const games = gp(byTeam[tid]) || sched?.games || 0;
    if ((v.offPtsPerG === undefined || v.offPtsPerG === null) && sched && games) {
      v.offPtsPerG = sched.for / games;
    }
    if ((v.defPtsPerG === undefined || v.defPtsPerG === null) && sched && games) {
      v.defPtsPerG = sched.against / games;
    }
  });

  return { ranks, values, standings: byTeam };
}

function buildPlayoffAverages(snapshot) {
  const teamTotals = {};
  const weeks = (snapshot?.weeklyStats || []).filter(w => Number(w.weekIndex || 0) >= 19);
  weeks.forEach(w => {
    const list = w.teamstats?.teamStatInfoList || [];
    list.forEach(ts => {
      if (!ts.teamId) return;
      const t = teamTotals[ts.teamId] = teamTotals[ts.teamId] || { games: 0, offPts: 0, defPts: 0, offPass: 0, offRush: 0, defPass: 0, defRush: 0 };
      t.games += 1;
      t.offPts += Number(ts.offPtsPerGame ?? ts.offPts ?? 0);
      t.defPts += Number(ts.defPtsPerGame ?? ts.defPts ?? 0);
      t.offPass += Number(ts.offPassYds ?? 0);
      t.offRush += Number(ts.offRushYds ?? 0);
      t.defPass += Number(ts.defPassYds ?? 0);
      t.defRush += Number(ts.defRushYds ?? 0);
    });
  });
  const avg = {};
  Object.entries(teamTotals).forEach(([tid, t]) => {
    const g = t.games || 1;
    avg[tid] = {
      offPtsPerG: t.offPts / g,
      defPtsPerG: t.defPts / g,
      offPassYds: t.offPass / g,
      offRushYds: t.offRush / g,
      defPassYds: t.defPass / g,
      defRushYds: t.defRush / g,
    };
  });
  return avg;
}

function scoreFromStats(weeklyEntry) {
  if (!weeklyEntry) return {};
  const scores = {};
  const add = (teamId, val) => {
    if (!teamId) return;
    scores[teamId] = (scores[teamId] || 0) + val;
  };
  // If team stats have points, prefer them
  const teamStats = weeklyEntry.teamstats?.teamStatInfoList || [];
  teamStats.forEach(ts => {
    if (ts.teamId && ts.ptsFor !== undefined) {
      scores[ts.teamId] = ts.ptsFor;
    } else if (ts.teamId && ts.offPts !== undefined) {
      scores[ts.teamId] = ts.offPts;
    }
  });
  // Fallback: compute from player stats
  const addList = (list, fn) => (list || []).forEach(p => fn(p));
  // Offensive TDs: use rushing/receiving to avoid double-counting passing TDs
  addList(weeklyEntry.rushing?.playerRushingStatInfoList, p => add(p.teamId, (Number(p.rushTDs || 0) * 6)));
  addList(weeklyEntry.receiving?.playerReceivingStatInfoList, p => add(p.teamId, (Number(p.recTDs || 0) * 6)));
  // Defensive TDs
  addList(weeklyEntry.defense?.playerDefensiveStatInfoList, p => add(p.teamId, (Number(p.defTDs || 0) * 6)));
  // Kicking
  addList(weeklyEntry.kicking?.playerKickingStatInfoList, p => {
    add(p.teamId, (Number(p.fGMade || 0) * 3));
    add(p.teamId, (Number(p.xPMade || 0) * 1));
  });
  return scores;
}

function getBestWeekStats(snapshot, week) {
  const matches = (snapshot?.weeklyStats || []).filter(w => Number(w.weekIndex ?? -1) === Number(week));
  if (!matches.length) return null;
  return matches.reduce((best, curr) => {
    const currCount = curr.playerCount ?? 0;
    const bestCount = best?.playerCount ?? -1;
    return currCount > bestCount ? curr : best;
  }, null);
}

function scoresForWeek(snapshot, week) {
  const entry = getBestWeekStats(snapshot, week);
  return { scores: scoreFromStats(entry), playerCount: entry?.playerCount ?? 0 };
}

function wildcardPairs(seeds) {
  // seeds: [{teamId, seed}] sorted ascending
  const s = [...seeds].sort((a, b) => a.seed - b.seed);
  if (s.length < 7) return [];
  return [
    { homeTeamId: s[1].teamId, awayTeamId: s[6].teamId },
    { homeTeamId: s[2].teamId, awayTeamId: s[5].teamId },
    { homeTeamId: s[3].teamId, awayTeamId: s[4].teamId },
  ];
}

function winnerFromPair(pair, scores, seedMap) {
  const h = pair.homeTeamId;
  const a = pair.awayTeamId;
  const hScore = scores[h];
  const aScore = scores[a];
  if (hScore != null || aScore != null) {
    if ((hScore ?? -1) === (aScore ?? -1)) {
      // tie: higher seed (lower number) advances
      const hs = seedMap[h] ?? 99;
      const as = seedMap[a] ?? 99;
      return hs <= as ? h : a;
    }
    return (hScore ?? -Infinity) >= (aScore ?? -Infinity) ? h : a;
  }
  const hs = seedMap[h] ?? 99;
  const as = seedMap[a] ?? 99;
  return hs <= as ? h : a;
}

function buildDivisionalPairs(confSeeds, wcWinners, scores, seedMap) {
  const seedsSorted = [...confSeeds].sort((a, b) => a.seed - b.seed);
  const oneSeed = seedsSorted.find(s => s.seed === 1);
  const participants = [oneSeed, ...wcWinners.filter(Boolean)].filter(Boolean);
  // If we still don't have 4 teams, pad with remaining seeds
  for (const s of seedsSorted) {
    if (participants.length >= 4) break;
    if (!participants.find(p => p.teamId === s.teamId)) participants.push(s);
  }
  const sorted = participants.sort((a, b) => a.seed - b.seed);
  if (sorted.length < 2) return [];
  const pairs = [];
  while (sorted.length > 1) {
    const low = sorted.shift();
    const high = sorted.pop();
    if (!low || !high) break;
    pairs.push({ homeTeamId: high.teamId, awayTeamId: low.teamId });
  }
  return pairs;
}

function buildConferencePair(winners) {
  const sorted = [...winners].sort((a, b) => a.seed - b.seed);
  if (sorted.length < 2) return [];
  const high = sorted[0];
  const low = sorted[sorted.length - 1];
  return [{ homeTeamId: high.teamId, awayTeamId: low.teamId }];
}

function buildSuperBowlPair(afcChamp, nfcChamp) {
  if (!afcChamp || !nfcChamp) return [];
  return [{ homeTeamId: afcChamp.teamId, awayTeamId: nfcChamp.teamId }];
}

function deriveWinnersByConference(games, seedsMap) {
  const winners = { afc: [], nfc: [] };
  games.forEach(g => {
    if (!g.awayTeamId || !g.homeTeamId) return;
    const homeSeed = seedsMap[g.homeTeamId];
    const awaySeed = seedsMap[g.awayTeamId];
    if (!homeSeed || !awaySeed) return;
    const conf = (g.conferenceName || '').toLowerCase().includes('afc') ? 'afc'
      : (g.conferenceName || '').toLowerCase().includes('nfc') ? 'nfc'
        : (homeSeed <= 16 ? 'afc' : 'nfc'); // crude fallback by seed range if labeled that way
    const homeScore = Number(g.homeScore ?? g.finalHomeScore ?? 0);
    const awayScore = Number(g.awayScore ?? g.finalAwayScore ?? 0);
    const winnerId = homeScore >= awayScore ? g.homeTeamId : g.awayTeamId;
    winners[conf].push({ teamId: winnerId, seed: seedsMap[winnerId] });
  });
  return winners;
}

function pairFromSeeds(seeds, roundName) {
  // seeds: [{teamId, seed}]
  const sorted = [...seeds].sort((a, b) => a.seed - b.seed);
  if (sorted.length < 2) return [];
  if (roundName === 'wildcard') {
    // Expect seeds 2-7 in sorted order
    return [
      { homeTeamId: sorted[1].teamId, awayTeamId: sorted[6].teamId },
      { homeTeamId: sorted[2].teamId, awayTeamId: sorted[5].teamId },
      { homeTeamId: sorted[3].teamId, awayTeamId: sorted[4].teamId },
    ];
  }
  // Divisional/conference: highest vs lowest, remaining two face each other
  const pairs = [];
  while (sorted.length > 1) {
    const low = sorted.shift();
    const high = sorted.pop();
    if (low && high) pairs.push({ homeTeamId: high.teamId, awayTeamId: low.teamId });
  }
  return pairs;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadJson(ROLE_MAP_FILE);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Madden Commish/Co-Commish can use this command.' });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
    return;
  }

  const weekInput = interaction.options.getInteger('week');
  const playoffRound = interaction.options.getString('playoff_round');
  const playoffMap = {
    wildcard: 19, // display week
    divisional: 20,
    conference: 21,
    superbowl: 23,
  };
  const playoffWeekIdx = {
    wildcard: 18,     // exports use 0-based index; wildcard is weekIndex 18
    divisional: 19,
    conference: 20,
    superbowl: 22,    // Super Bowl commonly weekIndex 22 (Pro Bowl skipped at 21)
  };
  // Regular season = stage 1, playoffs can be stage 1 or 2 depending on export; try both for playoffs.
  const targetStages = playoffRound ? [2, 1] : [1];
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const wkNumeric = playoffRound ? playoffMap[playoffRound] : (weekInput ?? snapshot.currentWeek ?? 1) || 1;
    const weekLabel = playoffRound ? `PO-${playoffRound}` : `W${wkNumeric}`;
    const targetWeekIdx = playoffRound ? playoffWeekIdx[playoffRound] : (Number(wkNumeric) - 1);
    const allGames = snapshot?.schedule?.schedules || [];
    const standingsList = snapshot?.standings?.teamStandingInfoList || [];
    // Seed map for playoff derivation
    const seedMap = {};
    standingsList.forEach(s => {
      if (s.teamId && s.seed) seedMap[s.teamId] = s.seed;
    });

    const games = allGames.filter(g => {
      const stage = Number(g.stageIndex ?? g.stage ?? 1);
      const rawWeek = Number(g.seasonWeek ?? g.seasonWeekIndex ?? g.weekIndex ?? g.week ?? -1);
      const weekVal = Number.isNaN(rawWeek) ? -1 : rawWeek;
      const stageOk = playoffRound ? true : targetStages.includes(stage);
      // Only match the exact week index (zero-based)
      return stageOk && (weekVal === targetWeekIdx);
    });
    let gamesFinal = games.filter(g => g.awayTeamId && g.homeTeamId);

    const seedsByConf = {
      afc: standingsList.filter(s => (s.conferenceName || '').toLowerCase().includes('afc') && s.seed && s.seed <= 7).sort(seedSort).map(s => ({ teamId: s.teamId, seed: s.seed })),
      nfc: standingsList.filter(s => (s.conferenceName || '').toLowerCase().includes('nfc') && s.seed && s.seed <= 7).sort(seedSort).map(s => ({ teamId: s.teamId, seed: s.seed })),
    };
    const scoresWC = scoresForWeek(snapshot, playoffWeekIdx.wildcard).scores;
    const scoresDIV = scoresForWeek(snapshot, playoffWeekIdx.divisional).scores;
    const scoresCONF = scoresForWeek(snapshot, playoffWeekIdx.conference).scores;
    const scoresSB = scoresForWeek(snapshot, playoffWeekIdx.superbowl).scores;

    if (playoffRound) {
      const winnersFromPairs = (pairs, scores) => pairs.map(p => {
        const winId = winnerFromPair(p, scores, seedMap);
        return { teamId: winId, seed: seedMap[winId] };
      }).filter(x => x.teamId && x.seed);

      if (playoffRound === 'wildcard') {
        const wcPairsAfc = wildcardPairs(seedsByConf.afc);
        const wcPairsNfc = wildcardPairs(seedsByConf.nfc);
        gamesFinal = [...wcPairsAfc, ...wcPairsNfc];
      } else if (playoffRound === 'divisional') {
        const wcPairsAfc = wildcardPairs(seedsByConf.afc);
        const wcPairsNfc = wildcardPairs(seedsByConf.nfc);
        const wcWinnersAfc = winnersFromPairs(wcPairsAfc, scoresWC);
        const wcWinnersNfc = winnersFromPairs(wcPairsNfc, scoresWC);
        const divPairsAfc = buildDivisionalPairs(seedsByConf.afc, wcWinnersAfc, scoresWC, seedMap);
        const divPairsNfc = buildDivisionalPairs(seedsByConf.nfc, wcWinnersNfc, scoresWC, seedMap);
        gamesFinal = [...divPairsAfc, ...divPairsNfc];
      } else if (playoffRound === 'conference') {
        // winners from divisional games (week 20)
        const wcPairsAfc = wildcardPairs(seedsByConf.afc);
        const wcPairsNfc = wildcardPairs(seedsByConf.nfc);
        const wcWinnersAfc = winnersFromPairs(wcPairsAfc, scoresWC);
        const wcWinnersNfc = winnersFromPairs(wcPairsNfc, scoresWC);
        const divPairsAfc = buildDivisionalPairs(seedsByConf.afc, wcWinnersAfc, scoresWC, seedMap);
        const divPairsNfc = buildDivisionalPairs(seedsByConf.nfc, wcWinnersNfc, scoresWC, seedMap);
        const divWinnersAfc = winnersFromPairs(divPairsAfc, scoresDIV);
        const divWinnersNfc = winnersFromPairs(divPairsNfc, scoresDIV);
        gamesFinal = [
          ...buildConferencePair(divWinnersAfc),
          ...buildConferencePair(divWinnersNfc),
        ];
      } else if (playoffRound === 'superbowl') {
        const wcPairsAfc = wildcardPairs(seedsByConf.afc);
        const wcPairsNfc = wildcardPairs(seedsByConf.nfc);
        const wcWinnersAfc = winnersFromPairs(wcPairsAfc, scoresWC);
        const wcWinnersNfc = winnersFromPairs(wcPairsNfc, scoresWC);
        const divPairsAfc = buildDivisionalPairs(seedsByConf.afc, wcWinnersAfc, scoresWC, seedMap);
        const divPairsNfc = buildDivisionalPairs(seedsByConf.nfc, wcWinnersNfc, scoresWC, seedMap);
        const divWinnersAfc = winnersFromPairs(divPairsAfc, scoresDIV);
        const divWinnersNfc = winnersFromPairs(divPairsNfc, scoresDIV);
        const confPairAfc = buildConferencePair(divWinnersAfc);
        const confPairNfc = buildConferencePair(divWinnersNfc);
        const confWinnerAfc = winnersFromPairs(confPairAfc, scoresCONF)[0];
        const confWinnerNfc = winnersFromPairs(confPairNfc, scoresCONF)[0];
        gamesFinal = buildSuperBowlPair(confWinnerAfc, confWinnerNfc);
      }
    }

    if (!gamesFinal.length) {
      const avail = allGames.map(g => `stage ${g.stageIndex ?? g.stage ?? '?'} wk ${g.weekIndex ?? g.seasonWeek ?? '?'}`).slice(0, 20).join(', ');
      await interaction.editReply({ content: `No games found for ${playoffRound ? playoffRound : `week ${wkNumeric}`} in the snapshot. Available schedule entries: ${avail || 'none'}` });
      return;
    }
    const threadsChannelId = channelMap['Game threads'];
    if (!threadsChannelId) {
      await interaction.editReply({ content: 'Game threads channel ID not set.' });
      return;
    }
    const channel = await interaction.client.channels.fetch(threadsChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply({ content: 'Game threads channel not found or not text-based.' });
      return;
    }
    const teams = teamMap(snapshot);
    const ranks = buildRankMaps(snapshot);
    const playoffAvgs = playoffRound ? buildPlayoffAverages(snapshot) : null;
    let created = 0;
    const deadline = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000);
    for (const game of gamesFinal) {
      const name = buildThreadName(game, teams, weekLabel);
      try {
        const thread = await channel.threads.create({
          name,
          autoArchiveDuration: 10080, // 7 days
          reason: `Game thread for ${weekLabel}`,
        });
        const mentionText = teamMentions(game, teams, roleMap);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`madden_game_complete_${thread.id}`)
            .setLabel('Mark Game Complete')
            .setStyle(ButtonStyle.Success)
        );
        const statLine = (tid) => {
          if (playoffAvgs && playoffAvgs[tid]) {
            const v = playoffAvgs[tid];
            const fmt = (val, decimals = 1) => val != null ? (Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals)).toString() : '–';
            return [
              `Off Pts/G ${fmt(v.offPtsPerG)} (Playoffs)`,
              `Pass Yds ${fmt(v.offPassYds, 0)} (Playoffs)`,
              `Rush Yds ${fmt(v.offRushYds, 0)} (Playoffs)`,
              `Opp Pts/G ${fmt(v.defPtsPerG)} (Playoffs)`,
              `Opp Pass ${fmt(v.defPassYds, 0)} (Playoffs)`,
              `Opp Rush ${fmt(v.defRushYds, 0)} (Playoffs)`,
            ].join('\n');
          }
          const v = ranks.values[tid] || {};
          const r = ranks.ranks;
          const s = ranks.standings[tid] || {};
          const fmt = (val, decimals = 1) => val != null ? (Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals)).toString() : '–';
          const offPts = v.offPtsPerG ?? s.ptsFor ?? s.pointsFor ?? s.offPts;
          const defPts = v.defPtsPerG ?? s.ptsAgainst ?? s.pointsAgainst ?? s.defPtsAllowed;
          const passO = v.offPassYds ?? s.offPassYds;
          const rushO = v.offRushYds ?? s.offRushYds;
          const passD = v.defPassYds ?? s.defPassYds;
          const rushD = v.defRushYds ?? s.defRushYds;
          return [
            `Off Pts/G ${fmt(offPts)} (R${r?.offPtsPerG?.[tid] || s.ptsForRank || '–'})`,
            `Pass Yds ${fmt(passO, 0)} (R${r?.offPassYds?.[tid] || s.offPassYdsRank || '–'})`,
            `Rush Yds ${fmt(rushO, 0)} (R${r?.offRushYds?.[tid] || s.offRushYdsRank || '–'})`,
            `Opp Pts/G ${fmt(defPts)} (R${r?.defPtsPerG?.[tid] || s.ptsAgainstRank || '–'})`,
            `Opp Pass ${fmt(passD, 0)} (R${r?.defPassYds?.[tid] || s.defPassYdsRank || '–'})`,
            `Opp Rush ${fmt(rushD, 0)} (R${r?.defRushYds?.[tid] || s.defRushYdsRank || '–'})`,
          ].join('\n');
        };
        const embed = {
          title: 'Matchup Thread',
          description: `Welcome${mentionText ? ` ${mentionText}` : ''}!\nUse this thread to coordinate your matchup and mark it complete when done.\n\n${teams[game.awayTeamId] || 'Away'} stats:\n${statLine(game.awayTeamId)}\n\n${teams[game.homeTeamId] || 'Home'} stats:\n${statLine(game.homeTeamId)}\n\nDeadline: <t:${deadline}:R> (<t:${deadline}:f>)`,
          color: 0x00b0f4,
          timestamp: new Date().toISOString(),
        };
        await thread.send({ embeds: [embed], components: [row] });
        created += 1;
      } catch (e) {
        console.warn('[madden-creategamethreads] Failed to create thread', name, e?.message || e);
      }
    }
    try {
      const announceChannelId = channelMap['Madden League Buddy Announcements'];
      const coachRoleId = roleMap['Madden Coach'];
      const coachTag = coachRoleId ? `<@&${coachRoleId}>` : '';
      if (announceChannelId) {
        const announce = await interaction.client.channels.fetch(announceChannelId).catch(() => null);
        if (announce && announce.isTextBased()) {
          const embed = {
            title: playoffRound ? `${playoffRound} Threads Created` : `Week ${wkNumeric} Threads Created`,
            description: `Deadline to play: <t:${deadline}:F> (<t:${deadline}:R>).`,
            color: 0x00b0f4,
            timestamp: new Date().toISOString(),
          };
          await announce.send({ content: coachTag || null, embeds: [embed] });
        }
      }
    } catch (e) {
      console.warn('[madden-creategamethreads] Failed to post announcement:', e?.message || e);
    }
    await interaction.editReply({ content: `Created ${created}/${gamesFinal.length} game threads for ${playoffRound ? playoffRound : `week ${wkNumeric}`}.` });
  } catch (err) {
    await interaction.editReply({ content: `Failed to create game threads: ${err.message || err}` });
  }
}

export const data = new SlashCommandBuilder()
  .setName('madden-creategamethreads')
  .setDescription('Create game threads for a given week (regular season or playoffs) (staff-only).')
  .addIntegerOption(o => o.setName('week').setDescription('Regular-season week number (defaults to current)').setRequired(false))
  .addStringOption(o =>
    o.setName('playoff_round')
      .setDescription('Playoff round')
      .setRequired(false)
      .addChoices(
        { name: 'Wild Card', value: 'wildcard' },
        { name: 'Divisional', value: 'divisional' },
        { name: 'Conference', value: 'conference' },
        { name: 'Super Bowl', value: 'superbowl' },
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export default { data, execute };
function seedSort(a, b) {
  const aSeed = a.seed ?? 0;
  const bSeed = b.seed ?? 0;
  if (aSeed && bSeed) return aSeed - bSeed;
  if (aSeed && !bSeed) return -1;
  if (!aSeed && bSeed) return 1;
  return 0;
}
