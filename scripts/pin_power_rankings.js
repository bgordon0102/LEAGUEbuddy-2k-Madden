import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { updatePowerRankings } from '../src/madden/power_rankings.js';
import { setPinId } from '../src/madden/pins_store.js';

function latestLeagueId() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (!files.length) return null;
  const sorted = files
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return sorted[0].f.replace('.json', '');
}

function resolveLeagueId() {
  const candidates = [process.env.LEAGUE_ID, process.env.MADDEN_LEAGUE_ID, latestLeagueId()];
  for (const cand of candidates) {
    if (!cand) continue;
    const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${cand}.json`);
    if (fs.existsSync(file)) return cand;
  }
  return null;
}

const leagueId = resolveLeagueId();
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
  console.log(`Logged in as ${client.user.tag}. Pinning Power Rankings${leagueId ? ` for league ${leagueId}` : ''}...`);
  try {
    let pinned = false;
    if (leagueId) {
      try {
        await updatePowerRankings(client, leagueId);
        console.log('Power Rankings pin updated.');
        pinned = true;
      } catch (err) {
        console.warn('Power Rankings update failed, falling back to placeholder:', err?.message || err);
      }
    }
    if (!pinned) {
      const channelMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json'), 'utf8'));
      const channelId = channelMap['Power Rankings'];
      if (!channelId) throw new Error('Power Rankings channel not configured');
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) throw new Error('Power Rankings channel not accessible');
      const msg = await channel.send({
        embeds: [{ title: 'Madden Power Rankings', description: 'Awaiting league data.', color: 0xffcc00 }],
      });
      try { await msg.pin(); } catch {}
      setPinId('power_rankings', msg.id);
      console.log('Power Rankings placeholder pin created.');
    }
  } catch (e) {
    console.error('Failed to update Power Rankings pin:', e?.message || e);
  } finally {
    setTimeout(() => client.destroy(), 500);
  }
});

client.login(token);
