import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getLeagueForGuild } from '../madden_config.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const THREAD_REMINDERS_PATH = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const WEEKLY_GAME_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'weekly_game_log.json');
const COACH_ASSIGNMENTS_PATH = path.join(process.cwd(), 'data', 'madden', 'coach_assignments.json');
const RECOGNITION_PATH = path.join(process.cwd(), 'data', 'leaguebuddy_recognition.json');
const STAFF_ACTIVITY_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'staff_activity_log.json');
const CHANNEL_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

export const data = new SlashCommandBuilder()
  .setName('madden-health')
  .setDescription('Show league health across staffing, engagement, execution, and ops.')
  .setDefaultMemberPermissions(null);

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function pctLabel(numerator, denominator) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function scoreOutOf25(value) {
  return clamp(Math.round(value * 25), 0, 25);
}

function ageHours(timestamp) {
  if (!timestamp) return null;
  return (Date.now() - Number(timestamp)) / 3600000;
}

function formatHours(hours) {
  if (!Number.isFinite(hours)) return 'unknown';
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function activeAssignedTeams(guildId) {
  const assignments = readJson(COACH_ASSIGNMENTS_PATH, {});
  const guildRoot = assignments?.[String(guildId)]?.users || {};
  const teams = new Map();
  for (const [userId, state] of Object.entries(guildRoot)) {
    for (const entry of Object.values(state?.teams || {})) {
      if (!entry?.teamName || entry?.active === false) continue;
      teams.set(String(entry.teamName).toLowerCase(), { userId, teamName: entry.teamName });
    }
  }
  return [...teams.values()];
}

function currentLeagueWeek(leagueId) {
  const leagueFile = leagueId ? path.join(LEAGUE_DIR, `${leagueId}.json`) : null;
  if (!leagueFile || !fs.existsSync(leagueFile)) return null;
  const league = readJson(leagueFile, {});
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const displayWeek = Number(seasonInfo?.displayWeek);
  if (Number.isFinite(displayWeek) && displayWeek > 0) return displayWeek;
  const seasonWeek = Number(seasonInfo?.seasonWeek);
  if (Number.isFinite(seasonWeek) && seasonWeek >= 0) return seasonWeek + 1;
  return null;
}

function buildCoverageMetrics(guildId, leagueId) {
  const assignedTeams = activeAssignedTeams(guildId);
  const roleMap = readJson(ROLE_MAP_PATH, {});
  const channelMap = readJson(CHANNEL_MAP_PATH, {});
  const leagueFile = leagueId ? path.join(LEAGUE_DIR, `${leagueId}.json`) : null;
  const snapshotFreshnessHours = leagueFile && fs.existsSync(leagueFile)
    ? ageHours(fs.statSync(leagueFile).mtimeMs)
    : null;
  const coachRolesConfigured = Object.keys(roleMap).filter((name) => name.endsWith(' Coach') && roleMap[name]).length;
  const channelsConfigured = Object.keys(channelMap || {}).length;

  const staffingRate = pct(assignedTeams.length, 32);
  const freshnessScore = snapshotFreshnessHours == null ? 0.35 : snapshotFreshnessHours <= 2 ? 1 : snapshotFreshnessHours <= 6 ? 0.8 : snapshotFreshnessHours <= 24 ? 0.55 : 0.3;
  const configScore = pct(Math.min(coachRolesConfigured, 32), 32) * 0.7 + (channelsConfigured ? 0.3 : 0);
  const score = scoreOutOf25((staffingRate * 0.6) + (freshnessScore * 0.25) + (configScore * 0.15));

  return {
    score,
    assignedTeams: assignedTeams.length,
    coachRolesConfigured,
    channelsConfigured,
    snapshotFreshnessHours,
  };
}

function buildEngagementMetrics(guildId, leagueId) {
  const recognition = readJson(RECOGNITION_PATH, {});
  const seasonRoot = recognition?.[String(guildId)]?.madden?.seasons || {};
  const currentSeasonKey = Object.keys(seasonRoot).sort().at(-1);
  const currentSeason = currentSeasonKey ? seasonRoot[currentSeasonKey] : null;
  const liveWeekNumber = currentLeagueWeek(leagueId);
  const derivedWeekKey = liveWeekNumber ? `week_${liveWeekNumber}` : null;
  const fallbackWeekKey = Object.keys(
    Object.values(currentSeason?.users || {}).find((user) => Object.keys(user?.weeks || {}).length)?.weeks || {}
  ).sort().at(-1) || null;
  const currentWeekKey = derivedWeekKey || currentSeason?.currentWeek || fallbackWeekKey;
  const userEntries = currentSeason?.users || {};
  const weekEntries = Object.values(userEntries)
    .map((user) => user?.weeks?.[currentWeekKey])
    .filter(Boolean);

  const checklistKeys = [
    ['strategy', 'Strategy'],
    ['frontOffice', 'Front Office'],
    ['stream', 'Stream'],
    ['threadResponse', 'Thread Response'],
    ['gameCompletedOnTime', 'On-Time Finish'],
  ];
  const checklistCounts = Object.fromEntries(checklistKeys.map(([key]) => [key, 0]));
  let totalChecksHit = 0;
  for (const entry of weekEntries) {
    const checklist = entry?.checklist || {};
    for (const [key] of checklistKeys) {
      if (checklist[key]) {
        checklistCounts[key] += 1;
        totalChecksHit += 1;
      }
    }
  }
  const trackedCoaches = weekEntries.length;
  const checklistDepth = trackedCoaches ? totalChecksHit / (trackedCoaches * checklistKeys.length) : 0;
  const score = scoreOutOf25((pct(trackedCoaches, 26) * 0.45) + (checklistDepth * 0.55));

  return {
    score,
    currentSeasonKey,
    currentWeekKey,
    liveWeekNumber,
    trackedCoaches,
    checklistKeys,
    checklistCounts,
  };
}

function buildExecutionMetrics(leagueId) {
  const reminders = readJson(THREAD_REMINDERS_PATH, { reminders: [] });
  const entries = Array.isArray(reminders?.reminders) ? reminders.reminders : [];
  const pending = entries.filter((entry) => String(entry?.status || '').toLowerCase() === 'pending');
  const liveWeekNumber = currentLeagueWeek(leagueId);
  const preferredWeekIndex = Number.isFinite(Number(liveWeekNumber)) ? Number(liveWeekNumber) - 1 : null;
  const activeWeekIndex = preferredWeekIndex ?? pending.reduce((max, entry) => Math.max(max, Number(entry?.weekIndex ?? -1)), -1);
  const activeWeekPending = pending.filter((entry) => Number(entry?.weekIndex ?? -1) === activeWeekIndex);
  const coachCoach = activeWeekPending.filter((entry) => entry.awayCoachStatus === 'coach' && entry.homeCoachStatus === 'coach').length;
  const cpuMix = activeWeekPending.filter((entry) => [entry.awayCoachStatus, entry.homeCoachStatus].includes('coach') && [entry.awayCoachStatus, entry.homeCoachStatus].includes('cpu')).length;
  const cpuCpu = activeWeekPending.filter((entry) => entry.awayCoachStatus !== 'coach' && entry.homeCoachStatus !== 'coach').length;
  const warnedTwentyFour = activeWeekPending.filter((entry) => entry.warnedTwentyFourAt).length;

  const weeklyLog = readJson(WEEKLY_GAME_LOG_PATH, {});
  const leagueLog = weeklyLog?.[String(leagueId)] || {};
  const latestCompletedWeek = Number(leagueLog?.latestCompletedWeek ?? 0);
  const gameRows = Array.isArray(leagueLog?.games) ? leagueLog.games : [];
  let completedWeeksReliable = 0;
  for (let weekIndex = 0; weekIndex <= latestCompletedWeek; weekIndex += 1) {
    const weekGames = gameRows.filter((row) => Number(row?.weekIndex) === weekIndex);
    if (!weekGames.length) continue;
    const playedCount = weekGames.filter((row) => row?.played).length;
    if (playedCount === weekGames.length) completedWeeksReliable += 1;
  }

  const pressurePenalty = activeWeekPending.length ? pct(warnedTwentyFour, activeWeekPending.length) : 0;
  const completionStrength = latestCompletedWeek >= 0 ? pct(completedWeeksReliable, Math.max(1, latestCompletedWeek + 1)) : 0;
  const score = scoreOutOf25((completionStrength * 0.55) + ((1 - pressurePenalty) * 0.45));

  return {
    score,
    liveWeekNumber,
    activeWeekIndex,
    activeWeekPendingCount: activeWeekPending.length,
    coachCoach,
    cpuMix,
    cpuCpu,
    warnedTwentyFour,
    latestCompletedWeek,
    completedWeeksReliable,
  };
}

function buildOpsMetrics() {
  const reminders = readJson(THREAD_REMINDERS_PATH, { reminders: [] });
  const entries = Array.isArray(reminders?.reminders) ? reminders.reminders : [];
  const staleIgnored = entries.filter((entry) => String(entry?.status || '').toLowerCase() === 'ignored').length;

  const activity = readJson(STAFF_ACTIVITY_LOG_PATH, []);
  const rows = Array.isArray(activity) ? activity : [];
  const cutoff = Date.now() - (7 * 24 * 3600000);
  const recent = rows.filter((row) => Number(row?.at || row?.timestamp || 0) >= cutoff);
  const countType = (type) => recent.filter((row) => String(row?.type || '') === type).length;

  const recapFailures = countType('weekly_recap_queue_failed');
  const participationRisk = countType('participation_risk');
  const gameChecks = countType('twenty_four_hour_game_check') + countType('twenty_four_hour_cpu_game_check');
  const completionPrompts = countType('game_complete_prompt');

  const failurePenalty = clamp((recapFailures * 0.12) + (participationRisk * 0.035) + (gameChecks * 0.02) + (staleIgnored * 0.004), 0, 0.9);
  const score = scoreOutOf25(1 - failurePenalty);

  return {
    score,
    staleIgnored,
    recapFailures,
    participationRisk,
    gameChecks,
    completionPrompts,
  };
}

function weakestAreas(metrics) {
  const areas = [
    { label: 'Coverage', score: metrics.coverage.score, note: `${metrics.coverage.assignedTeams}/32 teams staffed` },
    { label: 'Engagement', score: metrics.engagement.score, note: `${metrics.engagement.trackedCoaches} coaches tracked this week` },
    { label: 'Execution', score: metrics.execution.score, note: `${metrics.execution.warnedTwentyFour}/${Math.max(1, metrics.execution.activeWeekPendingCount)} active-week games hit 24h pressure` },
    { label: 'Ops', score: metrics.ops.score, note: `${metrics.ops.recapFailures} recap failures • ${metrics.ops.staleIgnored} stale reminder rows` },
  ];
  return areas.sort((a, b) => a.score - b.score).slice(0, 3);
}

function fixTargets(metrics) {
  const lines = [];
  if (metrics.coverage.assignedTeams < 32) lines.push(`Fill the remaining ${32 - metrics.coverage.assignedTeams} open teams before scale-up.`);
  if ((metrics.engagement.checklistCounts.strategy || 0) < Math.ceil(Math.max(1, metrics.engagement.trackedCoaches) * 0.35)) lines.push('Drive strategy usage earlier in the week so prep is not all thread-only activity.');
  if ((metrics.engagement.checklistCounts.frontOffice || 0) < Math.ceil(Math.max(1, metrics.engagement.trackedCoaches) * 0.35)) lines.push('Push more front-office touchpoints so the ecosystem is broader than game-thread check-ins.');
  if ((metrics.engagement.checklistCounts.gameCompletedOnTime || 0) === 0) lines.push('Treat on-time finish rate as a priority KPI; right now the ecosystem is not converting activity into clean closes.');
  if (metrics.execution.activeWeekPendingCount && metrics.execution.warnedTwentyFour >= Math.ceil(metrics.execution.activeWeekPendingCount * 0.75)) lines.push('Get scheduling locked earlier. Too many current-week games are already living in the 24-hour window.');
  if (metrics.ops.staleIgnored >= 20) lines.push('Clean stale reminder records so health and reminder tools are reading a cleaner live pool.');
  if (metrics.ops.recapFailures > 0) lines.push('Stabilize weekly recap queue failures so staff does not burn time on repair work.');
  return lines.slice(0, 4);
}

function leagueCoachBase(metrics) {
  return Math.max(metrics.coverage.assignedTeams, metrics.engagement.trackedCoaches, 1);
}

function displayNameForCoach(interaction, userId, teamName) {
  const member = interaction.guild?.members?.cache?.get?.(String(userId));
  const label = member?.displayName || member?.user?.globalName || member?.user?.username || teamName || String(userId);
  return teamName ? `${label} (${teamName})` : label;
}

function buildCoachPulse(interaction, guildId, engagement, execution) {
  const assignments = readJson(COACH_ASSIGNMENTS_PATH, {});
  const recognition = readJson(RECOGNITION_PATH, {});
  const assignedTeams = activeAssignedTeams(guildId);
  const assignmentByUserId = new Map(assignedTeams.map((entry) => [String(entry.userId), entry.teamName]));
  const seasonRoot = recognition?.[String(guildId)]?.madden?.seasons || {};
  const currentSeason = engagement.currentSeasonKey ? seasonRoot?.[engagement.currentSeasonKey] : null;
  const weekKey = engagement.currentWeekKey;
  const users = currentSeason?.users || {};
  const pending = Array.isArray(readJson(THREAD_REMINDERS_PATH, { reminders: [] })?.reminders)
    ? readJson(THREAD_REMINDERS_PATH, { reminders: [] }).reminders.filter((entry) => String(entry?.status || '').toLowerCase() === 'pending')
    : [];

  const pressureByTeam = new Map();
  for (const entry of pending) {
    if (Number(entry?.weekIndex ?? -1) !== Number(execution.activeWeekIndex)) continue;
    if (entry.awayCoachStatus === 'coach' && (entry.warnedTwentyFourAt || entry.warnedDeadlineAt)) {
      pressureByTeam.set(String(entry.awayTeam || ''), (pressureByTeam.get(String(entry.awayTeam || '')) || 0) + 1);
    }
    if (entry.homeCoachStatus === 'coach' && (entry.warnedTwentyFourAt || entry.warnedDeadlineAt)) {
      pressureByTeam.set(String(entry.homeTeam || ''), (pressureByTeam.get(String(entry.homeTeam || '')) || 0) + 1);
    }
  }

  const activity = [];
  const watch = [];

  for (const [userId, teamName] of assignmentByUserId.entries()) {
    const weekEntry = users?.[userId]?.weeks?.[weekKey] || null;
    const checklist = weekEntry?.checklist || {};
    const checklistHits = [
      checklist.strategy,
      checklist.stream,
      checklist.frontOffice,
      checklist.threadResponse,
      checklist.gameCompletedOnTime,
    ].filter(Boolean).length;
    const pressure = pressureByTeam.get(teamName) || 0;
    activity.push({
      userId,
      teamName,
      score: checklistHits * 10 + (checklist.gameCompletedOnTime ? 8 : 0) + (checklist.threadResponse ? 2 : 0),
    });
    const watchScore = (!weekEntry ? 2 : 0) + (checklistHits === 0 ? 2 : checklistHits <= 1 ? 1 : 0) + pressure;
    if (watchScore > 0) {
      watch.push({ userId, teamName, watchScore, weekEntry, checklistHits, pressure });
    }
  }

  const topUsers = activity
    .sort((a, b) => b.score - a.score || a.teamName.localeCompare(b.teamName))
    .filter((entry) => entry.score > 0)
    .slice(0, 3)
    .map((entry) => displayNameForCoach(interaction, entry.userId, entry.teamName));

  const removalWatch = watch
    .sort((a, b) => b.watchScore - a.watchScore || a.teamName.localeCompare(b.teamName))
    .slice(0, 3)
    .map((entry) => {
      if (!entry.weekEntry) return `${displayNameForCoach(interaction, entry.userId, entry.teamName)} - no LEAGUEbuddy touch this week`;
      if (entry.pressure > 0) return `${displayNameForCoach(interaction, entry.userId, entry.teamName)} - quiet week + thread pressure`;
      return `${displayNameForCoach(interaction, entry.userId, entry.teamName)} - low LEAGUEbuddy usage`;
    });

  return { topUsers, removalWatch };
}

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  await interaction.deferReply({ flags: 64 });

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }

  const leagueId = getLeagueForGuild(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league is configured for this server yet.' });
    return;
  }

  const coverage = buildCoverageMetrics(interaction.guildId, leagueId);
  const engagement = buildEngagementMetrics(interaction.guildId, leagueId);
  const execution = buildExecutionMetrics(leagueId);
  const ops = buildOpsMetrics();
  const overall = coverage.score + engagement.score + execution.score + ops.score;
  const weakSpots = weakestAreas({ coverage, engagement, execution, ops });
  const targets = fixTargets({ coverage, engagement, execution, ops });
  const coachBase = leagueCoachBase({ coverage, engagement });
  const coachPulse = buildCoachPulse(interaction, interaction.guildId, engagement, execution);

  const checklistText = engagement.checklistKeys
    .map(([key, label]) => `${label} ${engagement.checklistCounts[key]}/${engagement.trackedCoaches || 0}`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle('Madden League Health')
    .setColor(overall >= 75 ? 0x2ecc71 : overall >= 55 ? 0xf1c40f : 0xe67e22)
    .setDescription(
      `Overall: **${overall}/100**\n`
      + `Baseline LEAGUEbuddy health. Lower early scores are normal while league habits settle in.`
    )
    .addFields(
      {
        name: 'Scorecard',
        value:
          `Teams On Board **${coverage.score}/25**\n`
          + `Coach Usage **${engagement.score}/25**\n`
          + `Game Flow **${execution.score}/25**\n`
          + `Staff Load **${ops.score}/25**`,
        inline: true,
      },
      {
        name: 'What That Means',
        value:
          `Teams On Board = staffed teams + fresh sync\n`
          + `Coach Usage = coaches touching LEAGUEbuddy this week\n`
          + `Game Flow = how cleanly games are closing\n`
          + `Staff Load = cleanup / reminder / repair pressure`,
        inline: true,
      },
      {
        name: 'League Read',
        value:
          `${coverage.assignedTeams}/32 teams staffed\n`
          + `${engagement.trackedCoaches}/${coachBase} coached teams touched LEAGUEbuddy in Week ${engagement.liveWeekNumber || execution.liveWeekNumber || '?'}\n`
          + `${execution.activeWeekPendingCount} Week ${execution.liveWeekNumber || Math.max(0, execution.activeWeekIndex) + 1} games still open\n`
          + `${execution.activeWeekPendingCount ? `${execution.warnedTwentyFour}/${execution.activeWeekPendingCount} hit the 24h pressure window` : 'No current open-game pressure right now'}`,
        inline: true,
      },
      {
        name: 'Coach Usage This Week',
        value:
          `Strategy ${engagement.checklistCounts.strategy}/${Math.max(engagement.trackedCoaches, 1)}\n`
          + `Front Office ${engagement.checklistCounts.frontOffice}/${Math.max(engagement.trackedCoaches, 1)}\n`
          + `Stream ${engagement.checklistCounts.stream}/${Math.max(engagement.trackedCoaches, 1)}\n`
          + `Thread ${engagement.checklistCounts.threadResponse}/${Math.max(engagement.trackedCoaches, 1)}\n`
          + `On-Time ${engagement.checklistCounts.gameCompletedOnTime}/${Math.max(engagement.trackedCoaches, 1)}`,
        inline: false,
      },
      {
        name: 'Pressure Points',
        value: weakSpots.map((item) => `**${item.label}** (${item.score}/25) • ${item.note}`).join('\n'),
        inline: false,
      },
      {
        name: 'Coach Pulse',
        value:
          `Most active: ${coachPulse.topUsers.length ? coachPulse.topUsers.join(' • ') : 'No strong usage leaders yet'}\n`
          + `Removal watch: ${coachPulse.removalWatch.length ? coachPulse.removalWatch.join(' • ') : 'No clear removal-watch names right now'}`,
        inline: false,
      },
      {
        name: 'Fix Next',
        value: targets.length ? targets.map((line) => `• ${line}`).join('\n') : 'No obvious pressure points surfaced right now.',
        inline: false,
      },
    );

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
