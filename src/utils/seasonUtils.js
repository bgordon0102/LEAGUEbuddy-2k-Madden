import fs from 'fs';
import path from 'path';

const SEASON_FILE = path.join(process.cwd(), 'data', 'season.json');
const DEFAULT_PLAYOFF_START_WEEK = 30; // playoffs begin after week 29
const DEFAULT_OFFSEASON_START_WEEK = 31; // offseason begins after week 30
const DEFAULT_TRADE_CUTOFF_WEEK = 15;
const DEFAULT_PHASE = 'regular'; // regular, playoffs, offseason

function readSeason() {
  try {
    return JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function getSeasonState() {
  const season = readSeason();
  const currentWeek = Number(season.currentWeek ?? 0);
  const phaseRaw = (season.phase || DEFAULT_PHASE).toLowerCase();
  const playoffStart = Number(season.playoffStartWeek ?? DEFAULT_PLAYOFF_START_WEEK);
  const offseasonStart = Number(season.offseasonStartWeek ?? DEFAULT_OFFSEASON_START_WEEK);
  const tradeCutoff = Number(season.tradeCutoffWeek ?? DEFAULT_TRADE_CUTOFF_WEEK);
  const scoutingClosed = Boolean(season.scoutingClosed);

  let inferredPhase = phaseRaw;
  // Always respect week-based boundaries first
  if (currentWeek === 0) {
    inferredPhase = 'offseason';
  } else if (currentWeek >= offseasonStart) {
    inferredPhase = 'offseason';
  } else if (currentWeek >= playoffStart) {
    inferredPhase = 'playoffs';
  } else if (!season.phase) {
    inferredPhase = 'regular';
  }

  return { currentWeek, seasonNo: Number(season.seasonNo ?? 1), phase: inferredPhase, playoffStart, offseasonStart, tradeCutoff, scoutingClosed };
}

export function canTrade() {
  const { currentWeek, phase, tradeCutoff, playoffStart, offseasonStart } = getSeasonState();
  // Offseason: trades open
  if (phase === 'offseason' || currentWeek >= offseasonStart) return true;
  // Playoffs: locked
  if (phase === 'playoffs' || currentWeek >= playoffStart) return false;
  // Regular season: open through cutoff week
  return currentWeek <= tradeCutoff;
}

export function canProgression() {
  const { phase, currentWeek, playoffStart, offseasonStart } = getSeasonState();
  if (phase === 'offseason' || currentWeek >= offseasonStart) return false;
  if (phase === 'playoffs' || currentWeek >= playoffStart) return false;
  return phase === 'regular';
}
