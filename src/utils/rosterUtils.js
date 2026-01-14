
import fs from 'fs';
import path from 'path';

// Load canonical teams list once
let canonicalTeams = null;
function getCanonicalTeams() {
  if (!canonicalTeams) {
    try {
      canonicalTeams = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'teams.json'), 'utf8'));
    } catch {
      canonicalTeams = [];
    }
  }
  return canonicalTeams;
}

export function normalizeName(name) {
  return name ? name.trim() : '';
}

export function readRoster(team) {
  if (!team) return { roster: [], rosterPath: null };
  const rostersDir = path.join(process.cwd(), 'teams_rosters');
  // Special case: Free Agency
  if (team.trim().toLowerCase().replace(/[_\s]+/g, '') === 'freeagency') {
    const faPath = path.join(rostersDir, 'Free_Agency.json');
    if (fs.existsSync(faPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(faPath, 'utf-8'));
        const players = Array.isArray(data) ? data : data.players || [];
        return { roster: players, rosterPath: faPath };
      } catch {
        return { roster: [], rosterPath: faPath };
      }
    }
    return { roster: [], rosterPath: faPath };
  }

  // Canonical team name mapping
  const teams = getCanonicalTeams();
  let canonical = null;
  const input = team.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  for (const t of teams) {
    const name = t.name.toLowerCase();
    const abbr = (t.abbreviation || '').toLowerCase();
    const city = name.split(' ')[0];
    const nickname = name.split(' ').slice(1).join(' ');
    if (
      input === name ||
      input === abbr ||
      input === city ||
      input === nickname ||
      input.replace(/ /g, '') === name.replace(/ /g, '') ||
      input.replace(/ /g, '') === abbr.replace(/ /g, '')
    ) {
      canonical = t.name;
      break;
    }
    // Fuzzy: substring
    if (
      name.includes(input) ||
      abbr.includes(input) ||
      city.includes(input) ||
      nickname.includes(input)
    ) {
      canonical = t.name;
    }
  }
  const fileBase = (canonical || team).replace(/\s+/g, '_');
  const fileName = fileBase + '.json';
  const filePath = path.join(rostersDir, fileName);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const players = Array.isArray(data) ? data : data.players || [];
      return { roster: players, rosterPath: filePath };
    } catch {
      return { roster: [], rosterPath: filePath };
    }
  }
  // Fallback: try to find a file that matches (case-insensitive, underscores)
  const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
  const lower = fileBase.toLowerCase();
  let found = files.find(f => f.replace('.json', '').toLowerCase() === lower);
  if (found) {
    const foundPath = path.join(rostersDir, found);
    try {
      const data = JSON.parse(fs.readFileSync(foundPath, 'utf-8'));
      const players = Array.isArray(data) ? data : data.players || [];
      return { roster: players, rosterPath: foundPath };
    } catch {
      return { roster: [], rosterPath: foundPath };
    }
  }
  // Fuzzy: substring match
  found = files.find(f => f.replace('.json', '').toLowerCase().includes(lower));
  if (found) {
    const foundPath = path.join(rostersDir, found);
    try {
      const data = JSON.parse(fs.readFileSync(foundPath, 'utf-8'));
      const players = Array.isArray(data) ? data : data.players || [];
      return { roster: players, rosterPath: foundPath };
    } catch {
      return { roster: [], rosterPath: foundPath };
    }
  }
  return { roster: [], rosterPath: filePath };
}

export function saveRoster(team, roster) {
  // Accept either a roster path or a team name
  const isPath = typeof team === 'string' && (team.endsWith('.json') || team.includes(path.sep) || path.isAbsolute(team));
  const file = isPath
    ? path.isAbsolute(team)
      ? team
      : path.join(process.cwd(), team)
    : path.join(process.cwd(), 'teams_rosters', `${team}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roster, null, 2));
  return file;
}

export function upsertPlayer(roster, player, payload = {}) {
  if (!Array.isArray(roster)) return roster;
  const base = typeof player === 'string' ? { name: player } : { ...(player || {}) };
  const merged = { ...base, ...payload };
  if (!merged.name && payload.name) merged.name = payload.name;
  if (!merged.name) return roster;

  const existingIndex = roster.findIndex(
    p => (merged.id && p.id === merged.id) || normalizeName(p.name) === normalizeName(merged.name)
  );
  if (existingIndex >= 0) {
    roster[existingIndex] = { ...roster[existingIndex], ...merged };
  } else {
    roster.push(merged);
  }
  return roster;
}

// Remove a player from all other rosters (fuzzy by name) and return true if removed
export function removePlayerFromOtherRostersFuzzy(playerName, excludePath = null) {
  const rostersDir = path.join(process.cwd(), 'teams_rosters');
  if (!fs.existsSync(rostersDir)) return false;
  const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
  let removed = false;
  for (const file of files) {
    const full = path.join(rostersDir, file);
    if (excludePath && path.resolve(full) === path.resolve(excludePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const roster = Array.isArray(data) ? data : data.players || [];
      const idx = roster.findIndex(p => normalizeName(p.name) === normalizeName(playerName));
      if (idx >= 0) {
        roster.splice(idx, 1);
        const payload = Array.isArray(data) ? roster : { ...data, players: roster };
        fs.writeFileSync(full, JSON.stringify(payload, null, 2));
        removed = true;
      }
    } catch (e) {
      console.error(`[rosterUtils] Failed to update ${file}:`, e);
    }
  }
  return removed;
}
