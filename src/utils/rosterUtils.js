import fs from 'fs';
import path from 'path';
import { TEAM_ALIASES } from './config.js';

const ROSTER_DIR = path.join(process.cwd(), 'data', 'teams_rosters');

function teamToFile(teamName = '') {
  return teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + '.json';
}

export function normalizeName(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function readRoster(teamName) {
  // If we know the canonical file from config, use it directly
  const canonicalFile = TEAM_ALIASES[normalizeName(teamName)] || TEAM_ALIASES[teamName?.toLowerCase?.()] || null;
  const fromConfigFile = canonicalFile || null;

  const fileName = teamToFile(teamName);
  const rosterPath = path.join(ROSTER_DIR, fileName);
  const configPath = fromConfigFile ? path.join(ROSTER_DIR, fromConfigFile) : null;
  const primaryPath = configPath && fs.existsSync(configPath) ? configPath : rosterPath;

  if (!fs.existsSync(primaryPath)) {
    // Try fuzzy/alias mapping for common abbreviations
    const aliasKey = normalizeName(teamName).replace(/_/g, '');
    const aliasFile = TEAM_ALIASES[aliasKey];
    if (aliasFile) {
      const aliasPath = path.join(ROSTER_DIR, aliasFile);
      if (fs.existsSync(aliasPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(aliasPath, 'utf8'));
          const roster = Array.isArray(data)
            ? { players: data, picks: [] }
            : { players: data.players || [], picks: data.picks || [] };
          if (!Array.isArray(roster.players)) roster.players = [];
          if (!Array.isArray(roster.picks)) roster.picks = [];
          return { rosterPath: aliasPath, roster };
        } catch {
          return null;
        }
      }
    }
    // Fallback: scan roster files for best match by normalized name
    try {
      const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
      const normalizedKey = normalizeName(teamName);
      for (const file of files) {
        const base = file.replace('.json', '');
        const normBase = normalizeName(base);
        if (normBase === normalizedKey || normBase.includes(normalizedKey) || normalizedKey.includes(normBase)) {
          const altPath = path.join(ROSTER_DIR, file);
          const data = JSON.parse(fs.readFileSync(altPath, 'utf8'));
          const roster = Array.isArray(data)
            ? { players: data, picks: [] }
            : { players: data.players || [], picks: data.picks || [] };
          if (!Array.isArray(roster.players)) roster.players = [];
          if (!Array.isArray(roster.picks)) roster.picks = [];
          return { rosterPath: altPath, roster };
        }
      }
    } catch {
      return null;
    }
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(primaryPath, 'utf8'));
  } catch {
    return null;
  }
  const roster = Array.isArray(data)
    ? { players: data, picks: [] }
    : { players: data.players || [], picks: data.picks || [] };
  if (!Array.isArray(roster.players)) roster.players = [];
  if (!Array.isArray(roster.picks)) roster.picks = [];
  return { rosterPath: primaryPath, roster };
}

export function saveRoster(rosterPath, roster) {
  fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
}

export function upsertPlayer(roster, playerName, fields = {}) {
  const idx = roster.players.findIndex(p => normalizeName(p.name) === normalizeName(playerName));
  if (idx !== -1) {
    roster.players[idx] = { ...roster.players[idx], name: playerName, ...fields };
  } else {
    roster.players.push({ name: playerName, ...fields });
  }
}

export function removePlayerFromOtherRosters(playerName, targetPath) {
  const removed = [];
  const norm = normalizeName(playerName);
  const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(ROSTER_DIR, file);
    if (path.resolve(full) === path.resolve(targetPath)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const roster = Array.isArray(data)
      ? { players: data, picks: [] }
      : { players: data.players || [], picks: data.picks || [] };
    const before = roster.players.length;
    roster.players = roster.players.filter(p => normalizeName(p.name) !== norm);
    if (roster.players.length !== before) {
      saveRoster(full, roster);
      removed.push(full);
    }
  }
  return removed;
}

export function removePlayerFromOtherRostersFuzzy(playerName, targetPath) {
  const removed = [];
  const norm = normalizeName(playerName);
  const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(ROSTER_DIR, file);
    if (path.resolve(full) === path.resolve(targetPath)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const roster = Array.isArray(data)
      ? { players: data, picks: [] }
      : { players: data.players || [], picks: data.picks || [] };
    const before = roster.players.length;
    roster.players = roster.players.filter(p => {
      const n = normalizeName(p.name);
      return !(n === norm || n.includes(norm) || norm.includes(n));
    });
    if (roster.players.length !== before) {
      saveRoster(full, roster);
      removed.push(full);
    }
  }
  return removed;
}
