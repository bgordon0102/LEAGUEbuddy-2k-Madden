import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function normalize(name) {
  if (!name) return name;
  let out = name.replace(/-w\d+/i, '').replace(/-/g, ' ').replace(/\s+-\s+w\d+/i, '').trim();
  const lower = out.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') out = 'Giants';
  if (lower === 'pack' || lower === 'packers') out = 'Packers';
  if (lower === 'jags') out = 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') out = 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') out = 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs' || lower === 'buccaneers') out = 'Buccaneers';
  if (lower === 'pats' || lower === 'patriots') out = 'Patriots';
  if (lower === 'bolts' || lower === 'chargers') out = 'Chargers';
  return out;
}

function slug(str) {
  return (str || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
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
  const parts = base.split(/\s+/);
  const last = parts[parts.length - 1];
  if (last && roleMap[`${last} Coach`]) return roleMap[`${last} Coach`];
  // Fallback: fuzzy match against role names
  const target = base.toLowerCase();
  const matchKey = Object.keys(roleMap).find(k => {
    const lower = k.toLowerCase();
    return lower.endsWith(' coach') && (lower.includes(target) || target.includes(lower.replace(' coach', '')));
  });
  if (matchKey) return roleMap[matchKey];
  return null;
}

export const data = new SlashCommandBuilder()
  .setName('madden-remindgame')
  .setDescription('Send reminders to all open Madden game threads (Commish/Co-Commish only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadRoleMap();
  const channelMap = loadChannelMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Madden Commish/Co-Commish can use this command.' });
    return;
  }
  const gameThreadsChannelId = channelMap['Game threads'];
  if (!gameThreadsChannelId) {
    await interaction.editReply({ content: 'Game threads channel not configured.' });
    return;
  }
  const parent = interaction.guild.channels.cache.get(gameThreadsChannelId) || await interaction.guild.channels.fetch(gameThreadsChannelId).catch(() => null);
  if (!parent || !parent.threads) {
    await interaction.editReply({ content: 'Could not load game threads channel.' });
    return;
  }

  const active = await parent.threads.fetchActive();
  const archived = await parent.threads.fetchArchived({ limit: 50 }).catch(() => ({ threads: [] }));
  const threads = [...active.threads.values(), ...(archived.threads ? archived.threads.values() : [])];

  let sent = 0;
  for (const thread of threads) {
    if (!/vs/i.test(thread.name)) continue;
    // Skip if already marked complete
    try {
      const recent = await thread.messages.fetch({ limit: 20 });
      const done = recent.some(m => m.author.id === interaction.client.user.id && m.embeds.some(e => (e.title || '').toLowerCase().includes('game completed')));
      if (done) continue;
      const match = thread.name.match(/(.+)\s+vs\s+(.+)(?:\s+-\s+w\d+)?/i);
      if (!match) continue;
      const awayName = match[1];
      const homeName = match[2];
      const awayRole = findCoachRoleId(awayName, roleMap);
      const homeRole = findCoachRoleId(homeName, roleMap);
      const mentions = new Set();
      if (awayRole) mentions.add(`<@&${awayRole}>`);
      if (homeRole) mentions.add(`<@&${homeRole}>`);
      const content = Array.from(mentions).join(' ');
      const embed = {
        title: 'Game Reminder',
        description: 'Please play your game!',
        color: 0x00b0f4,
      };
      await thread.send({ content: content || null, embeds: [embed] });
      sent++;
    } catch {
      continue;
    }
  }
  await interaction.editReply({ content: sent ? `Reminders sent to ${sent} open game thread(s).` : 'No open game threads needed reminders.' });
}

export default { data, execute };
