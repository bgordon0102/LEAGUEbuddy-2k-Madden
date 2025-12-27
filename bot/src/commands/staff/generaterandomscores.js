import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const data = new SlashCommandBuilder()
    .setName('generaterandomscores')
    .setDescription('Generate random approved scores for all games up to a given week')
    .addIntegerOption(option =>
        option.setName('week')
            .setDescription('Generate scores for all games up to this week (inclusive)')
            .setRequired(true)
    );



function writeJSON(file, data) {
    try {
        if (typeof data === 'undefined') {
            console.error(`[writeJSON] Tried to write undefined data to ${file}`);
            return;
        }
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`[writeJSON] Failed to write to ${file}:`, err);
    }
}

function safeReadJSON(file, fallback) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        if (!data) throw new Error('Empty file');
        return JSON.parse(data);
    } catch (err) {
        console.warn(`[generaterandomscores] File ${file} missing or invalid (${err.message}), using fallback.`);
        writeJSON(file, fallback);
        return fallback;
    }
}

function getRandomScore() {
    // NBA-like scores
    return [
        Math.floor(Math.random() * 41) + 90, // 90-130
        Math.floor(Math.random() * 41) + 90
    ];
}

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        const week = interaction.options.getInteger('week');
        // Use absolute paths from project root
        const baseDir = path.resolve(__dirname, '../../../');
        const schedulePath = path.join(baseDir, 'data/schedule.json');
        const standingsPath = path.join(baseDir, 'data/standings.json');
        const playoffPath = path.join(baseDir, 'data/playoffpicture.json');
        const seasonPath = path.join(baseDir, 'data/season.json');

        // schedule.json is expected to be an array of arrays: [ [], [week1games], [week2games], ... ]
        // Index 0 is week 0 (no games), index 1 is week 1, etc.
        let schedule = safeReadJSON(schedulePath, null);
        if (!Array.isArray(schedule) || schedule.length < 2) {
            await interaction.editReply({ content: `❌ No schedule found. Please ensure schedule.json is an array of arrays, with index 0 as week 0 (empty), index 1 as week 1, etc.`, ephemeral: true });
            return;
        }
        let standings = safeReadJSON(standingsPath, {});
        let playoff = safeReadJSON(playoffPath, {});
        // Also update scores.json for standings/playoffpicture compatibility
        const scoresPath = path.join(baseDir, 'data/scores.json');
        let scores = safeReadJSON(scoresPath, []);
        // Self-healing: Remove any games from scores.json with week 0 (string or number)
        scores = scores.filter(g => g.week !== '0' && g.week !== 0);
        // Load season.json for seasonNo
        let season = safeReadJSON(seasonPath, {});

        let gamesSimmed = 0;
        for (let w = 1; w <= week; w++) {
            // week 0 (index 0) is always skipped
            if (!Array.isArray(schedule[w])) continue;
            for (const game of schedule[w]) {
                if (!game || game.approved) continue; // skip already approved or invalid
                // Support both object and string team fields for legacy compatibility
                const team1 = typeof game.team1 === 'object' ? game.team1.name || game.team1.abbreviation : game.team1;
                const team2 = typeof game.team2 === 'object' ? game.team2.name || game.team2.abbreviation : game.team2;
                if (!team1 || !team2) {
                    console.warn(`[generaterandomscores] Skipping game with missing teams in week ${w}`);
                    continue;
                }
                const [score1, score2] = getRandomScore();
                game.score1 = score1;
                game.score2 = score2;
                game.approved = true;
                // Update standings (win/loss, games, points)
                if (!standings[team1]) standings[team1] = { wins: 0, losses: 0, games: 0, pointsFor: 0, pointsAgainst: 0 };
                if (!standings[team2]) standings[team2] = { wins: 0, losses: 0, games: 0, pointsFor: 0, pointsAgainst: 0 };
                standings[team1].games++;
                standings[team2].games++;
                standings[team1].pointsFor += score1;
                standings[team1].pointsAgainst += score2;
                standings[team2].pointsFor += score2;
                standings[team2].pointsAgainst += score1;
                let result = '';
                if (score1 > score2) {
                    standings[team1].wins++;
                    standings[team2].losses++;
                    result = `${team1} def. ${team2}`;
                } else if (score2 > score1) {
                    standings[team2].wins++;
                    standings[team1].losses++;
                    result = `${team2} def. ${team1}`;
                } else {
                    // No ties in basketball: randomly pick a winner
                    if (Math.random() < 0.5) {
                        standings[team1].wins++;
                        standings[team2].losses++;
                        result = `${team1} (OT) def. ${team2}`;
                    } else {
                        standings[team2].wins++;
                        standings[team1].losses++;
                        result = `${team2} (OT) def. ${team1}`;
                    }
                }
                // Log all relevant info for debugging
                console.log(`[generaterandomscores] Week ${w}: ${result} | ${score1}-${score2}`);
                console.log(`[generaterandomscores] Updated standings:`);
                console.log(`  ${team1}:`, standings[team1]);
                console.log(`  ${team2}:`, standings[team2]);
                // Add to scores.json in the same format as real games
                scores.push({
                    teamA: team1,
                    scoreA: score1,
                    teamB: team2,
                    scoreB: score2,
                    week: w.toString(),
                    seasonNo: (season?.seasonNo || 1).toString(),
                    submittedBy: 'sim',
                    approved: true,
                    approvedBy: 'sim',
                    approvedAt: new Date().toISOString()
                });
                gamesSimmed++;
            }
        }
        writeJSON(schedulePath, schedule); // Always write as array-of-arrays
        writeJSON(standingsPath, standings);
        // Self-healing: Remove any games from scores before writing, just in case
        scores = scores.filter(g => g.week !== '0' && g.week !== 0);
        writeJSON(scoresPath, scores);
        // Optionally update playoff picture here if needed
        if (gamesSimmed === 0) {
            await interaction.editReply({ content: `No games were simulated. All games may already be approved, or schedule is empty up to week ${week}.`, ephemeral: true });
        } else {
            await interaction.editReply({ content: `Simulated and approved ${gamesSimmed} games up to week ${week}.`, ephemeral: true });
        }
    } catch (err) {
        console.error('Error in generaterandomscores:', err);
        await interaction.editReply({ content: 'Error simulating scores.' });
    }
}

export default { data, execute };
