// Main Discord bot entry (moved from apps/leaguebuddy-2k/app.js)
import dotenv from 'dotenv';
import fs, { readdirSync, createWriteStream } from 'fs';
import { Client, GatewayIntentBits, Collection, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as submitScore from './interactions/submit_score.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions] });
client.commands = new Collection();
client.interactionHandlers = [];

// Register startseason_confirm button handler
import * as startseasonConfirm from './interactions/startseason_confirm.js';
// Dynamically load all interaction handlers from src/interactions
const interactionsPath = join(process.cwd(), 'src', 'interactions');
const interactionFiles = readdirSync(interactionsPath).filter(f => f.endsWith('.js'));
for (const file of interactionFiles) {
    const filePath = join(interactionsPath, file);
    const handler = await import(pathToFileURL(filePath).href);
    // Register main button/select handlers
    if (handler.customId && typeof handler.execute === 'function') {
        client.interactionHandlers.push({ customId: handler.customId, execute: handler.execute });
    }
    // Register modal customIds if present
    for (const key of Object.keys(handler)) {
        if (key.startsWith('customId_')) {
            const customIdValue = handler[key];
            const executeFn = handler[`execute_${key.replace('customId_', '')}`] || handler[`execute_${customIdValue}`];
            if (typeof executeFn === 'function') {
                client.interactionHandlers.push({ customId: customIdValue, execute: executeFn });
            }
        }
    }
}
// ...existing code...
