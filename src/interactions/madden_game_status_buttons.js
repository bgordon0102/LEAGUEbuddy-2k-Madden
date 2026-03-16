import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { markThreadDone, getThreadState, collectParticipation } from '../shared/madden_thread_notifier.js';
import { updateFairSimBoard } from '../shared/fairsim_board.js';
import { registerThread } from '../shared/madden_thread_notifier.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from '../shared/madden_staff_ops.js';
import { queueRemovalReview, queueImmediateRemedyReview } from '../shared/madden_removal_review.js';
import { sendCoachReceipt } from '../shared/madden_coach_receipts.js';
import {
  STRIKE_LIMIT,
  loadStrikeStore,
  saveStrikeStore,
  ensureStrikeSeason,
  weightedOverLimit,
  addStrikeOutcome,
  resetCompletedOutcome,
  recordCommunicationWeek,
  remainingWeighted,
  weightedCount,
} from '../shared/madden_strikes.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const COMMISH_ROLE_IDS = ['1460399404241522759', '1460399405436768431']; // Legacy commish roles
const PENDING_FILE = path.join(process.cwd(), 'data', 'madden', 'pending.json');
const pendingFair = new Map(); // threadId or threadId:complete -> { away: bool, home: bool }

function loadPendingFile() {
  try {
    const data = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    Object.entries(data || {}).forEach(([k, v]) => {
      if (v && (v.away || v.home)) pendingFair.set(k, { away: !!v.away, home: !!v.home });
    });
  } catch { /* ignore */ }
}

function savePendingFile() {
  const obj = {};
  pendingFair.forEach((v, k) => { obj[k] = v; });
  try {
    fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.warn('[game_status] failed to persist pending file', e?.message || e); }
}

loadPendingFile();

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}
function normalize(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'pack' || lower === 'packers') return 'Packers';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs' || lower === 'buccaneers') return 'Buccaneers';
  if (lower === 'pats' || lower === 'patriots') return 'Patriots';
  if (lower === 'bolts' || lower === 'chargers') return 'Chargers';
  return name;
}

function parseTeams(threadName) {
  const cleaned = (threadName || '').replace(/-+\s*test$/i, '').trim();
  const match = cleaned.match(/(.+)\s+vs\s+(.+?)(?:\s+-\s+w\d+)?$/i);
  if (!match) return { away: null, home: null };
  const clean = (s) => s.replace(/\bcoach\b/ig, '').trim();
  return { away: clean(match[1]), home: clean(match[2]) };
}

function coachRoleIds(team, roleMap) {
  if (!team) return [];
  const norm = (str) => normalize(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTeam = norm(team.replace(/coach/ig, '').trim());
  const mascotTeam = norm(team.split(/\s+/).pop());
  return Object.entries(roleMap)
    .filter(([k]) => /coach$/i.test(k))
    .filter(([k]) => {
      const base = k.replace(/coach$/i, '').trim();
      const normBase = norm(base);
      const mascotBase = norm(base.split(/\s+/).pop());
      return (
        normBase === normTeam ||
        mascotBase === mascotTeam ||
        normBase.includes(normTeam) ||
        normTeam.includes(normBase)
      );
    })
    .map(([, id]) => id)
    .filter(Boolean);
}

async function buildCoachMentions(guild, team, roleMap) {
  const roleIds = coachRoleIds(team, roleMap);
  if (roleIds.length) return roleIds.map(id => `<@&${id}>`);
  const users = await coachUserIds(guild, team, roleMap);
  return users.map(id => `<@${id}>`);
}

function rolesFromMessageMentions(thread) {
  const msg = thread?.messages?.cache?.first();
  if (!msg) return [];
  return [...msg.mentions.roles.keys()];
}

async function coachUserIds(guild, team, roleMap) {
  const ids = coachRoleIds(team, roleMap);
  const users = [];
  for (const roleId of ids) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    // Use cached members first; if empty, fetch all members and filter by role to avoid cache misses.
    if (role.members?.size) {
      role.members.forEach(m => users.push(m.id));
    } else {
      try {
        const all = await guild.members.fetch();
        all.filter(m => m.roles.cache.has(roleId)).forEach(m => users.push(m.id));
      } catch {
        // ignore fetch failures; fallback is empty
      }
    }
  }
  return users;
}

function seasonKeyFromSnapshot(snapshot) {
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

function ensureSeason(fairData, seasonKey) {
  return ensureStrikeSeason(fairData, seasonKey);
}

function fairCountExceeded(users, seasonData) {
  return weightedOverLimit(seasonData, users);
}

function resetConsecutive(users, fairData, seasonKey) {
  resetCompletedOutcome(fairData, seasonKey, users);
}

function remainingFair(users, seasonData) {
  return remainingWeighted(seasonData, users);
}

function consecutiveWarnings(users, seasonData) {
  const warn = [];
  users.forEach(u => {
    const seq = seasonData.consecutive?.[u] || 0;
    if (seq >= 2) warn.push({ user: u, seq });
  });
  return warn;
}

function disableButtons(interaction) {
  const updatedRows = interaction.message.components.map(row => {
    const newRow = ActionRowBuilder.from(row);
    newRow.components = newRow.components.map(btn => ButtonBuilder.from(btn).setDisabled(true));
    return newRow;
  });
  return interaction.message.edit({ components: updatedRows });
}

function clearPendingFair(threadId) {
  pendingFair.delete(threadId);
  savePendingFile();
}

function setPendingFair(threadId, side) {
  const entry = pendingFair.get(threadId) || { away: false, home: false };
  entry[side] = true;
  pendingFair.set(threadId, entry);
  savePendingFile();
  return entry;
}

async function sendWarnings(thread, users, seasonData, commishMention) {
  const lines = [];
  users.forEach(u => {
    const total = weightedCount(seasonData, u);
    if (total >= 2 && total < 4) lines.push(`<@${u}> is at ${total}/5 weighted strike points.`);
    else if (total >= 4 && total < STRIKE_LIMIT) lines.push(`<@${u}> is at ${total}/5 weighted strike points. One more issue puts them on the edge.`);
    else if (total >= STRIKE_LIMIT) lines.push(`<@${u}> is at ${total}/5 weighted strike points. All remaining games this season should be treated as must-play.`);
  });
  if (lines.length) {
    await thread.send({ content: `${lines.join('\n')} ${commishMention || ''}`.trim() });
  }
}

async function maybeQueueRemovalReview(client, guild, seasonKey, teamName, roleIds = [], userIds = []) {
  for (const roleId of roleIds) {
    for (const userId of userIds) {
      await queueRemovalReview(client, guild.id, { seasonKey, userId, roleId, teamName }).catch(() => null);
      await queueImmediateRemedyReview(client, guild.id, { seasonKey, userId, roleId, teamName }).catch(() => null);
    }
  }
}

export const customId = /^madden_game_status_(complete|fairsim|homewin|awaywin|cpu|staffstrikeaway|staffstrikehome)\|([^|]+)(?:\|([^|]+)\|([^|]+))?$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [, action, threadId, awayEnc, homeEnc] = interaction.customId.match(customId) || [];
  const roleMap = loadRoleMap();
  const thread = interaction.channel;
  if (!thread || String(thread.id) !== threadId) {
    await interaction.reply({ content: 'Thread not found for this button.', ephemeral: true });
    return;
  }
  const threadState = getThreadState(threadId);
  if (threadState && threadState.status && threadState.status !== 'pending' && !isNaN(Date.now())) {
    await interaction.reply({ content: 'This matchup has already been resolved by the system or staff. Ask staff if it needs to be reopened.', ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  let { away, home } = parseTeams(thread.name || '');
  if (awayEnc || homeEnc) {
    away = awayEnc ? decodeURIComponent(awayEnc) : away;
    home = homeEnc ? decodeURIComponent(homeEnc) : home;
  }
  console.log('[game_status] thread', { thread: thread.name, away, home, action, user: interaction.user.id });
  let awayCoachRoles = coachRoleIds(away, roleMap);
  let homeCoachRoles = coachRoleIds(home, roleMap);
  // Fallback: use first-message mentions if no roles found (helps test threads)
  if (!awayCoachRoles.length || !homeCoachRoles.length) {
    const mentionRoles = rolesFromMessageMentions(thread);
    if (mentionRoles.length) {
      if (!awayCoachRoles.length && mentionRoles[0]) awayCoachRoles = [mentionRoles[0]];
      if (!homeCoachRoles.length && mentionRoles[1]) homeCoachRoles = [mentionRoles[1]];
      // If only one role was mentioned, fall back to all mentions for the missing side
      if (!homeCoachRoles.length && mentionRoles.length === 1) homeCoachRoles = mentionRoles;
      if (!awayCoachRoles.length && mentionRoles.length === 1) awayCoachRoles = mentionRoles;
    }
  }
  const staffRoles = [roleMap['Ghost Legacy Commish'], roleMap['Ghost Legacy Co-Commish'], ...COMMISH_ROLE_IDS].filter(Boolean);
  const hasRole = (roles) => roles.some(rid => member.roles.cache.has(rid));
  const isAwayCoach = hasRole(awayCoachRoles);
  const isHomeCoach = hasRole(homeCoachRoles);
  const isStaff = hasRole(staffRoles);
  console.log('[game_status] roleCheck', { awayCoachRoles, homeCoachRoles, staffRoles, isAwayCoach, isHomeCoach, isStaff });

  const allowed = (() => {
    if (isStaff) return true;
    if (action === 'complete' || action === 'fairsim' || action === 'cpu') return isAwayCoach || isHomeCoach;
    if (action === 'homewin') return isAwayCoach; // only opponent can concede
    if (action === 'awaywin') return isHomeCoach; // only opponent can concede
    return false;
  })();

  if (!allowed) {
    await interaction.reply({ content: 'Only the appropriate opposing coach (or commish staff) can use this button.', ephemeral: true });
    return;
  }

  const commishMention = Array.from(new Set(COMMISH_ROLE_IDS)).map(id => `<@&${id}>`).join(' ');
  const baseEmbed = new EmbedBuilder().setTimestamp(new Date());

  // Fair sim / force wins (also used for complete/cpu/staffstrike after userIds are resolved)
  const seasonKey = (() => {
    try {
      const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
      const snapshot = loadLeagueSnapshot(leagueId);
      return seasonKeyFromSnapshot(snapshot);
    } catch {
      return `year_${new Date().getFullYear()}`;
    }
  })();

  const fairData = loadStrikeStore();
  const seasonData = ensureSeason(fairData, seasonKey);
  const userIds = [
    ...(await coachUserIds(interaction.guild, away, roleMap)),
    ...(await coachUserIds(interaction.guild, home, roleMap)),
  ];
  const awayUserIds = await coachUserIds(interaction.guild, away, roleMap);
  const homeUserIds = await coachUserIds(interaction.guild, home, roleMap);
  const participation = await collectParticipation(thread, {
    awayRoleIds: awayCoachRoles,
    homeRoleIds: homeCoachRoles,
    lastReminder: getThreadState(threadId)?.lastReminder,
  });
  const onTimeOutcome = (() => {
    const state = getThreadState(threadId);
    const deadlineAt = Number(state?.deadlineAt || 0);
    return !deadlineAt || Date.now() <= deadlineAt;
  })();

  // Staff-awarded strike (targeted to home/away coaches)
  if (action === 'staffstrikeaway' || action === 'staffstrikehome') {
    if (!isStaff) {
      await interaction.reply({ content: 'Only staff can award a strike.', ephemeral: true });
      return;
    }
    const targetTeam = action === 'staffstrikeaway' ? away : home;
    const targetUsers = await coachUserIds(interaction.guild, targetTeam, roleMap);
    const teamOnly = !targetUsers.length;
    const over = fairCountExceeded(targetUsers, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      const msg = `Strike denied: ${names} already at ${STRIKE_LIMIT}/5 weighted strike points. All remaining games must be played.`;
      await interaction.reply({ content: msg, ephemeral: true });
      try { await thread.send({ content: `${commishMention} ${msg}`.trim(), allowedMentions: { parse: ['roles'] } }); } catch {}
      return;
    }
    if (!targetUsers.length) {
      await interaction.reply({ content: 'No coach user is currently resolved for that team. Fix the coach role before applying a strike.', ephemeral: true });
      return;
    }
    addStrikeOutcome(fairData, seasonKey, targetUsers, 'determined_strike', 'DS');
    recordCommunicationWeek(fairData, seasonKey, awayUserIds, { responded: participation.awayCount > 0, onTime: onTimeOutcome });
    recordCommunicationWeek(fairData, seasonKey, homeUserIds, { responded: participation.homeCount > 0, onTime: onTimeOutcome });
    saveStrikeStore(fairData);
    markThreadDone(threadId, action);
    const seasonDataAfter = ensureSeason(fairData, seasonKey);
    const remaining = remainingFair(targetUsers, seasonDataAfter);
    const remLine = targetUsers.length
      ? Object.entries(remaining).map(([u, rem]) => `<@${u}> has ${Math.max(rem,0)}/5 weighted strike room left this season`).join('\n')
      : 'Team strike recorded (no coach role members found).';
    const label = action === 'staffstrikeaway' ? 'Determined Strike (Away)' : 'Determined Strike (Home)';
    baseEmbed
      .setTitle(label)
      .setColor(0xED4245)
      .setDescription(`Issued by ${interaction.user}\nTeam: ${targetTeam || 'Unknown'}`)
      .addFields({ name: 'Remaining', value: remLine || 'N/A', inline: false });
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    if (targetUsers.length) {
      await sendWarnings(thread, targetUsers, seasonDataAfter, commishMention);
    }
    await maybeQueueRemovalReview(interaction.client, interaction.guild, seasonKey, targetTeam, action === 'staffstrikeaway' ? awayCoachRoles : homeCoachRoles, targetUsers);
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[game_status] updateFairSimBoard failed', e?.message || e); }
    try { await disableButtons(interaction); } catch {}
    appendMaddenStaffLog({
      type: 'determined_strike',
      guildId: interaction.guildId,
      threadId,
      targetTeam,
      awardedBy: interaction.user.id,
      action,
    });
    await postMaddenStaffLog(
      interaction.client,
      interaction.guildId,
      'Determined Strike Applied',
      `${targetTeam || 'Unknown team'} received a determined strike in <#${threadId}>.`,
    ).catch(() => null);
    await sendCoachReceipt(interaction.guild, action === 'staffstrikeaway' ? awayCoachRoles : homeCoachRoles, {
      title: 'Determined Strike Applied',
      description: `${targetTeam || 'Your team'} received a determined strike.`,
      fields: [
        { name: 'Reason', value: 'The thread evidence supported a determined strike for nonresponse / fault.' },
        { name: 'Thread', value: `<#${threadId}>` },
      ],
      color: 0xED4245,
    }).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'determined strike applied').catch(() => null);
    await interaction.reply({ content: teamOnly ? 'Strike recorded for the team (no coach users found in the role).' : 'Strike issued and recorded.', ephemeral: true });
    clearPendingFair(threadId);
    return;
  }

  if (action === 'complete') {
    // Require both sides (staff included)
    const side = isAwayCoach ? 'away' : isHomeCoach ? 'home' : 'staff';
    const key = threadId + ':complete';
    const existing = pendingFair.get(key) || { away: false, home: false };
    if ((side === 'away' && existing.away) || (side === 'home' && existing.home)) {
      await interaction.reply({ content: 'Still waiting for the other side to press Game Completed.', ephemeral: true });
      return;
    }
    const pending = setPendingFair(key, side);
    if (!(pending.away && pending.home)) {
      const waitMsg = 'Game completed pending. Your opponent still needs to press Game Completed to confirm and stop reminders.';
      await interaction.reply({ content: waitMsg, ephemeral: true });
      const otherTeam = side === 'away' ? home : away;
      const otherMentions = await buildCoachMentions(interaction.guild, otherTeam, roleMap);
      const mentionText = [...otherMentions].join(' ');
      const coachPrompt = `${mentionText} Your opponent marked the game complete. Press **Game Completed** too if the game is finished so the thread can fully close.`.trim();
      try { await thread.send({ content: coachPrompt, allowedMentions: { parse: ['roles', 'users'] } }); } catch {}
      return;
    }
    clearPendingFair(threadId + ':complete');

    resetConsecutive(userIds, fairData, seasonKey);
    recordCommunicationWeek(fairData, seasonKey, awayUserIds, { responded: participation.awayCount > 0, onTime: onTimeOutcome });
    recordCommunicationWeek(fairData, seasonKey, homeUserIds, { responded: participation.homeCount > 0, onTime: onTimeOutcome });
    saveStrikeStore(fairData);
    markThreadDone(threadId, 'complete');
    baseEmbed.setTitle('Game Completed').setColor(0x57F287).setDescription(`Marked by ${interaction.user}`);
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    try { await disableButtons(interaction); } catch {}
    appendMaddenStaffLog({
      type: 'game_completed',
      guildId: interaction.guildId,
      threadId,
      away,
      home,
      byUser: interaction.user.id,
    });
    await interaction.reply({ content: 'Marked complete. Reminders stopped.', ephemeral: true });
    return;
  }

  if (action === 'cpu') {
    baseEmbed.setTitle('CPU Game Logged').setColor(0x5865F2).setDescription(`Marked by ${interaction.user}. No strikes applied.`);
    markThreadDone(threadId, 'cpu');
    try { await disableButtons(interaction); } catch {}
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[game_status] updateFairSimBoard failed', e?.message || e); }
    appendMaddenStaffLog({
      type: 'cpu_game',
      guildId: interaction.guildId,
      threadId,
      away,
      home,
      byUser: interaction.user.id,
    });
    await interaction.reply({ content: 'Logged as CPU matchup. No sim strikes applied.', ephemeral: true });
    clearPendingFair(threadId);
    return;
  }

  if (action === 'fairsim') {
    // Everyone (staff too) must two-step confirm
    const side = isAwayCoach ? 'away' : isHomeCoach ? 'home' : 'staff';
    const existing = pendingFair.get(threadId) || { away: false, home: false };
    if ((side === 'away' && existing.away) || (side === 'home' && existing.home)) {
      await interaction.reply({ content: 'Still waiting for the other side to press Fair Sim.', ephemeral: true });
      return;
    }
    const pending = setPendingFair(threadId, side);
    if (!(pending.away && pending.home)) {
      const waitMsg = 'Fair sim pending. Your opponent still needs to press Fair Sim to confirm the non-play result.';
      await interaction.reply({ content: waitMsg, ephemeral: true });
      const otherTeam = side === 'away' ? home : away;
      const otherMentions = await buildCoachMentions(interaction.guild, otherTeam, roleMap);
      const mentionText = [...otherMentions].join(' ');
      const coachPrompt = `${mentionText} Your opponent requested **Fair Sim**. Press **Fair Sim** too only if both sides agree the game will not be played.`.trim();
      try { await thread.send({ content: coachPrompt, allowedMentions: { parse: ['roles', 'users'] } }); } catch {}
      return;
    }
    clearPendingFair(threadId);
    const over = fairCountExceeded(userIds, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Fair sim denied: ${names} are already at ${STRIKE_LIMIT}/5 weighted strike points this season. They must play the game.`, ephemeral: true });
      try { await thread.send({ content: `${commishMention || ''} Fair sim denied: ${names} are already at the weighted limit. Game must be played.`.trim() }); } catch {}
      return;
    }
    if (!awayUserIds.length || !homeUserIds.length) {
      await interaction.reply({ content: 'Both coach roles must resolve to users before a Fair Sim can be logged.', ephemeral: true });
      return;
    }
    addStrikeOutcome(fairData, seasonKey, userIds, 'fair_sim', 'FS');
    recordCommunicationWeek(fairData, seasonKey, awayUserIds, { responded: participation.awayCount > 0, onTime: onTimeOutcome });
    recordCommunicationWeek(fairData, seasonKey, homeUserIds, { responded: participation.homeCount > 0, onTime: onTimeOutcome });
    saveStrikeStore(fairData);
    markThreadDone(threadId, 'fairsim');
    const remaining = remainingFair(userIds, ensureSeason(fairData, seasonKey));
    const remLine = Object.entries(remaining).map(([u, rem]) => `<@${u}> has ${Math.max(rem,0)}/5 weighted strike room left`).join('\n');
    baseEmbed.setTitle('Fair Sim Logged').setColor(0xFEE75C).setDescription(`Confirmed by both coaches\nTeams: ${away || 'Away'} vs ${home || 'Home'}`).addFields({ name: 'Weighted strike room', value: remLine || 'N/A', inline: false });
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    await sendWarnings(thread, userIds, ensureSeason(fairData, seasonKey), commishMention);
    // Refresh fair-sim board (best effort)
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[game_status] updateFairSimBoard failed', e?.message || e); }
    try { await disableButtons(interaction); } catch {}
    appendMaddenStaffLog({
      type: 'fair_sim',
      guildId: interaction.guildId,
      threadId,
      away,
      home,
      byUser: interaction.user.id,
    });
    await postMaddenStaffLog(
      interaction.client,
      interaction.guildId,
      'Fair Sim Logged',
      `${away || 'Away'} vs ${home || 'Home'} was logged as a fair sim in <#${threadId}>.`,
    ).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'fair sim logged').catch(() => null);
    await sendCoachReceipt(interaction.guild, [...awayCoachRoles, ...homeCoachRoles], {
      title: 'Fair Sim Receipt',
      description: `${away || 'Away'} vs ${home || 'Home'} was recorded as a Fair Sim.`,
      fields: [
        { name: 'Weight', value: 'Each coach received 0.5 strike points.' },
        { name: 'Thread', value: `<#${threadId}>` },
      ],
    }).catch(() => null);
    await interaction.reply({ content: 'Fair sim logged and commish notified. Reminders stopped.', ephemeral: true });
    await maybeQueueRemovalReview(interaction.client, interaction.guild, seasonKey, away, awayCoachRoles, awayUserIds);
    await maybeQueueRemovalReview(interaction.client, interaction.guild, seasonKey, home, homeCoachRoles, homeUserIds);
    return;
  }

  if (action === 'homewin' || action === 'awaywin') {
    const chargeUsers = action === 'homewin'
      ? await coachUserIds(interaction.guild, away, roleMap)
      : await coachUserIds(interaction.guild, home, roleMap);
    const over = fairCountExceeded(chargeUsers, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Force win denied: ${names} are already at ${STRIKE_LIMIT}/5 weighted strike points this season. They must play the game.`, ephemeral: true });
      try { await thread.send({ content: `${commishMention || ''} Force win denied: ${names} are already at the weighted limit. Game must be played.`.trim() }); } catch {}
      return;
    }
    if (!chargeUsers.length) {
      await interaction.reply({ content: 'No coach user is resolved for the charged team. Fix the coach role before logging this outcome.', ephemeral: true });
      return;
    }
    addStrikeOutcome(fairData, seasonKey, chargeUsers, 'force_win', 'FW');
    recordCommunicationWeek(fairData, seasonKey, awayUserIds, { responded: participation.awayCount > 0, onTime: onTimeOutcome });
    recordCommunicationWeek(fairData, seasonKey, homeUserIds, { responded: participation.homeCount > 0, onTime: onTimeOutcome });
    saveStrikeStore(fairData);
    markThreadDone(threadId, action);
    const label = action === 'homewin' ? 'Home Win Requested' : 'Away Win Requested';
    baseEmbed.setTitle(label).setColor(0x5865F2).setDescription(`Requested by ${interaction.user}\nTeams: ${away || 'Away'} vs ${home || 'Home'}`);
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    await sendWarnings(thread, chargeUsers, ensureSeason(fairData, seasonKey), commishMention);
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[game_status] updateFairSimBoard failed', e?.message || e); }
    try { await disableButtons(interaction); } catch {}
    appendMaddenStaffLog({
      type: 'force_win',
      guildId: interaction.guildId,
      threadId,
      away,
      home,
      chargedTeam: action === 'homewin' ? away : home,
      byUser: interaction.user.id,
    });
    await postMaddenStaffLog(
      interaction.client,
      interaction.guildId,
      'Force Win Logged',
      `${away || 'Away'} vs ${home || 'Home'} was resolved with a force-win style outcome in <#${threadId}>.`,
    ).catch(() => null);
    await sendCoachReceipt(interaction.guild, action === 'homewin' ? awayCoachRoles : homeCoachRoles, {
      title: 'Force Win Receipt',
      description: `${action === 'homewin' ? away : home || 'Your team'} was charged with a non-play outcome.`,
      fields: [
        { name: 'Weight', value: 'This outcome added 1.0 strike points.' },
        { name: 'Thread', value: `<#${threadId}>` },
      ],
      color: 0xED4245,
    }).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'force win logged').catch(() => null);
    await interaction.reply({ content: 'Force-win request sent and reminders stopped.', ephemeral: true });
    if (action === 'homewin') await maybeQueueRemovalReview(interaction.client, interaction.guild, seasonKey, away, awayCoachRoles, chargeUsers);
    if (action === 'awaywin') await maybeQueueRemovalReview(interaction.client, interaction.guild, seasonKey, home, homeCoachRoles, chargeUsers);
    clearPendingFair(threadId);
    return;
  }
}

export default { customId, execute };
