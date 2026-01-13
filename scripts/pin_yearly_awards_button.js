import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getPinId, setPinId } from '../src/madden/pins_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN missing in environment.');
  process.exit(1);
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Pinning Yearly Awards button...`);
  try {
    const channelMap = loadChannelMap();
    const channelId = channelMap['Yearly awards'];
    if (!channelId) throw new Error('Yearly awards channel not configured');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) throw new Error('Yearly awards channel not accessible');

    const button = new ButtonBuilder()
      .setCustomId('madden_awards_button')
      .setLabel('Submit Yearly Awards')
      .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(button);
    const embed = {
      title: 'Madden Yearly Awards',
      description: 'Staff: use this button to submit yearly awards.',
      color: 0xffc107,
      timestamp: new Date().toISOString(),
    };

    // Try existing pin
    const pinId = getPinId('yearly_awards');
    if (pinId) {
      const msg = await channel.messages.fetch(pinId).catch(() => null);
      if (msg) {
        await msg.edit({ content: null, embeds: [embed], components: [row] }).catch(() => null);
        console.log('Updated existing Yearly Awards pin.');
        return setTimeout(() => client.destroy(), 500);
      }
    }

    // Fallback: reuse a bot pin if present
    try {
      const pins = await channel.messages.fetchPinned().catch(() => null);
      const botPin = pins ? pins.find(m => m.author.id === client.user.id) : null;
      if (botPin) {
        await botPin.edit({ content: null, embeds: [embed], components: [row] }).catch(() => null);
        setPinId('yearly_awards', botPin.id);
        console.log('Reused existing bot pin for Yearly Awards.');
        return setTimeout(() => client.destroy(), 500);
      }
    } catch { /* ignore */ }

    const msg = await channel.send({ embeds: [embed], components: [row] });
    try { await msg.pin(); } catch { /* ignore */ }
    setPinId('yearly_awards', msg.id);
    console.log('Created and pinned Yearly Awards button.');
  } catch (err) {
    console.error('Failed to pin Yearly Awards button:', err?.message || err);
  } finally {
    setTimeout(() => client.destroy(), 500);
  }
});

client.login(token);
