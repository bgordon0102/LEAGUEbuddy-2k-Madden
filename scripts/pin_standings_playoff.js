// Run this script once to send and pin the initial standings and playoff picture messages
// Usage: node scripts/pin_standings_playoff.js

import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const TOKEN = process.env.DISCORD_TOKEN;
const STANDINGS_CHANNEL_ID = '1428159168904167535';
const PLAYOFF_CHANNEL_ID = '1428159324341141576';

// --- Standings logic (copied from standings.js) ---
const EAST = [
    'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks', 'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
];
const WEST = [
    'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
];
function getStandings() {
    const TEAMS_FILE = './data/teams.json';
    const SCORES_FILE = './data/scores.json';
    if (!fs.existsSync(TEAMS_FILE) || !fs.existsSync(SCORES_FILE)) return null;
    const teamsArr = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
    const scores = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    const standings = {};
    for (const team of teamsArr) {
        standings[team.name] = { team: team.name, wins: 0, losses: 0, winPct: 0, gb: 0 };
    }
    for (const game of scores) {
        if (!game.approved) continue;
        const { teamA, teamB, scoreA, scoreB } = game;
        if (!standings[teamA] || !standings[teamB]) continue;
        if (scoreA > scoreB) {
            standings[teamA].wins++;
            standings[teamB].losses++;
        } else if (scoreB > scoreA) {
            standings[teamB].wins++;
            standings[teamA].losses++;
        }
    }
    for (const team of teamsArr) {
        const s = standings[team.name];
        const total = s.wins + s.losses;
        s.winPct = total > 0 ? (s.wins / total) : 0;
    }
    function sortConf(conf) {
        const arr = conf.filter(t => standings[t]).map(t => standings[t]);
        arr.sort((a, b) => b.winPct - a.winPct || b.wins - a.wins || a.losses - b.losses || a.team.localeCompare(b.team));
        const leader = arr[0];
        for (const s of arr) {
            s.gb = ((leader.wins - s.wins) + (s.losses - leader.losses)) / 2;
        }
        return arr;
    }
    return {
        east: sortConf(EAST),
        west: sortConf(WEST)
    };
}
function formatRow(s, i) {
    return `**${i + 1}. ${s.team}**  ${s.wins}-${s.losses}  (.${String(Math.round(s.winPct * 1000)).padStart(3, '0')})  GB: ${s.gb === 0 ? '-' : s.gb}`;
}
function getStandingsEmbed() {
    const standings = getStandings();
    if (!standings) return null;
    const eastRows = standings.east.map(formatRow).join('\n');
    const westRows = standings.west.map(formatRow).join('\n');
    return new EmbedBuilder()
        .setTitle('NBA League Standings')
        .addFields(
            { name: 'Eastern Conference', value: eastRows || 'No games played', inline: false },
            { name: 'Western Conference', value: westRows || 'No games played', inline: false }
        )
        .setColor(0x1D428A)
        .setFooter({ text: 'W-L | Win% | Games Behind (GB)' });
}
// --- Playoff picture logic (copied from playoffpicture.js) ---
function getTeamName(arr, idx) {
    return arr[idx] ? arr[idx].team : 'TBD';
}
function playoffMatchups(conf) {
    return [
        `1️⃣ ${getTeamName(conf, 0)} vs 8️⃣ ${getTeamName(conf, 7)}`,
        `2️⃣ ${getTeamName(conf, 1)} vs 7️⃣ ${getTeamName(conf, 6)}`,
        `3️⃣ ${getTeamName(conf, 2)} vs 6️⃣ ${getTeamName(conf, 5)}`,
        `4️⃣ ${getTeamName(conf, 3)} vs 5️⃣ ${getTeamName(conf, 4)}`
    ].join('\n');
}
function playinMatchups(conf) {
    return [
        `7️⃣ ${getTeamName(conf, 6)} vs 🏟️ ${getTeamName(conf, 9)}`,
        `8️⃣ ${getTeamName(conf, 7)} vs 9️⃣ ${getTeamName(conf, 8)}`
    ].join('\n');
}
function getPlayoffEmbeds() {
    const standings = getStandings();
    if (!standings) return [];
    const eastEmbed = new EmbedBuilder()
        .setTitle('🏆 Eastern Conference Playoff Bracket')
        .addFields(
            { name: 'Playoff Matchups', value: playoffMatchups(standings.east), inline: false },
            { name: 'Play-In Matchups', value: playinMatchups(standings.east), inline: false }
        )
        .setColor(0x1D428A)
        .setFooter({ text: 'Top 6: Playoff | 7-10: Play-In' });
    const westEmbed = new EmbedBuilder()
        .setTitle('🏆 Western Conference Playoff Bracket')
        .addFields(
            { name: 'Playoff Matchups', value: playoffMatchups(standings.west), inline: false },
            { name: 'Play-In Matchups', value: playinMatchups(standings.west), inline: false }
        )
        .setColor(0xE03A3E)
        .setFooter({ text: 'Top 6: Playoff | 7-10: Play-In' });
    return [eastEmbed, westEmbed];
}
// --- Main script ---
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
client.once('ready', async () => {
    console.log('Bot is ready. Sending and pinning standings/playoff messages...');
    try {
        const standingsChannel = await client.channels.fetch(STANDINGS_CHANNEL_ID);
        const playoffChannel = await client.channels.fetch(PLAYOFF_CHANNEL_ID);
        // Send and pin standings
        const standingsEmbed = getStandingsEmbed();
        if (standingsEmbed && standingsChannel) {
            const msg = await standingsChannel.send({ embeds: [standingsEmbed] });
            await msg.pin();
            console.log('Standings message sent and pinned.');
        }
        // Send and pin playoff picture
        const playoffEmbeds = getPlayoffEmbeds();
        if (playoffEmbeds.length && playoffChannel) {
            const msg = await playoffChannel.send({ embeds: playoffEmbeds });
            await msg.pin();
            console.log('Playoff picture message sent and pinned.');
        }
    } catch (err) {
        console.error('Error sending/pinning messages:', err);
    }
    client.destroy();
});
client.login(TOKEN);
