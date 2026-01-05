// Script to generate the initial standings pin in your standings channel
// Usage: node scripts/generateStandingsPin.js

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.STANDINGS_CHANNEL_ID || '1428159168904167535'; // Set your channel ID here

if (!TOKEN) {
    console.error('DISCORD_BOT_TOKEN not set in .env');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    try {
        const channel = await client.channels.fetch(CHANNEL_ID);
        if (!channel) throw new Error('Channel not found');
        // Read standings
        const standings = JSON.parse(fs.readFileSync('./data/standings.json', 'utf8'));
        const eastTeams = [
            'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls', 'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks', 'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
        ];
        const westTeams = [
            'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
        ];
        function formatRow(team, s, i) {
            const winPct = s.games > 0 ? s.wins / s.games : 0;
            return `**${i + 1}. ${team}**  ${s.wins}-${s.losses}  (.${String(Math.round(winPct * 1000)).padStart(3, '0')})`;
        }
        const eastSorted = eastTeams.map(t => ({ team: t, ...standings[t] })).sort((a, b) => b.wins - a.wins || (b.wins / b.games) - (a.wins / a.games));
        const westSorted = westTeams.map(t => ({ team: t, ...standings[t] })).sort((a, b) => b.wins - a.wins || (b.wins / b.games) - (a.wins / a.games));
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
        const sentMsg = await channel.send({ embeds: [standingsEmbed] });
        await sentMsg.pin();
        console.log('Standings pin created! Message ID:', sentMsg.id);
        process.exit(0);
    } catch (err) {
        console.error('Failed to create standings pin:', err);
        process.exit(1);
    }
});

client.login(TOKEN);
