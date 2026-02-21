// src/interactions/trade_submit_button.js
import fs from "fs";
import path from "path";
import { get2kRostersDir } from "../shared/rosterUtils.js";
import { ButtonInteraction, EmbedBuilder } from "discord.js";
import { canTrade, getSeasonState } from "../utils/seasonUtils.js";

export const customId = "trade_submit_button";

function loadAllRosters() {
    const rostersDir = get2kRostersDir();
    const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
    let all = {};
    for (const file of files) {
        const arr = JSON.parse(fs.readFileSync(path.join(rostersDir, file), "utf8"));
        all[file.replace('.json', '')] = arr;
    }
    return all;
}
function saveRoster(teamFile, rosterArr) {
    const rostersDir = get2kRostersDir();
    fs.writeFileSync(path.join(rostersDir, teamFile), JSON.stringify(rosterArr, null, 2));
}
function parseTradeMessage(msg) {
    // Example: Team A sends: Player X, 1st Round Pick\nTeam B sends: Player Y, 2nd Round Pick
    const lines = msg.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
    let trade = {};
    for (const line of lines) {
        const match = line.match(/^(.*?)\s*sends:\s*(.*)$/i);
        if (match) {
            const team = match[1].trim();
            const assets = match[2].split(",").map(a => a.trim()).filter(Boolean);
            trade[team] = assets;
        }
    }
    return trade;
}

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) {
        console.log('[DEBUG] trade_submit_button.js: Interaction is not a ButtonInteraction:', interaction.customId);
        return;
    }
    console.log('[DEBUG] trade_submit_button.js: Handler triggered for customId:', interaction.customId, 'user:', interaction.user?.id);

    // For 2K, redirect the button to the new Trade Builder flow
    const startTime = Date.now();
    console.log('[DEBUG] trade_submit_button.js: Starting Trade Builder redirect at', startTime);
    await interaction.deferReply({ ephemeral: true });
    // Reuse trade_builder_start logic by emitting a synthetic interaction update
    const { execute: startBuilder } = await import('./trade_builder_start.js');
    // Spoof a button with customId trade_builder_start so the handler runs
    const fake = {
        ...interaction,
        customId: 'trade_builder_start_2k',
        isButton: () => true,
    };
    console.log('[DEBUG] trade_submit_button.js: Calling trade_builder_start handler with spoofed interaction.');
    await startBuilder(fake);
    console.log('[DEBUG] trade_submit_button.js: trade_builder_start handler finished. Time elapsed:', Date.now() - startTime, 'ms');
    return;


    // Synchronously detect user's team before building modal (NBA coach roles only)
    let detectedTeam = '';
    try {
        const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
        const nbaTeams = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/teams.json'), 'utf8'));
        // Build a set of valid NBA coach role IDs
        const validCoachRoles = nbaTeams.map(t => `${t.name} Coach`);
        const nbaCoachRoleIdToTeam = {};
        for (const [team, roleId] of Object.entries(coachMap)) {
            if (validCoachRoles.includes(team)) {
                nbaCoachRoleIdToTeam[roleId] = team;
            }
        }
        if (interaction.member && interaction.member.roles && interaction.member.roles.cache) {
            const userRoleIds = Array.from(interaction.member.roles.cache.keys());
            console.log('[TRADE DEBUG] User role IDs:', userRoleIds);
            console.log('[TRADE DEBUG] NBA coach roleId->team map:', nbaCoachRoleIdToTeam);
            // Find all NBA coach roles the user has (by role ID)
            const matchedCoachRoles = userRoleIds.filter(roleId => nbaCoachRoleIdToTeam[roleId]);
            console.log('[TRADE DEBUG] Matched NBA coach roles:', matchedCoachRoles);
            if (matchedCoachRoles.length === 1) {
                detectedTeam = nbaCoachRoleIdToTeam[matchedCoachRoles[0]];
                console.log('[TRADE DEBUG] Detected NBA team:', detectedTeam);
            } else {
                detectedTeam = '';
                if (matchedCoachRoles.length > 1) {
                    console.log('[TRADE DEBUG] Multiple NBA coach roles detected, leaving blank.');
                } else {
                    console.log('[TRADE DEBUG] No NBA coach role detected, leaving blank.');
                }
            }
        }
    } catch (e) {
        console.error('[TRADE DEBUG] Exception in NBA coach role detection:', e);
        // fallback: leave blank
    }

    // Build modal with detected team value
    const yourTeamInput = new TextInputBuilder()
        .setCustomId('yourTeam')
        .setLabel('Your Team (name or keyword)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    if (detectedTeam) {
        yourTeamInput.setValue(detectedTeam);
    }

    const otherTeamInput = new TextInputBuilder()
        .setCustomId('otherTeam')
        .setLabel('Other Team (name or keyword)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const assetsSentInput = new TextInputBuilder()
        .setCustomId('assetsSent')
        .setLabel('Assets Sent')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('e.g. PG Darius Garland, 2026 1st, 2028 1st (top 10), 2028 2nd');

    const assetsReceivedInput = new TextInputBuilder()
        .setCustomId('assetsReceived')
        .setLabel('Assets Received')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('e.g. PF Chet Holmgren, 2030 1st (lottery), 2030 2nd');

    const notesInput = new TextInputBuilder()
        .setCustomId('notes')
        .setLabel('Notes (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder().addComponents(yourTeamInput),
        new ActionRowBuilder().addComponents(otherTeamInput),
        new ActionRowBuilder().addComponents(assetsSentInput),
        new ActionRowBuilder().addComponents(assetsReceivedInput),
        new ActionRowBuilder().addComponents(notesInput)
    );
    const beforeShowModal = Date.now();
    console.log(`[DEBUG] trade_submit_button.js: Time from handler start to before showModal: ${beforeShowModal - startTime}ms`);
    try {
        await interaction.showModal(modal);
        const afterShowModal = Date.now();
        console.log(`[DEBUG] trade_submit_button.js: Time to showModal: ${afterShowModal - beforeShowModal}ms`);
    } catch (err) {
        if (err.code === 10062) {
            // Unknown interaction, likely expired
            console.error('❌ Cannot show modal: interaction expired.');
        } else {
            console.error('❌ Error showing modal:', err);
        }
        return;
    }
}
