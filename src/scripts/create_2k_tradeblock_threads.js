import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const TRADE_BLOCK_CHANNEL_ID = '1432507364468068412'; // 2K trade-block channel

function loadTeams() {
  // Prefer teams.json if present; fallback to hardcoded list
  const jsonPath = path.join(process.cwd(), 'data', 'teams.json');
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(data)) return data.map(t => t.name).filter(Boolean);
  } catch {}
  return [
    'Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
    'Cleveland Cavaliers','Dallas Mavericks','Denver Nuggets','Detroit Pistons','Golden State Warriors',
    'Houston Rockets','Indiana Pacers','Los Angeles Clippers','Los Angeles Lakers','Memphis Grizzlies',
    'Miami Heat','Milwaukee Bucks','Minnesota Timberwolves','New Orleans Pelicans','New York Knicks',
    'Oklahoma City Thunder','Orlando Magic','Philadelphia 76ers','Phoenix Suns','Portland Trail Blazers',
    'Sacramento Kings','San Antonio Spurs','Toronto Raptors','Utah Jazz','Washington Wizards'
  ];
}

async function ensureThread(channel, teamName) {
  const targetName = `${teamName} Trade Block`;
  const matches = (t) => (t?.name || '').toLowerCase() === targetName.toLowerCase();

  // check active
  const active = await channel.threads.fetchActive().catch(() => null);
  const foundActive = active?.threads?.find(matches);
  if (foundActive) return foundActive;

  // check archived
  const archived = await channel.threads.fetchArchived().catch(() => null);
  const foundArchived = archived?.threads?.find(matches);
  if (foundArchived) return foundArchived;

  // create
  return channel.threads.create({
    name: targetName,
    autoArchiveDuration: 10080,
    reason: `2K trade block thread for ${teamName}`,
  });
}

async function main() {
  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN (or BOT_TOKEN) is required');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    try {
      const channel = await client.channels.fetch(TRADE_BLOCK_CHANNEL_ID).catch(() => null);
      if (!channel) throw new Error('Trade block channel not found');
      const teams = loadTeams();
      let created = 0;
      for (const team of teams) {
        const thread = await ensureThread(channel, team).catch(() => null);
        if (thread?.createdTimestamp && thread.createdTimestamp > Date.now() - 60_000) created++;
        console.log(`${team}: ${thread ? 'ok' : 'failed'}`);
      }
      console.log(`Threads ready. Newly created: ${created}`);
    } catch (err) {
      console.error('Error:', err.message || err);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  client.login(token).catch(err => {
    console.error('Discord login failed:', err.message || err);
    process.exit(1);
  });
}

main();
