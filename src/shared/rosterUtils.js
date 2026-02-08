import fs from 'fs';
import path from 'path';

export function normalizeName(name) {
  return name ? name.trim() : '';
}

export function readRoster(team) {
  const file = path.join(process.cwd(), 'data', 'teams_rosters', `${team}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveRoster(team, roster) {
  const file = path.join(process.cwd(), 'data', 'teams_rosters', `${team}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(roster, null, 2));
  return true;
}

export function upsertPlayer(roster, player) {
  const existingIndex = roster.findIndex(p => p.id === player.id || normalizeName(p.name) === normalizeName(player.name));
  if (existingIndex >= 0) {
    roster[existingIndex] = { ...roster[existingIndex], ...player };
  } else {
    roster.push(player);
  }
  return roster;
}

// Remove a player from all other rosters (fuzzy by name); returns true if removed
export function removePlayerFromOtherRostersFuzzy(playerName) {
  const rostersDir = path.join(process.cwd(), 'data', 'teams_rosters');
  if (!fs.existsSync(rostersDir)) return false;
  const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
  let removed = false;
  for (const file of files) {
    const full = path.join(rostersDir, file);
    try {
      const roster = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const idx = roster.findIndex(p => normalizeName(p.name) === normalizeName(playerName));
      if (idx >= 0) {
        roster.splice(idx, 1);
        fs.writeFileSync(full, JSON.stringify(roster, null, 2));
        removed = true;
      }
    } catch (e) {
      console.error(`[rosterUtils] Failed to update ${file}:`, e);
    }
  }
  return removed;
}
