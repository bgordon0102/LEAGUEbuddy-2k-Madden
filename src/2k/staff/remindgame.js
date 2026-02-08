import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', '2k', '2k_channel_ids.json');
const STAFF_ROLES = ['Ghost Paradise Commish', 'Ghost Paradise Co-Commish'];

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function slug(str) {
  return (str || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function normalize(name) {
  if (!name) return name;
  return name.replace(/-w\d+/i, '').replace(/-/g, ' ').trim();
}

function buildRoleSlugMap(roleMap) {
  const m = new Map();
  for (const [name, id] of Object.entries(roleMap || {})) {
    if (!name.toLowerCase().endsWith(' coach')) continue;
    const base = name.replace(/ coach$/i, '');
    m.set(slug(base), id);
  }
  return m;
}

function findCoachRoleId(rawName, roleMap) {
  if (!rawName) return null;
  const base = normalize(rawName);
  const slugMap = buildRoleSlugMap(roleMap);
  const baseSlug = slug(base);
  if (slugMap.has(baseSlug)) return slugMap.get(baseSlug);
  const direct = roleMap[`${base} Coach`];
  if (direct) return direct;
  const target = base.toLowerCase();
  const matchKey = Object.keys(roleMap).find(k => {
    const lower = k.toLowerCase();
    return lower.endsWith(' coach') && (lower.includes(target) || target.includes(lower.replace(' coach', '')));
  });
  if (matchKey) return roleMap[matchKey];
  return null;
}

async function sendReminderToThread(thread, roleMap, client) {
  // Skip if already marked complete
  try {
    const recent = await thread.messages.fetch({ limit: 20 });
    const done = recent.some(m => m.author.id === client.user.id && m.embeds.some(e => (e.title || '').toLowerCase().includes('game completed')));
    if (done) return false;
  } catch { /* ignore */ }

  const rawName = thread.name;
  const cleanedName = rawName.replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
  let team1 = null;
  let team2 = null;
  const vsSplit = cleanedName.split(/\s+vs\s+/i);
  if (vsSplit.length >= 2) {
    team1 = vsSplit[0].replace(/\s+w(?:k)?\d+$/i, '').trim();
    team2 = vsSplit[1].replace(/\s+w(?:k)?\d+$/i, '').trim();
  } else {
    const matchFallback = rawName.match(/(.+?)[\s\-_]+vs[\s\-_]+(.+?)(?:[\s\-_]+w(?:k)?\d+)?$/i);
    if (matchFallback) {
      team1 = matchFallback[1].replace(/[_-]/g, ' ').trim();
      team2 = matchFallback[2].replace(/[_-]/g, ' ').trim();
    }
  }
  if (!team1 || !team2) return false;
  const role1 = findCoachRoleId(team1, roleMap);
  const role2 = findCoachRoleId(team2, roleMap);
  const mentions = new Set();
  if (role1) mentions.add(`<@&${role1}>`);
  if (role2) mentions.add(`<@&${role2}>`);
  const content = Array.from(mentions).join(' ') || 'Reminder: please play your game!';
  const embed = {
    title: 'Game Reminder',
    description: 'Please complete your game and press "Mark Game Complete" when done.',
    color: 0x00b0f4,
  };
  await thread.send({
    content,
    embeds: [embed],
    allowedMentions: { parse: [], roles: [role1, role2].filter(Boolean) }
  });
  return true;
}

export const data = new SlashCommandBuilder()
  .setName('2k-remindgame')
  .setDescription('Send reminders to all open 2K game threads (staff only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      await interaction.editReply({ content: 'Only Ghost Paradise Commish/Co-Commish can use this command.' });
      return;
    }

    const gameThreadsChannelId = channelMap['Game threads'];
    const parent = gameThreadsChannelId
      ? (interaction.guild.channels.cache.get(gameThreadsChannelId) || await interaction.guild.channels.fetch(gameThreadsChannelId).catch(() => null))
      : null;
    if (!parent || !parent.threads) {
      await interaction.editReply({ content: 'Game threads channel not configured or accessible.' });
      return;
    }

    const active = await parent.threads.fetchActive();
    const archived = await parent.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: [] }));
    const threads = [...active.threads.values(), ...(archived.threads ? archived.threads.values() : [])];

    let sent = 0;
    for (const thread of threads) {
      if (!/vs/i.test(thread.name)) continue;
      const didSend = await sendReminderToThread(thread, roleMap, interaction.client);
      if (didSend) sent++;
    }

    await interaction.editReply({ content: sent ? `Reminders sent to ${sent} open game thread(s).` : 'No open game threads needed reminders.' });
  } catch (err) {
    console.error('Error in 2k-remindgame:', err);
    await interaction.editReply({ content: 'Error sending reminders.' });
  }
}

export default { data, execute };
