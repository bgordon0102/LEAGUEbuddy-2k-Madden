// commands/player.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";

const data = new SlashCommandBuilder()
    .setName("2k-player")
    .setDescription("Search for an NBA 2K player")
    .addStringOption((option) =>
        option
            .setName("name")
            .setDescription("Type a player's name")
            .setRequired(true)
            .setAutocomplete(true)
    );

// Helper to load all players from all team roster files using readRoster utility
import { readRoster, computePlayerValue2k, deriveAge, deriveContract } from '../../utils/rosterUtils.js';

const teamEmojisPath = path.join(process.cwd(), 'data', '2k', 'team_emojis.json');
let teamEmojis = {};
try { teamEmojis = JSON.parse(fs.readFileSync(teamEmojisPath, 'utf8')); } catch { teamEmojis = {}; }

function findTeamEmoji(teamName) {
    if (!teamName) return null;
    const mascot = teamName.trim().split(/\s+/).pop().toLowerCase();
    const matchKey = Object.keys(teamEmojis).find(k => k.toLowerCase() === mascot);
    if (!matchKey) return null;
    const emojiId = teamEmojis[matchKey];
    const emojiName = matchKey.replace(/\s+/g, '');
    return `<:${emojiName}:${emojiId}>`;
}
function loadAllPlayers() {
    const rostersDir = path.join(process.cwd(), "teams_rosters");
    const files = fs.existsSync(rostersDir) ? fs.readdirSync(rostersDir).filter(f => f.endsWith('.json')) : [];
    let players = [];
    for (const file of files) {
        const teamFile = file.replace('.json','');
        const teamDisplay = teamFile.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
        try {
            const data = readRoster(teamFile);
            const arr = Array.isArray(data) ? data : Array.isArray(data?.players) ? data.players : [];
            players.push(...arr.map(p => ({ ...p, team: p.team || teamDisplay })));
        } catch { }
    }
    return players;
}

async function autocomplete(interaction) {
    try {
        const focusedValue = (interaction.options.getFocused() || "").toLowerCase();
        let allPlayers = loadAllPlayers()
            .filter(p => p.name)
            .sort((a, b) => a.name.localeCompare(b.name));

        const filtered = focusedValue
            ? allPlayers.filter(p => p.name.toLowerCase().includes(focusedValue))
            : allPlayers;

        const options = filtered.slice(0, 25).map(p => ({ name: p.name, value: p.name }));
        await interaction.respond(options.length ? options : [{ name: 'No players found', value: 'none' }]);
    } catch (err) {
        if (err?.code === 10062 || err?.code === 40060) return;
        console.error('[player autocomplete] Error:', err);
        try { await interaction.respond([{ name: 'No players found', value: 'none' }]); } catch (e) {
            if (e?.code !== 10062 && e?.code !== 40060) console.error('[player autocomplete] respond failed:', e);
        }
    }
}

async function execute(interaction) {
    try {
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (err) {
            if (err?.code === 10062) return;
            throw err;
        }
        const playerName = interaction.options.getString("name");
        const allPlayers = loadAllPlayers();
        const player = allPlayers.find(p => p.name && p.name.toLowerCase() === playerName.toLowerCase());
        if (!player) {
            await interaction.editReply({ content: `Player not found: ${playerName}` });
            return;
        }
        // Calculate player age as of Oct 20 of current season year; fallback to stored age field
        let ageStr = player.age != null ? String(player.age) : "-";
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
        const pos = player.position || player.position_1 || player.position1 || "-";
        const thumb = player.imgUrl || player.imgURL || player.img || player.thumbnail;
        const value = computePlayerValue2k(player);
        const { salary, yearsLeft } = deriveContract(player);
        const emoji = findTeamEmoji(player.team);
        const title = `${emoji ? `${emoji} ` : ''}${player.name}`;
        const embed = new EmbedBuilder().setTitle(title);
        if (thumb) embed.setThumbnail(String(thumb));
        embed.addFields(
            { name: "Position", value: String(pos || "-"), inline: true },
            { name: "Overall", value: player.ovr != null ? String(player.ovr) : "-", inline: true },
            { name: "Team", value: player.team ? String(player.team) : "-", inline: true },
            { name: "Trade Value", value: value ? value.toFixed(1) : "-", inline: true },
            { name: "Height", value: player.height != null ? String(player.height) : "-", inline: true },
            { name: "Weight", value: player.weight != null ? String(player.weight) : "-", inline: true },
            { name: "Wingspan", value: player.wingspan != null ? String(player.wingspan) : "-", inline: true },
            { name: "Archetype", value: player.archetype != null ? String(player.archetype) : "-", inline: true },
            { name: "Age", value: ageStr, inline: true },
            { name: "Salary (yr1)", value: salary ? `$${salary.toLocaleString()}` : "-", inline: true },
            { name: "Years Left", value: yearsLeft ? String(yearsLeft) : "-", inline: true },
            { name: "Prior to NBA", value: player.prior_to_nba != null ? String(player.prior_to_nba) : "-", inline: true },
            { name: "Nationality", value: player.nationality != null ? String(player.nationality) : "-", inline: true }
        );
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[player execute] Error:', err);
        try {
            await interaction.editReply({ content: 'Error showing player info.' });
        } catch (e) {
            if (e?.code !== 10062) console.error('[player execute] fallback failed:', e);
        }
    }
}

export default { data, execute, autocomplete };
