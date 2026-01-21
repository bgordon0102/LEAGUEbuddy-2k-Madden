import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getTradeDraft } from '../utils/trade_draft_store.js';

export const customId = /^trade_builder_team_search_other\|/;

export async function execute(interaction) {
  if (!interaction.isButton() || !customId.test(interaction.customId)) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`trade_builder_team_search_modal|${draftId}`)
    .setTitle('Type other team');
  const input = new TextInputBuilder()
    .setCustomId('team_query')
    .setLabel('Team name / city / nickname')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export default { customId, execute };
