// Handles submit_player_progression interaction (auto-detect coach, team pre-filled, player dropdown)
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from "discord.js";

import fs from "fs";
import path from "path";
import { canProgression, getSeasonState } from "../shared/seasonUtils.js";
import { readRoster } from "../shared/rosterUtils.js";

export const customId = "submit_player_progression";

export async function execute(interaction) {
    console.log('[PROGRESSION DEBUG] Handler triggered');
    if (!canProgression()) {
        const state = getSeasonState();
        const cutoffWeek = 29;
        await interaction.reply({
            content: `Progression is available Weeks 1-29. Locked during playoffs and offseason. Current week: ${state.currentWeek}, phase: ${state.phase}.`,
            ephemeral: true
        });
        return;
    }
    // Auto-detect coach's team by role
    const coachRoleMap = JSON.parse(fs.readFileSync("data/coachRoleMap.json", "utf8"));
    const member = interaction.member;
    let teamName = null;
    for (const [roleLabel, roleId] of Object.entries(coachRoleMap)) {
        if (member.roles.cache.has(roleId)) {
            const teams = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'teams.json'), 'utf8'));
            // Try to match city or nickname in role label
            const found = teams.find(t => {
                const city = t.name.split(' ')[0].toLowerCase();
                const nickname = t.name.split(' ').slice(1).join(' ').toLowerCase();
                return (
                    roleLabel.toLowerCase().includes(city) ||
                    roleLabel.toLowerCase().includes(nickname) ||
                    roleLabel.toLowerCase().includes(t.abbreviation.toLowerCase())
                );
            });
            if (found) {
                teamName = found.name;
            } else {
                // fallback: strip ' Coach' and use as is
                teamName = roleLabel.replace(/ Coach$/, '');
            }
            break;
        }
    }
    if (!teamName) {
        await interaction.reply({ content: "Could not find your team.", ephemeral: true });
        return;
    }
    // Load roster using robust readRoster
    try {
        const debugLog = (msg) => {
            console.log(msg);
            try { process.stdout.write(msg + '\n'); } catch { }
        };
        const debugError = (msg) => {
            console.error(msg);
            try { process.stderr.write(msg + '\n'); } catch { }
        };
        debugLog(`[PROGRESSION DEBUG] Attempting to resolve roster for teamName: '${teamName}'`);
        const { roster: players, rosterPath } = readRoster(teamName);
        debugLog(`[PROGRESSION DEBUG] readRoster('${teamName}') returned rosterPath: ${rosterPath}, players.length: ${players ? players.length : 'null'}`);
        if (!players || players.length === 0) {
            debugError(`[PROGRESSION DEBUG] Roster not found or empty for '${teamName}' at path: ${rosterPath}`);
            await interaction.reply({ content: `Roster file not found or empty for ${teamName}.`, ephemeral: true });
            return;
        }
        // ...existing code for playerOptions, skillSets, and reply...
        const playerOptions = players
            .slice()
            .sort((a, b) => (Number(b.ovr) || 0) - (Number(a.ovr) || 0) || (a.name || '').localeCompare(b.name || ''))
            .map(p => ({ label: p.name, value: p.name }))
            .slice(0, 25);
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
    } catch (err) {
        console.error(`[PROGRESSION DEBUG] Exception occurred:`, err);
        await interaction.reply({ content: `Progression error: ${err.message}`, ephemeral: true });
    }
    // Sort by OVR desc, then name for stable, up to 25
    const playerOptions = players
        .slice()
        .sort((a, b) => (Number(b.ovr) || 0) - (Number(a.ovr) || 0) || (a.name || '').localeCompare(b.name || ''))
        .map(p => ({ label: p.name, value: p.name }))
        .slice(0, 25);
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
