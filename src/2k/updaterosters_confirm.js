import { ButtonInteraction } from 'discord.js';
import fs from 'fs';
import path from 'path';

import {
  readRoster,
  saveRoster,
  upsertPlayer,
  removePlayerFromOtherRostersFuzzy,
  normalizeName
} from '../shared/rosterUtils.js';



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

function applySignings(entries, actorId) {
  const results = { applied: [], missing: [] };
  // Load Free Agency roster for full player info
  const faData = readRoster('free agency');
  for (const entry of entries) {
    const data = readRoster(entry.team);
    if (!data) {
      results.missing.push(`${entry.team} (roster not found)`);
      continue;
    }
    const { roster, rosterPath } = data;
    // Find player in Free Agency
    let faPlayer = null;
    if (faData && faData.roster && Array.isArray(faData.roster.players)) {
      faPlayer = faData.roster.players.find(p => normalizeName(p.name) === normalizeName(entry.player));
    }
    // Strictly copy all fields from free agency profile, only overlay contract fields
    if (!faPlayer) {
      results.missing.push(`${entry.player} not found in Free Agency`);
      continue;
    }
    let mergedPlayer = { ...faPlayer };
    // Overlay contract fields and transaction fields only
    if (entry.contractYears) mergedPlayer.contractYears = entry.contractYears;
    if (entry.salaryPerYear) mergedPlayer.salaryPerYear = entry.salaryPerYear;
    if (entry.salaryText) mergedPlayer.salaryText = entry.salaryText;
    if (entry.contractYearsText) mergedPlayer.contractYearsText = entry.contractYearsText;
    mergedPlayer.lastSigned = 'transaction';
    mergedPlayer.lastUpdatedBy = actorId;
    mergedPlayer.lastUpdatedAt = new Date().toISOString();
    upsertPlayer(roster, mergedPlayer);
    removePlayerFromOtherRostersFuzzy(entry.player, rosterPath);
    saveRoster(rosterPath, roster);
    results.applied.push(`${entry.player} -> ${entry.team}`);
  }
  return results;
}

function applyWaives(entries, actorId) {
  const results = { waived: [], missing: [] };
  const faData = readRoster('free agency');
  if (!faData) {
    results.missing.push('free agency roster not found');
    return results;
  }
  for (const entry of entries) {
    const teamData = readRoster(entry.team);
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
    upsertPlayer(faData.roster, entry.player, payload);
    removePlayerFromOtherRostersFuzzy(entry.player, faData.rosterPath);
    saveRoster(faData.rosterPath, faData.roster);
    results.waived.push(`${entry.player} -> free agency (from ${entry.team})`);
  }
  return results;
}

function moveAssets(source, dest, assets, actorId, results) {
  const now = new Date().toISOString();
  for (const asset of assets) {
    if (asset.type === 'pick') {
      // Find pick by value or label, move full original string
      let idx = source.roster.picks.findIndex(p => {
        if (typeof p === 'string') return p === asset.value;
        return p.value === asset.value || p.label === asset.value || p.pick === asset.value;
      });
      dest.roster.picks = dest.roster.picks || [];
      if (idx !== -1) {
        const originalPick = source.roster.picks[idx];
        source.roster.picks.splice(idx, 1);
        dest.roster.picks.push(originalPick);
        results.moves.push(`Pick ${asset.value}: ${source.name} -> ${dest.name}`);
      } else {
        // If not found, preserve the full original string and do NOT revalue or normalize
        dest.roster.picks.push(asset.value);
        results.moves.push(`Pick ${asset.value} (not found as object, preserved as-is): ${source.name} -> ${dest.name}`);
      }
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
    upsertPlayer(dest.roster, asset.name, payload);
    removePlayerFromOtherRostersFuzzy(asset.name, dest.rosterPath);
    results.moves.push(`${asset.name}: ${source.name} -> ${dest.name}`);
  }
}

function applyTrades(entries, actorId) {
  const results = { moves: [], missing: [], note: '' };
  if (entries.length !== 2) {
    results.note = `Trade apply supports exactly 2 teams; detected ${entries.length}. No changes applied.`;
    return results;
  }
  const [a, b] = entries;
  const rosterA = readRoster(a.team);
  const rosterB = readRoster(b.team);
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
  if (entry.type === 'sign') {
    results = applySignings(entry.entries, interaction.user.id);
  } else if (entry.type === 'waive') {
    results = applyWaives(entry.entries, interaction.user.id);
  } else if (entry.type === 'trade') {
    results = applyTrades(entry.entries, interaction.user.id);
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
