import fs from 'fs';
import path from 'path';
import { getMaddenSeasonKey } from '../../shared/madden_metadata.js';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');

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

export function getScoutSeasonKey(snapshot) {
  return getMaddenSeasonKey(snapshot);
}

function emptySeasonState() {
  return {
    players: {},
    order: {},
    boardUi: {},
    suggestedScout: {},
    weeklyPoints: {},
    scoutingBonus: 0,
    scoutingBonusAwardedWeeks: {},
  };
}

function migrateLegacyIntoSeason(rootUser = {}, seasonKey) {
  const seasonState = { ...emptySeasonState(), ...(rootUser?.seasons?.[seasonKey] || {}) };
  seasonState.players = seasonState.players || {};
  seasonState.order = seasonState.order || {};
  seasonState.boardUi = seasonState.boardUi || {};
  seasonState.suggestedScout = seasonState.suggestedScout || {};
  seasonState.weeklyPoints = seasonState.weeklyPoints || {};
  seasonState.scoutingBonusAwardedWeeks = seasonState.scoutingBonusAwardedWeeks || {};
  seasonState.scoutingBonus = Number(seasonState.scoutingBonus || rootUser?.scoutingBonusBySeason?.[seasonKey] || 0);

  if (!Object.keys(seasonState.players).length && rootUser?.players) {
    seasonState.players = { ...rootUser.players };
  }
  if (!Object.keys(seasonState.order).length && rootUser?.order) {
    seasonState.order = { ...rootUser.order };
  }
  if (!Object.keys(seasonState.boardUi).length && rootUser?.boardUi) {
    seasonState.boardUi = { ...rootUser.boardUi };
  }
  if (!Object.keys(seasonState.suggestedScout).length && rootUser?.suggestedScout) {
    seasonState.suggestedScout = { ...rootUser.suggestedScout };
  }

  for (const [weekKey, value] of Object.entries(rootUser?.weeklyPoints || {})) {
    if (String(weekKey).startsWith(`${seasonKey}_`) || String(weekKey).startsWith(`${seasonKey.replace(/^year_/, 'year_')}_`)) {
      seasonState.weeklyPoints[weekKey] = value;
    }
  }
  for (const [weekKey, value] of Object.entries(rootUser?.scoutingBonusAwardedWeeks || {})) {
    if (String(weekKey).startsWith(`${seasonKey}_`) || String(weekKey).startsWith(`${seasonKey.replace(/^year_/, 'year_')}_`)) {
      seasonState.scoutingBonusAwardedWeeks[weekKey] = value;
    }
  }
  return seasonState;
}

export function loadScoutStore() {
  return safeReadJSON(SCOUT_PATH, {});
}

export function saveScoutStore(store) {
  saveJSON(SCOUT_PATH, store || {});
}

export function getSeasonScoutUser(store, userId, seasonKey, { create = true } = {}) {
  if (!store[userId]) {
    if (!create) return null;
    store[userId] = {};
  }
  const rootUser = store[userId];
  rootUser.seasons = rootUser.seasons || {};
  if (!rootUser.seasons[seasonKey]) {
    if (!create) return null;
    rootUser.seasons[seasonKey] = migrateLegacyIntoSeason(rootUser, seasonKey);
  } else {
    rootUser.seasons[seasonKey] = migrateLegacyIntoSeason(rootUser, seasonKey);
  }
  return rootUser.seasons[seasonKey];
}

export function getScoutSummaryForSeason(store, userId, seasonKey) {
  const season = getSeasonScoutUser(store, userId, seasonKey, { create: false });
  return season || emptySeasonState();
}
