import { buildPagesForUser, buildMyScoutsComponents, updateBoardUiState } from '../madden/coach/myscouts.js';

export const customId = /^madden_myscouts_select\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  // madden_myscouts_select|userId|classKey|pageIdx
  if (parts.length < 4) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  const pageIdx = Number(parts[3]);
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }
  const selection = interaction.values?.[0];
  const { pages, error, seasonKey } = buildPagesForUser(targetUserId, interaction.guildId);
  updateBoardUiState(targetUserId, classKey, { activeName: selection }, seasonKey);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  const idx = Math.max(0, Math.min(pages.length - 1, pageIdx));
  const embeds = [pages[idx].embed];
  const components = buildMyScoutsComponents(idx, pages, targetUserId, classKey, selection);
  await interaction.update({ embeds, components });
}

export default { customId, execute };
