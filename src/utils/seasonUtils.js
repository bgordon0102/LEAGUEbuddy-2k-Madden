import fs from 'fs';
import path from 'path';

const SEASON_FILE = path.join(process.cwd(), 'data', 'season.json');
const DEFAULT_PLAYOFF_START_WEEK = 30; // playoffs begin after 29 games/weeks
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
  const phase = (season.phase || DEFAULT_PHASE).toLowerCase();
  const playoffStart = Number(season.playoffStartWeek ?? DEFAULT_PLAYOFF_START_WEEK);
  const tradeCutoff = Number(season.tradeCutoffWeek ?? DEFAULT_TRADE_CUTOFF_WEEK);
  const scoutingClosed = Boolean(season.scoutingClosed);

  let inferredPhase = 'regular';
  if (phase) {
    inferredPhase = phase;
  } else if (currentWeek >= playoffStart) {
    inferredPhase = 'playoffs';
  }

  return { currentWeek, seasonNo: Number(season.seasonNo ?? 1), phase: inferredPhase, playoffStart, tradeCutoff, scoutingClosed };
}

export function canTrade() {
  const { currentWeek, phase, tradeCutoff } = getSeasonState();
  if (phase === 'playoffs') return false;
  if (phase === 'offseason') return true;
  return currentWeek <= tradeCutoff;
}

export function canProgression() {
  const { phase } = getSeasonState();
  return phase === 'regular';
}
