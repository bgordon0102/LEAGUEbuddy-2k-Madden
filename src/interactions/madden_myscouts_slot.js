import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

export const customId = /^madden_myscouts_slot\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  if (parts.length < 4) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  const pageIdx = parts[3];
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This board is not yours.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`madden_myscouts_slot_submit|${targetUserId}|${classKey}|${pageIdx}`)
    .setTitle('Move To Board Slot');

  const input = new TextInputBuilder()
    .setCustomId('slot')
    .setLabel('Board Slot Number')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Example: 7')
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export default { customId, execute };
