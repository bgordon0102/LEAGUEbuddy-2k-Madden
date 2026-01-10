import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { updateStandings } from '../src/madden/standings_pin.js';
import { setPinId } from '../src/madden/pins_store.js';

function latestLeagueId() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (!files.length) return null;
  // pick most recently modified
  const sorted = files
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return sorted[0].f.replace('.json', '');
}

const leagueId = process.env.LEAGUE_ID || process.env.MADDEN_LEAGUE_ID || latestLeagueId();
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN missing in environment.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Pinning Standings${leagueId ? ` for league ${leagueId}` : ''}...`);
  try {
    let pinned = false;
    if (leagueId) {
      try {
        await updateStandings(client, leagueId);
        console.log('Standings pin updated.');
        pinned = true;
      } catch (err) {
        console.warn('Standings update failed, falling back to placeholder:', err?.message || err);
      }
    }
    if (!pinned) {
      const channelMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json'), 'utf8'));
      const channelId = channelMap['Standings'];
      if (!channelId) throw new Error('Standings channel not configured');
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) throw new Error('Standings channel not accessible');
      const msg = await channel.send({
        embeds: [{ title: 'Madden Standings', description: 'Awaiting league data.', color: 0x00b0f4 }],
      });
      try { await msg.pin(); } catch {}
      setPinId('standings', msg.id);
      console.log('Standings placeholder pin created.');
    }
  } catch (e) {
    console.error('Failed to update Standings pin:', e?.message || e);
  } finally {
    setTimeout(() => client.destroy(), 500);
  }
});

client.login(token);
