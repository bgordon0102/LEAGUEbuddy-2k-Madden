import fs from 'fs';
import path from 'path';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from './madden_staff_ops.js';

const STATE_FILE = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const COMMISH_ROLE_IDS = ['1460399404241522759', '1460399405436768431'];

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

async function collectParticipation(thread, info) {
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return { awayCount: 0, homeCount: 0, totalCoachMessages: 0 };
  const awayUsers = new Set(await coachUserIds(thread.guild, info.awayRoleIds || []));
  const homeUsers = new Set(await coachUserIds(thread.guild, info.homeRoleIds || []));
  let awayCount = 0;
  let homeCount = 0;
  for (const message of messages.values()) {
    if (message.author?.bot) continue;
    if (awayUsers.has(message.author.id)) awayCount += 1;
    if (homeUsers.has(message.author.id)) homeCount += 1;
  }
  return { awayCount, homeCount, totalCoachMessages: awayCount + homeCount, awayUsers: [...awayUsers], homeUsers: [...homeUsers] };
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

function buildProjectedOutcome(info, participation) {
  const strikeAway = participation.awayCount === 0 || (participation.awayCount > 0 && participation.homeCount > 0);
  const strikeHome = participation.homeCount === 0 || (participation.awayCount > 0 && participation.homeCount > 0);
  const lines = [];
  if (strikeAway) lines.push(`${info.awayTeam || 'Away'} projected strike.`);
  if (strikeHome) lines.push(`${info.homeTeam || 'Home'} projected strike.`);
  const reason = participation.awayCount === 0 && participation.homeCount === 0
    ? 'No coach communication logged in the thread and no outcome button has been used.'
    : participation.awayCount === 0 || participation.homeCount === 0
      ? 'One side has not communicated in the thread and no outcome button has been used.'
      : 'Both sides communicated, but there is still no recorded outcome button.';
  return {
    reason,
    lines,
    strikeAway,
    strikeHome,
  };
}

const state = loadState();

export function initNotifier(client) {
  setInterval(async () => {
    const now = Date.now();
    const entries = Object.entries(state.threads || {});
    for (const [threadId, info] of entries) {
      if (info.status !== 'pending') continue;
      const deadlineAt = Number(info.deadlineAt || 0);
      const thread = await client.channels.fetch(threadId).catch(() => null);
      if (!thread || !thread.isTextBased()) continue;
      const participation = await collectParticipation(thread, info);
      const sinceCreated = now - (info.created || 0);
      if (!info.warnedNoResponseAt && sinceCreated >= TWENTY_FOUR_HOURS) {
        if (participation.awayCount === 0 || participation.homeCount === 0) {
          const coachMention = buildCoachMention(info);
          const silentSide = participation.awayCount === 0 && participation.homeCount === 0
            ? 'Both coaches still need to communicate.'
            : participation.awayCount === 0
              ? `${info.awayTeam || 'Away'} has not communicated yet.`
              : `${info.homeTeam || 'Home'} has not communicated yet.`;
          await thread.send({
            content: coachMention || '',
            embeds: [{
              title: 'Participation Risk',
              description: `${silentSide}\nA button outcome must be entered before the advance deadline or staff will have a clear strike recommendation to apply.`,
              color: 0xFEE75C,
              timestamp: new Date().toISOString(),
            }],
            allowedMentions: coachMention ? { parse: ['roles'] } : { parse: [] },
          }).catch(() => {});
          info.warnedNoResponseAt = now;
          appendMaddenStaffLog({
            type: 'participation_risk',
            guildId: thread.guildId,
            threadId,
            awayTeam: info.awayTeam,
            homeTeam: info.homeTeam,
            awayCount: participation.awayCount,
            homeCount: participation.homeCount,
          });
          await postMaddenStaffLog(
            client,
            thread.guildId,
            'Participation Risk',
            `${info.awayTeam || 'Away'} vs ${info.homeTeam || 'Home'} hit the 24-hour risk mark with one or both sides still silent.`,
            [{ name: 'Thread', value: `<#${threadId}>` }],
          ).catch(() => null);
          await postLeagueStaffOpsSnapshot(client, thread.guildId, '24-hour participation risk').catch(() => null);
        }
      }
      if (!info.warnedDeadlineAt && deadlineAt && deadlineAt > now && deadlineAt - now <= ONE_HOUR) {
        const coachAndStaffMention = buildCoachAndStaffMention(info);
        const projected = buildProjectedOutcome(info, participation);
        await thread.send({
          content: coachAndStaffMention || '',
          embeds: [{
            title: 'Projected Strike Outcome',
            description: [
              `Advance deadline is in less than 1 hour and no outcome button has been recorded.`,
              projected.reason,
              '',
              projected.lines.join('\n') || 'No projected strikes.',
              '',
              'Staff should use the thread buttons to apply the actual outcome.',
            ].join('\n'),
            color: 0xFEE75C,
            fields: [
              { name: `${info.awayTeam || 'Away'} messages`, value: String(participation.awayCount), inline: true },
              { name: `${info.homeTeam || 'Home'} messages`, value: String(participation.homeCount), inline: true },
            ],
            timestamp: new Date().toISOString(),
          }],
          allowedMentions: coachAndStaffMention ? { parse: ['roles'] } : { parse: [] },
        }).catch(() => {});
        info.warnedDeadlineAt = now;
        appendMaddenStaffLog({
          type: 'projected_strike',
          guildId: thread.guildId,
          threadId,
          awayTeam: info.awayTeam,
          homeTeam: info.homeTeam,
          awayCount: participation.awayCount,
          homeCount: participation.homeCount,
          projected,
        });
        await postMaddenStaffLog(
          client,
          thread.guildId,
          'Projected Strike Outcome',
          `${info.awayTeam || 'Away'} vs ${info.homeTeam || 'Home'} is under 1 hour from deadline with no outcome recorded.`,
          [
            { name: 'Projected', value: projected.lines.join('\n') || 'No projected strikes.' },
            { name: 'Thread', value: `<#${threadId}>` },
          ],
        ).catch(() => null);
        await postLeagueStaffOpsSnapshot(client, thread.guildId, 'projected strike outcome').catch(() => null);
      }
      const last = info.lastReminder || info.created || 0;
      if (now - last < EIGHT_HOURS) continue;
      try {
        const mention = buildCoachMention(info);
        await thread.send({
          content: `${mention} ⏰ Friendly reminder: communicate in-thread and make sure one outcome button is used before the advance deadline.`,
          allowedMentions: mention ? { parse: ['roles'] } : { parse: [] },
        });
        info.lastReminder = now;
      } catch {
        // ignore failures
      }
    }
    saveState(state);
  }, 60 * 60 * 1000); // check hourly
}

export function registerThread(threadId, payload = '') {
  state.threads = state.threads || {};
  const info = typeof payload === 'string' ? { mention: payload || '' } : { ...(payload || {}) };
  state.threads[threadId] = {
    status: 'pending',
    created: Date.now(),
    lastReminder: Date.now(),
    mention: info.mention || '',
    deadlineAt: info.deadlineAt || null,
    awayTeam: info.awayTeam || null,
    homeTeam: info.homeTeam || null,
    awayRoleIds: info.awayRoleIds || [],
    homeRoleIds: info.homeRoleIds || [],
  };
  saveState(state);
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

export default { initNotifier, registerThread, markThreadDone, resetThread, getThreadState };
