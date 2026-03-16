import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { buildLiveDraftContext } from './draft_live_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadRoleMap } from '../staff/staffUtils.js';

const data = new SlashCommandBuilder()
  .setName('madden-gamestrategy')
  .setDescription('Private weekly opponent strategy built from live stats, context, and inferred tendencies.');

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teamMap(snapshot) {
  const map = new Map();
  for (const team of snapshot?.teams?.leagueTeamInfoList || []) {
    map.set(Number(team.teamId), getFullTeamName(team, `Team ${team.teamId}`));
  }
  return map;
}

function findCoachTeam(member, snapshot) {
  const roleMap = loadRoleMap();
  const names = new Set(
    Object.keys(roleMap)
      .filter((name) => / coach$/i.test(name))
      .map((name) => name.replace(/ coach$/i, '').trim()),
  );
  const teamInfos = snapshot?.teams?.leagueTeamInfoList || [];
  const teamCandidates = teamInfos.map((team) => ({
    teamId: Number(team.teamId),
    fullName: getFullTeamName(team, `Team ${team.teamId}`),
    mascot: String(team.displayName || team.nickName || '').trim(),
    city: String(team.cityName || '').trim(),
    abbr: String(team.abbrName || '').trim(),
  }));
  for (const role of member?.roles?.cache?.values?.() || []) {
    const roleName = String(role.name || '').replace(/ coach$/i, '').trim();
    if (!names.has(roleName)) continue;
    const normRole = normalizeName(roleName);
    const match = teamCandidates.find((team) => {
      return [
        team.fullName,
        team.mascot,
        team.city,
        team.abbr,
      ].some((value) => normalizeName(value) === normRole);
    });
    if (match) return match;
  }
  return null;
}

function currentWeekInfo(snapshot) {
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const weekType = Number(seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? snapshot?.stage ?? 1);
  const displayWeek = Number(
    seasonInfo.displayWeek ??
    (Number.isFinite(Number(seasonInfo.seasonWeek)) ? Number(seasonInfo.seasonWeek) + 1 : null) ??
    (Number.isFinite(Number(snapshot?.currentWeek)) ? Number(snapshot.currentWeek) : 1)
  );
  return {
    weekType,
    displayWeek: Number.isFinite(displayWeek) ? displayWeek : 1,
    offSeasonStage: Number(seasonInfo.offSeasonStage || 0),
  };
}

function latestCompletedWeekIndex(snapshot, stage = 1) {
  const entries = (snapshot?.weeklyStats || [])
    .filter((week) => Number(week?.stage ?? week?.stageIndex ?? 0) === Number(stage))
    .map((week) => Number(week?.weekIndex ?? -1))
    .filter((week) => week >= 0);
  return entries.length ? Math.max(...entries) : -1;
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

function findWeeklyOpponent(snapshot, teamId) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  const targetWeekIndex = Math.max(0, Number(displayWeek) - 1);
  const schedules = snapshot?.schedule?.schedules || [];
  const preferredStages = weekType === 2 ? [2, 1, 0] : [1, 0, 2];

  const teamGames = schedules
    .filter((entry) => Number(entry?.homeTeamId) === teamId || Number(entry?.awayTeamId) === teamId)
    .map((entry) => ({
      entry,
      stage: Number(entry?.stageIndex ?? entry?.stage ?? -1),
      weekIndex: Number(entry?.weekIndex ?? -1),
    }));

  for (const stage of preferredStages) {
    const exactScheduled = teamGames
      .filter((game) => game.stage === stage && game.weekIndex === targetWeekIndex)
      .find((game) => ['scheduled', 'upcoming'].includes(inferredScheduleStatus(snapshot, game.entry, stage)));
    if (exactScheduled) return exactScheduled.entry;
  }

  for (const stage of preferredStages) {
    const nextScheduled = teamGames
      .filter((game) => game.stage === stage && game.weekIndex >= targetWeekIndex)
      .sort((a, b) => a.weekIndex - b.weekIndex)
      .find((game) => ['scheduled', 'upcoming'].includes(inferredScheduleStatus(snapshot, game.entry, stage)));
    if (nextScheduled) return nextScheduled.entry;
  }

  for (const stage of preferredStages) {
    const game = schedules.find((entry) => {
      const entryStage = Number(entry?.stageIndex ?? entry?.stage ?? -1);
      const weekIndex = Number(entry?.weekIndex ?? -1);
      return entryStage === stage &&
        weekIndex === targetWeekIndex &&
        (Number(entry?.homeTeamId) === teamId || Number(entry?.awayTeamId) === teamId);
    });
    if (game) return game;
  }
  return null;
}

function average(value, games) {
  return games > 0 ? Number(value || 0) / games : 0;
}

function leagueRank(teams, valueFn, teamId, descending = true) {
  const values = [...teams].map(([id, stats]) => ({ id, value: Number(valueFn(stats) || 0) }));
  values.sort((a, b) => descending ? b.value - a.value : a.value - b.value);
  const idx = values.findIndex((entry) => Number(entry.id) === Number(teamId));
  return idx >= 0 ? idx + 1 : null;
}

function ordinal(n) {
  if (!n) return 'N/A';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n}st`;
  if (mod10 === 2 && mod100 !== 12) return `${n}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${n}rd`;
  return `${n}th`;
}

function tendencyLabel(stats) {
  const passAtt = Number(stats?.pass?.att || 0);
  const rushAtt = Number(stats?.rush?.att || 0);
  const total = Math.max(1, passAtt + rushAtt);
  const passRate = passAtt / total;
  if (passRate >= 0.63) return 'pass-heavy';
  if (passRate <= 0.44) return 'run-heavy';
  return 'balanced';
}

function defensiveShape(stats, ranks = {}) {
  const games = Math.max(1, Number(stats?.games || 0));
  const passAllowed = average(stats?.def?.passYdsAllowed, games);
  const rushAllowed = average(stats?.def?.rushYdsAllowed, games);
  if ((ranks.passDefRank && ranks.passDefRank >= 22) && (ranks.rushDefRank && ranks.rushDefRank <= 18)) {
    return 'more vulnerable through the air than on the ground';
  }
  if ((ranks.rushDefRank && ranks.rushDefRank >= 22) && (ranks.passDefRank && ranks.passDefRank <= 18)) {
    return 'more vulnerable on the ground than through the air';
  }
  if (passAllowed >= 235 && rushAllowed <= 112) return 'more vulnerable through the air than on the ground';
  if (rushAllowed >= 118 && passAllowed <= 230) return 'more vulnerable on the ground than through the air';
  return 'fairly balanced defensively';
}

function playerOvr(player) {
  return Number(player?.playerBestOvr || player?.teamSchemeOvr || player?.overall || 0);
}

function playerDevTier(player) {
  const raw = player?.devTrait ?? player?.raw?.devTrait ?? player?.developmentTrait ?? player?.raw?.developmentTrait;
  const tier = Number(raw);
  return Number.isFinite(tier) ? tier : 0;
}

function formatPlayerName(player) {
  return player?.name || `${player?.firstName || ''} ${player?.lastName || ''}`.trim() || 'Unknown';
}

function playerImpact(player) {
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    return Number(player?.passYds || 0) * 0.35 +
      Number(player?.passTDs || 0) * 18 -
      Number(player?.passInts || 0) * 8 +
      Number(player?.rushYds || 0) * 0.2 +
      Number(player?.rushTDs || 0) * 16;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return Number(player?.rushYds || 0) * 0.4 +
      Number(player?.rushTDs || 0) * 18 +
      Number(player?.recYds || 0) * 0.2;
  }
  if (['WR', 'TE'].includes(pos)) {
    return Number(player?.recYds || 0) * 0.35 +
      Number(player?.recTDs || 0) * 18;
  }
  return Number(player?.sacks || 0) * 20 +
    Number(player?.interceptions || 0) * 18 +
    Number(player?.def?.tfl || 0) * 6 +
    Number(player?.def?.tackles || 0) * 0.5 +
    Number(player?.def?.pds || 0) * 4;
}

function topPlayers(players = [], predicate, limit = 2) {
  return players
    .filter(predicate)
    .sort((a, b) => playerImpact(b) - playerImpact(a))
    .slice(0, limit);
}

function strugglingPlayers(players = [], limit = 2) {
  return players
    .filter((player) => {
      const pos = String(player?.position || '').toUpperCase();
      if (pos === 'QB') {
        return Number(player?.passAtt || 0) >= 18 &&
          (Number(player?.passInts || 0) >= 2 || (Number(player?.passTDs || 0) <= 1 && Number(player?.passYds || 0) <= 210));
      }
      if (['HB', 'RB', 'FB'].includes(pos)) {
        return Number(player?.rushAtt || 0) >= 8 && Number(player?.rushYds || 0) <= 40;
      }
      if (['WR', 'TE'].includes(pos)) {
        return (Number(player?.recYds || 0) > 0 || Number(player?.recTDs || 0) > 0 || Number(player?.rec?.yds || 0) > 0) &&
          Number(player?.recYds || 0) <= 35 &&
          Number(player?.recTDs || 0) === 0;
      }
      return false;
    })
    .sort((a, b) => playerImpact(a) - playerImpact(b))
    .slice(0, limit);
}

function teamInjuries(snapshot, teamId, limit = 3) {
  const roster = snapshot?.rosters?.teams?.[String(teamId)]?.rosterInfoList || [];
  return roster
    .filter((player) => Number(player?.injuryLength || 0) > 0)
    .sort((a, b) => Number(b?.playerBestOvr || b?.teamSchemeOvr || 0) - Number(a?.playerBestOvr || a?.teamSchemeOvr || 0))
    .slice(0, limit)
    .map((player) => `${player.position} ${formatPlayerName(player)} — out ${Number(player.injuryLength || 0)} week${Number(player.injuryLength || 0) === 1 ? '' : 's'}`);
}

function teamInjuryPlayers(snapshot, teamId, limit = 3) {
  const roster = snapshot?.rosters?.teams?.[String(teamId)]?.rosterInfoList || [];
  return roster
    .filter((player) => Number(player?.injuryLength || 0) > 0)
    .sort((a, b) => Number(b?.playerBestOvr || b?.teamSchemeOvr || 0) - Number(a?.playerBestOvr || a?.teamSchemeOvr || 0))
    .slice(0, limit);
}

function findLivePlayerByName(players = [], name = '') {
  const norm = normalizeName(name);
  return players.find((player) => normalizeName(formatPlayerName(player)) === norm) || null;
}

function findImpactInjury(players = [], livePlayers = []) {
  const ranked = players
    .map((player) => {
      const live = findLivePlayerByName(livePlayers, formatPlayerName(player));
      const pos = String(player?.position || '').toUpperCase();
      let score = playerOvr(player) * 2;
      if (live) score += playerImpact(live);
      score += playerDevTier(player) * 25;
      if (['HB', 'RB', 'FB', 'WR', 'TE', 'QB'].includes(pos)) score += 40;
      if (pos === 'QB') score += 80;
      if (['CB', 'FS', 'SS', 'MLB', 'ROLB', 'LOLB', 'LE', 'RE', 'DT'].includes(pos)) score += 30;
      return { player, live, pos, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

function buildOpponentShiftLine(opponentTeamName, oppStats = {}, oppRanks = {}, oppInjuryPlayers = [], oppPlayers = []) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const passYpg = average(oppStats?.pass?.yds, games);
  const rushYpg = average(oppStats?.rush?.yds, games);
  const injury = findImpactInjury(oppInjuryPlayers, oppPlayers);
  if (!injury) {
    const tendency = tendencyLabel(oppStats);
    if (oppRanks.passOffRank <= 8) {
      return `${opponentTeamName} still look like a pass-first offense. The main job is keeping their air game from dictating the whole week.`;
    }
    if (oppRanks.rushOffRank <= 8) {
      return `${opponentTeamName} still want the run game to shape the script. Win early downs and make them throw into longer situations.`;
    }
    return `${opponentTeamName} have played more like a ${tendency} group than a one-lane offense. Do not hand them easy explosives or short fields.`;
  }

  const name = formatPlayerName(injury.player);
  if (['HB', 'RB', 'FB'].includes(injury.pos)) {
    const passLean = oppRanks.passOffRank <= 10 || passYpg >= rushYpg;
    return `${name} is out, so tilt less toward the run and more toward pass defense this week. Make their backup run game prove it${passLean ? ', then force the pass game to stay patient' : ''}.`;
  }
  if (['WR', 'TE'].includes(injury.pos)) {
    return `${name} is out, which takes away one of their cleaner targets. That lets you play tighter on the run game and their next receiving option.`;
  }
  if (injury.pos === 'QB') {
    return `${name} is out, so the whole offense changes. Pressure the backup early and do not let the run game settle the script for them.`;
  }
  if (['CB', 'FS', 'SS'].includes(injury.pos)) {
    return `${name} is out, so their secondary is the cleaner weakness to test. Be more willing to attack matchups outside and down the field.`;
  }
  if (['LE', 'RE', 'DT', 'ROLB', 'LOLB', 'MLB'].includes(injury.pos)) {
    return `${name} is out, so their front loses one of its better pieces. You can be more willing to stay balanced and challenge the box.`;
  }
  return `${name} being out changes some of their usual balance. Press the healthier side of their offense until they show another answer.`;
}

function buildOwnInjuryAdjustmentLine(ownInjuryPlayers = [], ownRoster = []) {
  const injury = findImpactInjury(ownInjuryPlayers, []);
  if (!injury) return null;
  const pos = String(injury.pos || '').toUpperCase();
  const name = formatPlayerName(injury.player);
  const weeks = Number(injury.player?.injuryLength || 0);
  const replacement = sortByOvr(
    ownRoster.filter((player) => String(player?.position || '').toUpperCase() === pos && normalizeName(formatPlayerName(player)) !== normalizeName(name)),
  )[0];
  const replacementOvr = replacement ? playerOvr(replacement) : 0;
  const replacementName = replacement ? formatPlayerName(replacement) : 'the replacement';

  if (['LT', 'RT'].includes(pos)) {
    return `${name} is out, so give the backup tackle more TE and RB help in protection and do not leave that edge exposed all game.`;
  }
  if (['LG', 'RG', 'C'].includes(pos)) {
    return `${name} is out, so protect the middle more this week and do not let interior pressure wreck the timing of the game.`;
  }
  if (pos === 'QB') {
    return `${name} is out, so trim the game down for the backup and let the run game and cleaner throws carry more of the load.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${name} is out, so do not force the run volume. Let the pass game and spacing carry more of the offense this week.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${name} is out, so spread the targets around more and avoid leaning too hard on one replacement option.`;
  }
  if (pos === 'CB') {
    return `${name} is out, so protect ${replacementName} more in coverage${replacementOvr && replacementOvr <= 76 ? ` at ${replacementOvr} OVR` : ''} and be more willing to play with help over that side instead of hanging him in pure iso looks.`;
  }
  if (['FS', 'SS'].includes(pos)) {
    return `${name} is out, so keep the secondary cleaner this week and do not ask ${replacementName} to erase everything late by himself${replacementOvr && replacementOvr <= 76 ? ` at ${replacementOvr} OVR` : ''}.`;
  }
  if (pos === 'MLB') {
    return `${name} is out, so tighten the box rules and do not ask ${replacementName} to handle all the traffic inside by himself${replacementOvr && replacementOvr <= 76 ? ` at ${replacementOvr} OVR` : ''}.`;
  }
  if (['ROLB', 'LOLB'].includes(pos)) {
    return `${name} is out, so be more careful about edge fits and underneath coverage rules with ${replacementName} rotating in${replacementOvr && replacementOvr <= 76 ? ` at ${replacementOvr} OVR` : ''}.`;
  }
  if (pos === 'DT') {
    return `${name} is out, so expect less push inside and be more careful about letting the run game get downhill too easily.`;
  }
  if (['LE', 'RE'].includes(pos)) {
    return `${name} is out, so do not count on four-man rush alone. Mix pressure better and make the coverage buy the front more time.`;
  }
  return `${name} is out ${weeks} weeks, so keep the game plan cleaner around that replacement spot.`;
}

function teamRosterPlayers(snapshot, teamId) {
  return snapshot?.rosters?.teams?.[String(teamId)]?.rosterInfoList || [];
}

function conferenceRaceLine(snapshot, standing, ownTeamName) {
  const { weekType, displayWeek } = currentWeekInfo(snapshot);
  if (weekType === 2) return `${ownTeamName} are in the postseason now. This is win-or-go-home football.`;
  if (!standing) return `${ownTeamName} are in the middle of the season grind. This week still matters for tone and direction.`;
  const conference = String(standing?.conferenceName || '').toLowerCase();
  const teams = (snapshot?.standings?.teamStandingInfoList || [])
    .filter((team) => String(team?.conferenceName || '').toLowerCase() === conference)
    .slice()
    .sort((a, b) => Number(b?.winPct || 0) - Number(a?.winPct || 0) || Number(b?.totalWins || 0) - Number(a?.totalWins || 0));
  const rank = teams.findIndex((team) => Number(team.teamId) === Number(standing?.teamId)) + 1;
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const gamesPlayed = wins + losses + Number(standing?.totalTies || 0);
  const gamesLeft = Math.max(0, 18 - gamesPlayed);
  const cutLineTeam = teams[6];
  const cutWins = Number(cutLineTeam?.totalWins || 0);
  const gap = cutWins - wins;

  if (displayWeek >= 5 && wins === 0 && losses >= 4) {
    return `${ownTeamName} badly need a result here. At ${wins}-${losses}, the season starts feeling urgent unless they stop the slide now.`;
  }
  if (displayWeek >= 6 && losses - wins >= 3) {
    return `${ownTeamName} need this week to keep the season from drifting further. Another loss would make the climb much steeper.`;
  }

  if (displayWeek >= 15 && rank > 7 && gap <= 1) {
    return `${ownTeamName} need this one to stay firmly in the playoff race. Another slip would put real pressure on the path back in.`;
  }
  if (displayWeek >= 15 && rank <= 7 && gamesLeft <= 4) {
    return `${ownTeamName} are playing to protect playoff ground now. A win would help hold position in the ${String(standing?.conferenceName || 'conference')} picture.`;
  }
  if (displayWeek >= 10 && losses > wins) {
    return `${ownTeamName} still need traction to stay relevant in the race. This is the kind of week that can keep the season alive or let it slide further.`;
  }
  return `${ownTeamName} are still in the long middle of the season. This week matters more for shape and leverage than pure desperation.`;
}

function buildApproachLines(ownStats, oppStats, ownRanks, oppRanks) {
  const lines = [];
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const ownPassYpg = average(ownStats?.pass?.yds, ownGames);
  const ownRushYpg = average(ownStats?.rush?.yds, ownGames);
  const oppPassAllowed = average(oppStats?.def?.passYdsAllowed, oppGames);
  const oppRushAllowed = average(oppStats?.def?.rushYdsAllowed, oppGames);
  const ownSacks = average(ownStats?.def?.sacks, ownGames);
  const oppSacksAllowed = average(oppStats?.pass?.sacksTaken, oppGames);
  const oppPassYpg = average(oppStats?.pass?.yds, oppGames);
  const oppRushYpg = average(oppStats?.rush?.yds, oppGames);

  if (ownPassYpg >= ownRushYpg && (oppRanks.passDefRank >= oppRanks.rushDefRank || oppPassAllowed >= 230)) {
    lines.push(`Lean into the passing game for the best results. ${opponentSideLabel(oppRanks.passDefRank, 'pass defense')} and ${oppPassAllowed.toFixed(1)} pass yards allowed per game point there.`);
  } else if (ownRushYpg > ownPassYpg && (oppRanks.rushDefRank >= 20 || oppRushAllowed >= 118)) {
    lines.push(`Test them on the ground early. ${oppRushAllowed.toFixed(1)} rush yards allowed per game gives you a real chance to stay on schedule.`);
  }

  if (ownSacks >= 2 && oppSacksAllowed >= 2.2) {
    lines.push(`Turn this into a pressure game. Their protection has been shaky enough that your front can change the whole script.`);
  }
  if (oppPassYpg >= 240 && oppRanks.passOffRank <= 10) {
    lines.push(`Do not let their passing rhythm settle in. Make them work underneath and force long drives instead of explosives.`);
  } else if (oppRushYpg >= 120 && oppRanks.rushOffRank <= 10) {
    lines.push(`The first job is taking away the run game. If you make them play left-handed, the matchup changes.`);
  }
  if (!lines.length) {
    lines.push(`This looks like a patience matchup. Start with your cleaner offense, protect the ball, and make them prove they can win without short fields.`);
  }
  return lines.slice(0, 3);
}

function buildStrategicLeanSentence(ownStats = {}, oppStats = {}, ownRanks = {}, oppRanks = {}) {
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const passAtt = Number(ownStats?.pass?.att || 0);
  const rushAtt = Number(ownStats?.rush?.att || 0);
  const totalAtt = Math.max(1, passAtt + rushAtt);
  const passRate = passAtt / totalAtt;
  const ownPassYpg = average(ownStats?.pass?.yds, ownGames);
  const ownRushYpg = average(ownStats?.rush?.yds, ownGames);
  const oppPassAllowed = average(oppStats?.def?.passYdsAllowed, oppGames);
  const oppRushAllowed = average(oppStats?.def?.rushYdsAllowed, oppGames);
  const passDefRank = Number(oppRanks?.passDefRank || 16);
  const rushDefRank = Number(oppRanks?.rushDefRank || 16);

  if (passRate >= 0.61 && (rushDefRank - passDefRank >= 5 || oppRushAllowed >= 118)) {
    return `You have leaned pass-heavy, but this is a better week to stay more balanced and make the run game carry more of the early script.`;
  }
  if (passRate <= 0.45 && (passDefRank - rushDefRank >= 5 || oppPassAllowed >= 235)) {
    return `You have leaned run-heavy, but this is a better week to open the pass game more and test their coverage depth.`;
  }
  if (rushDefRank >= 22 || oppRushAllowed >= 120) {
    return `The cleanest offensive path is leaning on the run game first, then making them defend your play-action off it.`;
  }
  if (passDefRank >= 22 || oppPassAllowed >= 235) {
    return `The cleanest offensive path is leaning on the pass game and making their coverage win enough snaps.`;
  }
  if (ownPassYpg >= ownRushYpg) {
    return `This is still more of a balanced week than a pass-only week, but the throw game should create the first clean edge.`;
  }
  return `This is still more of a balanced week than a run-only week, but the ground game should keep the script cleaner for you.`;
}

function buildDangerLines(ownStats, oppStats, ownRanks, oppRanks) {
  const lines = [];
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const ownPassAllowed = average(ownStats?.def?.passYdsAllowed, ownGames);
  const ownRushAllowed = average(ownStats?.def?.rushYdsAllowed, ownGames);
  const oppPassYpg = average(oppStats?.pass?.yds, oppGames);
  const oppRushYpg = average(oppStats?.rush?.yds, oppGames);

  if (ownPassAllowed >= 245 && oppPassYpg >= 230) {
    lines.push(`Your biggest risk is through the air. They already move it well enough to test a secondary that has given up ${ownPassAllowed.toFixed(1)} pass yards per game.`);
  }
  if (ownRushAllowed >= 120 && oppRushYpg >= 110) {
    lines.push(`The run game is a real danger area this week. If they stay efficient on early downs, the matchup gets harder fast.`);
  }
  if (oppRanks.turnoverRank <= 10) {
    lines.push(`They do not usually beat themselves. Expect a cleaner offense and make them earn mistakes instead of waiting for them.`);
  }
  if (oppRanks.passOffRank <= 5 && !lines.some((line) => line.includes('through the air'))) {
    lines.push(`Their passing game deserves real attention. A top-five air attack can flip a game quickly if you give them easy explosives.`);
  }
  if (!lines.length) {
    lines.push(`The danger this week is more about game script than one glaring weakness. Falling behind would let them play on their terms.`);
  }
  return lines.slice(0, 3);
}

function opponentSideLabel(rank, label) {
  if (!rank) return `their ${label}`;
  if (rank >= 25) return `a bottom-tier ${label}`;
  if (rank >= 18) return `a softer ${label}`;
  if (rank <= 8) return `a strong ${label}`;
  return `their ${label}`;
}

function teamRankBundle(live, teamId) {
  const entries = Object.entries(live?.teamStatsByTeamId || {});
  const wrap = (fn, descending = true) => leagueRank(entries, fn, teamId, descending);
  return {
    passOffRank: wrap((stats) => average(stats?.pass?.yds, stats?.games)),
    rushOffRank: wrap((stats) => average(stats?.rush?.yds, stats?.games)),
    sacksRank: wrap((stats) => average(stats?.def?.sacks, stats?.games)),
    turnoverRank: wrap((stats) => -(average(stats?.pass?.int, stats?.games)), true),
    passDefRank: wrap((stats) => average(stats?.def?.passYdsAllowed, stats?.games), false),
    rushDefRank: wrap((stats) => average(stats?.def?.rushYdsAllowed, stats?.games), false),
  };
}

function compactTeamSnapshot(teamName, stats) {
  const games = Math.max(1, Number(stats?.games || 0));
  return [
    `${teamName}: ${average(stats?.pass?.yds, games).toFixed(1)} pass ypg`,
    `${average(stats?.rush?.yds, games).toFixed(1)} rush ypg`,
    `${average(stats?.def?.sacks, games).toFixed(1)} sacks/g`,
  ].join(' | ');
}

function recordLabel(standing) {
  if (!standing) return 'N/A';
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const ties = Number(standing?.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function concisePlayerLine(player, mode = 'generic') {
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    return `${player.name} (${pos}) — ${Number(player.passTDs || 0)} TD, ${Number(player.passInts || 0)} INT`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${player.name} (${pos}) — ${Number(player.rushYds || 0)} rush yds, ${Number(player.rushTDs || 0)} TD`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${player.name} (${pos}) — ${Number(player.recYds || 0)} rec yds, ${Number(player.recTDs || 0)} TD`;
  }
  return `${player.name} (${pos}) — ${Number(player.sacks || 0)} sacks, ${Number(player.interceptions || 0)} INT`;
}

function buildGamePlanText(approachLines = [], dangerLines = []) {
  const offense = approachLines[0] || '';
  const defense = approachLines.find((line) => line !== offense && /passing rhythm|run game|pressure game|underneath|left-handed/i.test(line)) || dangerLines[0] || '';
  const caution = dangerLines.find((line) => line !== defense) || '';
  return [offense, defense, caution].filter(Boolean).slice(0, 3).join('\n');
}

function buildQuickRead({
  contextLine = '',
  shiftLine = '',
  ownAdjustmentLine = '',
  strategicLine = '',
  dangerLine = '',
  matchupLine = '',
}) {
  return [contextLine, shiftLine, ownAdjustmentLine, strategicLine, dangerLine, matchupLine].filter(Boolean).join(' ');
}

function qbPerGame(player, key) {
  const games = Math.max(1, Number(player?.games || 0));
  return Number(player?.[key] || 0) / games;
}

function pickOwnFeature(ownStars = [], oppRanks = {}) {
  const candidates = ownStars.map((player) => {
    const pos = String(player?.position || '').toUpperCase();
    let score = playerImpact(player);
    if (pos === 'QB') {
      const td = Number(player?.passTDs || 0);
      const ints = Number(player?.passInts || 0);
      if (oppRanks.passDefRank >= 22) score += 80;
      if (ints >= Math.max(4, Math.ceil(td * 0.55))) score -= 140;
      if (td <= ints + 2) score -= 60;
    } else if (['WR', 'TE'].includes(pos) && oppRanks.passDefRank >= 20) {
      score += 90;
    } else if (['HB', 'RB', 'FB'].includes(pos) && oppRanks.rushDefRank >= 20) {
      score += 70;
    }
    return { player, score };
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.player || ownStars[0] || null;
}

function buildOwnFeatureNote(player, oppRanks = {}) {
  if (!player) return null;
  const pos = String(player.position || '').toUpperCase();
  if (pos === 'QB') {
    const td = Number(player.passTDs || 0);
    const ints = Number(player.passInts || 0);
    const rushYds = Number(player.rushYds || 0);
    if (oppRanks.passDefRank >= 22) {
      if (ints >= Math.max(4, Math.ceil(td * 0.55))) {
        return `${player.name}: ${td} TD, ${ints} INT; the pass matchup is there, but it has to be cleaner.`;
      }
      return `${player.name}: ${td} TD, ${ints} INT; their pass defense is there to attack.`;
    }
    if (rushYds >= 180) {
      return `${player.name}: ${td} TD, ${ints} INT, ${rushYds} rush yds; his legs can change the script.`;
    }
    return `${player.name}: ${td} TD, ${ints} INT; keep the game on his cleaner throws.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${player.name}: ${Number(player.recYds || 0)} rec yds, ${Number(player.recTDs || 0)} TD; best coverage matchup on your side.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${player.name}: ${Number(player.rushYds || 0)} rush yds, ${Number(player.rushTDs || 0)} TD; best path to steadier early downs.`;
  }
  return `${player.name}: one of your best matchup drivers this week.`;
}

function buildOppThreatNote(player) {
  if (!player) return null;
  const pos = String(player.position || '').toUpperCase();
  if (pos === 'QB') {
    const td = Number(player.passTDs || 0);
    const ints = Number(player.passInts || 0);
    const rushYds = Number(player.rushYds || 0);
    if (rushYds >= 150 && ints >= 6) {
      return `${player.name}: ${td} TD, ${ints} INT, ${rushYds} rush yds; explosive, but there are mistake throws there.`;
    }
    if (rushYds >= 150) {
      return `${player.name}: ${td} TD, ${rushYds} rush yds; contain him twice, not once.`;
    }
    return `${player.name}: ${td} TD, ${ints} INT; disrupt his rhythm early.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${player.name}: ${Number(player.recYds || 0)} rec yds, ${Number(player.recTDs || 0)} TD; do not let him tilt the coverage.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${player.name}: ${Number(player.rushYds || 0)} rush yds, ${Number(player.rushTDs || 0)} TD; if he stays efficient, they stay on schedule.`;
  }
  return `${player.name}: one of the pieces most likely to swing the matchup.`;
}

function pickInjuryExploit(players = []) {
  return players.find((player) => {
    const pos = String(player.position || '').toUpperCase();
    const weeks = Number(player.injuryLength || 0);
    const ovr = Number(player.playerBestOvr || player.teamSchemeOvr || 0);
    if (['CB', 'SS', 'FS'].includes(pos)) return weeks >= 3 && ovr >= 80;
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) return weeks >= 3 && ovr >= 78;
    if (pos === 'QB') return weeks >= 2;
    return false;
  });
}

function buildStressNote(stress) {
  if (!stress) return null;
  const pos = String(stress.position || '').toUpperCase();
  if (pos === 'QB') {
    return `${stress.name}: ${Number(stress.passInts || 0)} INT; pressure him into the extra mistake.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${stress.name}: ${Number(stress.recYds || 0)} rec yds; make that target win a harder game.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${stress.name}: ${Number(stress.rushYds || 0)} rush yds; win there and their offense loses shape.`;
  }
  return `${stress.name}: softer spot if you can isolate it.`;
}

function playerName(player) {
  return formatPlayerName(player);
}

function sortByOvr(players = []) {
  return [...players].sort((a, b) => Number(b?.playerBestOvr || b?.teamSchemeOvr || b?.overall || 0) - Number(a?.playerBestOvr || a?.teamSchemeOvr || a?.overall || 0));
}

function buildOlRoomSignal(roster = [], teamStats = {}) {
  const line = roster.filter((p) => ['LT', 'RT', 'LG', 'RG', 'C'].includes(String(p?.position || '').toUpperCase()));
  if (!line.length) return { weakCount: 0, avgPassBlock: 0, floorPassBlock: 0, sacksAllowedPerGame: 0, vulnerability: 0 };
  const blocks = line.map((p) => Number(p?.passBlockRating || 0)).filter((v) => Number.isFinite(v));
  const avgPassBlock = blocks.length ? blocks.reduce((sum, v) => sum + v, 0) / blocks.length : 0;
  const floorPassBlock = blocks.length ? Math.min(...blocks) : 0;
  const weakCount = blocks.filter((v) => v <= 74).length;
  const games = Math.max(1, Number(teamStats?.games || 0));
  const sacksAllowedPerGame = average(teamStats?.pass?.sacksTaken, games);
  const vulnerability =
    Math.max(0, 76 - avgPassBlock) * 1.4 +
    Math.max(0, 72 - floorPassBlock) * 1.8 +
    weakCount * 5 +
    Math.max(0, sacksAllowedPerGame - 1.8) * 12;
  return { weakCount, avgPassBlock, floorPassBlock, sacksAllowedPerGame, vulnerability };
}

function bestCoverageAttribute(defender) {
  const man = Number(defender?.manCoverRating || 0);
  const zone = Number(defender?.zoneCoverRating || 0);
  return zone > man
    ? { label: 'Zone Coverage', value: zone }
    : { label: 'Man Coverage', value: man };
}

function bestRouteAttribute(player) {
  const short = Number(player?.routeRunShortRating || 0);
  const medium = Number(player?.routeRunMediumRating || 0);
  const deep = Number(player?.routeRunDeepRating || 0);
  if (deep >= medium && deep >= short) return { label: 'Deep Route Running', value: deep };
  if (medium >= short) return { label: 'Medium Route Running', value: medium };
  return { label: 'Short Route Running', value: short };
}

function bestRushMoveAttribute(player) {
  const finesse = Number(player?.finesseMovesRating || 0);
  const power = Number(player?.powerMovesRating || 0);
  return finesse >= power
    ? { label: 'Finesse Moves', value: finesse }
    : { label: 'Power Moves', value: power };
}

function findBestMismatch(ownRoster = [], oppRoster = [], ownStats = {}, oppStats = {}) {
  const ownWide = sortByOvr(ownRoster.filter((p) => ['WR', 'TE'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => Number(p?.speedRating || 0) >= 88 || Number(p?.routeRunDeepRating || 0) >= 85 || Number(p?.routeRunShortRating || 0) >= 85)
    .slice(0, 3);
  const oppCorners = sortByOvr(oppRoster.filter((p) => ['CB', 'FS', 'SS'].includes(String(p?.position || '').toUpperCase())))
    .sort((a, b) => {
      const aCover = Math.min(Number(a?.manCoverRating || 0), Number(a?.zoneCoverRating || 0));
      const bCover = Math.min(Number(b?.manCoverRating || 0), Number(b?.zoneCoverRating || 0));
      return aCover - bCover || Number(a?.speedRating || 0) - Number(b?.speedRating || 0);
    })
    .slice(0, 4);
  let best = null;
  for (const target of ownWide) {
    for (const defender of oppCorners) {
      const score =
        Math.max(0, Number(target?.speedRating || 0) - Number(defender?.speedRating || 0)) * 4 +
        Math.max(0, Number(target?.routeRunDeepRating || target?.routeRunShortRating || 0) - Math.max(Number(defender?.manCoverRating || 0), Number(defender?.zoneCoverRating || 0))) * 2 +
        Math.max(0, 78 - Math.max(Number(defender?.manCoverRating || 0), Number(defender?.zoneCoverRating || 0))) * 2;
      if (!best || score > best.score) {
        best = { type: 'coverage', score, target, defender };
      }
    }
  }

  const ownRushers = sortByOvr(ownRoster.filter((p) => ['LE', 'RE', 'DT', 'ROLB', 'LOLB'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => Math.max(Number(p?.finesseMovesRating || 0), Number(p?.powerMovesRating || 0)) >= 72)
    .slice(0, 4);
  const oppProtectors = sortByOvr(oppRoster.filter((p) => ['LT', 'RT', 'LG', 'RG', 'C'].includes(String(p?.position || '').toUpperCase())))
    .sort((a, b) => Number(a?.passBlockRating || 0) - Number(b?.passBlockRating || 0))
    .slice(0, 4);
  const oppOlSignal = buildOlRoomSignal(oppRoster, oppStats);
  for (const rusher of ownRushers) {
    for (const blocker of oppProtectors) {
      const baseScore =
        Math.max(0, Math.max(Number(rusher?.finesseMovesRating || 0), Number(rusher?.powerMovesRating || 0)) - Number(blocker?.passBlockRating || 0)) * 3 +
        Math.max(0, 78 - Number(blocker?.passBlockRating || 0)) * 2;
      const score = baseScore + oppOlSignal.vulnerability;
      if (
        (!best || score > best.score) &&
        baseScore >= 18 &&
        oppOlSignal.vulnerability >= 14 &&
        (oppOlSignal.weakCount >= 2 || oppOlSignal.sacksAllowedPerGame >= 2.2 || Number(blocker?.passBlockRating || 0) <= 70)
      ) {
        best = { type: 'protection', score, rusher, blocker, olSignal: oppOlSignal };
      }
    }
  }

  const ownBacks = sortByOvr(ownRoster.filter((p) => ['HB', 'RB', 'FB'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => Number(p?.speedRating || 0) >= 88)
    .slice(0, 3);
  const oppFront = sortByOvr(oppRoster.filter((p) => ['MLB', 'ROLB', 'LOLB', 'SS', 'FS'].includes(String(p?.position || '').toUpperCase())))
    .sort((a, b) => (Number(a?.tackleRating || 0) + Number(a?.pursuitRating || 0)) - (Number(b?.tackleRating || 0) + Number(b?.pursuitRating || 0)))
    .slice(0, 4);
  for (const back of ownBacks) {
    for (const defender of oppFront) {
      const score =
        Math.max(0, Number(back?.speedRating || 0) - Number(defender?.speedRating || 0)) * 3 +
        Math.max(0, 150 - (Number(defender?.tackleRating || 0) + Number(defender?.pursuitRating || 0)));
      if ((!best || score > best.score) && score >= 20) {
        best = { type: 'run', score, back, defender };
      }
    }
  }

  return best;
}

function buildMismatchNote(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const { target, defender } = mismatch;
    const targetSpeed = Number(target?.speedRating || 0);
    const targetAgility = Number(target?.agilityRating || 0);
    const routeAttr = bestRouteAttribute(target);
    const coverageAttr = bestCoverageAttribute(defender);
    const defenderSpeed = Number(defender?.speedRating || 0);
    const press = Number(defender?.pressRating || 0);
    return `${playerName(target)} vs ${playerName(defender)}: lean on Speed ${targetSpeed}, Agility ${targetAgility}, and ${routeAttr.label} ${routeAttr.value} against ${coverageAttr.label} ${coverageAttr.value} and Press ${press}. If you have the speed edge, test him vertically; if not, make the route-running and change of direction do the work.`;
  }
  if (mismatch.type === 'protection') {
    const { rusher, blocker, olSignal } = mismatch;
    const rushMove = bestRushMoveAttribute(rusher);
    const passBlock = Number(blocker?.passBlockRating || 0);
    const passBlockPower = Number(blocker?.passBlockPowerRating || 0);
    const passBlockFinesse = Number(blocker?.passBlockFinesseRating || 0);
    const strength = Number(rusher?.strengthRating || 0);
    const roomTag = olSignal?.sacksAllowedPerGame >= 2.4
      ? `they are already giving up ${olSignal.sacksAllowedPerGame.toFixed(1)} sacks per game`
      : `their line is sitting around ${Math.round(Number(olSignal?.avgPassBlock || 0))} Pass Block on average`;
    return `${playerName(rusher)} vs ${playerName(blocker)}: attack with ${rushMove.label} ${rushMove.value}, Strength ${strength}, and overall rush pressure into Pass Block ${passBlock}, Pass Block Power ${passBlockPower}, and Pass Block Finesse ${passBlockFinesse}. ${roomTag}.`;
  }
  if (mismatch.type === 'run') {
    const { back, defender } = mismatch;
    const speed = Number(back?.speedRating || 0);
    const agility = Number(back?.agilityRating || 0);
    const accel = Number(back?.accelerationRating || 0);
    const tackle = Number(defender?.tackleRating || 0);
    const pursuit = Number(defender?.pursuitRating || 0);
    return `${playerName(back)} vs ${playerName(defender)}: use Speed ${speed}, Acceleration ${accel}, and Agility ${agility} against Tackle ${tackle} and Pursuit ${pursuit}. If the first defender misses or takes a bad angle, that run can turn loose fast.`;
  }
  return null;
}

function buildMatchupLeanSentence(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const { target, defender } = mismatch;
    const targetSpeed = Number(target?.speedRating || 0);
    const targetAgility = Number(target?.agilityRating || 0);
    const defenderSpeed = Number(defender?.speedRating || 0);
    const routeAttr = bestRouteAttribute(target);
    const coverageAttr = bestCoverageAttribute(defender);
    return `The best matchup leans to ${playerName(target)} against ${playerName(defender)}. The clearest edge is Speed ${targetSpeed} and ${routeAttr.label} ${routeAttr.value} against ${coverageAttr.label} ${coverageAttr.value}; Agility ${targetAgility} matters more if the speed gap on ${defenderSpeed} is not clean enough to just run by him.`;
  }
  if (mismatch.type === 'protection') {
    const { rusher, blocker, olSignal } = mismatch;
    const rushMove = bestRushMoveAttribute(rusher);
    const passBlock = Number(blocker?.passBlockRating || 0);
    const passBlockPower = Number(blocker?.passBlockPowerRating || 0);
    const passBlockFinesse = Number(blocker?.passBlockFinesseRating || 0);
    return `The best matchup leans to ${playerName(rusher)} on ${playerName(blocker)}. The key is ${rushMove.label} ${rushMove.value} attacking Pass Block ${passBlock}, Pass Block Power ${passBlockPower}, and Pass Block Finesse ${passBlockFinesse}, and the full line is already allowing ${Number(olSignal?.sacksAllowedPerGame || 0).toFixed(1)} sacks per game.`;
  }
  if (mismatch.type === 'run') {
    const { back, defender } = mismatch;
    const speed = Number(back?.speedRating || 0);
    const accel = Number(back?.accelerationRating || 0);
    const agility = Number(back?.agilityRating || 0);
    const tackle = Number(defender?.tackleRating || 0);
    const pursuit = Number(defender?.pursuitRating || 0);
    return `The best matchup leans to ${playerName(back)} in space against ${playerName(defender)}. Speed ${speed}, Acceleration ${accel}, and Agility ${agility} are going at Tackle ${tackle} and Pursuit ${pursuit}, so one missed fit can turn into a real explosive.`;
  }
  return null;
}

function buildKeyNotes({ ownStars = [], oppStars = [], keyOppStress = [], ownTeamName = '', opponentTeamName = '', oppInjuryPlayers = [], oppRanks = {}, oppStats = {}, ownRoster = [], oppRoster = [] }) {
  const notes = [];
  const own = pickOwnFeature(ownStars, oppRanks);
  const opp = oppStars[0];
  const stress = keyOppStress[0];
  const mismatchNote = buildMismatchNote(findBestMismatch(ownRoster, oppRoster, {}, oppStats));
  const weaknessNote = buildDefenseWeaknessNote(oppRoster, oppInjuryPlayers, oppStats);

  const ownNote = buildOwnFeatureNote(own, oppRanks);
  if (ownNote) notes.push(ownNote);

  const oppNote = buildOppThreatNote(opp);
  if (oppNote && notes.length < 2) notes.push(oppNote);

  const injuryExploit = pickInjuryExploit(oppInjuryPlayers);
  if (injuryExploit) {
    const pos = String(injuryExploit.position || '').toUpperCase();
    const weeks = Number(injuryExploit.injuryLength || 0);
    if (['CB', 'SS', 'FS'].includes(pos)) {
      notes.push(`${formatPlayerName(injuryExploit)} out ${weeks} weeks: test their secondary depth.`);
    } else if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) {
      notes.push(`${formatPlayerName(injuryExploit)} out ${weeks} weeks: their protection should be easier to stress.`);
    } else if (pos === 'QB') {
      notes.push(`${formatPlayerName(injuryExploit)} out ${weeks} weeks: the whole offense changes.`);
    } else {
      notes.push(`${formatPlayerName(injuryExploit)} out ${weeks} weeks: real depth strain for them.`);
    }
  } else if (stress && (!opp || normalizeName(formatPlayerName(stress)) !== normalizeName(formatPlayerName(opp)))) {
    const stressNote = buildStressNote(stress);
    if (stressNote) notes.push(stressNote);
  }

  if (mismatchNote && !notes.some((note) => note === mismatchNote)) {
    notes.splice(Math.min(1, notes.length), 0, mismatchNote);
  }

  if (weaknessNote && notes.length < 4 && !notes.some((note) => note === weaknessNote)) {
    notes.push(weaknessNote);
  }

  const deduped = [];
  for (const note of notes) {
    if (!note) continue;
    if (deduped.some((existing) => normalizeName(existing) === normalizeName(note))) continue;
    deduped.push(note);
  }

  return deduped.slice(0, 3).join('\n');
}

function buildDefenseWeaknessNote(oppRoster = [], oppInjuryPlayers = [], oppStats = {}) {
  const injury = findImpactInjury(oppInjuryPlayers, []);
  if (injury) {
    const pos = String(injury.pos || '').toUpperCase();
    const name = formatPlayerName(injury.player);
    if (['CB', 'FS', 'SS'].includes(pos)) return `${name} out: attack the secondary depth.`;
    if (['LE', 'RE', 'DT', 'ROLB', 'LOLB', 'MLB'].includes(pos)) return `${name} out: their front is lighter this week.`;
  }

  const corners = sortByOvr(oppRoster.filter((p) => ['CB', 'FS', 'SS'].includes(String(p?.position || '').toUpperCase())));
  const weakestCover = [...corners].sort((a, b) => Math.max(Number(a?.manCoverRating || 0), Number(a?.zoneCoverRating || 0)) - Math.max(Number(b?.manCoverRating || 0), Number(b?.zoneCoverRating || 0)))[0];
  if (weakestCover && Math.max(Number(weakestCover?.manCoverRating || 0), Number(weakestCover?.zoneCoverRating || 0)) <= 74) {
    return `${playerName(weakestCover)}: coverage ${Math.max(Number(weakestCover?.manCoverRating || 0), Number(weakestCover?.zoneCoverRating || 0))}; best spot to test outside.`;
  }

  const frontSeven = oppRoster.filter((p) => ['MLB', 'ROLB', 'LOLB', 'LE', 'RE', 'DT'].includes(String(p?.position || '').toUpperCase()));
  const weakTackler = [...frontSeven].sort((a, b) => (Number(a?.tackleRating || 0) + Number(a?.pursuitRating || 0)) - (Number(b?.tackleRating || 0) + Number(b?.pursuitRating || 0)))[0];
  if (weakTackler && (Number(weakTackler?.tackleRating || 0) + Number(weakTackler?.pursuitRating || 0)) <= 145) {
    return `${playerName(weakTackler)}: tackle/pursuit ${Number(weakTackler?.tackleRating || 0)}/${Number(weakTackler?.pursuitRating || 0)}; make him finish in space.`;
  }

  const olSignal = buildOlRoomSignal(oppRoster, oppStats);
  if (olSignal.vulnerability >= 18 && (olSignal.weakCount >= 2 || olSignal.sacksAllowedPerGame >= 2.4)) {
    return `Their line is giving up ${olSignal.sacksAllowedPerGame.toFixed(1)} sacks/g; pressure is still worth leaning into.`;
  }

  return null;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) throw new Error('No Madden league is configured for this server.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const ownTeam = findCoachTeam(interaction.member, snapshot);
    if (!ownTeam) throw new Error('Could not determine your team from your coach role.');

    const matchup = findWeeklyOpponent(snapshot, ownTeam.teamId);
    if (!matchup) throw new Error('No scheduled matchup was found for your team this week.');

    const teams = teamMap(snapshot);
    const isHome = Number(matchup.homeTeamId) === ownTeam.teamId;
    const opponentTeamId = Number(isHome ? matchup.awayTeamId : matchup.homeTeamId);
    const ownTeamName = teams.get(ownTeam.teamId) || ownTeam.fullName;
    const opponentTeamName = teams.get(opponentTeamId) || `Team ${opponentTeamId}`;
    const live = buildLiveDraftContext(snapshot);
    const ownStats = live.teamStatsByTeamId?.[ownTeam.teamId];
    const oppStats = live.teamStatsByTeamId?.[opponentTeamId];
    const ownStanding = (snapshot?.standings?.teamStandingInfoList || []).find((team) => Number(team.teamId) === ownTeam.teamId);
    const oppStanding = (snapshot?.standings?.teamStandingInfoList || []).find((team) => Number(team.teamId) === opponentTeamId);
    const ownRanks = teamRankBundle(live, ownTeam.teamId);
    const oppRanks = teamRankBundle(live, opponentTeamId);
    const oppPlayers = live.currentPlayersByTeamId?.[opponentTeamId] || [];
    const ownRoster = teamRosterPlayers(snapshot, ownTeam.teamId);
    const oppRoster = teamRosterPlayers(snapshot, opponentTeamId);
    const ownInjuries = teamInjuries(snapshot, ownTeam.teamId, 2);
    const oppInjuries = teamInjuries(snapshot, opponentTeamId, 2);
    const ownInjuryPlayers = teamInjuryPlayers(snapshot, ownTeam.teamId, 2);
    const oppInjuryPlayers = teamInjuryPlayers(snapshot, opponentTeamId, 2);
    const { weekType, displayWeek } = currentWeekInfo(snapshot);
    const phaseLabel = weekType === 2 ? 'Postseason' : `Week ${displayWeek}`;

    const contextLine = conferenceRaceLine(snapshot, ownStanding, ownTeamName);
    const shiftLine = buildOpponentShiftLine(opponentTeamName, oppStats, oppRanks, oppInjuryPlayers, oppPlayers);
    const approachLines = buildApproachLines(ownStats, oppStats, ownRanks, oppRanks);
    const dangerLines = buildDangerLines(ownStats, oppStats, ownRanks, oppRanks);
    const bestMismatch = findBestMismatch(ownRoster, oppRoster, {}, oppStats);
    const ownAdjustmentLine = buildOwnInjuryAdjustmentLine(ownInjuryPlayers, ownRoster);
    const strategicLine = buildStrategicLeanSentence(ownStats, oppStats, ownRanks, oppRanks);
    const dangerLine = dangerLines[0] || '';
    const matchupLine = buildMatchupLeanSentence(bestMismatch) || '';
    const quickRead = buildQuickRead({
      contextLine,
      shiftLine,
      ownAdjustmentLine,
      strategicLine,
      dangerLine,
      matchupLine,
    });
    const injuryBlock = [
      ownInjuries[0] ? `${ownTeamName}: ${ownInjuries[0]}` : null,
      oppInjuries[0] ? `${opponentTeamName}: ${oppInjuries[0]}` : null,
    ].filter(Boolean).join('\n') || 'No major injuries in the current export.';

    const embed = new EmbedBuilder()
      .setColor(0x2b6cb0)
      .setTitle(`Madden Game Strategy — ${ownTeamName} vs ${opponentTeamName}`)
      .setDescription(`${phaseLabel} scouting report.`)
      .addFields(
        {
          name: 'Records',
          value: `${ownTeamName}: ${recordLabel(ownStanding)}\n${opponentTeamName}: ${recordLabel(oppStanding)}`,
          inline: false,
        },
        { name: 'Quick Read', value: quickRead || 'Play your cleaner game, protect the ball, and make them earn long drives.', inline: false },
        {
          name: 'Injury Watch',
          value: injuryBlock,
          inline: false,
        },
      )
      .setFooter({ text: 'Built from live weekly stats, roster state, injuries, standings, and matchup data.' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ content: `Failed to build weekly strategy: ${error.message}` });
  }
}

export default { data, execute };
