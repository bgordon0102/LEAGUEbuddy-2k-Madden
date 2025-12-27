// commands/schedule.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";


export const data = new SlashCommandBuilder()
    .setName("schedule")
    .setDescription("Show a team's NBA season schedule")
    .addStringOption((option) =>
        option
            .setName("team")
            .setDescription("The NBA team to view the schedule for")
            .setRequired(true)
            .setAutocomplete(true)
    );
async function autocomplete(interaction) {
    try {
        const focusedValue = interaction.options.getFocused();
        const teamsPath = path.join(process.cwd(), "data/teams.json");
        let teams = [];
        if (fs.existsSync(teamsPath)) {
            try {
                teams = JSON.parse(fs.readFileSync(teamsPath, "utf8"));
                // Always sort full list alphabetically
                teams.sort((a, b) => a.name.localeCompare(b.name));
                console.log(`[autocomplete] Loaded teams from teams.json:`, teams);
            } catch (e) {
                console.error('[autocomplete] Failed to parse teams.json:', e);
            }
        } else {
            console.error('[autocomplete] teams.json does not exist at', teamsPath);
        }
        let filtered;
        if (!focusedValue) {
            // No filter: show all teams in ABC order
            filtered = teams;
        } else {
            filtered = teams.filter(team => team.name && team.name.toLowerCase().includes(focusedValue.toLowerCase()));
        }
        // filtered is now always in ABC order
        console.log(`[autocomplete] Focused value: '${focusedValue}', Filtered:`, filtered);
        await interaction.respond(
            filtered.map(team => ({ name: team.name, value: team.name })).slice(0, 25)
        );
        return;
    } catch (err) {
        console.error('[autocomplete] Fatal error:', err);
        // If error, respond with empty array and return
        try { await interaction.respond([]); } catch { }
        return;
    }
}

async function execute(interaction) {
    let responded = false;
    console.log('[DEBUG] schedule.js execute called');
    try {
        await interaction.deferReply({ ephemeral: true });
        responded = true;
        const team = interaction.options.getString("team");
        console.log(`[DEBUG] Requested team: ${team}`);
        const teamsPath = path.join(process.cwd(), "data/teams.json");
        const schedulePath = path.join(process.cwd(), "data/schedule.json");
        const seasonPath = path.join(process.cwd(), "data/season.json");
        console.log(`[DEBUG] teamsPath: ${teamsPath}, schedulePath: ${schedulePath}, seasonPath: ${seasonPath}`);
        if (!fs.existsSync(teamsPath) || !fs.existsSync(schedulePath) || !fs.existsSync(seasonPath)) {
            console.log('[DEBUG] One or more data files missing');
            await interaction.editReply({
                content: "No season data found. Please run `/startseason` first."
            });
            return;
        }
        const teams = JSON.parse(fs.readFileSync(teamsPath, "utf8"));
        const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
        const seasonData = JSON.parse(fs.readFileSync(seasonPath, "utf8"));
        console.log('[DEBUG] Loaded teams:', teams.length);
        console.log('[DEBUG] Loaded schedule:', Array.isArray(schedule), schedule.length);
        console.log('[DEBUG] Loaded seasonData:', seasonData);
        const currentWeek = seasonData.currentWeek;
        let week = 1;
        let gamesList = [];
        if (currentWeek === 0) {
            gamesList.push('**Week 0**');
        }
        gamesList = gamesList.concat(
            schedule.flat().map((g) => {
                let opponent = null;
                if (g.team1 && g.team1.name === team) {
                    opponent = g.team2 && g.team2.name ? g.team2.name : '';
                } else if (g.team2 && g.team2.name === team) {
                    opponent = g.team1 && g.team1.name ? g.team1.name : '';
                }
                if (!opponent) return null;
                if (week === currentWeek && currentWeek !== 0) {
                    // Highlight current week
                    const line = `➡️ **W${week}. ${opponent}**`;
                    week++;
                    return line;
                } else {
                    const line = `W${week}. ${opponent}`;
                    week++;
                    return line;
                }
            }).filter(Boolean)
        );
        console.log('[DEBUG] gamesList:', gamesList);
        const weekLabel = currentWeek === 0 ? 'Week 0' : `Current Week: ${currentWeek}`;
        const embed = new EmbedBuilder()
            .setTitle(`Schedule for ${team}`)
            .setDescription(gamesList.length ? gamesList.join("\n") : "No games found.")
            .setFooter({ text: weekLabel })
            .setColor(0x1E90FF);
        await interaction.editReply({ embeds: [embed] });
        console.log('[DEBUG] Sent schedule embed');
    } catch (err) {
        console.error('Error in schedule:', err);
        if (responded) {
            await interaction.editReply({ content: 'Failed to load schedule.' });
        } else {
            await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
        }
    }
}

export default { data, execute, autocomplete };
