import fs from 'fs';
import path from 'path';
import { ensurePickValues, computePickValue2k } from './rosterUtils.js';

// Helpers duplicated from committee vote
function ensurePickArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    return val
      .split(/[,\n]/)
      .map(s => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalize(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/gi, '');
}

function teamToFile(team) {
  const map = {
    "cavaliers": "cleveland_cavaliers.json",
    "cleveland cavaliers": "cleveland_cavaliers.json",
    "hawks": "atlanta_hawks.json",
    "atlanta hawks": "atlanta_hawks.json",
    "celtics": "boston_celtics.json",
    "boston celtics": "boston_celtics.json",
    "nets": "brooklyn_nets.json",
    "brooklyn nets": "brooklyn_nets.json",
    "hornets": "charlotte_hornets.json",
    "charlotte hornets": "charlotte_hornets.json",
    "bulls": "chicago_bulls.json",
    "chicago bulls": "chicago_bulls.json",
    "mavericks": "dallas_mavericks.json",
    "dallas mavericks": "dallas_mavericks.json",
    "nuggets": "denver_nuggets.json",
    "denver nuggets": "denver_nuggets.json",
    "pistons": "detroit_pistons.json",
    "detroit pistons": "detroit_pistons.json",
    "warriors": "golden_state_warriors.json",
    "golden state warriors": "golden_state_warriors.json",
    "rockets": "houston_rockets.json",
    "houston rockets": "houston_rockets.json",
    "pacers": "indiana_pacers.json",
    "indiana pacers": "indiana_pacers.json",
    "clippers": "los_angeles_clippers.json",
    "los angeles clippers": "los_angeles_clippers.json",
    "lakers": "los_angeles_lakers.json",
    "los angeles lakers": "los_angeles_lakers.json",
    "grizzlies": "memphis_grizzlies.json",
    "memphis grizzlies": "memphis_grizzlies.json",
    "heat": "miami_heat.json",
    "miami heat": "miami_heat.json",
    "bucks": "milwaukee_bucks.json",
    "milwaukee bucks": "milwaukee_bucks.json",
    "timberwolves": "minnesota_timberwolves.json",
    "minnesota timberwolves": "minnesota_timberwolves.json",
    "knicks": "new_york_knicks.json",
    "new york knicks": "new_york_knicks.json",
    "thunder": "oklahoma_city_thunder.json",
    "oklahoma city thunder": "oklahoma_city_thunder.json",
    "magic": "orlando_magic.json",
    "orlando magic": "orlando_magic.json",
    "76ers": "philadelphia_76ers.json",
    "philadelphia 76ers": "philadelphia_76ers.json",
    "suns": "phoenix_suns.json",
    "phoenix suns": "phoenix_suns.json",
    "trail blazers": "portland_trail_blazers.json",
    "portland trail blazers": "portland_trail_blazers.json",
    "kings": "sacramento_kings.json",
    "sacramento kings": "sacramento_kings.json",
    "spurs": "san_antonio_spurs.json",
    "san antonio spurs": "san_antonio_spurs.json",
    "raptors": "toronto_raptors.json",
    "toronto raptors": "toronto_raptors.json",
    "jazz": "utah_jazz.json",
    "utah jazz": "utah_jazz.json",
    "wizards": "washington_wizards.json",
    "washington wizards": "washington_wizards.json"
  };
  const key = team.toLowerCase().trim();
  if (map[key]) return map[key];
  return key.replace(/ /g, '_') + '.json';
}

function extractPicks(assetStr) {
  if (!assetStr) return [];
  return assetStr.split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => s.match(/20\d{2}/))
    .filter(s => !s.match(/\(([^)]+protected[^)]*)\)/));
}

function buildPickValueMap(tradeObj) {
  const map = {};
  const lines = []
    .concat(String(tradeObj.assetsSent || '').split(/\n|,/))
    .concat(String(tradeObj.assetsReceived || '').split(/\n|,/));
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/—|-/);
    if (parts.length < 2) continue;
    const labelPart = parts[0].trim();
    const valNum = parseFloat(parts.slice(1).join('-').trim());
    if (!Number.isFinite(valNum)) continue;
    const norm = labelPart
      .replace(/\s*\(.*\)/, '')
      .replace(/round\s*1/i, '1st')
      .replace(/round\s*2/i, '2nd')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    map[norm] = valNum;
  }
  return map;
}

function getSeasonYear() {
  try {
    const seasonPath = path.join(process.cwd(), 'data', 'season.json');
    if (fs.existsSync(seasonPath)) {
      const s = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      if (s.seasonYear) return Number(s.seasonYear);
      if (s.seasonNo) return 2025 + Number(s.seasonNo);
    }
  } catch { /* ignore */ }
  return new Date().getFullYear();
}

function movePlayers(playerNames, fromRoster, toRoster) {
  for (const name of playerNames) {
    const normName = normalize(name);
    const idx = fromRoster.players.findIndex(p => normalize(p.name) === normName);
    if (idx !== -1) {
      toRoster.players.push(fromRoster.players[idx]);
      fromRoster.players.splice(idx, 1);
    }
  }
}

function movePicks(pickNames, fromRoster, toRoster, fromTeamName, pickValueMap) {
  if (!Array.isArray(pickNames)) {
    console.warn('[movePicks] pickNames was not array:', pickNames);
    return;
  }
  function parsePick(val) {
    let str = typeof val === 'string' ? val : val.pick || val.label || '';
    str = str.replace(/\(val: [^)]+\)/gi, '').toLowerCase();
    const yearMatch = str.match(/(20\d{2})/);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    let round = null;
    if (/1st|first|round 1/.test(str)) round = 1;
    else if (/2nd|second|round 2/.test(str)) round = 2;
    else {
      const roundMatch = str.match(/round\s*(\d)/);
      if (roundMatch) round = Number(roundMatch[1]);
    }
    const protectionMatch = str.match(/\(([^)]+protected[^)]*)\)/);
    const protection = protectionMatch ? protectionMatch[1] : null;
    const valMatch = (typeof val === 'object' && val.value != null)
      ? Number(val.value)
      : (() => { const m = String(val).match(/val:\s*([0-9.]+)/i); return m ? Number(m[1]) : null; })();
    const normKey = str
      .replace(/\s*\(.*\)/, '')
      .replace(/round\s*1/i, '1st')
      .replace(/round\s*2/i, '2nd')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    return { year, round, protection, raw: val, value: valMatch, normKey };
  }
  for (const pick of pickNames) {
    const tradePick = parsePick(pick);
    if (!tradePick.year || !tradePick.round) continue;
    let idx = -1;
    for (let i = 0; i < fromRoster.picks.length; i++) {
      const rosterPick = parsePick(fromRoster.picks[i]);
      if (rosterPick.year === tradePick.year && rosterPick.round === tradePick.round) {
        idx = i;
        break;
      }
    }
    if (idx === -1) continue;
    const original = fromRoster.picks[idx];
    const originalParsed = parsePick(original);
    let movedPick = (typeof original === 'string' ? original : original?.pick || '').trim();
    if (tradePick.protection) {
      const basePick = movedPick.replace(/\(([^)]+protected[^)]*)\)/, '').trim();
      movedPick = `${basePick} (${tradePick.protection})`;
    }
    movedPick = `${movedPick} (VIA ${fromTeamName})`;
    const storedVal = (originalParsed.value != null && originalParsed.value !== undefined)
      ? originalParsed.value
      : (pickValueMap[tradePick.normKey] ?? computePickValue2k(tradePick.year, tradePick.round, null, getSeasonYear(), tradePick.protection));
    movedPick = { pick: movedPick, value: storedVal };
    toRoster.picks.push(movedPick);
    fromRoster.picks.splice(idx, 1);
  }
}

export function applyApprovedTrade(trade) {
  const sentPicksRaw = trade.picks || trade.picksSent || trade.assetsSent;
  const receivedPicksRaw = trade.picksTo || trade.picksReceived || trade.assetsReceived;
  const sentPicks = ensurePickArray(sentPicksRaw).length
    ? ensurePickArray(sentPicksRaw)
    : extractPicks(trade.assetsSent);
  const receivedPicks = ensurePickArray(receivedPicksRaw).length
    ? ensurePickArray(receivedPicksRaw)
    : extractPicks(trade.assetsReceived);

  const rosterDir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
  const teamAFile = path.join(rosterDir, teamToFile(trade.yourTeam));
  const teamBFile = path.join(rosterDir, teamToFile(trade.otherTeam));
  let teamARoster = ensurePickValues(JSON.parse(fs.readFileSync(teamAFile, 'utf8')));
  let teamBRoster = ensurePickValues(JSON.parse(fs.readFileSync(teamBFile, 'utf8')));
  if (Array.isArray(teamARoster)) teamARoster = { players: teamARoster, picks: [] };
  if (Array.isArray(teamBRoster)) teamBRoster = { players: teamBRoster, picks: [] };
  teamARoster.players = Array.isArray(teamARoster.players) ? teamARoster.players : [];
  teamBRoster.players = Array.isArray(teamBRoster.players) ? teamBRoster.players : [];
  teamARoster.picks = Array.isArray(teamARoster.picks) ? teamARoster.picks : [];
  teamBRoster.picks = Array.isArray(teamBRoster.picks) ? teamBRoster.picks : [];

  const pickValueMap = buildPickValueMap(trade);
  const sentPlayers = trade.players || trade.assetsSent.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));
  const receivedPlayers = trade.playersTo || trade.assetsReceived.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));

  movePlayers(sentPlayers, teamARoster, teamBRoster);
  movePlayers(receivedPlayers, teamBRoster, teamARoster);
  movePicks(sentPicks, teamARoster, teamBRoster, trade.yourTeam, pickValueMap);
  movePicks(receivedPicks, teamBRoster, teamARoster, trade.otherTeam, pickValueMap);

  fs.writeFileSync(teamAFile, JSON.stringify(teamARoster, null, 2));
  fs.writeFileSync(teamBFile, JSON.stringify(teamBRoster, null, 2));

  return { teamAFile, teamBFile };
}
