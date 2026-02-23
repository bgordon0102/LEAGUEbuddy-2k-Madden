import { ButtonInteraction } from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  readRoster,
  saveRoster,
  upsertPlayer,
  removePlayerFromOtherRostersFuzzy,
  normalizeName,
} from '../utils/rosterUtils.js';

const TEAM_ALIASES = {
  heat: 'Miami Heat',
  suns: 'Phoenix Suns',
  celtics: 'Boston Celtics',
  knicks: 'New York Knicks',
  nets: 'Brooklyn Nets',
  lakers: 'Los Angeles Lakers',
  clippers: 'Los Angeles Clippers',
  warriors: 'Golden State Warriors',
  sixers: 'Philadelphia 76ers',
  '76ers': 'Philadelphia 76ers',
  pels: 'New Orleans Pelicans',
  pelicans: 'New Orleans Pelicans',
  wolves: 'Minnesota Timberwolves',
  twolves: 'Minnesota Timberwolves',
  blazers: 'Portland Trail Blazers',
  mavs: 'Dallas Mavericks',
  spurs: 'San Antonio Spurs',
  jazz: 'Utah Jazz',
  bucks: 'Milwaukee Bucks',
};

const PENDING_FILE = path.join(process.cwd(), 'data', 'updaterosters_pending.json');
const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');

const ALLOWED_STAFF_NAMES = ['Paradise Commish', 'Paradise Co-Commish'];

function readStaffRoleIds() {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    return Object.entries(map || {})
      .filter(([name]) => ALLOWED_STAFF_NAMES.includes(name))
      .map(([, id]) => id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePending(data) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data ?? {}, null, 2));
}

function rosterFileCandidates(team) {
  const cleaned = normalizeName(team);
  const variants = new Set();
  const add = (s) => variants.add(s.replace(/_+/g, '_').replace(/^_+|_+$/g, ''));
  add(cleaned);
  add(cleaned.replace(/ /g, '_'));
  add(cleaned.replace(/\s+/g, '_'));
  add(cleaned.replace(/[^A-Za-z0-9]+/g, '_'));
  add(cleaned.replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '_'));
  return [...variants].filter(Boolean);
}

function resolveTeamKey(team) {
  const alias = TEAM_ALIASES[String(team || '').toLowerCase()] || team;
  const dirs = [
    path.join(process.cwd(), 'data', '2k', 'teams_rosters'),
    path.join(process.cwd(), 'data', 'teams_rosters'),
  ];
  const candidates = rosterFileCandidates(alias).map(n => `${n}.json`);
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const lower = files.map(f => f.toLowerCase());
    const found = candidates.find(c => lower.includes(c.toLowerCase()));
    if (found) return found.replace(/\.json$/i, '');
  }
  // fallback to normalized name
  const fallback = rosterFileCandidates(alias)[0] || alias;
  console.warn('[updaterosters][resolveTeamKey] fallback', team, 'alias', alias, '->', fallback);
  return fallback;
}

function loadRoster(team) {
  const alias = TEAM_ALIASES[String(team || '').toLowerCase()] || team;
  const raw = readRoster(alias, { force2k: true });
  if (!raw) {
    console.warn('[updaterosters][loadRoster] roster not found', { team, alias });
    return null;
  }
  const key = raw.rosterPath || resolveTeamKey(alias);
  if (raw?.roster && Array.isArray(raw.roster.players)) {
    return { roster: raw.roster, rosterPath: raw.rosterPath || key };
  }
  if (Array.isArray(raw?.players)) {
    return { roster: { players: raw.players, picks: raw.picks || [] }, rosterPath: raw.rosterPath || key };
  }
  if (Array.isArray(raw)) {
    return { roster: { players: raw, picks: [] }, rosterPath: raw.rosterPath || key };
  }
  return null;
}

function applySignings(entries = [], actorId) {
  if (!Array.isArray(entries)) entries = [];
  const results = { applied: [], missing: [] };
  const faData = loadRoster('free agency');
  const findPlayerByName = (rosterObj, name) => {
    const norm = normalizeName(name);
    return rosterObj?.players?.find(p => normalizeName(p.name || '') === norm) || null;
  };
  for (const entry of entries) {
    const data = loadRoster(entry.team);
    if (!data) {
      results.missing.push(`${entry.team} (roster not found)`);
      continue;
    }
    const { roster, rosterPath } = data;
    // Prefer full player data from free agency (keeps OVR/contract intact)
    const source = faData ? findPlayerByName(faData.roster, entry.player) : null;
    const payload = source
      ? {
          ...source,
          lastSigned: 'transaction',
          lastUpdatedBy: actorId,
          lastUpdatedAt: new Date().toISOString(),
        }
      : {
          name: entry.player,
          position: entry.position || undefined,
          lastSigned: 'transaction',
          lastUpdatedBy: actorId,
          lastUpdatedAt: new Date().toISOString(),
        };
    upsertPlayer(roster.players, payload);
    removePlayerFromOtherRostersFuzzy(entry.player);
    saveRoster(rosterPath, roster);
    console.log('[updaterosters][sign]', { player: entry.player, team: entry.team, rosterPath, size: roster.players.length });
    results.applied.push(`${entry.player} -> ${entry.team}`);
  }
  return results;
}

function applyWaives(entries = [], actorId) {
  if (!Array.isArray(entries)) entries = [];
  const results = { waived: [], missing: [] };
  const faData = loadRoster('free agency');
  if (!faData) {
    results.missing.push('free agency roster not found');
    return results;
  }
  for (const entry of entries) {
    const teamData = loadRoster(entry.team);
    if (!teamData) {
      results.missing.push(`${entry.team} (roster not found)`);
      continue;
    }
    const { roster, rosterPath } = teamData;
    const normTarget = normalizeName(entry.player);
    const before = roster.players.length;
    const idx = roster.players.findIndex(p => normalizeName(p.name || '') === normTarget);
    let removedPlayer = null;
    if (idx !== -1) {
      removedPlayer = roster.players[idx];
      roster.players.splice(idx, 1);
    }
    if (roster.players.length === before) {
      results.missing.push(`${entry.player} not found on ${entry.team}`);
      continue;
    }
    saveRoster(rosterPath, roster);
    // add to FA
    const payload = {
      ...removedPlayer,
      name: entry.player,
      position: entry.position || removedPlayer?.position || undefined,
      lastSigned: 'waived',
      lastUpdatedBy: actorId,
      lastUpdatedAt: new Date().toISOString(),
    };
    upsertPlayer(faData.roster.players, payload);
    removePlayerFromOtherRostersFuzzy(entry.player);
    saveRoster(faData.rosterPath, faData.roster);
    results.waived.push(`${entry.player} -> free agency (from ${entry.team})`);
  }
  return results;
}

function moveAssets(source, dest, assets, actorId, results) {
  const now = new Date().toISOString();
  for (const asset of assets) {
    if (asset.type === 'pick') {
      const idx = source.roster.picks.findIndex(p => p === asset.value);
      if (idx !== -1) source.roster.picks.splice(idx, 1);
      dest.roster.picks = dest.roster.picks || [];
      dest.roster.picks.push(asset.value);
      results.moves.push(`Pick ${asset.value}: ${source.name} -> ${dest.name}`);
      continue;
    }
    // player
    const norm = normalizeName(asset.name);
    let playerObj = source.roster.players.find(p => normalizeName(p.name || '') === norm);
    if (playerObj) {
      source.roster.players = source.roster.players.filter(p => normalizeName(p.name || '') !== norm);
    }
    if (!playerObj) {
      results.missing.push(`${asset.name} not found on ${source.name}`);
      playerObj = { name: asset.name };
    }
    const payload = {
      ...playerObj,
      name: asset.name,
      position: asset.position || playerObj.position || undefined,
      lastSigned: 'trade',
      lastUpdatedBy: actorId,
      lastUpdatedAt: now,
    };
    upsertPlayer(dest.roster.players, payload);
    removePlayerFromOtherRostersFuzzy(asset.name);
    results.moves.push(`${asset.name}: ${source.name} -> ${dest.name}`);
  }
}

function applyTrades(entries = [], actorId) {
  if (!Array.isArray(entries)) entries = [];
  const results = { moves: [], missing: [], note: '' };
  if (entries.length < 2) {
    results.note = `Need two sides for a trade; detected ${entries.length}.`;
    return results;
  }
  const [a, b] = entries;
  const rosterA = loadRoster(a.team);
  const rosterB = loadRoster(b.team);
  if (!rosterA) results.missing.push(`${a.team} roster not found`);
  if (!rosterB) results.missing.push(`${b.team} roster not found`);
  if (!rosterA || !rosterB) return results;
  moveAssets({ ...rosterA, name: a.team }, { ...rosterB, name: b.team }, a.assets, actorId, results);
  moveAssets({ ...rosterB, name: b.team }, { ...rosterA, name: a.team }, b.assets, actorId, results);
  saveRoster(rosterA.rosterPath, rosterA.roster);
  saveRoster(rosterB.rosterPath, rosterB.roster);
  return results;
}

export const customId = /^updaterosters_(confirm|cancel)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [_, action, id] = interaction.customId.split('_');
  const pending = readPending();
  const entry = pending[id];
  if (!entry) {
    await interaction.reply({ content: 'Request not found or already processed.', ephemeral: true });
    return;
  }
  const staffRoleIds = readStaffRoleIds();
  const isStaff = staffRoleIds.length
    ? interaction.member?.roles?.cache?.some(r => staffRoleIds.includes(r.id))
    : interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
  if (interaction.user.id !== entry.requester && !isStaff) {
    await interaction.reply({ content: 'Only the requester or staff can act on this request.', ephemeral: true });
    return;
  }

  if (action === 'cancel') {
    delete pending[id];
    writePending(pending);
    try {
      await interaction.update({ content: 'Update canceled.', components: [] });
    } catch (err) {
      if (err?.code !== 10062) throw err;
    }
    return;
  }

  let results;
  if (entry.type === 'auto') {
    const signRes = applySignings(entry.entries.sign || entry.entries || [], interaction.user.id);
    const waiveRes = applyWaives(entry.entries.waive || [], interaction.user.id);
    const tradeRes = applyTrades(entry.entries.trade || [], interaction.user.id);
    results = {
      applied: signRes.applied,
      waived: waiveRes.waived,
      moves: tradeRes.moves,
      missing: [...(signRes.missing||[]), ...(waiveRes.missing||[]), ...(tradeRes.missing||[])],
      note: tradeRes.note,
    };
  } else if (entry.type === 'sign') {
    const signEntries = Array.isArray(entry.entries?.sign) ? entry.entries.sign : Array.isArray(entry.entries) ? entry.entries : [];
    results = applySignings(signEntries, interaction.user.id);
  } else if (entry.type === 'waive') {
    results = applyWaives(entry.entries || [], interaction.user.id);
  } else if (entry.type === 'trade') {
    results = applyTrades(entry.entries || [], interaction.user.id);
  } else {
    results = { missing: ['Unknown type'], applied: [], moves: [] };
  }
  delete pending[id];
  writePending(pending);

  const lines = [];
  if (results.note) lines.push(results.note);
  if (results.applied?.length) lines.push(`Applied: ${results.applied.join('; ')}`);
  if (results.waived?.length) lines.push(`Waived: ${results.waived.join('; ')}`);
  if (results.moves?.length) lines.push(`Moves: ${results.moves.slice(0, 20).join('; ')}`);
  if (results.missing?.length) lines.push(`Issues: ${results.missing.slice(0, 20).join('; ')}`);
  try {
    await interaction.update({ content: lines.join('\n') || 'Done.', components: [] });
  } catch (err) {
    if (err?.code !== 10062) throw err;
  }
}

export default { customId, execute };
