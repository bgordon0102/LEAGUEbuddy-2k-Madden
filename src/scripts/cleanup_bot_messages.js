#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';

// Usage:
// DISCORD_TOKEN=... DISCORD_GUILD_ID=... node scripts/cleanup_bot_messages.js
// To actually delete matched messages set DELETE=true in env (default is dry-run)

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
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

async function inspectMessage(msg) {
    if (!msg) return false;
    if (!msg.components || msg.components.length === 0) return false;
    // Inspect each component row and component for a custom_id containing 'submit_score'
    for (const row of msg.components) {
        for (const comp of row.components) {
            // Different shapes exist depending on how the component was created
            const custom = comp.data?.custom_id || comp.customId || comp.data?.customId;
            if (custom && String(custom).includes('submit_score')) return true;
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
            // Only inspect text-based channels (includes threads as separate objects later)
            if (!channel.isTextBased()) continue;

            // Fetch recent messages (limit 100)
            let messages;
            try {
                messages = await channel.messages.fetch({ limit: 100 });
            } catch (err) {
                console.warn('Failed to fetch messages for channel', channel.id, err.message);
                messages = null;
            }

            if (messages) {
                for (const [mid, msg] of messages) {
                    if (msg.author?.id !== client.user.id) continue; // only our bot's messages
                    const matched = await inspectMessage(msg);
                    if (matched) {
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

            // If channel can have threads, scan them too
            if (channel.threads) {
                try {
                    const threads = await channel.threads.fetch();
                    for (const [tid, thread] of threads.threads) {
                        try {
                            const tmsgs = await thread.messages.fetch({ limit: 100 });
                            for (const [mid, tmsg] of tmsgs) {
                                if (tmsg.author?.id !== client.user.id) continue;
                                const matched = await inspectMessage(tmsg);
                                if (matched) {
                                    console.log(`[FOUND THREAD] thread:${thread.id} name:${thread.name} msg:${mid} createdAt:${tmsg.createdAt}`);
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
                            console.warn('Failed to scan thread', thread.id, te.message);
                        }
                    }
                } catch (err) {
                    // ignore channels that don't support threads or fetch fail
                }
            }

        } catch (err) {
            console.warn('Skipping channel', id, err.message);
        }
    }

    console.log('Scan complete. Logout.');
    await client.destroy();
    process.exit(0);
}

run().catch(err => {
    console.error('Script failed', err);
    process.exit(1);
});
