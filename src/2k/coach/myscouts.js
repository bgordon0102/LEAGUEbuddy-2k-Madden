import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'scout_points.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', '2k');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function currentClassId() {
  const seasonPath = path.join(process.cwd(), 'data', 'season.json');
  let seasonNo = 1;
  try {
    if (fs.existsSync(seasonPath)) {
      const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      if (seasonData?.seasonNo) seasonNo = seasonData.seasonNo;
    }
  } catch {
    /* ignore */
  }
  return `CUS${String(seasonNo).padStart(2, '0')}`;
}

function findClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const files = fs.readdirSync(DRAFT_DIR).filter(
    (f) => f.toLowerCase().includes(classId.toLowerCase()) && f.toLowerCase().includes('big board') && f.toLowerCase().endsWith('.json')
  );
  if (files.length) return path.join(DRAFT_DIR, files[0]);
  const allJson = fs.readdirSync(DRAFT_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  return allJson.length ? path.join(DRAFT_DIR, allJson[0]) : null;
}

export const data = new SlashCommandBuilder()
  .setName('2k-myscouts')
  .setDescription('View the prospects you have scouted in 2K.')
  .setDMPermission(false);

export async function execute(interaction) {
  const scouts = safeReadJSON(SCOUT_PATH, {});
  const userData = scouts[interaction.user.id];
  const playersScouted = userData?.playersScouted || {};
  if (!Object.keys(playersScouted).length) {
    await interaction.reply({ content: 'You have not scouted any players yet.', ephemeral: true });
    return;
  }

  const classId = currentClassId();
  const classFile = findClassFile(classId);
  if (!classFile) {
    await interaction.reply({ content: `Draft class ${classId} not found under data/draft_classes/2k.`, ephemeral: true });
    return;
  }
  const draftData = safeReadJSON(classFile, {});
  const prospects = Object.values(draftData);

  const items = Object.entries(playersScouted)
    .map(([name, unlocked]) => {
      const p = prospects.find((pl) => (pl.name || '').toLowerCase() === name.toLowerCase());
      if (!p) return null;
      const meta = [];
      if (p.position_1 || p.position) meta.push(p.position_1 || p.position);
      if (p.team || p.college) meta.push(p.team || p.college);
      if (p.height || p.weight) meta.push(`${p.height || 'N/A'} / ${p.weight || 'N/A'}`);
      const board = p.id_number || p.rank || p.order || p.RNK;
      if (board) meta.push(`Board #${board}`);

      const parts = [];
      if (unlocked.includes('build') && p.build) parts.push(`Build: ${p.build}`);
      if (unlocked.includes('draft_score') && p.draft_score != null) parts.push(`Draft Score: ${p.draft_score}`);
      if (unlocked.includes('overall') && p.overall != null) parts.push(`OVR: ${p.overall}`);
      if (unlocked.includes('potential') && p.potential != null) parts.push(`Potential: ${p.potential}`);
      const line = `**${p.name}** (${meta.join(' • ')})\n${parts.join(' | ') || 'No info unlocked'}`;
      const boardKey = Number(board) || Infinity;
      return { line, boardKey, name: p.name };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.boardKey !== b.boardKey) return a.boardKey - b.boardKey;
      return a.name.localeCompare(b.name);
    });

  if (!items.length) {
    await interaction.reply({ content: 'No scouted players found in the current class.', ephemeral: true });
    return;
  }

  const desc = items.map((i) => i.line);
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

  const embeds = chunks.map((lines, idx) =>
    new EmbedBuilder()
      .setTitle(`Your Scouted Players — ${classId}${chunks.length > 1 ? ` (Page ${idx + 1}/${chunks.length})` : ''}`)
      .setDescription(lines.join('\n\n'))
      .setColor(0x1f8b4c)
  );

  await interaction.reply({ embeds, ephemeral: true });
}

export default { data, execute };
