import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';
import { buildProjectedOutcome, collectParticipation, hydrateThreadStateFromLiveThread, listThreadStates } from '../../shared/madden_thread_notifier.js';
import { postMaddenStaffDecision } from '../../shared/madden_staff_ops.js';
import { getMaddenSnapshotContext, loadMaddenChannelMap } from '../../shared/madden_metadata.js';
import { formatTeamEmoji, loadTeamEmojis } from '../coach/mockdraft.js';

const data = new SlashCommandBuilder()
  .setName('madden-matchuppicture')
  .setDescription('Show the current weekly matchup and strike picture (staff only).')
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

function recommendedLabel(projected = {}) {
  const label = projected?.recommended?.label;
  return label ? `Recommended: ${label}` : null;
}

function weeklyButtonLabel(entry) {
  if (!entry) return 'Review matchup';
  const away = entry.info?.awayTeam || 'Away';
  const home = entry.info?.homeTeam || 'Home';
  const recType = String(entry?.projected?.recommended?.type || 'unknown');
  const actionable = ['fair_sim', 'force_win_home', 'force_win_away', 'cpu'].includes(recType);
  if (actionable && String(entry?.status || 'pending') === 'pending') {
    return `Apply: ${away} vs ${home}`.slice(0, 80);
  }
  return `Review: ${away} vs ${home}`.slice(0, 80);
}

function outcomeLabel(entry) {
  const status = String(entry?.status || 'pending').toLowerCase();
  if (status !== 'pending') {
    // These status values map to the same labels used in the game status buttons handler.
    return `LOG ${statusLabel(status)}`;
  }
  const rec = entry?.projected?.recommended;
  if (rec?.type === 'no_strikes') {
    const state = String(entry?.participation?.conversationState || '').trim();
    if (state) return `REC OK (${state})`;
    return 'REC OK (talking)';
  }
  if (rec?.type === 'force_win_home') return `REC FW ${entry?.info?.homeTeam || 'Home'}`;
  if (rec?.type === 'force_win_away') return `REC FW ${entry?.info?.awayTeam || 'Away'}`;
  if (rec?.label) return `REC ${rec.label}`;
  if (entry?.projected?.strikeAway || entry?.projected?.strikeHome) return 'REC Determined';
  return 'REC Review';
}

function strikeMarker(entry) {
  if (String(entry?.status || 'pending').toLowerCase() !== 'pending') return '';
  const away = String(entry?.info?.awayTeam || 'Away').trim() || 'Away';
  const home = String(entry?.info?.homeTeam || 'Home').trim() || 'Home';

  // Determined strike projection (silence-based).
  const a = Boolean(entry?.projected?.strikeAway);
  const h = Boolean(entry?.projected?.strikeHome);
  if (a || h) {
    if (a && h) return ` [S:${away}+${home}]`;
    if (a) return ` [S:${away}]`;
    return ` [S:${home}]`;
  }

  // If the recommendation is a force win, the implied non-play strike is typically on the losing side.
  const recType = String(entry?.projected?.recommended?.type || '').toLowerCase();
  if (recType === 'force_win_home') return ` [S:${away}]`;
  if (recType === 'force_win_away') return ` [S:${home}]`;

  return '';
}

function safeThreadMention(threadId) {
  const id = String(threadId || '');
  if (!/^[0-9]{6,20}$/.test(id)) return '';
  return ` <#${id}>`;
}

function clampLinesToEmbed(lines, maxChars = 1024) {
  const output = [];
  let total = 0;
  for (const line of lines) {
    const next = (output.length ? 1 : 0) + line.length;
    if (total + next > maxChars) break;
    output.push(line);
    total += next;
  }
  return output;
}

function chunkLines(lines, maxChars = 1024) {
  const chunks = [];
  let current = [];
  let total = 0;

  for (const line of lines) {
    const next = (current.length ? 1 : 0) + line.length;
    if (current.length && total + next > maxChars) {
      chunks.push(current);
      current = [];
      total = 0;
    }
    current.push(line);
    total += (current.length > 1 ? 1 : 0) + line.length;
  }

  if (current.length) chunks.push(current);
  return chunks;
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

function resolveEmojiKey(teamName = '') {
  const raw = String(teamName || '').trim();
  const norm = normalizeName(raw);
  const aliasMap = {
    niners: '49ers',
    fourtyniners: '49ers',
    fortyniners: '49ers',
    forty9ers: '49ers',
    fourty9ers: '49ers',
    sf: '49ers',
    sanfrancisco: '49ers',
    // keep canonical too
    '49ers': '49ers',

    pats: 'Patriots',
    patriots: 'Patriots',

    jags: 'Jaguars',
    jaguars: 'Jaguars',

    bucs: 'Buccaneers',
    buccaneers: 'Buccaneers',

    fins: 'Dolphins',
    phins: 'Dolphins',
    dolphins: 'Dolphins',

    commies: 'Commanders',
    commanders: 'Commanders',

    bolts: 'Chargers',
    chargers: 'Chargers',

    hawks: 'Seahawks',
    seahawks: 'Seahawks',
  };
  return aliasMap[norm] || raw;
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

// NOTE: matchuppicture uses shared collectParticipation() from madden_thread_notifier
// so its strike picture lines up exactly with the notifier’s “Determined Strike Outcome” embed.

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
      // Hydrate can be async (it may fetch starter message to infer deadlineAt), so await it.
      const infoHydrated = await hydrateThreadStateFromLiveThread(thread, storedInfo).catch(() => null);
      const info = infoHydrated || storedInfo;

      // Be forgiving when stored seasonKey/weekIndex are missing; fall back to inferred values.
      // (Older registrations sometimes omitted these, which would otherwise filter everything out.)
      const effectiveSeasonKey = info?.seasonKey || seasonKey;
      if (effectiveSeasonKey !== seasonKey) continue;
      diagnostics.currentSeason += 1;

      const inferredWeekIndex = Number.isFinite(Number(info?.weekIndex))
        ? Number(info.weekIndex)
        : parseWeekIndexFromThreadName(thread.name || '');
      if (currentWeekIndex != null && inferredWeekIndex != null && inferredWeekIndex !== currentWeekIndex) continue;
      diagnostics.currentWeek += 1;
      candidateInfos.push({
        info: {
          ...info,
          seasonKey: effectiveSeasonKey,
          weekIndex: Number.isFinite(Number(info?.weekIndex)) ? Number(info.weekIndex) : inferredWeekIndex,
        },
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
    // Participation is collected using the shared logic from the notifier module.
    const participationStartedAt = Date.now();
    for (const baseEntry of candidateInfos) {
      const participation = await collectParticipation(baseEntry.thread, baseEntry.info);
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

    // Always show the toddler-simple outcome board privately, with one Apply All button.
    const emojiMap = loadTeamEmojis();
    const outcomeLines = entries.map((entry, idx) => {
      const away = entry.info?.awayTeam || 'Away';
      const home = entry.info?.homeTeam || 'Home';
      const threadId = entry.info?.threadId;
      const awayEmoji = formatTeamEmoji(resolveEmojiKey(away), emojiMap);
      const homeEmoji = formatTeamEmoji(resolveEmojiKey(home), emojiMap);
      const n = String(idx + 1).padStart(2, '0');
      const left = `${awayEmoji ? `${awayEmoji} ` : ''}${away}`;
      const right = `${homeEmoji ? `${homeEmoji} ` : ''}${home}`;
      return `${n}. ${left} @ ${right} — ${outcomeLabel(entry)}${strikeMarker(entry)}${safeThreadMention(threadId)}`;
    });

    const outcomeChunks = chunkLines(outcomeLines);

    const baseBoardEmbed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`Outcome Board${currentWeek > 0 ? ` - Week ${currentWeek}` : ''}`)
      .setDescription(`Games: ${entries.length} • Determined-risk: ${determinedEntries.length} • Silent-side: ${silentEntries.length}`)
      .setTimestamp();

    // Discord limits per embed:
    // - 25 fields per embed
    // - 1024 chars per field value
    // We'll split "Every game" across multiple fields, and if we exceed 25 fields we spill into a second embed.
    const embeds = [baseBoardEmbed];

    const fieldSets = [];
    let remaining = [...outcomeChunks];
    while (remaining.length) {
      fieldSets.push(remaining.splice(0, 25));
    }

    fieldSets.forEach((chunkSet, embedIdx) => {
      const embed = embedIdx === 0
        ? embeds[0]
        : new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle(`Outcome Board (cont.)${currentWeek > 0 ? ` - Week ${currentWeek}` : ''}`)
          .setTimestamp();

      chunkSet.forEach((chunk, idx) => {
        const label = chunkSet.length === 1
          ? 'Every game'
          : (idx === 0 ? 'Every game' : '…');
        embed.addFields({
          name: label,
          value: chunk.join('\n') || '—',
        });
      });

      if (embedIdx > 0) embeds.push(embed);
    });

    const applyAllButton = new ButtonBuilder()
      .setCustomId(`madden_apply_all_week|${seasonKey}|${currentWeekIndex != null ? String(currentWeekIndex) : 'unknown'}`)
      .setLabel('APPLY ALL (confirm)')
      .setStyle(ButtonStyle.Danger);

    await interaction.editReply({
      embeds,
      components: [new ActionRowBuilder().addComponents(applyAllButton)],
    });
  } catch (e) {
    await interaction.editReply({ content: `Weekly picture failed: ${e?.message || e}` });
  }
}

export default { data, execute };
