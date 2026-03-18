import fs from 'fs';
import path from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffDecision } from './madden_staff_ops.js';
import { sendCoachReceipt } from './madden_coach_receipts.js';
import { getMaddenSnapshotContext, loadMaddenChannelMap } from './madden_metadata.js';

const STATE_FILE = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const COMMISH_ROLE_IDS = ['1460399404241522759', '1460399405436768431'];

function normalizeName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teamAliasKeys(label = '') {
  const normalized = normalizeName(label);
  const aliases = new Set([normalized]);
  const aliasMap = {
    niners: ['49ers', 'san francisco 49ers', 'sf 49ers', 'sanfrancisco49ers'],
    '49ers': ['niners', 'san francisco 49ers', 'sf 49ers', 'sanfrancisco49ers'],
    broncos: ['denver broncos'],
    patriots: ['new england patriots'],
    cardinals: ['arizona cardinals'],
    cowboys: ['dallas cowboys'],
    steelers: ['pittsburgh steelers'],
    browns: ['cleveland browns'],
    saints: ['new orleans saints'],
    packers: ['green bay packers'],
    raiders: ['las vegas raiders'],
    chargers: ['los angeles chargers'],
  };
  for (const alias of aliasMap[normalized] || []) aliases.add(normalizeName(alias));
  return [...aliases];
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
    for (const key of [full, display, nick, team?.abbrName].flatMap(teamAliasKeys).filter(Boolean)) {
      map.set(key, status);
    }
  }
  return map;
}

function coachStatusForTeam(teamName, coachStatusByTeam) {
  for (const key of teamAliasKeys(teamName)) {
    if (coachStatusByTeam.has(key)) return coachStatusByTeam.get(key);
  }
  return 'unknown';
}

function getCoachRoleIdForTeam(label, roleMap) {
  const targets = teamAliasKeys(label);
  if (!targets.length) return null;
  for (const [roleName, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(roleName)) continue;
    const base = roleName.replace(/ coach$/i, '').trim();
    if (targets.includes(normalizeName(base))) return roleId;
  }
  return null;
}

function parseRoleIdsFromMention(mention = '') {
  return [...new Set(String(mention).match(/\d{6,}/g) || [])].filter((id) => !COMMISH_ROLE_IDS.includes(id));
}

function parseThreadTeams(threadName = '') {
  const matchupLabel = String(threadName).split(/\s+-\s+/)[0] || '';
  const [awayRaw, homeRaw] = matchupLabel.split(/\s+vs\s+/i);
  const awayTeam = (awayRaw || '').trim() || null;
  const homeTeam = (homeRaw || '').trim() || null;
  return { awayTeam, homeTeam };
}

function parseWeekIndex(threadName = '') {
  const match = String(threadName).match(/\b(?:week|w)\s*\.?\s*(\d+)\b/i);
  if (!match) return null;
  const weekNumber = Number(match[1]);
  return Number.isFinite(weekNumber) && weekNumber > 0 ? weekNumber - 1 : null;
}

function parseDeadlineFromText(text = '') {
  const match = String(text || '').match(/\bDeadline\s*:?\s*<t:(\d{9,})\b/i);
  if (!match) return null;
  const sec = Number(match[1]);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return sec * 1000;
}

function saveThreadState() {
  saveState(state);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { threads: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function coachUserIds(guild, roleIds = [], candidateUserIds = []) {
  const users = new Set();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    role.members?.forEach((m) => users.add(m.id));
  }
  return [...users];
}

function analyzeThreadConversation(messages = [], awayUsers = new Set(), homeUsers = new Set()) {
  const allHumanMessages = messages
    .filter((message) => !message.author?.bot)
    .map((message) => {
      const authorId = String(message.author?.id || '');
      const text = String(message.content || '').trim();
      const lower = text.toLowerCase();
      const side = awayUsers.has(authorId) ? 'away' : (homeUsers.has(authorId) ? 'home' : 'other');
      return { authorId, side, text, lower, createdAt: Number(message.createdTimestamp || 0) };
    })
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-20);

  const coachMessages = allHumanMessages
    .filter((message) => message.side !== 'other' && message.text)
    .slice(-12);
  const participantMessages = allHumanMessages.filter((message) => message.text).slice(-12);

  const tags = new Set();
  const sidesTalking = new Set();
  const participantIds = new Set();
  let explicitTimeMentions = 0;
  let availabilityMentions = 0;
  let replyChecks = 0;
  for (const message of participantMessages) {
    const lower = message.lower;
    participantIds.add(message.authorId);
    if (message.side !== 'other') sidesTalking.add(message.side);
    if (/\b(cpu|computer)\b/.test(lower)) tags.add('cpu_reference');
    if (/\b(gg|ggs|good game|game ?(done|finished|over)|we played|we finished|final score)\b/.test(lower)) {
      tags.add('game_complete_signal');
    }
    if (/\b(\d{1,2}\s?(am|pm|est|cst|pst|mst)|\d{1,2}:\d{2}|at \d{1,2}|around \d{1,2}|after \d{1,2}|all day|morning|afternoon|evening)\b/.test(lower)) explicitTimeMentions += 1;
    if (/\b(can play|i can play|free at|free after|available at|available after|tonight|tomorrow|tmr|today at|later tonight|later today|all day|morning works|afternoon works|good to run)\b/.test(lower)) {
      tags.add('time_proposed');
      availabilityMentions += 1;
    }
    if (/\b(resched|reschedule|push it|push to|move it to|later works|tomorrow works|lets do tomorrow|let's do tomorrow|feel better|too sick|cant breathe|can't breathe)\b/.test(lower)) {
      tags.add('reschedule');
    }
    if (/\b(lmk|let me know|you there|checking in|any update|what time works|still good\??|still on\??|does .* work\??|can you do)\b/.test(lower)) {
      tags.add('waiting_on_reply');
      replyChecks += 1;
    }
    if (/\b(can'?t connect|server issue|servers|desync|lagged out|invite failed|connection|disconnect)\b/.test(lower)) {
      tags.add('connection_issue');
    }
    if (/\b(weird|dash|get him out of here|stop being weird|as fuck|weird asf)\b/.test(lower)) {
      tags.add('off_topic_conflict');
    }
    if (/\b(stream|you need to stream)\b/.test(lower)) {
      tags.add('stream_followup');
    }
  }
  const bothSidesTalking = sidesTalking.has('away') && sidesTalking.has('home');
  const activeBackAndForth = participantIds.size >= 2 && participantMessages.length >= 2;
  const tomorrowScheduled = activeBackAndForth && participantMessages.some((message) => /\b(tomorrow|tmr)\b/.test(message.lower));
  if (tomorrowScheduled) tags.add('scheduled_next_day');
  const lockedTimeLikely = activeBackAndForth && explicitTimeMentions >= 2;
  if (lockedTimeLikely) tags.add('locked_time');
  const softAvailabilityOnly = activeBackAndForth && availabilityMentions > 0 && explicitTimeMentions === 0;
  if (softAvailabilityOnly) tags.add('soft_availability');
  const oneSideCarrying = (sidesTalking.size === 1 && participantIds.size === 1) || (replyChecks > 0 && !bothSidesTalking);
  if (oneSideCarrying) tags.add('one_side_carrying');
  if (activeBackAndForth) tags.add('active_thread');

  let state = 'generic';
  if (tags.has('game_complete_signal')) state = 'game_complete_signal';
  else if (tags.has('off_topic_conflict')) state = 'off_topic_conflict';
  else if (tags.has('cpu_reference')) state = 'cpu_reference';
  else if (tags.has('connection_issue')) state = 'connection_issue';
  else if (tags.has('locked_time')) state = 'locked_time';
  else if (tags.has('scheduled_next_day')) state = 'scheduled_next_day';
  else if (tags.has('reschedule')) state = 'reschedule';
  else if (tags.has('soft_availability')) state = 'soft_availability';
  else if (tags.has('time_proposed') && tags.has('waiting_on_reply')) state = 'time_proposed_waiting';
  else if (tags.has('time_proposed')) state = 'time_proposed';
  else if (tags.has('waiting_on_reply')) state = 'waiting_on_reply';
  else if (tags.has('one_side_carrying')) state = 'one_side_carrying';

  return {
    state,
    tags: [...tags],
    recentSample: participantMessages.slice(-3).map((message) => message.text).join(' | '),
    activeBackAndForth,
    participantCount: participantIds.size,
    recognizedCoachConversation: bothSidesTalking || sidesTalking.size === 1,
  };
}

export async function collectParticipation(thread, info) {
  const hydratedInfo = await hydrateThreadStateFromLiveThread(thread, info) || info || {};
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
      awayLastAt: null,
      homeLastAt: null,
      awayFirstAt: null,
      homeFirstAt: null,
      conversationState: 'unknown',
      conversationTags: [],
      recentCoachSample: '',
      activeBackAndForth: false,
      participantCount: 0,
    };
  }
  const messageList = [...messages.values()];
  const awayRoleIds = new Set((hydratedInfo.awayRoleIds || []).map((id) => String(id)));
  const homeRoleIds = new Set((hydratedInfo.homeRoleIds || []).map((id) => String(id)));
  const awayUsers = new Set(await coachUserIds(thread.guild, hydratedInfo.awayRoleIds || []));
  const homeUsers = new Set(await coachUserIds(thread.guild, hydratedInfo.homeRoleIds || []));
  let awayCount = 0;
  let homeCount = 0;
  let awayAfterReminder = 0;
  let homeAfterReminder = 0;
  let awayLastAt = null;
  let homeLastAt = null;
  let awayFirstAt = null;
  let homeFirstAt = null;
  const awayResponderIds = new Set();
  const homeResponderIds = new Set();
  const reminderCutoff = Number(hydratedInfo.lastReminder || 0);
  for (const message of messages.values()) {
    if (message.author?.bot) continue;
    const createdAt = message.createdTimestamp || 0;
    const memberRoleIds = new Set(message.member?.roles?.cache?.map((role) => String(role.id)) || []);
    const isAway = awayUsers.has(message.author.id) || [...awayRoleIds].some((roleId) => memberRoleIds.has(roleId));
    const isHome = homeUsers.has(message.author.id) || [...homeRoleIds].some((roleId) => memberRoleIds.has(roleId));
    if (isAway) {
      awayCount += 1;
      awayResponderIds.add(String(message.author.id));
      awayUsers.add(String(message.author.id));
      if (createdAt > reminderCutoff) awayAfterReminder += 1;
      if (!awayFirstAt || createdAt < awayFirstAt) awayFirstAt = createdAt;
      if (!awayLastAt || createdAt > awayLastAt) awayLastAt = createdAt;
    }
    if (isHome) {
      homeCount += 1;
      homeResponderIds.add(String(message.author.id));
      homeUsers.add(String(message.author.id));
      if (createdAt > reminderCutoff) homeAfterReminder += 1;
      if (!homeFirstAt || createdAt < homeFirstAt) homeFirstAt = createdAt;
      if (!homeLastAt || createdAt > homeLastAt) homeLastAt = createdAt;
    }
  }
  const conversation = analyzeThreadConversation(messageList, awayUsers, homeUsers);
  return {
    awayCount,
    homeCount,
    totalCoachMessages: awayCount + homeCount,
    awayResponderIds: [...awayResponderIds],
    homeResponderIds: [...homeResponderIds],
    awayUsers: [...awayUsers],
    homeUsers: [...homeUsers],
    awayAfterReminder,
    homeAfterReminder,
    awayLastAt,
    homeLastAt,
    awayFirstAt,
    homeFirstAt,
    conversationState: conversation.state,
    conversationTags: conversation.tags,
    recentCoachSample: conversation.recentSample,
    activeBackAndForth: Boolean(conversation.activeBackAndForth),
    participantCount: Number(conversation.participantCount || 0),
  };
}

function buildCoachMention(info) {
  const roleIds = [...new Set([...(info.awayRoleIds || []), ...(info.homeRoleIds || [])].filter(Boolean))];
  return roleIds.map((id) => `<@&${id}>`).join(' ');
}

function matchupCoachState(info = {}) {
  const awayHasCoach = info.awayCoachStatus
    ? info.awayCoachStatus === 'coach'
    : (Array.isArray(info.awayRoleIds) && info.awayRoleIds.length > 0);
  const homeHasCoach = info.homeCoachStatus
    ? info.homeCoachStatus === 'coach'
    : (Array.isArray(info.homeRoleIds) && info.homeRoleIds.length > 0);
  if (awayHasCoach && homeHasCoach) return 'coach_both';
  if (awayHasCoach || homeHasCoach) return 'cpu_one';
  return 'cpu_both';
}

function buildCoachAndStaffMention(info) {
  const coachMention = buildCoachMention(info);
  const staffMention = COMMISH_ROLE_IDS.map((id) => `<@&${id}>`).join(' ');
  return [coachMention, staffMention].filter(Boolean).join(' ');
}

function buildTailoredReminder(threadInfo, participation, now = Date.now()) {
  const awayTeam = threadInfo.awayTeam || 'Away';
  const homeTeam = threadInfo.homeTeam || 'Home';
  const deadlineAt = Number(threadInfo.deadlineAt || 0);
  const timeToDeadline = deadlineAt ? Math.max(0, deadlineAt - now) : null;
  const coachState = matchupCoachState(threadInfo);
  const bothSilent = participation.awayCount === 0 && participation.homeCount === 0;
  const awaySilent = participation.awayCount === 0;
  const homeSilent = participation.homeCount === 0;
  const bothTalking = participation.awayCount > 0 && participation.homeCount > 0;

  if (coachState !== 'coach_both') {
    if (timeToDeadline != null && timeToDeadline <= SIX_HOURS) {
      const cpuContext =
        participation.conversationState === 'game_complete_signal'
          ? 'The thread reads like the game may already be done.'
          : participation.conversationState === 'cpu_reference'
            ? 'The thread already reads like a CPU matchup.'
            : 'This matchup still needs to be closed out.';
      return {
        key: 'cpu_outcome_needed',
        mention: buildCoachMention(threadInfo),
        content: `${buildCoachMention(threadInfo)} ${cpuContext} If it was a CPU game, log it with the CPU button. If it was played, make sure the correct outcome button is used before deadline.`,
      };
    }
    return null;
  }

  if (bothSilent) {
    if (participation.activeBackAndForth || participation.participantCount >= 2) {
      return {
        key: 'active_unmapped',
        mention: buildCoachMention(threadInfo),
        content: `${buildCoachMention(threadInfo)} This thread has activity in it, but the coach-side scheduling picture is still not clean enough to leave alone. Keep the game plan clear in-thread, make sure both sides are set, and use the right outcome button once it is done.`,
      };
    }
    return {
      key: 'both_silent',
      mention: buildCoachMention(threadInfo),
      content: `${buildCoachMention(threadInfo)} No movement yet in this thread. ${awayTeam} and ${homeTeam} both need to get on the board, lock a time, and keep the thread clean before the deadline gets tight.`,
    };
  }

  if (awaySilent || homeSilent) {
    const targetRoleIds = awaySilent ? (threadInfo.awayRoleIds || []) : (threadInfo.homeRoleIds || []);
    const targetMention = targetRoleIds.map((id) => `<@&${id}>`).join(' ');
    const activeTeam = awaySilent ? homeTeam : awayTeam;
    const silentTeam = awaySilent ? awayTeam : homeTeam;
    const contextLine =
      participation.conversationState === 'time_proposed_waiting'
        ? ` A time looks like it was already put on the table by ${activeTeam}; ${silentTeam} need to answer it here.`
        : participation.conversationState === 'waiting_on_reply'
          ? ` The thread already reads like ${activeTeam} are waiting on an answer.`
          : participation.conversationState === 'scheduled_next_day'
            ? ` The thread reads like tomorrow is already the working plan, so the main thing now is making sure ${silentTeam} confirms cleanly and the game gets closed before sim.`
            : participation.conversationState === 'one_side_carrying'
              ? ` The thread reads like ${activeTeam} are doing the scheduling work and still need a clear answer back.`
              : '';
    return {
      key: awaySilent ? 'away_silent' : 'home_silent',
      mention: targetMention,
      content: `${targetMention} ${activeTeam} already have thread activity in. ${silentTeam} still need to answer here so the game plan and timing are both on record before this turns into a deadline problem.${contextLine}`,
    };
  }

  if (bothTalking && timeToDeadline != null && timeToDeadline <= SIX_HOURS) {
    const contextLine =
      participation.conversationState === 'game_complete_signal'
        ? ' The thread reads like the game may already be finished, so this is mainly an outcome-button reminder.'
        : participation.conversationState === 'locked_time'
          ? ' The thread reads like both sides already have a real time on the table, so this is just a reminder to finish it and close the thread cleanly.'
          : participation.conversationState === 'scheduled_next_day'
            ? ' The thread reads like both sides already pushed this to tomorrow, so this is just a gentle nudge to get it played and closed before sim.'
            : participation.conversationState === 'time_proposed'
              ? ' A time looks like it has already been proposed, so the next step is either play it or lock the reschedule cleanly.'
              : participation.conversationState === 'reschedule'
                ? ' The thread reads like a reschedule is in progress, so make sure the final time lands clearly in-thread.'
                : participation.conversationState === 'soft_availability'
                  ? ' The thread has availability talk in it, but it still needs a locked time and a clean finish.'
                  : participation.conversationState === 'connection_issue'
                    ? ' The thread reads like connection/setup friction may be part of the delay, so keep the status clear here.'
                    : '';
    return {
      key: 'outcome_needed',
      mention: buildCoachMention(threadInfo),
      content: `${buildCoachMention(threadInfo)} This thread has communication, but it still needs the finish. Get the game played and make sure one outcome button is used before the deadline closes in.${contextLine}`,
    };
  }

  if (bothTalking && participation.conversationState === 'scheduled_next_day') {
    return {
      key: 'scheduled_next_day_followthrough',
      mention: buildCoachMention(threadInfo),
      content: `${buildCoachMention(threadInfo)} This thread reads like both sides already have tomorrow lined up. Make sure the game gets played before sim, keep any time updates in here, and press the right outcome button as soon as it is done.`,
    };
  }

  return null;
}

export function buildProjectedOutcome(info, participation) {
  const coachState = matchupCoachState(info);
  if (coachState !== 'coach_both') {
    return {
      reason: 'CPU matchup or missing coach assignment. No determined strike language should apply here.',
      lines: ['No determined strikes: this thread should be closed with the correct game outcome instead.'],
      recommended: {
        type: 'cpu',
        label: 'CPU',
        guidance: 'Use the CPU button (or log the played result) to close the thread.',
      },
      strikeAway: false,
      strikeHome: false,
    };
  }
  const awaySilent = participation.awayCount === 0;
  const homeSilent = participation.homeCount === 0;
  const bothCommunicated = participation.awayCount > 0 && participation.homeCount > 0;

  // Fairness-first: if both coaches have communicated or the thread shows real scheduling evidence,
  // do not attribute determined strikes from the reminder alone. Push toward outcome-button closure.
  const schedulingEvidence =
    participation?.activeBackAndForth ||
    ['locked_time', 'scheduled_next_day', 'time_proposed', 'time_proposed_waiting', 'reschedule', 'soft_availability', 'connection_issue'].includes(participation?.conversationState);
  if (bothCommunicated || schedulingEvidence) {
    return {
      reason: 'Both coaches have communicated or the thread shows scheduling progress, but no outcome button has been recorded.',
      lines: ['No determined strikes right now. Finish the game (or log CPU/Fair Sim/forfeit) and press the correct outcome button before deadline.'],
      recommended: {
        type: 'no_strikes',
        label: 'No determined strikes (communication exists)',
        guidance: 'This thread should be closed via an outcome button (Completed / FW / Fair Sim / CPU). Determined strikes are not recommended based on the thread evidence.',
      },
      strikeAway: false,
      strikeHome: false,
    };
  }

  // True nonresponse scenarios only.
  const strikeAway = awaySilent;
  const strikeHome = homeSilent;
  const lines = [];
  if (awaySilent) lines.push(`${info.awayTeam || 'Away'} determined strike.`);
  if (homeSilent) lines.push(`${info.homeTeam || 'Home'} determined strike.`);
  if (!lines.length) lines.push('No determined strikes.');

  const recommended = (() => {
    if (strikeAway && strikeHome) {
      return {
        type: 'fair_sim',
        label: 'Fair Sim (recommended)',
        guidance: 'Both sides appear non-responsive. If no outcome is logged, the fairest default is typically a Fair Sim. If your league policy differs, override accordingly.',
      };
    }
    if (strikeAway && !strikeHome) {
      return {
        type: 'force_win_home',
        label: `FW ${info.homeTeam || 'Home'} (recommended)`,
        guidance: `Home appears responsive while ${info.awayTeam || 'Away'} is silent. Recommend a force win for ${info.homeTeam || 'Home'} and a non-play strike to ${info.awayTeam || 'Away'}.`,
      };
    }
    if (!strikeAway && strikeHome) {
      return {
        type: 'force_win_away',
        label: `FW ${info.awayTeam || 'Away'} (recommended)`,
        guidance: `Away appears responsive while ${info.homeTeam || 'Home'} is silent. Recommend a force win for ${info.awayTeam || 'Away'} and a non-play strike to ${info.homeTeam || 'Home'}.`,
      };
    }
    return {
      type: 'unknown',
      label: 'Outcome unknown',
      guidance: 'Use the correct outcome button (Completed / FW / Fair Sim / CPU) based on what actually happened in the matchup.',
    };
  })();

  const reason = awaySilent && homeSilent
    ? 'No coach communication logged in the thread and no outcome button has been used.'
    : awaySilent || homeSilent
      ? 'One side has not communicated in the thread and no outcome button has been used.'
      : 'Thread needs an outcome button.';
  return { reason, lines, recommended, strikeAway, strikeHome };
}

const state = loadState();

function retirePendingThread(threadId, status = 'ignored', note = '') {
  if (!state.threads?.[threadId]) return;
  state.threads[threadId] = {
    ...state.threads[threadId],
    status,
    reminderNote: note || state.threads[threadId].reminderNote || null,
  };
}

function persistThreadRuntimeState(threadId, patch = {}) {
  if (!threadId || !patch || typeof patch !== 'object') return null;
  state.threads = state.threads || {};
  const current = state.threads[threadId] || { threadId, status: 'pending', created: Date.now(), lastReminder: Date.now() };
  state.threads[threadId] = {
    ...current,
    ...patch,
    threadId,
  };
  return state.threads[threadId];
}

function consumeStartupReminderBackfillFlag() {
  state.meta = state.meta || {};
  const shouldRun = state.meta.startupReminderBackfillOnce !== false;
  state.meta.startupReminderBackfillOnce = false;
  saveState(state);
  return shouldRun;
}

export function scheduleStartupReminderBackfillOnce() {
  state.meta = state.meta || {};
  state.meta.startupReminderBackfillOnce = true;
  saveState(state);
}

function seedStartupReminderBackfillFlagOnce() {
  state.meta = state.meta || {};
  if (!Object.prototype.hasOwnProperty.call(state.meta, 'startupReminderBackfillOnce')) {
    state.meta.startupReminderBackfillOnce = true;
    saveState(state);
  }
}

function logNotifierDecision({ enabled = false, threadId, info, participation, decision, reason, extra = {} }) {
  if (!enabled) return;
  console.log('[madden-thread-reminder]', {
    threadId,
    matchup: `${info?.awayTeam || 'Away'} vs ${info?.homeTeam || 'Home'}`,
    coachState: matchupCoachState(info || {}),
    conversationState: participation?.conversationState || 'unknown',
    awayCount: participation?.awayCount ?? null,
    homeCount: participation?.homeCount ?? null,
    decision,
    reason,
    ...extra,
  });
}

function runReminderSideEffects(tasks = []) {
  for (const task of tasks) {
    Promise.resolve()
      .then(() => task?.())
      .catch(() => null);
  }
}

async function buildLiveStartupThreadEntries(client, { debugDecisions = false } = {}) {
  const channelMap = loadMaddenChannelMap();
  const gameThreadsChannelId = channelMap['Game threads'] || null;
  if (!gameThreadsChannelId) return Object.entries(state.threads || {});
  const channel = await client.channels.fetch(gameThreadsChannelId).catch(() => null);
  if (!channel?.threads?.fetchActive) return Object.entries(state.threads || {});

  const active = await channel.threads.fetchActive().catch(() => null);
  const archived = channel.threads.fetchArchived
    ? await channel.threads.fetchArchived({ limit: 100 }).catch(() => null)
    : null;
  const liveThreads = [
    ...(active?.threads ? [...active.threads.values()] : []),
    ...(archived?.threads ? [...archived.threads.values()] : []),
  ];

  const liveEntries = [];
  if (debugDecisions) {
    console.log('[madden-thread-reminder] startup_live_scan', {
      channelId: gameThreadsChannelId,
      activeThreads: active?.threads?.size || 0,
      archivedThreads: archived?.threads?.size || 0,
      totalLiveThreads: liveThreads.length,
    });
  }
  for (const thread of liveThreads) {
    const threadId = String(thread.id);
    const existing = state.threads?.[threadId] || { threadId, status: 'pending' };
    if (existing.status && existing.status !== 'pending') continue;
    const hydrated = await hydrateThreadStateFromLiveThread(thread, existing) || existing;
    const context = getMaddenSnapshotContext(thread.guildId, { leagueId: hydrated.leagueId || null }) || null;
    const currentWeekIndex = Number.isFinite(Number(context?.weekIndex)) ? Number(context.weekIndex) : null;
    const threadWeekIndex = Number.isFinite(Number(hydrated.weekIndex)) ? Number(hydrated.weekIndex) : null;
    if (debugDecisions) {
      console.log('[madden-thread-reminder] startup_live_candidate', {
        threadId,
        matchup: `${hydrated.awayTeam || 'Away'} vs ${hydrated.homeTeam || 'Home'}`,
        status: existing.status || 'pending',
        currentWeekIndex,
        threadWeekIndex,
        included: !(currentWeekIndex != null && threadWeekIndex != null && threadWeekIndex !== currentWeekIndex),
      });
    }
    if (currentWeekIndex != null && threadWeekIndex != null && threadWeekIndex !== currentWeekIndex) continue;
    liveEntries.push([threadId, {
      ...existing,
      ...hydrated,
      threadId,
      status: existing.status || 'pending',
    }]);
  }
  return liveEntries;
}

export async function runNotifierCycle(client, { forceImmediate = false, debugDecisions = false } = {}) {
  const now = Date.now();
  const entries = forceImmediate
    ? await buildLiveStartupThreadEntries(client, { debugDecisions })
    : Object.entries(state.threads || {});
  const entryList = Array.isArray(entries) ? [...entries] : [];
  if (debugDecisions) {
    console.log('[madden-thread-reminder] loop_entries', {
      forceImmediate,
      count: entryList.length,
      threadIds: entryList.map(([threadId]) => threadId),
    });
  }
  for (const [threadId, info] of entryList) {
    try {
      if (debugDecisions) {
        console.log('[madden-thread-reminder] loop_start', {
          threadId,
          matchup: `${info?.awayTeam || 'Away'} vs ${info?.homeTeam || 'Home'}`,
          status: info?.status || 'pending',
        });
      }
      if (info.status !== 'pending') continue;
      const deadlineAt = Number(info.deadlineAt || 0);
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread || !thread.isTextBased()) {
        retirePendingThread(threadId, 'ignored', 'Thread not accessible');
        logNotifierDecision({ enabled: debugDecisions, threadId, info, decision: 'skip', reason: 'thread_not_accessible' });
        continue;
      }
      const hydratedInfo = await hydrateThreadStateFromLiveThread(thread, info) || info;
      const trackedInfo = persistThreadRuntimeState(threadId, {
        ...hydratedInfo,
        status: hydratedInfo.status || 'pending',
      }) || hydratedInfo;
      const context = getMaddenSnapshotContext(thread.guildId, { leagueId: hydratedInfo.leagueId || null }) || null;
      const coachState = matchupCoachState(trackedInfo);
      const currentWeekIndex = Number.isFinite(Number(context?.weekIndex)) ? Number(context.weekIndex) : null;
      const threadWeekIndex = Number.isFinite(Number(trackedInfo.weekIndex)) ? Number(trackedInfo.weekIndex) : null;
      const missingMatchupMetadata =
        !trackedInfo.awayTeam ||
        !trackedInfo.homeTeam ||
        (coachState === 'coach_both' && (
          !Array.isArray(trackedInfo.awayRoleIds) ||
          !Array.isArray(trackedInfo.homeRoleIds) ||
          trackedInfo.awayRoleIds.length === 0 ||
          trackedInfo.homeRoleIds.length === 0
        )) ||
        (coachState === 'cpu_one' && (
          (trackedInfo.awayCoachStatus === 'coach' && (!Array.isArray(trackedInfo.awayRoleIds) || trackedInfo.awayRoleIds.length === 0)) ||
          (trackedInfo.homeCoachStatus === 'coach' && (!Array.isArray(trackedInfo.homeRoleIds) || trackedInfo.homeRoleIds.length === 0))
        ));
      if (missingMatchupMetadata && now - Number(trackedInfo.created || info.created || now) >= TWENTY_FOUR_HOURS) {
        retirePendingThread(threadId, 'ignored', 'Missing matchup metadata');
        logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, decision: 'skip', reason: 'missing_matchup_metadata' });
        continue;
      }
      if (
        currentWeekIndex != null &&
        threadWeekIndex != null &&
        threadWeekIndex < currentWeekIndex
      ) {
        retirePendingThread(threadId, 'ignored', 'Past week pending thread');
        logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, decision: 'skip', reason: 'past_week_pending_thread', extra: { currentWeekIndex, threadWeekIndex } });
        continue;
      }
      const participation = await collectParticipation(thread, trackedInfo);
      const createdAt = Number.isFinite(Number(trackedInfo.created))
        ? Number(trackedInfo.created)
        : (Number.isFinite(Number(info.created)) ? Number(info.created) : 0);
      const sinceCreated = now - createdAt;
      if (!trackedInfo.warnedCompletionPromptAt && participation.conversationState === 'game_complete_signal') {
        const coachMention = buildCoachMention(trackedInfo);
        await thread.send({
          content: coachMention || '',
          embeds: [{
            title: 'Game Sounds Finished',
            description: [
              'This thread reads like the game may already be done.',
              '',
              'If the game is finished, press the correct outcome button now so the matchup closes cleanly and the league record stays current.',
            ].join('\n'),
            color: 0x57F287,
            timestamp: new Date().toISOString(),
          }],
          allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
        }).catch(() => { });
        persistThreadRuntimeState(threadId, { warnedCompletionPromptAt: now });
        try {
          appendMaddenStaffLog({
            type: 'game_complete_prompt',
            guildId: thread.guildId,
            threadId,
            awayTeam: trackedInfo.awayTeam,
            homeTeam: trackedInfo.homeTeam,
            recentCoachSample: participation.recentCoachSample || null,
          });
        } catch { }
        logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, participation, decision: 'sent', reason: 'game_complete_prompt' });
      }
      if (!trackedInfo.warnedTwentyFourAt && sinceCreated >= TWENTY_FOUR_HOURS) {
        const shouldUseStrikePicture =
          coachState === 'coach_both' &&
          !participation.activeBackAndForth &&
          !['game_complete_signal', 'scheduled_next_day', 'locked_time', 'soft_availability', 'connection_issue', 'off_topic_conflict'].includes(participation.conversationState) &&
          (participation.awayCount === 0 || participation.homeCount === 0);
        if (coachState !== 'coach_both') {
          const coachMention = buildCoachMention(trackedInfo);
          await thread.send({
            content: coachMention || '',
            embeds: [{
              title: '24-Hour Game Check',
              description: [
                'This matchup is still unresolved after 24 hours.',
                '',
                'If this is a CPU game, log it with the CPU button. If it was played, use the correct outcome button so the thread is closed before deadline.',
              ].join('\n'),
              color: 0x5865F2,
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
          }).catch(() => { });
          persistThreadRuntimeState(threadId, { warnedTwentyFourAt: now });
          try {
            appendMaddenStaffLog({
              type: 'twenty_four_hour_cpu_game_check',
              guildId: thread.guildId,
              threadId,
              awayTeam: trackedInfo.awayTeam,
              homeTeam: trackedInfo.homeTeam,
            });
          } catch { }
          logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, participation, decision: 'sent', reason: '24h_cpu_game_check' });
        } else if (shouldUseStrikePicture) {
          const coachMention = buildCoachMention(trackedInfo);
          const projected = buildProjectedOutcome(trackedInfo, participation);
          const silentSide = participation.awayCount === 0 && participation.homeCount === 0
            ? 'Both coaches still need to communicate.'
            : participation.awayCount === 0
              ? `${trackedInfo.awayTeam || 'Away'} has not communicated yet.`
              : `${trackedInfo.homeTeam || 'Home'} has not communicated yet.`;
          await thread.send({
            content: coachMention || '',
            embeds: [{
              title: '24-Hour Strike Picture',
              description: [
                silentSide,
                '',
                projected.reason,
                '',
                projected.lines.join('\n') || 'No determined strikes right now.',
                '',
                'This is the current strike picture. The thread still needs communication and a recorded outcome before deadline.',
              ].join('\n'),
              color: 0xFEE75C,
              fields: [
                { name: `${info.awayTeam || 'Away'} messages`, value: String(participation.awayCount), inline: true },
                { name: `${info.homeTeam || 'Home'} messages`, value: String(participation.homeCount), inline: true },
              ],
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
          }).catch(() => { });
          persistThreadRuntimeState(threadId, { warnedNoResponseAt: now, warnedTwentyFourAt: now });
          try {
            appendMaddenStaffLog({
              type: 'participation_risk',
              guildId: thread.guildId,
              threadId,
              awayTeam: trackedInfo.awayTeam,
              homeTeam: trackedInfo.homeTeam,
              awayCount: participation.awayCount,
              homeCount: participation.homeCount,
            });
          } catch { }
          const silentRoleIds =
            participation.awayCount === 0 && participation.homeCount === 0
              ? [...(trackedInfo.awayRoleIds || []), ...(trackedInfo.homeRoleIds || [])]
              : participation.awayCount === 0
                ? (trackedInfo.awayRoleIds || [])
                : (trackedInfo.homeRoleIds || []);
          runReminderSideEffects([
            () => sendCoachReceipt(thread.guild, silentRoleIds, {
              title: '24-Hour Strike Picture',
              description: `${trackedInfo.awayTeam || 'Away'} vs ${trackedInfo.homeTeam || 'Home'} has reached the 24-hour mark with no outcome recorded.`,
              fields: [
                { name: 'Current Picture', value: projected.lines.join('\n') || 'No determined strikes right now.' },
                { name: 'What This Means', value: 'You need to communicate in the thread and make sure one outcome button is used before deadline.' },
                { name: 'Thread', value: `<#${threadId}>` },
              ],
            }),
            () => postLeagueStaffOpsSnapshot(client, thread.guildId, '24-hour participation risk'),
          ]);
          logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, participation, decision: 'sent', reason: '24h_strike_picture' });
        } else {
          const coachMention = buildCoachMention(trackedInfo);
          const contextLine =
            participation.conversationState === 'scheduled_next_day'
              ? ' The thread reads like both sides already have tomorrow in mind, so this is just a gentle check to make sure it gets done before sim.'
              : participation.conversationState === 'reschedule'
                ? ' The thread reads like a reschedule is in progress, so make sure the final time stays clear in the thread.'
                : participation.conversationState === 'game_complete_signal'
                  ? ' The thread may already be done, so if it is, use the outcome button now.'
                  : '';
          await thread.send({
            content: coachMention || '',
            embeds: [{
              title: '24-Hour Game Check',
              description: [
                'This thread has communication in it, but the game is still unresolved after 24 hours.',
                '',
                `If the game is already done, press the correct outcome button. If it is not, lock the time in here and keep the thread moving before the deadline gets tight.${contextLine}`,
              ].join('\n'),
              color: 0x5865F2,
              fields: [
                { name: `${info.awayTeam || 'Away'} messages`, value: String(participation.awayCount), inline: true },
                { name: `${info.homeTeam || 'Home'} messages`, value: String(participation.homeCount), inline: true },
              ],
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
          }).catch(() => { });
          persistThreadRuntimeState(threadId, { warnedTwentyFourAt: now });
          try {
            appendMaddenStaffLog({
              type: 'twenty_four_hour_game_check',
              guildId: thread.guildId,
              threadId,
              awayTeam: trackedInfo.awayTeam,
              homeTeam: trackedInfo.homeTeam,
              awayCount: participation.awayCount,
              homeCount: participation.homeCount,
            });
          } catch { }
          logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, participation, decision: 'sent', reason: '24h_game_check' });
        }
      }
      if (coachState === 'coach_both' && !trackedInfo.warnedDeadlineAt && deadlineAt && deadlineAt > now && deadlineAt - now <= ONE_HOUR) {
        const coachAndStaffMention = buildCoachAndStaffMention(trackedInfo);
        const projected = buildProjectedOutcome(trackedInfo, participation);
        const recommendedLine = projected?.recommended?.label
          ? `Recommended outcome: **${projected.recommended.label}**`
          : null;
        const guidanceLine = projected?.recommended?.guidance
          ? `Guidance: ${projected.recommended.guidance}`
          : null;
        await thread.send({
          content: coachAndStaffMention || '',
          embeds: [{
            title: 'Determined Strike Outcome',
            description: [
              `Advance deadline is in less than 1 hour and no outcome button has been recorded.`,
              projected.reason,
              '',
              ...(recommendedLine ? [recommendedLine] : []),
              ...(guidanceLine ? [guidanceLine] : []),
              ...(recommendedLine || guidanceLine ? [''] : []),
              projected.lines.join('\n') || 'No determined strikes.',
              '',
              'Staff can use the button below to apply the determined strikes.',
            ].join('\n'),
            color: 0xFEE75C,
            fields: [
              { name: `${info.awayTeam || 'Away'} messages`, value: String(participation.awayCount), inline: true },
              { name: `${info.homeTeam || 'Home'} messages`, value: String(participation.homeCount), inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
          components: projected.strikeAway || projected.strikeHome
            ? [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`madden_apply_determined_strikes|${threadId}`)
                  .setLabel('Apply Determined Strikes')
                  .setStyle(ButtonStyle.Danger),
              ),
            ]
            : [],
          allowedMentions: coachAndStaffMention ? { parse: ['roles'] } : { parse: [] },
        }).catch(() => { });
        persistThreadRuntimeState(threadId, { warnedDeadlineAt: now });
        try {
          appendMaddenStaffLog({
            type: 'determined_strike',
            guildId: thread.guildId,
            threadId,
            awayTeam: trackedInfo.awayTeam,
            homeTeam: trackedInfo.homeTeam,
            awayCount: participation.awayCount,
            homeCount: participation.homeCount,
            projected,
          });
        } catch { }
        runReminderSideEffects([
          () => postMaddenStaffDecision(
            client,
            thread.guildId,
            'Determined Strike Outcome',
            `${trackedInfo.awayTeam || 'Away'} vs ${trackedInfo.homeTeam || 'Home'} is under 1 hour from deadline with no outcome recorded.`,
            [
              { name: 'Determined', value: projected.lines.join('\n') || 'No determined strikes.' },
              { name: 'Thread', value: `<#${threadId}>` },
            ],
          ),
          () => sendCoachReceipt(thread.guild, [...(trackedInfo.awayRoleIds || []), ...(trackedInfo.homeRoleIds || [])], {
            title: 'Determined Strike Window',
            description: `${trackedInfo.awayTeam || 'Away'} vs ${trackedInfo.homeTeam || 'Home'} is under 1 hour from deadline with no outcome recorded.`,
            fields: [
              { name: 'Determination', value: projected.lines.join('\n') || 'No determined strikes.' },
              { name: 'Thread', value: `<#${threadId}>` },
            ],
            color: 0xED4245,
          }),
          () => postLeagueStaffOpsSnapshot(client, thread.guildId, 'determined strike outcome'),
        ]);
        logNotifierDecision({ enabled: debugDecisions, threadId, info: trackedInfo, participation, decision: 'sent', reason: '1h_determined_strike' });
      }
      const latestInfo = state.threads?.[threadId] || trackedInfo;
      const tailoredReminder = buildTailoredReminder(latestInfo, participation, now);
      const timeToDeadline = deadlineAt ? Math.max(0, deadlineAt - now) : null;
      const shouldSendTailoredReminder =
        tailoredReminder &&
        (forceImmediate || tailoredReminder.key !== String(latestInfo.lastReminderKey || '')) &&
        (
          (tailoredReminder.key === 'both_silent' && sinceCreated >= TWELVE_HOURS && !latestInfo.warnedNoResponseAt) ||
          (tailoredReminder.key === 'active_unmapped' && sinceCreated >= TWELVE_HOURS && !latestInfo.warnedNoResponseAt) ||
          ((tailoredReminder.key === 'away_silent' || tailoredReminder.key === 'home_silent') && sinceCreated >= TWELVE_HOURS && !latestInfo.warnedNoResponseAt) ||
          (tailoredReminder.key === 'scheduled_next_day_followthrough' && sinceCreated >= TWELVE_HOURS && !latestInfo.warnedTwentyFourAt) ||
          ((tailoredReminder.key === 'outcome_needed' || tailoredReminder.key === 'cpu_outcome_needed') && timeToDeadline != null && timeToDeadline <= SIX_HOURS && !latestInfo.warnedDeadlineAt)
        );

      if (shouldSendTailoredReminder) {
        try {
          await thread.send({
            content: tailoredReminder.content,
            allowedMentions: tailoredReminder.mention ? { parse: ['roles'] } : { parse: [] },
          });
          persistThreadRuntimeState(threadId, { lastReminder: now, lastReminderKey: tailoredReminder.key });
          logNotifierDecision({ enabled: debugDecisions, threadId, info: latestInfo, participation, decision: 'sent', reason: `tailored_${tailoredReminder.key}` });
        } catch {
          // ignore failures
        }
      } else {
        logNotifierDecision({
          enabled: debugDecisions,
          threadId,
          info: latestInfo,
          participation,
          decision: 'skip',
          reason: tailoredReminder
            ? `tailored_not_due_${tailoredReminder.key}`
            : 'no_due_reminder',
          extra: {
            sinceCreatedHours: Math.round((sinceCreated / 3600000) * 10) / 10,
            deadlineAt,
            warnedTwentyFourAt: Boolean(latestInfo.warnedTwentyFourAt),
            warnedDeadlineAt: Boolean(latestInfo.warnedDeadlineAt),
          },
        });
      }
      if (debugDecisions) {
        console.log('[madden-thread-reminder] loop_end', {
          threadId,
          matchup: `${trackedInfo?.awayTeam || info?.awayTeam || 'Away'} vs ${trackedInfo?.homeTeam || info?.homeTeam || 'Home'}`,
        });
      }
    } catch (error) {
      console.log('[madden-thread-reminder] thread_failure', {
        threadId,
        matchup: `${info?.awayTeam || 'Away'} vs ${info?.homeTeam || 'Home'}`,
        reason: error?.message || String(error || 'unknown_error'),
        stack: error?.stack || null,
      });
    }
  }
  saveState(state);
}

export async function backfillAndRunPendingThreadReminders(client) {
  if (!consumeStartupReminderBackfillFlag()) {
    console.log('[madden-thread-reminder] startup backfill skipped', { reason: 'one_shot_already_consumed' });
    return;
  }
  await runNotifierCycle(client, { forceImmediate: true, debugDecisions: true });
}

export function initNotifier(client) {
  setInterval(() => {
    runNotifierCycle(client).catch(() => null);
  }, 5 * 60 * 1000); // check every 5 minutes (keeps 1-hour window reminders close to T-60)
}

export function registerThread(threadId, payload = '') {
  state.threads = state.threads || {};
  const info = typeof payload === 'string' ? { mention: payload || '' } : { ...(payload || {}) };
  const createdAt = Number.isFinite(Number(info.createdAt)) ? Number(info.createdAt) : Date.now();
  state.threads[threadId] = {
    threadId,
    status: 'pending',
    created: createdAt,
    lastReminder: createdAt,
    mention: info.mention || '',
    deadlineAt: info.deadlineAt || null,
    leagueId: info.leagueId || null,
    seasonKey: info.seasonKey || null,
    stageIndex: Number.isFinite(Number(info.stageIndex)) ? Number(info.stageIndex) : null,
    weekIndex: Number.isFinite(Number(info.weekIndex)) ? Number(info.weekIndex) : null,
    scheduleId: info.scheduleId || null,
    awayTeamId: info.awayTeamId || null,
    homeTeamId: info.homeTeamId || null,
    awayTeam: info.awayTeam || null,
    homeTeam: info.homeTeam || null,
    awayRoleIds: info.awayRoleIds || [],
    homeRoleIds: info.homeRoleIds || [],
  };
  saveState(state);
}

export function updateThreadState(threadId, patch = {}) {
  if (!threadId || !patch || typeof patch !== 'object') return null;
  state.threads = state.threads || {};
  const current = state.threads[threadId] || { threadId, status: 'pending', created: Date.now(), lastReminder: Date.now() };
  state.threads[threadId] = {
    ...current,
    ...patch,
    threadId,
  };
  saveThreadState();
  return state.threads[threadId];
}

export async function hydrateThreadStateFromLiveThread(thread, existing = null) {
  if (!thread?.id || !thread?.guildId) return existing;
  const info = existing || getThreadState(thread.id) || {};
  const liveCreatedAt = Number.isFinite(Number(thread.createdTimestamp)) ? Number(thread.createdTimestamp) : null;
  const roleMap = loadRoleMap();
  const leagueId = info.leagueId || resolveLeagueIdWithConfig(thread.guildId) || null;
  let snapshot = null;
  let coachStatusByTeam = new Map();
  if (leagueId) {
    try {
      snapshot = loadLeagueSnapshot(leagueId);
      coachStatusByTeam = buildCoachStatusByTeam(snapshot);
    } catch {
      snapshot = null;
      coachStatusByTeam = new Map();
    }
  }
  const context = getMaddenSnapshotContext(thread.guildId, { leagueId, snapshot });
  const seasonInfo = context?.seasonInfo || {};
  const inferredSeasonKey = context?.seasonKey || info.seasonKey || null;
  const parsedTeams = parseThreadTeams(thread.name || '');
  const mentionRoleIds = parseRoleIdsFromMention(info.mention || '');
  let awayRoleIds = Array.isArray(info.awayRoleIds) ? info.awayRoleIds.filter(Boolean) : [];
  let homeRoleIds = Array.isArray(info.homeRoleIds) ? info.homeRoleIds.filter(Boolean) : [];
  const awayTeam = info.awayTeam || parsedTeams.awayTeam || null;
  const homeTeam = info.homeTeam || parsedTeams.homeTeam || null;
  const mappedAwayRole = awayTeam ? getCoachRoleIdForTeam(awayTeam, roleMap) : null;
  const mappedHomeRole = homeTeam ? getCoachRoleIdForTeam(homeTeam, roleMap) : null;
  if (!awayRoleIds.length && mappedAwayRole) awayRoleIds = [mappedAwayRole];
  if (!homeRoleIds.length && mappedHomeRole) homeRoleIds = [mappedHomeRole];
  if (!awayRoleIds.length && mentionRoleIds.length === 2) awayRoleIds = [mentionRoleIds[0]];
  if (!homeRoleIds.length && mentionRoleIds.length === 2) homeRoleIds = [mentionRoleIds[1]];

  // Deadline hydration: older thread registrations sometimes missed persisting deadlineAt.
  // If we don't have it, read the thread starter embed for "Deadline: <t:...>".
  let deadlineAt = Number.isFinite(Number(info.deadlineAt)) ? Number(info.deadlineAt) : null;
  if (!deadlineAt) {
    const starter = thread.fetchStarterMessage ? await thread.fetchStarterMessage().catch(() => null) : null;
    const starterText = [
      starter?.content || '',
      starter?.embeds?.[0]?.description || '',
      ...(starter?.embeds?.[0]?.fields || []).map((f) => `${f?.name || ''}\n${f?.value || ''}`),
    ].filter(Boolean).join('\n');
    deadlineAt = parseDeadlineFromText(starterText);
  }
  const patched = {
    created: liveCreatedAt || (Number.isFinite(Number(info.created)) ? Number(info.created) : Date.now()),
    leagueId,
    deadlineAt: deadlineAt || null,
    seasonKey: info.seasonKey || inferredSeasonKey || null,
    stageIndex: Number.isFinite(Number(info.stageIndex)) ? Number(info.stageIndex) : (Number.isFinite(Number(snapshot?.stage)) ? Number(snapshot.stage) : null),
    weekIndex: Number.isFinite(Number(info.weekIndex))
      ? Number(info.weekIndex)
      : (parseWeekIndex(thread.name || '') ?? (context?.weekIndex ?? null)),
    awayTeam,
    homeTeam,
    awayRoleIds,
    homeRoleIds,
    awayCoachStatus: coachStatusForTeam(awayTeam, coachStatusByTeam),
    homeCoachStatus: coachStatusForTeam(homeTeam, coachStatusByTeam),
  };
  const needsSave =
    patched.created !== (Number.isFinite(Number(info.created)) ? Number(info.created) : null) ||
    patched.leagueId !== (info.leagueId || null) ||
    patched.deadlineAt !== (Number.isFinite(Number(info.deadlineAt)) ? Number(info.deadlineAt) : null) ||
    patched.seasonKey !== (info.seasonKey || null) ||
    patched.stageIndex !== (Number.isFinite(Number(info.stageIndex)) ? Number(info.stageIndex) : null) ||
    patched.weekIndex !== (Number.isFinite(Number(info.weekIndex)) ? Number(info.weekIndex) : null) ||
    patched.awayTeam !== (info.awayTeam || null) ||
    patched.homeTeam !== (info.homeTeam || null) ||
    patched.awayCoachStatus !== (info.awayCoachStatus || null) ||
    patched.homeCoachStatus !== (info.homeCoachStatus || null) ||
    JSON.stringify(patched.awayRoleIds || []) !== JSON.stringify(info.awayRoleIds || []) ||
    JSON.stringify(patched.homeRoleIds || []) !== JSON.stringify(info.homeRoleIds || []);
  if (!needsSave) return info;
  return updateThreadState(thread.id, patched);
}

export function markThreadDone(threadId, status = 'done') {
  if (!state.threads || !state.threads[threadId]) return;
  state.threads[threadId].status = status;
  saveState(state);
}

export function resetThread(threadId) {
  if (!state.threads || !state.threads[threadId]) return;
  state.threads[threadId].status = 'pending';
  state.threads[threadId].lastReminder = Date.now();
  saveState(state);
}

export function getThreadState(threadId) {
  return state.threads?.[threadId] || null;
}

export function listThreadStates() {
  return Object.values(state.threads || {});
}

seedStartupReminderBackfillFlagOnce();

export default { initNotifier, runNotifierCycle, backfillAndRunPendingThreadReminders, registerThread, markThreadDone, resetThread, getThreadState, listThreadStates, updateThreadState, hydrateThreadStateFromLiveThread, scheduleStartupReminderBackfillOnce };
