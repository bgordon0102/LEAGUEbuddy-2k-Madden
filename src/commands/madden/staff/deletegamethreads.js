import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

export const data = new SlashCommandBuilder()
  .setName('madden-deletegamethreads')
  .setDescription('Delete game threads for a given week (staff-only).')
  .addIntegerOption(o => o.setName('week').setDescription('Week number to delete (required)').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadJson(ROLE_MAP_FILE);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Madden Commish/Co-Commish can use this command.' });
    return;
  }
  const week = interaction.options.getInteger('week');
  const threadsChannelId = channelMap['Game threads'];
  if (!threadsChannelId) {
    await interaction.editReply({ content: 'Game threads channel ID not set.' });
    return;
  }
  const channel = await interaction.client.channels.fetch(threadsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.editReply({ content: 'Game threads channel not found or not text-based.' });
    return;
  }
  try {
    const threads = await channel.threads.fetchActive();
    let deleted = 0;
    const match = `W${week}`;
    for (const [, thread] of threads.threads) {
      if (thread.name.includes(match)) {
        await thread.delete('Madden game thread cleanup');
        deleted += 1;
      }
    }
    await interaction.editReply({ content: `Deleted ${deleted} threads for week ${week}.` });
  } catch (err) {
    if (err.code === 50001) {
      await interaction.editReply({ content: 'Missing access to the Game threads channel. Check bot permissions and channel ID.' });
      return;
    }
    await interaction.editReply({ content: `Failed to delete threads: ${err.message || err}` });
  }
}

export default { data, execute };
