// Handles player_progression_modal_submit modal submission
import fs from "fs";
import path from "path";
import { EmbedBuilder } from "discord.js";

const PROGRESSION_CHANNEL_ID = "1425555037328773220";

export const customId = "player_progression_modal_submit";

export async function execute(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== "player_progression_modal_submit") return;
    const log = (msg) => { console.log(msg); try { process.stdout.write(msg + '\n'); } catch {} };
    const errorLog = (msg) => { console.error(msg); try { process.stderr.write(msg + '\n'); } catch {} };
    log('[PROGRESSION DEBUG] player_progression_modal_submit handler triggered');

    // Early error handling before deferReply
    const teamName = interaction.fields.getTextInputValue("teamName");
    const playerName = interaction.fields.getTextInputValue("playerName");
    const skillSet = interaction.fields.getTextInputValue("skillSet");
    const attributeUpgrades = interaction.fields.getTextInputValue("attributeUpgrades");

    // Load roster using shared helper
    let rosterPath = null;
    let players = [];
    try {
        const { readRoster } = await import('../utils/rosterUtils.js');
        const res = readRoster(teamName);
        rosterPath = res.rosterPath;
        players = res.roster || [];
    } catch (e) {
        errorLog(`[PROGRESSION DEBUG] Failed to load roster via readRoster: ${e?.message || e}`);
    }

    log(`[PROGRESSION DEBUG] Modal readRoster('${teamName}') -> path: ${rosterPath}, players: ${players ? players.length : 'null'}`);

    if (!players || players.length === 0) {
        await interaction.reply({ content: `Roster file not found or empty for ${teamName}. Path: ${rosterPath}`, ephemeral: true });
        return;
    }
    const norm = str => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx = players.findIndex(p => norm(p.name) === norm(playerName));
    if (idx === -1) {
        await interaction.reply({ content: "Player not found in your roster.", ephemeral: true });
        return;
    }
    // Defer reply for all async work
    await interaction.deferReply({ ephemeral: true });

    // Save progression details to player
    players[idx].progression = players[idx].progression || [];
    players[idx].progression.push({
        skillSet,
        attributeUpgrades,
        date: new Date().toISOString(),
        submittedBy: interaction.user.id
    });

    // Save changes
    if (!rosterPath) {
        await interaction.editReply({ content: 'Progression saved in memory, but roster path unavailable to write.' });
        return;
    }
    try {
        // Write back preserving original shape
        const isArray = Array.isArray(players) && (!fs.existsSync(rosterPath) || Array.isArray(players));
        if (isArray) {
            fs.writeFileSync(rosterPath, JSON.stringify(players, null, 2));
        } else {
            // If original was object, keep players under .players
            const current = fs.existsSync(rosterPath) ? JSON.parse(fs.readFileSync(rosterPath, 'utf8')) : {};
            current.players = players;
            fs.writeFileSync(rosterPath, JSON.stringify(current, null, 2));
        }
    } catch (e) {
        errorLog(`[PROGRESSION DEBUG] Failed to write roster: ${e?.message || e}`);
    }


    // Build embed for progression request
    const coachTag = `<@${interaction.user.id}>`;
    const embed = new EmbedBuilder()
        .setTitle("Player Progression Request")
        .addFields(
            { name: "Team", value: teamName },
            { name: "Player Name", value: playerName },
            { name: "Skill Set", value: skillSet },
            { name: "Attribute Upgrades", value: attributeUpgrades },
            { name: "Submitted By", value: coachTag }
        )
        .setColor(0x1E90FF);

    // Add approve/deny buttons
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
    const approveBtn = new ButtonBuilder()
        .setCustomId(`progression_approve_${playerName}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder()
        .setCustomId(`progression_deny_${playerName}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger);
    const actionRow = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    // Tag staff roles
    const staffMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/staffRoleMap.main.json'), 'utf8'));
    const staffTags = [staffMap['Paradise Commish'], staffMap['Paradise Co-Commish']]
        .filter(Boolean)
        .map(id => `<@&${id}>`)
        .join(' ');

    // Post to progression channel (ensure correct channel ID is used)
    // Replace PROGRESSION_CHANNEL_ID with the actual progression channel ID string if needed
    const progressionChannelId = '1428097786272026736';
    const channel = await interaction.client.channels.fetch(progressionChannelId);
    if (channel) {
        // Add coach role tag for the submitting team
        let coachRoleTag = "";
        try {
            const coachRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
            const coachRoleId = coachRoleMap[teamName];
            if (coachRoleId) {
                coachRoleTag = `<@&${coachRoleId}>`;
            }
        } catch (err) {
            console.error('Error tagging coach role:', err);
        }
        const allTags = [coachRoleTag, staffTags].filter(Boolean).join(' ');
        await channel.send({ content: allTags, embeds: [embed], components: [actionRow] });
        await interaction.editReply({ content: `Progression for ${playerName} submitted and saved!` });
    } else {
        await interaction.editReply({ content: 'Error: Progression channel not found, but progression was saved.' });
    }
}
