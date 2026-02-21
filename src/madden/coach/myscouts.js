import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const LOGO_DIR = path.join(process.cwd(), 'college football logos');

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
  if (!file) return { data: null, resolvedId: classId };
  const data = safeReadJSON(file, null);
  const resolvedId = (() => {
    const base = path.basename(file).toLowerCase();
    const match = base.match(/cus[_ -]?(\d+)/);
    if (match) return `cus_${String(match[1]).padStart(2, '0')}`;
    return classId;
  })();
  return { data, resolvedId };
}

function formatDev(dev, emojis) {
  const emojiId = emojis?.[dev] ?? emojis?.[String(dev)];
  if (emojiId) return `<:dev_${dev}:${emojiId}>`;
  const map = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
  return map[dev] || 'Normal';
}

function hydrateFromLog(userId, classKey) {
  try {
    const log = JSON.parse(fs.readFileSync(SCOUT_LOG_PATH, 'utf8'));
    if (!Array.isArray(log)) return null;
    const userEntries = log.filter(e => e.userId === userId && (e.classId === classKey || e.classId === classKey.toUpperCase()));
    if (!userEntries.length) return null;
    const out = {};
    for (const entry of userEntries) {
      const name = entry.player;
      const cat = entry.unlockedCategory;
      if (!name || !cat) continue;
      if (!out[name]) out[name] = [];
      if (!out[name].includes(cat)) out[name].push(cat);
    }
    return out;
  } catch {
    return null;
  }
}

function getSchoolLogo(school) {
  if (!school) return null;
  const base = school.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  const file = path.join(LOGO_DIR, `${base}.png`);
  if (fs.existsSync(file)) return { attachment: file, name: `${base}.png` };
  return null;
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
  const { data: draftData, resolvedId: resolvedClassId } = loadDraftClass(classId);
  const classKey = resolvedClassId || classId;
  if (!draftData) {
    await interaction.reply({ content: `Draft class ${classKey} not found. Add a JSON under data/draft_classes/madden.`, ephemeral: true });
    return;
  }

  const scoutData = safeReadJSON(SCOUT_PATH, {});
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});
  const userId = interaction.user.id;
  const userData = scoutData[userId];

  // Try current class first, then fall back to the most recent class the user has entries for.
  let playersByClass = userData && userData.players && (userData.players[classKey] || userData.players[classId]);
  if (!playersByClass && userData?.players) {
    const classes = Object.keys(userData.players);
    if (classes.length) {
      // Pick the latest class ID (lexicographically works with cus_XX)
      const latest = classes.sort().pop();
      playersByClass = userData.players[latest];
    }
  }
  // Hydrate from scout log if still empty
  if (!playersByClass) {
    const fromLog = hydrateFromLog(userId, classKey);
    if (fromLog && Object.keys(fromLog).length) {
      if (!scoutData[userId]) scoutData[userId] = { players: {}, weeklyPoints: {} };
      if (!scoutData[userId].players) scoutData[userId].players = {};
      scoutData[userId].players[classKey] = fromLog;
      playersByClass = fromLog;
      // persist backfill
      fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));
    }
  }

  if (!playersByClass) {
    await interaction.reply({ content: 'You have not scouted any players yet this season.', ephemeral: true });
    return;
  }

  const entries = Object.entries(playersByClass);
  const items = entries.map(([name, unlocked]) => {
    const p = Object.values(draftData).find(pl => pl.name === name);
    const parts = [];
    if (!p) return null;
    const hasArch = unlocked.includes('arch') || unlocked.includes('arch1') || unlocked.includes('arch2');
    if (hasArch) parts.push(`Arch: ${p.archetype_1 || p.archetype_2 || 'N/A'}`);
    if (unlocked.includes('ovr')) parts.push(`OVR: ${p.overall ?? 'N/A'}`);
    if (unlocked.includes('dev')) parts.push(`Dev: ${formatDev(p.dev_trait, devEmojis)}`);
    const meta = [];
    if (p.position) meta.push(p.position);
    if (p.jersey) {
      const jerseyNum = p.jersey.toString().replace(/^#+/, '');
      meta.push(`#${jerseyNum}`);
    }
    if (p.year) meta.push(p.year);
    if (p.school) meta.push(p.school);
    if (p.height || p.weight) meta.push(`${p.height || 'N/A'} / ${p.weight ? `${p.weight} lbs` : 'N/A'}`);
    const boardPos = p.RNK ?? p.rank ?? p.order ?? p['#'];
    meta.push(`Board #${boardPos || '?'}`);
    const line = `**${name}** (${meta.join(' • ')})\n${parts.join(' | ') || 'No info unlocked'}`;
    const boardNum = Number(boardPos);
    const boardKey = Number.isFinite(boardNum) ? boardNum : Infinity;
    return { line, boardKey, name };
  }).filter(Boolean);

  // Sort by board position, then name
  items.sort((a, b) => {
    if (a.boardKey !== b.boardKey) return a.boardKey - b.boardKey;
    return (a.name || '').localeCompare(b.name || '');
  });
  const desc = items.map(i => i.line);

  if (!desc.length) {
    await interaction.reply({ content: 'You have not scouted any players yet this season.', ephemeral: true });
    return;
  }

  // Chunk if long
  const chunks = [];
  const logos = [];
  let current = [];
  let len = 0;
  for (const line of desc) {
    const addLen = line.length + 2;
    if (len + addLen > 3500 && current.length) {
      chunks.push(current);
      logos.push(null);
      current = [];
      len = 0;
    }
    current.push(line);
    len += addLen;
  }
  if (current.length) {
    chunks.push(current);
    logos.push(null);
  }

  const embeds = chunks.map((lines, idx) => {
    const embed = new EmbedBuilder()
      .setTitle(`Your Scouted Players — ${classKey.toUpperCase()}${chunks.length > 1 ? ` (Page ${idx + 1}/${chunks.length})` : ''}`)
      .setDescription(lines.join('\n\n'))
      .setColor(0x1e90ff);
    // Add a logo for the first entry on this page if available
    const firstLine = lines[0];
    const school = firstLine?.split('•').map(s => s.trim()).find(m => m && !m.toLowerCase().startsWith('board #') && m.includes(' '));
    const logo = school ? getSchoolLogo(school) : null;
    if (logo) {
      embed.setImage(`attachment://${logo.name}`);
      logos[idx] = logo;
    }
    return embed;
  });

  const files = logos.filter(Boolean).map(l => ({ attachment: l.attachment, name: l.name }));

  await interaction.reply({ embeds, files, ephemeral: true });
}

export default { data, execute };
