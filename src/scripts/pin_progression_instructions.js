// scripts/pin_progression_instructions.js
// Usage: node scripts/pin_progression_instructions.js
// Posts or updates the progression instructions pin message in the progression channel.

import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.DISCORD_TOKEN;
const PROGRESSION_CHANNEL_ID = '1428097786272026736'; // Update if needed
const PINNED_MESSAGE_ID = process.env.PROGRESSION_PIN_ID || null; // Set to message ID to update, or null to post new

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    const channel = await client.channels.fetch(PROGRESSION_CHANNEL_ID);
    if (!channel) {
        console.error('Progression channel not found!');
        process.exit(1);
    }

    // Build embed (same as submit_player_progression.js)
    const embed = new EmbedBuilder()
        .setTitle('📈 Player Progression System')
        .setDescription('Press the button to submit your upgrade.')
        .addFields({
            name: 'Steps',
            value: `1️⃣ Select the player you want to upgrade.\n2️⃣ Choose which skill set you want to improve.\n3️⃣ Use your tier points to upgrade any attributes in that skill set.\n   (Example: If you have 5 points for Tier 3, you could do: Shooting → 3PT +3, FT +2)`
        }, {
            name: 'Tier Values (per team)',
            value: `T1 = 3 pts | T2 = 4 pts | T3 = 5 pts | T4 = 6 pts | T5 = 7 pts`
        }, {
            name: 'Skill-Sets',
            value: `Driving – Layup, Dunk, Speed w/ Ball\nShooting – Mid, 3PT, Free Throw\nPost Scoring – Close Shot, Standing Dunk, Post Hook, Post Fade, Post Control\nPlaymaking – Ball Handling, Pass Accuracy, Pass IQ, Vision\nInterior Defense – Inside Defense, Block, Help D IQ\nPerimeter Defense – Perimeter D, Steal, Pass Perception\nRebounding – OREB, DREB\nIQ – Foul, Shot IQ, Offensive Consistency, Defensive Consistency, Intangibles`
        }, {
            name: 'Special (one-time perks)',
            value: `• Conditioning: +5 to physicals\n• Weight Room: +3 STR, +8 lbs, -1 SPD/ACC/VERT\n• Shooting Mechanics: Adjust timing\n• Distributor: Play Initiator (80+ Ball Handle)\n• X-Factor: +3 POT`
        }, {
            name: '\u2728 New users start with 1 free upgrade!',
            value: '\u200B'
        });

    // Build button row (same customId as your interaction handler)
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('submit_progression_button')
            .setLabel('Submit Progression')
            .setStyle(ButtonStyle.Primary)
    );

    let msg;
    if (PINNED_MESSAGE_ID) {
        try {
            msg = await channel.messages.fetch(PINNED_MESSAGE_ID);
            await msg.edit({ embeds: [embed], components: [actionRow] });
            console.log('Progression pin updated!');
        } catch (err) {
            console.error('Failed to update pinned message:', err);
        }
    } else {
        msg = await channel.send({ embeds: [embed], components: [actionRow] });
        await msg.pin();
        console.log('Progression pin posted and pinned!');
    }
    process.exit(0);
});

client.login(TOKEN);
