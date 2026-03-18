import fs from 'fs';
import path from 'path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { brandTitle } from './madden_branding.js';
import { awardRecognitionPoints, consumeRecognitionPerk, getRecognitionGameOfWeek, getRecognitionPerkState, hasRecognitionPerk } from './league_recognition.js';
import { getCoachAssignmentMap } from './madden_coach_assignments.js';
import { loadLeagueSnapshot, resolveLeagueIdWithConfig } from '../../madden/madden_data.js';
import { getMaddenSnapshotContext } from './madden_metadata.js';

const STORE_PATH = path.join(process.cwd(), 'data', 'madden', 'sportsbook.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const WEEKLY_GAME_LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'weekly_game_log.json');

const STARTING_BANKROLL = 40;
const MAX_GAME_MARKETS = 2;
const SPREAD_PRICE = -110;
const TOTAL_PRICE = -110;
const IMPACT_EMOJI = '<:impact:1482989570185363466>';
const GAME_OF_WEEK_BET_BONUS = 2;
const FIRST_BET_BOOST_MULTIPLIER = 2;
const FIRST_BET_BOOST_MAX_EXTRA = 10;

// Founder/test protection: prevent role-removal testing from wiping founder sportsbook state.
const PROTECTED_SPORTSBOOK_USER_IDS = new Set([
  '1076243288056664234',
]);

function safeReadJSON(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function loadStore() {
  return safeReadJSON(STORE_PATH, {});
}

function saveStore(store) {
  saveJSON(STORE_PATH, store);
}

function loadRoleMap() {
  return safeReadJSON(ROLE_MAP_FILE, {});
}

function loadWeeklyGameLog() {
  return safeReadJSON(WEEKLY_GAME_LOG_FILE, {});
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roundToHalf(value) {
  return Math.round(Number(value || 0) * 2) / 2;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function formatSigned(value) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number}`;
}

function formatImpactValue(value) {
  const amount = Number(value || 0);
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return `${rounded}x ${IMPACT_EMOJI}`;
}

function formatImpactDelta(value) {
  const amount = Number(value || 0);
  const prefix = amount > 0 ? '+' : '';
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
  return `${prefix}${rounded}x ${IMPACT_EMOJI}`;
}

function recordWins(record = '') {
  const [wins] = String(record).split('-').map((value) => Number(value || 0));
  return Number.isFinite(wins) ? wins : 0;
}

function favoriteLabel(line) {
  return line.favorite === 'home' ? line.homeSpreadDisplay : line.awaySpreadDisplay;
}

function buildSportsbookIntel(lines = [], gotw = null) {
  if (!lines.length) {
    return {
      bestSide: 'Best side: board still loading.',
      totalToWatch: 'Total to watch: board still loading.',
      trapLine: 'Trap line: board still loading.',
      stayAway: 'Stay away: board still loading.',
      featured: gotw ? `Featured game: ${gotw.label} • winning bets add +${GAME_OF_WEEK_BET_BONUS} ${IMPACT_EMOJI}` : 'Featured game: not set yet.',
    };
  }

  const gotwGameId = gotw?.awayTeam && gotw?.homeTeam
    ? (lines.find((line) =>
      normalizeName(line.awayTeam) === normalizeName(gotw.awayTeam)
      && normalizeName(line.homeTeam) === normalizeName(gotw.homeTeam)
    )?.gameId || null)
    : null;

  const strongestSide = [...lines].sort((a, b) => Number(b.spread || 0) - Number(a.spread || 0))[0];
  const highestTotal = [...lines].sort((a, b) => Number(b.total || 0) - Number(a.total || 0))[0];
  const trapCandidate = [...lines]
    .filter((line) => Math.abs(Number(line.spread || 0)) <= 3.5)
    .filter((line) => !gotwGameId || String(line.gameId) !== String(gotwGameId))
    .sort((a, b) => {
      const aGap = Math.abs(recordWins(a.homeRecord) - recordWins(a.awayRecord));
      const bGap = Math.abs(recordWins(b.homeRecord) - recordWins(b.awayRecord));
      return bGap - aGap;
    })[0];
  const stayAwayLine = [...lines]
    .filter((line) => String(line?.gameId || '') !== String(trapCandidate?.gameId || ''))
    .filter((line) => String(line?.gameId || '') !== String(strongestSide?.gameId || ''))
    .filter((line) => !gotwGameId || String(line.gameId) !== String(gotwGameId))
    .sort((a, b) => {
      const aSpread = Math.abs(Number(a.spread || 0) - 1.5);
      const bSpread = Math.abs(Number(b.spread || 0) - 1.5);
      return aSpread - bSpread;
    })[0];

  return {
    bestSide: strongestSide
      ? `Best side: ${favoriteLabel(strongestSide)} • biggest edge on the board`
      : 'Best side: board still loading.',
    totalToWatch: highestTotal
      ? `Total to watch: ${highestTotal.awayTeam} at ${highestTotal.homeTeam} • O/U ${highestTotal.total}`
      : 'Total to watch: board still loading.',
    trapLine: trapCandidate
      ? `Trap line: ${trapCandidate.awayTeam} at ${trapCandidate.homeTeam} • ${favoriteLabel(trapCandidate)}`
      : 'Trap line: none yet.',
    stayAway: stayAwayLine
      ? `Stay away: ${stayAwayLine.awayTeam} at ${stayAwayLine.homeTeam} • close number at ${favoriteLabel(stayAwayLine)}`
      : 'Stay away: none yet.',
    featured: gotw
      ? `Featured game: ${gotw.label} • winning bets add +${GAME_OF_WEEK_BET_BONUS} ${IMPACT_EMOJI}`
      : 'Featured game: not set yet.',
  };
}

function resolveRecognitionSeasonKeyForGuild(guildId, fallbackSeasonKey) {
  if (!guildId) return fallbackSeasonKey;
  try {
    const leagueId = resolveLeagueIdWithConfig(guildId);
    if (!leagueId) return fallbackSeasonKey;
    const snapshot = loadLeagueSnapshot(leagueId);
    const year = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
      || snapshot?.info?.calendarYear
      || new Date().getFullYear();
    return `year_${year}`;
  } catch {
    return fallbackSeasonKey;
  }
}

function gotwLabelFromRecognition(gotw = null) {
  if (!gotw) return null;
  if (gotw.label) return String(gotw.label);
  const away = gotw.awayTeam ? String(gotw.awayTeam) : '';
  const home = gotw.homeTeam ? String(gotw.homeTeam) : '';
  if (away && home) return `${away} at ${home}`;
  return null;
}

function featuredGameLabelFromSnapshot(snapshot = null, weekNumber) {
  const featured = snapshot?.info?.careerHubInfo?.featuredGame || snapshot?.info?.featuredGame || null;
  if (!featured) return null;
  const week = Number(featured?.week ?? featured?.weekNumber ?? featured?.weekIndex != null ? Number(featured.weekIndex) + 1 : NaN);
  if (Number.isFinite(week) && weekNumber && Number(weekNumber) !== Number(week)) return null;
  const away = featured?.awayTeam || featured?.awayTeamName || featured?.visitorTeam || featured?.awayDisplayName || '';
  const home = featured?.homeTeam || featured?.homeTeamName || featured?.homeDisplayName || '';
  if (away && home) return `${away} at ${home}`;
  const label = featured?.label || featured?.gameLabel || '';
  return label ? String(label) : null;
}

function mostPopularLineFromBoard(lines = []) {
  if (!Array.isArray(lines) || !lines.length) return null;
  // If we haven't collected any bet meta yet, just surface "best line" as the default popular lean.
  const strongestSide = [...lines].sort((a, b) => Number(b.spread || 0) - Number(a.spread || 0))[0];
  if (!strongestSide) return null;
  return {
    matchupLabel: `${strongestSide.awayTeam} at ${strongestSide.homeTeam}`,
    label: `Spread ${favoriteLabel(strongestSide)}`,
    count: 0,
  };
}

function mostPopularBetForWeek(weekStore = {}) {
  const bets = (weekStore?.bets || []).filter((bet) => {
    const status = String(bet?.status || '');
    return status && status !== 'void';
  });
  if (!bets.length) return null;
  const counts = new Map();
  for (const bet of bets) {
    const key = [bet.gameId, bet.market, bet.selection].map((v) => String(v ?? '')).join('|');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [topKey, count] = sorted[0] || [];
  if (!topKey || !count) return null;
  const [gameId, market, selection] = String(topKey).split('|');
  const sample = bets.find((bet) => String(bet.gameId) === String(gameId) && String(bet.market) === String(market) && String(bet.selection) === String(selection));
  if (!sample) return null;
  return {
    label: sample.betLabel || `${market} ${selection}`,
    matchupLabel: sample.matchupLabel || 'Game',
    count,
  };
}

function getSportsbookLimits(balance = STARTING_BANKROLL) {
  const current = Math.max(0, Number(balance || 0));
  return {
    maxWager: Math.min(current, clamp(Math.floor(current * 0.25), 1, 20)),
    maxWeeklyExposure: Math.min(current, clamp(Math.floor(current * 0.65), 1, 60)),
  };
}

function americanProfit(stake, americanOdds) {
  const wager = Number(stake || 0);
  const odds = Number(americanOdds || 0);
  if (!wager || !odds) return 0;
  if (odds > 0) return Math.round((wager * (odds / 100)) * 10) / 10;
  return Math.round((wager * (100 / Math.abs(odds))) * 10) / 10;
}

function payoutBreakdown(stake, americanOdds) {
  const wager = Number(stake || 0);
  const profit = americanProfit(wager, americanOdds);
  return {
    stake: wager,
    profit,
    totalReturn: wager + profit,
  };
}

function impliedMoneylineFromSpread(spread) {
  const abs = Math.abs(Number(spread || 0));
  if (abs <= 1.5) return { favorite: -120, underdog: 100 };
  if (abs <= 3.5) return { favorite: -145, underdog: 125 };
  if (abs <= 6.5) return { favorite: -190, underdog: 160 };
  return { favorite: -260, underdog: 210 };
}

function ensureSeason(store, seasonKey) {
  store[seasonKey] = store[seasonKey] || { bankrolls: {}, weeks: {} };
  return store[seasonKey];
}

function ensureWeek(seasonStore, weekKey) {
  seasonStore.weeks[weekKey] = seasonStore.weeks[weekKey] || {
    lines: [],
    bets: [],
    posts: null,
    settled: false,
    settledAt: null,
  };
  return seasonStore.weeks[weekKey];
}

function initialSportsbookImpact({ guildId, seasonKey, userId }) {
  if (!guildId || !seasonKey || !userId) return STARTING_BANKROLL;
  const perkState = getRecognitionPerkState({
    guildId,
    league: 'madden',
    seasonKey,
    userId: String(userId),
  });
  const impact = Number(perkState?.balances?.impact || 0);
  return impact > 0 ? impact : STARTING_BANKROLL;
}

function ensureBankroll(seasonStore, userId, startingBalance = STARTING_BANKROLL) {
  seasonStore.bankrolls[userId] = seasonStore.bankrolls[userId] || {
    balance: Number(startingBalance || STARTING_BANKROLL),
    totalWagered: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    profit: 0,
    firstBetBoostUsed: false,
    firstBetBoostBetPlacedAt: null,
    firstBetBoostBonus: 0,
  };
  return seasonStore.bankrolls[userId];
}

function firstBetBoostState(card = {}) {
  const bankroll = card?.bankroll || {};
  const liveBoostBet = (card?.bets || []).find((bet) => bet?.status === 'open' && bet?.firstBetBoost);
  if (liveBoostBet) {
    return `Live now on your first bet: ${liveBoostBet.betLabel || 'open slip'} • win gets ${FIRST_BET_BOOST_MULTIPLIER}x profit`;
  }
  if (bankroll.firstBetBoostUsed) {
    return bankroll.firstBetBoostBonus > 0
      ? `Used • cashed an extra ${formatImpactValue(bankroll.firstBetBoostBonus)}`
      : 'Used • your boosted first bet did not cash';
  }
  return `Available • your first bet of the season pays ${FIRST_BET_BOOST_MULTIPLIER}x profit if it wins`;
}

function isCoachOrGhostLegacy(member, roleMap) {
  return member.roles.cache.some((role) => {
    if (role.id === roleMap['Ghost Legacy']) return true;
    return Object.entries(roleMap).some(([name, id]) => /coach$/i.test(name) && id === role.id);
  });
}

function coachTeamsFromMember(member, roleMap) {
  const teams = [];
  for (const role of member?.roles?.cache?.values?.() || []) {
    for (const [name, id] of Object.entries(roleMap || {})) {
      if (id !== role.id) continue;
      if (!/coach$/i.test(name)) continue;
      teams.push(name.replace(/coach$/i, '').trim());
    }
  }
  return [...new Set(teams)];
}

function pointsFromSchedule(snapshot, currentWeekLimit) {
  const out = {};
  const games = (snapshot?.schedule?.schedules || []).filter((game) => {
    const stage = Number(game.stageIndex ?? game.stage ?? 1);
    if (stage !== 1) return false;
    if (currentWeekLimit != null && Number.isInteger(game.weekIndex)) return game.weekIndex < currentWeekLimit;
    return true;
  });
  for (const game of games) {
    const away = game.awayTeamId;
    const home = game.homeTeamId;
    const awayScore = Number(game.awayScore ?? 0);
    const homeScore = Number(game.homeScore ?? 0);
    out[away] = out[away] || { for: 0, against: 0, games: 0 };
    out[home] = out[home] || { for: 0, against: 0, games: 0 };
    out[away].for += awayScore;
    out[away].against += homeScore;
    out[away].games += 1;
    out[home].for += homeScore;
    out[home].against += awayScore;
    out[home].games += 1;
  }
  return out;
}

function pickField(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) return Number(obj[key]);
  }
  return null;
}

function normalizeStandingsPoints(rawValue, games) {
  const raw = Number(rawValue);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const played = Math.max(1, Number(games || 1));
  // Many exports already store ptsFor / ptsAgainst as per-game values.
  // Only divide when the number looks like a season total.
  if (raw >= played * 10) return raw / played;
  return raw;
}

function buildTeamStrengthMap(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const currentWeek = snapshot?.currentWeek ?? snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? null;
  const schedulePts = pointsFromSchedule(snapshot, currentWeek ? currentWeek : null);
  const map = {};
  for (const team of standings) {
    const teamId = Number(team.teamId);
    const wins = Number(team.totalWins || 0);
    const losses = Number(team.totalLosses || 0);
    const ties = Number(team.totalTies || 0);
    const games = Math.max(1, wins + losses + ties);
    const winPct = wins / games;
    const scheduleHasScoring = Number(schedulePts[teamId]?.for || 0) > 0 || Number(schedulePts[teamId]?.against || 0) > 0;
    const standingsPtsFor = normalizeStandingsPoints(pickField(team, ['pointsFor', 'totalPointsFor', 'offPts', 'ptsFor']), games);
    const standingsPtsAgainst = normalizeStandingsPoints(pickField(team, ['pointsAgainst', 'ptsAllowed', 'defPtsAllowed', 'ptsAgainst']), games);
    const ptsFor = (schedulePts[teamId]?.games && scheduleHasScoring)
      ? (schedulePts[teamId].for / schedulePts[teamId].games)
      : standingsPtsFor;
    const ptsAgainst = (schedulePts[teamId]?.games && scheduleHasScoring)
      ? (schedulePts[teamId].against / schedulePts[teamId].games)
      : standingsPtsAgainst;
    const diff = (Number.isFinite(ptsFor) ? ptsFor : 0) - (Number.isFinite(ptsAgainst) ? ptsAgainst : 0);
    map[teamId] = {
      wins,
      losses,
      winPct,
      ptsFor: Number.isFinite(ptsFor) ? ptsFor : 21,
      ptsAgainst: Number.isFinite(ptsAgainst) ? ptsAgainst : 21,
      diff,
      teamOvr: Number(team.teamOvr || team.ovrRating || 80),
      netPts: Number(team.netPts || 0),
      ptsForRank: Number(team.ptsForRank || 16),
      ptsAgainstRank: Number(team.ptsAgainstRank || 16),
      offPassYdsRank: Number(team.offPassYdsRank || 16),
      offRushYdsRank: Number(team.offRushYdsRank || 16),
      defPassYdsRank: Number(team.defPassYdsRank || 16),
      defRushYdsRank: Number(team.defRushYdsRank || 16),
      score: (winPct * 18) + (diff * 0.9) + ((Number.isFinite(ptsFor) ? ptsFor : 21) * 0.15),
    };
  }
  return map;
}

function recentGameMap(snapshot, currentWeekLimit) {
  const out = {};
  const games = (snapshot?.schedule?.schedules || [])
    .filter((game) => Number(game.stageIndex ?? game.stage ?? 1) === 1)
    .filter((game) => currentWeekLimit == null || Number(game.weekIndex ?? -1) < Number(currentWeekLimit))
    .filter((game) => Number(game.awayScore ?? 0) > 0 || Number(game.homeScore ?? 0) > 0)
    .sort((a, b) => Number(a.weekIndex ?? 0) - Number(b.weekIndex ?? 0));
  for (const game of games) {
    const awayTeamId = Number(game.awayTeamId);
    const homeTeamId = Number(game.homeTeamId);
    out[awayTeamId] = out[awayTeamId] || [];
    out[homeTeamId] = out[homeTeamId] || [];
    out[awayTeamId].push({
      weekIndex: Number(game.weekIndex ?? -1),
      pointsFor: Number(game.awayScore || 0),
      pointsAgainst: Number(game.homeScore || 0),
      margin: Number(game.awayScore || 0) - Number(game.homeScore || 0),
      won: Number(game.awayScore || 0) > Number(game.homeScore || 0),
    });
    out[homeTeamId].push({
      weekIndex: Number(game.weekIndex ?? -1),
      pointsFor: Number(game.homeScore || 0),
      pointsAgainst: Number(game.awayScore || 0),
      margin: Number(game.homeScore || 0) - Number(game.awayScore || 0),
      won: Number(game.homeScore || 0) > Number(game.awayScore || 0),
    });
  }
  return out;
}

function averageOf(values = []) {
  const nums = values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function buildRecentFormMap(snapshot) {
  const currentWeek = snapshot?.currentWeek ?? snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? null;
  const gamesByTeam = recentGameMap(snapshot, currentWeek ? currentWeek : null);
  const out = {};
  for (const [teamId, games] of Object.entries(gamesByTeam)) {
    const recent = [...games].slice(-3);
    out[Number(teamId)] = {
      recentWins: recent.filter((game) => game.won).length,
      recentAvgMargin: averageOf(recent.map((game) => game.margin)),
      recentAvgPtsFor: averageOf(recent.map((game) => game.pointsFor)),
      recentAvgPtsAgainst: averageOf(recent.map((game) => game.pointsAgainst)),
      blowoutWins: recent.filter((game) => game.margin >= 14).length,
      blowoutLosses: recent.filter((game) => game.margin <= -14).length,
      games: recent.length,
    };
  }
  return out;
}

function buildTeamWeeklyProfiles(snapshot) {
  const out = {};
  for (const week of snapshot?.weeklyStats || []) {
    if (Number(week?.stage ?? week?.stageIndex ?? 1) !== 1) continue;
    for (const player of week?.passing?.playerPassingStatInfoList || []) {
      const teamId = Number(player.teamId);
      out[teamId] = out[teamId] || { passAtt: 0, rushAtt: 0, sacks: 0, games: new Set() };
      out[teamId].passAtt += Number(player.passAtt || 0);
      out[teamId].games.add(`${week.weekIndex}:${player.scheduleId || ''}`);
    }
    for (const player of week?.rushing?.playerRushingStatInfoList || []) {
      const teamId = Number(player.teamId);
      out[teamId] = out[teamId] || { passAtt: 0, rushAtt: 0, sacks: 0, games: new Set() };
      out[teamId].rushAtt += Number(player.rushAtt || 0);
      out[teamId].games.add(`${week.weekIndex}:${player.scheduleId || ''}`);
    }
    for (const player of week?.defense?.playerDefensiveStatInfoList || []) {
      const teamId = Number(player.teamId);
      out[teamId] = out[teamId] || { passAtt: 0, rushAtt: 0, sacks: 0, games: new Set() };
      out[teamId].sacks += Number(player.defSacks || player.sacks || 0);
      out[teamId].games.add(`${week.weekIndex}:${player.scheduleId || ''}`);
    }
  }
  for (const value of Object.values(out)) {
    value.gameCount = Math.max(1, value.games.size);
    delete value.games;
  }
  return out;
}

function tendencyLabelFromProfile(profile = {}) {
  const passAtt = Number(profile.passAtt || 0);
  const rushAtt = Number(profile.rushAtt || 0);
  const total = Math.max(1, passAtt + rushAtt);
  const passRate = passAtt / total;
  if (passRate >= 0.63) return 'pass-heavy';
  if (passRate <= 0.44) return 'run-heavy';
  return 'balanced';
}

function buildStandingsByTeam(snapshot) {
  const map = {};
  for (const team of snapshot?.standings?.teamStandingInfoList || []) {
    map[Number(team.teamId)] = team;
  }
  return map;
}

function buildHeadToHeadContext(snapshot, awayTeamId, homeTeamId, targetWeekNumber = 1) {
  const targetWeekIndex = Math.max(0, Number(targetWeekNumber || 1) - 1);
  const allGames = (snapshot?.schedule?.schedules || []).filter((game) => {
    const gameAway = Number(game.awayTeamId);
    const gameHome = Number(game.homeTeamId);
    const sameMatchup = (gameAway === Number(awayTeamId) && gameHome === Number(homeTeamId)) ||
      (gameAway === Number(homeTeamId) && gameHome === Number(awayTeamId));
    if (!sameMatchup) return false;
    const weekIndex = Number(game.weekIndex ?? -1);
    const stage = Number(game.stageIndex ?? game.stage ?? 1);
    if (stage === 1) return weekIndex >= 0 && weekIndex < targetWeekIndex && hasRealPlayedSignal(game);
    if (stage === 2) return hasRealPlayedSignal(game);
    return false;
  });
  const ordered = allGames
    .slice()
    .sort((a, b) =>
      Number(a.stageIndex ?? a.stage ?? 1) - Number(b.stageIndex ?? b.stage ?? 1) ||
      Number(a.weekIndex ?? -1) - Number(b.weekIndex ?? -1));
  const lastMeeting = ordered.length ? ordered[ordered.length - 1] : null;
  return {
    games: ordered,
    count: ordered.length,
    lastMeeting,
    regularSeasonMeetings: ordered.filter((game) => Number(game.stageIndex ?? game.stage ?? 1) === 1).length,
    postseasonMeetings: ordered.filter((game) => Number(game.stageIndex ?? game.stage ?? 1) === 2).length,
    isRematch: ordered.length > 0,
  };
}

function divisionGameFlag(snapshot, awayTeamId, homeTeamId) {
  const standings = buildStandingsByTeam(snapshot);
  const awayDivision = String(standings?.[Number(awayTeamId)]?.divisionId || '');
  const homeDivision = String(standings?.[Number(homeTeamId)]?.divisionId || '');
  return awayDivision && homeDivision && awayDivision === homeDivision;
}

function spreadToMoneyline(spread) {
  const abs = Math.abs(Number(spread || 0));
  if (abs <= 1.5) return { favorite: -120, underdog: 100 };
  if (abs <= 3.5) return { favorite: -155, underdog: 135 };
  if (abs <= 5.5) return { favorite: -185, underdog: 155 };
  if (abs <= 7.5) return { favorite: -240, underdog: 195 };
  if (abs <= 10.5) return { favorite: -320, underdog: 250 };
  return { favorite: -425, underdog: 325 };
}

function buildLinesForGames(snapshot, games = [], teamsById = {}, weekNumber = 1) {
  const strength = buildTeamStrengthMap(snapshot);
  const recentForm = buildRecentFormMap(snapshot);
  const weeklyProfiles = buildTeamWeeklyProfiles(snapshot);
  return games.map((game) => {
    const awayTeamId = Number(game.awayTeamId);
    const homeTeamId = Number(game.homeTeamId);
    const away = strength[awayTeamId] || { score: 0, ptsFor: 21, ptsAgainst: 21, wins: 0, losses: 0, diff: 0 };
    const home = strength[homeTeamId] || { score: 0, ptsFor: 21, ptsAgainst: 21, wins: 0, losses: 0, diff: 0 };
    const awayRecent = recentForm[awayTeamId] || { recentWins: 0, recentAvgMargin: 0, recentAvgPtsFor: away.ptsFor, recentAvgPtsAgainst: away.ptsAgainst, blowoutWins: 0, blowoutLosses: 0, games: 0 };
    const homeRecent = recentForm[homeTeamId] || { recentWins: 0, recentAvgMargin: 0, recentAvgPtsFor: home.ptsFor, recentAvgPtsAgainst: home.ptsAgainst, blowoutWins: 0, blowoutLosses: 0, games: 0 };
    const awayProfile = weeklyProfiles[awayTeamId] || {};
    const homeProfile = weeklyProfiles[homeTeamId] || {};
    const awayTendency = tendencyLabelFromProfile(awayProfile);
    const homeTendency = tendencyLabelFromProfile(homeProfile);
    const h2h = buildHeadToHeadContext(snapshot, awayTeamId, homeTeamId, weekNumber);
    const divisionGame = divisionGameFlag(snapshot, awayTeamId, homeTeamId);
    const lastMeeting = h2h.lastMeeting;
    const lastAwayScore = Number(lastMeeting?.awayScore || 0);
    const lastHomeScore = Number(lastMeeting?.homeScore || 0);
    const lastWinner = lastMeeting
      ? (lastAwayScore > lastHomeScore ? 'away' : 'home')
      : null;
    const lastMarginForHome = lastMeeting
      ? ((Number(lastMeeting.homeTeamId) === homeTeamId ? lastHomeScore - lastAwayScore : lastAwayScore - lastHomeScore))
      : 0;

    const homeEdge = 1.5;
    const recentMarginEdge = (homeRecent.recentAvgMargin - awayRecent.recentAvgMargin) * 0.22;
    const blowoutEdge = ((homeRecent.blowoutWins - homeRecent.blowoutLosses) - (awayRecent.blowoutWins - awayRecent.blowoutLosses)) * 0.9;
    const rankEdge =
      ((away.ptsAgainstRank - home.ptsAgainstRank) * 0.08) +
      ((away.ptsForRank - home.ptsForRank) * 0.08) +
      ((away.defPassYdsRank - home.defPassYdsRank) * 0.03) +
      ((away.defRushYdsRank - home.defRushYdsRank) * 0.03);
    const ovrEdge = (home.teamOvr - away.teamOvr) * 0.12;
    const rematchSpreadLean = lastMeeting
      ? clamp(lastMarginForHome * 0.1, -2.5, 2.5)
      : 0;
    const divisionCompression = divisionGame ? -0.6 : 0;
    const repeatFamiliarityCompression = h2h.count >= 1 ? -0.4 : 0;
    const rawSpread = clamp(
      roundToHalf(((home.score + homeEdge) - away.score) + recentMarginEdge + blowoutEdge + rankEdge + ovrEdge + rematchSpreadLean + divisionCompression + repeatFamiliarityCompression),
      -16.5,
      16.5,
    );

    const explosiveOffenseBoost =
      ((away.ptsFor > 31 ? 1 : 0) + (home.ptsFor > 31 ? 1 : 0)) +
      ((awayRecent.recentAvgPtsFor > 31 ? 1 : 0) + (homeRecent.recentAvgPtsFor > 31 ? 1 : 0));
    const leakyDefenseBoost =
      ((away.ptsAgainst > 29 ? 1 : 0) + (home.ptsAgainst > 29 ? 1 : 0)) +
      ((awayRecent.recentAvgPtsAgainst > 29 ? 1 : 0) + (homeRecent.recentAvgPtsAgainst > 29 ? 1 : 0));
    const tendencyTotalBoost =
      (awayTendency === 'pass-heavy' ? 1.2 : awayTendency === 'run-heavy' ? -0.8 : 0) +
      (homeTendency === 'pass-heavy' ? 1.2 : homeTendency === 'run-heavy' ? -0.8 : 0);
    const rematchTotalLean = lastMeeting ? clamp(((lastAwayScore + lastHomeScore) - 42) * 0.08, -3, 3) : 0;
    const trenchSuppression =
      ((awayProfile.sacks || 0) / Math.max(1, awayProfile.gameCount || 1) > 3 ? -0.7 : 0) +
      ((homeProfile.sacks || 0) / Math.max(1, homeProfile.gameCount || 1) > 3 ? -0.7 : 0);
    const awayExpected = ((away.ptsFor * 0.6) + (home.ptsAgainst * 0.4) + (awayRecent.recentAvgPtsFor * 0.35) + (homeRecent.recentAvgPtsAgainst * 0.25)) / 1.6;
    const homeExpected = ((home.ptsFor * 0.6) + (away.ptsAgainst * 0.4) + (homeRecent.recentAvgPtsFor * 0.35) + (awayRecent.recentAvgPtsAgainst * 0.25)) / 1.6;
    const totalBase = awayExpected + homeExpected;
    const recentTotalLean = (((awayRecent.recentAvgPtsFor + awayRecent.recentAvgPtsAgainst) + (homeRecent.recentAvgPtsFor + homeRecent.recentAvgPtsAgainst)) / 2) - totalBase;
    const rankTotalBoost =
      ((33 - away.ptsForRank) * 0.18) +
      ((33 - home.ptsForRank) * 0.18) +
      ((33 - away.ptsAgainstRank) * 0.08) +
      ((33 - home.ptsAgainstRank) * 0.08) +
      ((33 - away.offPassYdsRank) * 0.04) +
      ((33 - home.offPassYdsRank) * 0.04);
    const matchupTotalBoost =
      ((home.ptsAgainst - 21) * 0.18) +
      ((away.ptsAgainst - 21) * 0.18) +
      ((away.ptsFor - 21) * 0.22) +
      ((home.ptsFor - 21) * 0.22);
    const lateSeasonBump = weekNumber >= 10 ? 1 : 0;
    const total = clamp(
      roundToHalf(totalBase + (recentTotalLean * 0.2) + rankTotalBoost + matchupTotalBoost + (explosiveOffenseBoost * 1.4) + (leakyDefenseBoost * 1.1) + tendencyTotalBoost + rematchTotalLean + trenchSuppression + lateSeasonBump),
      34.5,
      78.5,
    );
    const favorite = rawSpread >= 0 ? 'home' : 'away';
    const spread = Math.abs(rawSpread);
    const money = spreadToMoneyline(spread);
    return {
      gameId: `${weekNumber}:${awayTeamId}:${homeTeamId}`,
      weekNumber,
      awayTeamId,
      homeTeamId,
      awayTeam: teamsById[awayTeamId] || 'Away',
      homeTeam: teamsById[homeTeamId] || 'Home',
      awayRecord: `${away.wins}-${away.losses}`,
      homeRecord: `${home.wins}-${home.losses}`,
      favorite,
      spread,
      awayTendency,
      homeTendency,
      awaySpreadDisplay: favorite === 'away' ? `${teamsById[awayTeamId] || 'Away'} -${spread}` : `${teamsById[awayTeamId] || 'Away'} +${spread}`,
      homeSpreadDisplay: favorite === 'home' ? `${teamsById[homeTeamId] || 'Home'} -${spread}` : `${teamsById[homeTeamId] || 'Home'} +${spread}`,
      total,
      awayMoneyline: favorite === 'away' ? money.favorite : money.underdog,
      homeMoneyline: favorite === 'home' ? money.favorite : money.underdog,
      divisionGame,
      rematchCount: h2h.count,
      isRematch: h2h.isRematch,
      regularSeasonMeetings: h2h.regularSeasonMeetings,
      postseasonMeetings: h2h.postseasonMeetings,
      lastMeeting: lastMeeting ? {
        weekIndex: Number(lastMeeting.weekIndex ?? -1),
        stage: Number(lastMeeting.stageIndex ?? lastMeeting.stage ?? 1),
        awayTeamId: Number(lastMeeting.awayTeamId),
        homeTeamId: Number(lastMeeting.homeTeamId),
        awayScore: lastAwayScore,
        homeScore: lastHomeScore,
        winner: lastWinner,
      } : null,
    };
  });
}

function buildTeamsById(snapshot) {
  const out = {};
  for (const team of snapshot?.teams?.leagueTeamInfoList || []) {
    out[Number(team.teamId)] = String(team.displayName || team.nickName || team.longName || `Team ${team.teamId}`).trim();
  }
  return out;
}

function getSportsbookContextForGuild(guildId) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  if (!leagueId) return null;
  let snapshot = null;
  try {
    snapshot = loadLeagueSnapshot(leagueId);
  } catch {
    return null;
  }
  const context = getMaddenSnapshotContext(guildId, { leagueId, snapshot });
  if (!context) return null;
  const stage = Number(context.seasonInfo?.seasonWeekType ?? 1);
  const weekNumber = context.weekNumber;
  if (!weekNumber || stage !== 1) {
    return { leagueId: context.leagueId, snapshot, seasonKey: context.seasonKey, weekNumber: null, games: [], teamsById: buildTeamsById(snapshot) };
  }
  const games = (snapshot?.schedule?.schedules || []).filter((game) =>
    Number(game.stageIndex ?? game.stage ?? 1) === 1 &&
    Number(game.weekIndex ?? -1) === Number(weekNumber) - 1,
  );
  return {
    leagueId: context.leagueId,
    snapshot,
    seasonKey: context.seasonKey,
    weekNumber,
    games,
    teamsById: buildTeamsById(snapshot),
  };
}

export function getSportsbookLineForMatchup({ guildId, awayTeamId, homeTeamId, seasonKey = null, weekNumber = null, snapshot = null }) {
  const context = snapshot
    ? {
      snapshot,
      seasonKey,
      weekNumber,
      teamsById: buildTeamsById(snapshot),
      games: (snapshot?.schedule?.schedules || []).filter((game) =>
        Number(game.stageIndex ?? game.stage ?? 1) === 1 &&
        (weekNumber == null || Number(game.weekIndex ?? -1) === Number(weekNumber) - 1),
      ),
    }
    : getSportsbookContextForGuild(guildId);
  if (!context?.snapshot || !context?.teamsById) return null;
  const targetAway = Number(awayTeamId);
  const targetHome = Number(homeTeamId);
  const week = Number(weekNumber || context.weekNumber || 0);
  if (!week) return null;
  const games = (context.games || []).filter((game) =>
    Number(game.awayTeamId) === targetAway &&
    Number(game.homeTeamId) === targetHome,
  );
  if (!games.length) return null;
  return buildLinesForGames(context.snapshot, games, context.teamsById, week)[0] || null;
}

function marketCountForGame(weekStore, userId, gameId, existingMarket = null) {
  const markets = new Set();
  for (const bet of weekStore?.bets || []) {
    if (String(bet.userId) !== String(userId)) continue;
    if (bet.gameId !== gameId) continue;
    if (bet.status !== 'open') continue;
    if (existingMarket && bet.market === existingMarket) continue;
    markets.add(bet.market);
  }
  return markets.size;
}

function openExposureForWeek(weekStore, userId, existingBet = null) {
  return (weekStore?.bets || []).reduce((sum, bet) => {
    if (String(bet.userId) !== String(userId)) return sum;
    if (bet.status !== 'open') return sum;
    if (existingBet && bet === existingBet) return sum;
    return sum + Number(bet.wager || 0);
  }, 0);
}

function hasRealPlayedSignal(game = {}) {
  const awayScore = Number(game.awayScore ?? 0);
  const homeScore = Number(game.homeScore ?? 0);
  const explicitPlayed = game.isPlayed === true || game.played === true;
  const completedStatus = [2, 3, 4].includes(Number(game.status ?? game.gameStatus ?? -1));
  return completedStatus || (explicitPlayed && (awayScore > 0 || homeScore > 0));
}

function gameAlreadyPlayed(leagueId, weekNumber, line, liveGames = []) {
  const liveGame = (liveGames || []).find((game) =>
    Number(game.awayTeamId) === Number(line.awayTeamId) &&
    Number(game.homeTeamId) === Number(line.homeTeamId) &&
    Number(game.weekIndex ?? -1) === Number(weekNumber) - 1 &&
    Number(game.stageIndex ?? game.stage ?? 1) === 1,
  );
  if (liveGame && !hasRealPlayedSignal(liveGame)) return false;
  if (liveGame && hasRealPlayedSignal(liveGame)) return true;

  const log = loadWeeklyGameLog();
  const leagueLog = log?.[String(leagueId)];
  if (!leagueLog?.games?.length) return false;
  return leagueLog.games.some((game) =>
    Number(game.stageIndex ?? game.stage ?? 1) === 1 &&
    Number(game.weekIndex ?? -1) === Number(weekNumber) - 1 &&
    Number(game.awayTeamId) === Number(line.awayTeamId) &&
    Number(game.homeTeamId) === Number(line.homeTeamId) &&
    hasRealPlayedSignal(game),
  );
}

function sportsbookHeaderEmbed(weekNumber, seasonKey, intel = null) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(brandTitle(`LB Sportsbook • Week ${weekNumber}`))
    .setDescription([
      `Open the private board below to view this week's lines, check your card, and place bets.`,
      `Eligible: coaches and <@&${loadRoleMap()['Ghost Legacy']}>`,
      ``,
      `Markets: spread, moneyline, over/under`,
      `Rules: current week only • max ${MAX_GAME_MARKETS} markets per game`,
      `Season offer: First Bet Boost • your first bet pays ${FIRST_BET_BOOST_MULTIPLIER}x profit if it wins`,
      `Your Impact available to bet, limits, and payouts are shown inside the private board.`,
      `Winning bets return your Impact and add bonus Impact.`,
    ].join('\n'))
    .setFooter({ text: `${seasonKey.replace('_', ' ')} • private board opens only for you` })
    .setTimestamp();
  if (intel) {
    embed.addFields(
      { name: 'Board Intel', value: [intel.bestSide, intel.totalToWatch, intel.trapLine, intel.stayAway].join('\n') },
      { name: 'Featured Bonus', value: intel.featured },
    );
  }
  return embed;
}

function headerRows(weekNumber) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_open|${weekNumber}|board|0`)
        .setLabel('Open Private Lines, Card & Bets')
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

export async function postSportsbookWeek({ client, guild, seasonKey, weekNumber, snapshot, games = [], teamsById = {} }) {
  // Sportsbook channel is deprecated. The board is accessed privately via Franchise Hub.
  // We still persist weekly lines here so the private view has something to render.
  const store = loadStore();
  const seasonStore = ensureSeason(store, seasonKey);
  const weekKey = `week_${weekNumber}`;
  const weekStore = ensureWeek(seasonStore, weekKey);
  const lines = buildLinesForGames(snapshot, games, teamsById, weekNumber);
  const gotw = getRecognitionGameOfWeek({
    guildId: guild?.id,
    league: 'madden',
    seasonKey,
    weekKey,
  });
  weekStore.lines = lines;
  // Clear any legacy channel post pointers so they don't get refreshed/recreated.
  weekStore.posts = null;
  saveStore(store);
  return weekStore;
}

export async function ensureSportsbookWeekPosted({ client, guild, mode = 'all' } = {}) {
  if (!client || !guild) return null;
  const context = getSportsbookContextForGuild(guild.id);
  if (!context?.seasonKey || !context?.weekNumber || !context?.games?.length) return null;

  // Startup safety: only ensure the *current* board exists. This prevents old weeks
  // (like a settled Week 6) from being recreated if their stored message IDs went stale.
  if (mode === 'currentOnly') {
    const store = loadStore();
    const seasonStore = store?.[context.seasonKey];
    const currentWeekKey = `week_${context.weekNumber}`;
    const weekStore = seasonStore?.weeks?.[currentWeekKey];
    if (weekStore?.settled) return null;
  }
  return postSportsbookWeek({
    client,
    guild,
    seasonKey: context.seasonKey,
    weekNumber: context.weekNumber,
    snapshot: context.snapshot,
    games: context.games,
    teamsById: context.teamsById,
  });
}

export async function refreshSportsbookHeaders({ client, guild, mode = 'all' } = {}) {
  // No-op: sportsbook channel headers are deprecated.
  return { updated: 0 };
}

export function sportsbookModal(customId, line) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(`${line.awayTeam} at ${line.homeTeam}`);
  const wagerInput = new TextInputBuilder()
    .setCustomId('wager')
    .setLabel('Type a whole number only (example: 5)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3)
    .setPlaceholder('5 = bet 5 Impact');
  modal.addComponents(new ActionRowBuilder().addComponents(wagerInput));
  return modal;
}

export function getLineForBet(seasonKey, weekNumber, gameId) {
  const store = loadStore();
  const seasonStore = store?.[seasonKey];
  const weekStore = seasonStore?.weeks?.[`week_${weekNumber}`];
  return weekStore?.lines?.find((entry) => entry.gameId === gameId) || null;
}

function linePrice(line, market, selection) {
  if (market === 'moneyline') {
    return selection === 'away' ? line.awayMoneyline : line.homeMoneyline;
  }
  if (market === 'total') return TOTAL_PRICE;
  return SPREAD_PRICE;
}

export function placeSportsbookBet({ guildId, member, userId, seasonKey, weekNumber, gameId, market, selection, wager }) {
  const roleMap = loadRoleMap();
  if (!isCoachOrGhostLegacy(member, roleMap)) {
    return { ok: false, message: 'Only coaches and Ghost Legacy members can use the sportsbook.' };
  }
  const liveContext = getSportsbookContextForGuild(guildId);
  if (!liveContext?.seasonKey || !liveContext?.weekNumber) {
    return { ok: false, message: 'The sportsbook is not open right now.' };
  }
  if (String(seasonKey) !== String(liveContext.seasonKey) || Number(weekNumber) !== Number(liveContext.weekNumber)) {
    return { ok: false, message: 'Only the current week board is open for betting.' };
  }
  const line = getLineForBet(seasonKey, weekNumber, gameId);
  if (!line) return { ok: false, message: 'This betting line is no longer available.' };
  if (gameAlreadyPlayed(liveContext.leagueId, weekNumber, line, liveContext.games || [])) {
    return { ok: false, message: 'This game has already been logged as played. Betting is closed.' };
  }
  const coachTeams = coachTeamsFromMember(member, roleMap).map(normalizeName);
  const bettingOwnGame = coachTeams.some((team) =>
    team === normalizeName(line.awayTeam) || team === normalizeName(line.homeTeam),
  );
  if (bettingOwnGame) {
    return { ok: false, message: 'Coaches cannot bet on their own games.' };
  }
  const store = loadStore();
  const seasonStore = ensureSeason(store, seasonKey);
  const weekStore = ensureWeek(seasonStore, `week_${weekNumber}`);
  if (weekStore.settled) return { ok: false, message: 'This week is already settled.' };
  const bankroll = ensureBankroll(
    seasonStore,
    String(userId),
    initialSportsbookImpact({ guildId, seasonKey, userId }),
  );
  const limits = getSportsbookLimits(bankroll.balance);
  const amount = Number(wager || 0);
  if (!Number.isFinite(amount) || amount < 1 || amount > limits.maxWager) {
    return { ok: false, message: `Bet amount must be between 1 and ${limits.maxWager} based on your Impact available to bet.` };
  }
  const existing = weekStore.bets.find((bet) =>
    String(bet.userId) === String(userId) &&
    bet.gameId === gameId &&
    bet.market === market,
  );
  if (existing && existing.status === 'open') {
    return { ok: false, message: 'You already have a bet in this market for this game. Open bets cannot be edited.' };
  }
  if (marketCountForGame(weekStore, userId, gameId, existing?.market) >= MAX_GAME_MARKETS) {
    return { ok: false, message: `You can only hold ${MAX_GAME_MARKETS} open markets on one game.` };
  }
  const weeklyExposure = openExposureForWeek(weekStore, userId, existing);
  if ((weeklyExposure + amount) > limits.maxWeeklyExposure) {
    return { ok: false, message: `You can only keep ${formatImpactValue(limits.maxWeeklyExposure)} in open bets this week.` };
  }
  if (bankroll.balance < amount) {
    return { ok: false, message: `You only have ${formatImpactValue(bankroll.balance)} Impact available to bet.` };
  }
  bankroll.balance -= amount;
  bankroll.totalWagered += amount;
  const price = linePrice(line, market, selection);
  const placedAt = Date.now();
  const firstBetBoost = !bankroll.firstBetBoostUsed && !bankroll.firstBetBoostBetPlacedAt;
  const betLabel =
    market === 'moneyline'
      ? `${selection === 'away' ? line.awayTeam : line.homeTeam} moneyline ${formatSigned(price)}`
      : market === 'total'
        ? `${selection === 'over' ? 'Over' : 'Under'} ${line.total} ${formatSigned(price)}`
        : `${selection === 'away' ? line.awaySpreadDisplay : line.homeSpreadDisplay} ${formatSigned(price)}`;
  const record = {
    userId: String(userId),
    gameId,
    market,
    selection,
    matchupLabel: `${line.awayTeam} at ${line.homeTeam}`,
    betLabel,
    wager: amount,
    price,
    status: 'open',
    placedAt,
    firstBetBoost,
  };
  if (firstBetBoost) {
    bankroll.firstBetBoostUsed = true;
    bankroll.firstBetBoostBetPlacedAt = placedAt;
  }
  weekStore.bets.push(record);
  saveStore(store);
  const payout = payoutBreakdown(amount, price);
  return {
    ok: true,
    line,
    balance: bankroll.balance,
    price,
    payout,
    limits,
  };
}

export function getSportsbookUserCard({ seasonKey, weekNumber, userId, guildId = null }) {
  const store = loadStore();
  const seasonStore = store?.[seasonKey];
  const bankroll = seasonStore?.bankrolls?.[String(userId)] || {
    balance: initialSportsbookImpact({ guildId, seasonKey, userId }),
    profit: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
  };
  const weekStore = seasonStore?.weeks?.[`week_${weekNumber}`] || { bets: [] };
  const bets = (weekStore.bets || []).filter((bet) => String(bet.userId) === String(userId));
  return { bankroll, bets, lines: weekStore.lines || [] };
}

function parseMatchupFromGameId(gameId = '') {
  const parts = String(gameId || '').split(':');
  if (parts.length !== 3) return null;
  const awayTeamId = Number(parts[1]);
  const homeTeamId = Number(parts[2]);
  if (!Number.isFinite(awayTeamId) || !Number.isFinite(homeTeamId)) return null;
  return { awayTeamId, homeTeamId };
}

function buildTeamsByIdFromStoreOrSnapshot(lines = [], guildId = null) {
  const map = new Map();
  for (const line of lines || []) {
    if (line?.awayTeamId != null && line?.awayTeam) map.set(Number(line.awayTeamId), String(line.awayTeam));
    if (line?.homeTeamId != null && line?.homeTeam) map.set(Number(line.homeTeamId), String(line.homeTeam));
  }
  if (guildId == null) return map;
  try {
    const leagueId = resolveLeagueIdWithConfig(guildId);
    if (!leagueId) return map;
    const snapshot = loadLeagueSnapshot(leagueId);
    for (const team of snapshot?.teams?.leagueTeamInfoList || []) {
      const teamId = Number(team?.teamId);
      const label = String(team?.displayName || team?.nickName || team?.longName || '').trim();
      if (Number.isFinite(teamId) && label) map.set(teamId, label);
    }
  } catch { }
  return map;
}

function resolveBetMatchupLabel(bet = {}, lines = [], guildId = null) {
  if (bet?.matchupLabel) return String(bet.matchupLabel);
  const line = (lines || []).find((entry) => String(entry?.gameId || '') === String(bet?.gameId || ''));
  if (line?.awayTeam && line?.homeTeam) return `${line.awayTeam} at ${line.homeTeam}`;
  const parsed = parseMatchupFromGameId(bet?.gameId || '');
  if (!parsed) return 'Unknown game';
  const teamsById = buildTeamsByIdFromStoreOrSnapshot(lines, guildId);
  const away = teamsById.get(parsed.awayTeamId);
  const home = teamsById.get(parsed.homeTeamId);
  return away && home ? `${away} at ${home}` : 'Unknown game';
}

export function getSportsbookOpenBetOpportunity({ seasonKey, userId, weekNumber = null, guildId = null }) {
  const store = loadStore();
  const seasonStore = store?.[seasonKey];
  const bankroll = seasonStore?.bankrolls?.[String(userId)] || {
    balance: initialSportsbookImpact({ guildId, seasonKey, userId }),
    profit: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
  };
  const weekKeys = weekNumber != null
    ? [`week_${weekNumber}`]
    : Object.keys(seasonStore?.weeks || {});
  let total = 0;
  let count = 0;
  for (const key of weekKeys) {
    const weekStore = seasonStore?.weeks?.[key];
    for (const bet of weekStore?.bets || []) {
      if (String(bet?.userId) !== String(userId)) continue;
      if (String(bet?.status || '') !== 'open') continue;
      count += 1;
      total += Number(payoutBreakdown(bet?.wager || 0, bet?.price || 0)?.profit || 0);
    }
  }
  return {
    bankroll,
    total: Math.round(total * 10) / 10,
    count,
  };
}

export function sportsbookLeaderboard(seasonKey, limit = 10) {
  const store = loadStore();
  const seasonStore = store?.[seasonKey];
  const rows = Object.entries(seasonStore?.bankrolls || {}).map(([userId, value]) => ({
    userId,
    balance: Number(value.balance || 0),
    profit: Number(value.profit || 0),
    wins: Number(value.wins || 0),
    losses: Number(value.losses || 0),
    pushes: Number(value.pushes || 0),
  }));
  rows.sort((a, b) => (b.balance - a.balance) || (b.profit - a.profit));
  return rows.slice(0, limit);
}

function openBetsForGame(bets = [], gameId) {
  return bets.filter((bet) => bet.gameId === gameId && bet.status === 'open');
}

function cardLinesForUser(bets = [], lines = [], guildId = null) {
  return bets.length
    ? bets
      .slice()
      .sort((a, b) => Number(b.placedAt || 0) - Number(a.placedAt || 0))
      .slice(0, 8)
      .map((bet) => {
        const matchupLabel = resolveBetMatchupLabel(bet, lines, guildId);
        const baseLabel = bet.betLabel || `${bet.market} ${bet.selection}`;
        const oddsLabel = Number.isFinite(Number(bet?.price || 0)) && Number(bet?.price || 0) !== 0 && !String(baseLabel).includes(formatSigned(Number(bet.price || 0)))
          ? ` @ ${formatSigned(Number(bet.price || 0))}`
          : '';
        if (bet.status === 'buyout') {
          return `${matchupLabel} • ${baseLabel}${oddsLabel} • ${formatImpactValue(bet.wager)} • buyout for ${formatImpactValue(bet.refund || 0)}`;
        }
        return `${matchupLabel} • ${baseLabel}${oddsLabel} • ${formatImpactValue(bet.wager)} • ${bet.status}`;
      })
    : ['No bets placed for this week.'];
}

function openBuyoutBetsForUser(bets = []) {
  return bets
    .filter((bet) => String(bet?.status || '') === 'open')
    .slice()
    .sort((a, b) => Number(b?.placedAt || 0) - Number(a?.placedAt || 0));
}

function normalizeTeamKey(name = '') {
  return normalizeName(name);
}

function userOwnsSportsbookGame({ guildId, userId, line }) {
  if (!guildId || !userId || !line) return false;
  const assignments = getCoachAssignmentMap({ guildId });
  const teams = assignments?.userToTeams?.get?.(String(userId)) || [];
  const owned = new Set(teams.map((team) => normalizeTeamKey(team)));
  return owned.has(normalizeTeamKey(line.awayTeam)) || owned.has(normalizeTeamKey(line.homeTeam));
}

function viewNavRow(weekNumber, mode, index, hasBoard = true) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|tab_breakdown|0`).setLabel('Week Breakdown').setStyle(mode === 'breakdown' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|tab_board|${index}`).setLabel('Board').setStyle(mode === 'board' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!hasBoard),
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|tab_card|0`).setLabel('My Card').setStyle(mode === 'card' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|tab_leaderboard|0`).setLabel('Leaderboard').setStyle(mode === 'leaderboard' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
}

function breakdownPagerRow(weekNumber, index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|breakdown_prev|${Math.max(0, index - 1)}`).setLabel('Prev Game').setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|breakdown_next|${Math.min(total - 1, index + 1)}`).setLabel('Next Game').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
  );
}

function pageRow(weekNumber, index, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|page_prev|${Math.max(0, index - 1)}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(index <= 0),
    new ButtonBuilder().setCustomId(`madden_sportsbook_view|${weekNumber}|page_next|${Math.min(total - 1, index + 1)}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index >= total - 1),
  );
}

function betRows(line) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|spread|away`).setLabel(line.awaySpreadDisplay).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|spread|home`).setLabel(line.homeSpreadDisplay).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|total|over`).setLabel(`Over ${line.total}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|total|under`).setLabel(`Under ${line.total}`).setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|moneyline|away`).setLabel(`${line.awayTeam} ML ${formatSigned(line.awayMoneyline)}`).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`madden_sportsbook_bet|${line.weekNumber}|${line.gameId}|moneyline|home`).setLabel(`${line.homeTeam} ML ${formatSigned(line.homeMoneyline)}`).setStyle(ButtonStyle.Success),
    ),
  ];
}

function buyoutRows(openBets = [], weekNumber = 0) {
  const rows = [];
  const bets = openBets.slice(0, 5);
  for (let i = 0; i < bets.length; i += 2) {
    const row = new ActionRowBuilder();
    for (const bet of bets.slice(i, i + 2)) {
      const shortLabel = `${bet.matchupLabel || 'Bet'} • ${formatImpactValue(Math.round((Number(bet.wager || 0) * 0.5) * 10) / 10)}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_sportsbook_buyout|${weekNumber}|${encodeURIComponent(String(bet.gameId))}|${bet.placedAt}`)
          .setLabel(shortLabel.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
      );
    }
    rows.push(row);
  }
  return rows;
}

async function resolveSportsbookUserLabel(guild, userId) {
  const compact = String(userId || '').trim();
  if (!compact) return 'Unknown Coach';
  const member = guild?.members?.cache?.get?.(compact)
    || await guild?.members?.fetch?.(compact).catch(() => null);
  const user = member?.user || await guild?.client?.users?.fetch?.(compact).catch(() => null);
  return member?.displayName
    || user?.globalName
    || user?.username
    || `Coach ${compact.slice(-4)}`;
}

export async function buildSportsbookPrivateView({ seasonKey, weekNumber, userId, guildId = null, guild = null, mode = 'board', index = 0 }) {
  const card = getSportsbookUserCard({ seasonKey, weekNumber, userId, guildId });
  const lines = card.lines || [];
  const safeIndex = lines.length ? Math.max(0, Math.min(lines.length - 1, Number(index || 0))) : 0;
  const components = [viewNavRow(weekNumber, mode, safeIndex, lines.length > 0)];

  if (mode === 'breakdown') {
    const store = loadStore();
    const weekStore = store?.[seasonKey]?.weeks?.[`week_${weekNumber}`] || {};
    const gotwSeasonKey = resolveRecognitionSeasonKeyForGuild(guildId, seasonKey);
    const gotw = getRecognitionGameOfWeek({
      guildId,
      league: 'madden',
      seasonKey: gotwSeasonKey,
      weekKey: `week_${weekNumber}`,
    });
    const intel = buildSportsbookIntel(weekStore?.lines || [], gotw);
    const popular = mostPopularBetForWeek(weekStore) || mostPopularLineFromBoard(weekStore?.lines || lines);
    const openOpp = getSportsbookOpenBetOpportunity({ seasonKey, userId, weekNumber, guildId });

    const featuredFallbackLabel = featuredGameLabelFromSnapshot(openOpp?.snapshot, weekNumber);
    const featuredLabel = gotwLabelFromRecognition(gotw) || featuredFallbackLabel;

    if (lines.length) {
      components.push(breakdownPagerRow(weekNumber, safeIndex, lines.length));
    }

    const focusLine = lines[safeIndex] || null;
    const focusLabel = focusLine
      ? `${focusLine.awayTeam} at ${focusLine.homeTeam} • line: ${favoriteLabel(focusLine)} • O/U ${focusLine.total}`
      : null;

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`LB Sportsbook • Week Breakdown • Week ${weekNumber}`)
      .setDescription([
        `Impact available to bet: **${formatImpactValue(openOpp?.bankroll?.balance || 0)}**`,
        openOpp?.count ? `Open bets: **${openOpp.count}** • live max profit: **${formatImpactValue(openOpp.total || 0)}**` : 'Open bets: **0**',
        focusLabel ? `\n**Current matchup:** ${focusLabel}` : null,
        '',
        `**Best Line:** ${intel?.bestSide || 'Not available yet.'}`,
        `**Most Popular Bet:** ${popular ? `**${popular.matchupLabel}** • ${popular.label}${popular.count ? ` (${popular.count})` : ''}` : 'No bets placed yet.'}`,
        `**Trap Line:** ${intel?.trapLine || 'Not available yet.'}`,
        `**Stay Away:** ${intel?.stayAway || 'Not available yet.'}`,
        '',
        '**Game of the Week Bonus**',
        featuredLabel
          ? `${featuredLabel}${gotwLabelFromRecognition(gotw) ? '' : ' *(featured game)*'}\nWinning bets on this matchup add **+${GAME_OF_WEEK_BET_BONUS} ${IMPACT_EMOJI}** profit.`
          : 'Not set yet.',
      ].filter(Boolean).join('\n'))
      .setFooter({ text: 'Private view • start here each week, then browse the book' })
      .setTimestamp();

    return { embeds: [embed], components };
  }

  if (mode === 'card') {
    const buyoutActive = Boolean(hasRecognitionPerk({
      guildId,
      league: 'madden',
      seasonKey,
      weekKey: `week_${weekNumber}`,
      userId: String(userId),
      perkKey: 'betBuyout',
    }));
    const buyoutBets = buyoutActive ? openBuyoutBetsForUser(card.bets) : [];
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`LB Sportsbook • My Card • Week ${weekNumber}`)
      .setDescription(cardLinesForUser(card.bets, card.lines, guildId).join('\n'))
      .addFields(
        { name: 'Impact To Bet', value: formatImpactValue(card.bankroll.balance || 0), inline: true },
        { name: 'Impact Won', value: formatImpactValue(card.bankroll.profit || 0), inline: true },
        { name: 'Record', value: `${card.bankroll.wins || 0}-${card.bankroll.losses || 0}-${card.bankroll.pushes || 0}`, inline: true },
        { name: 'First Bet Boost', value: firstBetBoostState(card), inline: false },
      )
      .setFooter({ text: 'Private view • open bets and settled results' })
      .setTimestamp();
    if (buyoutActive) {
      embed.addFields({
        name: 'Bet Buyout',
        value: buyoutBets.length
          ? 'Your buyout perk is live. Use one button below to cash out an open bet for 50% of the stake before kickoff.'
          : 'Your buyout perk is live, but there is no open bet eligible to cash out right now.',
        inline: false,
      });
    }
    if (buyoutBets.length) components.push(...buyoutRows(buyoutBets, weekNumber));
    return { embeds: [embed], components };
  }

  if (mode === 'leaderboard') {
    const board = sportsbookLeaderboard(seasonKey, 10);
    const lines = await Promise.all(
      board.map(async (row, idx) => `${idx + 1}. ${await resolveSportsbookUserLabel(guild, row.userId)} — ${formatImpactValue(row.balance)} bankroll (${row.wins}-${row.losses}-${row.pushes})`)
    );
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`LB Sportsbook • Leaderboard • Week ${weekNumber}`)
      .setDescription(
        board.length
          ? lines.join('\n')
          : 'No sportsbook action yet.',
      )
      .setFooter({ text: 'Private view • sportsbook standings' })
      .setTimestamp();
    return { embeds: [embed], components };
  }

  if (!lines.length) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`LB Sportsbook • Week ${weekNumber}`)
      .setDescription('This week does not have an active board yet.')
      .setTimestamp();
    return { embeds: [embed], components };
  }

  const line = lines[safeIndex];
  const gameBets = openBetsForGame(card.bets, line.gameId);
  const limits = getSportsbookLimits(card.bankroll.balance || STARTING_BANKROLL);
  const priceGuide = payoutBreakdown(5, SPREAD_PRICE);
  const ownGameBlocked = userOwnsSportsbookGame({ guildId, userId, line });
  const gotwSeasonKey = resolveRecognitionSeasonKeyForGuild(guildId, seasonKey);
  const gotw = guildId ? getRecognitionGameOfWeek({ guildId, league: 'madden', seasonKey: gotwSeasonKey, weekKey: `week_${weekNumber}` }) : null;
  const gotwMatch = gotw && normalizeName(gotw.awayTeam) === normalizeName(line.awayTeam) && normalizeName(gotw.homeTeam) === normalizeName(line.homeTeam);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`LB Sportsbook • Week ${weekNumber}`)
    .setDescription([
      `**${line.awayTeam} at ${line.homeTeam}**`,
      `${line.awayTeam} (${line.awayRecord}) vs ${line.homeTeam} (${line.homeRecord})`,
      '',
      `Spread: ${line.favorite === 'home' ? line.homeSpreadDisplay : line.awaySpreadDisplay}`,
      `Moneyline: ${line.awayTeam} ${formatSigned(line.awayMoneyline)} • ${line.homeTeam} ${formatSigned(line.homeMoneyline)}`,
      `Over/Under: ${line.total}`,
      '',
      'How to bet: Spread = beat the number • ML = just win • O/U = total points',
      `Impact available to bet: ${formatImpactValue(card.bankroll.balance || 0)}`,
      `Max on one bet: ${formatImpactValue(limits.maxWager)}`,
      `Max open this week: ${formatImpactValue(limits.maxWeeklyExposure)}`,
      `Example: bet ${formatImpactValue(priceGuide.stake)} at -110 • if it wins, you profit ${formatImpactValue(priceGuide.profit)} and get back ${formatImpactValue(priceGuide.totalReturn)} total`,
      gotwMatch ? `Featured bonus: this is Game of the Week • winning bets add +${GAME_OF_WEEK_BET_BONUS} ${IMPACT_EMOJI}` : null,
      gameBets.length
        ? `Your bets on this game: ${gameBets.map((bet) => `${bet.betLabel || `${bet.market} ${bet.selection}`} ${formatImpactValue(bet.wager)}`).join(' • ')}`
        : 'Your bets on this game: none yet.',
      '',
      ownGameBlocked
        ? 'You cannot bet this game because it is your matchup.'
        : 'Pick a button below to bet spread, moneyline, or total.',
    ].filter(Boolean).join('\n'))
    .setFooter({ text: `Game ${safeIndex + 1} of ${lines.length} • private betting board` })
    .setTimestamp();

  components.push(pageRow(weekNumber, safeIndex, lines.length));
  if (!ownGameBlocked) components.push(...betRows(line));
  return { embeds: [embed], components };
}

export { IMPACT_EMOJI, formatImpactValue, formatImpactDelta, getSportsbookLimits, payoutBreakdown, linePrice };

export function buyoutSportsbookBet({ guildId, seasonKey, weekNumber, userId, gameId, placedAt }) {
  if (!guildId || !seasonKey || !weekNumber || !userId || !gameId || !placedAt) {
    return { ok: false, message: 'Missing buyout context.' };
  }
  const weekKey = `week_${weekNumber}`;
  if (!hasRecognitionPerk({ guildId, league: 'madden', seasonKey, weekKey, userId: String(userId), perkKey: 'betBuyout' })) {
    return { ok: false, message: 'Bet Buyout is not active for this week.' };
  }
  const liveContext = getSportsbookContextForGuild(guildId);
  if (!liveContext?.seasonKey || !liveContext?.weekNumber) {
    return { ok: false, message: 'The sportsbook is not open right now.' };
  }
  if (String(seasonKey) !== String(liveContext.seasonKey) || Number(weekNumber) !== Number(liveContext.weekNumber)) {
    return { ok: false, message: 'Bet Buyout only works on the current week board.' };
  }
  const store = loadStore();
  const seasonStore = ensureSeason(store, seasonKey);
  const weekStore = ensureWeek(seasonStore, weekKey);
  const bet = (weekStore.bets || []).find((entry) =>
    String(entry?.userId) === String(userId) &&
    String(entry?.gameId) === String(gameId) &&
    Number(entry?.placedAt || 0) === Number(placedAt) &&
    String(entry?.status || '') === 'open');
  if (!bet) {
    return { ok: false, message: 'That open bet is no longer available for buyout.' };
  }
  const line = weekStore.lines.find((entry) => String(entry?.gameId) === String(gameId));
  if (!line) {
    return { ok: false, message: 'This betting line is no longer available.' };
  }
  if (gameAlreadyPlayed(liveContext.leagueId, weekNumber, line, liveContext.games || [])) {
    return { ok: false, message: 'That game has already been logged as played, so the bet cannot be bought out.' };
  }
  const bankroll = ensureBankroll(seasonStore, String(userId), initialSportsbookImpact({ guildId, seasonKey, userId }));
  const refund = Math.round((Number(bet.wager || 0) * 0.5) * 10) / 10;
  const realizedLoss = Math.max(0, Number(bet.wager || 0) - refund);
  bankroll.balance += refund;
  bankroll.profit -= realizedLoss;
  bet.status = 'buyout';
  bet.refund = refund;
  bet.buyoutAt = Date.now();
  bet.profit = -realizedLoss;
  saveStore(store);
  consumeRecognitionPerk({
    guildId,
    league: 'madden',
    seasonKey,
    weekKey,
    userId: String(userId),
    perkKey: 'betBuyout',
    reason: 'Consumed Bet Buyout',
  });
  return {
    ok: true,
    bet,
    line,
    refund,
    realizedLoss,
    balance: bankroll.balance,
  };
}

export function resetSportsbookUserSeason({ seasonKey, userId, reason = 'Coach role removed' }) {
  if (!seasonKey || !userId) return { ok: false, message: 'Missing sportsbook reset context.' };
  if (PROTECTED_SPORTSBOOK_USER_IDS.has(String(userId))) {
    return { ok: false, protected: true, message: 'Sportsbook reset skipped for protected user.' };
  }
  const store = loadStore();
  const seasonStore = ensureSeason(store, seasonKey);
  const userKey = String(userId);
  const bankroll = seasonStore?.bankrolls?.[userKey] || null;
  const userBets = [];
  for (const [weekKey, weekStore] of Object.entries(seasonStore?.weeks || {})) {
    const remaining = [];
    for (const bet of weekStore?.bets || []) {
      if (String(bet.userId) === userKey) {
        userBets.push({ weekKey, ...bet });
      } else {
        remaining.push(bet);
      }
    }
    weekStore.bets = remaining;
  }
  if (!bankroll && !userBets.length) {
    return { ok: false, message: 'No sportsbook state found for this user in the current season.' };
  }
  seasonStore.archivedUsers = seasonStore.archivedUsers || {};
  seasonStore.archivedUsers[userKey] = seasonStore.archivedUsers[userKey] || [];
  seasonStore.archivedUsers[userKey].push({
    ts: Date.now(),
    reason,
    bankroll,
    bets: userBets,
  });
  seasonStore.archivedUsers[userKey] = seasonStore.archivedUsers[userKey].slice(-5);
  if (seasonStore.bankrolls?.[userKey]) delete seasonStore.bankrolls[userKey];
  saveStore(store);
  return { ok: true, archived: true, betCount: userBets.length };
}

function settleBet(line, bet, game) {
  const awayScore = Number(game.awayScore || 0);
  const homeScore = Number(game.homeScore || 0);
  if (bet.market === 'spread') {
    const favoriteScore = line.favorite === 'away' ? awayScore : homeScore;
    const underdogScore = line.favorite === 'away' ? homeScore : awayScore;
    const margin = favoriteScore - underdogScore;
    const favoriteCovered = margin > line.spread;
    const push = margin === line.spread;
    if (push) return { result: 'push', profit: 0 };
    const selectionWins =
      (bet.selection === line.favorite && favoriteCovered) ||
      (bet.selection !== line.favorite && !favoriteCovered);
    return { result: selectionWins ? 'win' : 'loss', profit: selectionWins ? americanProfit(bet.wager, bet.price) : -bet.wager };
  }
  if (bet.market === 'total') {
    const totalScore = awayScore + homeScore;
    if (totalScore === line.total) return { result: 'push', profit: 0 };
    const over = totalScore > line.total;
    const selectionWins = (bet.selection === 'over' && over) || (bet.selection === 'under' && !over);
    return { result: selectionWins ? 'win' : 'loss', profit: selectionWins ? americanProfit(bet.wager, bet.price) : -bet.wager };
  }
  const awayWon = awayScore > homeScore;
  const selectionWins = (bet.selection === 'away' && awayWon) || (bet.selection === 'home' && !awayWon);
  return { result: selectionWins ? 'win' : 'loss', profit: selectionWins ? americanProfit(bet.wager, bet.price) : -bet.wager };
}

export async function settleSportsbookWeek({ client, guildId, seasonKey, weekNumber, games = [] }) {
  const store = loadStore();
  const seasonStore = ensureSeason(store, seasonKey);
  const weekStore = ensureWeek(seasonStore, `week_${weekNumber}`);
  if (weekStore.settled) return null;
  const gameMap = new Map((games || []).map((game) => [`${weekNumber}:${Number(game.awayTeamId)}:${Number(game.homeTeamId)}`, game]));
  let settled = 0;
  const summary = [];
  for (const bet of weekStore.bets || []) {
    if (bet.status !== 'open') continue;
    const line = weekStore.lines.find((entry) => entry.gameId === bet.gameId);
    const game = gameMap.get(bet.gameId);
    if (!line || !game || !hasRealPlayedSignal(game)) continue;
    const bankroll = ensureBankroll(seasonStore, String(bet.userId));
    const outcome = settleBet(line, bet, game);
    let firstBetBoostBonus = 0;
    if (outcome.result === 'win' && bet.firstBetBoost) {
      firstBetBoostBonus = Math.min(
        Number(outcome.profit || 0) * (FIRST_BET_BOOST_MULTIPLIER - 1),
        FIRST_BET_BOOST_MAX_EXTRA,
      );
      outcome.profit = Math.round((Number(outcome.profit || 0) + firstBetBoostBonus) * 10) / 10;
    }
    bet.status = outcome.result;
    bet.profit = outcome.profit;
    bet.settledAt = Date.now();
    bet.impactAward = 0;
    bet.firstBetBoostBonus = firstBetBoostBonus;
    if (firstBetBoostBonus > 0) bankroll.firstBetBoostBonus = Number(firstBetBoostBonus || 0);
    settled += 1;
    if (outcome.result === 'push') {
      bankroll.pushes += 1;
      bankroll.balance += Number(bet.wager || 0);
    } else if (outcome.result === 'win') {
      bankroll.wins += 1;
      bankroll.profit += Number(outcome.profit || 0);
      bankroll.balance += Number(bet.wager || 0) + Number(outcome.profit || 0);
      let impactAward = Math.max(1, Math.round(Number(outcome.profit || 0)));
      const gotwSeasonKey = resolveRecognitionSeasonKeyForGuild(guildId, seasonKey);
      const gotw = getRecognitionGameOfWeek({
        guildId,
        league: 'madden',
        seasonKey: gotwSeasonKey,
        weekKey: `week_${weekNumber}`,
      });
      if (
        gotw &&
        line &&
        normalizeName(gotw.awayTeam) === normalizeName(line.awayTeam) &&
        normalizeName(gotw.homeTeam) === normalizeName(line.homeTeam)
      ) {
        impactAward += GAME_OF_WEEK_BET_BONUS;
      }
      bet.impactAward = impactAward;
      awardRecognitionPoints({
        guildId,
        league: 'madden',
        seasonKey,
        userId: String(bet.userId),
        tier: 'impact',
        amount: impactAward,
        reason: `Sportsbook win • Week ${weekNumber}`,
        weekKey: `week_${weekNumber}`,
      });
    } else {
      bankroll.losses += 1;
      bankroll.profit -= Number(bet.wager || 0);
    }
    summary.push({ userId: String(bet.userId), wager: Number(bet.wager || 0), ...outcome });
  }
  if (!settled) return null;
  weekStore.settled = true;
  weekStore.settledAt = Date.now();
  saveStore(store);

  // With the sportsbook channel being optional, always DM coaches their personal results.
  if (client) {
    const settledByUser = new Map();
    for (const bet of weekStore.bets || []) {
      if (!bet?.userId) continue;
      if (!['win', 'loss', 'push', 'buyout'].includes(String(bet.status || ''))) continue;
      const list = settledByUser.get(String(bet.userId)) || [];
      list.push(bet);
      settledByUser.set(String(bet.userId), list);
    }

    await Promise.all(
      [...settledByUser.entries()].map(async ([userId, bets]) => {
        const user = await client.users.fetch(String(userId)).catch(() => null);
        if (!user) return;
        const wins = (bets || []).filter((bet) => bet.status === 'win');
        const totalProfit = Math.round((bets || []).reduce((sum, bet) => sum + Number(bet?.profit || 0), 0) * 10) / 10;

        const embed = new EmbedBuilder()
          .setColor(wins.length ? 0x2ecc71 : 0xe67e22)
          .setTitle(brandTitle(`Sportsbook Slip Results • Week ${weekNumber}`))
          .setDescription(
            [
              wins.length
                ? `You had **${wins.length}** winning bet(s). Your bankroll + Impact earnings are updated in Franchise Hub.`
                : `Your bets are settled. Your bankroll is updated in Franchise Hub.`,
              `Net profit: ${formatImpactValue(totalProfit)}`,
              '',
              (bets || [])
                .slice(0, 10)
                .map((bet) => {
                  const resultLabel = String(bet.status || '').toUpperCase();
                  const profit = Number(bet.profit || 0);
                  const award = Number(bet.impactAward || 0);
                  const awardText = award > 0 ? ` • ${formatImpactDelta(award)}` : '';
                  const buyoutText = bet.status === 'buyout' ? ` • buyout refund ${formatImpactValue(bet.refund || 0)}` : '';
                  return `• **${resultLabel}** — ${bet.matchupLabel || 'Game'}\n  ${bet.betLabel || `${bet.market} ${bet.selection}`} • stake ${formatImpactValue(bet.wager || 0)} • profit ${formatImpactValue(profit)}${awardText}${buyoutText}`;
                })
                .join('\n'),
              (bets || []).length > 10 ? `\n…and ${bets.length - 10} more slip(s).` : null,
              `\nOpen **/madden-franchisehub** → **Open Sportsbook** to review the board + your card anytime.`,
            ].filter(Boolean).join('\n'),
          )
          .setFooter({ text: 'Private DM • results are reflected in Franchise Hub' })
          .setTimestamp();

        await user.send({ embeds: [embed] }).catch(() => null);
      }),
    );
  }

  return summary;
}
