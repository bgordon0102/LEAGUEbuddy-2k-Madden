import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { buildLiveDraftContext } from './draft_live_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { getMaddenSnapshotContext, loadMaddenChannelMap } from '../../shared/madden_metadata.js';
import { loadRoleMap } from '../staff/staffUtils.js';
import { getLegacyOpportunityForTeam, getRecognitionPerkState, getRecognitionStreamTotal } from '../../shared/league_recognition.js';
import { getSportsbookLineForMatchup } from '../../shared/madden_sportsbook.js';
import { coachCommandDescription } from '../../shared/madden_coach_voice.js';
import { formatTeamLabelWithEmoji, RECOGNITION_EMOJIS } from '../../shared/madden_visuals.js';

function normalizeName(name = '') {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function average(total, games) {
  return games > 0 ? Number(total || 0) / games : 0;
}

function playerOvr(player = {}) {
  return Number(player?.playerBestOvr || player?.teamSchemeOvr || player?.overall || player?.overallRating || 0);
}

function formatPlayerName(player = {}) {
  return player?.name || `${player?.firstName || ''} ${player?.lastName || ''}`.trim() || 'Unknown';
}

function teamMap(snapshot) {
  return new Map(
    (snapshot?.teams?.leagueTeamInfoList || []).map((team) => [
      Number(team.teamId),
      {
        teamId: Number(team.teamId),
        fullName: getFullTeamName(team, `Team ${team.teamId}`),
        city: String(team.cityName || '').trim(),
        mascot: String(team.displayName || team.nickName || '').trim(),
        abbr: String(team.abbrName || '').trim(),
      },
    ]),
  );
}

function teamCandidates(snapshot) {
  return [...teamMap(snapshot).values()];
}

function resolveTeamFromRoleName(roleName = '', snapshot) {
  const cleaned = String(roleName || '').replace(/ coach$/i, '').trim();
  if (!cleaned) return null;
  const key = normalizeName(cleaned);
  return teamCandidates(snapshot).find((team) =>
    [team.fullName, team.city, team.mascot, team.abbr].some((value) => normalizeName(value) === key),
  ) || null;
}

function coachTeamFromMember(member, roleMap, snapshot) {
  const roles = member?.roles?.cache;
  if (!roles) return null;
  for (const [name, id] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(name)) continue;
    if (!roles.has(id)) continue;
    const match = resolveTeamFromRoleName(name, snapshot);
    if (match) return match;
  }
  for (const role of roles.values()) {
    const match = resolveTeamFromRoleName(role.name, snapshot);
    if (match) return match;
  }
  return null;
}

function resolveCoachRoleIdForTeam(team, roleMap = {}) {
  if (!team) return null;
  const variants = new Set([
    `${team.fullName} Coach`,
    `${team.city} ${team.mascot}`.trim() ? `${`${team.city} ${team.mascot}`.trim()} Coach` : '',
    team.mascot ? `${team.mascot} Coach` : '',
    team.city ? `${team.city} Coach` : '',
    team.abbr ? `${team.abbr} Coach` : '',
  ].filter(Boolean));

  for (const [name, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(name)) continue;
    const normalized = normalizeName(name);
    if ([...variants].some((variant) => normalizeName(variant) === normalized)) return roleId;
  }
  return null;
}

async function resolveCoachUserFromRole(guild, roleId) {
  if (!guild || !roleId) return null;
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return null;
  const member = role.members?.find((entry) => !entry.user?.bot) || null;
  return member?.user || null;
}

function formatMoneyline(odds) {
  const number = Number(odds || 0);
  return `${number > 0 ? '+' : ''}${number}`;
}

function buildBettingLine(line) {
  if (!line) return null;
  const predictedWinner = line.favorite === 'home' ? line.homeTeam : line.awayTeam;
  const extras = [];
  if (line.divisionGame) extras.push('Division game');
  if (line.isRematch && line.lastMeeting) {
    const rematchLabel = Number(line.lastMeeting.stage) === 2
      ? 'postseason rematch'
      : `last meeting: ${line.awayTeam} ${line.lastMeeting.awayScore}, ${line.homeTeam} ${line.lastMeeting.homeScore}`;
    extras.push(rematchLabel);
  }
  return [
    `Spread: ${line.awaySpreadDisplay} | ${line.homeSpreadDisplay}`,
    `Moneyline: ${line.awayTeam} ${formatMoneyline(line.awayMoneyline)} • ${line.homeTeam} ${formatMoneyline(line.homeMoneyline)}`,
    `Total: O/U ${Number(line.total || 0).toFixed(1)}`,
    `Predicted winner: **${predictedWinner}**`,
    ...(extras.length ? [extras.join(' • ')] : []),
  ].join('\n');
}

function currentWeekInfo(snapshot) {
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const rawWeekType = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? snapshot?.stage ?? 1;
  const weekType = Number.isFinite(Number(rawWeekType)) ? Number(rawWeekType) : 1;
  const displayWeek = Number(
    snapshot?.currentWeek ??
    seasonInfo.displayWeek ??
    (Number.isFinite(Number(seasonInfo.seasonWeek)) ? Number(seasonInfo.seasonWeek) + 1 : 1),
  );
  return {
    weekType,
    displayWeek: Number.isFinite(displayWeek) && displayWeek > 0 ? displayWeek : 1,
    offSeasonStage: Number(seasonInfo.offSeasonStage || 0),
    seasonInfo,
  };
}

function weekLabel(snapshot) {
  const { weekType, displayWeek, offSeasonStage } = currentWeekInfo(snapshot);
  if (weekType === 2) return `Postseason ${snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || ''}`.trim();
  if (weekType === 1) return `Week ${displayWeek}`;
  if (offSeasonStage === 1) return 'Re-sign Period';
  if (offSeasonStage === 2) return 'Free Agency';
  if (offSeasonStage === 3) return 'Draft Season';
  return 'Offseason';
}

function latestCompletedWeekIndex(snapshot, stage = 1) {
  return (snapshot?.weeklyStats || [])
    .filter((week) => Number(week?.stage ?? week?.stageIndex ?? 0) === Number(stage))
    .map((week) => Number(week?.weekIndex ?? -1))
    .filter((week) => week >= 0)
    .reduce((max, value) => Math.max(max, value), -1);
}

function inferredScheduleStatus(snapshot, game, stage = 1) {
  const explicit = Number(game?.status ?? 0);
  if (explicit >= 2) return 'played';
  if (explicit === 1) return 'scheduled';
  const latestCompleted = latestCompletedWeekIndex(snapshot, stage);
  const weekIndex = Number(game?.weekIndex ?? -1);
  if (weekIndex >= 0 && weekIndex <= latestCompleted) return 'played_inferred';
  return 'upcoming';
}

function findWeeklyMatchup(snapshot, teamId, explicitOpponentTeamId = null) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  const targetWeekIndex = Math.max(0, Number(displayWeek) - 1);
  const schedules = snapshot?.schedule?.schedules || [];
  const preferredStages = weekType === 2 ? [2, 1, 0] : [1, 0, 2];
  const candidates = schedules
    .filter((game) => Number(game?.homeTeamId) === Number(teamId) || Number(game?.awayTeamId) === Number(teamId))
    .filter((game) => {
      if (!explicitOpponentTeamId) return true;
      return Number(game?.homeTeamId) === Number(explicitOpponentTeamId) || Number(game?.awayTeamId) === Number(explicitOpponentTeamId);
    })
    .map((entry) => ({
      entry,
      stage: Number(entry?.stageIndex ?? entry?.stage ?? -1),
      weekIndex: Number(entry?.weekIndex ?? -1),
    }));

  for (const stage of preferredStages) {
    const exact = candidates
      .filter((game) => game.stage === stage && game.weekIndex === targetWeekIndex)
      .find((game) => ['scheduled', 'upcoming'].includes(inferredScheduleStatus(snapshot, game.entry, stage)));
    if (exact) return exact.entry;
  }
  for (const stage of preferredStages) {
    const next = candidates
      .filter((game) => game.stage === stage && game.weekIndex >= targetWeekIndex)
      .sort((a, b) => a.weekIndex - b.weekIndex)
      .find((game) => ['scheduled', 'upcoming'].includes(inferredScheduleStatus(snapshot, game.entry, stage)));
    if (next) return next.entry;
  }
  return candidates.sort((a, b) => a.weekIndex - b.weekIndex)[0]?.entry || null;
}

function recordByTeamId(snapshot) {
  return new Map(
    (snapshot?.standings?.teamStandingInfoList || []).map((team) => [Number(team.teamId), team]),
  );
}

function formatRecord(standing) {
  if (!standing) return '0-0';
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const ties = Number(standing?.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatLegacySummaryLine(label, user, balances, streamTotal, legacyInPlay) {
  const display = user ? `<@${user.id}>` : label;
  const legacy = Number(balances?.legacy || 0);
  const legacyInPlayTotal = Number(legacyInPlay?.total || 0);
  return `${RECOGNITION_EMOJIS.legacy} ${display} • Legacy ${legacy} • On the line +${legacyInPlayTotal} • 📺 ${Number(streamTotal || 0)} streams`;
}

function formatLegacyOutlook(lineA, lineB) {
  return [lineA, lineB].join('\n');
}

function hashSeed(...values) {
  const text = values.map((value) => String(value || '')).join('|');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return Math.abs(hash);
}

function pickVariant(seed, options = []) {
  if (!options.length) return '';
  return options[seed % options.length];
}

function playerImpact(player = {}) {
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    return Number(player?.passYds || player?.pass?.yds || 0) * 0.35 +
      Number(player?.passTDs || player?.pass?.td || 0) * 18 -
      Number(player?.passInts || player?.pass?.int || 0) * 8 +
      Number(player?.rushYds || player?.rush?.yds || 0) * 0.2 +
      Number(player?.rushTDs || player?.rush?.td || 0) * 16;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return Number(player?.rushYds || player?.rush?.yds || 0) * 0.4 +
      Number(player?.rushTDs || player?.rush?.td || 0) * 18 +
      Number(player?.recYds || player?.rec?.yds || 0) * 0.2;
  }
  if (['WR', 'TE'].includes(pos)) {
    return Number(player?.recYds || player?.rec?.yds || 0) * 0.35 +
      Number(player?.recTDs || player?.rec?.td || 0) * 18;
  }
  return Number(player?.sacks || player?.def?.sacks || 0) * 20 +
    Number(player?.interceptions || player?.def?.ints || 0) * 18 +
    Number(player?.def?.tfl || 0) * 6 +
    Number(player?.def?.tackles || 0) * 0.5;
}

function qbEfficiencyScore(player = {}) {
  const passAtt = Number(player?.passAtt || player?.pass?.att || 0);
  const passComp = Number(player?.passComp || player?.pass?.comp || 0);
  const passYds = Number(player?.passYds || player?.pass?.yds || 0);
  const passTD = Number(player?.passTDs || player?.pass?.td || 0);
  const ints = Number(player?.passInts || player?.pass?.int || 0);
  const compPct = passAtt > 0 ? (passComp / passAtt) * 100 : 0;
  const ypa = passAtt > 0 ? passYds / passAtt : 0;
  return (compPct - 60) * 3.5 + (ypa - 7) * 18 + (passTD * 16) - (ints * 20);
}

function spotlightScore(player = {}) {
  const pos = String(player?.position || '').toUpperCase();
  const base = playerImpact(player);
  if (pos === 'QB') {
    return base * 0.62 + qbEfficiencyScore(player);
  }
  if (['WR', 'TE'].includes(pos)) {
    const recYds = Number(player?.recYds || player?.rec?.yds || 0);
    const recTD = Number(player?.recTDs || player?.rec?.td || 0);
    return base + (recYds >= 110 ? 22 : 0) + (recYds >= 150 ? 18 : 0) + (recTD >= 2 ? 20 : 0);
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    const rushYds = Number(player?.rushYds || player?.rush?.yds || 0);
    const scrimYds = rushYds + Number(player?.recYds || player?.rec?.yds || 0);
    const rushTD = Number(player?.rushTDs || player?.rush?.td || 0);
    return base + (scrimYds >= 120 ? 18 : 0) + (scrimYds >= 160 ? 16 : 0) + (rushTD >= 2 ? 18 : 0);
  }
  const sacks = Number(player?.sacks || player?.def?.sacks || 0);
  const ints = Number(player?.interceptions || player?.def?.ints || 0);
  return base + (sacks >= 2 ? 18 : 0) + (ints >= 2 ? 18 : 0);
}

function teamStatLine(stats = {}) {
  const games = Math.max(1, Number(stats?.games || 0));
  return {
    passYpg: average(stats?.pass?.yds, games),
    rushYpg: average(stats?.rush?.yds, games),
    sacksPerGame: average(stats?.def?.sacks, games),
    sacksAllowedPerGame: average(stats?.pass?.sacksTaken, games),
    compPct: Number(stats?.pass?.att || 0) > 0
      ? (Number(stats?.pass?.comp || 0) / Number(stats?.pass?.att || 1)) * 100
      : 0,
  };
}

function rosterForTeam(snapshot, teamId) {
  return snapshot?.rosters?.teams?.[String(teamId)]?.rosterInfoList || [];
}

function sortByOvr(players = []) {
  return players.slice().sort((a, b) => playerOvr(b) - playerOvr(a));
}

function injuryPlayers(snapshot, teamId) {
  return rosterForTeam(snapshot, teamId)
    .filter((player) => Number(player?.injuryLength || 0) > 0)
    .slice();
}

function injuryPriority(player = {}) {
  const pos = String(player?.position || '').toUpperCase();
  const ovr = playerOvr(player);
  const weeks = Number(player?.injuryLength || 0);
  const posBoost =
    pos === 'QB' ? 60 :
    ['LT', 'RT', 'WR', 'TE', 'CB', 'FS', 'SS'].includes(pos) ? 42 :
    ['HB', 'RB', 'DT', 'LE', 'RE', 'MLB'].includes(pos) ? 30 :
    16;
  return posBoost + ovr + (weeks * 2);
}

function findImpactInjury(snapshot, teamId) {
  return injuryPlayers(snapshot, teamId)
    .sort((a, b) => injuryPriority(b) - injuryPriority(a))[0] || null;
}

function topImpactPlayers(players = [], count = 3) {
  return players
    .slice()
    .sort((a, b) => spotlightScore(b) - spotlightScore(a) || playerImpact(b) - playerImpact(a) || playerOvr(b) - playerOvr(a))
    .slice(0, count);
}

function teamLivePlayers(live, teamId) {
  return (live?.currentPlayersByTeamId?.[Number(teamId)] || []).slice();
}

function rookieCandidates(snapshot, live, teamId) {
  const liveByName = new Map(teamLivePlayers(live, teamId).map((player) => [normalizeName(player.name), player]));
  return rosterForTeam(snapshot, teamId)
    .filter((player) => player?.isRookie === true || Number(player?.yearsPro ?? -1) === 0)
    .map((player) => {
      const livePlayer = liveByName.get(normalizeName(formatPlayerName(player)));
      return {
        ...player,
        name: formatPlayerName(player),
        position: String(player?.position || '').toUpperCase(),
        impact: playerImpact(livePlayer || player) + (playerOvr(player) * 0.4),
      };
    })
    .sort((a, b) => b.impact - a.impact || playerOvr(b) - playerOvr(a))
    .slice(0, 2);
}

function qbShortLine(player = {}) {
  const passAtt = Number(player?.passAtt || player?.pass?.att || 0);
  const passComp = Number(player?.passComp || player?.pass?.comp || 0);
  const compPct = passAtt > 0 ? ((passComp / passAtt) * 100) : 0;
  const passYds = Number(player?.passYds || player?.pass?.yds || 0);
  const passTD = Number(player?.passTDs || player?.pass?.td || 0);
  const ints = Number(player?.passInts || player?.pass?.int || 0);
  return `${formatPlayerName(player)} (QB): ${passYds} yds, ${passTD}-${ints}, ${compPct.toFixed(1)}%`;
}

function qbNarrativeLine(player = {}) {
  const passAtt = Number(player?.passAtt || player?.pass?.att || 0);
  const passComp = Number(player?.passComp || player?.pass?.comp || 0);
  const compPct = passAtt > 0 ? ((passComp / passAtt) * 100) : 0;
  const passYds = Number(player?.passYds || player?.pass?.yds || 0);
  const passTD = Number(player?.passTDs || player?.pass?.td || 0);
  const ints = Number(player?.passInts || player?.pass?.int || 0);
  return `${formatPlayerName(player)} is sitting at ${passYds} passing yards with a ${passTD}-${ints} TD-INT line and a ${compPct.toFixed(1)}% completion rate`;
}

function qbIsWatchworthy(player = {}) {
  const passAtt = Number(player?.passAtt || player?.pass?.att || 0);
  const passComp = Number(player?.passComp || player?.pass?.comp || 0);
  const passTD = Number(player?.passTDs || player?.pass?.td || 0);
  const ints = Number(player?.passInts || player?.pass?.int || 0);
  const compPct = passAtt > 0 ? (passComp / passAtt) * 100 : 0;
  return compPct >= 65 || passTD - ints >= 3 || spotlightScore(player) >= 230;
}

function nonQbShortLine(player = {}) {
  const pos = String(player?.position || '').toUpperCase();
  if (['WR', 'TE'].includes(pos)) {
    const recYds = Number(player?.recYds || player?.rec?.yds || 0);
    const recTD = Number(player?.recTDs || player?.rec?.td || 0);
    return `${formatPlayerName(player)} (${pos}): ${recYds} rec yds, ${recTD} TD`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    const rushYds = Number(player?.rushYds || player?.rush?.yds || 0);
    const rushTD = Number(player?.rushTDs || player?.rush?.td || 0);
    return `${formatPlayerName(player)} (${pos}): ${rushYds} rush yds, ${rushTD} TD`;
  }
  const sacks = Number(player?.sacks || player?.def?.sacks || 0);
  const ints = Number(player?.interceptions || player?.def?.ints || 0);
  if (sacks > 0) return `${formatPlayerName(player)} (${pos}): ${sacks} sacks`;
  if (ints > 0) return `${formatPlayerName(player)} (${pos}): ${ints} INT`;
  return `${formatPlayerName(player)} (${pos})`;
}

function defensiveStarNote(player = {}) {
  const sacks = Number(player?.sacks || player?.def?.sacks || 0);
  const ints = Number(player?.interceptions || player?.def?.ints || 0);
  const pos = String(player?.position || '').toUpperCase();
  if (sacks > 0) return `${formatPlayerName(player)} (${pos}) has ${sacks} sacks and is the first pressure alert on tape.`;
  if (ints > 0) return `${formatPlayerName(player)} (${pos}) has ${ints} interceptions and can flip the game if the ball hangs.`;
  return `${formatPlayerName(player)} (${pos}) is one of the cleaner defensive tone-setters in this matchup.`;
}

function findTeamQuarterback(players = []) {
  return players
    .filter((player) => String(player?.position || '').toUpperCase() === 'QB')
    .sort((a, b) => spotlightScore(b) - spotlightScore(a) || playerImpact(b) - playerImpact(a) || playerOvr(b) - playerOvr(a))[0] || null;
}

function findDefenseToneSetter(players = []) {
  return players
    .filter((player) => ['LE', 'RE', 'DT', 'ROLB', 'LOLB', 'MLB', 'CB', 'FS', 'SS'].includes(String(player?.position || '').toUpperCase()))
    .sort((a, b) => spotlightScore(b) - spotlightScore(a) || playerImpact(b) - playerImpact(a) || playerOvr(b) - playerOvr(a))[0] || null;
}

function findBestNonQuarterback(players = []) {
  return players
    .filter((player) => String(player?.position || '').toUpperCase() !== 'QB')
    .sort((a, b) => spotlightScore(b) - spotlightScore(a) || playerImpact(b) - playerImpact(a) || playerOvr(b) - playerOvr(a))[0] || null;
}

function classifyGameContext(snapshot, ownStanding, oppStanding) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  if (weekType === 2) return 'postseason';
  const ownWins = Number(ownStanding?.totalWins || 0);
  const ownLosses = Number(ownStanding?.totalLosses || 0);
  const oppWins = Number(oppStanding?.totalWins || 0);
  const oppLosses = Number(oppStanding?.totalLosses || 0);
  if (displayWeek >= 14) return 'stretch';
  if (Math.abs((ownWins - ownLosses) - (oppWins - oppLosses)) >= 4) return 'contrast';
  if (displayWeek <= 4) return 'early';
  return 'middle';
}

function buildWhyWatch({
  snapshot,
  ownTeam,
  oppTeam,
  ownStats,
  oppStats,
  ownStanding,
  oppStanding,
  seed,
}) {
  const ownLine = teamStatLine(ownStats);
  const oppLine = teamStatLine(oppStats);
  const context = classifyGameContext(snapshot, ownStanding, oppStanding);
  const openers = {
    postseason: [
      `This one is carrying postseason weight now, so one wasted possession can swing the whole watch window.`,
      `Playoff football is in the air here, which usually means the first clean answer matters more than volume.`,
    ],
    stretch: [
      `This has stretch-run pressure on it, not just another week on the board.`,
      `The calendar is late enough now that one sharp performance changes how this matchup is read.`,
    ],
    contrast: [
      `${ownTeam.fullName} and ${oppTeam.fullName} are coming in on different tracks, which usually sharpens the first few drives.`,
      `This matchup brings two different season stories into the same window, and that usually shows up early.`,
    ],
    early: [
      `The season is still young enough for one clean performance to change how this matchup is being read.`,
      `This is still early enough in the year for momentum to change fast, which makes the first quarter matter.`,
    ],
    middle: [
      `There is enough live form behind this matchup now for it to feel like a real measuring-stick spot.`,
      `This lands in the part of the season where identity starts to stick, so the tone should show early.`,
    ],
  };

  const ownIdentity = ownLine.passYpg >= ownLine.rushYpg
    ? `${ownTeam.fullName} are leaning pass-first at ${ownLine.passYpg.toFixed(1)} pass yards per game`
    : `${ownTeam.fullName} have been more ground-led at ${ownLine.rushYpg.toFixed(1)} rush yards per game`;
  const oppIdentity = oppLine.passYpg >= oppLine.rushYpg
    ? `${oppTeam.fullName} counter with ${oppLine.passYpg.toFixed(1)} pass yards per game`
    : `${oppTeam.fullName} counter with ${oppLine.rushYpg.toFixed(1)} rush yards per game`;
  const tension = ownLine.sacksAllowedPerGame >= 2.5 || oppLine.sacksPerGame >= 2.5
    ? `The watch point early is whether ${ownTeam.fullName} can keep the pocket clean enough to stay on schedule.`
    : `If the first few drives stay clean, this should settle into a real back-and-forth instead of a scramble game.`;

  return `${pickVariant(seed, openers[context])} ${ownIdentity}, and ${oppIdentity}. ${tension}`;
}

function buildGameOutlook({
  ownTeam,
  oppTeam,
  ownStanding,
  oppStanding,
  ownStats,
  oppStats,
  seed,
}) {
  const ownRecord = formatRecord(ownStanding);
  const oppRecord = formatRecord(oppStanding);
  const ownLine = teamStatLine(ownStats);
  const oppLine = teamStatLine(oppStats);
  const options = [
    `${ownTeam.fullName} come in at ${ownRecord} and have leaned more on the pass game than the run, while ${oppTeam.fullName} at ${oppRecord} have been the steadier offense through the air so far.`,
    `${ownTeam.fullName} are still trying to find a cleaner offensive rhythm at ${ownRecord}, while ${oppTeam.fullName} have looked more settled at ${oppRecord} with the better passing output to this point.`,
    `${ownTeam.fullName} have had to live through more uneven football so far, while ${oppTeam.fullName} have built the more stable profile and usually look more comfortable when the game turns pass-heavy.`,
  ];
  return pickVariant(seed + 3, options);
}

function buildStakesLine(snapshot, ownTeam, oppTeam, ownStanding, oppStanding, seed) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  const ownWins = Number(ownStanding?.totalWins || 0);
  const ownLosses = Number(ownStanding?.totalLosses || 0);
  const oppWins = Number(oppStanding?.totalWins || 0);
  const oppLosses = Number(oppStanding?.totalLosses || 0);
  if (weekType === 2) {
    return pickVariant(seed + 21, [
      `This is postseason football now, so the margin for a slow start is gone.`,
      `The postseason puts more weight on every clean possession in a matchup like this.`,
    ]);
  }
  if (displayWeek >= 12 && ownWins <= ownLosses && oppWins > oppLosses) {
    return `${ownTeam.fullName} need a sharper week here to keep the season from slipping further, while ${oppTeam.fullName} are trying to keep firm control of their spot.`;
  }
  if (displayWeek >= 12 && ownWins > ownLosses && oppWins > oppLosses) {
    return `Both sides are late enough into the year for this one to matter in the standings picture, not just the weekly window.`;
  }
  if (ownWins === 0 && ownLosses >= 4) {
    return `${ownTeam.fullName} are at the point where they need traction, while ${oppTeam.fullName} have a chance to press the gap wider.`;
  }
  if (Math.abs((ownWins - ownLosses) - (oppWins - oppLosses)) >= 4) {
    return `These teams are coming in from different places in the season arc, and that usually sharpens the first real momentum swing.`;
  }
  return pickVariant(seed + 22, [
    `This one matters more for tone and identity than the records alone would say.`,
    `This is the kind of matchup that can reshape how both teams are being read going into next week.`,
  ]);
}

function buildInjuryContextLine(snapshot, ownTeam, oppTeam, ownTeamId, oppTeamId, seed) {
  const ownInjury = findImpactInjury(snapshot, ownTeamId);
  const oppInjury = findImpactInjury(snapshot, oppTeamId);

  if (ownInjury && String(ownInjury.position || '').toUpperCase() === 'QB') {
    const backup = sortByOvr(
      rosterForTeam(snapshot, ownTeamId).filter((player) =>
        String(player?.position || '').toUpperCase() === 'QB' &&
        normalizeName(formatPlayerName(player)) !== normalizeName(formatPlayerName(ownInjury)),
      ),
    )[0];
    return `${formatPlayerName(ownInjury)} (QB) is out, so ${ownTeam.fullName} are asking ${backup ? `${formatPlayerName(backup)} (${playerOvr(backup)} OVR)` : 'the backup'} to keep the offense on schedule.`;
  }
  if (oppInjury && String(oppInjury.position || '').toUpperCase() === 'QB') {
    const backup = sortByOvr(
      rosterForTeam(snapshot, oppTeamId).filter((player) =>
        String(player?.position || '').toUpperCase() === 'QB' &&
        normalizeName(formatPlayerName(player)) !== normalizeName(formatPlayerName(oppInjury)),
      ),
    )[0];
    return `${formatPlayerName(oppInjury)} (QB) is out, which changes the whole look of ${oppTeam.fullName} and puts more on ${backup ? formatPlayerName(backup) : 'the backup'} early.`;
  }
  if (ownInjury) {
    const pos = String(ownInjury.position || '').toUpperCase();
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) {
      return `${formatPlayerName(ownInjury)} (${pos}) being out puts more stress on ${ownTeam.fullName} protection, so that spot is worth watching immediately.`;
    }
    if (['WR', 'TE', 'HB', 'RB'].includes(pos)) {
      return `${formatPlayerName(ownInjury)} (${pos}) is out, so ${ownTeam.fullName} have to redistribute touches and create offense a little differently this week.`;
    }
    if (['CB', 'FS', 'SS'].includes(pos)) {
      return `${formatPlayerName(ownInjury)} (${pos}) is out, so ${ownTeam.fullName} may need more help over the top and cleaner coverage communication.`;
    }
  }
  if (oppInjury) {
    const pos = String(oppInjury.position || '').toUpperCase();
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) {
      return `${formatPlayerName(oppInjury)} (${pos}) is out for ${oppTeam.fullName}, which should put the protection under more stress if that replacement spot gets tested.`;
    }
    if (['WR', 'TE', 'HB', 'RB'].includes(pos)) {
      return `${formatPlayerName(oppInjury)} (${pos}) is out for ${oppTeam.fullName}, which takes one of their cleaner answers off the board and shifts the workload elsewhere.`;
    }
    if (['CB', 'FS', 'SS'].includes(pos)) {
      return `${formatPlayerName(oppInjury)} (${pos}) is out for ${oppTeam.fullName}, so the back end is a little easier to stress if the game opens up.`;
    }
  }
  return pickVariant(seed + 23, [
    'Both sides look close to full strength in the current export, so this feels more like a clean personnel matchup than an injury game.',
    'There are no major missing stars in the current export, which puts the focus more on form and matchup than replacement stress.',
  ]);
}

function buildMatchupLever({
  ownTeam,
  oppTeam,
  ownPlayers,
  oppPlayers,
  ownStats,
  oppStats,
  ownRookies,
  oppRookies,
  seed,
}) {
  const ownQb = findTeamQuarterback(ownPlayers);
  const oppQb = findTeamQuarterback(oppPlayers);
  const ownStar = topImpactPlayers(ownPlayers, 1)[0];
  const oppDef = findDefenseToneSetter(oppPlayers);
  const ownLine = teamStatLine(ownStats);
  const oppLine = teamStatLine(oppStats);
  const rookie = ownRookies[0] || oppRookies[0] || null;

  const options = [
    ownQb && qbIsWatchworthy(ownQb)
      ? `${qbNarrativeLine(ownQb)}, and the hinge is whether ${ownTeam.fullName} can get him settled before ${oppTeam.fullName} speed the whole game up.`
      : null,
    oppDef
      ? `${defensiveStarNote(oppDef)} If that pressure lands early, this matchup can tilt fast.`
      : null,
    ownStar && String(ownStar.position || '').toUpperCase() !== 'QB'
      ? `${nonQbShortLine(ownStar)} If ${ownTeam.fullName} can get that matchup rolling, the whole game opens up differently.`
      : null,
    ownLine.sacksAllowedPerGame >= 2.2 || oppLine.sacksPerGame >= 2.2
      ? `${ownTeam.fullName} are at ${ownLine.sacksAllowedPerGame.toFixed(1)} sacks allowed per game, while ${oppTeam.fullName} are creating ${oppLine.sacksPerGame.toFixed(1)}. Protection is the first lever to watch.`
      : null,
    rookie
      ? `Keep an eye on ${formatPlayerName(rookie)} (${String(rookie.position || '').toUpperCase()}). This is the kind of week where a young piece can steal a few moments.`
      : null,
    oppQb
      ? `${qbShortLine(oppQb)} If ${ownTeam.fullName} do not disrupt timing, the opposing quarterback can settle this game down quickly.`
      : null,
  ].filter(Boolean);

  return pickVariant(seed + 17, options);
}

function buildPlayersToWatch({
  ownPlayers,
  oppPlayers,
  ownRookies,
  oppRookies,
}) {
  const watch = [];
  const ownTop = topImpactPlayers(ownPlayers, 1)[0];
  const oppTop = topImpactPlayers(oppPlayers, 1)[0];
  const ownDef = findDefenseToneSetter(ownPlayers);
  const oppDef = findDefenseToneSetter(oppPlayers);
  const ownNonQb = findBestNonQuarterback(ownPlayers);
  const oppNonQb = findBestNonQuarterback(oppPlayers);
  const rookie = ownRookies[0] || oppRookies[0] || null;
  const ownStar = ownDef && spotlightScore(ownDef) >= spotlightScore(ownTop) * 0.85
    ? ownDef
    : (String(ownTop?.position || '').toUpperCase() === 'QB' && ownNonQb ? ownNonQb : ownTop);
  const oppStar = oppDef && spotlightScore(oppDef) >= spotlightScore(oppTop) * 0.85
    ? oppDef
    : (String(oppTop?.position || '').toUpperCase() === 'QB' && oppNonQb ? oppNonQb : oppTop);

  if (ownStar) {
    const pos = String(ownStar.position || '').toUpperCase();
    watch.push(`Own spotlight: ${pos === 'QB' ? qbShortLine(ownStar) : nonQbShortLine(ownStar)}`);
  }
  if (oppStar && normalizeName(formatPlayerName(oppStar)) !== normalizeName(formatPlayerName(ownStar))) {
    const pos = String(oppStar.position || '').toUpperCase();
    watch.push(`Opponent spotlight: ${pos === 'QB' ? qbShortLine(oppStar) : nonQbShortLine(oppStar)}`);
  }
  if (rookie) {
    watch.push(`Rookie watch: ${formatPlayerName(rookie)} (${String(rookie.position || '').toUpperCase()})`);
  }
  return watch.slice(0, 3).join('\n');
}

function stripTrailingPeriod(text = '') {
  return String(text || '').replace(/\.\s*$/, '').trim();
}

function firstSentence(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = value.match(/^.+?[.!?](?:\s|$)/);
  return (match ? match[0] : value).trim();
}

function buildGameBrief({
  snapshot,
  ownTeam,
  oppTeam,
  ownStanding,
  oppStanding,
  ownTeamId,
  oppTeamId,
  seed,
  whyWatch,
  gameOutlook,
  matchupLever,
  watchList,
  bettingLine,
}) {
  const watchLines = String(watchList || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const playerSentence = watchLines.length
    ? `Players to watch: ${watchLines
      .map((line) => stripTrailingPeriod(line.replace(/^[^:]+:\s*/, '')))
      .join('; ')}.`
    : '';
  const stakes = buildStakesLine(snapshot, ownTeam, oppTeam, ownStanding, oppStanding, seed);
  const injury = buildInjuryContextLine(snapshot, ownTeam, oppTeam, ownTeamId, oppTeamId, seed);
  const rivalryRematch = buildDivisionRematchLine(bettingLine, ownTeam, oppTeam, seed);
  const h2hStatLine = buildHeadToHeadStatLine(bettingLine, ownTeam, oppTeam);
  const modules = [
    firstSentence(whyWatch),
    stakes,
    rivalryRematch,
    stripTrailingPeriod(gameOutlook) ? `${stripTrailingPeriod(gameOutlook)}.` : '',
    stripTrailingPeriod(matchupLever) ? `${stripTrailingPeriod(matchupLever)}.` : '',
    h2hStatLine,
    injury,
    playerSentence,
  ];
  const orders = [
    [0, 1, 2, 3, 5, 6, 4],
    [1, 0, 2, 5, 3, 6, 4],
    [0, 2, 3, 4, 5, 1, 6],
    [5, 1, 0, 2, 3, 6, 4],
  ];
  const order = orders[seed % orders.length];
  return order
    .map((index) => modules[index])
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

function buildPhaseHook(snapshot, ownStanding, oppStanding, seed) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  if (weekType === 2) {
    return pickVariant(seed + 7, [
      'Playoff football usually strips the game down to a handful of high-leverage snaps.',
      'Postseason windows usually come down to which side wastes fewer possessions.',
    ]);
  }
  if (displayWeek >= 15) {
    return pickVariant(seed + 7, [
      'This late in the year, clean situational football matters more than style points.',
      'The later the calendar gets, the more one bad quarter can change the standings picture.',
    ]);
  }
  const ownWins = Number(ownStanding?.totalWins || 0);
  const oppWins = Number(oppStanding?.totalWins || 0);
  if (Math.abs(ownWins - oppWins) >= 3) {
    return pickVariant(seed + 7, [
      'The records are not landing in the same place, but that usually makes the early tone more interesting, not less.',
      'Different records are coming into the same stream window, and that usually sharpens the first few possessions.',
    ]);
  }
  return pickVariant(seed + 7, [
    'This looks like the kind of game where the first clean answer changes the whole tone of the night.',
    'There is enough balance here for one matchup swing to reshape the whole game flow.',
  ]);
}

function buildDivisionRematchLine(line, ownTeam, oppTeam, seed) {
  if (!line) return null;
  const last = line.lastMeeting;
  if (line.divisionGame && last) {
    const ownWasAway = Number(last.awayTeamId) === Number(ownTeam.teamId);
    const ownScore = ownWasAway ? Number(last.awayScore || 0) : Number(last.homeScore || 0);
    const oppScore = ownWasAway ? Number(last.homeScore || 0) : Number(last.awayScore || 0);
    const meetingLabel = Number(last.stage) === 2 ? 'the last postseason meeting' : 'the first meeting';
    return `${ownScore > oppScore ? ownTeam.fullName : oppTeam.fullName} took ${meetingLabel} ${Math.max(ownScore, oppScore)}-${Math.min(ownScore, oppScore)}, and division rematches usually carry more adjustment memory than a normal week.`;
  }
  if (line.divisionGame) {
    return pickVariant(seed + 44, [
      'This is a division game, so both sides should already know the shell of the game plan. The next counter usually matters more than the opener.',
      'Division football usually strips some mystery out of the matchup, which makes the first real adjustment more important than the first call.',
    ]);
  }
  if (last) {
    const ownWasAway = Number(last.awayTeamId) === Number(ownTeam.teamId);
    const ownScore = ownWasAway ? Number(last.awayScore || 0) : Number(last.homeScore || 0);
    const oppScore = ownWasAway ? Number(last.homeScore || 0) : Number(last.awayScore || 0);
    const meetingLabel = Number(last.stage) === 2 ? 'the last postseason meeting' : 'the last meeting';
    return `${ownScore > oppScore ? ownTeam.fullName : oppTeam.fullName} took ${meetingLabel} ${Math.max(ownScore, oppScore)}-${Math.min(ownScore, oppScore)}, so this one already has a real baseline instead of reading like a first look.`;
  }
  return null;
}

function buildHeadToHeadStatLine(line, ownTeam, oppTeam) {
  if (!line?.lastMeeting) return null;
  const last = line.lastMeeting;
  const ownWasAway = Number(last.awayTeamId) === Number(ownTeam.teamId);
  const ownScore = ownWasAway ? Number(last.awayScore || 0) : Number(last.homeScore || 0);
  const oppScore = ownWasAway ? Number(last.homeScore || 0) : Number(last.awayScore || 0);
  const total = ownScore + oppScore;
  if (Math.abs(ownScore - oppScore) <= 7) {
    return `The last matchup stayed tight at ${ownScore}-${oppScore}, so late-down execution and red-zone trips are the cleaner watch points in the rematch.`;
  }
  if (total >= 55) {
    return `The last matchup got loose on the scoreboard at ${ownScore}-${oppScore}, which is part of why the total is sitting where it is again this time.`;
  }
  return `The last matchup finished ${ownScore}-${oppScore}, so there is already a real scoreline to measure this one against.`;
}

export const data = new SlashCommandBuilder()
  .setName('madden-streamlink')
  .setDescription(coachCommandDescription('streamlink'))
  .addStringOption((o) => o.setName('link').setDescription('Streaming URL').setRequired(true))
  .addRoleOption((o) => o.setName('opponent_coach').setDescription('Opponent coach role for this stream post').setRequired(false))
  .addStringOption((o) => o.setName('note').setDescription('Optional short broadcast note').setRequired(false))
  .setDMPermission(false);

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-setleague first.', flags: 64 });
    return;
  }

  const snapshot = loadLeagueSnapshot(leagueId);
  const meta = getMaddenSnapshotContext(interaction.guildId, { leagueId, snapshot });
  const channelMap = loadMaddenChannelMap();
  const roleMap = loadRoleMap();
  const streamingChannelId = channelMap['Streaming links'];
  const ghostRoleId = roleMap['Ghost Legacy'];
  const channel = streamingChannelId ? await interaction.client.channels.fetch(streamingChannelId).catch(() => null) : null;

  if (!streamingChannelId) {
    await interaction.reply({ content: 'Streaming links channel not configured.', flags: 64 });
    return;
  }
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ content: 'Streaming links channel not accessible.', flags: 64 });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const ownTeam = coachTeamFromMember(interaction.member, roleMap, snapshot);
  if (!ownTeam) {
    await interaction.editReply({ content: 'Your coach role could not be matched to a Madden team.' });
    return;
  }

  const opponentRole = interaction.options.getRole('opponent_coach');
  const explicitOpponent = opponentRole ? resolveTeamFromRoleName(opponentRole.name, snapshot) : null;
  const matchup = findWeeklyMatchup(snapshot, ownTeam.teamId, explicitOpponent?.teamId || null);
  let opponentTeam = explicitOpponent;
  if (matchup && !opponentTeam) {
    const isHome = Number(matchup.homeTeamId) === Number(ownTeam.teamId);
    const opponentTeamId = Number(isHome ? matchup.awayTeamId : matchup.homeTeamId);
    opponentTeam = teamMap(snapshot).get(opponentTeamId) || null;
  }
  if (!opponentTeam) {
    await interaction.editReply({ content: 'No opponent could be resolved from your current matchup or the provided coach role.' });
    return;
  }

  const live = buildLiveDraftContext(snapshot);
  const statsByTeam = live?.teamStatsByTeamId || {};
  const standingsByTeam = recordByTeamId(snapshot);
  const ownStats = statsByTeam[ownTeam.teamId] || {};
  const oppStats = statsByTeam[opponentTeam.teamId] || {};
  const ownStanding = standingsByTeam.get(ownTeam.teamId) || null;
  const oppStanding = standingsByTeam.get(opponentTeam.teamId) || null;
  const ownPlayers = teamLivePlayers(live, ownTeam.teamId);
  const oppPlayers = teamLivePlayers(live, opponentTeam.teamId);
  const ownRookies = rookieCandidates(snapshot, live, ownTeam.teamId);
  const oppRookies = rookieCandidates(snapshot, live, opponentTeam.teamId);
  const ownCoachRoleId = resolveCoachRoleIdForTeam(ownTeam, roleMap);
  const opponentCoachRoleId = opponentRole?.id || resolveCoachRoleIdForTeam(opponentTeam, roleMap);
  const ownCoachUser = await resolveCoachUserFromRole(interaction.guild, ownCoachRoleId);
  const opponentCoachUser = await resolveCoachUserFromRole(interaction.guild, opponentCoachRoleId);
  const ownPerkState = ownCoachUser
    ? getRecognitionPerkState({
      guildId: interaction.guildId,
      league: 'madden',
      seasonKey: meta?.seasonKey,
      userId: ownCoachUser.id,
      weekKey: meta?.weekKey || null,
    })
    : null;
  const ownStreamTotal = ownCoachUser
    ? getRecognitionStreamTotal({
      guildId: interaction.guildId,
      league: 'madden',
      userId: ownCoachUser.id,
    })
    : 0;
  const oppPerkState = opponentCoachUser
    ? getRecognitionPerkState({
      guildId: interaction.guildId,
      league: 'madden',
      seasonKey: meta?.seasonKey,
      userId: opponentCoachUser.id,
      weekKey: meta?.weekKey || null,
    })
    : null;
  const oppStreamTotal = opponentCoachUser
    ? getRecognitionStreamTotal({
      guildId: interaction.guildId,
      league: 'madden',
      userId: opponentCoachUser.id,
    })
    : 0;
  const seed = hashSeed(meta?.seasonKey, meta?.weekKey, ownTeam.fullName, opponentTeam.fullName);
  const ownLegacyInPlay = getLegacyOpportunityForTeam({ snapshot, teamId: ownTeam.teamId });
  const oppLegacyInPlay = getLegacyOpportunityForTeam({ snapshot, teamId: opponentTeam.teamId });
  const isHome = matchup ? Number(matchup.homeTeamId) === Number(ownTeam.teamId) : false;
  const awayTeamId = matchup ? Number(matchup.awayTeamId) : (isHome ? opponentTeam.teamId : ownTeam.teamId);
  const homeTeamId = matchup ? Number(matchup.homeTeamId) : (isHome ? ownTeam.teamId : opponentTeam.teamId);
  const matchupTitle = matchup
    ? `${formatTeamLabelWithEmoji(isHome ? opponentTeam.fullName : ownTeam.fullName)} at ${formatTeamLabelWithEmoji(isHome ? ownTeam.fullName : opponentTeam.fullName)}`
    : `${formatTeamLabelWithEmoji(ownTeam.fullName)} vs ${formatTeamLabelWithEmoji(opponentTeam.fullName)}`;
  const bettingLine = getSportsbookLineForMatchup({
    guildId: interaction.guildId,
    awayTeamId,
    homeTeamId,
    seasonKey: meta?.seasonKey,
    weekNumber: meta?.weekNumber,
    snapshot,
  });

  const whyWatch = buildWhyWatch({
    snapshot,
    ownTeam,
    oppTeam: opponentTeam,
    ownStats,
    oppStats,
    ownStanding,
    oppStanding,
    seed,
  });
  const gameOutlook = buildGameOutlook({
    ownTeam,
    oppTeam: opponentTeam,
    ownStanding,
    oppStanding,
    ownStats,
    oppStats,
    seed,
  });
  const matchupLever = buildMatchupLever({
    ownTeam,
    oppTeam: opponentTeam,
    ownPlayers,
    oppPlayers,
    ownStats,
    oppStats,
    ownRookies,
    oppRookies,
    seed,
  });
  const watchList = buildPlayersToWatch({ ownPlayers, oppPlayers, ownRookies, oppRookies });
  const gameBrief = buildGameBrief({
    snapshot,
    ownTeam,
    oppTeam: opponentTeam,
    ownStanding,
    oppStanding,
    ownTeamId: ownTeam.teamId,
    oppTeamId: opponentTeam.teamId,
    seed,
    whyWatch,
    gameOutlook,
    matchupLever,
    watchList,
    bettingLine,
  });
  const phaseHook = buildPhaseHook(snapshot, ownStanding, oppStanding, seed);
  const note = interaction.options.getString('note');
  const link = interaction.options.getString('link');

  const titleVariants = [
    `${weekLabel(snapshot)} Stream Spotlight`,
    `${weekLabel(snapshot)} Watch Window`,
    `${weekLabel(snapshot)} Live Matchup`,
  ];

  const embed = new EmbedBuilder()
    .setColor(0xc89b3c)
    .setTitle(pickVariant(seed + 5, titleVariants))
    .setDescription(`**${matchupTitle}**\n${phaseHook}`)
    .addFields(
      {
        name: 'Matchup',
        value: `${formatTeamLabelWithEmoji(ownTeam.fullName)} (${formatRecord(ownStanding)}) vs ${formatTeamLabelWithEmoji(opponentTeam.fullName)} (${formatRecord(oppStanding)})`,
        inline: false,
      },
      {
        name: 'Game Brief',
        value: gameBrief || 'This matchup has enough live context behind it to be worth keeping on in the background.',
        inline: false,
      },
      ...(bettingLine ? [{
        name: 'Odds & Pick',
        value: buildBettingLine(bettingLine),
        inline: false,
      }] : []),
      {
        name: 'Coach Legacy Picture',
        value: formatLegacyOutlook(
          formatLegacySummaryLine(ownTeam.fullName, ownCoachUser, ownPerkState?.balances || {}, ownStreamTotal, ownLegacyInPlay),
          formatLegacySummaryLine(opponentTeam.fullName, opponentCoachUser, oppPerkState?.balances || {}, oppStreamTotal, oppLegacyInPlay),
        ),
        inline: false,
      },
      {
        name: 'Stream',
        value: link,
        inline: false,
      },
    )
    .setFooter({
      text: note
        ? `${interaction.user.tag} | ${note}`
        : `${interaction.user.tag} | ${meta?.seasonKey || 'season'} | ${meta?.weekKey || 'week'}`,
    })
    .setTimestamp(new Date());

  const roleMentions = [ghostRoleId, opponentRole?.id].filter(Boolean);
  const mentionParts = [
    ghostRoleId ? `<@&${ghostRoleId}>` : null,
    opponentRole?.id ? `<@&${opponentRole.id}>` : null,
  ].filter(Boolean);

  await channel.send({
    content: mentionParts.join(' '),
    embeds: [embed],
    allowedMentions: {
      parse: [],
      roles: roleMentions,
    },
  }).catch(() => null);

  await interaction.editReply({ content: `Stream link posted for ${matchupTitle}.` });
}

export default { data, execute };
