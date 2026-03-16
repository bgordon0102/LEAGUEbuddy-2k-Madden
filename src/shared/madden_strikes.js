import fs from 'fs';
import path from 'path';

const STRIKE_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
export const STRIKE_LIMIT = 5;
export const STRIKE_WEIGHTS = {
  fair_sim: 0.5,
  force_win: 1,
  determined_strike: 1.5,
};

function clone(value, fallback) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : fallback;
}

function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

export function loadStrikeStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STRIKE_FILE, 'utf8'));
    return normalizeStrikeStore(raw);
  } catch {
    return {};
  }
}

export function saveStrikeStore(store) {
  fs.mkdirSync(path.dirname(STRIKE_FILE), { recursive: true });
  fs.writeFileSync(STRIKE_FILE, JSON.stringify(store, null, 2));
}

export function normalizeStrikeStore(store = {}) {
  const next = clone(store, {});
  for (const seasonData of Object.values(next)) {
    if (!seasonData || typeof seasonData !== 'object') continue;
    seasonData.counts = seasonData.counts || {};
    seasonData.weightedCounts = seasonData.weightedCounts || {};
    seasonData.consecutive = seasonData.consecutive || {};
    seasonData.categories = seasonData.categories || {};
    seasonData.communication = seasonData.communication || {};

    for (const [key, count] of Object.entries(seasonData.counts)) {
      if (typeof seasonData.weightedCounts[key] !== 'number') {
        seasonData.weightedCounts[key] = Number(count) || 0;
      }
      seasonData.categories[key] = seasonData.categories[key] || {};
      seasonData.communication[key] = seasonData.communication[key] || {};
      const comm = seasonData.communication[key];
      comm.respondedWeeks = Number(comm.respondedWeeks) || 0;
      comm.silentWeeks = Number(comm.silentWeeks) || 0;
      comm.consecutiveSilentWeeks = Number(comm.consecutiveSilentWeeks) || 0;
      comm.onTimeOutcomes = Number(comm.onTimeOutcomes) || 0;
      comm.completedGames = Number(comm.completedGames) || 0;
      comm.nonPlayOutcomes = Number(comm.nonPlayOutcomes) || 0;
      comm.faultOutcomes = Number(comm.faultOutcomes) || 0;
    }
  }
  return next;
}

export function ensureStrikeSeason(store, seasonKey) {
  store[seasonKey] = store[seasonKey] || {};
  const seasonData = store[seasonKey];
  seasonData.counts = seasonData.counts || {};
  seasonData.weightedCounts = seasonData.weightedCounts || {};
  seasonData.consecutive = seasonData.consecutive || {};
  seasonData.categories = seasonData.categories || {};
  seasonData.communication = seasonData.communication || {};
  return seasonData;
}

export function strikeWeight(type) {
  return STRIKE_WEIGHTS[type] ?? 1;
}

function ensureEntity(seasonData, key) {
  seasonData.counts[key] = Number(seasonData.counts[key]) || 0;
  seasonData.weightedCounts[key] = Number(seasonData.weightedCounts[key]) || 0;
  seasonData.consecutive[key] = Number(seasonData.consecutive[key]) || 0;
  seasonData.categories[key] = seasonData.categories[key] || {};
  seasonData.communication[key] = seasonData.communication[key] || {};
  const comm = seasonData.communication[key];
  comm.respondedWeeks = Number(comm.respondedWeeks) || 0;
  comm.silentWeeks = Number(comm.silentWeeks) || 0;
  comm.consecutiveSilentWeeks = Number(comm.consecutiveSilentWeeks) || 0;
  comm.onTimeOutcomes = Number(comm.onTimeOutcomes) || 0;
  comm.completedGames = Number(comm.completedGames) || 0;
  comm.nonPlayOutcomes = Number(comm.nonPlayOutcomes) || 0;
  comm.faultOutcomes = Number(comm.faultOutcomes) || 0;
  comm.history = Array.isArray(comm.history) ? comm.history.slice(-49) : [];
}

export function addStrikeOutcome(store, seasonKey, keys = [], type, label = null) {
  const weight = strikeWeight(type);
  const seasonData = ensureStrikeSeason(store, seasonKey);
  for (const key of [...new Set(keys.filter(Boolean))]) {
    ensureEntity(seasonData, key);
    seasonData.counts[key] += 1;
    seasonData.weightedCounts[key] = round1(seasonData.weightedCounts[key] + weight);
    seasonData.consecutive[key] += 1;
    seasonData.categories[key][type] = (Number(seasonData.categories[key][type]) || 0) + 1;
    const comm = seasonData.communication[key];
    comm.nonPlayOutcomes += 1;
    if (type === 'force_win' || type === 'determined_strike') comm.faultOutcomes += 1;
    comm.history.push({
      kind: 'strike',
      type,
      label: label || (type === 'fair_sim' ? 'FS' : type === 'force_win' ? 'FW' : type === 'determined_strike' ? 'DS' : 'NP'),
      weight,
      ts: Date.now(),
    });
    comm.history = comm.history.slice(-50);
  }
  return seasonData;
}

export function resetCompletedOutcome(store, seasonKey, keys = []) {
  const seasonData = ensureStrikeSeason(store, seasonKey);
  for (const key of [...new Set(keys.filter(Boolean))]) {
    ensureEntity(seasonData, key);
    seasonData.consecutive[key] = 0;
    const comm = seasonData.communication[key];
    comm.completedGames += 1;
    comm.consecutiveSilentWeeks = 0;
    comm.history.push({ kind: 'played', type: 'complete', label: 'PLAY', weight: 0, ts: Date.now() });
    comm.history = comm.history.slice(-50);
  }
  return seasonData;
}

export function recordCommunicationWeek(store, seasonKey, keys = [], options = {}) {
  const seasonData = ensureStrikeSeason(store, seasonKey);
  const {
    responded = false,
    onTime = false,
  } = options;
  for (const key of [...new Set(keys.filter(Boolean))]) {
    ensureEntity(seasonData, key);
    const comm = seasonData.communication[key];
    if (responded) {
      comm.respondedWeeks += 1;
      comm.consecutiveSilentWeeks = 0;
    } else {
      comm.silentWeeks += 1;
      comm.consecutiveSilentWeeks += 1;
    }
    if (onTime) comm.onTimeOutcomes += 1;
  }
  return seasonData;
}

export function weightedCount(seasonData, key) {
  return round1(Number(seasonData?.weightedCounts?.[key]) || 0);
}

export function remainingWeighted(seasonData, keys = []) {
  const result = {};
  for (const key of [...new Set(keys.filter(Boolean))]) {
    result[key] = round1(STRIKE_LIMIT - weightedCount(seasonData, key));
  }
  return result;
}

export function weightedOverLimit(seasonData, keys = []) {
  return [...new Set(keys.filter(Boolean))].filter((key) => weightedCount(seasonData, key) >= STRIKE_LIMIT);
}

export function formatBreakdown(seasonData, key) {
  const categories = seasonData?.categories?.[key] || {};
  const fair = Number(categories.fair_sim) || 0;
  const force = Number(categories.force_win) || 0;
  const determined = Number(categories.determined_strike) || 0;
  const parts = [];
  if (fair) parts.push(`FS ${fair}`);
  if (force) parts.push(`FW ${force}`);
  if (determined) parts.push(`DS ${determined}`);
  return parts.join(' • ') || 'Clean';
}

export function completionRate(seasonData, key) {
  const comm = seasonData?.communication?.[key] || {};
  const played = Number(comm.completedGames) || 0;
  const nonPlay = Number(comm.nonPlayOutcomes) || 0;
  const total = played + nonPlay;
  if (!total) return null;
  return Math.round((played / total) * 100);
}

export function communicationSummary(seasonData, key) {
  const comm = seasonData?.communication?.[key] || {};
  const responded = Number(comm.respondedWeeks) || 0;
  const silent = Number(comm.silentWeeks) || 0;
  const consecutiveSilent = Number(comm.consecutiveSilentWeeks) || 0;
  const onTime = Number(comm.onTimeOutcomes) || 0;
  return { responded, silent, consecutiveSilent, onTime };
}

export function strikeHistory(seasonData, key) {
  const comm = seasonData?.communication?.[key] || {};
  return Array.isArray(comm.history) ? comm.history.slice() : [];
}
