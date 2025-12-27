// commands/roster.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";

const data = new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Show a team's NBA 2K roster")
    .addStringOption((option) =>
        option
            .setName("team")
            .setDescription("The NBA team to view the roster for")
            .setRequired(true)
            .setAutocomplete(true)
    );

async function autocomplete(interaction) {
    try {
        console.log('[DEBUG] roster autocomplete called');
        const focusedValue = interaction.options.getFocused() || "";
        console.log(`[DEBUG] focusedValue: '${focusedValue}'`);
        const teamsPath = path.join(process.cwd(), "data/teams.json");
        let teams = [];
        if (fs.existsSync(teamsPath)) {
            try {
                teams = JSON.parse(fs.readFileSync(teamsPath, "utf8"));
                console.log(`[DEBUG] Loaded teams: ${teams.length}`);
            } catch (e) {
                console.error('[roster autocomplete] Failed to parse teams.json:', e);
            }
        } else {
            console.error(`[DEBUG] teams.json does not exist at ${teamsPath}`);
        }
        // Support searching by name or abbreviation
        const filtered = teams.filter(team => {
            const name = team.name?.toLowerCase() || "";
            const abbr = team.abbreviation?.toLowerCase() || "";
            const search = focusedValue.toLowerCase();
            return name.includes(search) || abbr.includes(search);
        });
        console.log(`[DEBUG] Filtered teams: ${filtered.length}`);
        // If nothing matches, show all teams
        const options = (filtered.length ? filtered : teams)
            .map(team => ({ name: `${team.name} (${team.abbreviation})`, value: team.name }))
            .slice(0, 25);
        console.log('[DEBUG] Autocomplete options:', options);
        await interaction.respond(options);
        return;
    } catch (err) {
        console.error('[roster autocomplete] Fatal error:', err);
        try { await interaction.respond([{ name: 'No teams found', value: 'none' }]); } catch { }
        return;
    }
}

async function execute(interaction) {
    let responded = false;
    try {
        await interaction.deferReply({ ephemeral: true });
        responded = true;
        const team = interaction.options.getString("team");
        // Convert team name to file name
        const fileName = team.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + ".json";
        const rosterPath = path.join(process.cwd(), "data/teams_rosters", fileName);
        if (!fs.existsSync(rosterPath)) {
            await interaction.editReply({ content: `No roster found for ${team}.` });
            return;
        }
        const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
        // Handle new roster format: object with players and picks
        let playersArr = Array.isArray(roster) ? roster : roster.players || [];
        if (!Array.isArray(playersArr) || playersArr.length === 0) {
            await interaction.editReply({ content: `No players found for ${team}.` });
            return;
        }
        // Sort roster by OVR descending
        const sortedRoster = [...playersArr].sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0));
        // Format roster for embed and build action rows for each player
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
        const lines = [];
        const actionRows = [];
        for (const player of sortedRoster) {
            lines.push(`**${player.name}** | ${player.position} | OVR: ${player.ovr}`);
            // No action buttons shown
        }
        // Discord only allows 5 action rows per message, batch if needed
        const batchedRows = [];
        for (let i = 0; i < actionRows.length; i += 5) {
            batchedRows.push(actionRows.slice(i, i + 5));
        }

        // Load draft picks for this team from roster file
        let teamPicks = Array.isArray(roster.picks) ? roster.picks : [];
        // Group and format picks by year for embed
        function formatPicksByYear(picks, teamName) {
            const grouped = {};
            for (const pick of picks) {
                let pickStr = typeof pick === 'string' ? pick : pick.pick || '';
                let yearMatch = pickStr.match(/\d{4}/);
                let year = yearMatch ? yearMatch[0] : 'Other';
                let line = pickStr;
                if (typeof pick === 'object') {
                    if (pick.protection && pick.protection !== 'unprotected') {
                        line += ` (${pick.protection} protected)`;
                    }
                    if (pick.originalTeam && pick.originalTeam !== teamName) {
                        line += ` (from ${pick.originalTeam})`;
                    }
                }
                if (!grouped[year]) grouped[year] = [];
                grouped[year].push(line);
            }
            let result = '';
            Object.keys(grouped).sort().forEach(year => {
                result += `**${year}**\n`;
                result += grouped[year].map(p => `• ${p}`).join('\n') + '\n';
            });
            return result.trim();
        }
        let pickLines = teamPicks.length ? formatPicksByYear(teamPicks, team) : '';

        const embed = new EmbedBuilder()
            .setTitle(`Roster for ${team}`)
            .setDescription(lines.join("\n\n").slice(0, 4000) || "No players found.")
            .setColor(0x1E90FF);
        embed.addFields({
            name: 'Draft Picks',
            value: pickLines ? pickLines.slice(0, 1024) : 'No draft picks found.'
        });
        // Debug: show sorted roster and picks in console
        console.log('[ROSTER DEBUG] Sorted roster:', sortedRoster.map(p => `${p.name} (${p.ovr})`).join(', '));
        console.log('[ROSTER DEBUG] Picks:', pickLines);
        await interaction.editReply({ embeds: [embed], components: batchedRows[0] || [] });
        // If more than 5 rows, send additional follow-up messages with only buttons
        for (let i = 1; i < batchedRows.length; i++) {
            await interaction.followUp({ components: batchedRows[i], ephemeral: true });
        }
    } catch (err) {
        console.error('Error in roster:', err);
        if (responded) {
            await interaction.editReply({ content: 'Failed to load roster.' });
        } else {
            await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
        }
    }
}

export default { data, execute, autocomplete };
