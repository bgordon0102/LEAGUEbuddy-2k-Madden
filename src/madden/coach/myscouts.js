import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const LOGO_DIR = path.join(process.cwd(), 'college football logos');
const POINTS_PER_WEEK = 60;
const BONUS_CAP = 60; // additional, so max 120
const TOTAL_CAP = 120;

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

function logClassIdsForUser(userId) {
  try {
    const log = JSON.parse(fs.readFileSync(SCOUT_LOG_PATH, 'utf8'));
    if (!Array.isArray(log)) return [];
    return Array.from(new Set(log.filter(e => e.userId === userId && e.classId).map(e => e.classId.toLowerCase()))).sort();
  } catch {
    return [];
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

function buildPagesForUser(userId, guildId) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  if (!leagueId) return { error: 'No league set. Run /madden-setleague first.' };
  const snapshot = loadLeagueSnapshot(leagueId);
  const calendarYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const currentClassId = classIdForSeason(calendarYear);
  const currentNorm = currentClassId.toLowerCase();

  const scoutData = safeReadJSON(SCOUT_PATH, {});
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});
  const userData = scoutData[userId] || {};
  userData.players = userData.players || {};
  userData.weeklyPoints = userData.weeklyPoints || {};
  userData.bonus = userData.bonus || {};

  const pages = [];

  // Prefer current class; if empty, fall back to latest class with data (still one class only)
  let availableClassKeys = Object.keys(userData.players).sort();
  // If nothing in scout_points yet, seed from scout_log for the latest class this user has entries for
  if (!availableClassKeys.length) {
    const logClasses = logClassIdsForUser(userId);
    const seedClass = logClasses[logClasses.length - 1] || currentNorm;
    const seedFromLog = hydrateFromLog(userId, seedClass);
    if (seedFromLog && Object.keys(seedFromLog).length) {
      userData.players[seedClass] = seedFromLog;
      availableClassKeys = Object.keys(userData.players).sort();
      scoutData[userId] = userData;
      fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));
    }
  }
  if (!availableClassKeys.length) {
    return { error: 'You have not scouted any players yet.' };
  }
  let targetClassId = currentClassId;
  let playersByClass = userData.players[currentClassId] || userData.players[currentNorm];
  if (!playersByClass || !Object.keys(playersByClass).length) {
    const latest = availableClassKeys[availableClassKeys.length - 1];
    if (latest) {
      targetClassId = latest;
      playersByClass = userData.players[latest];
    }
  }

  const { data: draftData, resolvedId } = loadDraftClass(targetClassId);
  if (!draftData) return { error: `Draft class ${targetClassId} not found.` };
  const resolvedClassKey = (resolvedId || targetClassId).toLowerCase();
  if (!playersByClass) playersByClass = userData.players[resolvedClassKey];

  // Merge in any scout_log entries for this class (regular + postseason)
  const logMerge = hydrateFromLog(userId, resolvedClassKey);
  if (logMerge && Object.keys(logMerge).length) {
    playersByClass = { ...(playersByClass || {}), ...logMerge };
    userData.players[resolvedClassKey] = playersByClass;
    userData.players[currentNorm] = userData.players[currentNorm] || playersByClass; // keep under current key too
    fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));
  }
  if (!playersByClass) {
    const fromLog = hydrateFromLog(userId, resolvedClassKey);
    if (fromLog && Object.keys(fromLog).length) {
      userData.players[resolvedClassKey] = fromLog;
      playersByClass = fromLog;
      fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));
    }
  }
  if (!playersByClass || !Object.keys(playersByClass).length) {
    return { error: 'You have not scouted any players yet for the current class.' };
  }

  // Build/ensure ordering list for this class
  userData.order = userData.order || {};
  const orderList = Array.isArray(userData.order[resolvedClassKey]) ? [...userData.order[resolvedClassKey]] : [];
  const names = Object.keys(playersByClass);
  // add any missing names to order list at the end
  names.forEach(n => { if (!orderList.includes(n)) orderList.push(n); });
  // drop any stale names
  const filteredOrder = orderList.filter(n => names.includes(n));
  userData.order[resolvedClassKey] = filteredOrder;
  scoutData[userId] = userData;
  fs.writeFileSync(SCOUT_PATH, JSON.stringify(scoutData, null, 2));

  const entries = filteredOrder.map(name => [name, playersByClass[name]]);
  const items = entries.map(([name, unlocked]) => {
    const p = Object.values(draftData).find(pl => pl.name === name);
    if (!p) return null;
    const parts = [];
    const hasArch = unlocked.includes('arch') || unlocked.includes('arch1') || unlocked.includes('arch2');
    if (hasArch) parts.push(`Arch: ${p.archetype_1 || p.archetype_2 || 'N/A'}`);
    if (unlocked.includes('ovr')) parts.push(`OVR: ${p.overall ?? 'N/A'}`);
    if (unlocked.includes('dev')) parts.push(`Dev: ${formatDev(p.dev_trait, devEmojis)}`);
    const meta = [];
    if (p.position) meta.push(p.position);
    if (p.jersey) meta.push(`#${p.jersey.toString().replace(/^#+/, '')}`);
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

  const desc = items.map(i => i.line);
  const orderedNames = items.map(i => i.name);
  if (!desc.length) return { error: 'You have not scouted any players yet for the current class.' };

  // Chunk by count (10 per page) to keep navigation consistent
  const PAGE_SIZE = 10;
  const classPages = [];
  const classNames = [];
  for (let i = 0; i < desc.length; i += PAGE_SIZE) {
    const slice = desc.slice(i, i + PAGE_SIZE).map((line, idx) => `${i + idx + 1}. ${line}`);
    classPages.push(slice);
    classNames.push(orderedNames.slice(i, i + PAGE_SIZE));
  }

  classPages.forEach((lines, idx) => {
    pages.push({
      embed: new EmbedBuilder()
        .setTitle(`Your Scouted Players — ${resolvedClassKey.toUpperCase()}${classPages.length > 1 ? ` (Page ${idx + 1}/${classPages.length})` : ''}`)
        .setDescription(lines.join('\n\n'))
        .setColor(0x1e90ff),
      players: classNames[idx] || [],
    });
  });

  if (!pages.length) return { error: 'You have not scouted any players yet.' };
  // Points header
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const currentWeek = snapshot?.currentWeek ?? seasonInfo.displayWeek ?? 0;
  const seasonWeekType = seasonInfo.seasonWeekType ?? snapshot?.stage ?? 0;
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const draftInactive = seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && seasonWeekType !== 1;
  const isRegularOrPost = seasonWeekType === 1 || seasonWeekType === 2;
  const isOffseason = seasonWeekType === 3 || seasonWeekType === 8 || seasonTitle.includes('offseason') || draftInactive || !isRegularOrPost;
  const seasonKey = `year_${calendarYear}`;
  const bonus = Math.min(Number(userData.bonus[seasonKey]) || 0, BONUS_CAP);
  const allowance = isOffseason ? 300 : Math.min(POINTS_PER_WEEK + bonus, TOTAL_CAP);
  const weekKey = isOffseason ? `year_${calendarYear}_offseason_total` : `year_${calendarYear}_week_${currentWeek}`;
  const remainingRaw = userData.weeklyPoints[weekKey];
  const remaining = Number.isFinite(remainingRaw) ? Number(remainingRaw) : allowance;

  pages.forEach((p) => {
    const header = `**Points:** ${remaining}/${allowance} (bonus +${bonus}, cap ${TOTAL_CAP})`;
    const desc = p.embed.data.description || '';
    p.embed.setDescription([header, desc].filter(Boolean).join('\n\n'));
  });

  return { pages, classKey: resolvedClassKey, order: filteredOrder };
}

export const data = new SlashCommandBuilder()
  .setName('madden-myscouts')
  .setDescription('View the prospects you have scouted (regular + postseason).')
  .setDMPermission(false);

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ flags: 64 }); } catch (_) {}
  }
  const userId = interaction.user.id;
  const { pages, error, classKey } = buildPagesForUser(userId, interaction.guildId);
  if (error) {
    await interaction.editReply({ content: error, ephemeral: true });
    return;
  }
  const total = pages.length;
  const pageIndex = 0;
  const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder } = await import('discord.js');
  const rowNeeded = total > 1;
  const row = rowNeeded ? new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_myscouts_page|${userId}|${pageIndex - 1}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`madden_myscouts_page|${userId}|${pageIndex + 1}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(total <= 1),
  ) : null;

  const moveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIndex}|up`).setStyle(ButtonStyle.Secondary).setLabel('↑'),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIndex}|down`).setStyle(ButtonStyle.Secondary).setLabel('↓'),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIndex}|top`).setStyle(ButtonStyle.Secondary).setLabel('Top'),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIndex}|bottom`).setStyle(ButtonStyle.Secondary).setLabel('Bottom'),
  );

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`madden_myscouts_select|${userId}|${classKey}|${pageIndex}`)
      .setPlaceholder('Pick a player to move')
      .addOptions((pages[0].players || []).map(p => ({ label: p.slice(0, 100), value: p })))
  );

  await interaction.editReply({
    embeds: [pages[pageIndex].embed],
    components: [moveRow, selectRow].concat(row ? [row] : []),
    ephemeral: true,
  });
}

export { buildPagesForUser };

export default { data, execute };
