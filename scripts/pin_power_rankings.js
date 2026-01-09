#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { updatePowerRankings } from '../src/madden/power_rankings.js';
import { getDefaultLeagueId } from '../src/madden/madden_data.js';
import { getLeagueForGuild } from '../src/madden/madden_config.js';

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN missing. Add it to .env before running this script.');
    process.exit(1);
  }

  const cliLeague = process.argv[2];
  const envLeague = process.env.MADDEN_LEAGUE_ID;
  const guildLeague = process.env.DISCORD_GUILD_ID ? getLeagueForGuild(process.env.DISCORD_GUILD_ID) : null;
  const snapshotLeague = getDefaultLeagueId();
  const leagueId = cliLeague || envLeague || guildLeague || snapshotLeague;
  if (!leagueId) {
    console.error('No league id found. Pass one as arg or set MADDEN_LEAGUE_ID / run /madden-set-league once.');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}, updating Power Rankings for league ${leagueId}...`);
    try {
      await updatePowerRankings(client, leagueId);
      console.log('Power Rankings embed updated.');
    } catch (e) {
      console.error('Failed to update Power Rankings:', e?.message || e);
    } finally {
      client.destroy();
    }
  });

  await client.login(token);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
