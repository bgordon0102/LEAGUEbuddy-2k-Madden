import fs from 'fs';
import path from 'path';
import { getFullTeamName } from '../../shared/madden_team_names.js';

function normalizeName(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getMetricOvr(player) {
  return player?.playerBestOvr ?? player?.teamSchemeOvr ?? player?.overallRating ?? player?.playerSchemeOvr ?? 0;
}

export function loadLatestLeagueSnapshot() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, time: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) return null;
  const file = path.join(dir, files[0].file);
  return {
    file,
    league: JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

export function getUpcomingDraftYear(league) {
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const calendarYear = seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 2025;
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  return (weekType === 1 || weekType === 2) ? Number(calendarYear) + 1 : Number(calendarYear);
}

export function getSeasonPhaseContext(league, completedRegularWeeks = 0) {
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const calendarYear = Number(seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 2025);
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  const rawWeek = Number(seasonInfo.seasonWeek ?? seasonInfo.week ?? 0);
  const currentWeek = Number.isFinite(rawWeek) ? rawWeek + 1 : null;

  if (weekType === 1) {
    const phase =
      completedRegularWeeks <= 4 ? 'early_regular' :
      completedRegularWeeks <= 10 ? 'mid_regular' :
      'late_regular';
    return {
      calendarYear,
      weekType,
      currentWeek,
      completedRegularWeeks,
      phase,
      phaseLabel: completedRegularWeeks <= 4 ? 'Early Season' : completedRegularWeeks <= 10 ? 'Midseason' : 'Stretch Run',
      isInSeason: true,
      isFinalized: false,
    };
  }

  if (weekType === 2) {
    return {
      calendarYear,
      weekType,
      currentWeek,
      completedRegularWeeks,
      phase: 'postseason',
      phaseLabel: 'Postseason',
      isInSeason: true,
      isFinalized: true,
    };
  }

  return {
    calendarYear,
    weekType,
    currentWeek,
    completedRegularWeeks,
    phase: 'offseason',
    phaseLabel: 'Offseason',
    isInSeason: false,
    isFinalized: true,
  };
}

export function buildLiveDraftContext(league) {
  const rosterMetaById = {};
  const currentPlayersByTeamId = {};
  const teamNameById = Object.fromEntries(
    (league?.teams?.leagueTeamInfoList || []).map((team) => [
      Number(team.teamId),
      getFullTeamName(team, String(team.teamId)),
    ]),
  );

  for (const [teamIdRaw, rosterTeam] of Object.entries(league?.rosters?.teams || {})) {
    const teamId = Number(teamIdRaw);
    const rosterPlayers = rosterTeam?.rosterInfoList || rosterTeam?.rosterPlayerInfoList || [];
    currentPlayersByTeamId[teamId] = [];
    for (const player of rosterPlayers) {
      const rosterId = player?.rosterId;
      if (rosterId == null) continue;
      rosterMetaById[rosterId] = {
        rosterId,
        teamId,
        teamName: teamNameById[teamId] || String(teamId),
        name: player.displayName || `${player.firstName || ''} ${player.lastName || ''}`.trim() || 'Unknown',
        firstName: player.firstName,
        lastName: player.lastName,
        position: (player.position || '').toUpperCase(),
        age: player.age ?? player.playerAge ?? null,
        yearsPro: player.yearsPro ?? player.playerExperience ?? player.experience ?? null,
        yearsLeft: player.contractYearsLeft ?? player.contractLength ?? null,
        overall: getMetricOvr(player),
        raw: player,
      };
    }
  }

  const latestSeason = Math.max(...(league?.weeklyStats || [{ seasonIndex: 0 }]).map((week) => Number(week?.seasonIndex || 0)));
  const relevantWeeks = (league?.weeklyStats || [])
    .filter((week) => Number(week?.seasonIndex || 0) === latestSeason)
    .filter((week) => Number(week?.stage ?? week?.stageIndex ?? 0) === 1)
    .filter((week) => Number(week?.weekIndex ?? 0) <= 18);

  const playerStatsByRosterId = {};
  const teamStatsByTeamId = {};
  const seasonCountsByTeamId = {};
  const weeklySchedule = new Map();

  for (const game of league?.schedule?.schedules || []) {
    const weekIndex = Number(game?.weekIndex ?? -1);
    const stageIndex = Number(game?.stageIndex ?? game?.stage ?? -1);
    if (weekIndex < 0 || stageIndex !== 1) continue;
    if (!weeklySchedule.has(weekIndex)) weeklySchedule.set(weekIndex, []);
    weeklySchedule.get(weekIndex).push(game);
  }

  const ensureTeam = (teamId) => {
    if (!teamStatsByTeamId[teamId]) {
      teamStatsByTeamId[teamId] = {
        teamName: teamNameById[teamId] || String(teamId),
        pass: { yds: 0, td: 0, int: 0, sacksTaken: 0, comp: 0, att: 0 },
        rush: { yds: 0, td: 0, att: 0 },
        rec: { yds: 0, td: 0, catches: 0 },
        def: { sacks: 0, ints: 0, passYdsAllowed: 0, rushYdsAllowed: 0 },
        labels: {},
        games: 0,
      };
    }
    return teamStatsByTeamId[teamId];
  };

  const ensureCount = (teamId, bucket) => {
    if (!seasonCountsByTeamId[teamId]) seasonCountsByTeamId[teamId] = {};
    seasonCountsByTeamId[teamId][bucket] = (seasonCountsByTeamId[teamId][bucket] || 0) + 1;
  };

  const ensurePlayer = (rosterId, teamId, fallbackName = 'Player') => {
    if (!playerStatsByRosterId[rosterId]) {
      const meta = rosterMetaById[rosterId] || {};
      playerStatsByRosterId[rosterId] = {
        rosterId,
        teamId: meta.teamId ?? teamId,
        name: meta.name || fallbackName,
        position: meta.position || '',
        age: meta.age ?? null,
        yearsPro: meta.yearsPro ?? null,
        yearsLeft: meta.yearsLeft ?? null,
        overall: meta.overall ?? 0,
        pass: { yds: 0, td: 0, int: 0, comp: 0, att: 0 },
        rush: { yds: 0, td: 0, att: 0 },
        rec: { yds: 0, td: 0, catches: 0 },
        def: { sacks: 0, ints: 0, tackles: 0, tfl: 0, pds: 0, ff: 0, fr: 0 },
      };
    }
    return playerStatsByRosterId[rosterId];
  };

  for (const week of relevantWeeks) {
    const offenseByTeam = {};
    const weekIndex = Number(week?.weekIndex ?? -1);
    const gamesThisWeek = weeklySchedule.get(weekIndex) || [];

    for (const stat of week?.passing?.playerPassingStatInfoList || []) {
      const teamId = Number(stat.teamId);
      const team = ensureTeam(teamId);
      team.pass.yds += Number(stat.passYds || 0);
      team.pass.td += Number(stat.passTDs || 0);
      team.pass.int += Number(stat.passInts || 0);
      team.pass.comp += Number(stat.passComp || 0);
      team.pass.att += Number(stat.passAtt || 0);
      team.pass.sacksTaken += Number(stat.passSacks || 0);
      ensureCount(teamId, 'pass');
      offenseByTeam[teamId] = offenseByTeam[teamId] || { passYds: 0, rushYds: 0 };
      offenseByTeam[teamId].passYds += Number(stat.passYds || 0);
      if (stat.rosterId != null) {
        const player = ensurePlayer(stat.rosterId, teamId, stat.fullName || 'Player');
        player.pass.yds += Number(stat.passYds || 0);
        player.pass.td += Number(stat.passTDs || 0);
        player.pass.int += Number(stat.passInts || 0);
        player.pass.comp += Number(stat.passComp || 0);
        player.pass.att += Number(stat.passAtt || 0);
      }
    }

    for (const stat of week?.rushing?.playerRushingStatInfoList || []) {
      const teamId = Number(stat.teamId);
      const team = ensureTeam(teamId);
      team.rush.yds += Number(stat.rushYds || 0);
      team.rush.td += Number(stat.rushTDs || 0);
      team.rush.att += Number(stat.rushAtt || 0);
      ensureCount(teamId, 'rush');
      offenseByTeam[teamId] = offenseByTeam[teamId] || { passYds: 0, rushYds: 0 };
      offenseByTeam[teamId].rushYds += Number(stat.rushYds || 0);
      if (stat.rosterId != null) {
        const player = ensurePlayer(stat.rosterId, teamId, stat.fullName || 'Player');
        player.rush.yds += Number(stat.rushYds || 0);
        player.rush.td += Number(stat.rushTDs || 0);
        player.rush.att += Number(stat.rushAtt || 0);
      }
    }

    for (const stat of week?.receiving?.playerReceivingStatInfoList || []) {
      const teamId = Number(stat.teamId);
      const team = ensureTeam(teamId);
      team.rec.yds += Number(stat.recYds || 0);
      team.rec.td += Number(stat.recTDs || 0);
      team.rec.catches += Number(stat.recCatches || 0);
      ensureCount(teamId, 'rec');
      if (stat.rosterId != null) {
        const player = ensurePlayer(stat.rosterId, teamId, stat.fullName || 'Player');
        player.rec.yds += Number(stat.recYds || 0);
        player.rec.td += Number(stat.recTDs || 0);
        player.rec.catches += Number(stat.recCatches || 0);
      }
    }

    for (const stat of week?.defense?.playerDefensiveStatInfoList || []) {
      const teamId = Number(stat.teamId);
      const team = ensureTeam(teamId);
      team.def.sacks += Number(stat.defSacks || 0);
      team.def.ints += Number(stat.defInts || 0);
      ensureCount(teamId, 'def');
      if (stat.rosterId != null) {
        const player = ensurePlayer(stat.rosterId, teamId, stat.fullName || 'Player');
        player.def.sacks += Number(stat.defSacks || 0);
        player.def.ints += Number(stat.defInts || 0);
        player.def.tackles += Number(stat.defTotalTackles || 0);
        player.def.tfl += Number(stat.defTacklesForLoss || 0);
        player.def.pds += Number(stat.defPassDeflections || 0);
        player.def.ff += Number(stat.defForcedFumbles || 0);
        player.def.fr += Number(stat.defRecoveredFumbles || 0);
      }
    }

    const teamsSeen = new Set(Object.keys(offenseByTeam).map(Number));
    for (const game of gamesThisWeek) {
      const homeTeamId = Number(game.homeTeamId);
      const awayTeamId = Number(game.awayTeamId);
      if (!Number.isFinite(homeTeamId) || !Number.isFinite(awayTeamId)) continue;
      const homeOff = offenseByTeam[homeTeamId] || { passYds: 0, rushYds: 0 };
      const awayOff = offenseByTeam[awayTeamId] || { passYds: 0, rushYds: 0 };
      ensureTeam(homeTeamId).def.passYdsAllowed += awayOff.passYds;
      ensureTeam(homeTeamId).def.rushYdsAllowed += awayOff.rushYds;
      ensureTeam(awayTeamId).def.passYdsAllowed += homeOff.passYds;
      ensureTeam(awayTeamId).def.rushYdsAllowed += homeOff.rushYds;
      teamsSeen.add(homeTeamId);
      teamsSeen.add(awayTeamId);
    }
    for (const teamId of teamsSeen) {
      ensureTeam(teamId).games += 1;
    }
  }

  for (const [teamIdRaw, teamStats] of Object.entries(teamStatsByTeamId)) {
    const teamId = Number(teamIdRaw);
    const passAtt = Math.max(1, Number(teamStats.pass.att || 0));
    const rushAtt = Math.max(1, Number(teamStats.rush.att || 0));
    teamStats.labels = {
      passYds: teamStats.pass.yds,
      passTD: teamStats.pass.td,
      passINT: teamStats.pass.int,
      sacksAllowed: teamStats.pass.sacksTaken,
      compPct: Number(((Number(teamStats.pass.comp || 0) / passAtt) * 100).toFixed(1)),
      ypa: Number((Number(teamStats.pass.yds || 0) / passAtt).toFixed(2)),
      rushYds: teamStats.rush.yds,
      rushTD: teamStats.rush.td,
      ypc: Number((Number(teamStats.rush.yds || 0) / rushAtt).toFixed(2)),
      recYds: teamStats.rec.yds,
      recTD: teamStats.rec.td,
      recCatches: teamStats.rec.catches,
      defSacks: teamStats.def.sacks,
      defINT: teamStats.def.ints,
      passYdsAllowed: teamStats.def.passYdsAllowed,
      rushYdsAllowed: teamStats.def.rushYdsAllowed,
      games: teamStats.games,
    };
    teamStats.teamId = teamId;
  }

  for (const meta of Object.values(rosterMetaById)) {
    const currentPlayer = ensurePlayer(meta.rosterId, meta.teamId, meta.name);
    currentPlayer.teamId = meta.teamId;
    currentPlayer.teamName = meta.teamName;
    currentPlayer.position = meta.position;
    currentPlayer.age = meta.age;
    currentPlayer.yearsPro = meta.yearsPro;
    currentPlayer.yearsLeft = meta.yearsLeft;
    currentPlayer.overall = meta.overall;
    currentPlayer.passYds = currentPlayer.pass.yds;
    currentPlayer.passTDs = currentPlayer.pass.td;
    currentPlayer.passInts = currentPlayer.pass.int;
    currentPlayer.passComp = currentPlayer.pass.comp;
    currentPlayer.passAtt = currentPlayer.pass.att;
    currentPlayer.rushYds = currentPlayer.rush.yds;
    currentPlayer.rushTDs = currentPlayer.rush.td;
    currentPlayer.rushAtt = currentPlayer.rush.att;
    currentPlayer.recYds = currentPlayer.rec.yds;
    currentPlayer.recTDs = currentPlayer.rec.td;
    currentPlayer.recCatches = currentPlayer.rec.catches;
    currentPlayer.sacks = currentPlayer.def.sacks;
    currentPlayer.interceptions = currentPlayer.def.ints;
    if (!currentPlayersByTeamId[meta.teamId]) currentPlayersByTeamId[meta.teamId] = [];
    currentPlayersByTeamId[meta.teamId].push(currentPlayer);
  }

  const teamStatsByName = Object.fromEntries(
    Object.values(teamStatsByTeamId).map((stats) => [normalizeName(stats.teamName || ''), stats]),
  );
  const seasonContext = getSeasonPhaseContext(league, relevantWeeks.length);

  return {
    latestSeason,
    rosterMetaById,
    currentPlayersByTeamId,
    playerStatsByRosterId,
    teamStatsByTeamId,
    teamStatsByName,
    seasonCountsByTeamId,
    teamNameById,
    seasonContext,
  };
}
