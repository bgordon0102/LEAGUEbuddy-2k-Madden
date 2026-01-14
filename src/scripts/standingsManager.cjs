// scripts/standingsManager.js
// Usage: node scripts/standingsManager.js
// This script recalculates standings, prints a debug summary, and updates the Discord standings pin message.

require('dotenv').config();
const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const SCORES_FILE = './data/scores.json';
const ROSTERS_DIR = './data/teams_rosters';
const STANDINGS_CHANNEL_ID = '1428159168904167535'; // <-- Provided channel ID
const STANDINGS_PINNED_MESSAGE_ID = '1429648846610497556'; // <-- Your provided message ID
const BOT_TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // <-- Set your bot token in .env or environment

function readScores() {
    if (!fs.existsSync(SCORES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
}
function readTeams() {
    if (!fs.existsSync(ROSTERS_DIR)) return [];
    return fs.readdirSync(ROSTERS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f.replace('.json', '').replace(/_/g, ' ') }));
}

function calculateStandings() {
    const teams = readTeams();
    const scores = readScores().filter(s => s.approved && s.teamA && s.teamB && s.week);
    // Debug: Print all games involving Hornets before deduplication
    const hornetsGames = scores.filter(s => {
        const teamA = s.teamA.trim().toUpperCase();
        const teamB = s.teamB.trim().toUpperCase();
        return teamA.includes('HORNETS') || teamB.includes('HORNETS');
    });
    if (hornetsGames.length > 0) {
        console.log('Hornets games before deduplication:');
        hornetsGames.forEach(g => {
            console.log(`Week ${g.week}: ${g.teamA} (${g.scoreA}) vs ${g.teamB} (${g.scoreB})`);
        });
    }
    // Deduplicate by [week, canonical teamA, canonical teamB] sorted
    const uniqueScoresMap = new Map();
    for (const s of scores) {
        const teamA = matchTeam(s.teamA);
        const teamB = matchTeam(s.teamB);
        const teamsSorted = [teamA, teamB].sort();
        const key = `${s.week}|${teamsSorted[0]}|${teamsSorted[1]}`;
        if (!uniqueScoresMap.has(key)) {
            uniqueScoresMap.set(key, s);
        }
    }
    const uniqueScores = Array.from(uniqueScoresMap.values());
    // Initialize standings
    const standings = {};
    for (const team of teams) {
        standings[team.name] = {
            wins: 0,
            losses: 0,
            games: 0,
            pointsFor: 0,
            pointsAgainst: 0
        };
    }
    // Helper to match team names robustly
    function matchTeam(name) {
        name = name.trim().toUpperCase();
        const altMap = {
            'TRAIL BLAZERS': 'PORTLAND TRAIL BLAZERS',
            'SUNS': 'PHOENIX SUNS',
            // Add more mappings as needed
        };
        if (altMap[name]) {
            // Return the full team name from /teams_rosters/
            const mapped = teams.find(t => t.name.trim().toUpperCase() === altMap[name]);
            return mapped ? mapped.name : null;
        }
        for (const team of teams) {
            const fullName = team.name.trim().toUpperCase();
            const mascot = fullName.split(' ').pop();
            if (name === fullName || name === mascot) {
                return team.name;
            }
        }
        return null;
    }
    // Calculate standings
    for (const s of uniqueScores) {
        const teamA = matchTeam(s.teamA);
        const teamB = matchTeam(s.teamB);
        if (!standings[teamA] || !standings[teamB]) continue;
        if (teamA === 'Charlotte Hornets' || teamB === 'Charlotte Hornets') {
            console.log(`[DEBUG] Processing Hornets game: teamA=${teamA}, teamB=${teamB}, scoreA=${s.scoreA}, scoreB=${s.scoreB}`);
        }
        standings[teamA].games++;
        standings[teamB].games++;
        standings[teamA].pointsFor += Number(s.scoreA);
        standings[teamA].pointsAgainst += Number(s.scoreB);
        standings[teamB].pointsFor += Number(s.scoreB);
        standings[teamB].pointsAgainst += Number(s.scoreA);
        if (Number(s.scoreA) > Number(s.scoreB)) {
            standings[teamA].wins++;
            standings[teamB].losses++;
            if (teamA === 'Charlotte Hornets' || teamB === 'Charlotte Hornets') {
                console.log(`[DEBUG] Hornets result: ${teamA === 'Charlotte Hornets' ? 'W/L' : 'L/W'}`);
            }
        } else if (Number(s.scoreB) > Number(s.scoreA)) {
            standings[teamB].wins++;
            standings[teamA].losses++;
            if (teamA === 'Charlotte Hornets' || teamB === 'Charlotte Hornets') {
                console.log(`[DEBUG] Hornets result: ${teamA === 'Charlotte Hornets' ? 'L/W' : 'W/L'}`);
            }
        }
    }
    return standings;
}

function getEastWestTeams() {
    // Team names from /teams_rosters/ (static order for NBA)
    return {
        east: [
            'Atlanta Hawks',
            'Boston Celtics',
            'Brooklyn Nets',
            'Charlotte Hornets',
            'Chicago Bulls',
            'Cleveland Cavaliers',
            'Detroit Pistons',
            'Indiana Pacers',
            'Miami Heat',
            'Milwaukee Bucks',
            'New York Knicks',
            'Orlando Magic',
            'Philadelphia 76ers',
            'Toronto Raptors',
            'Washington Wizards'
        ],
        west: [
            'Dallas Mavericks',
            'Denver Nuggets',
            'Golden State Warriors',
            'Houston Rockets',
            'Los Angeles Clippers',
            'Los Angeles Lakers',
            'Memphis Grizzlies',
            'Minnesota Timberwolves',
            'New Orleans Pelicans',
            'Oklahoma City Thunder',
            'Phoenix Suns',
            'Portland Trail Blazers',
            'Sacramento Kings',
            'San Antonio Spurs',
            'Utah Jazz'
        ]
    };
}

function formatRow(team, s, i) {
    const winPct = s.games > 0 ? s.wins / s.games : 0;
    return `**${i + 1}. ${team}**  ${s.wins}-${s.losses}  (.${String(Math.round(winPct * 1000)).padStart(3, '0')})`;
}

function printStandings(standings) {
    for (const [team, s] of Object.entries(standings)) {
        const winPct = s.games > 0 ? s.wins / s.games : 0;
        console.log(`${team}: ${s.wins}-${s.losses} (${winPct.toFixed(3)}) Games: ${s.games}`);
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    const standings = calculateStandings();
    printStandings(standings); // Debug output
    const { east, west } = getEastWestTeams();
    const eastSorted = east.map(t => ({ team: t, ...standings[t] })).sort((a, b) => b.wins - a.wins || (b.wins / b.games) - (a.wins / a.games));
    const westSorted = west.map(t => ({ team: t, ...standings[t] })).sort((a, b) => b.wins - a.wins || (b.wins / b.games) - (a.wins / a.games));
    const eastRows = eastSorted.map((s, i) => formatRow(s.team, s, i)).join('\n');
    const westRows = westSorted.map((s, i) => formatRow(s.team, s, i)).join('\n');
    const standingsEmbed = new EmbedBuilder()
        .setTitle('NBA League Standings')
        .addFields(
            { name: 'Eastern Conference', value: eastRows || 'No games played', inline: false },
            { name: 'Western Conference', value: westRows || 'No games played', inline: false }
        )
        .setColor(0x1D428A)
        .setFooter({ text: 'W-L | Win%' });

    const channel = await client.channels.fetch(STANDINGS_CHANNEL_ID);
    const pinnedMsg = await channel.messages.fetch(STANDINGS_PINNED_MESSAGE_ID);
    await pinnedMsg.edit({ embeds: [standingsEmbed] });
    console.log('Standings pin updated!');
    process.exit(0);
});

client.login(BOT_TOKEN);
