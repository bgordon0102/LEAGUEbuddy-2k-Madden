import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { updateAwards } from '../src/madden/awards.js';
import { resolveLeagueIdWithConfig } from '../src/madden/madden_data.js';

// Helper to post awards for a specific week using the graded list.
// Usage: DISCORD_TOKEN=<bot token> WEEK=<weekNumber> node scripts/post_week_awards.js

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Missing DISCORD_TOKEN env var.');
    process.exit(1);
  }
  const week = Number(process.env.WEEK);
  if (!week || Number.isNaN(week)) {
    console.error('Missing or invalid WEEK env var. Set WEEK=<weekNumber>.');
    process.exit(1);
  }
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  client.once('ready', async () => {
    try {
      const leagueId = resolveLeagueIdWithConfig();
      // weekOverride = WEEK + 1 (awardsWeek = weekOverride - 1)
      await updateAwards(client, leagueId, week + 1);
      console.log(`Posted awards for Week ${week}.`);
    } catch (err) {
      console.error(`Failed to post awards for Week ${week}:`, err);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  client.login(token).catch(err => {
    console.error('Discord login failed:', err);
    process.exit(1);
  });
}

main();
