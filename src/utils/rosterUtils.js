import fs from 'fs';
import path from 'path';

const ROSTER_DIR = path.join(process.cwd(), 'data', 'teams_rosters');

function teamToFile(teamName = '') {
  return teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + '.json';
}

export function normalizeName(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function readRoster(teamName) {
  const fileName = teamToFile(teamName);
  const rosterPath = path.join(ROSTER_DIR, fileName);
  if (!fs.existsSync(rosterPath)) {
    // Try fuzzy/alias mapping for common abbreviations
    const aliasMap = {
      nuggets: 'denver_nuggets.json',
      den: 'denver_nuggets.json',
      denver: 'denver_nuggets.json',
      lakers: 'los_angeles_lakers.json',
      lal: 'los_angeles_lakers.json',
      clippers: 'los_angeles_clippers.json',
      lac: 'los_angeles_clippers.json',
      mavs: 'dallas_mavericks.json',
      dallas: 'dallas_mavericks.json',
      knicks: 'new_york_knicks.json',
      nyk: 'new_york_knicks.json',
      nets: 'brooklyn_nets.json',
      bkn: 'brooklyn_nets.json',
      spurs: 'san_antonio_spurs.json',
      sas: 'san_antonio_spurs.json',
    };
    const aliasKey = normalizeName(teamName).replace(/_/g, '');
    const aliasFile = aliasMap[aliasKey];
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
    return null;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  } catch {
    return null;
  }
  const roster = Array.isArray(data)
    ? { players: data, picks: [] }
    : { players: data.players || [], picks: data.picks || [] };
  if (!Array.isArray(roster.players)) roster.players = [];
  if (!Array.isArray(roster.picks)) roster.picks = [];
  return { rosterPath, roster };
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
