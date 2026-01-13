import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];

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
  .addIntegerOption(o => o.setName('week').setDescription('Week number to delete (optional, defaults to current week)').setRequired(false))
  .addStringOption(o =>
    o.setName('playoff_round')
      .setDescription('Playoff round (optional)')
      .setRequired(false)
      .addChoices(
        { name: 'Wildcard', value: 'wildcard' },
        { name: 'Divisional', value: 'divisional' },
        { name: 'Conference Championship', value: 'conference' },
        { name: 'Super Bowl', value: 'superbowl' },
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadJson(ROLE_MAP_FILE);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }
  const playoffRound = interaction.options.getString('playoff_round');
  const playoffMap = {
    wildcard: 19,
    divisional: 20,
    conference: 21,
    superbowl: 23,
  };
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  let week = interaction.options.getInteger('week');
  if (!week && !playoffRound) {
    try {
      const snap = loadLeagueSnapshot(leagueId);
      week = snap?.currentWeek || 1;
    } catch {
      week = 1;
    }
  }
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
    const active = await channel.threads.fetchActive();
    const archived = await channel.threads.fetchArchived();
    const allThreads = new Map([...active.threads, ...archived.threads]);
    let deleted = 0;
    const roundNum = playoffRound ? playoffMap[playoffRound] : null;
    const match = roundNum ? [`P${roundNum}`, `PO-${playoffRound}`] : [`W${week}`];
    for (const [, thread] of allThreads) {
      if (match.some(m => thread.name.includes(m))) {
        await thread.delete('Madden game thread cleanup');
        deleted += 1;
      }
    }
    await interaction.editReply({ content: `Deleted ${deleted} threads for ${roundNum ? `playoff round ${roundNum}` : `week ${week}`}.` });
  } catch (err) {
    if (err.code === 50001) {
      await interaction.editReply({ content: 'Missing access to the Game threads channel. Check bot permissions and channel ID.' });
      return;
    }
    await interaction.editReply({ content: `Failed to delete threads: ${err.message || err}` });
  }
}

export default { data, execute };
