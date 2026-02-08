import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getTradeDraft } from '../shared/trade_draft_store.js';

export const customId = /^trade_builder_search\|(yours|other)\|/;

export async function execute(interaction) {
  if (!interaction.isButton() || !customId.test(interaction.customId)) return;
  const [, side, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`trade_builder_search_modal|${side}|${draftId}`)
    .setTitle('Search player by name');
  const input = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Enter part of the player name')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export default { customId, execute };
