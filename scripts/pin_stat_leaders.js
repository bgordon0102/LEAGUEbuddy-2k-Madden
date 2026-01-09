#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { updateStatLeaders } from '../src/madden/stat_leaders.js';
import { getDefaultLeagueId, resolveLeagueIdWithConfig } from '../src/madden/madden_data.js';
import { getLeagueForGuild } from '../src/madden/madden_config.js';

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN missing. Add it to .env before running this script.');
    process.exit(1);
  }

  // Pick league: CLI arg > env > guild mapping > latest snapshot
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
    console.log(`Logged in as ${client.user.tag}, updating Stat Leaders for league ${leagueId}...`);
    try {
      await updateStatLeaders(client, leagueId);
      console.log('Stat Leaders embed updated and pinned.');
    } catch (e) {
      console.error('Failed to update Stat Leaders:', e?.message || e);
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
