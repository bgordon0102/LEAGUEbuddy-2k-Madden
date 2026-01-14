#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { updateAvailable2KTeamsPin } from '../src/2k/available_teams.js';

async function main() {
    const token = process.env.DISCORD_TOKEN;
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!token || !guildId) {
        console.error('DISCORD_TOKEN and DISCORD_GUILD_ID are required.');
        process.exit(1);
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}. Pinning Available NBA Teams...`);
        try {
            await updateAvailable2KTeamsPin(client, guildId, { allowCreate: true });
            console.log('Available NBA Teams pin updated (created if missing).');
        } catch (e) {
            console.error('Failed to update Available NBA Teams pin:', e?.message || e);
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
