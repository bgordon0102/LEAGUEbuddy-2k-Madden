import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { updateFairSimBoard } from '../shared/2k_fairsim_board.js';

const FAIR_FILE = path.join(process.cwd(), 'data', '2k', 'fairsims.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
const COMMISH_NAMES = ['Ghost Paradise Commish', 'Ghost Paradise Co-Commish'];
const COMMISH_IDS_FALLBACK = ['1460734128935665817', '1460734222238220326'];
const SIM_LIMIT = 5;
const pending = new Map(); // key -> { away: bool, home: bool, staff?: bool }

const decode = (s = '') => decodeURIComponent(s);
const encode = (s = '') => encodeURIComponent(s);
const normalize = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function canonicalTeam(name = '', roleMap = {}) {
  if (!name) return '';
  const teams = Object.keys(roleMap)
    .filter(k => k.endsWith(' Coach'))
    .map(k => k.replace(/\s+Coach$/i, ''));
  const normName = normalize(name);
  // exact mascot match
  const exact = teams.find(t => normalize(t) === normName);
  if (exact) return exact;
  // mascot-only (last word)
  const parts = name.trim().split(/\s+/);
  const mascot = parts.slice(-2).join(' ');
  const mascotOne = parts.slice(-1).join(' ');
  const mascotHit = teams.find(t => {
    const nt = normalize(t);
    return nt === normalize(mascot) || nt === normalize(mascotOne);
  });
  if (mascotHit) return mascotHit;
  // contains overlap
  const contain = teams.find(t => {
    const nt = normalize(t);
    return nt.includes(normName) || normName.includes(nt);
  });
  return contain || name;
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}
function loadFair() { try { return JSON.parse(fs.readFileSync(FAIR_FILE, 'utf8')); } catch { return {}; } }
function saveFair(data) { fs.mkdirSync(path.dirname(FAIR_FILE), { recursive: true }); fs.writeFileSync(FAIR_FILE, JSON.stringify(data, null, 2)); }

function seasonKey() {
  return `year_${new Date().getFullYear()}`;
}

function ensureSeason(fairData, seasonKey) {
  fairData[seasonKey] = fairData[seasonKey] || {};
  const seasonData = fairData[seasonKey];
  seasonData.counts = seasonData.counts || {};
  seasonData.consecutive = seasonData.consecutive || {};
  return seasonData;
}

async function coachUserIds(guild, team, roleMap) {
  if (!team) return [];
  const canon = canonicalTeam(team, roleMap);
  const roleId = roleMap[`${canon} Coach`];
  if (!roleId) return [];
  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return [];
  return [...role.members.keys()];
}

async function mentionSnapshot(thread) {
  let msg = thread?.messages?.cache?.first();
  if (!msg && thread?.messages?.fetch) {
    try {
      const fetched = await thread.messages.fetch({ limit: 5 });
      msg = fetched?.first();
    } catch {/* ignore */}
  }
  if (!msg) return { roleIds: [], userIds: [] };
  return {
    roleIds: [...msg.mentions.roles.keys()],
    userIds: [...msg.mentions.users.keys()],
  };
}

async function membersForRoleIds(guild, roleIds = []) {
  const map = new Map();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    map.set(roleId, [...role.members.keys()]);
  }
  return map;
}

function increment(users, fairData, seasonKey, teams = []) {
  const seasonData = ensureSeason(fairData, seasonKey);
  users.forEach(u => {
    seasonData.counts[u] = (seasonData.counts[u] || 0) + 1;
    seasonData.consecutive[u] = (seasonData.consecutive[u] || 0) + 1;
  });
  teams.forEach(t => {
    const key = `team:${normalize(t)}`;
    seasonData.counts[key] = (seasonData.counts[key] || 0) + 1;
  });
}

function resetConsecutive(users, fairData, seasonKey) {
  const seasonData = ensureSeason(fairData, seasonKey);
  users.forEach(u => { seasonData.consecutive[u] = 0; });
}

function remaining(users, seasonData) {
  const out = {};
  users.forEach(u => { out[u] = SIM_LIMIT - (seasonData.counts?.[u] || 0); });
  return out;
}

function overLimit(users, seasonData) {
  return users.filter(u => (seasonData.counts?.[u] || 0) >= SIM_LIMIT);
}

function setPending(key, side) {
  const entry = pending.get(key) || { away: false, home: false, staff: false };
  entry[side] = true;
  pending.set(key, entry);
  return entry;
}
function clearPending(key) { pending.delete(key); }

function disableButtons(interaction) {
  if (!interaction?.message?.components?.length) return;
  const updatedRows = interaction.message.components.map(row => {
    const newRow = ActionRowBuilder.from(row);
    newRow.components = newRow.components.map(btn => ButtonBuilder.from(btn).setDisabled(true));
    return newRow;
  });
  return interaction.message.edit({ components: updatedRows }).catch(() => {});
}

async function sendStrikeAlerts(thread, users, seasonData, commishMention) {
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

export const customId = /^2k_game_status_(complete|fairsim|teamawin|teambwin|cpu|staffstrikea|staffstrikeb)\|([^|]+)\|([^|]+)\|([^|]+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = interaction.customId.match(customId);
  if (!match) return;
  const [, action, threadId, awayEnc, homeEnc] = match;
  if (interaction.channel?.id !== threadId) {
    await interaction.reply({ content: 'Thread mismatch for this button.', ephemeral: true });
    return;
  }
  let awayTeam = decode(awayEnc);
  let homeTeam = decode(homeEnc);
  // Fallback: derive teams from thread name if encoded values look missing/duplicated
  if (!awayTeam || !homeTeam || awayTeam === homeTeam) {
    const name = interaction.channel?.name || '';
    const m = name.match(/(.+)\s+vs\s+(.+)/i);
    if (m) {
      awayTeam = awayTeam || m[1].trim();
      homeTeam = homeTeam || m[2].trim();
      if (awayTeam === homeTeam) {
        awayTeam = m[1].trim();
        homeTeam = m[2].trim();
      }
    }
  }
  const roleMap = loadRoleMap();
  const commishIds = Array.from(new Set([
    ...COMMISH_NAMES.map(n => roleMap[n]).filter(Boolean),
    ...COMMISH_IDS_FALLBACK,
  ]));
  const commishMention = Array.from(new Set(commishIds)).map(id => `<@&${id}>`).join(' ');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const staffIds = commishIds;
  const isStaff = staffIds.some(id => member.roles.cache.has(id));
  let awayRoles = await coachUserIds(interaction.guild, awayTeam, roleMap);
  let homeRoles = await coachUserIds(interaction.guild, homeTeam, roleMap);
  let mentionData = null;
  let roleMembersMap = null;

  // Fallback: derive coaches from the thread's mentioned roles/users so the opponent can still award
  if ((!awayRoles.length || !homeRoles.length) && interaction.channel?.messages?.cache?.size) {
    mentionData = await mentionSnapshot(interaction.channel);
    roleMembersMap = await membersForRoleIds(interaction.guild, mentionData.roleIds);

    if (!awayRoles.length) {
      if (mentionData.roleIds[0] && roleMembersMap.get(mentionData.roleIds[0])?.length) {
        awayRoles = roleMembersMap.get(mentionData.roleIds[0]);
      } else if (mentionData.userIds?.length) {
        const [first] = mentionData.userIds;
        awayRoles = first ? [first] : [];
      }
    }

    if (!homeRoles.length) {
      if (mentionData.roleIds[1] && roleMembersMap.get(mentionData.roleIds[1])?.length) {
        homeRoles = roleMembersMap.get(mentionData.roleIds[1]);
      } else if (mentionData.userIds?.length) {
        const [, second] = mentionData.userIds;
        if (second) homeRoles = [second];
        // If only one user tagged, leave homeRoles empty so opponent-only rule blocks self-award
      }
    }
  }
  const isAway = awayRoles.includes(member.id);
  const isHome = homeRoles.includes(member.id);

  // permissions
  const allowed = (() => {
    if (isStaff) return true;
    if (action === 'complete' || action === 'fairsim' || action === 'cpu') return isAway || isHome;
    if (action === 'teamawin') return isHome; // opponent (home) can award away win
    if (action === 'teambwin') return isAway; // opponent (away) can award home win
    if (action.startsWith('staffstrike')) return false;
    return false;
  })();
  if (!allowed) {
    await interaction.reply({ content: 'You are not allowed to use this button.', ephemeral: true });
    return;
  }

  const seasonKeyStr = seasonKey();
  const fairData = loadFair();
  const seasonData = ensureSeason(fairData, seasonKeyStr);
  const resolveSideUsers = async (side) => {
    const team = side === 'away' ? awayTeam : homeTeam;
    const primary = await coachUserIds(interaction.guild, team, roleMap);
    if (primary.length) return primary;
    if (!mentionData && interaction.channel) {
      mentionData = await mentionSnapshot(interaction.channel);
      roleMembersMap = await membersForRoleIds(interaction.guild, mentionData.roleIds);
    }
    if (mentionData?.roleIds?.length) {
      const idx = side === 'away' ? 0 : 1;
      const roleId = mentionData.roleIds[idx] || mentionData.roleIds[0];
      const fromRole = roleId ? roleMembersMap?.get(roleId) || [] : [];
      if (fromRole.length) return fromRole;
    }
    return mentionData?.userIds?.length ? [...new Set(mentionData.userIds)] : [];
  };

  const awayUsers = await resolveSideUsers('away');
  const homeUsers = await resolveSideUsers('home');
  const bothUsers = [...new Set([...awayUsers, ...homeUsers])];
  const baseEmbed = new EmbedBuilder().setTimestamp(new Date());

  const notifyOtherPending = async (actionLabel, sidePressed) => {
    const otherTeam = sidePressed === 'away' ? homeTeam : awayTeam;
    const otherUsers = sidePressed === 'away' ? homeUsers : awayUsers;
    const mentionText = [...otherUsers.map(u => `<@${u}>`), ...commishIds.map(id => `<@&${id}>`)].join(' ');
    await interaction.reply({ content: `${actionLabel} pending. Waiting for the other side to press.`, ephemeral: true });
    if (mentionText) {
      try { await interaction.channel.send({ content: `${mentionText} ${actionLabel} pending. Please press to confirm.`.trim(), allowedMentions: { parse: ['users', 'roles'] } }); } catch {}
    }
  };

  // staff strikes
  if (action === 'staffstrikea' || action === 'staffstrikeb') {
    if (!isStaff) {
      await interaction.reply({ content: 'Only staff can issue a strike.', ephemeral: true });
      return;
    }
    const targetUsers = action === 'staffstrikea' ? awayUsers : homeUsers;
    if (!targetUsers.length) {
      await interaction.reply({ content: 'No coach found for that team.', ephemeral: true });
      return;
    }
    const over = overLimit(targetUsers, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Strike denied: ${names} already at ${SIM_LIMIT}/5.`, ephemeral: true });
      try { await interaction.channel.send({ content: `${commishMention} Strike denied: ${names} already at limit.`, allowedMentions: { parse: ['roles'] } }); } catch {}
      return;
    }
    const strikeTeam = canonicalTeam(action === 'staffstrikea' ? awayTeam : homeTeam, roleMap);
    increment(targetUsers, fairData, seasonKeyStr, [strikeTeam]);
    saveFair(fairData);
    const rem = remaining(targetUsers, seasonData);
    const remLine = Object.entries(rem).map(([u, r]) => `<@${u}> has ${Math.max(r, 0)} sim strikes left`).join('\n');
    baseEmbed.setTitle('Staff Strike').setColor(0xED4245).setDescription(`Issued by ${interaction.user}\nTeam: ${action === 'staffstrikea' ? awayTeam : homeTeam}`).addFields({ name: 'Remaining', value: remLine || 'N/A' });
    await interaction.channel.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    await sendStrikeAlerts(interaction.channel, targetUsers, seasonData, commishMention);
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[2k_game_status] board update failed', e?.message || e); }
    await interaction.reply({ content: 'Strike issued.', ephemeral: true });
    try { await disableButtons(interaction); } catch {}
    return;
  }

  // two-step flows
  if (action === 'complete') {
    const side = isAway ? 'away' : isHome ? 'home' : 'staff';
    const key = `${threadId}:complete`;
    const pend = setPending(key, side);
    if (!(pend.away && pend.home)) {
      await notifyOtherPending('Game Completed', side);
      return;
    }
    clearPending(key);
    resetConsecutive(bothUsers, fairData, seasonKeyStr);
    saveFair(fairData);
    baseEmbed.setTitle('Game Completed').setColor(0x57F287).setDescription(`Marked by ${interaction.user}`);
    await interaction.channel.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[2k_game_status] board update failed', e?.message || e); }
    await interaction.reply({ content: 'Marked complete. Reminders stopped.', ephemeral: true });
    try { await disableButtons(interaction); } catch {}
    return;
  }

  if (action === 'fairsim') {
    const side = isAway ? 'away' : isHome ? 'home' : 'staff';
    const pend = setPending(threadId, side);
    if (!(pend.away && pend.home)) {
      await notifyOtherPending('Fair Sim', side);
      return;
    }
    clearPending(threadId);
    const over = overLimit(bothUsers, seasonData);
    if (over.length) {
      const names = over.map(id => `<@${id}>`).join(', ');
      await interaction.reply({ content: `Fair Sim denied: ${names} already at ${SIM_LIMIT}/5.`, ephemeral: true });
      try { await interaction.channel.send({ content: `${commishMention} Fair Sim denied: ${names} at limit.`, allowedMentions: { parse: ['roles'] } }); } catch {}
      return;
    }
    const canonAway = canonicalTeam(awayTeam, roleMap);
    const canonHome = canonicalTeam(homeTeam, roleMap);
    increment(bothUsers, fairData, seasonKeyStr, [canonAway, canonHome]);
    saveFair(fairData);
    const rem = remaining(bothUsers, seasonData);
    const remLine = Object.entries(rem).map(([u, r]) => `<@${u}> has ${Math.max(r, 0)} sim strikes left`).join('\n');
    baseEmbed.setTitle('Fair Sim Logged').setColor(0xFEE75C).setDescription(`Both coaches confirmed.\n${awayTeam} vs ${homeTeam}`).addFields({ name: 'Remaining', value: remLine || 'N/A' });
    await interaction.channel.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    await sendStrikeAlerts(interaction.channel, bothUsers, seasonData, commishMention);
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[2k_game_status] board update failed', e?.message || e); }
    await interaction.reply({ content: 'Fair Sim logged.', ephemeral: true });
    try { await disableButtons(interaction); } catch {}
    return;
  }

  if (action === 'teamawin' || action === 'teambwin') {
    // Losing side gets the strike: away win -> home gets strike; home win -> away gets strike
    const losingSide = action === 'teamawin' ? 'home' : 'away';
    const losingTeamRaw = losingSide === 'home' ? homeTeam : awayTeam;
    const losingTeam = canonicalTeam(losingTeamRaw, roleMap);
    const losingTeamKey = `team:${normalize(losingTeam || '')}`;

    let targetUsers = losingSide === 'home' ? homeUsers : awayUsers;
    if (!targetUsers.length) {
      targetUsers = await resolveSideUsers(losingSide);
    }
    // Always apply a strike: prefer user strikes; fall back to team-level if no users resolved
    let strikeAppliedToUsers = targetUsers.length > 0;

    // Limit check for whichever bucket we will increment
    const overUsers = strikeAppliedToUsers ? overLimit(targetUsers, seasonData) : [];
    const teamCount = seasonData.counts?.[losingTeamKey] || 0;
    if ((strikeAppliedToUsers && overUsers.length) || (!strikeAppliedToUsers && teamCount >= SIM_LIMIT)) {
      const names = strikeAppliedToUsers ? overUsers.map(id => `<@${id}>`).join(', ') : losingTeam || 'Team';
      await interaction.reply({ content: `Force-win denied: ${names} already at ${SIM_LIMIT}/5.`, ephemeral: true });
      try { await interaction.channel.send({ content: `${commishMention} Force-win denied: ${names} at limit.`, allowedMentions: { parse: ['roles'] } }); } catch {}
      return;
    }

    increment(strikeAppliedToUsers ? targetUsers : [], fairData, seasonKeyStr, [losingTeam]);
    saveFair(fairData);
    const winner = action === 'teamawin' ? awayTeam : homeTeam;
    baseEmbed
      .setTitle('Force Win Requested')
      .setColor(0x5865F2)
      .setDescription([
        `Requested by ${interaction.user}`,
        `Winner: ${winner}`,
        `Strike applied to: ${losingTeam || 'Unknown team'}`,
        strikeAppliedToUsers ? '' : '(team-level strike; no coach users resolved)',
      ].filter(Boolean).join('\n'));
    await interaction.channel.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    if (strikeAppliedToUsers) {
      await sendStrikeAlerts(interaction.channel, targetUsers, seasonData, commishMention);
    }
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[2k_game_status] board update failed', e?.message || e); }
    await interaction.reply({ content: 'Force-win logged.', ephemeral: true });
    try { await disableButtons(interaction); } catch {}
    return;
  }

  if (action === 'cpu') {
    baseEmbed.setTitle('CPU Game Logged').setColor(0x5865F2).setDescription(`Marked by ${interaction.user}. No strikes applied.`);
    await interaction.channel.send({ content: commishMention || null, embeds: [baseEmbed], allowedMentions: { parse: ['roles'] } });
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[2k_game_status] board update failed', e?.message || e); }
    await interaction.reply({ content: 'Logged as CPU matchup. No strikes applied.', ephemeral: true });
    try { await disableButtons(interaction); } catch {}
    return;
  }
}

export default { customId, execute };
