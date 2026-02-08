// Handles progression_player_select (player dropdown selection) and opens modal
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = "progression_player_select";

export async function execute(interaction) {
    // Get selected player
    const selectedPlayer = interaction.values[0];
    // Get team name from previous message (assume ephemeral reply, so interaction.member is correct)
    // You may want to pass team name in customId or store in session if needed
    // For now, re-detect team from roles
    const coachRoleMap = JSON.parse(fs.readFileSync("data/coachRoleMap.json", "utf8"));
    const member = interaction.member;
    let teamName = null;
    for (const [team, roleId] of Object.entries(coachRoleMap)) {
        if (member.roles.cache.has(roleId)) {
            teamName = team;
            break;
        }
    }
    // Auto-detect player's OVR from roster
    let playerOvr = "";
    if (teamName) {
        const fileName = teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + ".json";
        const rosterPath = path.join(process.cwd(), "data/teams_rosters", fileName);
        if (fs.existsSync(rosterPath)) {
            const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
            const players = Array.isArray(roster) ? roster : roster.players || [];
            const playerObj = players.find(p => p.name === selectedPlayer);
            if (playerObj && playerObj.ovr) playerOvr = playerObj.ovr.toString();
        }
    }
    // Show skill set dropdown after player selection, then immediately show modal
    const skillSets = [
        { label: 'Driving', value: 'Driving', description: 'Layup, Dunk, Speed with Ball' },
        { label: 'Shooting', value: 'Shooting', description: 'Mid, 3pt, Free Throw' },
        { label: 'Post Scoring', value: 'Post Scoring', description: 'Close Shot, Standing Dunk, Post Hook, Post Fade, Post Control' },
        { label: 'Playmaking', value: 'Playmaking', description: 'Ball Handling, Pass Accuracy, Pass IQ, Vision' },
        { label: 'Interior Defense', value: 'Interior Defense', description: 'Inside Defense, Block, Help Defense IQ' },
        { label: 'Perimeter Defense', value: 'Perimeter Defense', description: 'Perimeter Defense, Steal, Pass Perception' },
        { label: 'Rebounding', value: 'Rebounding', description: 'Offensive Rebound, Defensive Rebound' },
        { label: 'IQ', value: 'IQ', description: 'Foul, Shot IQ, Offensive Consistency, Defensive Consistency, Intangible' },
        { label: 'Conditioning', value: 'Conditioning', description: '+5 to use on Speed, Accel, Agility, Vertical, Stamina' },
        { label: 'Weight Room', value: 'Weight Room', description: '+3 Strength, +8 lbs, -1 Speed, Accel, Vertical' },
        { label: 'Shooting Mechanics', value: 'Shooting Mechanics', description: 'Adjust Shot Timing' },
        { label: 'Distributor', value: 'Distributor', description: 'Enables Play Initiator (80+ Ball Handle)' },
        { label: 'X-Factor', value: 'X-Factor', description: '+3 Potential' }
    ];
    const { StringSelectMenuBuilder } = await import('discord.js');
    const skillSetSelect = new StringSelectMenuBuilder()
        .setCustomId('progression_skill_set_select')
        .setPlaceholder('Select Skill Set')
        .addOptions(skillSets);
    const skillSetRow = new ActionRowBuilder().addComponents(skillSetSelect);
    await interaction.update({ content: `Select a skill set for ${selectedPlayer}:`, components: [skillSetRow] });
}
