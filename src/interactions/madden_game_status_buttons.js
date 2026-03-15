import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { markThreadDone, getThreadState } from '../shared/madden_thread_notifier.js';
import { updateFairSimBoard } from '../shared/fairsim_board.js';
import { registerThread } from '../shared/madden_thread_notifier.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from '../shared/madden_staff_ops.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const FAIR_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const COMMISH_ROLE_IDS = ['1460399404241522759', '1460399405436768431']; // Legacy commish roles
const SIM_LIMIT = 5;
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
function loadFair() {
  try { return JSON.parse(fs.readFileSync(FAIR_FILE, 'utf8')); } catch { return {}; }
}
function saveFair(data) {
  fs.mkdirSync(path.dirname(FAIR_FILE), { recursive: true });
  fs.writeFileSync(FAIR_FILE, JSON.stringify(data, null, 2));
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
  fairData[seasonKey] = fairData[seasonKey] || {};
  const seasonData = fairData[seasonKey];
  if (!seasonData.counts) {
    const counts = {};
    Object.entries(seasonData).forEach(([k, v]) => { counts[k] = v; });
    seasonData.counts = counts;
  }
  seasonData.consecutive = seasonData.consecutive || {};
  return seasonData;
}

function fairCountExceeded(users, seasonData) {
  const over = [];
  users.forEach(u => {
    const c = seasonData.counts?.[u] || 0;
    if (c >= SIM_LIMIT) over.push(u);
  });
  return over;
}

function incrementFair(users, fairData, seasonKey, teams = []) {
  const seasonData = ensureSeason(fairData, seasonKey);
  users.forEach(u => {
    seasonData.counts[u] = (seasonData.counts[u] || 0) + 1;
    seasonData.consecutive[u] = (seasonData.consecutive[u] || 0) + 1;
  });
  // Teams kept for possible future use
  teams.forEach(t => {
    const norm = normalize(t || '');
    const key = `team:${norm}`;
    seasonData.counts[key] = (seasonData.counts[key] || 0) + 1;
  });
}

function resetConsecutive(users, fairData, seasonKey) {
  const seasonData = ensureSeason(fairData, seasonKey);
  users.forEach(u => { seasonData.consecutive[u] = 0; });
}

function remainingFair(users, seasonData) {
  const res = {};
  users.forEach(u => {
    res[u] = SIM_LIMIT - (seasonData.counts?.[u] || 0);
  });
  return res;
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
    const total = seasonData.counts?.[u] || 0;
    if (total === 2) lines.push(`<@${u}> is at 2/5 sim strikes. 3 left this season.`);
    else if (total === 4) lines.push(`<@${u}> is at 4/5 sim strikes. 1 left this season.`);
    else if (total === 5) lines.push(`<@${u}> is at 5/5 sim strikes. All remaining games this season must be played.`);
  });
  if (lines.length) {
    await thread.send({ content: `${lines.join('\n')} ${commishMention || ''}`.trim() });
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

  const fairData = loadFair();
  const seasonData = ensureSeason(fairData, seasonKey);
  const userIds = [
    ...(await coachUserIds(interaction.guild, away, roleMap)),
    ...(await coachUserIds(interaction.guild, home, roleMap)),
  ];

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
      const msg = `Strike denied: ${names} already at ${SIM_LIMIT}/5. All remaining games must be played.`;
      await interaction.reply({ content: msg, ephemeral: true });
      try { await thread.send({ content: `${commishMention} ${msg}`.trim(), allowedMentions: { parse: ['roles'] } }); } catch {}
      return;
    }
    incrementFair(targetUsers, fairData, seasonKey, [targetTeam].filter(Boolean));
    saveFair(fairData);
    markThreadDone(threadId, action);
    const seasonDataAfter = ensureSeason(fairData, seasonKey);
    const remaining = remainingFair(targetUsers, seasonDataAfter);
    const remLine = targetUsers.length
      ? Object.entries(remaining).map(([u, rem]) => `<@${u}> has ${Math.max(rem,0)} sim strikes left this season`).join('\n')
      : 'Team strike recorded (no coach role members found).';
    const label = action === 'staffstrikeaway' ? 'Staff Strike (Away)' : 'Staff Strike (Home)';
    baseEmbed
      .setTitle(label)
      .setColor(0xED4245)
      .setDescription(`Issued by ${interaction.user}\nTeam: ${targetTeam || 'Unknown'}`)
      .addFields({ name: 'Remaining', value: remLine || 'N/A', inline: false });
    await thread.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    if (targetUsers.length) {
      await sendWarnings(thread, targetUsers, seasonDataAfter, commishMention);
    }
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[game_status] updateFairSimBoard failed', e?.message || e); }
    try { await disableButtons(interaction); } catch {}
    appendMaddenStaffLog({
      type: 'staff_strike',
      guildId: interaction.guildId,
      threadId,
      targetTeam,
      awardedBy: interaction.user.id,
      action,
    });
    await postMaddenStaffLog(
      interaction.client,
      interaction.guildId,
      'Staff Strike Applied',
      `${targetTeam || 'Unknown team'} received a staff-applied strike in <#${threadId}>.`,
    ).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'staff strike applied').catch(() => null);
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
      const waitMsg = 'Game Completed pending. Waiting for the other side to press Game Completed.';
      await interaction.reply({ content: waitMsg, ephemeral: true });
      const otherTeam = side === 'away' ? home : away;
      const otherMentions = await buildCoachMentions(interaction.guild, otherTeam, roleMap);
      const mentionText = [...otherMentions, ...COMMISH_ROLE_IDS.map(id => `<@&${id}>`)].join(' ');
      try { await thread.send({ content: `${mentionText} ${waitMsg}`.trim(), allowedMentions: { parse: ['roles', 'users'] } }); } catch {}
      return;
    }
    clearPendingFair(threadId + ':complete');

    resetConsecutive(userIds, fairData, seasonKey);
    saveFair(fairData);
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
      const waitMsg = 'Fair sim pending. Waiting for the other side to press Fair Sim.';
      await interaction.reply({ content: waitMsg, ephemeral: true });
      const otherTeam = side === 'away' ? home : away;
      const otherMentions = await buildCoachMentions(interaction.guild, otherTeam, roleMap);
      const mentionText = [...otherMentions, ...COMMISH_ROLE_IDS.map(id => `<@&${id}>`)].join(' ');
      try { await thread.send({ content: `${mentionText} ${waitMsg}`.trim(), allowedMentions: { parse: ['roles', 'users'] } }); } catch {}
      return;
    }
    clearPendingFair(threadId);
    const over = fairCountExceeded(userIds, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Fair sim denied: ${names} have already used ${SIM_LIMIT} non-play outcomes (fair sims or force wins) this season. They must play the game.`, ephemeral: true });
      try { await thread.send({ content: `${commishMention || ''} Fair sim denied: ${names} at limit (${SIM_LIMIT}). Game must be played.`.trim() }); } catch {}
      return;
    }
    incrementFair(userIds, fairData, seasonKey, [away, home].filter(Boolean));
    saveFair(fairData);
    markThreadDone(threadId, 'fairsim');
    const remaining = remainingFair(userIds, ensureSeason(fairData, seasonKey));
    const remLine = Object.entries(remaining).map(([u, rem]) => `<@${u}> has ${Math.max(rem,0)} non-play outcomes (fair sims or force wins) left`).join('\n');
    baseEmbed.setTitle('Fair Sim Requested').setColor(0xFEE75C).setDescription(`Requested by ${interaction.user}\nTeams: ${away || 'Away'} vs ${home || 'Home'}`).addFields({ name: 'Fair sim remaining', value: remLine || 'N/A', inline: false });
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
    await interaction.reply({ content: 'Fair sim logged and commish notified. Reminders stopped.', ephemeral: true });
    return;
  }

  if (action === 'homewin' || action === 'awaywin') {
    const chargeUsers = action === 'homewin'
      ? await coachUserIds(interaction.guild, away, roleMap)
      : await coachUserIds(interaction.guild, home, roleMap);
    const over = fairCountExceeded(chargeUsers, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Force win denied: ${names} have already used ${SIM_LIMIT} non-play outcomes (fair sims or force wins)/force-wins this season. They must play the game.`, ephemeral: true });
      try { await thread.send({ content: `${commishMention || ''} Force win denied: ${names} at limit (${SIM_LIMIT}). Game must be played.`.trim() }); } catch {}
      return;
    }
    incrementFair(chargeUsers, fairData, seasonKey, [away, home].filter(Boolean));
    saveFair(fairData);
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
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'force win logged').catch(() => null);
    await interaction.reply({ content: 'Force-win request sent and reminders stopped.', ephemeral: true });
    clearPendingFair(threadId);
    return;
  }
}

export default { customId, execute };
