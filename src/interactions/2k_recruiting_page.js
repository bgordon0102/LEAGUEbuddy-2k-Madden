import { buildRecruitingEmbed, loadRecruiting } from '../2k/helpers/recruiting_helpers.js';

export const customId = /^2k_recruiting_page_(\d+)$/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  const match = interaction.customId.match(customId);
  if (!match) return;

  const recruits = loadRecruiting();
  if (!recruits || !recruits.length) {
    await interaction.update({ content: 'No recruiting data found.', embeds: [], components: [] });
    return;
  }

  const targetPageNum = Number(match[1]);
  const targetIndex = Math.max(0, targetPageNum - 1);
  const { embed, row } = buildRecruitingEmbed(targetIndex, recruits);

  await interaction.update({ embeds: [embed], components: [row] });
}

export default { execute, customId };
