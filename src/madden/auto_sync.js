import { SnallabotProvider } from './providers/SnallabotProvider.js';
import { runSync } from '../commands/madden/sync.js';

const ENABLED = (process.env.MADDEN_AUTO_SYNC_ENABLED ?? 'false').toLowerCase() === 'true';
const LEAGUE_ID = process.env.MADDEN_AUTO_SYNC_LEAGUE_ID || process.env.MADDEN_LEAGUE_ID || null;
const USE_SNALLABOT = (process.env.MADDEN_SYNC_USE_SNALLABOT ?? 'true').toLowerCase() !== 'false';
const INTERVAL_MINUTES = Number(process.env.MADDEN_AUTO_SYNC_MINUTES || 30);

let timer = null;
let running = false;

async function doSync() {
  if (!LEAGUE_ID) {
    console.warn('[madden-auto-sync] Skipping; no league id set (MADDEN_AUTO_SYNC_LEAGUE_ID or MADDEN_LEAGUE_ID)');
    return;
  }
  if (running) {
    console.log('[madden-auto-sync] Previous sync still running, skipping this tick');
    return;
  }
  running = true;
  const provider = USE_SNALLABOT ? new SnallabotProvider() : null;
  const started = Date.now();
  try {
    const res = await runSync(LEAGUE_ID, provider);
    const ms = Date.now() - started;
    console.log(`[madden-auto-sync] Synced league ${res.leagueId} week=${res.currentWeek} games=${res.gamesCount} (${ms}ms)`);
  } catch (err) {
    console.error('[madden-auto-sync] Sync failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startAutoSync() {
  if (!ENABLED) {
    console.log('[madden-auto-sync] Disabled (MADDEN_AUTO_SYNC_ENABLED=false)');
    return;
  }
  if (!LEAGUE_ID) {
    console.warn('[madden-auto-sync] Disabled; no league id set (MADDEN_AUTO_SYNC_LEAGUE_ID or MADDEN_LEAGUE_ID)');
    return;
  }
  const intervalMs = Math.max(5, INTERVAL_MINUTES) * 60 * 1000;
  console.log(`[madden-auto-sync] Enabled for league ${LEAGUE_ID} every ${Math.round(intervalMs / 60000)}m`);
  doSync(); // kick off immediately
  timer = setInterval(doSync, intervalMs);
}

export function stopAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}
