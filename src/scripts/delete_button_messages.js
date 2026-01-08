#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// delete_button_messages.js
// Scans the guild for messages authored by this bot that contain components (buttons)
// and optionally deletes them. By default it's a dry-run.
//
// Usage (dry-run):
// DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/delete_button_messages.js
// To actually delete found messages set DELETE=true

const TOKEN = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DO_DELETE = process.env.DELETE === 'true';

if (!TOKEN) {
    console.error('Missing DISCORD_TOKEN (or BOT_TOKEN) environment variable');
    process.exit(1);
}
if (!GUILD_ID) {
    console.error('Missing DISCORD_GUILD_ID environment variable');
    process.exit(1);
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel]
});

async function messageHasComponents(msg) {
    if (!msg) return false;
    if (!msg.components) return false;
    // Only target messages with components that match known Leaguebuddy custom IDs
    const KNOWN_PREFIXES = [
        'submit_score', 'force_win', 'sim_result', 'approve_score', 'deny_score', 'startseason_confirm', 'submit_score_react'
    ];
    for (const row of msg.components) {
        for (const comp of row.components) {
            const custom = comp.data?.custom_id || comp.customId || comp.data?.customId || comp.custom_id;
            if (!custom) continue;
            const s = String(custom);
            for (const pref of KNOWN_PREFIXES) {
                if (s === pref || s.startsWith(pref + ':') || s.includes(pref)) return true;
            }
        }
    }
    return false;
}

async function run() {
    await client.login(TOKEN);
    console.log('Logged in as', client.user.tag);
    const guild = await client.guilds.fetch(GUILD_ID);
    console.log('Scanning guild:', guild.id, guild.name);

    const channels = await guild.channels.fetch();
    for (const [id, channel] of channels) {
        try {
            if (!channel || !channel.isTextBased()) continue;

            // Fetch recent messages; adjust limit if needed
            let messages = null;
            try {
                messages = await channel.messages.fetch({ limit: 100 });
            } catch (err) {
                console.warn('Could not fetch messages for channel', channel.id, channel.name, err.message);
            }

            if (messages) {
                for (const [mid, msg] of messages) {
                    if (!msg) continue;
                    if (msg.author?.id !== client.user.id) continue; // only delete our bot's messages
                    if (msg.pinned) continue; // skip pinned messages per request
                    const hasComp = await messageHasComponents(msg);
                    if (hasComp) {
                        console.log(`[FOUND] channel:${channel.id} name:${channel.name || ''} msg:${mid} createdAt:${msg.createdAt}`);
                        if (DO_DELETE) {
                            try {
                                await msg.delete();
                                console.log('  -> DELETED', mid);
                            } catch (delErr) {
                                console.error('  -> DELETE FAILED', mid, delErr.message);
                            }
                        }
                    }
                }
            }

            // If channel supports threads, scan recent threads
            if (channel.threads) {
                try {
                    const threads = await channel.threads.fetch();
                    for (const [tid, thread] of threads.threads) {
                        try {
                            const tmsgs = await thread.messages.fetch({ limit: 100 });
                            for (const [mid, tmsg] of tmsgs) {
                                if (!tmsg) continue;
                                if (tmsg.author?.id !== client.user.id) continue;
                                if (tmsg.pinned) continue;
                                const hasComp = await messageHasComponents(tmsg);
                                if (hasComp) {
                                    console.log(`[FOUND THREAD] thread:${thread.id} name:${thread.name || ''} msg:${mid} createdAt:${tmsg.createdAt}`);
                                    if (DO_DELETE) {
                                        try {
                                            await tmsg.delete();
                                            console.log('  -> DELETED', mid);
                                        } catch (delErr) {
                                            console.error('  -> DELETE FAILED', mid, delErr.message);
                                        }
                                    }
                                }
                            }
                        } catch (te) {
                            console.warn('Failed to fetch messages for thread', thread.id, te.message);
                        }
                    }
                } catch (err) {
                    // channel may not support threads or fetch failed
                }
            }

        } catch (err) {
            console.warn('Skipping channel', id, err.message);
        }
    }

    console.log('Scan complete. Logging out.');
    await client.destroy();
    process.exit(0);
}

run().catch(err => {
    console.error('Script failed', err);
    process.exit(1);
});
