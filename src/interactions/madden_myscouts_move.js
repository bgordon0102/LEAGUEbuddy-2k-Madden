import fs from 'fs';
import path from 'path';
import { buildPagesForUser } from '../madden/coach/myscouts.js';
import { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');

function saveOrder(userId, classKey, order) {
  const scoutData = (() => {
    try { return JSON.parse(fs.readFileSync(SCOUT_PATH, 'utf8')); } catch { return {}; }
  })();
  const userData = scoutData[userId] || {};
  userData.order = userData.order || {};
  userData.order[classKey] = order;
  scoutData[userId] = userData;
  fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));
}

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

export const customId = /^madden_myscouts_move\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  // madden_myscouts_move|userId|classKey|pageIdx|action|active
  if (parts.length < 6) return;
  const targetUserId = parts[1];
  const classKey = parts[2];
  const pageIdx = Number(parts[3]);
  const action = parts[4];
  const activeName = parts[5] || null;
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }

  const { pages, error, order } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  if (!activeName || !order.includes(activeName)) {
    await interaction.update({ content: 'Select a player first.', embeds: [], components: [] });
    return;
  }
  const idx = order.indexOf(activeName);
  let newIdx = idx;
  if (action === 'up' && idx > 0) newIdx = idx - 1;
  if (action === 'down' && idx < order.length - 1) newIdx = idx + 1;
  if (action === 'top') newIdx = 0;
  if (action === 'bottom') newIdx = order.length - 1;
  if (newIdx !== idx) {
    const newOrder = [...order];
    newOrder.splice(idx, 1);
    newOrder.splice(newIdx, 0, activeName);
    saveOrder(targetUserId, classKey, newOrder);
  }
  const rebuilt = buildPagesForUser(targetUserId, interaction.guildId);
  const pages2 = rebuilt.pages;
  const order2 = rebuilt.order;
  const newPos = order2.indexOf(activeName);
  const perPage = 10;
  const newPageIdx = Math.floor(newPos / perPage);
  const embeds = [pages2[newPageIdx].embed];
  const components = componentsFor(newPageIdx, pages2, targetUserId, classKey, activeName);
  await interaction.update({ embeds, components });
}

export default { customId, execute };
