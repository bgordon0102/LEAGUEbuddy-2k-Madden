import fs from 'fs';
import path from 'path';

const PICK_FILE = path.join(process.cwd(), 'data', 'madden', 'pick_overrides.json');

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(PICK_FILE, 'utf8'));
    return Array.isArray(raw?.overrides) ? raw.overrides : [];
  } catch {
    return [];
  }
}

function saveOverrides(list) {
  fs.mkdirSync(path.dirname(PICK_FILE), { recursive: true });
  fs.writeFileSync(PICK_FILE, JSON.stringify({ overrides: list }, null, 2));
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Add or replace first-round pick overrides based on a trade.
 * @param {Object} opts
 * @param {string} opts.fromTeam - Original owner
 * @param {string} opts.toTeam - New owner
 * @param {number} opts.year - Draft year
 * @param {string} [opts.via] - Via tag
 */
export function upsertPickOverride({ fromTeam, toTeam, year, via }) {
  if (!fromTeam || !toTeam || !year) return;
  const list = loadOverrides();
  const filtered = list.filter(o => !(norm(o.from || o.owner) === norm(fromTeam) && Number(o.year) === Number(year) && Number(o.round || 1) === 1));
  filtered.push({
    from: fromTeam,
    to: toTeam,
    via: via || fromTeam.slice(0, 3).toUpperCase(),
    year: Number(year),
    round: 1,
    updatedAt: new Date().toISOString(),
  });
  saveOverrides(filtered);
  return filtered;
}

/**
 * Convenience: inspect trade assets arrays and persist round-1 pick swaps
 * @param {Object} trade
 * @param {string} trade.fromTeam
 * @param {string} trade.toTeam
 * @param {Array} trade.fromAssets - array of asset objects (type 'pick', year, round)
 * @param {Array} trade.toAssets - opposite side assets
 * @param {number} trade.seasonYear
 */
export function addPickOverridesFromTrade({ fromTeam, toTeam, fromAssets = [], toAssets = [], seasonYear }) {
  const applySide = (assets, sender, receiver) => {
    assets
      .filter(a => a?.type === 'pick' && Number(a.round) === 1)
      .forEach(p => {
        const year = Number(p.year || seasonYear);
        if (Number.isFinite(year)) upsertPickOverride({ fromTeam: sender, toTeam: receiver, year, via: p.via || sender.slice(0,3).toUpperCase() });
      });
  };
  applySide(fromAssets, fromTeam, toTeam);
  applySide(toAssets, toTeam, fromTeam);
}

export function loadPickOverrides() {
  return loadOverrides();
}
