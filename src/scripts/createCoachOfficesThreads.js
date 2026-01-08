// Script to create a channel and 30 private coach office threads for each NBA team
// Usage: Run this in your bot context with proper permissions

import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';

// Load coachRoleMap from season.json
const seasonPath = path.join(process.cwd(), 'data/season.json');
const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
const coachRoleMap = seasonData.coachRoleMap;

// List of NBA teams (from coachRoleMap keys)
const teams = Object.keys(coachRoleMap);

// Channel name for offices
const OFFICE_CHANNEL_NAME = 'coach-offices';

// Your bot token and guild ID
const BOT_TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessageTyping] });

client.once('ready', async () => {
    const guild = await client.guilds.fetch(GUILD_ID);
    // Use the provided channel ID for offices
    const officeChannel = await guild.channels.fetch('1428200029943763025');
    if (!officeChannel) {
        console.error('Specified office channel not found!');
        process.exit(1);
    }
    // Create threads for each team
    for (const team of teams) {
        const roleId = coachRoleMap[team];
        const threadName = `${team} Office`;
        // Create private thread
        const thread = await officeChannel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
            reason: `Coach office for ${team}`,
            type: 12 // PRIVATE_THREAD
        });
        // Set permissions so only the coach role can view/send
        await thread.send({ content: `Welcome to the ${team} Office!` });
        await thread.setLocked(false);
        await thread.permissionOverwrites.edit(roleId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        });
        // Optionally deny @everyone
        await thread.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: false
        });
    }
    console.log('All coach office threads created!');
    process.exit(0);
});

client.login(BOT_TOKEN);
