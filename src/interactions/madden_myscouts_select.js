import { buildPagesForUser } from '../madden/coach/myscouts.js';
import { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

function componentsFor(pageIdx, pages, userId, classKey, activeName) {
  const total = pages.length;
  const nav = total > 1 ? new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_myscouts_page|${userId}|${pageIdx - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(pageIdx <= 0),
    new ButtonBuilder().setCustomId(`madden_myscouts_page|${userId}|${pageIdx + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(pageIdx >= total - 1),
  ) : null;

  const moveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|up|${activeName || ''}`).setStyle(ButtonStyle.Secondary).setLabel('↑').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|down|${activeName || ''}`).setStyle(ButtonStyle.Secondary).setLabel('↓').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|top|${activeName || ''}`).setStyle(ButtonStyle.Secondary).setLabel('Top').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|bottom|${activeName || ''}`).setStyle(ButtonStyle.Secondary).setLabel('Bottom').setDisabled(!activeName),
  );

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`madden_myscouts_select|${userId}|${classKey}|${pageIdx}`)
      .setPlaceholder('Pick a player to move')
      .addOptions((pages[pageIdx].players || []).map(p => ({
        label: p.slice(0, 100),
        value: p,
        default: activeName === p,
      })))
      .setMinValues(1)
      .setMaxValues(1)
  );

  const components = [moveRow, selectRow];
  if (nav) components.push(nav);
  return components;
}

export const customId = /^madden_myscouts_select\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  // madden_myscouts_select|userId|classKey|pageIdx
  if (parts.length < 4) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  const pageIdx = Number(parts[3]);
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }
  const selection = interaction.values?.[0];
  const { pages, error } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  const idx = Math.max(0, Math.min(pages.length - 1, pageIdx));
  const embeds = [pages[idx].embed];
  const components = componentsFor(idx, pages, targetUserId, classKey, selection);
  await interaction.update({ embeds, components });
}

export default { customId, execute };
