// Script to pin the first message in the trade block channel
// Usage: node scripts/pinTradeBlockMessage.js

import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const TRADE_BLOCK_CHANNEL_ID = '1432507364468068412';
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const channel = await client.channels.fetch(TRADE_BLOCK_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
        console.error('Trade block channel not found or not text-based.');
        process.exit(1);
    }
    // Fetch messages, get the first one
    const messages = await channel.messages.fetch({ limit: 10 });
    const firstMsg = messages.last(); // Discord.js returns newest first, so .last() is oldest
    if (!firstMsg) {
        console.error('No messages found in trade block channel.');
        process.exit(1);
    }
    try {
        await firstMsg.pin();
        console.log('Pinned the first message in the trade block channel.');
    } catch (err) {
        console.error('Failed to pin message:', err);
    }
    process.exit(0);
});

client.login(TOKEN);
