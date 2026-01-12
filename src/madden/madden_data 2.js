import fs from 'fs';
import path from 'path';
import { getLeagueForGuild } from './madden_config.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');

export function loadLeagueSnapshot(leagueId) {
  if (!leagueId) throw new Error('Missing league_id');
  const file = path.join(LEAGUE_DIR, `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function listLeagueFiles() {
  try {
    return fs.readdirSync(LEAGUE_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

export function getDefaultLeagueId() {
  const files = listLeagueFiles();
  if (!files.length) return null;
  const withMtime = files.map(f => {
    const full = path.join(LEAGUE_DIR, f);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch {}
    return { name: f.replace('.json', ''), mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0]?.name || null;
}

export function resolveLeagueIdWithConfig(guildId) {
  // Prefer stored guild mapping; fall back to latest synced file.
  return getLeagueForGuild(guildId) || getDefaultLeagueId();
}

export function findScheduleForWeek(snapshot, weekIndex) {
  const schedules = snapshot?.schedule?.schedules || [];
  return schedules.filter(s => s.weekIndex === weekIndex);
}

export function currentWeek(snapshot) {
  return snapshot?.currentWeek ?? snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? 1;
}
