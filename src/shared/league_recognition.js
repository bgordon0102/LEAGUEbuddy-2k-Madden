import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig } from '../../madden/madden_data.js';
import { getSeasonState } from './seasonUtils.js';
import { getCoachAssignmentMap } from './madden_coach_assignments.js';
import { getMaddenSnapshotContext } from './madden_metadata.js';

const STORE_PATH = path.join(process.cwd(), 'data', 'leaguebuddy_recognition.json');
const MADDEN_SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');

export const RECOGNITION_ECONOMY = {
  points: {
    activity: {
      strategy: 1,
      stream: 1,
      frontOffice: 1,
      threadResponse: 1,
      gameCompletedOnTime: 1,
      checklistBonus: 1,
      streak2: 1,
      streak4: 2,
      streak6: 3,
    },
    impact: {
      gameOfWeekWin: 4,
    },
  },
  perks: {
    scoutingFocusPack: { tier: 'impact', cost: 6, label: 'Scouting Focus Pack', effect: 'cuts all scouting costs for the week, with the best price on your top need groups' },
    streakShield: { tier: 'activity', cost: 5, label: 'Streak Shield', effect: 'protects one borderline week from breaking your activity streak' },
    strikeCushion: { tier: 'activity', cost: 8, label: 'Strike Cushion', effect: 'downgrades one determined strike into a lighter fault outcome this week' },
    fairSimCredit: { tier: 'activity', cost: 8, label: 'Fair Sim Credit', effect: 'wipes your fair-sim strike once this week if a game gets simmed' },
    draftWarRoomIntel: { tier: 'impact', cost: 6, label: 'Draft War Room Intel', effect: 'league scout traffic and contested-lane intel in Draft Primer' },
    scoutRecommendation: { tier: 'impact', cost: 4, label: 'Scout Recommendation', effect: 'reveals one premium suggested target on My Scouts for the current class and week' },
    offensiveGamePlan: { tier: 'impact', cost: 6, label: 'Offensive Game Plan', effect: 'premium offense script with matchup, tendency, and counter detail in Game Strategy' },
    defensiveGamePlan: { tier: 'impact', cost: 6, label: 'Defensive Game Plan', effect: 'premium defense script with matchup, tendency, and counter detail in Game Strategy' },
    allGamePlanBundle: { tier: 'impact', cost: 14, label: 'All Game Plan Bundle', effect: 'activates offense, defense, and opponent tendency reports this week at a discount' },
    tendencyBreakdown: { tier: 'impact', cost: 5, label: 'Opponent Tendency Report', effect: 'premium coach-DNA and tendency report in Game Strategy with Madden-specific counters, field leverage, and matchup answers' },
    classTrendIntel: { tier: 'impact', cost: 4, label: 'Class Trend Intel', effect: 'round strength and dev-density intel in Draft Primer' },
    doubleOrNothing: { tier: 'impact', cost: 6, label: 'Double or Nothing', effect: 'pick Activity, Impact, or Legacy. If that lane earns points this week, that weekly gain is matched once.' },
    betBuyout: { tier: 'impact', cost: 5, label: 'Bet Buyout', effect: 'cash out one open sportsbook bet this week for a 50% Impact refund before that game is played' },
  },
  legacy: {
    currentSeason: {
      earlyPlayoffPositioning: { seedMax: 4, amount: 2 },
      divisionLead: { amount: 4 },
      strongSeasonFoundation: { wins: 5, amount: 2 },
      undefeatedRun: { wins: 5, lossesMax: 0, amount: 3 },
      conferenceTopSeed: { seed: 1, amount: 2 },
      awardVolume: { perAwards: 3, max: 3 },
      stopTheSlide: { minLosses: 4, maxWins: 1, amount: 3 },
    },
  },
};

const POINTS = RECOGNITION_ECONOMY.points;
const PERK_COSTS = RECOGNITION_ECONOMY.perks;
const DRAFT_SCOUT_PHASED_PERKS = new Set([]);

export function getRecognitionPerkCatalog() {
  return { ...PERK_COSTS };
}

export function getRecognitionEconomy() {
  return {
    points: JSON.parse(JSON.stringify(RECOGNITION_ECONOMY.points)),
    perks: JSON.parse(JSON.stringify(RECOGNITION_ECONOMY.perks)),
    legacy: JSON.parse(JSON.stringify(RECOGNITION_ECONOMY.legacy)),
  };
}

export function getRecognitionPerksByTier() {
  const grouped = { activity: [], impact: [], legacy: [] };
  for (const [key, perk] of Object.entries(PERK_COSTS)) {
    if (!grouped[perk.tier]) grouped[perk.tier] = [];
    grouped[perk.tier].push(key);
  }
  return grouped;
}

const FRONT_OFFICE_COMMANDS = new Set([
  'madden-scout',
  'madden-myscouts',
  'madden-draftprimer',
  'madden-franchisehub',
  'madden-recruiting',
  'madden-tradeblock',
  '2k-scout',
  '2k-myscouts',
  '2k-recruiting',
  '2k-tradeblock',
  '2k-bigboard',
]);

const STRATEGY_COMMANDS = new Set([
  'madden-gamestrategy',
]);

const STREAM_COMMANDS = new Set([
  'madden-streamlink',
  '2k-streamlink',
]);

function safeReadJSON(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function loadStore() {
  return safeReadJSON(STORE_PATH, {});
}

function saveStore(store) {
  writeJSON(STORE_PATH, store);
}

function ensureRoot(store, guildId, league, seasonKey) {
  if (!store[guildId]) store[guildId] = {};
  if (!store[guildId][league]) store[guildId][league] = { seasons: {} };
  if (!store[guildId][league].seasons[seasonKey]) {
    store[guildId][league].seasons[seasonKey] = {
      users: {},
      gameOfWeek: {},
      backfills: {},
      archivedUsers: {},
    };
  }
  store[guildId][league].seasons[seasonKey].backfills = store[guildId][league].seasons[seasonKey].backfills || {};
  store[guildId][league].seasons[seasonKey].archivedUsers = store[guildId][league].seasons[seasonKey].archivedUsers || {};
  return store[guildId][league].seasons[seasonKey];
}

function ensureUser(seasonRoot, userId) {
  if (!seasonRoot.users[userId]) {
    seasonRoot.users[userId] = {
      activity: 0,
      impact: 0,
      legacy: 0,
      spent: {
        activity: 0,
        impact: 0,
        legacy: 0,
      },
      interactionCount: 0,
      currentStreak: 0,
      bestStreak: 0,
      lastFinalizedWeek: null,
      weeks: {},
      activePerks: {},
      history: [],
    };
  }
  seasonRoot.users[userId].spent = seasonRoot.users[userId].spent || { activity: 0, impact: 0, legacy: 0 };
  seasonRoot.users[userId].activePerks = seasonRoot.users[userId].activePerks || {};
  return seasonRoot.users[userId];
}

function ensureWeek(userState, weekKey) {
  if (!userState.weeks[weekKey]) {
    userState.weeks[weekKey] = {
      checklist: {
        strategy: false,
        stream: false,
        frontOffice: false,
        threadResponse: false,
        gameCompletedOnTime: false,
      },
      awards: {
        strategy: false,
        stream: false,
        frontOffice: false,
        threadResponse: false,
        gameCompletedOnTime: false,
        checklistBonus: false,
        gotwWin: false,
        legacyWeekly: false,
      },
      commandCount: 0,
      finalized: false,
      updatedAt: Date.now(),
    };
  }
  return userState.weeks[weekKey];
}

function awardTier(userState, tier, amount, reason, weekKey) {
  if (!amount) return;
  userState[tier] = Number(userState[tier] || 0) + Number(amount || 0);
  userState.history.push({
    tier,
    amount,
    reason,
    weekKey,
    ts: Date.now(),
  });
  userState.history = userState.history.slice(-120);
}

function perkIsActive(value) {
  if (value === true) return true;
  if (value && typeof value === 'object') return value.active !== false;
  return false;
}

function weekPositiveTierEarnings(userState, weekKey, tier) {
  const history = Array.isArray(userState?.history) ? userState.history : [];
  return history
    .filter((entry) =>
      entry?.weekKey === weekKey &&
      entry?.tier === tier &&
      Number(entry?.amount || 0) > 0 &&
      !String(entry?.reason || '').startsWith('Double or Nothing'))
    .reduce((sum, entry) => sum + Number(entry?.amount || 0), 0);
}

export function awardRecognitionPoints({ guildId, league, seasonKey, userId, tier = 'impact', amount = 0, reason = '', weekKey = null }) {
  if (!guildId || !league || !seasonKey || !userId || !amount) return null;
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  if (weekKey) ensureWeek(userState, weekKey);
  awardTier(userState, tier, amount, reason || 'Recognition award', weekKey);
  saveStore(store);
  return userState;
}

function checklistCount(weekState) {
  return Object.values(weekState?.checklist || {}).filter(Boolean).length;
}

function maybeAwardChecklistBonus(userState, weekState, weekKey) {
  if (!weekState.awards.checklistBonus && checklistCount(weekState) >= 5) {
    weekState.awards.checklistBonus = true;
    awardTier(userState, 'activity', POINTS.activity.checklistBonus, 'Perfect weekly checklist', weekKey);
  }
}

function inferMaddenSeasonWeek(guildId) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  if (!leagueId) return null;
  const snap = safeReadJSON(path.join(MADDEN_SNAPSHOT_DIR, `${leagueId}.json`), null);
  const context = getMaddenSnapshotContext(guildId, { leagueId, snapshot: snap });
  if (!context) return null;
  const weekType = Number(context?.seasonInfo?.seasonWeekType ?? context?.seasonInfo?.seasonWeekTypeId ?? context?.seasonInfo?.weekType ?? 1);
  const weekNumber = Number(context.weekNumber || 0);
  const phase = weekType === 1
    ? (weekNumber <= 4 ? 'early_regular' : weekNumber <= 10 ? 'mid_regular' : 'late_regular')
    : weekType === 2
      ? 'postseason'
      : 'offseason';
  const phaseLabel = phase === 'early_regular'
    ? 'Early Season'
    : phase === 'mid_regular'
      ? 'Midseason'
      : phase === 'late_regular'
        ? 'Stretch Run'
        : phase === 'postseason'
          ? 'Postseason'
          : 'Offseason';
  return {
    leagueId: context.leagueId,
    seasonKey: context.seasonKey,
    weekKey: context.weekKey,
    weekNumber: context.weekNumber,
    phase,
    phaseLabel,
    seasonWeekType: weekType,
  };
}

function getMaddenWeekSideForUser({ guildId, userId, weekKey = null }) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  if (!leagueId || !userId) return null;
  const snap = safeReadJSON(path.join(MADDEN_SNAPSHOT_DIR, `${leagueId}.json`), null);
  if (!snap) return null;
  const weekNumber = weekKey ? Number(String(weekKey).replace(/^week_/, '')) : Number(snap?.currentWeek ?? snap?.info?.careerHubInfo?.seasonInfo?.displayWeek ?? snap?.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? 0);
  if (!weekNumber) return null;
  const assignments = getCoachAssignmentMap({ guildId });
  const teams = assignments?.userToTeams?.get?.(String(userId)) || [];
  if (!teams.length) return null;
  const activeGame = (snap?.schedule?.schedules || []).find((game) =>
    Number(game.stageIndex ?? game.stage ?? 1) === 1 &&
    Number(game.weekIndex ?? -1) === weekNumber - 1 &&
    (
      teams.some((team) => normalizeName(team) === normalizeName(game.awayTeam) || normalizeName(team) === normalizeName(game.awayDisplayName || game.awayTeamName || '')) ||
      teams.some((team) => normalizeName(team) === normalizeName(game.homeTeam) || normalizeName(team) === normalizeName(game.homeDisplayName || game.homeTeamName || ''))
    )
  );
  if (!activeGame) return null;
  const matchesAway = teams.some((team) =>
    normalizeName(team) === normalizeName(activeGame.awayTeam) ||
    normalizeName(team) === normalizeName(activeGame.awayDisplayName || activeGame.awayTeamName || '')
  );
  if (matchesAway) return 'away';
  const matchesHome = teams.some((team) =>
    normalizeName(team) === normalizeName(activeGame.homeTeam) ||
    normalizeName(team) === normalizeName(activeGame.homeDisplayName || activeGame.homeTeamName || '')
  );
  if (matchesHome) return 'home';
  return null;
}

function syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState }) {
  const side = getMaddenWeekSideForUser({ guildId, userId, weekKey });
  if (side === 'home') {
    weekState.checklist.stream = true;
  }
  return side;
}

function infer2kSeasonWeek() {
  const season = getSeasonState() || {};
  const seasonNo = Number(season.seasonNo || 1);
  const currentWeek = Number(season.currentWeek || 0);
  const phase = currentWeek > 0 ? 'regular' : String(season.phase || 'offseason');
  return {
    leagueId: '2k',
    seasonKey: `season_${seasonNo}`,
    weekKey: currentWeek > 0 ? `week_${currentWeek}` : `phase_${String(season.phase || 'offseason')}`,
    weekNumber: currentWeek > 0 ? currentWeek : null,
    phase,
    phaseLabel: currentWeek > 0 ? 'Regular Season' : String(season.phase || 'Offseason'),
  };
}

function perkPhaseGate(perkKey, phase = '') {
  const normalizedPhase = String(phase || '').toLowerCase();
  if (!DRAFT_SCOUT_PHASED_PERKS.has(perkKey)) {
    return { open: true, reason: null };
  }
  if (['late_regular', 'postseason', 'offseason'].includes(normalizedPhase)) {
    return { open: true, reason: null };
  }
  return {
    open: false,
    reason: 'opens in Stretch Run, Postseason, and Offseason when draft/scouting intel has real weekly value',
  };
}

export function inferRecognitionContext(league, guildId) {
  return league === 'madden' ? inferMaddenSeasonWeek(guildId) : infer2kSeasonWeek();
}

export function recordRecognitionCommandUse({ guildId, league, userId, commandName, seasonKey, weekKey }) {
  const context = seasonKey && weekKey ? { seasonKey, weekKey } : inferRecognitionContext(league, guildId);
  if (!guildId || !league || !userId || !context?.seasonKey || !context?.weekKey) return null;
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, context.seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  const weekState = ensureWeek(userState, context.weekKey);
  const streamSide = league === 'madden'
    ? syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey: context.weekKey, weekState })
    : null;
  userState.interactionCount += 1;
  weekState.commandCount += 1;
  weekState.updatedAt = Date.now();

  if (STRATEGY_COMMANDS.has(commandName) && !weekState.awards.strategy) {
    weekState.checklist.strategy = true;
    weekState.awards.strategy = true;
    awardTier(userState, 'activity', POINTS.activity.strategy, 'Used weekly strategy prep', context.weekKey);
  }
  if (STREAM_COMMANDS.has(commandName) && !weekState.awards.stream && streamSide !== 'home') {
    weekState.checklist.stream = true;
    weekState.awards.stream = true;
    awardTier(userState, 'activity', POINTS.activity.stream, 'Posted stream link', context.weekKey);
  }
  if (FRONT_OFFICE_COMMANDS.has(commandName) && !weekState.awards.frontOffice) {
    weekState.checklist.frontOffice = true;
    weekState.awards.frontOffice = true;
    awardTier(userState, 'activity', POINTS.activity.frontOffice, 'Used front-office tool', context.weekKey);
  }
  maybeAwardChecklistBonus(userState, weekState, context.weekKey);
  saveStore(store);
  return weekState;
}

export function recordRecognitionGameOutcome({
  guildId,
  league,
  seasonKey,
  weekKey,
  awayUserIds = [],
  homeUserIds = [],
  awayResponded = false,
  homeResponded = false,
  onTime = false,
  played = false,
}) {
  if (!guildId || !league || !seasonKey || !weekKey) return;
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const applyToUsers = (userIds, responseFlag) => {
    for (const userId of [...new Set((userIds || []).filter(Boolean))]) {
      const userState = ensureUser(seasonRoot, String(userId));
      const weekState = ensureWeek(userState, weekKey);
      if (league === 'madden') syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState });
      weekState.updatedAt = Date.now();
      if (responseFlag && !weekState.awards.threadResponse) {
        weekState.checklist.threadResponse = true;
        weekState.awards.threadResponse = true;
        awardTier(userState, 'activity', POINTS.activity.threadResponse, 'Responded in game thread', weekKey);
      }
      if (played && onTime && !weekState.awards.gameCompletedOnTime) {
        weekState.checklist.gameCompletedOnTime = true;
        weekState.awards.gameCompletedOnTime = true;
        awardTier(userState, 'activity', POINTS.activity.gameCompletedOnTime, 'Finished game on time', weekKey);
      }
      maybeAwardChecklistBonus(userState, weekState, weekKey);
    }
  };
  applyToUsers(awayUserIds, awayResponded);
  applyToUsers(homeUserIds, homeResponded);
  saveStore(store);
}

export function recordRecognitionThreadReply({
  guildId,
  league,
  seasonKey,
  weekKey,
  userId,
}) {
  if (!guildId || !league || !seasonKey || !weekKey || !userId) return null;
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  const weekState = ensureWeek(userState, weekKey);
  if (league === 'madden') syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState });
  weekState.updatedAt = Date.now();
  if (!weekState.awards.threadResponse) {
    weekState.checklist.threadResponse = true;
    weekState.awards.threadResponse = true;
    awardTier(userState, 'activity', POINTS.activity.threadResponse, 'Responded in game thread', weekKey);
    maybeAwardChecklistBonus(userState, weekState, weekKey);
    saveStore(store);
    return weekState;
  }
  saveStore(store);
  return weekState;
}

export function finalizeRecognitionWeek({ guildId, league, seasonKey, weekKey }) {
  if (!guildId || !league || !seasonKey || !weekKey) return [];
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const bonuses = [];
  for (const [userId, userState] of Object.entries(seasonRoot.users || {})) {
    const weekState = ensureWeek(userState, weekKey);
    if (league === 'madden') syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState });
    if (weekState.finalized) continue;
    const completed = checklistCount(weekState);
    const shieldActive = userState.activePerks?.[weekKey]?.streakShield === true;
    const qualified = completed >= 4 || (shieldActive && completed >= 3);
    if (qualified) {
      if (shieldActive && completed < 4) {
        delete userState.activePerks[weekKey].streakShield;
        userState.history.push({
          tier: 'activity',
          amount: 0,
          reason: 'Consumed Streak Shield',
          weekKey,
          ts: Date.now(),
        });
      }
      userState.currentStreak = Number(userState.currentStreak || 0) + 1;
      userState.bestStreak = Math.max(Number(userState.bestStreak || 0), userState.currentStreak);
      if (userState.currentStreak === 2) {
        awardTier(userState, 'activity', POINTS.activity.streak2, '2-week activity streak', weekKey);
        bonuses.push({ userId, bonus: POINTS.activity.streak2, label: '2-week streak' });
      } else if (userState.currentStreak === 4) {
        awardTier(userState, 'activity', POINTS.activity.streak4, '4-week activity streak', weekKey);
        bonuses.push({ userId, bonus: POINTS.activity.streak4, label: '4-week streak' });
      } else if (userState.currentStreak === 6) {
        awardTier(userState, 'activity', POINTS.activity.streak6, '6-week activity streak', weekKey);
        bonuses.push({ userId, bonus: POINTS.activity.streak6, label: '6-week streak' });
      }
    } else {
      userState.currentStreak = 0;
    }
    weekState.finalized = true;
    userState.lastFinalizedWeek = weekKey;
  }
  saveStore(store);
  return bonuses;
}

export function resolveRecognitionWeeklyLegacy({
  guildId,
  league,
  seasonKey,
  weekKey,
  awards = [],
}) {
  if (!guildId || !league || !seasonKey || !weekKey) return [];
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const applied = [];
  for (const award of awards || []) {
    const userId = String(award?.userId || '');
    const amount = Number(award?.amount || 0);
    if (!userId || amount <= 0) continue;
    const userState = ensureUser(seasonRoot, userId);
    const weekState = ensureWeek(userState, weekKey);
    if (weekState.awards.legacyWeekly) continue;
    weekState.awards.legacyWeekly = true;
    awardTier(userState, 'legacy', amount, award?.reason || 'Weekly legacy recognition', weekKey);
    applied.push({ userId, amount, reason: award?.reason || 'Weekly legacy recognition' });
  }
  if (applied.length) saveStore(store);
  return applied;
}

export function resolveRecognitionDoubleOrNothing({ guildId, league, seasonKey, weekKey }) {
  if (!guildId || !league || !seasonKey || !weekKey) return [];
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const outcomes = [];
  let changed = false;
  for (const [userId, userState] of Object.entries(seasonRoot.users || {})) {
    const weekPerks = userState.activePerks?.[weekKey] || {};
    const perkState = weekPerks.doubleOrNothing;
    if (!perkState || typeof perkState !== 'object') continue;
    if (!perkIsActive(perkState) || perkState.resolved === true || !perkState.selectedTier) continue;
    const tier = String(perkState.selectedTier || '');
    const earned = weekPositiveTierEarnings(userState, weekKey, tier);
    if (earned > 0) {
      awardTier(userState, tier, earned, `Double or Nothing hit: ${tier}`, weekKey);
      outcomes.push({ userId, tier, amount: earned, hit: true });
    } else {
      userState.history.push({
        tier: 'impact',
        amount: 0,
        reason: `Double or Nothing missed: ${tier}`,
        weekKey,
        ts: Date.now(),
      });
      userState.history = userState.history.slice(-120);
      outcomes.push({ userId, tier, amount: 0, hit: false });
    }
    perkState.resolved = true;
    perkState.active = false;
    changed = true;
  }
  if (changed) saveStore(store);
  return outcomes;
}

export function setRecognitionGameOfWeek({
  guildId,
  league,
  seasonKey,
  weekKey,
  awayTeam,
  homeTeam,
  awayUserIds = [],
  homeUserIds = [],
  label = null,
}) {
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  seasonRoot.gameOfWeek[weekKey] = {
    awayTeam,
    homeTeam,
    awayKey: normalizeName(awayTeam),
    homeKey: normalizeName(homeTeam),
    awayUserIds: [...new Set((awayUserIds || []).filter(Boolean).map(String))],
    homeUserIds: [...new Set((homeUserIds || []).filter(Boolean).map(String))],
    label: label || `${awayTeam} vs ${homeTeam}`,
    createdAt: Date.now(),
    awardedAt: null,
    winnerTeam: null,
  };
  saveStore(store);
  return seasonRoot.gameOfWeek[weekKey];
}

export function resolveRecognitionGameOfWeek({
  guildId,
  league,
  seasonKey,
  weekKey,
  games = [],
}) {
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const gotw = seasonRoot.gameOfWeek?.[weekKey];
  if (!gotw || gotw.awardedAt) return null;
  const game = (games || []).find((entry) =>
    normalizeName(entry?.awayTeam) === gotw.awayKey &&
    normalizeName(entry?.homeTeam) === gotw.homeKey
  );
  if (!game || !game.played) return null;
  const awayScore = Number(game.awayScore || 0);
  const homeScore = Number(game.homeScore || 0);
  if (awayScore === homeScore) return null;
  const winnerTeam = awayScore > homeScore ? gotw.awayTeam : gotw.homeTeam;
  const winnerUserIds = awayScore > homeScore ? gotw.awayUserIds : gotw.homeUserIds;
  for (const userId of winnerUserIds) {
    const userState = ensureUser(seasonRoot, String(userId));
    const weekState = ensureWeek(userState, weekKey);
    if (weekState.awards.gotwWin) continue;
    weekState.awards.gotwWin = true;
    awardTier(userState, 'impact', POINTS.impact.gameOfWeekWin, 'Game of the Week win', weekKey);
  }
  gotw.winnerTeam = winnerTeam;
  gotw.awardedAt = Date.now();
  saveStore(store);
  return {
    winnerTeam,
    winnerUserIds,
    label: gotw.label,
    points: POINTS.impact.gameOfWeekWin,
  };
}

export function getRecognitionUserSummary({ guildId, league, seasonKey, userId, weekKey = null }) {
  const store = loadStore();
  const seasonRoot = store?.[String(guildId)]?.[league]?.seasons?.[seasonKey];
  const userState = seasonRoot?.users?.[String(userId)] || null;
  if (!userState) return null;
  const weekState = weekKey ? userState.weeks?.[weekKey] || null : null;
  let changed = false;
  if (league === 'madden' && weekKey && weekState) {
    const before = Boolean(weekState.checklist?.stream);
    syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState });
    changed = before !== Boolean(weekState.checklist?.stream);
  }
  if (changed) saveStore(store);
  return { userState, weekState };
}

export function getRecognitionPurchaseReceipts({ guildId, league, seasonKey, userId, weekKey = null, limit = 5 }) {
  const summary = getRecognitionUserSummary({ guildId, league, seasonKey, userId, weekKey });
  const history = Array.isArray(summary?.userState?.history) ? summary.userState.history : [];
  return history
    .filter((entry) => {
      const reason = String(entry?.reason || '');
      if (!reason.startsWith('Activated ')) return false;
      if (weekKey && entry?.weekKey !== weekKey) return false;
      return true;
    })
    .slice()
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0))
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      tier: entry.tier,
      amount: Math.abs(Number(entry.amount || 0)),
      label: String(entry.reason || '').replace(/^Activated\s+/, '').trim(),
      weekKey: entry.weekKey || null,
      ts: Number(entry.ts || 0),
    }));
}

export function getRecognitionLeaderboard({ guildId, league, seasonKey, tier = 'total', limit = 10 }) {
  const store = loadStore();
  const users = Object.entries(store?.[String(guildId)]?.[league]?.seasons?.[seasonKey]?.users || {});
  const rows = users.map(([userId, state]) => ({
    userId,
    activity: Number(state.activity || 0),
    impact: Number(state.impact || 0),
    legacy: Number(state.legacy || 0),
    interactionCount: Number(state.interactionCount || 0),
    total: Number(state.activity || 0) + Number(state.impact || 0) + Number(state.legacy || 0),
    currentStreak: Number(state.currentStreak || 0),
  }));
  rows.sort((a, b) => {
    const diff = Number(b[tier] || 0) - Number(a[tier] || 0);
    if (diff) return diff;
    return b.interactionCount - a.interactionCount;
  });
  return rows.slice(0, Math.max(1, limit));
}

export function getRecognitionGameOfWeek({ guildId, league, seasonKey, weekKey }) {
  const store = loadStore();
  return store?.[String(guildId)]?.[league]?.seasons?.[seasonKey]?.gameOfWeek?.[weekKey] || null;
}

export function applyRecognitionBackfill({
  guildId,
  league,
  seasonKey,
  backfillKey,
  awards = [],
  interactionCounts = {},
  metadata = {},
}) {
  if (!guildId || !league || !seasonKey || !backfillKey) {
    return { ok: false, message: 'Missing recognition backfill context.' };
  }
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  if (seasonRoot.backfills?.[backfillKey]) {
    return {
      ok: false,
      alreadyApplied: true,
      summary: seasonRoot.backfills[backfillKey],
      message: 'This recognition backfill was already applied.',
    };
  }

  const totals = { activity: 0, impact: 0, legacy: 0 };
  const affectedUsers = new Set();
  let historyEntries = 0;

  for (const award of awards || []) {
    const userId = String(award?.userId || '');
    const tier = String(award?.tier || '');
    const amount = Number(award?.amount || 0);
    if (!userId || !['activity', 'impact', 'legacy'].includes(tier) || amount <= 0) continue;
    const userState = ensureUser(seasonRoot, userId);
    if (award?.weekKey) ensureWeek(userState, award.weekKey);
    awardTier(userState, tier, amount, award?.reason || 'Recognition metadata backfill', award?.weekKey || null);
    totals[tier] += amount;
    affectedUsers.add(userId);
    historyEntries += 1;
  }

  for (const [userIdRaw, countRaw] of Object.entries(interactionCounts || {})) {
    const userId = String(userIdRaw || '');
    const count = Number(countRaw || 0);
    if (!userId || count <= 0) continue;
    const userState = ensureUser(seasonRoot, userId);
    userState.interactionCount = Number(userState.interactionCount || 0) + count;
    affectedUsers.add(userId);
  }

  const summary = {
    backfillKey,
    appliedAt: Date.now(),
    usersAffected: affectedUsers.size,
    historyEntries,
    interactionUsers: Object.keys(interactionCounts || {}).filter((userId) => Number(interactionCounts[userId] || 0) > 0).length,
    totals,
    metadata,
  };
  seasonRoot.backfills[backfillKey] = summary;
  saveStore(store);
  return { ok: true, summary };
}

export function getRecognitionPerkState({ guildId, league, seasonKey, userId, weekKey = null }) {
  const context = inferRecognitionContext(league, guildId) || {};
  const summary = getRecognitionUserSummary({ guildId, league, seasonKey, userId });
  const userState = summary?.userState || {};
  const activity = Number(userState.activity || 0);
  const impact = Number(userState.impact || 0);
  const legacy = Number(userState.legacy || 0);
  const currentStreak = Number(userState.currentStreak || 0);
  const spent = userState.spent || {};
  const balances = {
    activity: Math.max(0, activity - Number(spent.activity || 0)),
    impact: Math.max(0, impact - Number(spent.impact || 0)),
    legacy: Math.max(0, legacy - Number(spent.legacy || 0)),
  };
  const activeWeekPerks = weekKey ? (userState.activePerks?.[weekKey] || {}) : {};
  const weekHistory = weekKey
    ? (Array.isArray(userState.history) ? userState.history.filter((entry) => entry?.weekKey === weekKey) : [])
    : [];

  const perks = Object.fromEntries(
    Object.keys(PERK_COSTS).map((key) => [key, perkIsActive(activeWeekPerks[key])]),
  );

  const active = [];
  const perkStatus = {};
  for (const [key, value] of Object.entries(perks)) {
    const perk = PERK_COSTS[key];
    const phaseGate = perkPhaseGate(key, context?.phase);
    const activatedThisWeek = weekHistory.some((entry) => entry?.reason === `Activated ${perk.label}`);
    const consumedThisWeek = weekHistory.some((entry) => String(entry?.reason || '').includes(`Consumed ${perk.label}`));
    const rawActiveValue = activeWeekPerks[key];
    const activeNow = perkIsActive(rawActiveValue);
    const blockedByBundle = perkIsActive(activeWeekPerks.allGamePlanBundle) && (key === 'offensiveGamePlan' || key === 'defensiveGamePlan' || key === 'tendencyBreakdown');
    const blockedBySingleGamePlan = key === 'allGamePlanBundle' && (
      perkIsActive(activeWeekPerks.offensiveGamePlan) ||
      perkIsActive(activeWeekPerks.defensiveGamePlan) ||
      perkIsActive(activeWeekPerks.tendencyBreakdown)
    );
    perkStatus[key] = {
      key,
      ...perk,
      activeNow,
      activatedThisWeek,
      consumedThisWeek,
      usedThisWeek: activatedThisWeek && !activeNow,
      phaseOpen: phaseGate.open,
      phaseLockedReason: phaseGate.reason,
      availableThisWeek: phaseGate.open && !activeNow && !activatedThisWeek && !blockedByBundle && !blockedBySingleGamePlan && balances[perk.tier] >= perk.cost,
      selectedTier: rawActiveValue && typeof rawActiveValue === 'object' ? rawActiveValue.selectedTier || null : null,
      resolved: rawActiveValue && typeof rawActiveValue === 'object' ? rawActiveValue.resolved === true : false,
    };
    if (!value) continue;
    active.push({
      ...perkStatus[key],
    });
  }

  const tierStatus = { activity: { active: [], used: [], available: [] }, impact: { active: [], used: [], available: [] }, legacy: { active: [], used: [], available: [] } };
  for (const status of Object.values(perkStatus)) {
    const bucket = tierStatus[status.tier] || (tierStatus[status.tier] = { active: [], used: [], available: [] });
    if (status.activeNow) bucket.active.push(status);
    else if (status.usedThisWeek) bucket.used.push(status);
    else if (status.availableThisWeek) bucket.available.push(status);
  }

  return {
    userState,
    balances,
    perks,
    active,
    perkStatus,
    tierStatus,
    costs: PERK_COSTS,
    currentStreak,
    phase: context?.phase || null,
    phaseLabel: context?.phaseLabel || null,
  };
}

export function getRecognitionStreamTotal({ guildId, league, userId }) {
  if (!guildId || !league || !userId) return 0;
  const store = loadStore();
  const seasons = store?.[String(guildId)]?.[league]?.seasons || {};
  let total = 0;
  for (const seasonRoot of Object.values(seasons)) {
    const userState = seasonRoot?.users?.[String(userId)];
    if (!userState?.weeks) continue;
    for (const weekState of Object.values(userState.weeks)) {
      if (weekState?.awards?.stream === true) total += 1;
    }
  }
  return total;
}

export function getLegacyOpportunityForTeam({ snapshot, teamId, teamAwardTotal = 0 }) {
  const standings = (snapshot?.standings?.teamStandingInfoList || []).slice();
  const standing = standings.find((team) => Number(team.teamId) === Number(teamId));
  if (!standing) return { total: 0, reasons: [] };

  const rules = RECOGNITION_ECONOMY.legacy.currentSeason;
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const seed = Number(standing?.seed || 0);
  const divisionId = String(standing?.divisionId || '');
  const divisionTeams = standings.filter((team) => String(team?.divisionId || '') === divisionId);
  const divisionLeader = divisionTeams
    .slice()
    .sort((a, b) =>
      Number(b?.winPct || 0) - Number(a?.winPct || 0) ||
      Number(b?.totalWins || 0) - Number(a?.totalWins || 0) ||
      Number(b?.netPts || 0) - Number(a?.netPts || 0))[0];
  const leaderWins = Math.max(...divisionTeams.map((team) => Number(team?.totalWins || 0)), 0);

  const reasons = [];
  if (wins === rules.strongSeasonFoundation.wins - 1) {
    reasons.push(`+${rules.strongSeasonFoundation.amount} with a win for reaching the strong-season mark`);
  } else if (wins >= rules.strongSeasonFoundation.wins) {
    reasons.push(`+${rules.strongSeasonFoundation.amount} for holding a strong-season profile`);
  }
  if (losses >= rules.stopTheSlide.minLosses && wins <= rules.stopTheSlide.maxWins) {
    reasons.push(`+${rules.stopTheSlide.amount} for stopping the slide and giving the season new life`);
  }
  if (wins >= rules.undefeatedRun.wins - 1 && losses <= rules.undefeatedRun.lossesMax) {
    reasons.push(`+${rules.undefeatedRun.amount} if the undefeated run stays alive`);
  }
  if (Number(divisionLeader?.teamId) === Number(teamId)) {
    reasons.push(`+${rules.divisionLead.amount} for defending the division lead`);
  } else if ((leaderWins - wins) <= 1) {
    reasons.push(`+${rules.divisionLead.amount} if this swings the division race`);
  }
  if (seed === rules.conferenceTopSeed.seed) {
    reasons.push(`+${rules.conferenceTopSeed.amount} for holding the conference top seed`);
  } else if (seed === rules.conferenceTopSeed.seed + 1) {
    reasons.push(`+${rules.conferenceTopSeed.amount} if this pushes them into the top-seed lane`);
  }
  const volumeBonus = Math.min(rules.awardVolume.max, Math.floor(Number(teamAwardTotal || 0) / rules.awardVolume.perAwards));
  if (volumeBonus > 0) {
    reasons.push(`+${volumeBonus} from sustained weekly award presence`);
  }

  return {
    total: reasons.reduce((sum, line) => sum + Number((line.match(/^\+(\d+)/) || [])[1] || 0), 0),
    reasons,
  };
}

export function getRecognitionWeeklyOpportunity({ guildId, league, seasonKey, weekKey, userId }) {
  if (!guildId || !league || !seasonKey || !weekKey || !userId) {
    return { activity: { total: 0, reasons: [] }, impact: { total: 0, reasons: [] } };
  }
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  const weekState = ensureWeek(userState, weekKey);
  if (league === 'madden') syncMaddenWeeklyStreamRequirement({ guildId, userId, weekKey, weekState });

  const activityReasons = [];
  if (!weekState?.checklist?.gameCompletedOnTime && Number(POINTS.activity.gameCompletedOnTime || 0) > 0) {
    activityReasons.push(`+${POINTS.activity.gameCompletedOnTime} game completed on time`);
  }
  if (!weekState?.awards?.checklistBonus) {
    const done = checklistCount(weekState);
    const remaining = 5 - done;
    if (remaining > 0 && remaining <= 2) {
      activityReasons.push(`+${POINTS.activity.checklistBonus} perfect checklist bonus`);
    }
  }

  const gotw = seasonRoot.gameOfWeek?.[weekKey];
  const userKey = String(userId);
  const inGotw = Boolean(
    gotw &&
    !gotw.awardedAt &&
    (
      (gotw.awayUserIds || []).includes(userKey) ||
      (gotw.homeUserIds || []).includes(userKey)
    )
  );
  const impactReasons = [];
  if (inGotw && !weekState?.awards?.gotwWin) {
    impactReasons.push(`+${POINTS.impact.gameOfWeekWin} Game of the Week win`);
  }

  return {
    activity: {
      total: activityReasons.reduce((sum, line) => sum + Number((line.match(/^\+(\d+)/) || [])[1] || 0), 0),
      reasons: activityReasons,
    },
    impact: {
      total: impactReasons.reduce((sum, line) => sum + Number((line.match(/^\+(\d+)/) || [])[1] || 0), 0),
      reasons: impactReasons,
    },
  };
}

export function activateRecognitionPerk({ guildId, league, seasonKey, weekKey, userId, perkKey }) {
  if (!guildId || !league || !seasonKey || !weekKey || !userId || !perkKey || !PERK_COSTS[perkKey]) return { ok: false, message: 'That perk is not available.' };
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  const perk = PERK_COSTS[perkKey];
  const context = inferRecognitionContext(league, guildId) || {};
  const phaseGate = perkPhaseGate(perkKey, context?.phase);
  const isGamePlanBundle = perkKey === 'allGamePlanBundle';
  const impactedPerkKeys = isGamePlanBundle
    ? ['offensiveGamePlan', 'defensiveGamePlan', 'tendencyBreakdown', 'allGamePlanBundle']
    : [perkKey];
  const earned = Number(userState[perk.tier] || 0);
  const spent = Number(userState.spent?.[perk.tier] || 0);
  const balance = Math.max(0, earned - spent);
  userState.activePerks[weekKey] = userState.activePerks[weekKey] || {};
  if (perkIsActive(userState.activePerks[weekKey][perkKey])) {
    return { ok: false, message: `${perk.label} is already active for this week.` };
  }
  if (!phaseGate.open) {
    return { ok: false, message: `${perk.label} is not open right now. It ${phaseGate.reason}.` };
  }
  if (isGamePlanBundle && (
    perkIsActive(userState.activePerks[weekKey].offensiveGamePlan) ||
    perkIsActive(userState.activePerks[weekKey].defensiveGamePlan) ||
    perkIsActive(userState.activePerks[weekKey].tendencyBreakdown)
  )) {
    return { ok: false, message: 'The all-game-plan bundle has to be purchased before any individual game-plan section is activated this week.' };
  }
  if (!isGamePlanBundle && perkIsActive(userState.activePerks[weekKey].allGamePlanBundle)) {
    return { ok: false, message: 'The all-game-plan bundle is already active for this week.' };
  }
  if (balance < perk.cost) {
    return { ok: false, message: `You need ${perk.cost} ${perk.tier} to activate ${perk.label}.` };
  }
  userState.spent[perk.tier] = spent + perk.cost;
  for (const key of impactedPerkKeys) {
    userState.activePerks[weekKey][key] = key === 'doubleOrNothing'
      ? { active: true, selectedTier: null, resolved: false }
      : true;
  }
  userState.history.push({
    tier: perk.tier,
    amount: -perk.cost,
    reason: `Activated ${perk.label}`,
    weekKey,
    ts: Date.now(),
  });
  userState.history = userState.history.slice(-120);
  saveStore(store);
  return {
    ok: true,
    perk,
    balanceBefore: balance,
    balanceAfter: Math.max(0, Number(userState[perk.tier] || 0) - Number(userState.spent?.[perk.tier] || 0)),
  };
}

export function hasRecognitionPerk({ guildId, league, seasonKey, weekKey, userId, perkKey }) {
  const store = loadStore();
  return perkIsActive(store?.[String(guildId)]?.[league]?.seasons?.[seasonKey]?.users?.[String(userId)]?.activePerks?.[weekKey]?.[perkKey]);
}

export function consumeRecognitionPerk({ guildId, league, seasonKey, weekKey, userId, perkKey, reason = '' }) {
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  if (!perkIsActive(userState.activePerks?.[weekKey]?.[perkKey])) return false;
  delete userState.activePerks[weekKey][perkKey];
  userState.history.push({
    tier: PERK_COSTS[perkKey]?.tier || 'activity',
    amount: 0,
    reason: reason || `Consumed ${PERK_COSTS[perkKey]?.label || perkKey}`,
    weekKey,
    ts: Date.now(),
  });
  userState.history = userState.history.slice(-120);
  saveStore(store);
  return true;
}

export function setRecognitionDoubleOrNothingTier({ guildId, league, seasonKey, weekKey, userId, targetTier }) {
  if (!guildId || !league || !seasonKey || !weekKey || !userId || !['activity', 'impact', 'legacy'].includes(String(targetTier || ''))) {
    return { ok: false, message: 'Missing Double or Nothing selection context.' };
  }
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userState = ensureUser(seasonRoot, String(userId));
  const perkState = userState.activePerks?.[weekKey]?.doubleOrNothing;
  if (!perkState || typeof perkState !== 'object' || !perkIsActive(perkState)) {
    return { ok: false, message: 'Double or Nothing is not active for this week.' };
  }
  if (perkState.resolved === true) {
    return { ok: false, message: 'Double or Nothing already settled for this week.' };
  }
  perkState.selectedTier = String(targetTier);
  userState.history.push({
    tier: 'impact',
    amount: 0,
    reason: `Set Double or Nothing: ${targetTier}`,
    weekKey,
    ts: Date.now(),
  });
  userState.history = userState.history.slice(-120);
  saveStore(store);
  return { ok: true, selectedTier: String(targetTier) };
}

export function resetRecognitionUserSeason({ guildId, league, seasonKey, userId, reason = 'Coach role removed' }) {
  if (!guildId || !league || !seasonKey || !userId) return { ok: false, message: 'Missing recognition reset context.' };
  const store = loadStore();
  const seasonRoot = ensureRoot(store, String(guildId), league, seasonKey);
  const userKey = String(userId);
  const existing = seasonRoot.users?.[userKey];
  if (!existing) {
    return { ok: false, message: 'No recognition state found for this user in the current season.' };
  }
  seasonRoot.archivedUsers[userKey] = seasonRoot.archivedUsers[userKey] || [];
  seasonRoot.archivedUsers[userKey].push({
    ts: Date.now(),
    reason,
    snapshot: existing,
  });
  seasonRoot.archivedUsers[userKey] = seasonRoot.archivedUsers[userKey].slice(-5);
  delete seasonRoot.users[userKey];
  saveStore(store);
  return { ok: true, archived: true };
}
