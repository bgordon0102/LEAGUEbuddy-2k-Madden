import { SlashCommandBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';
import { updateAwards } from '../../../madden/awards.js';

export const data = new SlashCommandBuilder()
  .setName('madden-awards')
  .setDescription('View weekly awards (staff-only). Defaults to private; optional public post.')
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number to view (defaults to current week)')
      .setMinValue(1)
  )
  .addBooleanOption(opt =>
    opt.setName('public')
      .setDescription('Post publicly in this channel and tag Ghost Legacy')
  )
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const week = interaction.options.getInteger('week');
  const isPublic = interaction.options.getBoolean('public') || false;
  const roleMap = loadRoleMap();

  try {
    await interaction.deferReply(isPublic ? {} : { flags: 64 });
  } catch (err) {
    if (err?.code === 10062) return;
    console.error('[madden-awards] defer failed:', err);
    try { await interaction.reply({ content: 'Discord temporarily unavailable.', flags: 64 }); } catch {}
    return;
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      return interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    }
  } catch (err) {
    console.error('[madden-awards] role check error:', err);
    return interaction.editReply({ content: 'Error checking permissions.' });
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    return interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
  }

  try {
    await updateAwards(interaction.client, leagueId, week ?? null, { interaction, isPublic });
  } catch (err) {
    console.error('[madden-awards] failed:', err);
    const msg = err?.message || 'Unknown error';
    return interaction.editReply({ content: `Awards failed: ${msg}` });
  }
}

export default { data, execute };
