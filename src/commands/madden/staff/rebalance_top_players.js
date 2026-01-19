// Command: /madden staff rebalance_top_players
// Usage: Run this command to re-band all grades for the most recent week using only the saved data in top_players.json

import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const FILE = path.join(process.cwd(), 'data', 'madden', 'top_players.json');


export const data = new SlashCommandBuilder()
    .setName('balanceplayergrades')
    .setDescription('Re-band all player grades for the most recent week using only saved data. (Staff only)');

export async function execute(interaction) {
    if (!interaction.member.roles.cache.some(r => r.name.toLowerCase().includes('staff'))) {
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: 64 });
        return;
    }
    let data;
    try {
        data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
        await interaction.reply({ content: 'Could not read top_players.json.', flags: 64 });
        return;
    }
    const leagueId = Object.keys(data)[0];
    const weekly = data[leagueId].weekly;
    const mostRecent = weekly.reduce((a, b) => (Number(a.week) > Number(b.week) ? a : b));
    const players = mostRecent.players.slice();
    players.sort((a, b) => (b.score || 0) - (a.score || 0));
    const bands = [
        { min: 97.0, max: 99.9, count: 1 },
        { min: 95.0, max: 96.9, count: 3 },
        { min: 90.0, max: 94.9, count: 8 },
        { min: 85.1, max: 89.9, count: 18 },
        { min: 80.0, max: 85.0, count: 23 },
        { min: 79.0, max: 79.9, count: 16 },
        { min: 78.0, max: 78.9, count: 17 },
        { min: 77.0, max: 77.9, count: 20 },
        { min: 76.0, max: 76.9, count: 30 }
    ];
    let idx = 0;
    bands.forEach(band => {
        const step = (band.max - band.min) / Math.max(1, band.count - 1);
        for (let i = 0; i < band.count && idx < players.length; i++, idx++) {
            players[idx].grade = Number((band.min + step * i).toFixed(2));
        }
    });
    for (; idx < players.length; idx++) {
        players[idx].grade = 40.0;
    }
    mostRecent.players = players;
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    await interaction.reply({ content: 'Rebanded grades for the most recent week.', flags: 64 });
}
