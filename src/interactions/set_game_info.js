import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

console.log('[set_game_info] File loaded and ready');

// Button to prompt for in-game date
export const customId = /^set_game_info_/;

// Modal submit handler id
export const customId_modal_set_game_info = /^set_game_info_modal_/;

// Handles the modal submit for setting game info in a thread
export async function execute_modal_set_game_info(interaction) {
  console.log('[set_game_info] execute_modal_set_game_info called');
  try {
    if (!interaction.isModalSubmit()) return;
    const threadId = interaction.customId.split('set_game_info_')[1] || interaction.customId.replace('set_game_info_modal_', '');
    const dateText = interaction.fields.getTextInputValue('ingame_date')?.trim();
    if (!dateText) {
      console.log('[set_game_info][modal_submit] No dateText provided.', {
        interactionCustomId: interaction?.customId,
        channelId: interaction?.channelId,
        userId: interaction?.user?.id
      });
      try { await interaction.reply({ content: 'Please provide an in-game date.', flags: 64 }); } catch { }
      return;
    }

    let message = interaction.message;
    if (!message && interaction.channel?.messages?.fetchPinned) {
      try {
        const pinned = await interaction.channel.messages.fetchPinned();
        message = pinned.find(m =>
          m.components?.some(row =>
            row.components?.some(btn => btn.customId?.startsWith('set_game_info_'))
          )
        );
      } catch (err) {
        console.error('[set_game_info] Failed to fetch pinned messages:', err);
      }
    }
    if (!message) {
      try {
        message = await interaction.channel.send('Thread game info');
      } catch (err) {
        console.error('[set_game_info] Could not create fallback message:', err);
        try { await interaction.reply({ content: 'Could not update the thread message.', flags: 64 }); } catch { }
        return;
      }
    }
    if (!message) {
      console.log('[set_game_info][modal_submit] No message found or created.', {
        interactionCustomId: interaction?.customId,
        channelId: interaction?.channelId,
        userId: interaction?.user?.id
      });
      try { await interaction.reply({ content: 'Could not find or create the thread message.', flags: 64 }); } catch { }
      return;
    }

    let content = message.content || '';
    if (content.includes('**In-game date:**')) {
      content = content.replace(/(\*\*In-game date:\*\* ?)(.*)/, `**In-game date:** **${dateText}**`);
    } else {
      const welcomeMatch = content.match(/^(Welcome.*?)(\n|$)/);
      if (welcomeMatch) {
        const idx = welcomeMatch[0].length;
        content = content.slice(0, idx) + `\n**In-game date:** **${dateText}**` + content.slice(idx);
      } else {
        content = `${content}\n**In-game date:** **${dateText}**`;
      }
    }

    const components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`game_complete_${threadId}`)
          .setLabel('Mark Game Complete')
          .setStyle(ButtonStyle.Success)
      )
    ];

    console.log('[set_game_info][modal_submit] Editing message:', {
      messageId: message?.id,
      channelId: message?.channelId,
      authorId: message?.author?.id,
      content,
      components
    });
    await message.edit({ content, components });
    await interaction.reply({ content: 'Game info set. Mark Game Complete is now available.', flags: 64 });
  } catch (err) {
    console.error('[set_game_info][modal_submit] Uncaught error:', err, {
      threadId: interaction?.customId,
      dateText: interaction?.fields?.getTextInputValue?.('ingame_date'),
      channelId: interaction?.channelId,
      userId: interaction?.user?.id
    });
    try {
      await interaction.reply({ content: 'Something went wrong while setting game info. Please try again or contact staff.', flags: 64 });
    } catch { }
  }
}

export async function execute(interaction) {
  console.log('[set_game_info] execute called');
  if (!interaction.isButton()) return;
  const threadId = interaction.customId.split('set_game_info_')[1];

  // Show the modal for entering game info
  const modal = new ModalBuilder()
    .setCustomId(`set_game_info_modal_${threadId}`)
    .setTitle('Set Game Info')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ingame_date')
          .setLabel('In-game date')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. March 31st')
      )
    );

  try {
    await interaction.showModal(modal);
  } catch (err) {
    console.error('[set_game_info][button] Failed to show modal:', err);
    try { await interaction.reply({ content: 'Could not open modal.', flags: 64 }); } catch { }
  }
}

export default { customId, execute, customId_modal_set_game_info, execute_modal_set_game_info };
