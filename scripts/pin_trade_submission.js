#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN missing. Add it to .env before running this script.');
    process.exit(1);
  }

  const channelMap = loadChannelMap();
  const channelId = channelMap['Trade Submissions'];
  if (!channelId) {
    console.error('Trade Submissions channel ID missing in data/madden/madden_channel_ids.json');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}. Updating pinned trade submission message...`);
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) throw new Error('Channel is not text-based');

      const embed = new EmbedBuilder()
        .setTitle('Submit a Trade')
        .setDescription(
          [
            'Use Trade Builder to propose your deal:',
            '• Your team is auto-detected. Pick the other team (AFC/NFC dropdown or “Type other team”).',
            '• Add assets via Offense / Defense / ST+picks menus, or use “Search” to find a specific player.',
            '• Review live totals in the embed. When ready, hit Submit to send for approval.',
            'Trades lock after Week 8.',
          ].join('\n')
        )
        .setColor(0x00ae86);

      const button = new ButtonBuilder()
        .setCustomId('madden_trade_for::::')
        .setLabel('Propose Trade')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(button);

      const pins = await channel.messages.fetchPins().catch(() => null);
      let botPin = null;
      if (pins) {
        const list = Array.from(pins.values ? pins.values() : []);
        for (const msg of list) {
          if (msg?.author?.id === client.user.id) { botPin = msg; break; }
        }
      }

      if (botPin) {
        await botPin.edit({ embeds: [embed], components: [row], content: null });
        console.log('Updated existing pinned trade submission message.');
      } else {
        const msg = await channel.send({ embeds: [embed], components: [row] });
        try { await msg.pin(); } catch {}
        console.log('Created and pinned trade submission message.');
      }
    } catch (err) {
      console.error('Failed to pin trade submission message:', err?.message || err);
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
