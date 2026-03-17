import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { deriveTeamNeeds } from './mockdraft.js';
import { loadScoutStore, saveScoutStore, getScoutSeasonKey, getSeasonScoutUser } from './scout_store.js';
import { getRecognitionPerkState, inferRecognitionContext } from '../../shared/league_recognition.js';
import { coachCommandDescription } from '../../shared/madden_coach_voice.js';

const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const LOGO_DIR = path.join(process.cwd(), 'college football logos');
const COACH_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const POINTS_PER_WEEK = 60;
const REVEAL_ORDER = ['arch', 'ovr', 'dev'];
const MAX_WEEKLY_POINTS = 120;

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadScoutData() {
  return loadScoutStore();
}

function saveScoutData(data) {
  saveScoutStore(data || {});
}

function classIdForSnapshot(snapshot) {
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const seasonOrdinal = Number(
    seasonInfo?.seasonYear
    ?? snapshot?.info?.seasonYear
    ?? snapshot?.seasonYear
  );
  if (Number.isFinite(seasonOrdinal) && seasonOrdinal >= 0 && seasonOrdinal < 50) {
    return `cus_${String(seasonOrdinal + 1).padStart(2, '0')}`;
  }
  const calendarYear = Number(seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear || 2025);
  const idx = Math.max(1, calendarYear - 2024);
  return `cus_${String(idx).padStart(2, '0')}`;
}

function normalizeTeamName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getCoachTeam(userId) {
  if (!fs.existsSync(COACH_MAP_PATH)) return null;
  try {
    const map = JSON.parse(fs.readFileSync(COACH_MAP_PATH, 'utf8'));
    return map?.[userId] || null;
  } catch {
    return null;
  }
}

function resolveTeamNeedsForCoach(userId, snapshot) {
  const teamName = getCoachTeam(userId);
  if (!teamName) return [];
  const needsByTeam = deriveTeamNeeds(snapshot);
  const target = normalizeTeamName(teamName);
  if (needsByTeam[target]) return needsByTeam[target];
  for (const [key, val] of Object.entries(needsByTeam)) {
    if (key === target || key.includes(target) || target.includes(key)) return val;
  }
  return [];
}

function mapPositionToNeed(posRaw) {
  const pos = String(posRaw || '').toUpperCase();
  if (pos === 'QB') return 'QB';
  if (['HB', 'RB', 'FB', 'TB'].includes(pos)) return 'RB';
  if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 'OL';
  if (pos === 'WR') return 'WR';
  if (pos === 'TE') return 'TE';
  if (['CB'].includes(pos)) return 'CB';
  if (['FS', 'SS'].includes(pos)) return 'S';
  if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(pos)) return 'DT';
  if (['LE', 'RE', 'DE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'LDE', 'RDE'].includes(pos)) return 'EDGE';
  if (['MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL', 'ROLB', 'LOLB', 'OLB'].includes(pos)) return 'LB';
  return 'BPA';
}

function getBoardPosition(player) {
  return Number(player?.RNK ?? player?.rank ?? player?.order ?? player?.['#'] ?? NaN);
}

function stringSeed(value = '') {
  let hash = 0;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function prospectGradeScore(grade) {
  const text = String(grade || '').toUpperCase().trim();
  if (!text) return 0;
  const map = {
    'A+': 20,
    'A': 18,
    'A-': 16,
    'B+': 13,
    'B': 11,
    'B-': 9,
    'C+': 6,
    'C': 4,
    'C-': 2,
    'D+': -1,
    'D': -3,
    'D-': -5,
    'F': -8,
  };
  return map[text] ?? 0;
}

function prospectArchetypeScore(prospect) {
  const arch = String(prospect?.archetype_1 || prospect?.archetype_2 || '').toLowerCase();
  if (!arch) return 0;
  if (/(deep threat|vertical|speed rusher|field general|shutdown|zone hawk|hybrid|power back|pass protector)/.test(arch)) return 8;
  if (/(route runner|scrambler|possession|receiving back|run stopper|power|agile|coverage)/.test(arch)) return 6;
  if (/(slot|elusive|speed|prototype|balanced)/.test(arch)) return 4;
  return 2;
}

function prospectUpsideScore(prospect) {
  const devScore = ({ 3: 28, 2: 20, 1: 10, 0: 0 })[Number(prospect?.dev_trait)] ?? 0;
  const overall = Number(prospect?.overall);
  const overallScore = Number.isFinite(overall) ? Math.max(0, (overall - 67) * 2.4) : 0;
  const gradeScore = prospectGradeScore(prospect?.grade);
  return devScore + overallScore + gradeScore;
}

function prospectNeedFitScore(needIdx, prospect) {
  const positionNeedScore = needIdx === 0 ? 34 : needIdx === 1 ? 24 : needIdx === 2 ? 16 : 0;
  const archScore = prospectArchetypeScore(prospect);
  return positionNeedScore + (needIdx >= 0 ? archScore : 0);
}

function prospectBoardValueScore(board) {
  if (!Number.isFinite(board)) return 18;
  if (board <= 20) return 18;
  if (board <= 60) return 16;
  if (board <= 100) return 14;
  if (board <= 160) return 12;
  if (board <= 220) return 9;
  return 6;
}

function prospectLateBoardUpsideBonus(seed, board, prospect) {
  if (!Number.isFinite(board) || board < 120) return 0;
  const devTrait = Number(prospect?.dev_trait || 0);
  if (devTrait < 1) return 0;
  return seed % 7 === 0 ? 10 : seed % 5 === 0 ? 6 : 0;
}

function prospectVarianceAdjustment(seed, board, prospect) {
  const devTrait = Number(prospect?.dev_trait || 0);
  const gradeScore = prospectGradeScore(prospect?.grade);
  if (seed % 31 === 0 && Number.isFinite(board) && board >= 90) {
    return devTrait >= 1 || gradeScore >= 9 ? 12 : 6;
  }
  if (seed % 43 === 0 && devTrait === 0 && gradeScore <= 4) {
    return 5;
  }
  return 0;
}

const SUGGESTED_SCOUT_WINDOWS = [
  { label: 'Round 1', min: 1, max: 32 },
  { label: 'Round 2', min: 33, max: 64 },
  { label: 'Round 3', min: 65, max: 96 },
  { label: 'Round 4', min: 97, max: 128 },
  { label: 'Round 5', min: 129, max: 170 },
  { label: 'Round 6', min: 171, max: 224 },
  { label: 'Round 7+', min: 225, max: Infinity },
];

function normalizeSuggestedScoutStore(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value) return [value];
  return [];
}

function getSuggestedScoutCandidates(userId, userData, classKey, weekKey, snapshot, draftData, playersByClass, perkEnabled = false) {
  if (!perkEnabled) return [];
  userData.suggestedScout = userData.suggestedScout || {};
  userData.suggestedScout[classKey] = userData.suggestedScout[classKey] || {};
  const storedNames = normalizeSuggestedScoutStore(userData.suggestedScout[classKey][weekKey]);
  const validStored = storedNames
    .map((name) => Object.values(draftData || {}).find((p) => p?.name === name) || null)
    .filter(Boolean)
    .filter((prospect) => {
      const unlocked = playersByClass?.[prospect.name] || [];
      return unlocked.length < REVEAL_ORDER.length;
    });
  if (validStored.length) {
    return validStored;
  }

  const topNeeds = resolveTeamNeedsForCoach(userId, snapshot).slice(0, 3);
  const prospects = Object.values(draftData || {});
  const needUsage = new Map();
  const pickedNames = new Set();
  const picks = [];

  for (let windowIdx = 0; windowIdx < SUGGESTED_SCOUT_WINDOWS.length; windowIdx += 1) {
    const window = SUGGESTED_SCOUT_WINDOWS[windowIdx];
    let best = null;
    let bestScore = -Infinity;
    for (const prospect of prospects) {
      const name = prospect?.name;
      if (!name || pickedNames.has(name)) continue;
      const unlocked = playersByClass?.[name] || [];
      if (unlocked.length >= REVEAL_ORDER.length) continue;
      const board = getBoardPosition(prospect);
      if (Number.isFinite(board) && (board < window.min || board > window.max)) continue;
      const need = mapPositionToNeed(prospect.position);
      const needIdx = topNeeds.indexOf(need);
      const seed = stringSeed(`${userId}|${classKey}|${weekKey}|${window.label}|${name}`);
      const boardScore = prospectBoardValueScore(board);
      const upsideScore = prospectUpsideScore(prospect);
      const needScore = prospectNeedFitScore(needIdx, prospect);
      const partialScore = unlocked.length === 0 ? 6 : unlocked.length === 1 ? 4 : 2;
      const fitScore = need !== 'BPA' ? 8 : 0;
      const lateBoardBonus = prospectLateBoardUpsideBonus(seed, board, prospect);
      const varianceScore = prospectVarianceAdjustment(seed, board, prospect);
      const dudPenalty = seed % 37 === 0 && Number(prospect?.dev_trait || 0) === 0 ? -8 : 0;
      const repeatedNeedPenalty = Math.max(0, (needUsage.get(need) || 0) - 1) * 10;
      const total = needScore + boardScore + upsideScore + partialScore + fitScore + lateBoardBonus + varianceScore + dudPenalty - repeatedNeedPenalty;
      if (total > bestScore) {
        best = prospect;
        bestScore = total;
      }
    }
    if (best?.name) {
      picks.push(best);
      pickedNames.add(best.name);
      const need = mapPositionToNeed(best.position);
      needUsage.set(need, (needUsage.get(need) || 0) + 1);
    }
  }

  if (picks.length) {
    userData.suggestedScout[classKey][weekKey] = picks.map((p) => p.name);
  } else {
    delete userData.suggestedScout[classKey][weekKey];
  }
  return picks;
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

function mergeUnlocked(into, from) {
  const out = { ...(into || {}) };
  for (const [name, unlocked] of Object.entries(from || {})) {
    const merged = new Set([...(out[name] || []), ...(Array.isArray(unlocked) ? unlocked : [])]);
    if (merged.size) out[name] = Array.from(merged);
  }
  return out;
}

function collectCurrentClassPlayers(userId, userData, classKey, draftData, calendarYear) {
  const validNames = new Set(Object.values(draftData || {}).map((p) => p?.name).filter(Boolean));
  let merged = {};

  for (const [storedClassKey, players] of Object.entries(userData.players || {})) {
    if (!players || typeof players !== 'object') continue;
    const filtered = {};
    for (const [name, unlocked] of Object.entries(players)) {
      if (validNames.has(name)) filtered[name] = unlocked;
    }
    merged = mergeUnlocked(merged, filtered);
  }

  try {
    const log = JSON.parse(fs.readFileSync(SCOUT_LOG_PATH, 'utf8'));
    if (Array.isArray(log)) {
      const fromLog = {};
      for (const entry of log) {
        if (entry?.userId !== userId) continue;
        if (Number(entry?.seasonYear) !== Number(calendarYear)) continue;
        if (!validNames.has(entry?.player)) continue;
        if (!entry?.unlockedCategory) continue;
        fromLog[entry.player] = fromLog[entry.player] || [];
        if (!fromLog[entry.player].includes(entry.unlockedCategory)) {
          fromLog[entry.player].push(entry.unlockedCategory);
        }
      }
      merged = mergeUnlocked(merged, fromLog);
    }
  } catch {
    // ignore broken logs
  }

  if (Object.keys(merged).length) {
    userData.players[classKey] = mergeUnlocked(userData.players[classKey] || {}, merged);
  }
  return userData.players[classKey] || {};
}

function getSchoolLogo(school) {
  if (!school) return null;
  const base = school.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  const file = path.join(LOGO_DIR, `${base}.png`);
  if (fs.existsSync(file)) return { attachment: file, name: `${base}.png` };
  return null;
}

function getBoardUi(userData, classKey) {
  userData.boardUi = userData.boardUi || {};
  userData.boardUi[classKey] = userData.boardUi[classKey] || { activeName: null };
  return userData.boardUi[classKey];
}

function buildBoardLine(item, displayIndex) {
  const boardBits = [`#${displayIndex}`];
  const identity = [item.position, item.school, `Board #${item.boardPos || '?'}`].filter(Boolean).join(' • ');
  return `**${boardBits.join(' | ')}**\n**${item.name}** (${identity})\n${item.status}${item.parts.length ? ` | ${item.parts.join(' | ')}` : ' | No info unlocked'}`;
}

export function saveBoardOrder(userId, classKey, order, seasonKey) {
  const scoutData = loadScoutData();
  const userData = getSeasonScoutUser(scoutData, userId, seasonKey || 'year_unknown');
  userData.order[classKey] = order;
  saveScoutData(scoutData);
}

export function updateBoardUiState(userId, classKey, patch = {}, seasonKey) {
  const scoutData = loadScoutData();
  const userData = getSeasonScoutUser(scoutData, userId, seasonKey || 'year_unknown');
  const ui = getBoardUi(userData, classKey);
  Object.assign(ui, patch);
  saveScoutData(scoutData);
  return ui;
}

function buildPagesForUser(userId, guildId) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  if (!leagueId) return { error: 'No league set. Run /madden-setleague first.' };
  const snapshot = loadLeagueSnapshot(leagueId);
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const calendarYear = seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const currentClassId = classIdForSnapshot(snapshot);
  const currentNorm = currentClassId.toLowerCase();
  const seasonKey = getScoutSeasonKey(snapshot);
  const recognitionContext = inferRecognitionContext('madden', guildId);

  const scoutData = loadScoutData();
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});
  const userData = getSeasonScoutUser(scoutData, userId, seasonKey);
  const perkState = recognitionContext?.seasonKey
    ? getRecognitionPerkState({
        guildId,
        league: 'madden',
        seasonKey: recognitionContext.seasonKey,
        userId,
        weekKey: recognitionContext.weekKey,
      })
    : null;

  const pages = [];

  let playersByClass = userData.players[currentClassId] || userData.players[currentNorm];
  if ((!playersByClass || !Object.keys(playersByClass).length)) {
    const seedFromLog = hydrateFromLog(userId, currentNorm);
    if (seedFromLog && Object.keys(seedFromLog).length) {
      userData.players[currentNorm] = seedFromLog;
      playersByClass = seedFromLog;
      saveScoutData(scoutData);
    }
  }

  const { data: draftData, resolvedId } = loadDraftClass(currentClassId);
  if (!draftData) return { error: `Draft class ${currentClassId} not found.` };
  const resolvedClassKey = (resolvedId || currentClassId).toLowerCase();
  playersByClass = collectCurrentClassPlayers(userId, userData, resolvedClassKey, draftData, calendarYear);
  userData.players[currentNorm] = userData.players[currentNorm] || userData.players[resolvedClassKey] || {};
  saveScoutData(scoutData);
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
  saveScoutData(scoutData);

  const currentWeek = snapshot?.currentWeek ?? seasonInfo.displayWeek ?? 0;
  const seasonWeekType = seasonInfo.seasonWeekType ?? snapshot?.stage ?? 0;
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const draftInactive = seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && seasonWeekType !== 1;
  const isRegularOrPost = seasonWeekType === 1 || seasonWeekType === 2;
  const isOffseason = seasonWeekType === 3 || seasonWeekType === 8 || seasonTitle.includes('offseason') || draftInactive || !isRegularOrPost;
  const seasonBonus = Math.max(0, Number(userData.scoutingBonus || 0));
  const allowance = isOffseason ? 300 : Math.min(MAX_WEEKLY_POINTS, POINTS_PER_WEEK + seasonBonus);
  const weekKey = isOffseason ? `year_${calendarYear}_offseason_total` : `year_${calendarYear}_week_${currentWeek}`;
  const remainingRaw = userData.weeklyPoints[weekKey];
  const remaining = Number.isFinite(remainingRaw) ? Number(remainingRaw) : allowance;
  getSuggestedScoutCandidates(
    userId,
    userData,
    resolvedClassKey,
    weekKey,
    snapshot,
    draftData,
    playersByClass,
    Boolean(perkState?.perks?.scoutRecommendation),
  );
  const boardUi = getBoardUi(userData, resolvedClassKey);

  const entries = filteredOrder.map(name => [name, playersByClass[name]]);
  let items = entries.map(([name, unlocked]) => {
    const p = Object.values(draftData).find(pl => pl.name === name);
    if (!p) return null;
    const parts = [];
    const hasArch = unlocked.includes('arch') || unlocked.includes('arch1') || unlocked.includes('arch2');
    if (hasArch) parts.push(`Arch: ${p.archetype_1 || p.archetype_2 || 'N/A'}`);
    if (unlocked.includes('ovr')) parts.push(`OVR: ${p.overall ?? 'N/A'}`);
    if (unlocked.includes('dev')) parts.push(`Dev: ${formatDev(p.dev_trait, devEmojis)}`);
    const meta = [];
    if (p.position) meta.push(p.position);
    if (p.year) meta.push(p.year);
    if (p.school) meta.push(p.school);
    const boardPos = p.RNK ?? p.rank ?? p.order ?? p['#'];
    meta.push(`Board #${boardPos || '?'}`);
    const progress = `${Math.min(unlocked.length, REVEAL_ORDER.length)}/${REVEAL_ORDER.length}`;
    const status = unlocked.length >= REVEAL_ORDER.length ? 'Fully scouted' : `${progress} unlocked`;
    const boardNum = Number(boardPos);
    const boardKey = Number.isFinite(boardNum) ? boardNum : Infinity;
    return {
      name,
      position: p.position || '',
      school: p.school || '',
      boardPos: boardPos || '?',
      boardKey,
      parts,
      unlocked,
      status,
    };
  }).filter(Boolean);

  if (!items.length) return { error: 'You have not scouted any players yet for the current class.' };

  // Chunk by count (10 per page) to keep navigation consistent
  const PAGE_SIZE = 32;
  const classPages = [];
  const classNames = [];
  for (let i = 0; i < items.length; i += PAGE_SIZE) {
    const sliceItems = items.slice(i, i + PAGE_SIZE);
    const slice = sliceItems.map((item, idx) => `${i + idx + 1}. ${buildBoardLine(item, i + idx + 1)}`);
    classPages.push(slice);
    classNames.push(sliceItems.map((item) => item.name));
  }

  classPages.forEach((lines, idx) => {
    const suggestedText = perkState?.perks?.scoutRecommendation
      ? '**Scout Recommendation:** Active in `/madden-draftprimer`. Open that command for the 7-name recommendation board, then come back here to spend scout points.'
      : '**Scout Recommendation:** Buy it in Franchise Hub, then use `/madden-draftprimer` to unlock the board-aware 7-name scout lane.';
    const fullyScouted = entries.filter(([, unlocked]) => Array.isArray(unlocked) && unlocked.length >= REVEAL_ORDER.length).length;
    const bonusLine = isOffseason ? '' : `\n**Weekly Bonus:** +${seasonBonus} (cap ${allowance}/${MAX_WEEKLY_POINTS})`;
    const selectedText = boardUi.activeName ? `\n**Selected:** ${boardUi.activeName}` : '';
    const summary = `**Points:** ${remaining}/${allowance}${bonusLine}\n**Fully Scouted:** ${fullyScouted}/${entries.length}${selectedText}\n${suggestedText}`;
    pages.push({
      embed: new EmbedBuilder()
        .setTitle(`Your Big Board — ${resolvedClassKey.toUpperCase()}${classPages.length > 1 ? ` (Page ${idx + 1}/${classPages.length})` : ''}`)
        .setDescription([summary, lines.join('\n\n')].filter(Boolean).join('\n\n'))
        .setColor(0x1e90ff),
      players: classNames[idx] || [],
    });
  });

  if (!pages.length) return { error: 'You have not scouted any players yet.' };
  scoutData[userId] = userData;
  saveScoutData(scoutData);

  return { pages, classKey: resolvedClassKey, order: filteredOrder, activeName: boardUi.activeName, seasonKey };
}

export function buildMyScoutsComponents(pageIdx, pages, userId, classKey, activeName) {
  const total = pages.length;
  const nav = total > 1 ? new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_myscouts_page|${userId}|${pageIdx - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(pageIdx <= 0),
    new ButtonBuilder().setCustomId(`madden_myscouts_page|${userId}|${pageIdx + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(pageIdx >= total - 1),
  ) : null;

  const moveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|up`).setStyle(ButtonStyle.Secondary).setLabel('Move Up').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|down`).setStyle(ButtonStyle.Secondary).setLabel('Move Down').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|top`).setStyle(ButtonStyle.Secondary).setLabel('Top').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_move|${userId}|${classKey}|${pageIdx}|bottom`).setStyle(ButtonStyle.Secondary).setLabel('Bottom').setDisabled(!activeName),
    new ButtonBuilder().setCustomId(`madden_myscouts_slot|${userId}|${classKey}|${pageIdx}`).setStyle(ButtonStyle.Primary).setLabel('Move To Slot').setDisabled(!activeName),
  );

  const playerSelectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`madden_myscouts_select|${userId}|${classKey}|${pageIdx}`)
      .setPlaceholder('Select a player on this page')
      .addOptions((pages[pageIdx].players || []).map((p) => ({
        label: p.slice(0, 100),
        value: p,
        default: activeName === p,
      })))
      .setMinValues(1)
      .setMaxValues(1),
  );
  return [moveRow, playerSelectRow].concat(nav ? [nav] : []);
}

export const data = new SlashCommandBuilder()
  .setName('madden-myscouts')
  .setDescription(coachCommandDescription('myscouts'))
  .setDMPermission(false);

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ flags: 64 }); } catch (_) {}
  }
  const userId = interaction.user.id;
  const { pages, error, classKey, activeName } = buildPagesForUser(userId, interaction.guildId);
  if (error) {
    await interaction.editReply({ content: error, ephemeral: true });
    return;
  }
  const pageIndex = 0;

  await interaction.editReply({
    embeds: [pages[pageIndex].embed],
    components: buildMyScoutsComponents(pageIndex, pages, userId, classKey, activeName),
    ephemeral: true,
  });
}

export { buildPagesForUser };

export default { data, execute };
