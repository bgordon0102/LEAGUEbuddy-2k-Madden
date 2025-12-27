// commands/player.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";

const data = new SlashCommandBuilder()
    .setName("player")
    .setDescription("Search for an NBA 2K player")
    .addStringOption((option) =>
        option
            .setName("name")
            .setDescription("Type a player's name")
            .setRequired(true)
            .setAutocomplete(true)
    );

// Helper to load all players from all team roster files
function loadAllPlayers() {
    const rostersDir = path.join(process.cwd(), "data/teams_rosters");
    const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
    let players = [];
    for (const file of files) {
        try {
            const obj = JSON.parse(fs.readFileSync(path.join(rostersDir, file), "utf8"));
            if (Array.isArray(obj.players)) players.push(...obj.players);
        } catch { }
    }
    return players;
}

async function autocomplete(interaction) {
    try {
        const focusedValue = interaction.options.getFocused() || "";
        let allPlayers = loadAllPlayers();
        // Sort all players alphabetically by name
        allPlayers = allPlayers.sort((a, b) => {
            if (!a.name) return 1;
            if (!b.name) return -1;
            return a.name.localeCompare(b.name);
        });
        // Filter by name (case-insensitive, partial match)
        const filtered = allPlayers.filter(p => p.name && p.name.toLowerCase().includes(focusedValue.toLowerCase()));
        // Show top 25 matches, sorted
        const options = (filtered.length ? filtered : allPlayers)
            .map(p => ({ name: p.name, value: p.name }))
            .slice(0, 25);
        await interaction.respond(options);
    } catch (err) {
        console.error('[player autocomplete] Error:', err);
        try { await interaction.respond([{ name: 'No players found', value: 'none' }]); } catch { }
    }
}

async function execute(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        const playerName = interaction.options.getString("name");
        const allPlayers = loadAllPlayers();
        const player = allPlayers.find(p => p.name && p.name.toLowerCase() === playerName.toLowerCase());
        if (!player) {
            await interaction.editReply({ content: `Player not found: ${playerName}` });
            return;
        }
        // Calculate player age as of Oct 20 of current season year
        let ageStr = "-";
        try {
            const seasonPath = path.join(process.cwd(), "data/season.json");
            let seasonNo = 1;
            if (fs.existsSync(seasonPath)) {
                const seasonData = JSON.parse(fs.readFileSync(seasonPath, "utf8"));
                if (seasonData.seasonNo) seasonNo = Number(seasonData.seasonNo);
            }
            const seasonYear = 2024 + seasonNo; // season 1 = 2025
            if (player.birthdate) {
                // Parse birthdate (e.g., "February 28, 1999")
                const birth = new Date(player.birthdate);
                const refDate = new Date(`${seasonYear}-10-20`);
                let age = refDate.getFullYear() - birth.getFullYear();
                if (
                    refDate.getMonth() < birth.getMonth() ||
                    (refDate.getMonth() === birth.getMonth() && refDate.getDate() < birth.getDate())
                ) {
                    age--;
                }
                ageStr = `${age}`;
            }
        } catch (err) {
            ageStr = "-";
        }
        // Build embed with all info
        const embed = new EmbedBuilder()
            .setTitle(player.name)
            .setThumbnail(player.imgUrl || null)
            .addFields(
                { name: "Position", value: player.position || "-", inline: true },
                { name: "Overall", value: player.ovr ? String(player.ovr) : "-", inline: true },
                { name: "Height", value: player.height || "-", inline: true },
                { name: "Weight", value: player.weight || "-", inline: true },
                { name: "Wingspan", value: player.wingspan || "-", inline: true },
                { name: "Archetype", value: player.archetype || "-", inline: true },
                { name: "Age", value: ageStr, inline: true },
                { name: "Salary", value: player.salary || "-", inline: true },
                { name: "Prior to NBA", value: player.prior_to_nba || "-", inline: true },
                { name: "Nationality", value: player.nationality || "-", inline: true }
            );
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[player execute] Error:', err);
        await interaction.editReply({ content: 'Error showing player info.' });
    }
}

export default { data, execute, autocomplete };
