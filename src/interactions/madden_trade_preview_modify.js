import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { getTradeDraft } from '../shared/trade_draft_store.js';

export const customId = /^madden_trade_preview_modify\|/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade draft expired or missing. Please resubmit the trade.', ephemeral: true });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId('madden_trade_modal_submit')
    .setTitle('Propose Trade')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('yourTeam')
          .setLabel('Your Team')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(draft.yourTeamRaw || draft.yourTeam || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('otherTeam')
          .setLabel('Other Team')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(draft.otherTeamRaw || draft.otherTeam || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsSent')
          .setLabel('Assets You Send')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(draft.assetsSent || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsReceived')
          .setLabel('Assets You Receive')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(draft.assetsReceived || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Notes')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setValue(draft.notes || '')
      ),
    );
  await interaction.showModal(modal);
}

export default { customId, execute };
