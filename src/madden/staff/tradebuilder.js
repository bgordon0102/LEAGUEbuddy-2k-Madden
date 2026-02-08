import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

export const data = new SlashCommandBuilder()
  .setName('madden-tradebuilder')
  .setDescription('Post a Trade Builder start button (staff only).')
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.reply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.', ephemeral: true });
    return;
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('trade_builder_start')
      .setLabel('Start Trade Builder')
      .setStyle(ButtonStyle.Primary)
  );
  await interaction.reply({
    content: 'Open the Trade Builder to propose a trade.',
    components: [row],
    ephemeral: false,
  });
}

export default { data, execute };
