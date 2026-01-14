// src/interactions/trade_submit_button.js
import fs from "fs";
import path from "path";
import { ButtonInteraction, EmbedBuilder } from "discord.js";
import { canTrade, getSeasonState } from "../utils/seasonUtils.js";

export const customId = "trade_submit_button";

function loadAllRosters() {
    const rostersDir = path.join(process.cwd(), "data/teams_rosters");
    const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
    let all = {};
    for (const file of files) {
        const arr = JSON.parse(fs.readFileSync(path.join(rostersDir, file), "utf8"));
        all[file.replace('.json', '')] = arr;
    }
    return all;
}
function saveRoster(teamFile, rosterArr) {
    const rostersDir = path.join(process.cwd(), "data/teams_rosters");
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
    if (!(interaction instanceof ButtonInteraction)) return;
    if (!canTrade()) {
        const state = getSeasonState();
        await interaction.reply({
            content: `Trades are open Weeks 1-15 and in the offseason. Locked Weeks 16-29 and during playoffs. Current week: ${state.currentWeek}, phase: ${state.phase}.`,
            ephemeral: true
        });
        return;
    }
    // Open a modal for trade entry
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
    const startTime = Date.now();
    const modal = new ModalBuilder()
        .setCustomId('trade_modal_submit')
        .setTitle('Submit Trade Proposal');


    // Synchronously detect user's team before building modal (NBA coaches only; ignore admin/ghost roles)
    let detectedTeam = '';
    try {
        const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
        const nbaTeams = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/teams.json'), 'utf8'));
        const validCoachNames = new Set(nbaTeams.map(t => `${t.name} Coach`));
        // Build roleId->team map for coach roles only
        const roleIdToTeam = {};
        for (const [team, roleId] of Object.entries(coachMap || {})) {
            if (validCoachNames.has(team)) roleIdToTeam[roleId] = team;
        }
        if (interaction.member?.roles?.cache) {
            const userRoleIds = Array.from(interaction.member.roles.cache.keys());
            const matched = userRoleIds.filter(rid => roleIdToTeam[rid]);
            if (matched.length === 1) {
                detectedTeam = roleIdToTeam[matched[0]];
            }
        }
    } catch (e) {
        // fallback: leave blank
    }

    // Build modal with detected team value
    const yourTeamInput = new TextInputBuilder()
        .setCustomId('yourTeam')
        .setLabel('Your Team (name or keyword)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(detectedTeam);

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
