import { ButtonInteraction } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { normalizeName } from '../utils/rosterUtils.js';

const ROSTER_DIR = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
const PENDING_FILE = path.join(process.cwd(), 'data', 'removeretires_pending.json');

function loadRosters() {
  const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
  const rosters = [];
  for (const file of files) {
    try {
      const full = path.join(ROSTER_DIR, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const roster = Array.isArray(data)
        ? { players: data, picks: [] }
        : { players: data.players || [], picks: data.picks || [] };
      rosters.push({ file, full, roster });
    } catch (err) {
      console.error('[removeretires_confirm] Failed to read roster:', file, err);
    }
  }
  return rosters;
}

function saveRoster(full, roster) {
  fs.writeFileSync(full, JSON.stringify(roster, null, 2));
}

function removePlayerAcrossRosters(name, rosters) {
  const target = normalizeName(name);
  for (const r of rosters) {
    const before = r.roster.players.length;
    r.roster.players = r.roster.players.filter(p => normalizeName(p.name || '') !== target);
    if (r.roster.players.length !== before) {
      saveRoster(r.full, r.roster);
      return r.file.replace('.json', '').replace(/_/g, ' ');
    }
  }
  return null;
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePending(data) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data ?? {}, null, 2));
  } catch (err) {
    console.error('[removeretires_confirm] Failed to write pending file:', err);
  }
}

export const customId = /^removeretires_(confirm|cancel)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [_, action, id] = interaction.customId.split('_');
  const pending = readPending();
  const entry = pending[id];
  if (!entry) {
    await interaction.reply({ content: 'Request not found or already processed.', ephemeral: true });
    return;
  }
  // Only allow requester or staff to act
  const staffIds = (() => {
    try {
      const map = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'staffRoleMap.main.json'), 'utf8'));
      const allowed = ['Paradise Commish', 'Paradise Co-Commish'];
      return Object.entries(map || {})
        .filter(([name]) => allowed.includes(name))
        .map(([, id]) => id)
        .filter(Boolean);
    } catch {
      return [];
    }
  })();
  const isStaff = interaction.member?.roles?.cache?.some(r => staffIds.includes(r.id));
  if (interaction.user.id !== entry.requester && !isStaff) {
    await interaction.reply({ content: 'Only the requester or staff can act on this list.', ephemeral: true });
    return;
  }

  if (action === 'cancel') {
    delete pending[id];
    writePending(pending);
    await interaction.update({ content: 'Retire removal canceled.', components: [] });
    return;
  }

  // Confirm: remove players
  const rosters = loadRosters();
  const removed = [];
  const notFound = [];
  for (const name of entry.names) {
    const team = removePlayerAcrossRosters(name, rosters);
    if (team) removed.push(`${name} (${team})`);
    else notFound.push(name);
  }
  delete pending[id];
  writePending(pending);
  const parts = [];
  parts.push(`Removed: ${removed.length}`);
  if (removed.length) parts.push(removed.slice(0, 20).join(', '));
  if (notFound.length) parts.push(`Not found: ${notFound.slice(0, 20).join(', ')}`);
  await interaction.update({ content: parts.join('\n') || 'Done.', components: [] });
}

export default { customId, execute };
