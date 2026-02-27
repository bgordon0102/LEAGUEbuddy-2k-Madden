import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { deriveTeamNeeds } from './mockdraft.js';

// Load coach map (assume JSON: { coachDiscordId: teamName })
const COACH_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
function getCoachTeam(userId) {
    if (!fs.existsSync(COACH_MAP_PATH)) return null;
    const map = JSON.parse(fs.readFileSync(COACH_MAP_PATH, 'utf8'));
    return map[userId] || null;
}

export const data = new SlashCommandBuilder()
    .setName('madden-teamneeds')
    .setDescription('Show your Madden team\'s current top needs.');

export async function execute(interaction) {
    const userId = interaction.user.id;
    const teamName = getCoachTeam(userId);
    if (!teamName) {
        await interaction.reply({ content: 'You are not mapped to a Madden team. Contact a commissioner.', ephemeral: true });
        return;
    }
    // Load latest league file
    const leagueFile = (() => {
        const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({ f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        return files.length ? path.join(dir, files[0].f) : null;
    })();
    if (!leagueFile) {
        await interaction.reply({ content: 'No league snapshot found.', ephemeral: true });
        return;
    }
    const league = JSON.parse(fs.readFileSync(leagueFile, 'utf8'));
    const needsByTeam = deriveTeamNeeds(league);
    // Normalize team name for lookup
    const teamNameNorm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const needs = needsByTeam[teamNameNorm] || [];
    const embed = new EmbedBuilder()
        .setTitle(`${teamName} — Top Team Needs`)
        .setDescription(needs.length ? needs.join(', ') : 'No needs found.')
        .setColor(0x00b0f4);
    await interaction.reply({ embeds: [embed], ephemeral: true });
}
