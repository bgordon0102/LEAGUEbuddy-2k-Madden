import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';
import { clearMaddenRumorState } from '../../shared/madden_rumor_admin.js';
import { brandTitle } from '../../shared/madden_branding.js';

export const data = new SlashCommandBuilder()
  .setName('madden-clearrumors')
  .setDescription('Clear pending rumor reviews, rumor history, and rumor feedback for this league.')
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  await interaction.deferReply({ flags: 64 });

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }

  const summary = await clearMaddenRumorState(interaction.client, interaction.guildId);
  const embed = new EmbedBuilder()
    .setTitle(brandTitle('Rumor State Cleared'))
    .setColor(0xf1c40f)
    .setDescription('Rumor review state was reset for this league.')
    .addFields(
      { name: 'Review cards removed', value: String(summary.clearedReviewCards), inline: true },
      { name: 'Queue items removed', value: String(summary.clearedQueueItems), inline: true },
      { name: 'Staff log entries removed', value: String(summary.clearedStaffLogEntries), inline: true },
      { name: 'Feedback reset', value: summary.clearedFeedback ? 'Yes' : 'No', inline: true },
      { name: 'History reset', value: summary.clearedSchedulerHistory ? 'Yes' : 'No', inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute };
