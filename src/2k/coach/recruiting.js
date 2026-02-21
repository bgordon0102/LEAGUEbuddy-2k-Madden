import { SlashCommandBuilder } from 'discord.js';
import { loadRecruiting, buildRecruitingEmbed } from '../helpers/recruiting_helpers.js';

export const data = new SlashCommandBuilder()
  .setName('2k-recruiting')
  .setDescription('View top recruits (10 per page)')
  .setDMPermission(false);

export async function execute(interaction) {
  const recruits = loadRecruiting();
  if (!recruits || !recruits.length) {
    await interaction.reply({ content: 'No recruiting data found.', ephemeral: true });
    return;
  }
  const { embed, row } = buildRecruitingEmbed(0, recruits);
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

export default { data, execute };
