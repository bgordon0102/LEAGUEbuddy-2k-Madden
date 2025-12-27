// Handles submit_player_progression interaction (auto-detect coach, team pre-filled, player dropdown)
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = "submit_player_progression";

export async function execute(interaction) {
    // Auto-detect coach's team by role
    const coachRoleMap = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../data/coachRoleMap.json'), "utf8"));
    const member = interaction.member;
    let teamName = null;
    for (const [team, roleId] of Object.entries(coachRoleMap)) {
        if (member.roles.cache.has(roleId)) {
            teamName = team;
            break;
        }
    }
    if (!teamName) {
        await interaction.reply({ content: "Could not find your team.", ephemeral: true });
        return;
    }
    // Load roster
    const fileName = teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + ".json";
    const rosterPath = path.join(__dirname, '../../../data/teams_rosters', fileName);
    if (!fs.existsSync(rosterPath)) {
        await interaction.reply({ content: "Roster file not found.", ephemeral: true });
        return;
    }
    const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    const players = Array.isArray(roster) ? roster : roster.players || [];
    // Build select menu options for players
    const playerOptions = players.map(p => ({ label: p.name, value: p.name })).slice(0, 25);
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
    const { EmbedBuilder } = await import('discord.js');
    const { StringSelectMenuBuilder } = await import('discord.js');
    // Team row (locked)
    const teamRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('progression_team_select')
            .setPlaceholder('Team')
            .addOptions([{ label: teamName, value: teamName }])
            .setDisabled(true)
    );
    // Player row
    const playerRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('progression_player_select')
            .setPlaceholder('Select a player to upgrade')
            .addOptions(playerOptions)
    );
    // Skill set row
    const skillSetRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('progression_skill_set_select')
            .setPlaceholder('Select Skill Set')
            .addOptions(skillSets)
    );
    // Embed
    const embed = new EmbedBuilder()
        .setTitle('📈 Player Progression System')
        .setDescription('Submit your upgrade using the button below.')
        .addFields(
            { name: 'Instructions', value: `Pick your skill set and check your tier value, then use your points to upgrade.\n(ex: Tier 3 = 5 pts → Shooting → 3PT +3, FT +2)`, inline: false }
        );
    await interaction.reply({ embeds: [embed], components: [teamRow, playerRow, skillSetRow], ephemeral: true });
    // Do not reply again in this handler
}
