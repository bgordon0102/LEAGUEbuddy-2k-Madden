import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';
import { buildProjectedOutcome, hydrateThreadStateFromLiveThread, listThreadStates } from '../../shared/madden_thread_notifier.js';
import { postMaddenStaffDecision } from '../../shared/madden_staff_ops.js';
import { getMaddenSnapshotContext, loadMaddenChannelMap } from '../../shared/madden_metadata.js';

const data = new SlashCommandBuilder()
  .setName('madden-matchuppicture')
  .setDescription('Show the current weekly matchup and strike picture (staff only).')
  .addBooleanOption((option) =>
    option
      .setName('post_to_staff')
      .setDescription('Post the report to the staff channel instead of only replying privately.')
      .setRequired(false))
  .setDefaultMemberPermissions(null);

function deadlineLabel(deadlineAt) {
  const deadline = Number(deadlineAt || 0);
  if (!deadline) return 'deadline unknown';
  const diffMs = deadline - Date.now();
  if (diffMs <= 0) return 'past deadline';
  const totalMinutes = Math.round(diffMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

function statusLabel(status = 'pending') {
  switch (String(status || '').toLowerCase()) {
    case 'pending': return 'Pending';
    case 'complete': return 'Complete';
    case 'homewin': return 'Forfeit Home';
    case 'awaywin': return 'Forfeit Away';
    case 'fairsim': return 'Fair Sim';
    case 'cpu': return 'CPU';
    case 'determined_strikes': return 'Determined';
    default: return String(status || 'Unknown');
  }
}

function projectedLabel(projected = {}) {
  if (projected?.strikeAway && projected?.strikeHome) return 'Double determined strike';
  if (projected?.strikeAway) return 'Away determined strike';
  if (projected?.strikeHome) return 'Home determined strike';
  return 'No determined strike';
}

function riskScore(entry) {
  if (entry.status === 'pending' && entry.projected?.strikeAway && entry.projected?.strikeHome) return 0;
  if (entry.status === 'pending' && (entry.projected?.strikeAway || entry.projected?.strikeHome)) return 1;
  if (entry.status === 'pending' && (entry.participation?.awayCount === 0 || entry.participation?.homeCount === 0)) return 2;
  if (entry.status === 'pending') return 3;
  return 4;
}

function buildRiskLabel(entry) {
  if (entry.projected?.strikeAway && entry.projected?.strikeHome) return 'High risk';
  if (entry.projected?.strikeAway || entry.projected?.strikeHome) return 'Watch';
  if (entry.participation.awayCount === 0 || entry.participation.homeCount === 0) return 'Quiet';
  return 'Active';
}

function conciseCurrentPicture(entries = []) {
  return entries.slice(0, 6).map((entry) =>
    `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'} • ${buildRiskLabel(entry)}${entryCoachState(entry) === 'cpu_one' ? ' • CPU side' : entryCoachState(entry) === 'cpu_both' ? ' • CPU game' : ''} • ${entry.participation.awayCount}-${entry.participation.homeCount}`
  ).join('\n');
}

function matchupLabel(entry) {
  return `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'}`;
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildCoachStatusByTeam(snapshot) {
  const map = new Map();
  for (const team of snapshot?.teams?.leagueTeamInfoList || []) {
    const city = String(team?.cityName || '').trim();
    const display = String(team?.displayName || '').trim();
    const nick = String(team?.nickName || '').trim();
    const full = [city, display].filter(Boolean).join(' ').trim() || nick || display;
    const hasCoach = Boolean(String(team?.userName || '').trim());
    const status = hasCoach ? 'coach' : 'cpu';
    for (const key of [full, display, nick, team?.abbrName].map(normalizeName).filter(Boolean)) {
      map.set(key, status);
    }
  }
  return map;
}

function coachStatusForTeam(teamName, coachStatusByTeam) {
  return coachStatusByTeam.get(normalizeName(teamName)) || 'unknown';
}

function entryCoachState(entry) {
  const away = entry.awayCoachStatus || 'unknown';
  const home = entry.homeCoachStatus || 'unknown';
  if (away !== 'coach' && home !== 'coach') return 'cpu_both';
  if (away !== 'coach' || home !== 'coach') return 'cpu_one';
  return 'coach_both';
}

function buildActionItems({ highRiskEntries = [], watchEntries = [], stableEntries = [] }) {
  const lines = [];
  if (highRiskEntries.length) {
    lines.push(`Immediate review: ${highRiskEntries.slice(0, 4).map(matchupLabel).join(' • ')}`);
  }
  if (watchEntries.length) {
    lines.push(`Monitor and nudge: ${watchEntries.slice(0, 4).map(matchupLabel).join(' • ')}`);
  }
  if (!highRiskEntries.length && !watchEntries.length && stableEntries.length) {
    lines.push('No strike actions needed right now. Keep normal reminder flow in place.');
  }
  if (!lines.length) {
    lines.push('No clear staff actions surfaced from the current thread picture.');
  }
  return lines.join('\n');
}

function buildPriorityBoard(entries = []) {
  return entries.slice(0, 6).map((entry) => {
    const afterReminderNeeded = entry.participation.awayAfterReminder > 0 || entry.participation.homeAfterReminder > 0
      ? ` • after reminder ${entry.participation.awayAfterReminder}-${entry.participation.homeAfterReminder}`
      : '';
    const coachState = entryCoachState(entry);
    const coachTag = coachState === 'cpu_one'
      ? ' • CPU side'
      : coachState === 'cpu_both'
        ? ' • CPU game'
        : '';
    return `${matchupLabel(entry)} • ${buildRiskLabel(entry)} • comm ${entry.participation.awayCount}-${entry.participation.homeCount}${afterReminderNeeded}${coachTag}`;
  }).join('\n');
}

function parseWeekIndexFromThreadName(threadName = '') {
  const match = String(threadName).match(/\b(?:week|w)\s*\.?\s*(\d+)\b/i);
  if (!match) return null;
  const weekNumber = Number(match[1]);
  return Number.isFinite(weekNumber) && weekNumber > 0 ? weekNumber - 1 : null;
}

async function resolveTrackedThread(interaction, threadId, cache = null, threadLookup = null) {
  const normalizedId = String(threadId || '');
  if (!normalizedId) return null;
  if (cache?.has(normalizedId)) return cache.get(normalizedId);
  if (threadLookup?.has(normalizedId)) {
    const cachedThread = threadLookup.get(normalizedId);
    cache?.set(normalizedId, cachedThread);
    return cachedThread;
  }

  const direct =
    interaction.client.channels.cache.get(normalizedId) ||
    await interaction.client.channels.fetch(normalizedId).catch(() => null) ||
    await interaction.guild.channels.fetch(normalizedId).catch(() => null);
  if (direct?.isTextBased?.()) {
    cache?.set(normalizedId, direct);
    return direct;
  }

  cache?.set(normalizedId, null);
  return null;
}

async function buildRoleUserCache(guild, entries = []) {
  const roleUserIds = new Map();
  const roleIds = [...new Set(entries.flatMap((info) => [ ...(info?.awayRoleIds || []), ...(info?.homeRoleIds || []) ]).filter(Boolean))];
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      roleUserIds.set(String(roleId), new Set());
      continue;
    }
    const members = role.members?.size
      ? [...role.members.keys()]
      : [...guild.members.cache.values()].filter((member) => member.roles?.cache?.has(roleId)).map((member) => member.id);
    roleUserIds.set(String(roleId), new Set(members.map(String)));
  }
  return roleUserIds;
}

async function collectParticipationForReport(thread, info, roleUserCache) {
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) {
    return {
      awayCount: 0,
      homeCount: 0,
      totalCoachMessages: 0,
      awayResponderIds: [],
      homeResponderIds: [],
      awayAfterReminder: 0,
      homeAfterReminder: 0,
    };
  }
  const awayUsers = new Set((info.awayRoleIds || []).flatMap((roleId) => [...(roleUserCache.get(String(roleId)) || new Set())]));
  const homeUsers = new Set((info.homeRoleIds || []).flatMap((roleId) => [...(roleUserCache.get(String(roleId)) || new Set())]));
  let awayCount = 0;
  let homeCount = 0;
  let awayAfterReminder = 0;
  let homeAfterReminder = 0;
  const awayResponderIds = new Set();
  const homeResponderIds = new Set();
  const reminderCutoff = Number(info?.lastReminder || 0);
  for (const message of messages.values()) {
    if (message.author?.bot) continue;
    const authorId = String(message.author.id);
    const createdAt = Number(message.createdTimestamp || 0);
    if (awayUsers.has(authorId)) {
      awayCount += 1;
      awayResponderIds.add(authorId);
      if (createdAt > reminderCutoff) awayAfterReminder += 1;
    }
    if (homeUsers.has(authorId)) {
      homeCount += 1;
      homeResponderIds.add(authorId);
      if (createdAt > reminderCutoff) homeAfterReminder += 1;
    }
  }
  return {
    awayCount,
    homeCount,
    totalCoachMessages: awayCount + homeCount,
    awayResponderIds: [...awayResponderIds],
    homeResponderIds: [...homeResponderIds],
    awayAfterReminder,
    homeAfterReminder,
  };
}

export { data };

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  try {
    const startedAt = Date.now();
    const logStep = (label, extra = {}) => {
      console.log('[madden-matchuppicture]', label, { ms: Date.now() - startedAt, ...extra });
    };
    logStep('start', { guildId: interaction.guildId, userId: interaction.user.id });
    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
      return;
    }

    const context = getMaddenSnapshotContext(interaction.guildId);
    if (!context?.leagueId || !context?.snapshot) {
      await interaction.editReply({ content: 'No Madden league is configured for this server.' });
      return;
    }
    const channelMap = loadMaddenChannelMap();
    const currentWeek = Number(context.weekNumber || 0);
    const currentWeekIndex = context.weekIndex;
    const seasonKey = context.seasonKey;
    const coachStatusByTeam = buildCoachStatusByTeam(context.snapshot);
    const gameThreadsChannelId = channelMap['Game threads'] || null;
    const storedThreadMap = new Map(listThreadStates().map((info) => [String(info?.threadId || ''), info]));
    logStep('context_ready', { currentWeek, currentWeekIndex, seasonKey, gameThreadsChannelId, storedThreads: storedThreadMap.size });

    const entries = [];
    const seasonEntries = [];
    const threadCache = new Map();
    const diagnostics = {
      tracked: 0,
      fetched: 0,
      resolvedArchived: 0,
      channelThreads: 0,
      channelAvailable: false,
      currentSeason: 0,
      currentWeek: 0,
      participationRead: 0,
      usedStoredWeek: false,
      msToCandidates: 0,
      msParticipation: 0,
    };
    const threadStates = listThreadStates().filter((info) => {
      const createdAt = Number(info?.created || 0);
      return createdAt > 0 && (Date.now() - createdAt) <= (14 * 24 * 60 * 60 * 1000);
    });
    diagnostics.tracked = threadStates.length;
    const syncedWeekStates = threadStates.filter((info) =>
      info?.seasonKey === seasonKey &&
      (currentWeekIndex == null || Number(info?.weekIndex) === currentWeekIndex)
    );
    diagnostics.usedStoredWeek = syncedWeekStates.length > 0;
    let threadLookup = new Map();
    let candidateThreads = [];
    if (syncedWeekStates.length) {
      const gameThreadsChannel = gameThreadsChannelId
        ? await interaction.client.channels.fetch(gameThreadsChannelId).catch(() => null)
        : null;
      diagnostics.channelAvailable = Boolean(gameThreadsChannel);
      const activeThreads = gameThreadsChannel?.threads?.fetchActive
        ? await gameThreadsChannel.threads.fetchActive().catch(() => null)
        : null;
      const archivedThreads = gameThreadsChannel?.threads?.fetchArchived
        ? await gameThreadsChannel.threads.fetchArchived({ limit: 100 }).catch(() => null)
        : null;
      for (const thread of activeThreads?.threads?.values?.() || []) {
        threadLookup.set(String(thread.id), thread);
      }
      for (const thread of archivedThreads?.threads?.values?.() || []) {
        threadLookup.set(String(thread.id), thread);
      }
      diagnostics.channelThreads = threadLookup.size;
      candidateThreads = syncedWeekStates.map((storedInfo) => ({
        __storedInfo: storedInfo,
        __thread: threadLookup.get(String(storedInfo.threadId)) || null,
      }));
    } else {
      const gameThreadsChannel = gameThreadsChannelId
        ? await interaction.client.channels.fetch(gameThreadsChannelId).catch(() => null)
        : null;
      diagnostics.channelAvailable = Boolean(gameThreadsChannel);
      const activeThreads = gameThreadsChannel?.threads?.fetchActive
        ? await gameThreadsChannel.threads.fetchActive().catch(() => null)
        : null;
      const archivedThreads = gameThreadsChannel?.threads?.fetchArchived
        ? await gameThreadsChannel.threads.fetchArchived({ limit: 100 }).catch(() => null)
        : null;
      for (const thread of activeThreads?.threads?.values?.() || []) {
        threadLookup.set(String(thread.id), thread);
      }
      for (const thread of archivedThreads?.threads?.values?.() || []) {
        threadLookup.set(String(thread.id), thread);
      }
      diagnostics.channelThreads = threadLookup.size;
      candidateThreads = threadLookup.size
        ? [...threadLookup.values()]
        : threadStates.map((storedInfo) => ({ __storedInfo: storedInfo }));
    }
    diagnostics.msToCandidates = Date.now() - startedAt;
    logStep('candidates_ready', {
      tracked: diagnostics.tracked,
      syncedWeekStates: syncedWeekStates.length,
      candidateThreads: candidateThreads.length,
      channelThreads: diagnostics.channelThreads,
      channelAvailable: diagnostics.channelAvailable,
    });
    const candidateInfos = [];
    for (const candidate of candidateThreads) {
      const storedInfo = candidate?.__storedInfo || storedThreadMap.get(String(candidate?.id || '')) || {};
      const thread = candidate?.__thread || (candidate?.id
        ? candidate
        : await resolveTrackedThread(interaction, storedInfo.threadId, threadCache, threadLookup));
      if (!thread?.isTextBased?.()) continue;
      diagnostics.fetched += 1;
      const resolvedThreadId = String(thread.id || storedInfo.threadId || '');
      if (resolvedThreadId && !interaction.client.channels.cache.has(resolvedThreadId)) diagnostics.resolvedArchived += 1;
      const info = hydrateThreadStateFromLiveThread(thread, storedInfo) || storedInfo;
      if (info?.seasonKey !== seasonKey) continue;
      diagnostics.currentSeason += 1;
      const inferredWeekIndex = Number.isFinite(Number(info?.weekIndex))
        ? Number(info.weekIndex)
        : parseWeekIndexFromThreadName(thread.name || '');
      if (currentWeekIndex != null && inferredWeekIndex !== currentWeekIndex) continue;
      diagnostics.currentWeek += 1;
      candidateInfos.push({
        info,
        thread,
        status: String(info.status || 'pending'),
      });
    }
    logStep('threads_filtered', {
      fetched: diagnostics.fetched,
      currentSeason: diagnostics.currentSeason,
      currentWeek: diagnostics.currentWeek,
      candidateInfos: candidateInfos.length,
    });
    const roleUserCache = await buildRoleUserCache(interaction.guild, candidateInfos.map((entry) => entry.info));
    logStep('role_cache_ready', { roles: roleUserCache.size });
    const participationStartedAt = Date.now();
    for (const baseEntry of candidateInfos) {
      let participation = null;
      try {
        participation = await collectParticipationForReport(baseEntry.thread, baseEntry.info, roleUserCache);
      } catch {
        participation = {
          awayCount: 0,
          homeCount: 0,
          totalCoachMessages: 0,
          awayAfterReminder: 0,
          homeAfterReminder: 0,
          awayResponderIds: [],
          homeResponderIds: [],
        };
      }
      diagnostics.participationRead += 1;
      const projected = buildProjectedOutcome(baseEntry.info, participation);
      const entry = {
        ...baseEntry,
        participation,
        projected,
        awayCoachStatus: coachStatusForTeam(baseEntry.info.awayTeam, coachStatusByTeam),
        homeCoachStatus: coachStatusForTeam(baseEntry.info.homeTeam, coachStatusByTeam),
      };
      seasonEntries.push(entry);
      entries.push(entry);
    }
    diagnostics.msParticipation = Date.now() - participationStartedAt;
    logStep('participation_complete', { reads: diagnostics.participationRead, msParticipation: diagnostics.msParticipation, entries: entries.length });

    if (!entries.length) {
      const fallbackWeekCandidates = seasonEntries
        .map((entry) => Number(entry?.info?.weekIndex))
        .filter((value) => Number.isFinite(value) && value >= 0);
      const fallbackWeekIndex = fallbackWeekCandidates.length
        ? Math.max(...fallbackWeekCandidates)
        : null;
      if (fallbackWeekIndex != null) {
        for (const entry of seasonEntries) {
          if (Number(entry?.info?.weekIndex) === fallbackWeekIndex) entries.push(entry);
        }
      }
      if (!entries.length) {
        await interaction.editReply({
          content: [
            'No usable matchup entries were built for the current report.',
            `Tracked: ${diagnostics.tracked}`,
            `Game threads channel available: ${diagnostics.channelAvailable ? 'yes' : 'no'}`,
            `Threads visible in channel: ${diagnostics.channelThreads}`,
            `Fetched: ${diagnostics.fetched}`,
            `Archived resolved: ${diagnostics.resolvedArchived}`,
            `Current season: ${diagnostics.currentSeason}`,
            `Current week match: ${diagnostics.currentWeek}`,
            `Participation reads: ${diagnostics.participationRead}`,
            `Used stored week records: ${diagnostics.usedStoredWeek ? 'yes' : 'no'}`,
            `Time to candidates: ${diagnostics.msToCandidates}ms`,
            `Participation time: ${diagnostics.msParticipation}ms`,
          ].join('\n'),
        });
        return;
      }
    }

    entries.sort((a, b) => {
      const riskDiff = riskScore(a) - riskScore(b);
      if (riskDiff !== 0) return riskDiff;
      return Number(a.info.deadlineAt || 0) - Number(b.info.deadlineAt || 0);
    });

    const pendingEntries = entries.filter((entry) => entry.status === 'pending');
    const coachPendingEntries = pendingEntries.filter((entry) => entryCoachState(entry) === 'coach_both');
    const cpuMixedEntries = pendingEntries.filter((entry) => entryCoachState(entry) === 'cpu_one');
    const cpuGameEntries = pendingEntries.filter((entry) => entryCoachState(entry) === 'cpu_both');
    const determinedEntries = coachPendingEntries.filter((entry) => entry.projected?.strikeAway || entry.projected?.strikeHome);
    const silentEntries = coachPendingEntries.filter((entry) => entry.participation.awayCount === 0 || entry.participation.homeCount === 0);
    const resolvedEntries = entries.filter((entry) => entry.status !== 'pending');
    const highRiskEntries = coachPendingEntries.filter((entry) => entry.projected?.strikeAway && entry.projected?.strikeHome);
    const watchEntries = coachPendingEntries.filter((entry) => (entry.projected?.strikeAway || entry.projected?.strikeHome) && !(entry.projected?.strikeAway && entry.projected?.strikeHome));
    const stableEntries = coachPendingEntries.filter((entry) => !entry.projected?.strikeAway && !entry.projected?.strikeHome);

    const leagueRead = [
      highRiskEntries.length ? `High risk: ${highRiskEntries.slice(0, 4).map((entry) => `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'}`).join(' • ')}` : null,
      watchEntries.length ? `Watch list: ${watchEntries.slice(0, 4).map((entry) => `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'}`).join(' • ')}` : null,
      stableEntries.length ? `Healthier threads: ${stableEntries.slice(0, 4).map((entry) => `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'}`).join(' • ')}` : null,
      cpuMixedEntries.length ? `CPU / user games: ${cpuMixedEntries.slice(0, 4).map((entry) => matchupLabel(entry)).join(' • ')}` : null,
      cpuGameEntries.length ? `CPU games: ${cpuGameEntries.slice(0, 4).map((entry) => matchupLabel(entry)).join(' • ')}` : null,
    ].filter(Boolean).join('\n') || 'No matchup buckets available.';

    const briefingEmbed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`Madden Matchup Briefing${currentWeek > 0 ? ` - Week ${currentWeek}` : ''}`)
      .setDescription(`Current matchup and determined-strike picture for ${seasonKey.replace(/^year_/, '')}.${diagnostics.currentWeek === 0 && seasonEntries.length ? ' Current-week export did not line up with tracked threads, so this is showing the latest tracked week instead.' : ''}`)
      .addFields(
        {
          name: 'League Snapshot',
          value: [
            `Tracked: ${entries.length}`,
            `Pending coach games: ${coachPendingEntries.length}`,
            `Resolved: ${resolvedEntries.length}`,
            `Determined risk: ${determinedEntries.length}`,
            `Silent-side risk: ${silentEntries.length}`,
            `CPU / user: ${cpuMixedEntries.length}`,
            `CPU only: ${cpuGameEntries.length}`,
          ].join('\n'),
          inline: true,
        },
        {
          name: 'Current Picture',
          value: conciseCurrentPicture(entries) || 'No tracked matchups.',
          inline: true,
        },
        {
          name: 'League Read',
          value: leagueRead,
        },
        {
          name: 'Staff Actions',
          value: buildActionItems({ highRiskEntries, watchEntries, stableEntries }),
        },
        {
          name: 'Priority Board',
          value: buildPriorityBoard([
            ...highRiskEntries,
            ...watchEntries,
            ...stableEntries,
          ]) || 'No priority matchups.',
        },
        {
          name: 'Debug',
          value: `stored=${diagnostics.usedStoredWeek ? 'yes' : 'no'} • build=${diagnostics.msToCandidates}ms • reads=${diagnostics.msParticipation}ms`,
        },
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [briefingEmbed] });

    if (interaction.options.getBoolean('post_to_staff') === true) {
      const fields = entries.slice(0, 8).map((entry) => ({
        name: `${entry.info.awayTeam || 'Away'} vs ${entry.info.homeTeam || 'Home'}`,
        value: [
          `${statusLabel(entry.status)} • ${projectedLabel(entry.projected)}`,
          `Comm: ${entry.participation.awayCount}-${entry.participation.homeCount}`,
          `After reminder: ${entry.participation.awayAfterReminder}-${entry.participation.homeAfterReminder}`,
          `Deadline: ${deadlineLabel(entry.info.deadlineAt)}`,
          `Thread: <#${entry.info.threadId}>`,
        ].join('\n'),
        inline: true,
      }));
      await postMaddenStaffDecision(
        interaction.client,
        interaction.guildId,
        `Matchup Picture${currentWeek > 0 ? ` - Week ${currentWeek}` : ''}`,
        `${determinedEntries.length} matchup(s) currently project at least one determined strike. ${silentEntries.length} pending matchup(s) still have a silent side.`,
        fields,
      ).catch(() => null);
    }
  } catch (e) {
    await interaction.editReply({ content: `Weekly picture failed: ${e?.message || e}` });
  }
}

export default { data, execute };
