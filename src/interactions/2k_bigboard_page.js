import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const BIGBOARD_DIRS = [
  path.join(process.cwd(), 'data', 'draft_classes', '2k'),
  path.join(process.cwd(), 'bot', 'draft classes', 'big boards'),
];
const PAGE_SIZE = 15;

function loadBoard() {
  const seasonPath = path.join(process.cwd(), 'data', 'season.json');
  let seasonNo = 1;
  try {
    if (fs.existsSync(seasonPath)) {
      const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      if (seasonData && seasonData.seasonNo) seasonNo = seasonData.seasonNo;
    }
  } catch { /* ignore */ }
  const classString = `CUS${seasonNo.toString().padStart(2, '0')}`;
  for (const dir of BIGBOARD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.includes(classString) && f.toLowerCase().includes('big board') && f.toLowerCase().endsWith('.json'));
    if (files.length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        return Object.values(data).filter(p => p && p.name && (p.position_1 || p.position));
      } catch { /* ignore */ }
    }
  }
  return [];
}

function buildPage(allPlayers, pageIdx) {
  const capped = allPlayers.slice(0, 60);
  const totalPages = Math.max(1, Math.ceil(capped.length / PAGE_SIZE));
  const safeIdx = Math.min(Math.max(pageIdx, 0), totalPages - 1);
  const startIdx = safeIdx * PAGE_SIZE;
  const boardPlayers = capped.slice(startIdx, startIdx + PAGE_SIZE);
  const lines = boardPlayers.map((player, idx) => {
    const pos = player.position_1 || player.position || '';
    const name = player.name || '';
    const team = player.team || player.college || '';
    return `${startIdx + idx + 1}: ${pos} ${name} - ${team}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`📋 Big Board (Page ${safeIdx + 1}/${totalPages})`)
    .setColor(0x1f8b4c)
    .setDescription(lines.join('\n') || 'No players on this page.')
    .setThumbnail('https://cdn.discordapp.com/icons/1153432333259530240/leaguebuddy_logo.png');

  const selectOptions = boardPlayers.map((player, idx) => ({
    label: `${startIdx + idx + 1}. ${player.name}`,
    description: `${player.position_1 || player.position} - ${player.team || player.college}`,
    value: player.name
  }));
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`2k_bigboard_select_${safeIdx}`)
    .setPlaceholder(`Select a player (${startIdx + 1}-${startIdx + boardPlayers.length})`)
    .addOptions(selectOptions)
    .setMinValues(1)
    .setMaxValues(1);
  const selectRow = new ActionRowBuilder().addComponents(selectMenu);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`2k_bigboard_page_${safeIdx}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safeIdx <= 0),
    new ButtonBuilder()
      .setCustomId(`2k_bigboard_page_${safeIdx + 2}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safeIdx >= totalPages - 1)
  );
  return { embed, rows: [selectRow, navRow] };
}

export const customId = /^2k_bigboard_page_(\d+)$/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  const match = interaction.customId.match(customId);
  if (!match) return;
  const target = Number(match[1]) - 1; // we encoded next as +2, prev as current
  const players = loadBoard();
  if (!players.length) {
    await interaction.update({ content: 'No big board found.', embeds: [], components: [] });
    return;
  }
  const page = buildPage(players, target);
  await interaction.update({ embeds: [page.embed], components: page.rows });
}

export default { execute, customId };
