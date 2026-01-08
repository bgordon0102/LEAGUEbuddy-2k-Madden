// Script to pin or update the trade block message in the trade block channel
// Usage: node scripts/updateTradeBlockPin.js

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

const TRADE_BLOCK_CHANNEL_ID = '1432507364468068412';
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const teamsRostersPath = path.join(process.cwd(), 'data', 'teams_rosters');
const tradeBlockPath = path.join(process.cwd(), 'data', 'tradeblock.json');

function getTradeBlock() {
    if (!fs.existsSync(tradeBlockPath)) return {};
    return JSON.parse(fs.readFileSync(tradeBlockPath));
}

function getTeamPlayers(team) {
    const teamFile = path.join(teamsRostersPath, `${team}.json`);
    if (!fs.existsSync(teamFile)) return [];
    const roster = JSON.parse(fs.readFileSync(teamFile));
    return roster.players ? roster.players : [];
}

function buildTradeBlockEmbed(tradeBlock) {
    const embed = new EmbedBuilder()
        .setTitle('League Trade Block')
        .setColor(0x00AE86)
        .setDescription('Current trade block for all teams');
    let thumbnailSet = false;
    Object.entries(tradeBlock).forEach(([team, players]) => {
        if (players.length === 0) return;
        let value = '';
        for (const playerName of players) {
            const teamPlayers = getTeamPlayers(team);
            const playerObj = teamPlayers.find(p => p.name === playerName);
            if (playerObj) {
                value += `• **${playerObj.name}** (${playerObj.position})\n`;
                // Set thumbnail to first player with image
                if (!thumbnailSet && playerObj.image) {
                    embed.setThumbnail(playerObj.image);
                    thumbnailSet = true;
                }
            } else {
                value += `• ${playerName}\n`;
            }
        }
        embed.addFields({ name: team.replace(/_/g, ' '), value: value.trim(), inline: false });
    });
    return embed;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const channel = await client.channels.fetch(TRADE_BLOCK_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
        console.error('Trade block channel not found or not text-based.');
        process.exit(1);
    }
    // Find pinned message
    const pins = await channel.messages.fetchPinned();
    let pinMsg = pins.find(m => m.author.id === client.user.id);
    const tradeBlock = getTradeBlock();
    const embed = buildTradeBlockEmbed(tradeBlock);
    if (!pinMsg) {
        // No pin: send new message and pin it
        const sent = await channel.send({ embeds: [embed] });
        await sent.pin();
        console.log('Created and pinned new trade block message.');
    } else {
        // Pin exists: edit it
        await pinMsg.edit({ embeds: [embed] });
        console.log('Updated pinned trade block message.');
    }
    process.exit(0);
});

client.login(TOKEN);
