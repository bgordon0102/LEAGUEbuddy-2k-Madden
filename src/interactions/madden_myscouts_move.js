import { buildPagesForUser, buildMyScoutsComponents, saveBoardOrder, updateBoardUiState } from '../madden/coach/myscouts.js';

export const customId = /^madden_myscouts_move\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  // madden_myscouts_move|userId|classKey|pageIdx|action
  if (parts.length < 5) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  const pageIdx = Number(parts[3]);
  const action = parts[4];
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }

  const { pages, error, order, activeName, seasonKey } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  if (!activeName || !order.includes(activeName)) {
    await interaction.update({ content: 'Select a player first.', embeds: [], components: [] });
    return;
  }
  const idx = order.indexOf(activeName);
  let newIdx = idx;
  if (action === 'up' && idx > 0) newIdx = idx - 1;
  if (action === 'down' && idx < order.length - 1) newIdx = idx + 1;
  if (action === 'top') newIdx = 0;
  if (action === 'bottom') newIdx = order.length - 1;
  if (newIdx !== idx) {
    const newOrder = [...order];
    newOrder.splice(idx, 1);
    newOrder.splice(newIdx, 0, activeName);
    saveBoardOrder(targetUserId, classKey, newOrder, seasonKey);
  }
  updateBoardUiState(targetUserId, classKey, { activeName }, seasonKey);
  const rebuilt = buildPagesForUser(targetUserId, interaction.guildId);
  const pages2 = rebuilt.pages;
  const order2 = rebuilt.order;
  const newPos = order2.indexOf(activeName);
  const perPage = 10;
  const newPageIdx = Math.floor(newPos / perPage);
  const embeds = [pages2[newPageIdx].embed];
  const components = buildMyScoutsComponents(newPageIdx, pages2, targetUserId, classKey, activeName);
  await interaction.update({ embeds, components });
}

export default { customId, execute };
