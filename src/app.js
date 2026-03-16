// LEAGUEbuddy: Modern Discord bot entry
import dotenv from 'dotenv';
import fs, { readdirSync, createWriteStream } from 'fs';
import { Client, GatewayIntentBits, Collection, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as submitScore from './interactions/submit_score.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { startAuthServer } from './madden/auth_server.js';
import { startExportWebhook } from './madden/export_webhook.js';
import { startAutoSync } from './madden/auto_sync.js';
import { startLocalSidecar } from './madden/local_sidecar.js';
import { initNotifier } from './shared/madden_thread_notifier.js';
import { appendMaddenStaffLog, postMaddenStaffLog, initMaddenStoryScheduler } from './shared/madden_staff_ops.js';
import { updateFairSimBoard } from './shared/fairsim_board.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ]
});
client.commands = new Collection();
client.interactionHandlers = [];

// Start local Madden auth server (for EA login) unless disabled
const enableAuthServer = process.env.MADDEN_AUTH_ENABLED !== 'false' && process.env.MADDEN_AUTH_ENABLED !== '0';
if (enableAuthServer) {
  try {
    startAuthServer();
  } catch (err) {
    console.warn(`[madden-auth] Failed to start auth server: ${err.message}`);
  }
}
try {
  startExportWebhook();
} catch (err) {
  console.warn(`[madden-export] Failed to start export webhook: ${err.message}`);
}
try {
  startAutoSync();
} catch (err) {
  console.warn(`[madden-auto-sync] Failed to start auto sync: ${err.message}`);
}
try {
  startLocalSidecar();
} catch (err) {
  console.warn(`[madden-sidecar] Failed to start local sidecar: ${err.message}`);
}

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
    if (interaction.commandName?.startsWith('madden-')) {
      appendMaddenStaffLog({
        type: 'command',
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        command: interaction.commandName,
      });
      postMaddenStaffLog(
        client,
        interaction.guildId,
        'Madden Command Used',
        `<@${interaction.user.id}> used \`/${interaction.commandName}\`.`,
      ).catch(() => null);
    }
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
    console.log(`[INTERACTION] Button pressed: customId=${interaction.customId}, user=${interaction.user?.id}, channel=${interaction.channel?.id}, thread=${interaction.channel?.isThread ? interaction.channel.id : 'N/A'}`);
    const customId = String(interaction.customId || '').toLowerCase();
    const isMaddenButton =
      customId.includes('madden') ||
      customId.startsWith('trade_') ||
      customId.startsWith('builder_') ||
      customId.startsWith('fairsim') ||
      customId.startsWith('forcewin') ||
      customId.startsWith('staff_strike');
    if (isMaddenButton) {
      appendMaddenStaffLog({
        type: 'button',
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        username: interaction.user?.tag,
        customId: interaction.customId,
        channelId: interaction.channel?.id,
      });
      postMaddenStaffLog(
        client,
        interaction.guildId,
        'Madden Button Used',
        `<@${interaction.user.id}> pressed \`${interaction.customId}\`.`,
        [{ name: 'Channel', value: interaction.channel?.id ? `<#${interaction.channel.id}>` : 'Unknown', inline: true }],
      ).catch(() => null);
    }
  } else if (interaction.isStringSelectMenu()) {
    console.log(`[INTERACTION] StringSelectMenu used: customId=${interaction.customId}, user=${interaction.user?.id}`);
  } else if (interaction.isAutocomplete()) {
    // Handle trade and progression buttons, and generic interaction handlers as before
  }

  // --- REGEX/GENERIC BUTTONS: robust customId matching ---
  if (interaction.customId) {
    // Wire up progression OVR modal handler
    if (interaction.isModalSubmit() && interaction.customId.startsWith('progression_ovr_modal_')) {
      const progressionApproveDeny = await import('./interactions/progression_approve_deny.js');
      const handleOvrModal = progressionApproveDeny.handleOvrModal || progressionApproveDeny.default?.handleOvrModal;
      if (typeof handleOvrModal === 'function') {
        await handleOvrModal(interaction);
      } else {
        console.error('❌ handleOvrModal is not a function. Check exports in progression_approve_deny.js');
      }
      return;
    }
    // Route Madden set_game_info_ legacy modal submits
    if (interaction.isModalSubmit() && interaction.customId.startsWith('set_game_info_modal_')) {
      const setGameInfo = await import('./interactions/set_game_info.js');
      await setGameInfo.execute_modal_set_game_info(interaction);
      return;
    }
    // Route 2K set_game_info| modals
    if (interaction.isModalSubmit() && interaction.customId.startsWith('set_game_info_modal|')) {
      console.log('[router] 2K set_game_info modal', interaction.customId);
      const setGameInfo2k = await import('./2k/set_game_info.js');
      await setGameInfo2k.execute_modal(interaction);
      return;
    }
    // Route 2K set_game_info| button
    if (interaction.isButton() && interaction.customId.startsWith('set_game_info|')) {
      console.log('[router] 2K set_game_info button', interaction.customId);
      const setGameInfo2k = await import('./2k/set_game_info.js');
      await setGameInfo2k.execute(interaction);
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
  try { initNotifier(client); } catch (e) { console.warn('[notifier] init failed', e?.message || e); }
  try { initMaddenStoryScheduler(client); } catch (e) { console.warn('[story scheduler] init failed', e?.message || e); }
  for (const guild of readyClient.guilds.cache.values()) {
    appendMaddenStaffLog({ type: 'lifecycle', guildId: guild.id, state: 'online' });
    postMaddenStaffLog(client, guild.id, 'Bot Online', 'LEAGUEbuddy Madden services are online.').catch(() => null);
    updateFairSimBoard(client, guild.id).catch((e) => {
      console.warn('[fairsim_board] startup refresh failed', guild.id, e?.message || e);
    });
  }
});


// Load all commands from src/commands/2k/{coach,staff} and src/commands/madden
async function loadCommands() {
  const commandFolders = [
    ['2k', 'coach'],
    ['2k', 'staff'],
    ['madden'],
    ['madden', 'coach'],
    ['madden', 'staff'],
  ];
  // Only scan the primary command directories (old src/commands stubs are ignored)
  const roots = [
    join(process.cwd(), 'src'),
  ];

  for (const parts of commandFolders) {
    for (const root of roots) {
      const commandsPath = join(root, ...parts);
      if (!fs.existsSync(commandsPath)) continue;
      const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));
      for (const file of commandFiles) {
        const filePath = join(commandsPath, file);
        const fileURL = pathToFileURL(filePath).href;
        try {
          const commandModule = await import(fileURL);
          const cmd = commandModule.default;
          if (cmd && cmd.data && cmd.execute) {
            client.commands.set(cmd.data.name, cmd);
          }
        } catch (err) {
          console.error(`❌ Error importing ${file}:`, err);
        }
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

async function logLifecycle(state) {
  for (const guild of client.guilds.cache.values()) {
    appendMaddenStaffLog({ type: 'lifecycle', guildId: guild.id, state });
    await postMaddenStaffLog(client, guild.id, state === 'offline' ? 'Bot Offline' : 'Bot Lifecycle', `LEAGUEbuddy Madden services marked \`${state}\`.`).catch(() => null);
  }
}

process.on('SIGINT', () => {
  logLifecycle('offline').finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  logLifecycle('offline').finally(() => process.exit(0));
});
