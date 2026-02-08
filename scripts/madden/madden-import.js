import dotenv from 'dotenv';
import process from 'process';
import { SnallabotProvider } from '../src/madden/providers/SnallabotProvider.js';
import { runSync } from '../src/commands/madden/sync.js';

dotenv.config();

async function main() {
  const leagueId = process.env.MADDEN_LEAGUE_ID || process.env.LEAGUE_ID || process.argv[2];
  if (!leagueId) {
    console.error('Missing league id. Set MADDEN_LEAGUE_ID or pass as first argument.');
    process.exit(1);
  }

  const useSnallabot = (process.env.MADDEN_SYNC_USE_SNALLABOT ?? 'true').toLowerCase() !== 'false';
  const provider = useSnallabot ? new SnallabotProvider() : null;

  try {
    const summary = await runSync(leagueId, provider);
    console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
  } catch (err) {
    console.error('Madden import failed:', err?.message || err);
    process.exit(1);
  }
}

main();
