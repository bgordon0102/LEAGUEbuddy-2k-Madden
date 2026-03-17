import { buildPagesForUser, buildMyScoutsComponents, saveBoardOrder, updateBoardUiState } from '../madden/coach/myscouts.js';

export const customId_slot_submit = /^madden_myscouts_slot_submit\|/;

export async function execute_slot_submit(interaction) {
  const parts = interaction.customId.split('|');
  if (parts.length < 4) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This board is not yours.', ephemeral: true });
    return;
  }

  const rawSlot = interaction.fields.getTextInputValue('slot');
  const desiredSlot = Number(rawSlot);
  if (!Number.isFinite(desiredSlot) || desiredSlot < 1) {
    await interaction.reply({ content: 'Enter a valid board slot number.', ephemeral: true });
    return;
  }

  const { pages, error, order, activeName, seasonKey } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.reply({ content: error, ephemeral: true });
    return;
  }
  if (!activeName || !order.includes(activeName)) {
    await interaction.reply({ content: 'Select a player on your board first.', ephemeral: true });
    return;
  }

  const oldIdx = order.indexOf(activeName);
  const newIdx = Math.min(order.length - 1, Math.max(0, desiredSlot - 1));
  const nextOrder = [...order];
  nextOrder.splice(oldIdx, 1);
  nextOrder.splice(newIdx, 0, activeName);
  saveBoardOrder(targetUserId, classKey, nextOrder, seasonKey);
  updateBoardUiState(targetUserId, classKey, { activeName }, seasonKey);

  const rebuilt = buildPagesForUser(targetUserId, interaction.guildId);
  const targetPageIdx = Math.floor(newIdx / 10);
  await interaction.reply({
    embeds: [rebuilt.pages[targetPageIdx].embed],
    components: buildMyScoutsComponents(targetPageIdx, rebuilt.pages, targetUserId, classKey, activeName),
    ephemeral: true,
  });
}

export default { customId_slot_submit, execute_slot_submit };
