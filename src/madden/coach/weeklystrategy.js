import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { buildLiveDraftContext } from './draft_live_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadRoleMap } from '../staff/staffUtils.js';
import { getRecognitionPerkState, inferRecognitionContext } from '../../shared/league_recognition.js';
import { coachCommandDescription, coachVoiceFooter } from '../../shared/madden_coach_voice.js';
import {
  pickOffenseLearningResource,
  pickDefenseLearningResource,
  pickTendencyLearningResource,
  buildLearningBridge,
  buildLearningStruggleNote,
  formatLearningResource,
} from '../../shared/madden_learning_resources.js';

const data = new SlashCommandBuilder()
  .setName('madden-gamestrategy')
  .setDescription(coachCommandDescription('gamestrategy'));

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function truncate(text = '', max = 1000) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function truncateSentence(text = '', max = 1000) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  if (lastStop >= Math.floor(max * 0.65)) return `${clipped.slice(0, lastStop + 1).trim()}`;
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= Math.floor(max * 0.8)) return `${clipped.slice(0, lastSpace).trim()}…`;
  return `${clipped.slice(0, max - 1).trim()}…`;
}

function buildPremiumFieldValue(baseText = '', bridgeText = '', max = 1000, mode = 'sentence') {
  const base = String(baseText || '').trim();
  const bridge = String(bridgeText || '').trim();
  const applyClip = (text, limit) => (mode === 'sentence' ? truncateSentence(text, limit) : truncate(text, limit));
  if (!bridge) return applyClip(base, max);
  const combined = mode === 'sentence' ? `${base} ${bridge}` : `${base}\n${bridge}`;
  if (combined.length <= max) return combined;

  const targetBase = Math.max(Math.floor(max * 0.62), max - Math.min(220, bridge.length + 2));
  const clippedBase = applyClip(base, targetBase);
  const separator = mode === 'sentence' ? ' ' : '\n';
  const remaining = max - clippedBase.length - separator.length;
  if (remaining < 48) return clippedBase;
  const clippedBridge = truncateSentence(bridge, remaining);
  return `${clippedBase}${separator}${clippedBridge}`;
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

function relativeTendencyLabel(stats = {}, leagueProfile = null) {
  const passAtt = Number(stats?.pass?.att || 0);
  const rushAtt = Number(stats?.rush?.att || 0);
  const total = Math.max(1, passAtt + rushAtt);
  const passRate = passAtt / total;
  if (leagueProfile?.passRate) {
    const bucket = statBucket(passRate, leagueProfile.passRate);
    if (bucket === 'high') return 'pass-heavy';
    if (bucket === 'low') return 'run-heavy';
    return 'balanced';
  }
  return tendencyLabel(stats);
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

function quantile(values = [], q = 0.5) {
  const sorted = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] + ((sorted[high] - sorted[low]) * weight);
}

function averageList(values = []) {
  const filtered = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value));
  if (!filtered.length) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function buildLeagueProfile(live = {}) {
  const entries = Object.values(live?.teamStatsByTeamId || {});
  const passOff = entries.map((stats) => average(stats?.pass?.yds, stats?.games));
  const rushOff = entries.map((stats) => average(stats?.rush?.yds, stats?.games));
  const passDef = entries.map((stats) => average(stats?.def?.passYdsAllowed, stats?.games));
  const rushDef = entries.map((stats) => average(stats?.def?.rushYdsAllowed, stats?.games));
  const sacksFor = entries.map((stats) => average(stats?.def?.sacks, stats?.games));
  const sacksAllowed = entries.map((stats) => average(stats?.pass?.sacksTaken, stats?.games));
  const passRate = entries.map((stats) => {
    const passAtt = Number(stats?.pass?.att || 0);
    const rushAtt = Number(stats?.rush?.att || 0);
    const total = Math.max(1, passAtt + rushAtt);
    return passAtt / total;
  });

  const pack = (values) => ({
    avg: averageList(values),
    low: quantile(values, 0.25),
    high: quantile(values, 0.75),
  });

  return {
    passOff: pack(passOff),
    rushOff: pack(rushOff),
    passDef: pack(passDef),
    rushDef: pack(rushDef),
    sacksFor: pack(sacksFor),
    sacksAllowed: pack(sacksAllowed),
    passRate: pack(passRate),
  };
}

function statBucket(value, scope = {}, invert = false) {
  const numeric = Number(value || 0);
  const low = Number(scope?.low || 0);
  const high = Number(scope?.high || 0);
  if (!invert) {
    if (numeric >= high) return 'high';
    if (numeric <= low) return 'low';
    return 'mid';
  }
  if (numeric <= low) return 'high';
  if (numeric >= high) return 'low';
  return 'mid';
}

function relativeStatPhrase(value, scope = {}, label = '') {
  const bucket = statBucket(value, scope);
  if (bucket === 'high') return `one of the higher-end ${label} marks in this league`;
  if (bucket === 'low') return `one of the lower-end ${label} marks in this league`;
  return `closer to the league middle in ${label}`;
}

function relativePassRatePhrase(stats = {}, leagueProfile = null) {
  const passAtt = Number(stats?.pass?.att || 0);
  const rushAtt = Number(stats?.rush?.att || 0);
  const total = Math.max(1, passAtt + rushAtt);
  const passRate = passAtt / total;
  const bucket = statBucket(passRate, leagueProfile?.passRate);
  if (bucket === 'high') return 'one of the more pass-forward profiles in this league';
  if (bucket === 'low') return 'one of the more run-leaning profiles in this league';
  return 'a more balanced profile by this league\'s standards';
}

function passRateValue(stats = {}) {
  const passAtt = Number(stats?.pass?.att || 0);
  const rushAtt = Number(stats?.rush?.att || 0);
  const total = Math.max(1, passAtt + rushAtt);
  return passAtt / total;
}

function bucketTag(bucket = 'mid', labels = {}) {
  if (bucket === 'high') return labels.high || 'high';
  if (bucket === 'low') return labels.low || 'low';
  return labels.mid || 'mid';
}

function percentileStyleTag(value, scope = {}, invert = false, labels = {}) {
  return bucketTag(statBucket(value, scope, invert), labels);
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
  ownTeamName = '',
  opponentTeamName = '',
  oppStats = {},
  oppRanks = {},
  offensiveMismatch = null,
  defensiveMismatch = null,
  leagueProfile = null,
}) {
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const oppPassYpg = average(oppStats?.pass?.yds, oppGames);
  const oppRushYpg = average(oppStats?.rush?.yds, oppGames);
  const lines = [
    `${opponentTeamName} profile as a ${relativeTendencyLabel(oppStats, leagueProfile)} group at ${oppPassYpg.toFixed(1)} pass ypg and ${oppRushYpg.toFixed(1)} rush ypg.`,
  ];
  if (defensiveMismatch?.type === 'protection') {
    lines.push(`The cleanest edge is your rush on ${playerName(defensiveMismatch.blocker)}; make their protection prove it can hold up without extra help.`);
  } else if (offensiveMismatch?.type === 'coverage') {
    lines.push(`Your best on-ball edge is speed outside with ${playerName(offensiveMismatch.target)} on ${playerName(offensiveMismatch.defender)}.`);
  } else if (offensiveMismatch?.type === 'run') {
    lines.push(`The cleanest offensive lane is getting ${playerName(offensiveMismatch.back)} and his speed on ${playerName(offensiveMismatch.defender)} in space.`);
  }
  if (oppRanks.passOffRank <= 8) {
    lines.push(`${ownTeamName} cannot hand them explosives through the air this week.`);
  } else if (oppRanks.rushOffRank <= 8) {
    lines.push(`${ownTeamName} need to win early downs so the run game does not script the whole afternoon.`);
  } else {
    lines.push(`Stay on schedule and make them string drives together instead of living on short fields.`);
  }
  return lines.slice(0, 3).join(' ');
}

function formatDevLabel(player) {
  const tier = playerDevTier(player);
  if (tier >= 3) return 'X-Factor';
  if (tier >= 2) return 'Superstar';
  if (tier >= 1) return 'Star';
  return 'Normal';
}

function formatRankBucket(rank) {
  if (!rank) return null;
  if (rank <= 5) return `top-${rank}`;
  if (rank >= 28) return `bottom-${33 - rank}`;
  if (rank <= 10) return `top-10`;
  if (rank >= 23) return `bottom-10`;
  return null;
}

function joinSentences(lines = [], limit = 7) {
  return lines.filter(Boolean).slice(0, limit).join(' ');
}

function speedEdge(player, defender) {
  return Math.max(0, speedRating(player) - speedRating(defender));
}

function speedRating(player = {}) {
  return Number(player?.speedRating ?? player?.spdRating ?? 0);
}

function accelRating(player = {}) {
  return Number(player?.accelerationRating ?? player?.accelRating ?? 0);
}

function agilityRating(player = {}) {
  return Number(player?.agilityRating ?? player?.agiRating ?? 0);
}

function completionPct(player = {}) {
  const comp = Number(player?.passComp || player?.completions || 0);
  const att = Number(player?.passAtt || player?.attempts || 0);
  return att > 0 ? (comp / att) * 100 : 0;
}

function playerStat(player = {}, ...keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((current, part) => (current == null ? undefined : current[part]), player);
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric !== 0) return numeric;
  }
  return 0;
}

function teamReceiverShare(players = [], teamPassYards = 0) {
  const passYards = Math.max(1, Number(teamPassYards || 0));
  const receivers = players
    .filter((player) => ['WR', 'TE', 'HB', 'RB', 'FB'].includes(String(player?.position || '').toUpperCase()))
    .map((player) => ({
      player,
      recYds: playerStat(player, 'recYds', 'rec.yds', 'totals.recYds'),
      catches: playerStat(player, 'recCatches', 'rec.catches', 'totals.recCatches'),
    }))
    .filter((entry) => entry.recYds > 0 || entry.catches > 0)
    .sort((a, b) => b.recYds - a.recYds || b.catches - a.catches);
  const top = receivers[0] || null;
  if (!top) return null;
  return {
    player: top.player,
    airShare: (top.recYds / passYards) * 100,
    catches: top.catches,
    recYds: top.recYds,
    ypc: top.catches > 0 ? top.recYds / top.catches : 0,
  };
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

function findCoverageMismatch(ownRoster = [], oppRoster = []) {
  const ownWide = sortByOvr(ownRoster.filter((p) => ['WR', 'TE'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => speedRating(p) >= 89 || Number(p?.routeRunDeepRating || 0) >= 85 || Number(p?.routeRunShortRating || 0) >= 85)
    .slice(0, 3);
  const pureCorners = sortByOvr(oppRoster.filter((p) => String(p?.position || '').toUpperCase() === 'CB'));
  const secondary = sortByOvr(oppRoster.filter((p) => ['CB', 'FS', 'SS'].includes(String(p?.position || '').toUpperCase())));
  const oppCorners = (pureCorners.length >= 2 ? pureCorners : secondary)
    .sort((a, b) => {
      const aCover = Math.min(Number(a?.manCoverRating || 0), Number(a?.zoneCoverRating || 0));
      const bCover = Math.min(Number(b?.manCoverRating || 0), Number(b?.zoneCoverRating || 0));
      return speedRating(a) - speedRating(b) || aCover - bCover;
    })
    .slice(0, 4);
  let best = null;
  for (const target of ownWide) {
    for (const defender of oppCorners) {
      const speedGap = speedEdge(target, defender);
      const score =
        speedGap * 7 +
        Math.max(0, accelRating(target) - accelRating(defender)) * 2 +
        Math.max(0, agilityRating(target) - agilityRating(defender)) * 1.5 +
        Math.max(0, Number(target?.routeRunDeepRating || target?.routeRunShortRating || 0) - Math.max(Number(defender?.manCoverRating || 0), Number(defender?.zoneCoverRating || 0))) * 1.5 +
        Math.max(0, 90 - speedRating(defender)) * 2;
      if (!best || score > best.score) best = { type: 'coverage', score, target, defender };
    }
  }
  return best;
}

function findProtectionMismatch(ownRoster = [], oppRoster = [], oppStats = {}) {
  const ownRushers = sortByOvr(ownRoster.filter((p) => ['LE', 'RE', 'DT', 'ROLB', 'LOLB'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => Math.max(Number(p?.finesseMovesRating || 0), Number(p?.powerMovesRating || 0)) >= 72)
    .slice(0, 4);
  const oppProtectors = sortByOvr(oppRoster.filter((p) => ['LT', 'RT', 'LG', 'RG', 'C'].includes(String(p?.position || '').toUpperCase())))
    .sort((a, b) => Number(a?.passBlockRating || 0) - Number(b?.passBlockRating || 0))
    .slice(0, 4);
  const oppOlSignal = buildOlRoomSignal(oppRoster, oppStats);
  let best = null;
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
  return best;
}

function findRunMismatch(ownRoster = [], oppRoster = []) {
  const ownBacks = sortByOvr(ownRoster.filter((p) => ['HB', 'RB', 'FB'].includes(String(p?.position || '').toUpperCase())))
    .filter((p) => speedRating(p) >= 89)
    .slice(0, 3);
  const oppFront = sortByOvr(oppRoster.filter((p) => ['MLB', 'ROLB', 'LOLB', 'SS', 'FS'].includes(String(p?.position || '').toUpperCase())))
    .sort((a, b) => (Number(a?.tackleRating || 0) + Number(a?.pursuitRating || 0)) - (Number(b?.tackleRating || 0) + Number(b?.pursuitRating || 0)))
    .slice(0, 4);
  let best = null;
  for (const back of ownBacks) {
    for (const defender of oppFront) {
      const score =
        Math.max(0, speedRating(back) - speedRating(defender)) * 6 +
        Math.max(0, accelRating(back) - accelRating(defender)) * 2 +
        Math.max(0, agilityRating(back) - agilityRating(defender)) * 1.5 +
        Math.max(0, 150 - (Number(defender?.tackleRating || 0) + Number(defender?.pursuitRating || 0)));
      if ((!best || score > best.score) && score >= 20) {
        best = { type: 'run', score, back, defender };
      }
    }
  }
  return best;
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
      score += Math.max(0, speedRating(player) - 88) * 12;
    } else if (['HB', 'RB', 'FB'].includes(pos) && oppRanks.rushDefRank >= 20) {
      score += 70;
      score += Math.max(0, speedRating(player) - 88) * 10;
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

function playerLabel(player) {
  const name = formatPlayerName(player);
  const pos = String(player?.position || '').toUpperCase();
  return pos ? `${name} (${pos})` : name;
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

function routeValue(player, area = 'short') {
  if (area === 'deep') return Number(player?.routeRunDeepRating || 0);
  if (area === 'medium') return Number(player?.routeRunMediumRating || 0);
  return Number(player?.routeRunShortRating || 0);
}

function coverageValue(player, area = 'man') {
  if (area === 'zone') return Number(player?.zoneCoverRating || 0);
  return Number(player?.manCoverRating || 0);
}

function isSkillReceiver(player) {
  return ['WR', 'TE'].includes(String(player?.position || '').toUpperCase());
}

function isSecondaryPlayer(player) {
  return ['CB', 'FS', 'SS'].includes(String(player?.position || '').toUpperCase());
}

function receiverInsideScore(player) {
  return routeValue(player, 'short') * 1.8 +
    routeValue(player, 'medium') * 1.5 +
    accelRating(player) * 1.4 +
    agilityRating(player) * 1.2 +
    speedRating(player) * 1.1 +
    Number(player?.catchInTrafficRating || 0) * 0.8;
}

function receiverOutsideScore(player) {
  return speedRating(player) * 1.9 +
    routeValue(player, 'deep') * 1.6 +
    routeValue(player, 'medium') * 1.1 +
    accelRating(player) * 1.2 +
    Number(player?.releaseRating || 0) * 0.9 +
    Number(player?.spectacularCatchRating || 0) * 0.6;
}

function defenderSlotLiabilityScore(player) {
  return (88 - speedRating(player)) * 3.2 +
    (86 - accelRating(player)) * 2.1 +
    (78 - coverageValue(player, 'man')) * 2.2 +
    (76 - coverageValue(player, 'zone')) * 1.6 +
    (72 - Number(player?.pressRating || 0)) * 0.8;
}

function defenderOutsideLiabilityScore(player) {
  return (89 - speedRating(player)) * 3.4 +
    (80 - coverageValue(player, 'man')) * 2.4 +
    (78 - coverageValue(player, 'zone')) * 1.1 +
    (75 - Number(player?.pressRating || 0)) * 1.3;
}

function frontSevenSpaceLiabilityScore(player) {
  return (82 - speedRating(player)) * 1.8 +
    (84 - accelRating(player)) * 1.2 +
    (78 - Number(player?.tackleRating || 0)) * 2.1 +
    (76 - Number(player?.pursuitRating || 0)) * 1.8 +
    (74 - Number(player?.playRecognitionRating || 0)) * 1.1;
}

function selectBestBy(players = [], scorer) {
  let best = null;
  for (const player of players) {
    const score = Number(scorer(player) || 0);
    if (!best || score > best.score) best = { player, score };
  }
  return best;
}

function findSlotMismatch(ownRoster = [], oppRoster = []) {
  const targets = ownRoster.filter((player) => isSkillReceiver(player))
    .sort((a, b) => receiverInsideScore(b) - receiverInsideScore(a))
    .slice(0, 4);
  const defenders = oppRoster.filter((player) => isSecondaryPlayer(player))
    .sort((a, b) => defenderSlotLiabilityScore(b) - defenderSlotLiabilityScore(a))
    .slice(0, 5);
  let best = null;
  for (const target of targets) {
    for (const defender of defenders) {
      const score =
        Math.max(0, receiverInsideScore(target) - 235) +
        Math.max(0, speedRating(target) - speedRating(defender)) * 4.2 +
        Math.max(0, accelRating(target) - accelRating(defender)) * 2.4 +
        Math.max(0, routeValue(target, 'short') - coverageValue(defender, 'man')) * 2.6 +
        Math.max(0, routeValue(target, 'medium') - coverageValue(defender, 'zone')) * 1.8 +
        Math.max(0, defenderSlotLiabilityScore(defender));
      if (!best || score > best.score) best = { type: 'slot', score, target, defender };
    }
  }
  return best && best.score >= 34 ? best : null;
}

function findOutsideMismatch(ownRoster = [], oppRoster = []) {
  const targets = ownRoster.filter((player) => isSkillReceiver(player))
    .sort((a, b) => receiverOutsideScore(b) - receiverOutsideScore(a))
    .slice(0, 4);
  const corners = oppRoster.filter((player) => String(player?.position || '').toUpperCase() === 'CB')
    .sort((a, b) => defenderOutsideLiabilityScore(b) - defenderOutsideLiabilityScore(a))
    .slice(0, 4);
  let best = null;
  for (const target of targets) {
    for (const defender of corners) {
      const score =
        Math.max(0, speedRating(target) - speedRating(defender)) * 4.8 +
        Math.max(0, routeValue(target, 'deep') - coverageValue(defender, 'man')) * 2.4 +
        Math.max(0, Number(target?.releaseRating || 0) - Number(defender?.pressRating || 0)) * 1.4 +
        Math.max(0, defenderOutsideLiabilityScore(defender));
      if (!best || score > best.score) best = { type: 'outside', score, target, defender };
    }
  }
  return best && best.score >= 32 ? best : null;
}

function findBoxMismatch(ownRoster = [], oppRoster = []) {
  const backs = ownRoster.filter((player) => ['HB', 'RB', 'FB'].includes(String(player?.position || '').toUpperCase()))
    .sort((a, b) => (
      (speedRating(b) * 2.1) + (accelRating(b) * 1.4) + (agilityRating(b) * 1.1)
    ) - (
      (speedRating(a) * 2.1) + (accelRating(a) * 1.4) + (agilityRating(a) * 1.1)
    ))
    .slice(0, 3);
  const defenders = oppRoster.filter((player) => ['MLB', 'ROLB', 'LOLB', 'SS', 'FS'].includes(String(player?.position || '').toUpperCase()))
    .sort((a, b) => frontSevenSpaceLiabilityScore(b) - frontSevenSpaceLiabilityScore(a))
    .slice(0, 5);
  let best = null;
  for (const back of backs) {
    for (const defender of defenders) {
      const score =
        Math.max(0, speedRating(back) - speedRating(defender)) * 4.4 +
        Math.max(0, accelRating(back) - accelRating(defender)) * 1.8 +
        Math.max(0, agilityRating(back) - Number(defender?.changeOfDirectionRating || 0)) * 1.3 +
        Math.max(0, frontSevenSpaceLiabilityScore(defender));
      if (!best || score > best.score) best = { type: 'box', score, back, defender };
    }
  }
  return best && best.score >= 28 ? best : null;
}

function buildFieldAttackProfile(ownRoster = [], oppRoster = [], ownStats = {}, oppStats = {}) {
  const slotMismatch = findSlotMismatch(ownRoster, oppRoster);
  const outsideMismatch = findOutsideMismatch(ownRoster, oppRoster);
  const boxMismatch = findBoxMismatch(ownRoster, oppRoster);
  const coverageMismatch = findCoverageMismatch(ownRoster, oppRoster);
  const games = Math.max(1, Number(oppStats?.games || ownStats?.games || 0));
  const oppPassAllowed = average(oppStats?.def?.passYdsAllowed, games);
  const oppRushAllowed = average(oppStats?.def?.rushYdsAllowed, games);

  const candidates = [
    slotMismatch ? { area: 'slot', score: slotMismatch.score + (oppPassAllowed >= 230 ? 6 : 0), detail: slotMismatch } : null,
    outsideMismatch ? { area: 'outside', score: outsideMismatch.score + (oppPassAllowed >= 235 ? 5 : 0), detail: outsideMismatch } : null,
    boxMismatch ? { area: 'box', score: boxMismatch.score + (oppRushAllowed >= 115 ? 5 : 0), detail: boxMismatch } : null,
    coverageMismatch ? { area: 'outside', score: Number(coverageMismatch.score || 0), detail: coverageMismatch } : null,
  ].filter(Boolean).sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function findDefensiveFieldVulnerability(oppRoster = [], ownRoster = [], oppStats = {}) {
  const coverageThreat = findCoverageMismatch(oppRoster, ownRoster);
  const runThreat = findRunMismatch(oppRoster, ownRoster);
  const slotThreat = findSlotMismatch(oppRoster, ownRoster);
  const games = Math.max(1, Number(oppStats?.games || 0));
  const oppPassYpg = average(oppStats?.pass?.yds, games);
  const oppRushYpg = average(oppStats?.rush?.yds, games);

  const candidates = [
    slotThreat ? { area: 'slot', score: slotThreat.score + (oppPassYpg >= 225 ? 6 : 0), detail: slotThreat } : null,
    coverageThreat ? { area: 'outside', score: Number(coverageThreat.score || 0) + (oppPassYpg >= 230 ? 4 : 0), detail: coverageThreat } : null,
    runThreat ? { area: 'box', score: Number(runThreat.score || 0) + (oppRushYpg >= 110 ? 4 : 0), detail: runThreat } : null,
  ].filter(Boolean).sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function buildTeamProfileSummary(ownRoster = [], oppRoster = [], ownStats = {}, oppStats = {}) {
  const offenseField = buildFieldAttackProfile(ownRoster, oppRoster, ownStats, oppStats);
  const defenseField = findDefensiveFieldVulnerability(oppRoster, ownRoster, oppStats);
  return { offenseField, defenseField };
}

function buildOffensiveFieldAttackLine(profile = null, oppStats = {}) {
  if (!profile?.detail) return null;
  const seed = hashSeed(profile?.area, profile?.detail?.target?.name, profile?.detail?.defender?.name, profile?.detail?.back?.name);
  if (profile.area === 'slot') {
    const oppGames = Math.max(1, Number(oppStats?.games || 0));
    const passAllowed = average(oppStats?.def?.passYdsAllowed, oppGames);
    return passAllowed >= 230
      ? pickVariant(seed, [
        `The field attack point is inside. Work ${playerLabel(profile.detail.target)} on ${playerLabel(profile.detail.defender)} through slot fades, option routes, seams, and glance windows until they prove they can carry the slot without tilting safety help there.`,
        `Start by stressing the hashes and inside seams. ${playerLabel(profile.detail.target)} on ${playerLabel(profile.detail.defender)} should be a live slot-fade, seam, and glance problem until they roll real help inside.`,
      ])
      : pickVariant(seed, [
        `The field attack point is the slot underneath the safeties. Put ${playerLabel(profile.detail.target)} on ${playerLabel(profile.detail.defender)} with choice, whip, pivot, and spacing concepts so the nickel has to handle two-way breaks all day.`,
        `The best access point is the slot under the roof of the coverage. Put ${playerLabel(profile.detail.target)} on ${playerLabel(profile.detail.defender)} with option, pivot, and spacing routes so that inside defender has to win with leverage all game.`,
      ]);
  }
  if (profile.area === 'outside') {
    const target = profile.detail.target || profile.detail.back;
    const defender = profile.detail.defender;
    if (!target || !defender) return null;
    return pickVariant(seed, [
      `The field attack point is outside. Keep testing ${playerLabel(target)} on ${playerLabel(defender)} with go balls, deep overs, comebacks, and flood spacing until that corner stops giving up leverage or they start rolling help over the top.`,
      `Attack the numbers first. ${playerLabel(target)} on ${playerLabel(defender)} should be a go, comeback, and deep-over problem until the coverage starts leaning outside to stop it.`,
    ]);
  }
  if (profile.area === 'box') {
    return pickVariant(seed, [
      `The field attack point is the alley and second level. Get ${playerLabel(profile.detail.back)} on ${playerLabel(profile.detail.defender)} with stretch, toss, angle, and Texas looks so their slower fit player has to tackle in space instead of fitting downhill cleanly.`,
      `The cleanest grass is in the alley. Force ${playerLabel(profile.detail.back)} onto ${playerLabel(profile.detail.defender)} with wide runs and backfield option routes so that fit player has to win in space instead of downhill.`,
    ]);
  }
  return null;
}

function buildDefensiveFieldLine(profile = null) {
  if (!profile?.detail) return null;
  if (profile.area === 'slot') {
    return `Protect the slot first. Their best inside stress is ${playerLabel(profile.detail.target)} on ${playerLabel(profile.detail.defender)}, so do not let your nickel, safety, or hook help get isolated there without a plan.`;
  }
  if (profile.area === 'outside') {
    const target = profile.detail.target;
    const defender = profile.detail.defender;
    if (!target || !defender) return null;
    return `Protect the numbers and sideline first. ${playerLabel(target)} is the outside stress point on ${playerLabel(defender)}, so keep the corner leveraged and make any vertical throw earn safety help over the top.`;
  }
  if (profile.area === 'box') {
    return `Protect the box fit and alley first. ${playerLabel(profile.detail.back)} is trying to get to ${playerLabel(profile.detail.defender)} in space, so the front and safety fits have to close that lane before it becomes the explosive.`;
  }
  return null;
}

function offensiveProfileTag(fieldProfile = null, oppStats = {}, oppRanks = {}, leagueProfile = null) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const passAllowed = average(oppStats?.def?.passYdsAllowed, games);
  const rushAllowed = average(oppStats?.def?.rushYdsAllowed, games);
  if (fieldProfile?.area === 'slot') return 'slot';
  if (fieldProfile?.area === 'outside') return 'outside';
  if (fieldProfile?.area === 'box') return 'box';
  if (oppRanks.passDefRank >= 22 || statBucket(passAllowed, leagueProfile?.passDef) === 'high') return 'coverage';
  if (oppRanks.rushDefRank >= 22 || statBucket(rushAllowed, leagueProfile?.rushDef) === 'high') return 'front';
  return 'balanced';
}

function defensiveProfileTag(defensiveMismatch = null, fieldVulnerability = null, oppStats = {}, oppRanks = {}, leagueProfile = null) {
  const tendency = relativeTendencyLabel(oppStats, leagueProfile);
  if (defensiveMismatch?.type === 'protection') return 'pressure';
  if (fieldVulnerability?.area === 'slot') return 'slot';
  if (fieldVulnerability?.area === 'outside') return 'outside';
  if (fieldVulnerability?.area === 'box') return 'runfit';
  if (tendency === 'pass-heavy' || oppRanks.passOffRank <= 10) return 'coverage';
  if (tendency === 'run-heavy' || oppRanks.rushOffRank <= 10) return 'front';
  return 'balanced';
}

function arrangePlanLines(lines = [], preferred = []) {
  const filtered = lines.filter((entry) => entry && entry.key && entry.text);
  const byKey = new Map(filtered.map((entry) => [entry.key, entry.text]));
  const ordered = [];
  for (const key of preferred) {
    if (byKey.has(key)) {
      ordered.push(byKey.get(key));
      byKey.delete(key);
    }
  }
  for (const entry of filtered) {
    if (byKey.has(entry.key)) {
      ordered.push(entry.text);
      byKey.delete(entry.key);
    }
  }
  return ordered;
}

function findBestMismatch(ownRoster = [], oppRoster = [], ownStats = {}, oppStats = {}) {
  return [findCoverageMismatch(ownRoster, oppRoster), findProtectionMismatch(ownRoster, oppRoster, oppStats), findRunMismatch(ownRoster, oppRoster)]
    .filter(Boolean)
    .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))[0] || null;
}

function buildMismatchNote(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const { target, defender } = mismatch;
    const targetSpeed = speedRating(target);
    const targetAgility = Number(target?.agilityRating || 0);
    const routeAttr = bestRouteAttribute(target);
    const coverageAttr = bestCoverageAttribute(defender);
    const defenderSpeed = speedRating(defender);
    const press = Number(defender?.pressRating || 0);
    return `${playerLabel(target)} vs ${playerLabel(defender)}: lean on Speed ${targetSpeed}, Agility ${targetAgility}, and ${routeAttr.label} ${routeAttr.value} against ${coverageAttr.label} ${coverageAttr.value} and Press ${press}. If you have the speed edge, test him vertically; if not, make the route-running and change of direction do the work.`;
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
    return `${playerLabel(rusher)} vs ${playerLabel(blocker)}: attack with ${rushMove.label} ${rushMove.value}, Strength ${strength}, and overall rush pressure into Pass Block ${passBlock}, Pass Block Power ${passBlockPower}, and Pass Block Finesse ${passBlockFinesse}. ${roomTag}.`;
  }
  if (mismatch.type === 'run') {
    const { back, defender } = mismatch;
    const speed = speedRating(back);
    const agility = Number(back?.agilityRating || 0);
    const accel = accelRating(back);
    const tackle = Number(defender?.tackleRating || 0);
    const pursuit = Number(defender?.pursuitRating || 0);
    return `${playerLabel(back)} vs ${playerLabel(defender)}: use Speed ${speed}, Acceleration ${accel}, and Agility ${agility} against Tackle ${tackle} and Pursuit ${pursuit}. If the first defender misses or takes a bad angle, that run can turn loose fast.`;
  }
  return null;
}

function buildMatchupLeanSentence(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const { target, defender } = mismatch;
    const targetSpeed = speedRating(target);
    const targetAgility = Number(target?.agilityRating || 0);
    const defenderSpeed = speedRating(defender);
    const routeAttr = bestRouteAttribute(target);
    const coverageAttr = bestCoverageAttribute(defender);
    return `The best matchup leans to ${playerLabel(target)} against ${playerLabel(defender)}. The clearest edge is Speed ${targetSpeed} and ${routeAttr.label} ${routeAttr.value} against ${coverageAttr.label} ${coverageAttr.value}; Agility ${targetAgility} matters more if the speed gap on ${defenderSpeed} is not clean enough to just run by him.`;
  }
  if (mismatch.type === 'protection') {
    const { rusher, blocker, olSignal } = mismatch;
    const rushMove = bestRushMoveAttribute(rusher);
    const passBlock = Number(blocker?.passBlockRating || 0);
    const passBlockPower = Number(blocker?.passBlockPowerRating || 0);
    const passBlockFinesse = Number(blocker?.passBlockFinesseRating || 0);
    return `The best matchup leans to ${playerLabel(rusher)} on ${playerLabel(blocker)}. The key is ${rushMove.label} ${rushMove.value} attacking Pass Block ${passBlock}, Pass Block Power ${passBlockPower}, and Pass Block Finesse ${passBlockFinesse}, and the full line is already allowing ${Number(olSignal?.sacksAllowedPerGame || 0).toFixed(1)} sacks per game.`;
  }
  if (mismatch.type === 'run') {
    const { back, defender } = mismatch;
    const speed = speedRating(back);
    const accel = accelRating(back);
    const agility = Number(back?.agilityRating || 0);
    const tackle = Number(defender?.tackleRating || 0);
    const pursuit = Number(defender?.pursuitRating || 0);
    return `The best matchup leans to ${playerLabel(back)} in space against ${playerLabel(defender)}. Speed ${speed}, Acceleration ${accel}, and Agility ${agility} are going at Tackle ${tackle} and Pursuit ${pursuit}, so one missed fit can turn into a real explosive.`;
  }
  return null;
}

function buildBaseMatchupLine(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    return `The cleanest matchup is outside against their coverage depth. Test whether they can hold up vertically before they get comfortable.`;
  }
  if (mismatch.type === 'protection') {
    return `The cleanest matchup is in protection. Make their line prove it can hold up without help.`;
  }
  if (mismatch.type === 'run') {
    return `The cleanest matchup is on the ground in space. One missed fit can flip field position fast.`;
  }
  return null;
}

function buildAttributeEdgeLine(mismatch) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const targetSpeed = speedRating(mismatch.target);
    const defenderSpeed = speedRating(mismatch.defender);
    const routeAttr = bestRouteAttribute(mismatch.target);
    const coverageAttr = bestCoverageAttribute(mismatch.defender);
    const speedGap = targetSpeed - defenderSpeed;
    return `Numbers: ${playerLabel(mismatch.target)} has Speed ${targetSpeed} with ${routeAttr.label} ${routeAttr.value}; ${playerLabel(mismatch.defender)} is giving you ${coverageAttr.label} ${coverageAttr.value} with Speed ${defenderSpeed}${speedGap > 0 ? `, so the raw speed edge is +${speedGap}` : ''}.`;
  }
  if (mismatch.type === 'protection') {
    const rushMove = bestRushMoveAttribute(mismatch.rusher);
    const blockerPb = Number(mismatch.blocker?.passBlockRating || 0);
    const blockerPbp = Number(mismatch.blocker?.passBlockPowerRating || 0);
    const blockerPbf = Number(mismatch.blocker?.passBlockFinesseRating || 0);
    const strength = Number(mismatch.rusher?.strengthRating || 0);
    return `Numbers: ${playerLabel(mismatch.rusher)} brings ${rushMove.label} ${rushMove.value} and Strength ${strength}; ${playerLabel(mismatch.blocker)} is sitting at Pass Block ${blockerPb}, Power ${blockerPbp}, Finesse ${blockerPbf}.`;
  }
  if (mismatch.type === 'run') {
    const backSpeed = speedRating(mismatch.back);
    const backAccel = accelRating(mismatch.back);
    const backAgility = Number(mismatch.back?.agilityRating || 0);
    const defenderPursuit = Number(mismatch.defender?.pursuitRating || 0);
    const defenderTackle = Number(mismatch.defender?.tackleRating || 0);
    return `Numbers: ${playerLabel(mismatch.back)} gives you Speed ${backSpeed}, Acceleration ${backAccel}, Agility ${backAgility}; ${playerLabel(mismatch.defender)} is trying to finish with Pursuit ${defenderPursuit} and Tackle ${defenderTackle}.`;
  }
  return null;
}

function buildTendencyPlanLine(oppStats = {}, oppRanks = {}) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const passYpg = average(oppStats?.pass?.yds, games);
  const rushYpg = average(oppStats?.rush?.yds, games);
  const sacksTaken = average(oppStats?.pass?.sacksTaken, games);
  const tendency = tendencyLabel(oppStats);
  if (tendency === 'pass-heavy') {
    return `Tendency: they are a pass-heavy outfit at ${passYpg.toFixed(1)} pass ypg. Make them snap it again and again underneath instead of giving them deep free access.`;
  }
  if (tendency === 'run-heavy') {
    return `Tendency: they want the run game to set the script at ${rushYpg.toFixed(1)} rush ypg. Close early-down space and force more pure dropback football.`;
  }
  if (oppRanks.passOffRank <= 10 && oppRanks.rushOffRank <= 12) {
    return `Tendency: they are balanced, but the real danger is staying ahead of schedule. Do not let them live in easy 2nd-and-medium all game.`;
  }
  if (sacksTaken >= 2.2) {
    return `Tendency: they are balanced on paper, but ${sacksTaken.toFixed(1)} sacks allowed per game says negative plays still change their script quickly.`;
  }
  return `Tendency: they are mostly balanced. Your edge comes from forcing them into a game style they do not want, not from waiting on a free mistake.`;
}

function buildDefensiveContextLine(oppStats = {}, oppRanks = {}, leagueProfile = null) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const sacksTaken = average(oppStats?.pass?.sacksTaken, games);
  const passYpg = average(oppStats?.pass?.yds, games);
  const rushYpg = average(oppStats?.rush?.yds, games);
  const tendency = relativeTendencyLabel(oppStats, leagueProfile);
  const sacksPhrase = relativeStatPhrase(sacksTaken, leagueProfile?.sacksAllowed, 'sacks allowed');
  const passPhrase = relativeStatPhrase(passYpg, leagueProfile?.passOff, 'pass production');
  const rushPhrase = relativeStatPhrase(rushYpg, leagueProfile?.rushOff, 'rush production');
  if (statBucket(sacksTaken, leagueProfile?.sacksAllowed) === 'high') {
    return `They are also giving up ${sacksTaken.toFixed(1)} sacks per game, which is ${sacksPhrase}, so negative plays still change their whole script quickly if you get them behind the sticks.`;
  }
  if (tendency === 'pass-heavy' && oppRanks.passOffRank <= 10) {
    return `The key is changing the picture after the snap without letting a pass game at ${passYpg.toFixed(1)} yards, which is ${passPhrase}, settle into rhythm.`;
  }
  if (tendency === 'run-heavy' && oppRanks.rushOffRank <= 10) {
    return `If you can turn ${rushYpg.toFixed(1)} rush yards per game, which is ${rushPhrase}, into long-yardage football, their offense has to operate outside its cleaner script.`;
  }
  return `This is more about changing their comfort than waiting for a free error. Make them confirm the read after the snap and finish every drive the hard way.`;
}

function buildConceptSuggestionLine(mismatch, ownStats = {}, oppStats = {}, oppRanks = {}) {
  if (!mismatch) return null;
  if (mismatch.type === 'coverage') {
    const shell = Number(oppRanks?.passDefRank || 16) <= 12 ? 'if they stay over the top' : 'if they spin late or sit flat';
    return `Call sheet: start with flood, sail, deep over, and slot fade concepts to test ${playerLabel(mismatch.defender)}. If ${shell}, come back to digs, curls, spacing, and mesh to make that corner tackle after the catch.`;
  }
  if (mismatch.type === 'protection') {
    const sacksTaken = average(oppStats?.pass?.sacksTaken, Math.max(1, Number(oppStats?.games || 0)));
    return `Call sheet: attack with overload pressure, nickel mug looks, slot heat, and simulated pressure at ${playerLabel(mismatch.blocker)}. If they start max protecting${sacksTaken >= 2.2 ? ` like they have had to all year` : ''}, sit in match zones and rally on the quick game.`;
  }
  if (mismatch.type === 'run') {
    return `Call sheet: use outside zone, stretch, toss, angle/Texas routes, and boot action off that same look. If they start flying downhill to the edge, come right back with split-zone, counter, or play-action crossers behind it.`;
  }
  return null;
}

function buildLimitPlayerLine(oppStars = [], keyOppStress = []) {
  const threat = oppStars[0] || null;
  if (!threat) return null;
  const pos = String(threat.position || '').toUpperCase();
  if (pos === 'QB') {
    return `Limit: ${threat.name}. Make him throw late, not on rhythm${Number(threat.rushYds || 0) >= 140 ? ', and keep a body on him when he breaks the pocket' : ''}.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `Limit: ${threat.name}. Shade him on key downs and make the rest of the target tree beat you instead of letting him own the leverage snaps.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `Limit: ${threat.name}. Fit the run clean first, then make him win in obvious pass situations instead of living on efficient early-down touches.`;
  }
  const stress = keyOppStress[0];
  if (stress && normalizeName(stress.name || '') !== normalizeName(threat.name || '')) {
    return `Limit: ${threat.name}, but keep making ${stress.name} handle pressure too. If both stress points stay live, their offense gets a lot thinner.`;
  }
  return `Limit: ${threat.name}. Make the ball and the matchup go somewhere else.`;
}

function buildSchemeAgainstLine(oppStars = [], oppStats = {}, oppRanks = {}, oppRoster = []) {
  const threat = oppStars[0] || null;
  const tendency = tendencyLabel(oppStats);
  if (threat) {
    const pos = String(threat.position || '').toUpperCase();
    if (pos === 'QB') {
      return `Scheme: show two-high pre-snap, rotate late, and make the quarterback diagnose after the snap. If he starts escaping, set the edge first and make him climb into traffic.`;
    }
    if (['WR', 'TE'].includes(pos)) {
      return `Scheme: reroute the primary target when you can, bracket him on money downs, and force them to stack long drives through secondary options.`;
    }
    if (['HB', 'RB', 'FB'].includes(pos)) {
      return `Scheme: tighten the box early, spill the run outside, and force their back into checkdown and protection snaps instead of easy downhill carries.`;
    }
  }
  if (tendency === 'pass-heavy') {
    return `Scheme: sit on intermediate throwing windows, tackle the underneath game, and make them string together long drives without explosives.`;
  }
  if (tendency === 'run-heavy') {
    return `Scheme: crowd early-down fits, force more 2nd-and-long, and make their dropback game carry the script.`;
  }
  const weakestCover = buildDefenseWeaknessNote(oppRoster, [], oppStats);
  return weakestCover
    ? `Scheme: stay balanced, but keep coming back to the weak spot the data is showing. ${weakestCover}`
    : `Scheme: stay balanced and win the hidden-down snaps. Do not hand them field position with busted leverage or cheap explosives.`;
}

function buildAdvancedStrategyLines(mismatch, ownStats, oppStats, oppRanks, oppRoster, oppInjuryPlayers, oppStars = [], keyOppStress = []) {
  if (!mismatch) return null;
  const lines = [];
  if (mismatch.type === 'coverage') {
    lines.push(`Exploit lane: make ${playerLabel(mismatch.defender)} prove he can survive your first vertical test without safety help.`);
    lines.push(`Counter window: if they cap the outside release, come back to intermediate timing throws and force their underneath coverage to tackle cleanly.`);
  } else if (mismatch.type === 'protection') {
    lines.push(`Exploit lane: keep pressure aimed at ${playerLabel(mismatch.blocker)} until they prove they can protect him without sliding help.`);
    lines.push(`Counter window: if they keep extra protectors in, rally to the quick game and make them drive the field without explosives.`);
  } else if (mismatch.type === 'run') {
    lines.push(`Exploit lane: stress ${playerLabel(mismatch.defender)} in space early and make the pursuit angle clean all game.`);
    lines.push(`Counter window: if they start overplaying the perimeter run, come back to play-action before the box settles down again.`);
  }
  const attributeEdgeLine = buildAttributeEdgeLine(mismatch);
  if (attributeEdgeLine) lines.push(attributeEdgeLine);
  const tendencyLine = buildTendencyPlanLine(oppStats, oppRanks);
  if (tendencyLine) lines.push(tendencyLine);
  const conceptLine = buildConceptSuggestionLine(mismatch, ownStats, oppStats, oppRanks);
  if (conceptLine) lines.push(conceptLine);
  const limitLine = buildLimitPlayerLine(oppStars, keyOppStress);
  if (limitLine) lines.push(limitLine);
  const schemeLine = buildSchemeAgainstLine(oppStars, oppStats, oppRanks, oppRoster);
  if (schemeLine) lines.push(schemeLine);
  const weaknessNote = buildDefenseWeaknessNote(oppRoster, oppInjuryPlayers, oppStats);
  if (weaknessNote) lines.push(`Extra read: ${weaknessNote}`);
  return lines.slice(0, 7).join('\n');
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
    return `${playerLabel(weakestCover)}: coverage ${Math.max(Number(weakestCover?.manCoverRating || 0), Number(weakestCover?.zoneCoverRating || 0))}; best spot to test outside.`;
  }

  const frontSeven = oppRoster.filter((p) => ['MLB', 'ROLB', 'LOLB', 'LE', 'RE', 'DT'].includes(String(p?.position || '').toUpperCase()));
  const weakTackler = [...frontSeven].sort((a, b) => (Number(a?.tackleRating || 0) + Number(a?.pursuitRating || 0)) - (Number(b?.tackleRating || 0) + Number(b?.pursuitRating || 0)))[0];
  if (weakTackler && (Number(weakTackler?.tackleRating || 0) + Number(weakTackler?.pursuitRating || 0)) <= 145) {
    return `${playerLabel(weakTackler)}: tackle/pursuit ${Number(weakTackler?.tackleRating || 0)}/${Number(weakTackler?.pursuitRating || 0)}; make him finish in space.`;
  }

  const olSignal = buildOlRoomSignal(oppRoster, oppStats);
  if (olSignal.vulnerability >= 18 && (olSignal.weakCount >= 2 || olSignal.sacksAllowedPerGame >= 2.4)) {
    return `Their line is giving up ${olSignal.sacksAllowedPerGame.toFixed(1)} sacks/g; pressure is still worth leaning into.`;
  }

  return null;
}

function buildOffensiveIdentityLine(ownTeamName, opponentTeamName, ownStats = {}, oppStats = {}, ownRanks = {}, oppRanks = {}, leagueProfile = null) {
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const ownPassYpg = average(ownStats?.pass?.yds, ownGames);
  const ownRushYpg = average(ownStats?.rush?.yds, ownGames);
  const oppPassAllowed = average(oppStats?.def?.passYdsAllowed, oppGames);
  const oppRushAllowed = average(oppStats?.def?.rushYdsAllowed, oppGames);
  const passRankTag = formatRankBucket(oppRanks.passDefRank);
  const rushRankTag = formatRankBucket(oppRanks.rushDefRank);
  const tendency = relativeTendencyLabel(ownStats, leagueProfile);
  const passPhrase = relativeStatPhrase(ownPassYpg, leagueProfile?.passOff, 'pass production');
  const rushPhrase = relativeStatPhrase(ownRushYpg, leagueProfile?.rushOff, 'rush production');
  const oppPassDefPhrase = relativeStatPhrase(oppPassAllowed, leagueProfile?.passDef, 'pass defense allowed');
  const oppRushDefPhrase = relativeStatPhrase(oppRushAllowed, leagueProfile?.rushDef, 'rush defense allowed');
  const passRatePhrase = relativePassRatePhrase(ownStats, leagueProfile);
  const seed = hashSeed(ownTeamName, opponentTeamName, ownPassYpg.toFixed(1), ownRushYpg.toFixed(1));
  if (oppRanks.passDefRank >= 22 || statBucket(oppPassAllowed, leagueProfile?.passDef) === 'high') {
    return pickVariant(seed, [
      `${ownTeamName} should open this week through the air and make speed the first stress point. ${opponentTeamName} are allowing ${oppPassAllowed.toFixed(1)} pass yards per game, which is ${oppPassDefPhrase}${passRankTag ? ` and lines up with a ${passRankTag} pass defense` : ''}, while their ${oppRushAllowed.toFixed(1)} rush yards allowed sit ${oppRushDefPhrase}.`,
      `This starts as a throw-first week for ${ownTeamName}. Your ${ownPassYpg.toFixed(1)} pass yards per game sit ${passPhrase}, and ${opponentTeamName} are giving up ${oppPassAllowed.toFixed(1)} through the air, which is ${oppPassDefPhrase}${passRankTag ? ` against a ${passRankTag} pass defense` : ''}.`,
    ]);
  }
  if (oppRanks.rushDefRank >= 22 || statBucket(oppRushAllowed, leagueProfile?.rushDef) === 'high') {
    return pickVariant(seed, [
      `${ownTeamName} should let the run game shape the opening script and force the defense to tackle speed in space. ${opponentTeamName} are giving up ${oppRushAllowed.toFixed(1)} rush yards per game, which is ${oppRushDefPhrase}${rushRankTag ? ` with a ${rushRankTag} rush defense` : ''}.`,
      `${ownTeamName} have a real chance to start this on the ground. Your ${ownRushYpg.toFixed(1)} rush yards per game sit ${rushPhrase}, and ${opponentTeamName} are allowing ${oppRushAllowed.toFixed(1)} on the ground, which is ${oppRushDefPhrase}${rushRankTag ? ` with a ${rushRankTag} rush defense` : ''}.`,
    ]);
  }
  return pickVariant(seed, [
    `${ownTeamName} come in with ${passRatePhrase} at ${ownPassYpg.toFixed(1)} pass yards and ${ownRushYpg.toFixed(1)} rush yards per game. That production sits ${passPhrase} through the air and ${rushPhrase} on the ground, so this week is more about finding where your speed forces bad leverage than forcing one style for four quarters.`,
    `${ownTeamName} are playing from ${passRatePhrase} at ${ownPassYpg.toFixed(1)} pass yards and ${ownRushYpg.toFixed(1)} rush yards per game. The bigger point this week is that your pass game sits ${passPhrase} while the run game sits ${rushPhrase}, so the plan should attack the cleaner space instead of chasing balance for its own sake.`,
  ]);
}

function buildOffensiveMismatchLine(coverageMismatch = null, runMismatch = null) {
  if (coverageMismatch && (!runMismatch || Number(coverageMismatch.score || 0) >= Number(runMismatch.score || 0))) {
    const routeAttr = bestRouteAttribute(coverageMismatch.target);
    const coverageAttr = bestCoverageAttribute(coverageMismatch.defender);
    const defenderPos = String(coverageMismatch.defender?.position || '').toUpperCase();
    const matchupFrame = defenderPos === 'CB'
      ? `The likely outside matchup is ${playerLabel(coverageMismatch.target)} on ${playerLabel(coverageMismatch.defender)}.`
      : `${playerLabel(coverageMismatch.target)} is the speed stress point in their secondary, even if the coverage rolls safety help over the top.`;
    return `${matchupFrame} Speed ${speedRating(coverageMismatch.target)}, Acceleration ${accelRating(coverageMismatch.target)}, and ${routeAttr.label} ${routeAttr.value} are lined up on ${playerLabel(coverageMismatch.defender)} with Speed ${speedRating(coverageMismatch.defender)} and ${coverageAttr.label} ${coverageAttr.value}, so keep forcing that race.`;
  }
  if (runMismatch) {
    return `${playerLabel(runMismatch.back)} is your cleanest space player this week. Speed ${speedRating(runMismatch.back)}, Acceleration ${accelRating(runMismatch.back)}, and Agility ${agilityRating(runMismatch.back)} are attacking ${playerLabel(runMismatch.defender)} at Tackle ${Number(runMismatch.defender?.tackleRating || 0)} and Pursuit ${Number(runMismatch.defender?.pursuitRating || 0)}.`;
  }
  return null;
}

function buildProtectionAlertLine(protectionMismatch = null, ownInjuryAdjustment = null) {
  if (protectionMismatch) {
    const rushMove = bestRushMoveAttribute(protectionMismatch.rusher);
    return `${playerLabel(protectionMismatch.rusher)} is the protection alert. He brings ${rushMove.label} ${rushMove.value} and Strength ${Number(protectionMismatch.rusher?.strengthRating || 0)} into ${playerLabel(protectionMismatch.blocker)} at Pass Block ${Number(protectionMismatch.blocker?.passBlockRating || 0)}, so be ready to slide help, chip, or cut down the pure dropback volume if that lane starts winning.`;
  }
  return ownInjuryAdjustment || null;
}

function buildOwnStarLine(player = null, oppRanks = {}) {
  if (!player) return null;
  const dev = formatDevLabel(player);
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    const td = Number(player.passTDs || 0);
    const ints = Number(player.passInts || 0);
    const pct = completionPct(player);
    if (ints >= td || pct < 61) {
      return `${player.name} needs to get going. He is sitting at ${td} passing TDs, ${ints} interceptions, and ${pct.toFixed(1)}% completions${dev !== 'Normal' ? ` despite ${dev} trait upside` : ''}, so the plan has to protect him with cleaner reads and fewer low-percentage throws early.`;
    }
    if (pct < 65 || ints >= Math.max(4, Math.ceil(td * 0.5))) {
      return `${player.name} is still the engine here, but it has to look cleaner. At ${td} passing TDs, ${ints} interceptions, and ${pct.toFixed(1)}% completions${dev !== 'Normal' ? ` with ${dev} trait upside` : ''}, the best version of this plan is keeping him on rhythm before asking for shot plays.`;
    }
    return `${player.name} is still the engine here. At ${td} passing TDs, ${ints} interceptions, and ${pct.toFixed(1)}% completions${dev !== 'Normal' ? ` with ${dev} trait upside` : ''}, the best version of this plan is keeping him on clean timing throws before chasing hero ball.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${player.name} gives you the premium receiving profile${dev !== 'Normal' ? ` as a ${dev} target` : ''} with Speed ${speedRating(player)}, ${Number(player.recYds || 0)} receiving yards, and ${Number(player.recTDs || 0)} scores, so build the plan around forcing corners to run instead of just hoping coverage busts.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${player.name} is the touch driver${dev !== 'Normal' ? ` with ${dev} trait juice` : ''}. Speed ${speedRating(player)}, ${Number(player.rushYds || 0)} rushing yards, and ${Number(player.rushTDs || 0)} rushing TDs say the offense is cleaner when he is dictating angles and down-and-distance.`;
  }
  return null;
}

function buildAvailabilityLine({ ownInjuryPlayers = [], oppInjuryPlayers = [], ownRoster = [], oppRoster = [], mode = 'offense' }) {
  const ownInjury = findImpactInjury(ownInjuryPlayers, []);
  const oppInjury = findImpactInjury(oppInjuryPlayers, []);
  if (mode === 'offense' && ownInjury) {
    const pos = String(ownInjury.pos || '').toUpperCase();
    const name = formatPlayerName(ownInjury.player);
    if (pos === 'QB') {
      const replacement = sortByOvr(ownRoster.filter((player) => String(player?.position || '').toUpperCase() === 'QB' && normalizeName(formatPlayerName(player)) !== normalizeName(name)))[0];
      return `${name} is out, so ${replacement ? formatPlayerName(replacement) : 'the backup'} has to keep the game on schedule. Trim the menu down early and make the easy completions show up before asking the backup to carry the whole game.`;
    }
    if (['WR', 'TE', 'HB', 'RB', 'FB'].includes(pos)) {
      return `${name} is out, so touches and targets need to be redistributed cleanly. Do not let one injury turn the plan into forced volume for the wrong replacement.`;
    }
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) {
      return `${name} is out, so the protection plan has to acknowledge the replacement. Slide help, chip, and keep obvious pass downs from turning into free pressure snaps.`;
    }
  }
  if (mode === 'offense' && oppInjury) {
    const pos = String(oppInjury.pos || '').toUpperCase();
    const name = formatPlayerName(oppInjury.player);
    if (['CB', 'FS', 'SS'].includes(pos)) return `${name} is out for them, so keep testing the secondary depth until the replacement proves he can run with your speed.`;
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) return `${name} is out for them, so their front should be easier to displace and their pass rush depth is less likely to survive long drives cleanly.`;
  }
  if (mode === 'defense' && oppInjury) {
    const pos = String(oppInjury.pos || '').toUpperCase();
    const name = formatPlayerName(oppInjury.player);
    if (pos === 'QB') {
      const replacement = sortByOvr(oppRoster.filter((player) => String(player?.position || '').toUpperCase() === 'QB' && normalizeName(formatPlayerName(player)) !== normalizeName(name)))[0];
      return `${name} is out, so ${replacement ? formatPlayerName(replacement) : 'their backup'} has to run the offense. Pressure the backup early and make him prove he can handle rotation and late disguise.`;
    }
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) return `${name} is out, so the protection should be stressed until the replacement proves he can survive it.`;
    if (['WR', 'TE'].includes(pos)) return `${name} is out, so the target tree is thinner. Tighten up on the remaining speed threats and make the depth options win the game.`;
  }
  if (mode === 'defense' && ownInjury) {
    const pos = String(ownInjury.pos || '').toUpperCase();
    const name = formatPlayerName(ownInjury.player);
    if (['CB', 'FS', 'SS'].includes(pos)) return `${name} is out on your side, so do not live in isolated coverage looks if the matchup does not demand it. Keep help on the replacement and force the offense to earn length.`;
  }
  return null;
}

function buildOffensiveCounterLine(coverageMismatch = null, runMismatch = null, oppStats = {}, oppRanks = {}, fieldProfile = null, leagueProfile = null) {
  if (fieldProfile?.area === 'slot' && fieldProfile?.detail?.target && fieldProfile?.detail?.defender) {
    return `If they start squeezing the slot on ${playerLabel(fieldProfile.detail.target)}, keep the same stem picture and hit the numbers behind it with sail, dagger, and clear-out overs. Make ${playerLabel(fieldProfile.detail.defender)} handle inside leverage first, then punish the help once it overcommits.`;
  }
  if (fieldProfile?.area === 'outside' && fieldProfile?.detail?.target && fieldProfile?.detail?.defender) {
    return `If they start bracketing ${playerLabel(fieldProfile.detail.target)} outside, reduce the split stress and come back to bunch, stack, flood, and drive concepts that make the corner and safety pass routes off cleanly.`;
  }
  if (fieldProfile?.area === 'box' && fieldProfile?.detail?.back && fieldProfile?.detail?.defender) {
    return `If they start packing the box to slow ${playerLabel(fieldProfile.detail.back)}, keep the same run picture and throw behind the fit with glance, leak, and play-action crossers before the support can recover.`;
  }
  const tendency = defensiveShape(oppStats, oppRanks);
  if (coverageMismatch) {
    return `If they start capping ${playerLabel(coverageMismatch.target)} with safety help because of the speed threat, shift the menu to flood, mesh, spacing, and digs underneath it and make ${playerLabel(coverageMismatch.defender)} tackle after the catch instead of letting them erase the vertical stress for free.`;
  }
  if (runMismatch) {
    return `If they start overplaying the edge against ${playerLabel(runMismatch.back)} because they are worried about his speed, keep the same picture and come back with split-zone, counter, angle routes, and play-action crossers so the pursuit has to handle conflict instead of just running downhill.`;
  }
  return `If the first script gets squeezed, stay attached to the softer side of their structure. They have looked ${tendency}, so the answer is changing where the ball goes, not panicking into low-efficiency calls.`;
}

function buildOffensiveFinishLine(ownStats = {}, oppStats = {}, oppInjuryPlayers = []) {
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const sacksTaken = average(ownStats?.pass?.sacksTaken, ownGames);
  const oppSacks = average(oppStats?.def?.sacks, oppGames);
  const injuryExploit = pickInjuryExploit(oppInjuryPlayers);
  if (injuryExploit) {
    return `${formatPlayerName(injuryExploit)} being out changes the back end of their plan, so keep forcing the replacement unit to communicate for four quarters instead of letting them hide it.`;
  }
  if (oppSacks >= 2.4 || sacksTaken >= 2.2) {
    return `The hidden-down rule is simple: do not give their pressure free wins. Staying out of 3rd-and-long matters more than any one shot play against a front that is producing ${oppSacks.toFixed(1)} sacks per game while you are taking ${sacksTaken.toFixed(1)}.`;
  }
  return `Finish drives by staying efficient in the red zone and on third down. This week is about stacking clean snaps and making them tackle through a full field, not forcing a low-percentage knockout shot.`;
}

function buildOffensiveGamePlan({
  ownTeamName = '',
  opponentTeamName = '',
  ownStats = {},
  oppStats = {},
  ownRanks = {},
  oppRanks = {},
  leagueProfile = null,
  ownRoster = [],
  oppRoster = [],
  ownStars = [],
  ownInjuryPlayers = [],
  oppInjuryPlayers = [],
  ownAdjustmentLine = '',
}) {
  const coverageMismatch = findCoverageMismatch(ownRoster, oppRoster);
  const runMismatch = findRunMismatch(ownRoster, oppRoster);
  const protectionAlert = findProtectionMismatch(oppRoster, ownRoster, ownStats);
  const ownFeature = pickOwnFeature(ownStars, oppRanks);
  const fieldProfile = buildFieldAttackProfile(ownRoster, oppRoster, ownStats, oppStats);
  const profileTag = offensiveProfileTag(fieldProfile, oppStats, oppRanks, leagueProfile);
  const availabilityLine = buildAvailabilityLine({ ownInjuryPlayers, oppInjuryPlayers, ownRoster, oppRoster, mode: 'offense' });
  const lines = [
    { key: 'identity', text: buildOffensiveIdentityLine(ownTeamName, opponentTeamName, ownStats, oppStats, ownRanks, oppRanks, leagueProfile) },
    { key: 'mismatch', text: buildOffensiveMismatchLine(coverageMismatch, runMismatch) },
    { key: 'field', text: buildOffensiveFieldAttackLine(fieldProfile, oppStats) },
    { key: 'protection', text: buildProtectionAlertLine(protectionAlert, ownAdjustmentLine) },
    { key: 'availability', text: availabilityLine },
    { key: 'feature', text: buildOwnStarLine(ownFeature, oppRanks) },
    { key: 'counter', text: buildOffensiveCounterLine(coverageMismatch, runMismatch, oppStats, oppRanks, fieldProfile, leagueProfile) },
    { key: 'finish', text: buildOffensiveFinishLine(ownStats, oppStats, oppInjuryPlayers) },
  ];
  const orderMap = {
    slot: ['identity', 'field', 'mismatch', 'feature', 'counter', 'protection', 'availability', 'finish'],
    outside: ['identity', 'mismatch', 'field', 'counter', 'feature', 'protection', 'availability', 'finish'],
    box: ['identity', 'field', 'feature', 'mismatch', 'protection', 'counter', 'availability', 'finish'],
    coverage: ['identity', 'mismatch', 'feature', 'field', 'counter', 'protection', 'availability', 'finish'],
    front: ['identity', 'protection', 'field', 'mismatch', 'feature', 'counter', 'availability', 'finish'],
    balanced: ['identity', 'feature', 'mismatch', 'field', 'protection', 'counter', 'availability', 'finish'],
  };
  return joinSentences(arrangePlanLines(lines, orderMap[profileTag] || orderMap.balanced), 5);
}

function buildDefensiveIdentityLine(opponentTeamName, oppStats = {}, oppRanks = {}, ownStats = {}, leagueProfile = null) {
  const ownGames = Math.max(1, Number(ownStats?.games || 0));
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const oppPassYpg = average(oppStats?.pass?.yds, oppGames);
  const oppRushYpg = average(oppStats?.rush?.yds, oppGames);
  const ownPassAllowed = average(ownStats?.def?.passYdsAllowed, ownGames);
  const ownRushAllowed = average(ownStats?.def?.rushYdsAllowed, ownGames);
  const tendency = relativeTendencyLabel(oppStats, leagueProfile);
  const passPhrase = relativeStatPhrase(oppPassYpg, leagueProfile?.passOff, 'pass production');
  const rushPhrase = relativeStatPhrase(oppRushYpg, leagueProfile?.rushOff, 'rush production');
  const ownPassDefPhrase = relativeStatPhrase(ownPassAllowed, leagueProfile?.passDef, 'pass defense allowed');
  if (tendency === 'pass-heavy') {
    return `${opponentTeamName} are one of the more pass-forward offenses in this league at ${oppPassYpg.toFixed(1)} pass yards per game, which is ${passPhrase}, so the job is taking away explosives and forcing them to work the hard yards underneath.`;
  }
  if (tendency === 'run-heavy') {
    return `${opponentTeamName} lean on the run game more than most teams in this league at ${oppRushYpg.toFixed(1)} rush yards per game, which is ${rushPhrase}. Your first win is keeping that from becoming easy early-down football against a front allowing ${ownRushAllowed.toFixed(1)} rush yards per game.`;
  }
  return `${opponentTeamName} are closer to the league middle in offensive balance at ${oppPassYpg.toFixed(1)} pass yards and ${oppRushYpg.toFixed(1)} rush yards per game. Your defense is cleaner when it keeps the ball in front, especially with ${ownPassAllowed.toFixed(1)} pass yards allowed, which sits ${ownPassDefPhrase}.`;
}

function buildDefensiveMismatchLine(defensiveMismatch = null) {
  if (!defensiveMismatch) return null;
  if (defensiveMismatch.type === 'protection') {
    const rushMove = bestRushMoveAttribute(defensiveMismatch.rusher);
    return `${playerLabel(defensiveMismatch.blocker)} is the protection weak point. ${playerLabel(defensiveMismatch.rusher)} brings ${rushMove.label} ${rushMove.value} and Strength ${Number(defensiveMismatch.rusher?.strengthRating || 0)} into Pass Block ${Number(defensiveMismatch.blocker?.passBlockRating || 0)}, Pass Block Power ${Number(defensiveMismatch.blocker?.passBlockPowerRating || 0)}, and Pass Block Finesse ${Number(defensiveMismatch.blocker?.passBlockFinesseRating || 0)}.`;
  }
  if (defensiveMismatch.type === 'coverage') {
    return `${playerLabel(defensiveMismatch.target)} is the target you cannot let own the game. His Speed ${speedRating(defensiveMismatch.target)}, Acceleration ${accelRating(defensiveMismatch.target)}, and ${bestRouteAttribute(defensiveMismatch.target).label} ${bestRouteAttribute(defensiveMismatch.target).value} are the matchup forcing your coverage rules this week.`;
  }
  if (defensiveMismatch.type === 'run') {
    return `${playerLabel(defensiveMismatch.back)} is the space problem. Speed ${speedRating(defensiveMismatch.back)} and Acceleration ${accelRating(defensiveMismatch.back)} mean one bad fit on ${playerLabel(defensiveMismatch.defender)} can become the explosive that flips the game fast.`;
  }
  return null;
}

function buildDevStressLine(player = null, role = 'threat') {
  if (!player || playerDevTier(player) < 2) return null;
  const dev = formatDevLabel(player);
  const pos = String(player?.position || '').toUpperCase();
  if (role === 'rusher') {
    return `${player.name} is also carrying ${dev} pass-rush talent, which raises the value of mug looks, simulated pressure, and any call that isolates his lane instead of letting the offense spread the protection evenly.`;
  }
  if (pos === 'QB') {
    return `${player.name} has ${dev} quarterback traits, so disguise matters. Show one picture before the snap, rotate late, and make him hold the ball long enough for the rush to win honestly.`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${player.name} brings ${dev} receiving talent, which is the right time to lean on brackets and leverage help instead of pretending a single defender should live in isolation all game.`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${player.name} has ${dev} backfield talent, so the tackle plan has to be clean. First contact and pursuit angles matter more this week than free shots at strips.`;
  }
  return null;
}

function buildDefensiveCallLine(defensiveMismatch = null, oppStats = {}) {
  if (defensiveMismatch?.type === 'protection') {
    const sacksTaken = average(oppStats?.pass?.sacksTaken, Math.max(1, Number(oppStats?.games || 0)));
    const pressureTag = sacksTaken >= 2.0
      ? `If they have already been living at ${sacksTaken.toFixed(1)} sacks allowed per game, keep forcing the protection to prove it can sort those looks out.`
      : `Even if they have only been at ${sacksTaken.toFixed(1)} sacks allowed per game, keep testing the weak blocker until they prove the clean season number is real against your rush.`;
    return `Work from Nickel Over, Nickel 3-3 Double Mug, and Nickel 3-3 Single Mug, then pressure that side with Edge Blitz 3, FS Will Blitz 0, Sim Pressure 3, Field Sim 3, or Blitz Loop 3. ${pressureTag}`;
  }
  if (defensiveMismatch?.type === 'coverage') {
    return `Treat the coverage plan like a bracket problem first. Show two-high shells, reroute where you can, and make the primary target deal with Quarters, Cover 9, Double Bracket, and 1 Double WR1 instead of repeated clean one-on-ones.`;
  }
  if (defensiveMismatch?.type === 'run') {
    return `Use your front to squeeze the run picture before it starts. Spill the ball wide, fit it from depth, and make the back handle tighter boxes and late-rotating safeties instead of clean downhill reads.`;
  }
  return `Build the coverage menu from disguise first and pressure second. The point is forcing post-snap decisions, not handing them an obvious answer before the snap.`;
}

function buildDefensiveCounterLine(defensiveMismatch = null, oppStats = {}, oppStars = [], keyOppStress = [], fieldVulnerability = null) {
  if (defensiveMismatch?.type === 'protection') {
    return `If they start sliding help to ${playerLabel(defensiveMismatch.blocker)} or keeping the TE or HB in, come off the heat and make the extra protector meaningless by rallying in Quarters, Cover 9, Double Bracket, or 1 Double WR1.`;
  }
  if (fieldVulnerability?.area === 'slot' && fieldVulnerability?.detail?.target) {
    return `If they start feeding ${playerLabel(fieldVulnerability.detail.target)} inside, stop treating it like normal zone traffic. Push help into the slot, reroute him early, and force the ball to the boundary.`;
  }
  if (fieldVulnerability?.area === 'outside' && fieldVulnerability?.detail?.target) {
    return `If the outside matchup starts getting loose for ${playerLabel(fieldVulnerability.detail.target)}, stop leaving the corner exposed. Tilt the coverage over the top and make the ball come back underneath.`;
  }
  if (fieldVulnerability?.area === 'box' && fieldVulnerability?.detail?.back) {
    return `If their back starts stressing the second level, tighten the run fit first and force him to bounce laterally. The answer is cleaner angles and faster support, not just heavier pressure.`;
  }
  const threat = oppStars[0] || keyOppStress[0];
  if (threat) {
    return `If ${threat.name} starts tilting the script, stop treating this like a generic call sheet. Move the leverage to him, make the ball go elsewhere, and trust the rest of the offense to sustain the drive the hard way.`;
  }
  return `If the first answer gets taken away, keep the shell and change the pressure picture. The value here is making them solve a new post-snap problem without getting a cheap pre-snap tell.`;
}

function buildDefensiveFinishLine(oppStars = [], keyOppStress = [], oppStats = {}, oppRoster = []) {
  const limitLine = buildLimitPlayerLine(oppStars, keyOppStress);
  const schemeLine = buildSchemeAgainstLine(oppStars, oppStats, {}, oppRoster);
  return [limitLine, schemeLine].filter(Boolean).join(' ');
}

function buildDefensiveGamePlan({
  opponentTeamName = '',
  ownStats = {},
  oppStats = {},
  oppRanks = {},
  leagueProfile = null,
  ownRoster = [],
  oppRoster = [],
  ownInjuryPlayers = [],
  oppInjuryPlayers = [],
  oppStars = [],
  keyOppStress = [],
}) {
  const defensiveMismatch = findProtectionMismatch(ownRoster, oppRoster, oppStats) || findBestMismatch(oppRoster, ownRoster, oppStats, ownStats);
  const fieldVulnerability = findDefensiveFieldVulnerability(oppRoster, ownRoster, oppStats);
  const profileTag = defensiveProfileTag(defensiveMismatch, fieldVulnerability, oppStats, oppRanks, leagueProfile);
  const primaryThreat = defensiveMismatch?.type === 'protection' ? defensiveMismatch.rusher : (oppStars[0] || null);
  const availabilityLine = buildAvailabilityLine({ ownInjuryPlayers, oppInjuryPlayers, ownRoster, oppRoster, mode: 'defense' });
  const lines = [
    { key: 'identity', text: buildDefensiveIdentityLine(opponentTeamName, oppStats, oppRanks, ownStats, leagueProfile) },
    { key: 'mismatch', text: buildDefensiveMismatchLine(defensiveMismatch) },
    { key: 'field', text: buildDefensiveFieldLine(fieldVulnerability) },
    { key: 'availability', text: availabilityLine },
    { key: 'dev', text: buildDevStressLine(primaryThreat, defensiveMismatch?.type === 'protection' ? 'rusher' : 'threat') },
    { key: 'context', text: buildDefensiveContextLine(oppStats, oppRanks, leagueProfile) },
    { key: 'calls', text: buildDefensiveCallLine(defensiveMismatch, oppStats) },
    { key: 'counter', text: buildDefensiveCounterLine(defensiveMismatch, oppStats, oppStars, keyOppStress, fieldVulnerability) },
    { key: 'finish', text: buildDefensiveFinishLine(oppStars, keyOppStress, oppStats, oppRoster) },
  ];
  const orderMap = {
    pressure: ['identity', 'mismatch', 'calls', 'context', 'counter', 'dev', 'availability', 'finish', 'field'],
    slot: ['identity', 'field', 'mismatch', 'calls', 'counter', 'context', 'availability', 'finish', 'dev'],
    outside: ['identity', 'field', 'mismatch', 'context', 'calls', 'counter', 'availability', 'finish', 'dev'],
    runfit: ['identity', 'field', 'context', 'mismatch', 'calls', 'counter', 'availability', 'finish', 'dev'],
    coverage: ['identity', 'mismatch', 'field', 'context', 'calls', 'counter', 'availability', 'finish', 'dev'],
    front: ['identity', 'context', 'mismatch', 'calls', 'field', 'counter', 'availability', 'finish', 'dev'],
    balanced: ['identity', 'mismatch', 'context', 'field', 'calls', 'counter', 'availability', 'finish', 'dev'],
  };
  return joinSentences(arrangePlanLines(lines, orderMap[profileTag] || orderMap.balanced), 5);
}

function buildOpponentRecordPressureLine(opponentTeamName = '', oppStanding = null) {
  const wins = Number(oppStanding?.totalWins || 0);
  const losses = Number(oppStanding?.totalLosses || 0);
  if ((wins + losses) <= 0) return null;
  if (wins >= losses + 3) {
    return `${opponentTeamName} have enough cushion to stay on script, so do not expect panic calls early. You usually have to take away their first menu before the coach starts forcing the ball or chasing the game.`;
  }
  if (losses >= wins + 3) {
    return `${opponentTeamName} are carrying more week-to-week pressure right now, so a bad first quarter can push them into hero-ball mode, extra pressure looks, or faster tempo than they really want.`;
  }
  return `${opponentTeamName} are in a game that should stay normal through the first script, so the real tell is the first clean adjustment. Once the score tilts, that is usually when the coach shows his real comfort call.`;
}

function buildOpponentPressureResponseLine(oppStats = {}, leagueProfile = null) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const sacksTaken = average(oppStats?.pass?.sacksTaken, games);
  const passYpg = average(oppStats?.pass?.yds, games);
  const sackBucket = statBucket(sacksTaken, leagueProfile?.sacksAllowed);
  if (sackBucket === 'high') {
    return `Pressure still changes their menu fast. At ${sacksTaken.toFixed(1)} sacks allowed per game, muddy pockets usually push them into quick game, max protect, or checkdown football instead of full-field reads.`;
  }
  if (sackBucket === 'low' && passYpg >= 200) {
    return `They have protected it well enough to keep the whole call sheet open, so four-man rush alone is less likely to get them off schedule. The cleaner answer is disguise, late rotation, and making the QB hold the first read.`;
  }
  return `Their pressure response has been closer to league middle, so this is not just about sending heat. Change the picture, mug the front, spin the shell late, and make them diagnose after the snap.`;
}

function buildOpponentDefensiveTendencyLine(opponentTeamName = '', oppStats = {}, oppRanks = {}, ownRoster = [], oppRoster = []) {
  const fieldProfile = buildFieldAttackProfile(ownRoster, oppRoster, {}, oppStats);
  if (fieldProfile?.area === 'slot' && fieldProfile?.detail?.target && fieldProfile?.detail?.defender) {
    return `Against your offense, the softer access point is the slot. ${playerLabel(fieldProfile.detail.defender)} is the inside coverage stress point, so bunch, trips, option routes, pivots, and seams are the best ways to make them tip their hand.`;
  }
  if (fieldProfile?.area === 'outside' && fieldProfile?.detail?.target && fieldProfile?.detail?.defender) {
    return `Against your offense, the cleaner access point is outside. ${playerLabel(fieldProfile.detail.defender)} is the corner to stress with go balls, comebacks, flood, and deep overs until ${opponentTeamName} start rolling help over the top.`;
  }
  if (fieldProfile?.area === 'box' && fieldProfile?.detail?.defender) {
    return `The easier stress point is the box and alley. ${playerLabel(fieldProfile.detail.defender)} is the support player you want fitting outside zone, stretch, toss, and backfield angle routes over and over again.`;
  }
  const shape = defensiveShape(oppStats, oppRanks);
  if (shape === 'more vulnerable through the air than on the ground') {
    return `Their defense has looked easier to move through the air than on the ground, so this week is more about coverage spacing, leverage, and forcing safeties to declare than trying to hammer a run-first script.`;
  }
  if (shape === 'more vulnerable on the ground than through the air') {
    return `Their defense has looked softer on the ground than through the air, so the better plan is making the front and second level fit the run cleanly before you even worry about forcing deep dropback volume.`;
  }
  return `Their defensive profile is relatively balanced, so the edge is more about formationing into the right matchup than assuming one whole coverage family or front structure will break by itself.`;
}

function buildOpponentCoachCounterLine(oppStats = {}, oppRanks = {}, ownRoster = [], oppRoster = []) {
  const tendency = tendencyLabel(oppStats);
  const fieldProfile = buildFieldAttackProfile(ownRoster, oppRoster, {}, oppStats);
  const pressurePoint = findProtectionMismatch(ownRoster, oppRoster, oppStats);
  if (tendency === 'pass-heavy') {
    return `Coach counter: if they open in pass-first mode, show two-high, rotate late, and take away the clean rhythm throw first. If they answer with max protect or quick game, rally underneath and make them stack completions instead of stealing explosives.`;
  }
  if (tendency === 'run-heavy') {
    return `Coach counter: if they keep trying to let the run game call the game, crowd early-down fits, tighten the box, and force 2nd-and-8 or worse. Once they are behind schedule, make the QB carry the script in obvious dropback football.`;
  }
  if (fieldProfile?.area === 'slot') {
    return `Coach counter: expect them to use the slot as the chain mover. Push help inside, reroute early, and if they start living on option routes, bracket the inside release and make the ball go to the boundary.`;
  }
  if (fieldProfile?.area === 'outside') {
    return `Coach counter: expect the coach to hunt the outside matchup once he sees it. Keep the corner leveraged, show help late, and if they keep taking vertical shots, make them work back to curls, digs, and checkdowns.`;
  }
  if (pressurePoint?.type === 'protection') {
    return `Coach counter: if they know the protection weak spot is live, they will eventually slide to it or keep the TE/HB in. Once that happens, come off the all-out pressure and make the extra blocker irrelevant by winning with coverage numbers.`;
  }
  return `Coach counter: the first adjustment usually matters more than the opening call. Once they show what they trust, take away that answer and make them play left-handed the rest of the way.`;
}

function buildOpponentTendencyReport({
  opponentTeamName = '',
  oppStanding = null,
  oppStats = {},
  oppRanks = {},
  leagueProfile = null,
  ownRoster = [],
  oppRoster = [],
  oppPlayers = [],
  oppStars = [],
  keyOppStress = [],
  oppInjuryPlayers = [],
}) {
  const games = Math.max(1, Number(oppStats?.games || 0));
  const passYpg = average(oppStats?.pass?.yds, games);
  const rushYpg = average(oppStats?.rush?.yds, games);
  const passRate = passRateValue(oppStats);
  const sacksTaken = average(oppStats?.pass?.sacksTaken, games);
  const sackRate = Number(oppStats?.pass?.att || 0) > 0
    ? (Number(oppStats?.pass?.sacksTaken || 0) / Math.max(1, Number(oppStats?.pass?.att || 0) + Number(oppStats?.pass?.sacksTaken || 0))) * 100
    : 0;
  const tendency = relativeTendencyLabel(oppStats, leagueProfile);
  const passBand = percentileStyleTag(passYpg, leagueProfile?.passOff, false, {
    high: 'top-quartile',
    mid: 'mid-tier',
    low: 'bottom-quartile',
  });
  const rushBand = percentileStyleTag(rushYpg, leagueProfile?.rushOff, false, {
    high: 'top-quartile',
    mid: 'mid-tier',
    low: 'bottom-quartile',
  });
  const pressureBand = percentileStyleTag(sacksTaken, leagueProfile?.sacksAllowed, false, {
    high: 'pressure-sensitive',
    mid: 'average under pressure',
    low: 'clean-pocket profile',
  });
  const fieldVulnerability = findDefensiveFieldVulnerability(oppRoster, ownRoster, oppStats);
  const mainThreat = oppStars[0] || keyOppStress[0] || null;
  const injury = findImpactInjury(oppInjuryPlayers, oppStars);
  const targetShare = teamReceiverShare(oppPlayers, Number(oppStats?.pass?.yds || 0));
  const lines = [];

  if (tendency === 'pass-heavy') {
    lines.push(`• Identity: ${(passRate * 100).toFixed(1)}% pass rate, ${passYpg.toFixed(1)} pass ypg (${passBand}), ${rushYpg.toFixed(1)} rush ypg (${rushBand}).`);
  } else if (tendency === 'run-heavy') {
    lines.push(`• Identity: ${(passRate * 100).toFixed(1)}% pass rate, ${rushYpg.toFixed(1)} rush ypg (${rushBand}), ${passYpg.toFixed(1)} pass ypg (${passBand}).`);
  } else {
    lines.push(`• Identity: ${(passRate * 100).toFixed(1)}% pass rate, ${passYpg.toFixed(1)} pass ypg (${passBand}), ${rushYpg.toFixed(1)} rush ypg (${rushBand}).`);
  }

  if (mainThreat && String(mainThreat?.position || '').toUpperCase() === 'QB') {
    const pct = completionPct(mainThreat);
    lines.push(`• QB profile: ${playerLabel(mainThreat)} — ${Number(mainThreat?.passTDs || 0)} TD, ${Number(mainThreat?.passInts || 0)} INT, ${pct.toFixed(1)}% completions, ${sacksTaken.toFixed(1)} sacks/g, ${sackRate.toFixed(1)}% sack rate (${pressureBand}).`);
  } else if (mainThreat) {
    lines.push(`• Engine: ${playerLabel(mainThreat)} is the player their script keeps coming back to first.`);
  } else {
    lines.push(`• Pressure profile: ${sacksTaken.toFixed(1)} sacks/g, ${sackRate.toFixed(1)}% sack rate (${pressureBand}).`);
  }

  if (targetShare?.player) {
    const catchSuffix = targetShare.catches > 0 ? ` on ${targetShare.catches} catches` : '';
    const ypcSuffix = targetShare.catches > 0 ? ` (${targetShare.ypc.toFixed(1)} ypc)` : '';
    lines.push(`• Distribution: ${playerLabel(targetShare.player)} carries ${targetShare.airShare.toFixed(1)}% of their air production with ${targetShare.recYds} yards${catchSuffix}${ypcSuffix}.`);
  }

  if (injury?.player) {
    lines.push(`• Availability: ${playerLabel(injury.player)} is out; expect the first adjustment to show up in touch distribution or protection usage.`);
  }

  if (fieldVulnerability?.area === 'slot' && fieldVulnerability?.detail?.target && fieldVulnerability?.detail?.defender) {
    lines.push(`• Tendency attack: close the slot access first. ${playerLabel(fieldVulnerability.detail.target)} into ${playerLabel(fieldVulnerability.detail.defender)} is the inside chain-mover, so reroute early, squeeze in-breakers, and force throws to the boundary.`);
  } else if (fieldVulnerability?.area === 'outside' && fieldVulnerability?.detail?.target && fieldVulnerability?.detail?.defender) {
    lines.push(`• Tendency attack: sit on the boundary shot and make them win inside. ${playerLabel(fieldVulnerability.detail.target)} on ${playerLabel(fieldVulnerability.detail.defender)} is the explosive lane they want to live on.`);
  } else if (fieldVulnerability?.area === 'box' && fieldVulnerability?.detail?.back && fieldVulnerability?.detail?.defender) {
    lines.push(`• Tendency attack: close the alley early. ${playerLabel(fieldVulnerability.detail.back)} on ${playerLabel(fieldVulnerability.detail.defender)} is the space matchup that keeps them on schedule.`);
  } else if (tendency === 'pass-heavy') {
    lines.push(`• Tendency attack: force checkdowns and second-window throws. Make the QB throw outside structure instead of living on rhythm.`);
  } else if (tendency === 'run-heavy') {
    lines.push(`• Tendency attack: win first down and make the QB carry the script in long-yardage dropback situations.`);
  } else {
    lines.push(`• Tendency attack: take away the first menu item and make the coach play left-handed after the first adjustment.`);
  }

  if (oppStanding) {
    const wins = Number(oppStanding?.totalWins || 0);
    const losses = Number(oppStanding?.totalLosses || 0);
    lines.push(`• Context: ${wins}-${losses} record. Expect a normal opening script unless score pressure forces them off tendency.`);
  }

  return lines.filter(Boolean).slice(0, 5).join('\n');
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) throw new Error('No Madden league is configured for this server.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const ownTeam = findCoachTeam(interaction.member, snapshot);
    if (!ownTeam) throw new Error('Could not determine your team from your coach role.');
    const recognitionContext = inferRecognitionContext('madden', interaction.guildId);
    const perkState = recognitionContext?.seasonKey
      ? getRecognitionPerkState({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: recognitionContext.seasonKey,
          userId: interaction.user.id,
          weekKey: recognitionContext.weekKey,
        })
      : null;

    const matchup = findWeeklyOpponent(snapshot, ownTeam.teamId);
    if (!matchup) throw new Error('No scheduled matchup was found for your team this week.');

    const teams = teamMap(snapshot);
    const isHome = Number(matchup.homeTeamId) === ownTeam.teamId;
    const opponentTeamId = Number(isHome ? matchup.awayTeamId : matchup.homeTeamId);
    const ownTeamName = teams.get(ownTeam.teamId) || ownTeam.fullName;
    const opponentTeamName = teams.get(opponentTeamId) || `Team ${opponentTeamId}`;
    const live = buildLiveDraftContext(snapshot);
    const leagueProfile = buildLeagueProfile(live);
    const ownStats = live.teamStatsByTeamId?.[ownTeam.teamId];
    const oppStats = live.teamStatsByTeamId?.[opponentTeamId];
    const ownStanding = (snapshot?.standings?.teamStandingInfoList || []).find((team) => Number(team.teamId) === ownTeam.teamId);
    const oppStanding = (snapshot?.standings?.teamStandingInfoList || []).find((team) => Number(team.teamId) === opponentTeamId);
    const ownRanks = teamRankBundle(live, ownTeam.teamId);
    const oppRanks = teamRankBundle(live, opponentTeamId);
    const oppPlayers = live.currentPlayersByTeamId?.[opponentTeamId] || [];
    const ownPlayers = live.currentPlayersByTeamId?.[ownTeam.teamId] || [];
    const ownRoster = teamRosterPlayers(snapshot, ownTeam.teamId);
    const oppRoster = teamRosterPlayers(snapshot, opponentTeamId);
    const ownInjuries = teamInjuries(snapshot, ownTeam.teamId, 2);
    const oppInjuries = teamInjuries(snapshot, opponentTeamId, 2);
    const ownInjuryPlayers = teamInjuryPlayers(snapshot, ownTeam.teamId, 2);
    const oppInjuryPlayers = teamInjuryPlayers(snapshot, opponentTeamId, 2);
    const { weekType, displayWeek } = currentWeekInfo(snapshot);
    const phaseLabel = weekType === 2 ? 'Postseason' : `Week ${displayWeek}`;

    const dangerLines = buildDangerLines(ownStats, oppStats, ownRanks, oppRanks);
    const offensiveCoverageMismatch = findCoverageMismatch(ownRoster, oppRoster);
    const offensiveRunMismatch = findRunMismatch(ownRoster, oppRoster);
    const offensiveMismatch = [offensiveCoverageMismatch, offensiveRunMismatch]
      .filter(Boolean)
      .sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0))[0] || null;
    const defensiveMismatch = findProtectionMismatch(ownRoster, oppRoster, oppStats) || findBestMismatch(oppRoster, ownRoster, oppStats, ownStats);
    const ownStars = topPlayers(ownPlayers, () => true, 3);
    const oppStars = topPlayers(oppPlayers, () => true, 3);
    const keyOppStress = strugglingPlayers(oppPlayers, 2);
    const ownAdjustmentLine = buildOwnInjuryAdjustmentLine(ownInjuryPlayers, ownRoster);
    const dangerLine = dangerLines[0] || '';
    const offenseGamePlanActive = Boolean(perkState?.perks?.offensiveGamePlan || perkState?.perks?.allGamePlanBundle);
    const defenseGamePlanActive = Boolean(perkState?.perks?.defensiveGamePlan || perkState?.perks?.allGamePlanBundle);
    const tendencyBreakdownActive = Boolean(perkState?.perks?.tendencyBreakdown || perkState?.perks?.allGamePlanBundle);
    const offensiveGamePlan = offenseGamePlanActive
      ? buildOffensiveGamePlan({
          ownTeamName,
          opponentTeamName,
          ownStats,
          oppStats,
          ownRanks,
          oppRanks,
          leagueProfile,
          ownRoster,
          oppRoster,
          ownStars,
          ownInjuryPlayers,
          oppInjuryPlayers,
          ownAdjustmentLine,
        })
      : null;
    const offensiveFieldProfile = buildFieldAttackProfile(ownRoster, oppRoster, ownStats, oppStats);
    const offensiveProfile = offensiveProfileTag(offensiveFieldProfile, oppStats, oppRanks, leagueProfile);
    const defensiveGamePlan = defenseGamePlanActive
      ? buildDefensiveGamePlan({
          opponentTeamName,
          ownStats,
          oppStats,
          oppRanks,
          leagueProfile,
          ownRoster,
          oppRoster,
          ownInjuryPlayers,
          oppInjuryPlayers,
          oppStars,
          keyOppStress,
        })
      : null;
    const defensiveFieldVulnerability = findDefensiveFieldVulnerability(oppRoster, ownRoster, oppStats);
    const defensiveProfile = defensiveProfileTag(defensiveMismatch, defensiveFieldVulnerability, oppStats, oppRanks, leagueProfile);
    const tendencyBreakdown = tendencyBreakdownActive
      ? buildOpponentTendencyReport({
          opponentTeamName,
          oppStanding,
          oppStats,
          oppRanks,
          leagueProfile,
          ownRoster,
          oppRoster,
          oppPlayers,
          oppStars,
          keyOppStress,
          oppInjuryPlayers,
        })
      : null;
    const offenseSeedKey = `${ownTeamName}:${opponentTeamName}:${displayWeek}:offense:${offensiveProfile}:${offensiveFieldProfile?.area || 'none'}`;
    const defenseSeedKey = `${ownTeamName}:${opponentTeamName}:${displayWeek}:defense:${defensiveProfile}:${defensiveFieldVulnerability?.area || 'none'}:${defensiveMismatch?.type || 'none'}`;
    const tendencySeedKey = `${ownTeamName}:${opponentTeamName}:${displayWeek}:tendency:${relativeTendencyLabel(oppStats, leagueProfile)}:${defensiveFieldVulnerability?.area || 'none'}`;
    const offenseResource = offenseGamePlanActive
      ? pickOffenseLearningResource(offensiveProfile, offensiveFieldProfile, ownStats, oppStats, offenseSeedKey)
      : '';
    const defenseResource = defenseGamePlanActive
      ? pickDefenseLearningResource(defensiveProfile, defensiveMismatch, defensiveFieldVulnerability, defenseSeedKey, ownStats, oppStats)
      : '';
    const tendencyResource = tendencyBreakdownActive
      ? pickTendencyLearningResource(relativeTendencyLabel(oppStats, leagueProfile), defensiveFieldVulnerability, tendencySeedKey, ownStats, oppStats)
      : '';
    const offenseStruggleNote = buildLearningStruggleNote('offense', ownStats, oppStats);
    const defenseStruggleNote = buildLearningStruggleNote('defense', ownStats, oppStats);
    const tendencyStruggleNote = buildLearningStruggleNote('tendency', ownStats, oppStats);
    const tendencyBridge = tendencyBreakdown && tendencyResource
      ? buildLearningBridge(tendencyResource, 'tendency', tendencyStruggleNote)
      : '';
    const offenseBridge = offensiveGamePlan && offenseResource
      ? buildLearningBridge(offenseResource, 'offense', offenseStruggleNote)
      : '';
    const defenseBridge = defensiveGamePlan && defenseResource
      ? buildLearningBridge(defenseResource, 'defense', defenseStruggleNote)
      : '';
    const quickRead = buildQuickRead({
      ownTeamName,
      opponentTeamName,
      oppStats,
      oppRanks,
      offensiveMismatch,
      defensiveMismatch,
      leagueProfile,
    });
    const injuryBlock = [
      ownInjuries[0] ? `${ownTeamName}: ${ownInjuries[0]}` : null,
      oppInjuries[0] ? `${opponentTeamName}: ${oppInjuries[0]}` : null,
    ].filter(Boolean).join('\n') || 'No major injuries in the current export.';

    const premiumSectionCount = [tendencyBreakdown, offensiveGamePlan, defensiveGamePlan].filter(Boolean).length;
    const premiumFieldLimit = premiumSectionCount >= 3 ? 700 : premiumSectionCount === 2 ? 800 : 900;

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
        {
          name: 'Quick Read',
          value: truncate(quickRead || 'Play your cleaner game, protect the ball, and make them earn long drives.', 600),
          inline: false,
        },
        ...(tendencyBreakdown ? [{
          name: 'Opponent Tendency Report',
          value: buildPremiumFieldValue(tendencyBreakdown, tendencyBridge, premiumFieldLimit, 'bullet'),
          inline: false,
        }] : []),
        ...(tendencyResource ? [{
          name: 'Tendency Resource',
          value: truncate(formatLearningResource(tendencyResource), 320),
          inline: false,
        }] : []),
        ...(offensiveGamePlan ? [{
          name: 'Offensive Game Plan',
          value: buildPremiumFieldValue(offensiveGamePlan, offenseBridge, premiumFieldLimit, 'sentence'),
          inline: false,
        }] : []),
        ...(offenseResource ? [{
          name: 'Offense Resource',
          value: truncate(formatLearningResource(offenseResource), 320),
          inline: false,
        }] : []),
        ...(defensiveGamePlan ? [{
          name: 'Defensive Game Plan',
          value: buildPremiumFieldValue(defensiveGamePlan, defenseBridge, premiumFieldLimit, 'sentence'),
          inline: false,
        }] : []),
        ...(defenseResource ? [{
          name: 'Defense Resource',
          value: truncate(formatLearningResource(defenseResource), 320),
          inline: false,
        }] : []),
        ...((offenseGamePlanActive || defenseGamePlanActive) ? [{
          name: 'Key Players',
          value: truncate(buildKeyNotes({
            ownStars,
            oppStars,
            keyOppStress,
            ownTeamName,
            opponentTeamName,
            oppInjuryPlayers,
            oppRanks,
            oppStats,
            ownRoster,
            oppRoster,
          }) || 'No extra player notes in the current export.', 650),
          inline: false,
        }] : []),
        {
          name: 'Injury Watch',
          value: truncate(injuryBlock, 350),
          inline: false,
        },
      )
      .setFooter({ text: coachVoiceFooter('strategy', 'Built from live weekly stats, roster state, injuries, standings, and matchup data.') });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({ content: `Failed to build weekly strategy: ${error.message}` });
  }
}

export default { data, execute };
