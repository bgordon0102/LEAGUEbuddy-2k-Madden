// commands/schedule.js
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";


export const data = new SlashCommandBuilder()
    .setName("2k-schedule")
    .setDescription("Show a team's NBA season schedule")
    .addStringOption((option) =>
        option
            .setName("team")
            .setDescription("The NBA team to view the schedule for")
            .setRequired(true)
            .setAutocomplete(true)
    );
async function autocomplete(interaction) {
    let responded = false;
    // Set a timeout to always respond within 1900ms
    const timeout = setTimeout(async () => {
        if (!responded) {
            responded = true;
            try { await interaction.respond([]); } catch { }
        }
    }, 1900);
    try {
        const focusedValue = interaction.options.getFocused();
        // Read team names from /teams_rosters/
        const rostersDir = path.join(process.cwd(), "teams_rosters");
        let teams = [];
        if (fs.existsSync(rostersDir)) {
            teams = fs.readdirSync(rostersDir)
                .filter(f => f.endsWith('.json'))
                .map(f => f.replace('.json', '').replace(/_/g, ' '))
                .sort((a, b) => a.localeCompare(b));
        }
        let filtered;
        if (!focusedValue) {
            filtered = teams;
        } else {
            filtered = teams.filter(name => name.toLowerCase().includes(focusedValue.toLowerCase()));
        }
        if (!responded) {
            responded = true;
            clearTimeout(timeout);
            await interaction.respond(
                filtered.map(name => ({ name, value: name })).slice(0, 25)
            );
        }
        return;
    } catch (err) {
        console.error('[autocomplete] Fatal error:', err);
        if (!responded) {
            responded = true;
            clearTimeout(timeout);
            try { await interaction.respond([]); } catch { }
        }
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
        const rostersDir = path.join(process.cwd(), "teams_rosters");
        const schedulePath = path.join(process.cwd(), "data/schedule.json");
        const seasonPath = path.join(process.cwd(), "data/season.json");
        if (!fs.existsSync(rostersDir) || !fs.existsSync(schedulePath) || !fs.existsSync(seasonPath)) {
            await interaction.editReply({
                content: "No season data found. Please run `/startseason` first."
            });
            return;
        }
        const teams = fs.readdirSync(rostersDir)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', '').replace(/_/g, ' '));
        const schedule = JSON.parse(fs.readFileSync(schedulePath, "utf8"));
        const seasonData = JSON.parse(fs.readFileSync(seasonPath, "utf8"));
        const currentWeek = seasonData.currentWeek;
        let week = 1;
        let gamesList = [];
        if (!teams.includes(team)) {
            await interaction.editReply({ content: `Team not found: ${team}` });
            return;
        }
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
        const weekLabel = currentWeek === 0 ? 'Week 0' : `Current Week: ${currentWeek}`;
        const embed = new EmbedBuilder()
            .setTitle(`Schedule for ${team}`)
            .setDescription(gamesList.length ? gamesList.join("\n") : "No games found.")
            .setFooter({ text: weekLabel })
            .setColor(0x1E90FF);
        await interaction.editReply({ embeds: [embed] });
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
