import fs from "fs";
import path from "path";
import { EmbedBuilder } from "discord.js";
export const customId = "bigboard_select_3";

// This handler is for page 3 (31-45)
const bigBoardsFile = path.join(process.cwd(), "draft classes", "2k26_CUS01 - Big Board.json");

export async function execute(interaction) {
    await interaction.deferReply({ flags: 64 });
    // Aggregate all players from every Big Board JSON file in draft classes
    const draftClassesDir = path.join(process.cwd(), 'draft classes');
    const boardFiles = fs.readdirSync(draftClassesDir)
        .filter(f => f.endsWith('Big Board.json'));
    let allPlayers = [];
    for (const file of boardFiles) {
        const filePath = path.join(draftClassesDir, file);
        if (fs.existsSync(filePath)) {
            try {
                const boardData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                const players = Object.values(boardData).filter(player => player && player.name && player.position_1);
                allPlayers = allPlayers.concat(players);
            } catch (err) {
                console.error(`Error reading big board file ${filePath}:`, err);
            }
        }
    }
    // Extract player name (remove leading number and dot if present)
    function normalize(str) {
        return str
            .replace(/^\d+\.\s*/, '')
            .trim()
            .toLowerCase()
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '');
    }
    const normalizedSelected = normalize(interaction.values[0]);
    // Search the full allPlayers list for the selected player
    const selected = allPlayers.find(p => p.name && normalize(p.name) === normalizedSelected);
    if (!selected) {
        try {
            await interaction.editReply({ content: "Player not found." });
        } catch (err) {
            console.error('bigboard_select_3: Failed to editReply for not found:', err);
        }
        return;
    }

    const strengths = [selected.strength_1, selected.strength_2, selected.strength_3].filter(Boolean).join(", ") || "N/A";
    const weaknesses = [selected.weakness_1, selected.weakness_2, selected.weakness_3].filter(Boolean).join(", ") || "N/A";
    // ...existing code...

    // Load scouting data for the requesting coach
    const userId = interaction.user.id;
    const scoutPath = path.join(process.cwd(), 'data/scout_points.json');
    let scoutData = fs.existsSync(scoutPath) ? JSON.parse(fs.readFileSync(scoutPath, 'utf8')) : {};
    const userData = scoutData[userId] || { playersScouted: {} };
    const unlocked = userData.playersScouted[selected.name] || [];

    const embed = new EmbedBuilder()
        .setTitle(`${selected.position_1} - ${selected.name}`)
        .setThumbnail(selected.image ? selected.image : null)
        .addFields(
            { name: "Team", value: selected.team || "N/A", inline: true },
            { name: "Nationality", value: selected.nationality || "N/A", inline: true },
            { name: "Class", value: selected.class || "N/A", inline: true },
            { name: "Height", value: selected.height || "N/A", inline: true },
            { name: "Weight", value: selected.weight?.toString() || "N/A", inline: true },
            { name: "Wingspan", value: selected.wingspan || "N/A", inline: true },
            { name: "About", value: selected.about || "N/A" },
            { name: "Strengths", value: strengths, inline: true },
            { name: "Weaknesses", value: weaknesses, inline: true },
            { name: "Pro Comparison", value: selected.pro_comp || "N/A", inline: false }
        )
        .setColor("Green");

    // Add scouted info if unlocked
    const displayOrder = ['build', 'draft_score', 'overall', 'potential'];
    let info = [];
    displayOrder.forEach(cat => {
        if (unlocked.includes(cat) && selected[cat]) {
            if (cat === 'build') info.push(`**Build:** ${selected.build}`);
            if (cat === 'draft_score') info.push(`**Draft Score:** ${selected.draft_score}`);
            if (cat === 'overall') info.push(`**Overall:** ${selected.overall}`);
            if (cat === 'potential') info.push(`**Potential:** ${selected.potential}`);
        }
    });
    if (info.length > 0) {
        embed.addFields({ name: 'Scouted Info', value: info.join(' | '), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}
