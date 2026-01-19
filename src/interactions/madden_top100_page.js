import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getTop100Page } from '../madden/top_players.js';

export const customId = /^madden_top100\|(prev|next)\|/;

export async function execute(interaction) {
  try {
    const parts = interaction.customId.split('|');
    const dir = parts[1];
    const currentPage = Number(parts[2] || 1);
    const totalPages = Number(parts[3] || 1);
    const leagueId = parts[4];
    const newPage = dir === 'prev'
      ? Math.max(1, currentPage - 1)
      : Math.min(totalPages, currentPage + 1);
    const { embed, totalPages: freshTotal } = getTop100Page(leagueId, newPage);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_top100|prev|${newPage}|${freshTotal}|${leagueId}`)
        .setLabel('Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(newPage <= 1),
      new ButtonBuilder()
        .setCustomId(`madden_top100|next|${newPage}|${freshTotal}|${leagueId}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(newPage >= freshTotal)
    );
    await interaction.update({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[madden_top100_page] Failed to page:', err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: 'Could not update the Top 100 page.' });
      } else {
        await interaction.reply({ content: 'Could not update the Top 100 page.', flags: 64 });
      }
    } catch { }
  }
}

export default { customId, execute };
