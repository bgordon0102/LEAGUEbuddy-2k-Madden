import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

// Button to prompt for in-game date
export const customId = /^set_game_info_/;

// Modal submit handler
export const customId_modal_set_game_info = /^set_game_info_modal_/;

export async function execute(interaction) {
  const threadId = interaction.customId.split('set_game_info_')[1];
  const modal = new ModalBuilder()
    .setCustomId(`set_game_info_modal_${threadId}`)
    .setTitle('Set Game Info')
    .addComponents(
      new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ingame_date')
        .setLabel('In-game date')
        .setPlaceholder('e.g., March 3rd or Nov 12')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
      )
    );
  await interaction.showModal(modal);
}

export async function execute_modal_set_game_info(interaction) {
  const threadId = interaction.customId.replace('set_game_info_modal_', '');
  const dateText = interaction.fields.getTextInputValue('ingame_date')?.trim();
  if (!dateText) {
    await interaction.reply({ content: 'Please provide an in-game date.', ephemeral: true });
    return;
  }

  const message = interaction.message;
  let content = message?.content || '';
  if (content.includes('**In-game date:**')) {
    content = content.replace(/\*\*In-game date:\*\*.*$/m, `**In-game date:** ${dateText}`);
  } else {
    content = `${content}\n**In-game date:** ${dateText}`;
  }

  // Components: keep Set Game Info plus reveal Mark Game Complete
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`set_game_info_${threadId}`)
        .setLabel('Set Game Info')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`game_complete_${threadId}`)
        .setLabel('Mark Game Complete')
        .setStyle(ButtonStyle.Success)
    )
  ];

  try {
    await message.edit({ content, components });
    await interaction.reply({ content: 'Game info set. Mark Game Complete is now available.', ephemeral: true });
  } catch (err) {
    console.error('[set_game_info] Failed to edit message:', err);
    try {
      await interaction.reply({ content: 'Failed to update the thread message.', ephemeral: true });
    } catch {}
  }
}

export default { customId, execute, customId_modal_set_game_info, execute_modal_set_game_info };
