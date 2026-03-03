import { buildPagesForUser } from '../madden/coach/myscouts.js';
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';

export const customId = /^madden_myscouts_page\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  if (parts.length < 3) return;
  const targetUserId = parts[1];
  const pageIdx = Number(parts[2]);
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }
  const { pages, error } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  const total = pages.length;
  const idx = Math.max(0, Math.min(total - 1, pageIdx));

  const rowNeeded = total > 1;
  const row = rowNeeded ? new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_myscouts_page|${targetUserId}|${idx - 1}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idx <= 0),
    new ButtonBuilder()
      .setCustomId(`madden_myscouts_page|${targetUserId}|${idx + 1}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(idx >= total - 1),
  ) : null;

  await interaction.update({
    embeds: [pages[idx].embed],
    components: row ? [row] : [],
  });
}

export default { customId, execute };
