import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { deriveTeamNeeds } from './mockdraft.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadRoleMap } from '../staff/staffUtils.js';
import { getRecognitionPerkState, inferRecognitionContext } from '../../shared/league_recognition.js';
import { loadScoutStore, saveScoutStore, getScoutSeasonKey, getSeasonScoutUser } from './scout_store.js';
import { coachCommandDescription } from '../../shared/madden_coach_voice.js';

const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const LOGO_DIR = path.join(process.cwd(), 'college football logos');
const POINTS_PER_WEEK = 60; // regular & postseason
const COST_PER_REVEAL = 10;
const OFFSEASON_POINTS = 300; // full offseason pool
const BONUS_INCREMENT = 10;
const MAX_WEEKLY_POINTS = 120;
const FOCUS_PACK_BASE_COST = 5;
const FOCUS_PACK_FOCUS_COST = 4;
// Preferred position order for autocomplete (canonical names)
const POS_ORDER = [
  'QB', 'HB', 'FB',
  'WR', 'TE',
  'LT', 'LG', 'C', 'RG', 'RT',
  'LEDG', 'REDG', 'DT',
  'SAM', 'MIKE', 'WILL',
  'CB', 'FS', 'SS',
  'K', 'P'
];

function normalizePos(pos) {
  return (pos || '').trim().toUpperCase();
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCoachTeam(member, snapshot) {
  const roleMap = loadRoleMap();
  const teamInfos = snapshot?.teams?.leagueTeamInfoList || [];
  const teamCandidates = teamInfos.map((team) => ({
    fullName: getFullTeamName(team, `Team ${team.teamId}`),
    mascot: String(team.displayName || team.nickName || '').trim(),
    city: String(team.cityName || '').trim(),
    abbr: String(team.abbrName || '').trim(),
  }));
  for (const role of member?.roles?.cache?.values?.() || []) {
    for (const [name] of Object.entries(roleMap || {})) {
      if (!/ coach$/i.test(name)) continue;
      if (name !== role.name) continue;
      const base = name.replace(/ coach$/i, '').trim();
      const norm = normalizeName(base);
      const match = teamCandidates.find((team) =>
        [team.fullName, team.mascot, team.city, team.abbr].some((value) => normalizeName(value) === norm));
      if (match) return match.fullName;
    }
  }
  return null;
}

function focusPositionsForNeeds(needs = []) {
  const map = {
    QB: ['QB'],
    OT: ['LT', 'RT'],
    IOL: ['LG', 'C', 'RG'],
    WR: ['WR'],
    TE: ['TE'],
    RB: ['HB', 'RB', 'FB'],
    EDGE: ['LEDG', 'REDG', 'LE', 'RE', 'DE'],
    DT: ['DT'],
    LB: ['SAM', 'MIKE', 'WILL', 'LB', 'MLB', 'ROLB', 'LOLB'],
    CB: ['CB'],
    S: ['FS', 'SS'],
  };
  return [...new Set(needs.flatMap((need) => map[need] || []))];
}

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendScoutLog(entry) {
  let log = [];
  try {
    log = JSON.parse(fs.readFileSync(SCOUT_LOG_PATH, 'utf8'));
    if (!Array.isArray(log)) log = [];
  } catch { log = []; }
  log.push(entry);
  saveJSON(SCOUT_LOG_PATH, log);
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

function findClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const files = fs.readdirSync(DRAFT_DIR).filter(f => f.toLowerCase().includes(classId.toLowerCase()) && f.toLowerCase().endsWith('.json'));
  if (files.length) return path.join(DRAFT_DIR, files[0]);
  // Fallback: pick first json
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

function uniqPositions(draftData) {
  const set = new Set();
  Object.values(draftData || {}).forEach(p => {
    if (p?.position) set.add(normalizePos(p.position));
  });
  const present = Array.from(set);
  const ordered = POS_ORDER.filter(p => present.includes(p));
  const leftovers = present.filter(p => !ordered.includes(p)).sort((a, b) => (a || '').localeCompare(b || ''));
  return [...ordered, ...leftovers];
}

function formatDev(dev, emojis) {
  const emojiId = emojis?.[dev] ?? emojis?.[String(dev)];
  if (emojiId) return `<:dev_${dev}:${emojiId}>`;
  const map = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
  return map[dev] || 'Normal';
}

function nextCategory(unlocked) {
  const order = ['arch', 'ovr', 'dev'];
  return order.find(cat => !unlocked.includes(cat));
}

function getSchoolLogo(school) {
  if (!school) return null;
  const base = school.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  const fileName = `${base.replace(/\s+/g, '_')}.png`;
  const file = path.join(LOGO_DIR, fileName);
  if (fs.existsSync(file)) return { attachment: file, name: fileName };
  return null;
}

export const data = new SlashCommandBuilder()
  .setName('madden-scout')
  .setDescription(coachCommandDescription('scout'))
  .addStringOption(o => o.setName('position').setDescription('Position to filter').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('name').setDescription('Optional name filter').setRequired(false).setAutocomplete(true))
  .setDMPermission(false);

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  // Keep autocomplete fast to avoid Unknown interaction (3s limit)
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = leagueId ? loadLeagueSnapshot(leagueId) : null;
  const classId = classIdForSnapshot(snapshot);
  const { data: draftData, resolvedId: resolvedClassId } = loadDraftClass(classId);
  const focusedOpt = interaction.options.getFocused(true);
  const focusedVal = focusedOpt?.value?.toLowerCase() || '';

  // Position autocomplete
  if (focusedOpt?.name === 'position') {
    const positions = uniqPositions(draftData);
    const choices = positions
      .filter(p => p.toLowerCase().includes(focusedVal))
      .slice(0, 25)
      .map(p => ({ name: p, value: p }));
    try { await interaction.respond(choices); } catch (_) {}
    return;
  }

  // Name autocomplete (filter by selected position if provided)
  const posInput = interaction.options.getString('position');
  const normPos = posInput ? normalizePos(posInput) : null;
  const players = Object.values(draftData || {}).filter(p => {
    const matchPos = normPos ? normalizePos(p.position) === normPos : true;
    const matchName = p?.name?.toLowerCase().includes(focusedVal);
    return matchPos && matchName;
  });
  const choices = players
    .slice(0, 25)
    .map(p => ({
      name: `${p.name}${p.school ? ` (${p.school})` : ''}`,
      value: p.name,
    }));
  try { await interaction.respond(choices); } catch (_) {}
}

export async function execute(interaction) {
  // Defer immediately to prevent interaction expiry; flags=64 for ephemeral-like visibility
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    const payload = { content: 'No league set. Run /madden-setleague first.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const calendarYear = seasonInfo.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const currentWeek = snapshot?.currentWeek ?? seasonInfo.displayWeek ?? 0;
  const seasonWeekType = seasonInfo.seasonWeekType ?? snapshot?.stage ?? 0; // 0=pre,1=reg,2=post,3=off,8=off
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const draftInactive = seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && seasonWeekType !== 1;
  const isRegularOrPost = seasonWeekType === 1 || seasonWeekType === 2;
  const isOffseason = seasonWeekType === 3 || seasonWeekType === 8 || seasonTitle.includes('offseason') || draftInactive || !isRegularOrPost;
  const scoutingOpen = (isRegularOrPost && currentWeek >= 1) || isOffseason;
  if (!scoutingOpen) {
    const payload = { content: 'Scouting opens after the Week 1 regular-season update and stays open through playoffs and offseason.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }

  const classId = classIdForSnapshot(snapshot);
  const { data: draftData, resolvedId: resolvedClassId } = loadDraftClass(classId);
  const classKey = resolvedClassId || classId;
  if (!draftData) {
    const payload = { content: `Draft class ${classKey} not found. Add a JSON under data/draft_classes/madden.` };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }

  const position = interaction.options.getString('position');
  const nameFilter = (interaction.options.getString('name') || '').toLowerCase();
  const normPos = normalizePos(position);
  const players = Object.values(draftData).filter(p => normalizePos(p.position) === normPos && (!nameFilter || p.name?.toLowerCase().includes(nameFilter)));
  if (!players.length) {
    const payload = { content: `No players found for ${position}${nameFilter ? ` matching "${nameFilter}"` : ''}.` };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const player = players[0]; // first match

  const recognitionContext = inferRecognitionContext('madden', interaction.guildId);
  const perkState = recognitionContext?.seasonKey
    ? getRecognitionPerkState({
        guildId: interaction.guildId,
        league: 'madden',
        seasonKey: recognitionContext.seasonKey,
        userId: interaction.user.id,
        weekKey: recognitionContext.weekKey,
      })
    : null;
  const coachTeam = findCoachTeam(interaction.member, snapshot);
  const needsByTeam = deriveTeamNeeds(snapshot);
  const focusNeeds = coachTeam ? (needsByTeam[coachTeam] || []).slice(0, 2) : [];
  const focusPositions = focusPositionsForNeeds(focusNeeds).map(normalizePos);

  // Load scouting data
  const scoutData = loadScoutStore();
  const userId = interaction.user.id;
  const seasonBonusKey = getScoutSeasonKey(snapshot);
  const userData = getSeasonScoutUser(scoutData, userId, seasonBonusKey);
  const seasonBonus = Math.max(0, Number(userData.scoutingBonus || 0));
  const weekKey = isOffseason ? `year_${calendarYear}_offseason_total` : `year_${calendarYear}_week_${currentWeek}`;
  const defaultPoints = isOffseason
    ? OFFSEASON_POINTS
    : Math.min(MAX_WEEKLY_POINTS, POINTS_PER_WEEK + seasonBonus);
  if (userData.weeklyPoints[weekKey] === undefined) {
    userData.weeklyPoints[weekKey] = defaultPoints;
  }
  let pointsLeft = Number(userData.weeklyPoints[weekKey]);
  if (!Number.isFinite(pointsLeft)) pointsLeft = defaultPoints;
  const unlocked = userData.players[classKey]?.[player.name] || [];
  const nextCat = nextCategory(unlocked);
  if (!nextCat) {
    const payload = { content: 'All info already unlocked for this player.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const focusPackActive = Boolean(perkState?.perks?.scoutingFocusPack);
  const isFocusPosition = focusPackActive && focusPositions.includes(normPos);
  const cost = focusPackActive
    ? (isFocusPosition ? FOCUS_PACK_FOCUS_COST : FOCUS_PACK_BASE_COST)
    : COST_PER_REVEAL;
  if (pointsLeft < cost) {
    const payload = { content: `Not enough points. You have ${pointsLeft} left this week and this scout costs ${cost}.` };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const newUnlocked = [...unlocked, nextCat];
  pointsLeft -= cost;
  if (!userData.players[classKey]) userData.players[classKey] = {};
  userData.players[classKey][player.name] = newUnlocked;
  const suggestedStore = userData.suggestedScout?.[classKey]?.[weekKey];
  const suggestedNames = Array.isArray(suggestedStore)
    ? suggestedStore
    : (typeof suggestedStore === 'string' && suggestedStore ? [suggestedStore] : []);
  const suggestedScoutHit = suggestedNames.includes(player.name);
  if (suggestedScoutHit && newUnlocked.length >= 3) {
    const remainingSuggestions = suggestedNames.filter((name) => name !== player.name);
    if (remainingSuggestions.length) userData.suggestedScout[classKey][weekKey] = remainingSuggestions;
    else delete userData.suggestedScout[classKey][weekKey];
  }
  // Ensure new scouted players are appended to the end of the user's board order
  userData.order = userData.order || {};
  userData.order[classKey] = Array.isArray(userData.order[classKey]) ? userData.order[classKey] : [];
  if (!userData.order[classKey].includes(player.name)) {
    userData.order[classKey].push(player.name);
  }
  let awardedBonus = 0;
  if (!isOffseason && pointsLeft === 0 && !userData.scoutingBonusAwardedWeeks[weekKey] && defaultPoints < MAX_WEEKLY_POINTS) {
    const nextBonus = Math.min(MAX_WEEKLY_POINTS - POINTS_PER_WEEK, seasonBonus + BONUS_INCREMENT);
    awardedBonus = Math.max(0, nextBonus - seasonBonus);
    if (awardedBonus > 0) {
      userData.scoutingBonus = nextBonus;
      userData.scoutingBonusAwardedWeeks[weekKey] = true;
      pointsLeft += awardedBonus;
    }
  }
  userData.weeklyPoints[weekKey] = pointsLeft;
  saveScoutStore(scoutData);
  // backend log only
  appendScoutLog({
    ts: Date.now(),
    userId,
    username: interaction.user?.tag || interaction.user?.username || '',
    guildId: interaction.guildId || null,
    classId,
    resolvedClassId: classKey,
    player: player.name,
    position: player.position,
    school: player.school || null,
    boardPosition: player.RNK ?? player.rank ?? player.order ?? player['#'] ?? null,
    archetype: player.archetype_1 || player.archetype_2 || null,
    overall: player.overall ?? null,
    devTrait: player.dev_trait ?? null,
    unlockedCategory: nextCat,
    unlockCount: newUnlocked.length,
    fullyScouted: newUnlocked.length >= 3,
    weekKey,
    seasonYear: calendarYear,
    currentWeek,
    stage: seasonWeekType,
    pointsLeft,
    pointsSpent: cost,
    weeklyAllowance: defaultPoints,
    awardedBonus,
    suggestedScoutHit,
  });

  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});
  const logo = getSchoolLogo(player.school);
  const hasLogo = Boolean(logo);
  const fields = [];
  const order = ['arch', 'ovr', 'dev'];
  order.forEach(cat => {
    if (newUnlocked.includes(cat)) {
      if (cat === 'arch') fields.push(`**Archetype:** ${player.archetype_1 || player.archetype_2 || 'N/A'}`);
      if (cat === 'ovr') fields.push(`**Overall:** ${player.overall ?? 'N/A'}`);
      if (cat === 'dev') fields.push(`**Dev Trait:** ${formatDev(player.dev_trait, devEmojis)}`);
    }
  });
  const yearLabel = player.year ? ` • ${player.year}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`${player.position} ${player.name}${yearLabel}`)
    .setDescription(fields.join('\n') || 'No info unlocked yet.')
    .setFooter({ text: `Used ${cost} pts. ${pointsLeft} pts left ${isOffseason ? 'this offseason (300 total)' : `this week (${Math.min(MAX_WEEKLY_POINTS, POINTS_PER_WEEK + Number(userData.scoutingBonus || 0))})`}. Class ${classKey.toUpperCase()}` })
    .setColor(0x1e90ff);
  const metaFields = [];
  const boardPos = player.RNK ?? player.rank ?? player.order ?? player['#'];
  if (player.jersey) {
    const jerseyNum = player.jersey.toString().replace(/^#+/, '');
    metaFields.push({
      name: 'Jersey',
      value: `#${jerseyNum}`,
      inline: true
    });
  }
  metaFields.push({
    name: 'Board Position',
    value: boardPos ? `#${boardPos}` : 'N/A',
    inline: true
  });
  if (player.height || player.weight) {
    metaFields.push({
      name: 'Ht/Wt',
      value: `${player.height || 'N/A'} / ${player.weight ? `${player.weight} lbs` : 'N/A'}`,
      inline: true
    });
  }
  if (player.school && !hasLogo) metaFields.push({ name: 'Team', value: player.school, inline: true });
  if (metaFields.length) embed.addFields(metaFields);

  const files = [];
  if (logo) {
    files.push({ attachment: logo.attachment, name: logo.name });
    embed.setImage(`attachment://${logo.name}`);
  }
  if (awardedBonus > 0) {
    embed.addFields({
      name: 'Scouting Bonus Earned',
      value: `You used your full weekly scouting pool and unlocked +${awardedBonus} weekly points going forward. New weekly cap: ${Math.min(MAX_WEEKLY_POINTS, POINTS_PER_WEEK + Number(userData.scoutingBonus || 0))}.`,
      inline: false
    });
  }
  if (focusPackActive && focusNeeds.length) {
    embed.addFields({
      name: 'Scouting Focus Pack',
      value: `Your focus pack is live this week. Every reveal costs ${FOCUS_PACK_BASE_COST} instead of ${COST_PER_REVEAL}, and ${focusNeeds.map((need) => need === 'IOL' ? 'interior OL' : need).join(' and ')} cost ${FOCUS_PACK_FOCUS_COST}. ${isFocusPosition ? `This scout hit the focus discount.` : `This scout used the standard discounted rate.`}`,
      inline: false,
    });
  }

  const payload = { embeds: [embed], files };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
  else await interaction.reply({ ...payload, flags: 64 });
}

export default { data, execute, autocomplete };
