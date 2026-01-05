// LEAGUEbuddy: Modern Discord bot entry
import dotenv from 'dotenv';
import fs, { readdirSync, createWriteStream } from 'fs';
import { Client, GatewayIntentBits, Collection, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as submitScore from './src/interactions/submit_score.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions] });
client.commands = new Collection();
client.interactionHandlers = [];

// Register startseason_confirm button handler
import * as startseasonConfirm from './src/interactions/startseason_confirm.js';
// client.interactions.set(startseasonConfirm.customId, startseasonConfirm); // Removed to fix TypeError

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

// OCR and image handling removed for simplified score flow

// Handle interactions (commands and autocomplete)
client.on('interactionCreate', async interaction => {

  // All interactions are now routed through the generic handler system below

  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.error(`❌ No command handler found for /${interaction.commandName}`);
      await interaction.reply({ content: 'Command not found.', ephemeral: true });
      return;
    }
    // Lightweight command audit log
    console.log(`[CMD] ${interaction.user.tag} used /${interaction.commandName}`);
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`❌ Error executing command /${interaction.commandName}:`, error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: 'There was an error while executing this command!' });
        } else {
          await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
    return;
  }

  // Handle autocomplete interactions for slash commands
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command || typeof command.autocomplete !== 'function') {
      console.error(`❌ No autocomplete handler found for /${interaction.commandName}`);
      try { await interaction.respond([]); } catch { }
      return;
    }
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(`❌ Error in autocomplete for /${interaction.commandName}:`, error);
      try { await interaction.respond([{ name: 'Error loading options', value: 'none' }]); } catch { }
    }
    return;
  }

  // Improved logging for other interaction types
  if (interaction.isButton()) {
  } else if (interaction.isStringSelectMenu()) {
  } else if (interaction.isAutocomplete()) {
    // Handle trade and progression buttons, and generic interaction handlers as before
  }

  // --- REGEX/GENERIC BUTTONS: robust customId matching ---
  if (interaction.customId) {
    // Wire up progression OVR modal handler
    if (interaction.isModalSubmit() && interaction.customId.startsWith('progression_ovr_modal_')) {
      const progressionApproveDeny = await import('./src/interactions/progression_approve_deny.js');
      const handleOvrModal = progressionApproveDeny.handleOvrModal || progressionApproveDeny.default?.handleOvrModal;
      if (typeof handleOvrModal === 'function') {
        await handleOvrModal(interaction);
      } else {
        console.error('❌ handleOvrModal is not a function. Check exports in progression_approve_deny.js');
      }
      return;
    }
    let foundHandler = null;
    for (const handler of client.interactionHandlers) {
      if (typeof handler.customId === 'string' && handler.customId === interaction.customId) {
        foundHandler = handler;
        break;
      }
      if (handler.customId instanceof RegExp && handler.customId.test(interaction.customId)) {
        foundHandler = handler;
        break;
      }
    }
    if (!foundHandler) {
      console.error(`❌ No interaction handler matching ${interaction.customId} was found.`);
      return;
    }
    try {
      await foundHandler.execute(interaction);
    } catch (error) {
      console.error(`❌ Error executing interaction ${interaction.customId}:`, error);
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ content: 'There was an error while executing this interaction!' });
        } else {
          await interaction.reply({ content: 'There was an error while executing this interaction!', flags: 64 });
        }
      } catch (replyError) {
        console.error('❌ Failed to send error message:', replyError);
      }
    }
    return;
  }
});

// Bot clientReady event (Discord.js v15+)
client.once('clientReady', (readyClient) => {
  console.log(`ENVIRONMENT: ${process.env.NODE_ENV || 'undefined'}`);
  console.log('🏀 LEAGUEbuddy is online!');
  console.log(`📊 Logged in as ${readyClient.user.tag}`);
  console.log(`🏟️  Serving ${readyClient.guilds.cache.size} server(s)`);
  console.log(`⚡ Loaded ${client.commands.size} commands`);
});


// Load all commands from src/commands/coach and src/commands/staff
async function loadCommands() {
  const commandFolders = ['coach', 'staff'];
  for (const folder of commandFolders) {
    const commandsPath = join(process.cwd(), 'src', 'commands', folder);
    const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
      const filePath = join(commandsPath, file);
      const fileURL = pathToFileURL(filePath).href;
      try {
        try {
          const commandModule = await import(fileURL);
          const cmd = commandModule.default;
          if (cmd && cmd.data && cmd.execute) {
            client.commands.set(cmd.data.name, cmd);
          }
        } catch (err) {
          console.error(`❌ Error importing ${file}:`, err);
        }
      } catch (err) {
        console.error(`❌ Failed to load command ${file}:`, err);
      }
    }
  }
}

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
if (!token) {
  console.error('❌ DISCORD_TOKEN is not set in environment. Exiting.');
  process.exit(1);
}

 
// Robust handleImageOCR implementation
async function handleImageOCR(message) {
  // Only process if in a thread
  if (!message.channel || !message.channel.isThread()) return;
  // Only process if thread is marked as pending
  const threadKey = `${message.channel.id}:${message.channel.expectedTeam || ''}`;
  if (!submitScore.pendingScoreThreads || !submitScore.pendingScoreThreads.has(threadKey)) return;
  // Only process if there is an attachment
  if (!message.attachments || message.attachments.size === 0) return;
  // Determine expected image type
  const imageType = message.channel.expectedImageType;
  if (imageType === 'box_score' && typeof submitScore.handleBoxScoreImage === 'function') {
    await submitScore.handleBoxScoreImage(message);
  } else if (imageType === 'team_comparison' && typeof submitScore.handleTeamComparisonImage === 'function') {
    await submitScore.handleTeamComparisonImage(message);
  } else {
    // Fallback: log and ignore
  }
}

(async () => {
  try {
    await loadCommands();
    await client.login(token);
  } catch (err) {
    console.error('❌ Failed to start bot:', err);
    process.exit(1);
  }
})();
