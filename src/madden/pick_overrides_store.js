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
const sameTeam = (a, b) => {
  const aNorm = norm(a);
  const bNorm = norm(b);
  if (!aNorm || !bNorm) return false;
  return aNorm === bNorm || aNorm.endsWith(bNorm) || bNorm.endsWith(aNorm);
};
const TEAM_ABBR = new Map([
  ['cardinals', 'ARI'],
  ['falcons', 'ATL'],
  ['ravens', 'BAL'],
  ['bills', 'BUF'],
  ['panthers', 'CAR'],
  ['bears', 'CHI'],
  ['bengals', 'CIN'],
  ['browns', 'CLE'],
  ['cowboys', 'DAL'],
  ['broncos', 'DEN'],
  ['lions', 'DET'],
  ['packers', 'GB'],
  ['texans', 'HOU'],
  ['colts', 'IND'],
  ['jaguars', 'JAX'],
  ['chiefs', 'KC'],
  ['raiders', 'LV'],
  ['chargers', 'LAC'],
  ['rams', 'LAR'],
  ['dolphins', 'MIA'],
  ['vikings', 'MIN'],
  ['patriots', 'NE'],
  ['saints', 'NO'],
  ['giants', 'NYG'],
  ['jets', 'NYJ'],
  ['eagles', 'PHI'],
  ['steelers', 'PIT'],
  ['49ers', 'SF'],
  ['seahawks', 'SEA'],
  ['buccaneers', 'TB'],
  ['titans', 'TEN'],
  ['commanders', 'WAS'],
]);
const viaCodeFor = (teamName = '') => {
  const teamNorm = norm(teamName);
  if (TEAM_ABBR.has(teamNorm)) return TEAM_ABBR.get(teamNorm);
  for (const [key, abbr] of TEAM_ABBR.entries()) {
    if (teamNorm.endsWith(key) || key.endsWith(teamNorm)) return abbr;
  }
  return teamName.slice(0, 3).toUpperCase();
};
const LEGACY_FIRST_ROUND_OVERRIDES = [
  { from: 'Cardinals', to: 'Detroit Lions', via: 'ARI', year: 2027 },
  { from: 'Cardinals', to: 'Detroit Lions', via: 'ARI', year: 2028 },
  { from: 'Packers', to: 'Dallas Cowboys', via: 'GB', year: 2027 },
  { from: 'Colts', to: 'New York Jets', via: 'IND', year: 2027 },
  { from: 'Cowboys', to: 'New York Jets', via: 'DAL', year: 2027 },
];

function findOverrideByOriginalOwner(list, fromTeam, year, round = 1) {
  return list.find(o =>
    sameTeam(o.from || o.owner, fromTeam)
    && Number(o.year) === Number(year)
    && Number(o.round || 1) === Number(round)
  ) || null;
}

export function resolveOriginalPickOwner(ownerTeam, year, round = 1) {
  if (!ownerTeam || !year) return ownerTeam;
  const list = loadOverrides();
  const matches = list.filter(o =>
    sameTeam(o.to || o.owner, ownerTeam)
    && Number(o.year) === Number(year)
    && Number(o.round || 1) === Number(round)
  );
  if (!matches.length) return ownerTeam;
  return matches[matches.length - 1].from || ownerTeam;
}

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
  const filtered = list.filter(o => !(sameTeam(o.from || o.owner, fromTeam) && Number(o.year) === Number(year) && Number(o.round || 1) === 1));
  filtered.push({
    from: fromTeam,
    to: toTeam,
    via: via || viaCodeFor(fromTeam),
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
        if (!Number.isFinite(year)) return;
        const originalOwner = p.originalOwner || p.viaTeam || resolveOriginalPickOwner(sender, year, 1) || sender;
        const existing = findOverrideByOriginalOwner(loadOverrides(), originalOwner, year, 1);
        const previousOwner = existing?.to || originalOwner;
        if (!sameTeam(previousOwner, sender) && !sameTeam(originalOwner, sender)) {
          return;
        }
        upsertPickOverride({
          fromTeam: originalOwner,
          toTeam: receiver,
          year,
          via: p.via || viaCodeFor(originalOwner),
        });
      });
  };
  applySide(fromAssets, fromTeam, toTeam);
  applySide(toAssets, toTeam, fromTeam);
}

export function loadPickOverrides() {
  return loadOverrides();
}

export function getEffectiveFirstRoundOverrides(year) {
  const seasonYear = Number(year);
  const fileOverrides = loadOverrides().filter(o =>
    Number(o.year) === seasonYear && Number(o.round || 1) === 1
  );
  const legacyOverrides = LEGACY_FIRST_ROUND_OVERRIDES.map(o => ({
    ...o,
    year: Number(o.year),
    round: 1,
  })).filter(o => Number(o.year) === seasonYear);
  return [...fileOverrides, ...legacyOverrides];
}

export function getFirstRoundPickLabelsForTeam(teamName, year, allTeams = []) {
  if (!teamName || !year) return [];
  const overrides = getEffectiveFirstRoundOverrides(year);
  const ownerByOriginal = new Map();
  allTeams.forEach(team => {
    const name = String(team || '').trim();
    if (name) ownerByOriginal.set(name, name);
  });
  overrides.forEach(o => {
    const from = o.from || o.owner;
    const to = o.to || o.owner;
    if (!from || !to) return;
    ownerByOriginal.set(from, to);
  });

  const labels = new Set();
  let tracksTeamOriginalPick = false;
  ownerByOriginal.forEach((owner, original) => {
    if (sameTeam(original, teamName)) tracksTeamOriginalPick = true;
    if (!sameTeam(owner, teamName)) return;
    labels.add(sameTeam(original, teamName) ? `${year} Round 1` : `${year} Round 1 via ${original}`);
  });

  if (!labels.size && !tracksTeamOriginalPick) labels.add(`${year} Round 1`);
  return [...labels].sort((a, b) => {
    const aVia = /\svia\s/i.test(a);
    const bVia = /\svia\s/i.test(b);
    if (aVia !== bVia) return aVia ? 1 : -1;
    return a.localeCompare(b);
  });
}
