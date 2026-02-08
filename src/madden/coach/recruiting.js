import { SlashCommandBuilder } from 'discord.js';
import { safeLoadRecruiting, buildRecruitingEmbed } from '../../../madden/helpers/recruiting_helpers.js';

export const data = new SlashCommandBuilder()
  .setName('madden-recruiting')
  .setDescription('View the top high school recruits (private)')
  .setDMPermission(false);

export async function execute(interaction) {
  const recruits = safeLoadRecruiting();
  if (!recruits || !recruits.length) {
    await interaction.reply({ content: 'No recruiting data found.', ephemeral: true });
    return;
  }

  const { embed, row } = buildRecruitingEmbed(0, recruits);
  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

export default { data, execute };
