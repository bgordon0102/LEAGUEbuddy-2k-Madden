// Handles submit_player_progression interaction (auto-detect coach, team pre-filled, player dropdown)
import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";
import fs from "fs";
import path from "path";
import { canProgression, getSeasonState } from "../utils/seasonUtils.js";
import { readRoster } from "../utils/rosterUtils.js";

export const customId = "submit_player_progression";

export async function execute(interaction) {
    const log = (msg) => { console.log(msg); try { process.stdout.write(msg + '\n'); } catch {} };
    const errorLog = (msg) => { console.error(msg); try { process.stderr.write(msg + '\n'); } catch {} };

    log('[PROGRESSION DEBUG] submit_player_progression handler triggered');

    if (!canProgression()) {
        const state = getSeasonState();
        await interaction.reply({
            content: `Progression is available Weeks 1-29. Locked during playoffs and offseason. Current week: ${state.currentWeek}, phase: ${state.phase}.`,
            ephemeral: true
        });
        return;
    }

    let coachRoleMap = {};
    try {
        coachRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
    } catch (e) {
        errorLog(`[PROGRESSION DEBUG] Failed to read coachRoleMap.json: ${e.message}`);
    }

    const member = interaction.member;
    let teamName = null;
    let matchedRole = null;
    // Prefer explicit team coach roles (ending with "Coach"), ignore org/staff roles
    const roleEntries = Object.entries(coachRoleMap).filter(([label]) => /coach$/i.test(label.trim()) || label.trim().endsWith(' Coach'));
    for (const [roleLabel, roleId] of roleEntries) {
        if (member?.roles?.cache?.has(roleId)) {
            matchedRole = roleLabel;
            teamName = roleLabel.replace(/ Coach$/i, '').trim();
            break;
        }
    }
    // If no coach role matched, fall back to any mapped role (last resort)
    if (!teamName) {
        for (const [roleLabel, roleId] of Object.entries(coachRoleMap)) {
            if (member?.roles?.cache?.has(roleId)) {
                matchedRole = roleLabel;
                teamName = roleLabel.replace(/ Coach$/i, '').trim();
                break;
            }
        }
    }

    log(`[PROGRESSION DEBUG] Matched role: ${matchedRole || 'none'}, teamName: ${teamName || 'none'}`);

    if (!teamName) {
        await interaction.reply({ content: "Could not find your team (no matching coach role).", ephemeral: true });
        return;
    }

    try {
        const { roster: players, rosterPath } = readRoster(teamName);
        log(`[PROGRESSION DEBUG] readRoster('${teamName}') -> path: ${rosterPath}, players: ${players ? players.length : 'null'}`);
        if (!players || players.length === 0) {
            await interaction.reply({ content: `Roster file not found or empty for ${teamName}. Path: ${rosterPath}`, ephemeral: true });
            return;
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

        const teamRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('progression_team_select')
                .setPlaceholder('Team')
                .addOptions([{ label: teamName, value: teamName }])
                .setDisabled(true)
        );
        const playerRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('progression_player_select')
                .setPlaceholder('Select a player to upgrade')
                .addOptions(playerOptions)
        );
        const skillSetRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId('progression_skill_set_select')
                .setPlaceholder('Select Skill Set')
                .addOptions(skillSets)
        );
        const embed = new EmbedBuilder()
            .setTitle('📈 Player Progression System')
            .setDescription('Submit your upgrade using the button below.')
            .addFields(
                { name: 'Instructions', value: `Pick your skill set and check your tier value, then use your points to upgrade.\n(ex: Tier 3 = 5 pts → Shooting → 3PT +3, FT +2)`, inline: false }
            );
        await interaction.reply({ embeds: [embed], components: [teamRow, playerRow, skillSetRow], ephemeral: true });
    } catch (err) {
        errorLog(`[PROGRESSION DEBUG] Exception occurred: ${err?.message || err}`);
        await interaction.reply({ content: `Progression error: ${err?.message || err}`, ephemeral: true });
    }
}
