import { Client, GatewayIntentBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const OUTPUT_FILE = path.join(process.cwd(), 'data', 'madden', 'trade_block_threads.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function getTeamsFromRoleMap(roleMap) {
  const teams = [];
  Object.keys(roleMap).forEach(key => {
    if (key.endsWith(' Coach')) {
      const name = key.replace(/ Coach$/, '');
      teams.push(name);
    }
  });
  teams.sort();
  return teams;
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN missing in environment.');
    process.exit(1);
  }
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const tradeBlockChannelId = channelMap['Trade block'] || channelMap['Trade Block'];
  if (!tradeBlockChannelId) {
    console.error('Trade block channel ID missing in madden_channel_ids.json');
    process.exit(1);
  }

  const teams = getTeamsFromRoleMap(roleMap);
  if (!teams.length) {
    console.error('No team roles found in madden_role_ids.json');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}. Creating trade block threads...`);
    const channel = await client.channels.fetch(tradeBlockChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.error('Trade block channel not found or not text-based.');
      process.exit(1);
    }

    const threadMap = {};
    for (const team of teams) {
      const name = `${team} Trade Block`;
      try {
        const thread = await channel.threads.create({
          name,
          reason: 'Initialize trade block threads',
          autoArchiveDuration: 10080, // 7 days
        });
        threadMap[team] = thread.id;
        console.log(`Created thread for ${team}: ${thread.id}`);
      } catch (e) {
        console.error(`Failed to create thread for ${team}: ${e?.message || e}`);
      }
    }

    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(threadMap, null, 2), 'utf8');
    console.log(`Saved thread map to ${OUTPUT_FILE}`);
    client.destroy();
    process.exit(0);
  });

  client.login(token);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
