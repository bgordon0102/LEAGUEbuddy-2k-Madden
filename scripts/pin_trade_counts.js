import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { updateTradeCountsEmbed, loadTradeCounts, saveTradeCounts } from '../src/utils/madden_trade_utils.js';
import { setPinId } from '../src/madden/pins_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN missing in environment.');
  process.exit(1);
}

const channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8'));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Pinning Trade Counts...`);
  try {
    const counts = loadTradeCounts();
    // Ensure file exists even if empty
    saveTradeCounts(counts);
    let pinned = false;
    try {
      await updateTradeCountsEmbed(client, channelMap, counts);
      console.log('Trade Counts pin updated.');
      pinned = true;
    } catch (err) {
      console.warn('Trade Counts update failed, falling back to placeholder:', err?.message || err);
    }
    if (!pinned) {
      const channelId = channelMap['Trade Counts'];
      if (!channelId) throw new Error('Trade Counts channel not configured');
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) throw new Error('Trade Counts channel not accessible');
      const msg = await channel.send({
        embeds: [{ title: 'Trade Counts', description: 'No trades yet.', color: 0x00b0f4 }],
      });
      try { await msg.pin(); } catch {}
      setPinId('trade_counts', msg.id);
      console.log('Trade Counts placeholder pin created.');
    }
  } catch (e) {
    console.error('Failed to update Trade Counts pin:', e?.message || e);
  } finally {
    setTimeout(() => client.destroy(), 1000);
  }
});

client.login(token);
