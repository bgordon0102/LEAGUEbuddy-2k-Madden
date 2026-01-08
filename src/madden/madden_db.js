import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(process.cwd(), 'data', 'madden', 'db.sqlite');

function ensureDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY CHECK (id=1),
  accessToken TEXT,
  refreshToken TEXT,
  expiry INTEGER,
  console TEXT,
  blazeId TEXT,
  gameYear TEXT
);
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY CHECK (id=1),
  leagueId TEXT
);
`;
  spawnSync('sqlite3', [DB_PATH, schema], { stdio: 'ignore' });
}

function escape(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function query(sql) {
  ensureDb();
  const res = spawnSync('sqlite3', [DB_PATH, sql], { encoding: 'utf8' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(res.stderr || 'sqlite error');
  return res.stdout?.trim() || '';
}

export function saveTokens(tokens) {
  try {
    const { accessToken, refreshToken, expiry, console, blazeId, gameYear } = tokens || {};
    query(`INSERT OR REPLACE INTO tokens (id, accessToken, refreshToken, expiry, console, blazeId, gameYear) VALUES (1, ${escape(accessToken)}, ${escape(refreshToken)}, ${escape(expiry ? Number(expiry) : null)}, ${escape(console)}, ${escape(blazeId)}, ${escape(gameYear)});`);
  } catch (e) {
    console.warn('[madden-db] saveTokens failed:', e.message);
  }
}

export function loadTokens() {
  try {
    const out = query(`SELECT accessToken, refreshToken, expiry, console, blazeId, gameYear FROM tokens WHERE id=1;`);
    if (!out) return null;
    const [accessToken, refreshToken, expiryStr, console, blazeId, gameYear] = out.split('|');
    return {
      accessToken,
      refreshToken,
      expiry: expiryStr ? Number(expiryStr) : null,
      console,
      blazeId,
      gameYear,
    };
  } catch {
    return null;
  }
}

export function saveLeague(leagueId) {
  try {
    query(`INSERT OR REPLACE INTO leagues (id, leagueId) VALUES (1, ${escape(leagueId)});`);
  } catch (e) {
    console.warn('[madden-db] saveLeague failed:', e.message);
  }
}

export function loadLeague() {
  try {
    const out = query(`SELECT leagueId FROM leagues WHERE id=1;`);
    return out || null;
  } catch {
    return null;
  }
}

// Snapshot storage removed (too large for CLI pipe). Use file-based snapshots.
