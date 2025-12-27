import { SlashCommandBuilder, EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const data = new SlashCommandBuilder()
    .setName('bigboard')
    .setDescription('View the big board');

export async function execute(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        // Read current season number
        const seasonPath = path.join(process.cwd(), 'data', 'season.json');
        let seasonNo = 1;
        try {
            if (fs.existsSync(seasonPath)) {
                const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
                if (seasonData && seasonData.seasonNo) seasonNo = seasonData.seasonNo;
            }
        } catch (err) {
            console.error('bigboard.js: Failed to read season.json:', err);
        }
        // Map season number to class string
        const classString = `CUS${seasonNo.toString().padStart(2, '0')}`;
        // Find the big board file in the root 'draft classes' folder
        const draftClassesDir = path.join(process.cwd(), 'draft classes');
        let bigBoardFile = null;
        if (fs.existsSync(draftClassesDir)) {
            const files = fs.readdirSync(draftClassesDir).filter(f => f.includes(classString) && f.includes('Big Board.json'));
            if (files.length > 0) bigBoardFile = path.join(draftClassesDir, files[0]);
        }
        if (!bigBoardFile || !fs.existsSync(bigBoardFile)) {
            await interaction.editReply({ content: `No big board found for season ${seasonNo}.` });
            return;
        }
        // Load players from the big board file
        let allPlayers = [];
        try {
            const boardData = JSON.parse(fs.readFileSync(bigBoardFile, 'utf8'));
            allPlayers = Object.values(boardData).filter(player => player && player.name && (player.position_1 || player.position));
        } catch (err) {
            console.error('bigboard.js: Failed to read big board file:', err);
            await interaction.editReply({ content: 'Error loading big board.' });
            return;
        }
        if (allPlayers.length === 0) {
            await interaction.editReply({ content: 'No players found in this big board.' });
            return;
        }
        const playerLines = allPlayers.map((player, index) => {
            const pos = player.position_1 || player.position || '';
            const name = player.name || '';
            const team = player.team || player.college || '';
            return `${index + 1}: ${pos} ${name} - ${team}`;
        });
        // Create select menus for groups of 15 players each
        const numMenus = Math.ceil(allPlayers.length / 15);
        const components = [];
        for (let i = 0; i < numMenus; i++) {
            const startIdx = i * 15;
            const boardPlayers = allPlayers.slice(startIdx, startIdx + 15);
            if (boardPlayers.length === 0) continue;
            let customId = `bigboard_select_${i + 1}`;
            const selectOptions = boardPlayers.map((player, idx) => ({
                label: `${startIdx + idx + 1}. ${player.name}`,
                description: `${player.position_1 || player.position} - ${player.team || player.college}`,
                value: player.name
            }));
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(`Select a player (${startIdx + 1}-${startIdx + boardPlayers.length})`)
                .addOptions(selectOptions)
                .setMinValues(1)
                .setMaxValues(1);
            const row = new ActionRowBuilder().addComponents(selectMenu);
            components.push(row);
        }
        // Truncate description to Discord's limit
        const MAX_EMBED_DESCRIPTION = 4096;
        const descriptionText = Array.isArray(playerLines) && playerLines.length
            ? playerLines.join('\n').slice(0, MAX_EMBED_DESCRIPTION)
            : 'No players available';
        const embed = new EmbedBuilder()
            .setTitle('📋 Big Board')
            .setColor(0x1f8b4c)
            .setDescription(descriptionText)
            .setThumbnail('https://cdn.discordapp.com/icons/1153432333259530240/leaguebuddy_logo.png');
        await interaction.editReply({ embeds: [embed], components });
    } catch (err) {
        console.error('bigboard.js error:', err && err.stack ? err.stack : err);
        await interaction.editReply({ content: 'Error loading big board.' });
    }
}

export default { data, execute };
