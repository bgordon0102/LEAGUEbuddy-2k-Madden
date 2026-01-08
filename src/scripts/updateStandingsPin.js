// scripts/updateStandingsPin.js
// Usage: node scripts/updateStandingsPin.js
// This script recalculates standings and updates the standings pin message in Discord.

const fs = require('fs');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const SCORES_FILE = './data/scores.json';
const TEAMS_FILE = './data/teams.json';
const STANDINGS_CHANNEL_ID = 'YOUR_STANDINGS_CHANNEL_ID'; // <-- Replace with your channel ID
const STANDINGS_PINNED_MESSAGE_ID = '1429648846610497556'; // <-- Your provided message ID
const BOT_TOKEN = 'YOUR_BOT_TOKEN'; // <-- Replace with your bot token

function readScores() {
    if (!fs.existsSync(SCORES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
}
function readTeams() {
    if (!fs.existsSync(TEAMS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
}

function calculateStandings() {
    const teams = readTeams();
    const scores = readScores().filter(s => s.approved && s.teamA && s.teamB && s.week);
    // Deduplicate by [week, teamA, teamB] sorted
    const uniqueScoresMap = new Map();
    for (const s of scores) {
        const teamsSorted = [s.teamA.trim().toUpperCase(), s.teamB.trim().toUpperCase()].sort();
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
    // Helper to match team names flexibly
    function matchTeam(name) {
        name = name.trim().toUpperCase();
        for (const team of teams) {
            if (team.name.toUpperCase() === name || team.abbreviation === name || team.name.toUpperCase().includes(name)) {
                return team.name;
            }
        }
        return name;
    }
    // Calculate standings
    for (const s of uniqueScores) {
        const teamA = matchTeam(s.teamA);
        const teamB = matchTeam(s.teamB);
        if (!standings[teamA] || !standings[teamB]) continue;
        standings[teamA].games++;
        standings[teamB].games++;
        standings[teamA].pointsFor += Number(s.scoreA);
        standings[teamA].pointsAgainst += Number(s.scoreB);
        standings[teamB].pointsFor += Number(s.scoreB);
        standings[teamB].pointsAgainst += Number(s.scoreA);
        if (Number(s.scoreA) > Number(s.scoreB)) {
            standings[teamA].wins++;
            standings[teamB].losses++;
        } else if (Number(s.scoreB) > Number(s.scoreA)) {
            standings[teamB].wins++;
            standings[teamA].losses++;
        }
    }
    return standings;
}

function getEastWestTeams() {
    // Fill in with your actual team names
    return {
        east: [
            'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks', 'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
        ],
        west: [
            'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
        ]
    };
}

function formatRow(team, s, i) {
    const winPct = s.games > 0 ? s.wins / s.games : 0;
    return `**${i + 1}. ${team}**  ${s.wins}-${s.losses}  (.${String(Math.round(winPct * 1000)).padStart(3, '0')})`;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    const standings = calculateStandings();
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
