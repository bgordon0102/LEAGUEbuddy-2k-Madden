import { SlashCommandBuilder, EmbedBuilder, StringSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';

const BIGBOARD_DIRS = [
    path.join(process.cwd(), 'data', 'draft_classes', '2k'),
    path.join(process.cwd(), 'bot', 'draft classes', 'big boards'),
];

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const data = new SlashCommandBuilder()
    .setName('2k-bigboard')
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
        // Find the big board file in new location first, then legacy
        let bigBoardFile = null;
        for (const dir of BIGBOARD_DIRS) {
            if (!fs.existsSync(dir)) continue;
            const files = fs.readdirSync(dir).filter(f => f.includes(classString) && f.toLowerCase().includes('big board') && f.toLowerCase().endsWith('.json'));
            if (files.length > 0) {
                bigBoardFile = path.join(dir, files[0]);
                break;
            }
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
        const cappedPlayers = allPlayers.slice(0, 60); // 4 pages * 15
        const PAGE_SIZE = 15;
        const totalPages = Math.max(1, Math.ceil(cappedPlayers.length / PAGE_SIZE));

        const buildPage = (pageIdx) => {
            const startIdx = pageIdx * PAGE_SIZE;
            const boardPlayers = cappedPlayers.slice(startIdx, startIdx + PAGE_SIZE);
            const lines = boardPlayers.map((player, idx) => {
                const pos = player.position_1 || player.position || '';
                const name = player.name || '';
                const team = player.team || player.college || '';
                return `${startIdx + idx + 1}: ${pos} ${name} - ${team}`;
            });
            const embed = new EmbedBuilder()
                .setTitle(`📋 Big Board (Page ${pageIdx + 1}/${totalPages})`)
                .setColor(0x1f8b4c)
                .setDescription(lines.join('\n') || 'No players on this page.')
                .setThumbnail('https://cdn.discordapp.com/icons/1153432333259530240/leaguebuddy_logo.png');

            const selectOptions = boardPlayers.map((player, idx) => ({
                label: `${startIdx + idx + 1}. ${player.name}`,
                description: `${player.position_1 || player.position} - ${player.team || player.college}`,
                value: player.name
            }));
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`2k_bigboard_select_${pageIdx}`)
                .setPlaceholder(`Select a player (${startIdx + 1}-${startIdx + boardPlayers.length})`)
                .addOptions(selectOptions)
                .setMinValues(1)
                .setMaxValues(1);
            const selectRow = new ActionRowBuilder().addComponents(selectMenu);

            const navRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`2k_bigboard_page_${pageIdx}`)
                    .setLabel('Prev')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pageIdx <= 0),
                new ButtonBuilder()
                    .setCustomId(`2k_bigboard_page_${pageIdx + 2}`)
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(pageIdx >= totalPages - 1)
            );
            return { embed, rows: [selectRow, navRow] };
        };

        const first = buildPage(0);
        await interaction.editReply({ embeds: [first.embed], components: first.rows });
    } catch (err) {
        console.error('bigboard.js error:', err && err.stack ? err.stack : err);
        await interaction.editReply({ content: 'Error loading big board.' });
    }
}

export default { data, execute };
