import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function classIdForSeason(calendarYear) {
  const idx = Math.max(1, (calendarYear || 2025) - 2025 + 1);
  return `cus_${String(idx).padStart(2, '0')}`;
}

function findClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const files = fs.readdirSync(DRAFT_DIR).filter(f => f.toLowerCase().includes(classId.toLowerCase()) && f.toLowerCase().endsWith('.json'));
  if (files.length) return path.join(DRAFT_DIR, files[0]);
  const allJson = fs.readdirSync(DRAFT_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  return allJson.length ? path.join(DRAFT_DIR, allJson[0]) : null;
}

function loadDraftClass(classId) {
  const file = findClassFile(classId);
  if (!file) return null;
  return safeReadJSON(file, null);
}

function formatDev(dev, emojis) {
  const emojiId = emojis?.[dev] ?? emojis?.[String(dev)];
  if (emojiId) return `<:dev_${dev}:${emojiId}>`;
  const map = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
  return map[dev] || 'Normal';
}

export const data = new SlashCommandBuilder()
  .setName('madden-myscouts')
  .setDescription('View the prospects you have scouted this season.')
  .setDMPermission(false);

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-setleague first.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const calendarYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const classId = classIdForSeason(calendarYear);
  const draftData = loadDraftClass(classId);
  if (!draftData) {
    await interaction.reply({ content: `Draft class ${classId} not found. Add a JSON under data/draft_classes/madden.`, ephemeral: true });
    return;
  }

  const scoutData = safeReadJSON(SCOUT_PATH, {});
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});
  const userId = interaction.user.id;
  const userData = scoutData[userId];
  if (!userData || !userData.players || !userData.players[classId]) {
    await interaction.reply({ content: 'You have not scouted any players yet this season.', ephemeral: true });
    return;
  }

  const entries = Object.entries(userData.players[classId]);
  const desc = entries.map(([name, unlocked]) => {
    const p = Object.values(draftData).find(pl => pl.name === name);
    const parts = [];
    if (!p) return null;
    if (unlocked.includes('arch2')) parts.push(`Arch2: ${p.archetype_2 || 'N/A'}`);
    if (unlocked.includes('arch1')) parts.push(`Arch1: ${p.archetype_1 || 'N/A'}`);
    if (unlocked.includes('ovr')) parts.push(`OVR: ${p.overall ?? 'N/A'}`);
    if (unlocked.includes('dev')) parts.push(`Dev: ${formatDev(p.dev_trait, devEmojis)}`);
    const meta = [];
    if (p.position) meta.push(p.position);
    if (p.year) meta.push(p.year);
    if (p.school) meta.push(p.school);
    if (p.height || p.weight) meta.push(`${p.height || 'N/A'} / ${p.weight ? `${p.weight} lbs` : 'N/A'}`);
    const boardPos = p.order ?? p['#'];
    meta.push(`Board #${boardPos || '?'}`);
    return `**${name}** (${meta.join(' • ')})\n${parts.join(' | ') || 'No info unlocked'}`;
  }).filter(Boolean);

  if (!desc.length) {
    await interaction.reply({ content: 'You have not scouted any players yet this season.', ephemeral: true });
    return;
  }

  // Chunk if long
  const chunks = [];
  let current = [];
  let len = 0;
  for (const line of desc) {
    const addLen = line.length + 2;
    if (len + addLen > 3500 && current.length) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += addLen;
  }
  if (current.length) chunks.push(current);

  const embeds = chunks.map((lines, idx) => new EmbedBuilder()
    .setTitle(`Your Scouted Players — ${classId.toUpperCase()}${chunks.length > 1 ? ` (Page ${idx + 1}/${chunks.length})` : ''}`)
    .setDescription(lines.join('\n\n'))
    .setColor(0x1e90ff)
  );

  await interaction.reply({ embeds, ephemeral: true });
}

export default { data, execute };
