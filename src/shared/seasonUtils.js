import fs from 'fs';
import path from 'path';

// Load season state from data/season.json (if present)
export function getSeasonState() {
  const file = path.join(process.cwd(), 'data', 'season.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

// Progression allowed during regular season weeks 1-29
export function canProgression() {
  const state = getSeasonState();
  if (!state) return true;
  const week = Number(state.currentWeek || state.week || 0);
  const phase = (state.phase || '').toLowerCase();
  if (phase.includes('playoff') || phase.includes('offseason') || phase.includes('off-season')) return false;
  if (week && week > 29) return false;
  return true;
}

// Trade gating: block in playoffs/offseason, allow otherwise
export function canTrade() {
  const state = getSeasonState();
  if (!state) return true;
  const phase = (state.phase || '').toLowerCase();
  if (phase.includes('playoff') || phase.includes('offseason') || phase.includes('off-season')) return false;
  return true;
}
