import fs from 'fs';
import path from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from './madden_staff_ops.js';
import { sendCoachReceipt } from './madden_coach_receipts.js';
import { getMaddenSnapshotContext } from './madden_metadata.js';

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

function getCoachRoleIdForTeam(label, roleMap) {
  const target = normalizeName(label);
  if (!target) return null;
  for (const [roleName, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(roleName)) continue;
    const base = roleName.replace(/ coach$/i, '').trim();
    if (normalizeName(base) === target) return roleId;
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

async function coachUserIds(guild, roleIds = []) {
  const users = new Set();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    if (role.members?.size) {
      role.members.forEach((m) => users.add(m.id));
      continue;
    }
    try {
      const all = await guild.members.fetch();
      all.filter((m) => m.roles.cache.has(roleId)).forEach((m) => users.add(m.id));
    } catch {
      // ignore
    }
  }
  return [...users];
}

export async function collectParticipation(thread, info) {
  const hydratedInfo = hydrateThreadStateFromLiveThread(thread, info) || info || {};
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
    };
  }
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
    if (awayUsers.has(message.author.id)) {
      awayCount += 1;
      awayResponderIds.add(String(message.author.id));
      if (createdAt > reminderCutoff) awayAfterReminder += 1;
      if (!awayFirstAt || createdAt < awayFirstAt) awayFirstAt = createdAt;
      if (!awayLastAt || createdAt > awayLastAt) awayLastAt = createdAt;
    }
    if (homeUsers.has(message.author.id)) {
      homeCount += 1;
      homeResponderIds.add(String(message.author.id));
      if (createdAt > reminderCutoff) homeAfterReminder += 1;
      if (!homeFirstAt || createdAt < homeFirstAt) homeFirstAt = createdAt;
      if (!homeLastAt || createdAt > homeLastAt) homeLastAt = createdAt;
    }
  }
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
  };
}

function buildCoachMention(info) {
  const roleIds = [...new Set([...(info.awayRoleIds || []), ...(info.homeRoleIds || [])].filter(Boolean))];
  return roleIds.map((id) => `<@&${id}>`).join(' ');
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
  const bothSilent = participation.awayCount === 0 && participation.homeCount === 0;
  const awaySilent = participation.awayCount === 0;
  const homeSilent = participation.homeCount === 0;
  const bothTalking = participation.awayCount > 0 && participation.homeCount > 0;

  if (bothSilent) {
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
    return {
      key: awaySilent ? 'away_silent' : 'home_silent',
      mention: targetMention,
      content: `${targetMention} ${activeTeam} already have thread activity in. ${silentTeam} still need to answer here so the game plan and timing are both on record before this turns into a deadline problem.`,
    };
  }

  if (bothTalking && timeToDeadline != null && timeToDeadline <= SIX_HOURS) {
    return {
      key: 'outcome_needed',
      mention: buildCoachMention(threadInfo),
      content: `${buildCoachMention(threadInfo)} This thread has communication, but it still needs the finish. Get the game played and make sure one outcome button is used before the deadline closes in.`,
    };
  }

  return null;
}

export function buildProjectedOutcome(info, participation) {
  const awaySilent = participation.awayCount === 0;
  const homeSilent = participation.homeCount === 0;
  const bothCommunicated = participation.awayCount > 0 && participation.homeCount > 0;
  const awayColdAfterReminder = bothCommunicated && participation.awayAfterReminder === 0 && participation.homeAfterReminder > 0;
  const homeColdAfterReminder = bothCommunicated && participation.homeAfterReminder === 0 && participation.awayAfterReminder > 0;

  const strikeAway = awaySilent || awayColdAfterReminder;
  const strikeHome = homeSilent || homeColdAfterReminder;
  const lines = [];
  if (awaySilent) lines.push(`${info.awayTeam || 'Away'} determined strike.`);
  else if (awayColdAfterReminder) lines.push(`${info.awayTeam || 'Away'} leaning strike: no follow-up after the latest reminder.`);
  if (homeSilent) lines.push(`${info.homeTeam || 'Home'} determined strike.`);
  else if (homeColdAfterReminder) lines.push(`${info.homeTeam || 'Home'} leaning strike: no follow-up after the latest reminder.`);
  if (!lines.length && bothCommunicated) lines.push('Staff review: both sides communicated, but no outcome button was used.');

  const reason = awaySilent && homeSilent
    ? 'No coach communication logged in the thread and no outcome button has been used.'
    : awaySilent || homeSilent
      ? 'One side has not communicated in the thread and no outcome button has been used.'
      : awayColdAfterReminder || homeColdAfterReminder
        ? 'Both sides spoke at some point, but one side stopped responding after reminders and no outcome button was used.'
        : 'Both sides communicated, but there is still no recorded outcome button.';
  return {
    reason,
    lines,
    strikeAway,
    strikeHome,
  };
}

const state = loadState();

export async function runNotifierCycle(client, { forceImmediate = false } = {}) {
  const now = Date.now();
  const entries = Object.entries(state.threads || {});
  for (const [threadId, info] of entries) {
    try {
      if (info.status !== 'pending') continue;
      const deadlineAt = Number(info.deadlineAt || 0);
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread || !thread.isTextBased()) continue;
      const hydratedInfo = hydrateThreadStateFromLiveThread(thread, info) || info;
      const participation = await collectParticipation(thread, hydratedInfo);
      const sinceCreated = now - (info.created || 0);
      if (!hydratedInfo.warnedNoResponseAt && sinceCreated >= TWENTY_FOUR_HOURS) {
        if (participation.awayCount === 0 || participation.homeCount === 0) {
          const coachMention = buildCoachMention(hydratedInfo);
          const silentSide = participation.awayCount === 0 && participation.homeCount === 0
            ? 'Both coaches still need to communicate.'
            : participation.awayCount === 0
              ? `${hydratedInfo.awayTeam || 'Away'} has not communicated yet.`
              : `${hydratedInfo.homeTeam || 'Home'} has not communicated yet.`;
          await thread.send({
            content: coachMention || '',
            embeds: [{
              title: 'Participation Risk',
              description: `${silentSide}\nA button outcome must be entered before the advance deadline or staff will have a clear strike determination to apply.`,
              color: 0xFEE75C,
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
          }).catch(() => {});
          hydratedInfo.warnedNoResponseAt = now;
          appendMaddenStaffLog({
            type: 'participation_risk',
            guildId: thread.guildId,
            threadId,
            awayTeam: hydratedInfo.awayTeam,
            homeTeam: hydratedInfo.homeTeam,
            awayCount: participation.awayCount,
            homeCount: participation.homeCount,
          });
          await postMaddenStaffLog(
            client,
            thread.guildId,
            'Participation Risk',
            `${hydratedInfo.awayTeam || 'Away'} vs ${hydratedInfo.homeTeam || 'Home'} hit the 24-hour risk mark with one or both sides still silent.`,
            [{ name: 'Thread', value: `<#${threadId}>` }],
          ).catch(() => null);
          const silentRoleIds =
            participation.awayCount === 0 && participation.homeCount === 0
              ? [...(hydratedInfo.awayRoleIds || []), ...(hydratedInfo.homeRoleIds || [])]
              : participation.awayCount === 0
                ? (hydratedInfo.awayRoleIds || [])
                : (hydratedInfo.homeRoleIds || []);
          await sendCoachReceipt(thread.guild, silentRoleIds, {
            title: 'Game Thread Participation Risk',
            description: `${hydratedInfo.awayTeam || 'Away'} vs ${hydratedInfo.homeTeam || 'Home'} has reached the 24-hour risk mark with no outcome recorded.`,
            fields: [
              { name: 'What This Means', value: 'You need to communicate in the thread and make sure one outcome button is used before deadline.' },
              { name: 'Thread', value: `<#${threadId}>` },
            ],
          }).catch(() => null);
          await postLeagueStaffOpsSnapshot(client, thread.guildId, '24-hour participation risk').catch(() => null);
        }
      }
      if (!hydratedInfo.warnedDeadlineAt && deadlineAt && deadlineAt > now && deadlineAt - now <= ONE_HOUR) {
        const coachAndStaffMention = buildCoachAndStaffMention(hydratedInfo);
        const projected = buildProjectedOutcome(hydratedInfo, participation);
        await thread.send({
          content: coachAndStaffMention || '',
          embeds: [{
            title: 'Determined Strike Outcome',
            description: [
              `Advance deadline is in less than 1 hour and no outcome button has been recorded.`,
              projected.reason,
              '',
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
        }).catch(() => {});
        hydratedInfo.warnedDeadlineAt = now;
        appendMaddenStaffLog({
          type: 'determined_strike',
          guildId: thread.guildId,
          threadId,
          awayTeam: hydratedInfo.awayTeam,
          homeTeam: hydratedInfo.homeTeam,
          awayCount: participation.awayCount,
          homeCount: participation.homeCount,
          projected,
        });
        await postMaddenStaffLog(
          client,
          thread.guildId,
            'Determined Strike Outcome',
            `${hydratedInfo.awayTeam || 'Away'} vs ${hydratedInfo.homeTeam || 'Home'} is under 1 hour from deadline with no outcome recorded.`,
          [
            { name: 'Determined', value: projected.lines.join('\n') || 'No determined strikes.' },
            { name: 'Thread', value: `<#${threadId}>` },
          ],
        ).catch(() => null);
        await sendCoachReceipt(thread.guild, [...(hydratedInfo.awayRoleIds || []), ...(hydratedInfo.homeRoleIds || [])], {
          title: 'Determined Strike Window',
          description: `${hydratedInfo.awayTeam || 'Away'} vs ${hydratedInfo.homeTeam || 'Home'} is under 1 hour from deadline with no outcome recorded.`,
          fields: [
            { name: 'Determination', value: projected.lines.join('\n') || 'No determined strikes.' },
            { name: 'Thread', value: `<#${threadId}>` },
          ],
          color: 0xED4245,
        }).catch(() => null);
        await postLeagueStaffOpsSnapshot(client, thread.guildId, 'determined strike outcome').catch(() => null);
      }
      const tailoredReminder = buildTailoredReminder(hydratedInfo, participation, now);
      const timeToDeadline = deadlineAt ? Math.max(0, deadlineAt - now) : null;
      const shouldSendTailoredReminder =
        tailoredReminder &&
        (forceImmediate || tailoredReminder.key !== String(hydratedInfo.lastReminderKey || '')) &&
        (
          (tailoredReminder.key === 'both_silent' && sinceCreated >= TWELVE_HOURS && !hydratedInfo.warnedNoResponseAt) ||
          ((tailoredReminder.key === 'away_silent' || tailoredReminder.key === 'home_silent') && sinceCreated >= TWELVE_HOURS && !hydratedInfo.warnedNoResponseAt) ||
          (tailoredReminder.key === 'outcome_needed' && timeToDeadline != null && timeToDeadline <= SIX_HOURS && !hydratedInfo.warnedDeadlineAt)
        );

      if (shouldSendTailoredReminder) {
        try {
          await thread.send({
            content: tailoredReminder.content,
            allowedMentions: tailoredReminder.mention ? { parse: ['roles'] } : { parse: [] },
          });
          hydratedInfo.lastReminder = now;
          hydratedInfo.lastReminderKey = tailoredReminder.key;
        } catch {
          // ignore failures
        }
      }
    } catch {
      // ignore thread-level failures
    }
  }
  saveState(state);
}

export async function backfillAndRunPendingThreadReminders(client) {
  await runNotifierCycle(client, { forceImmediate: true });
}

export function initNotifier(client) {
  runNotifierCycle(client).catch(() => null);
  setInterval(() => {
    runNotifierCycle(client).catch(() => null);
  }, 60 * 60 * 1000); // check hourly
}

export function registerThread(threadId, payload = '') {
  state.threads = state.threads || {};
  const info = typeof payload === 'string' ? { mention: payload || '' } : { ...(payload || {}) };
  state.threads[threadId] = {
    threadId,
    status: 'pending',
    created: Date.now(),
    lastReminder: Date.now(),
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

export function hydrateThreadStateFromLiveThread(thread, existing = null) {
  if (!thread?.id || !thread?.guildId) return existing;
  const info = existing || getThreadState(thread.id) || {};
  const roleMap = loadRoleMap();
  const leagueId = info.leagueId || resolveLeagueIdWithConfig(thread.guildId) || null;
  let snapshot = null;
  if (leagueId) {
    try {
      snapshot = loadLeagueSnapshot(leagueId);
    } catch {
      snapshot = null;
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
  const patched = {
    leagueId,
    seasonKey: info.seasonKey || inferredSeasonKey || null,
    stageIndex: Number.isFinite(Number(info.stageIndex)) ? Number(info.stageIndex) : (Number.isFinite(Number(snapshot?.stage)) ? Number(snapshot.stage) : null),
    weekIndex: Number.isFinite(Number(info.weekIndex))
      ? Number(info.weekIndex)
      : (parseWeekIndex(thread.name || '') ?? (context?.weekIndex ?? null)),
    awayTeam,
    homeTeam,
    awayRoleIds,
    homeRoleIds,
  };
  const needsSave =
    patched.leagueId !== (info.leagueId || null) ||
    patched.seasonKey !== (info.seasonKey || null) ||
    patched.stageIndex !== (Number.isFinite(Number(info.stageIndex)) ? Number(info.stageIndex) : null) ||
    patched.weekIndex !== (Number.isFinite(Number(info.weekIndex)) ? Number(info.weekIndex) : null) ||
    patched.awayTeam !== (info.awayTeam || null) ||
    patched.homeTeam !== (info.homeTeam || null) ||
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

export default { initNotifier, runNotifierCycle, backfillAndRunPendingThreadReminders, registerThread, markThreadDone, resetThread, getThreadState, listThreadStates, updateThreadState, hydrateThreadStateFromLiveThread };
