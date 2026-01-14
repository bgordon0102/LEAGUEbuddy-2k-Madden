#!/usr/bin/env node
import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// 2K trade submission channel
const CHANNEL_ID = '1425555037328773220';

async function main() {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error('DISCORD_TOKEN missing. Add it to .env before running this script.');
        process.exit(1);
    }

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}. Updating pinned 2K trade submission message...`);
        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            if (!channel?.isTextBased()) throw new Error('Channel is not text-based');

            const embed = new EmbedBuilder()
                .setTitle('📌 Trade Submission')
                .setDescription(
                    [
                        '**To propose a trade:**',
                        '• Click the button below and fill out the form.',
                        '• Both coaches must approve the trade via DM.',
                        '• Approved trades are sent to the committee for final review.',
                        '',
                        '💡 **Example:**',
                        'Team A sends: Player X, 1st Round Pick',
                        'Team B sends: Player Y, 2nd Round Pick',
                        '',
                        'Trades require approval from both coaches and the committee.'
                    ].join('\n')
                )
                .setColor(0x5865F2);

            const button = new ButtonBuilder()
                .setCustomId('trade_submit_button')
                .setLabel('Submit Trade')
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
                console.log('Updated existing pinned 2K trade submission message.');
            } else {
                const msg = await channel.send({ embeds: [embed], components: [row] });
                try { await msg.pin(); } catch { }
                console.log('Created and pinned 2K trade submission message.');
            }
        } catch (err) {
            console.error('Failed to pin 2K trade submission message:', err?.message || err);
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
