import { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { DataManager } from '../../utils/dataManager.js';
// Removed score submitting, pin, welcome, button, modal, OCR, and result logic for rebuild
import fs from 'fs';

export const data = new SlashCommandBuilder()
    .setName('advanceweek')
    .setDescription('Advance the current week by 1, or specify a week to advance to')
    .addIntegerOption(option =>
        option.setName('week')
            .setDescription('The week number to advance to (optional)')
            .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const TOTAL_WEEKS = 29;
// Updated dedicated channel for weekly game threads
const DEDICATED_CHANNEL_ID = '1428417230000885830';

async function sendInitialWelcome(thread) {
    // Extract team names from thread name
    const threadName = thread.name || '';
    const parts = threadName.split(/-vs-/i).map(s => s.replace(/-w\d+|-week\d+/i, '').trim());
    let teamA = parts[0] || 'Team A';
    let teamB = parts[1] || 'Team B';
    // Mention coaches using role IDs from coachRoleMap.json
    let coachRoleMap = {};
    try {
        coachRoleMap = JSON.parse(fs.readFileSync('./data/coachRoleMap.json', 'utf8'));
    } catch (err) { }
    function normalize(name) {
        const teamMap = {
            'Trail Blazers': 'Portland Trail Blazers',
            'Celtics': 'Boston Celtics',
            'Warriors': 'Golden State Warriors',
            'Lakers': 'Los Angeles Lakers',
            'Knicks': 'New York Knicks',
            'Nets': 'Brooklyn Nets',
            'Bulls': 'Chicago Bulls',
            'Heat': 'Miami Heat',
            'Suns': 'Phoenix Suns',
            'Spurs': 'San Antonio Spurs',
            'Raptors': 'Toronto Raptors',
            'Jazz': 'Utah Jazz',
            'Wizards': 'Washington Wizards',
            'Thunder': 'Oklahoma City Thunder',
            'Magic': 'Orlando Magic',
            '76ers': 'Philadelphia 76ers',
            'Pelicans': 'New Orleans Pelicans',
            'Grizzlies': 'Memphis Grizzlies',
            'Mavericks': 'Dallas Mavericks',
            'Cavaliers': 'Cleveland Cavaliers',
            'Pistons': 'Detroit Pistons',
            'Pacers': 'Indiana Pacers',
            'Rockets': 'Houston Rockets',
            'Clippers': 'Los Angeles Clippers',
            'Nuggets': 'Denver Nuggets',
            'Bucks': 'Milwaukee Bucks',
            'Hornets': 'Charlotte Hornets',
            'Kings': 'Sacramento Kings',
            'Hawks': 'Atlanta Hawks',
            'Timberwolves': 'Minnesota Timberwolves',
        };
        if (!name) return null;
        name = name.replace(/[^a-zA-Z ]/g, '').trim();
        return teamMap[name] || name;
    }
    teamA = normalize(teamA);
    teamB = normalize(teamB);
    const mentions = [];
    if (coachRoleMap[teamA]) mentions.push(`<@&${coachRoleMap[teamA]}>`);
    if (coachRoleMap[teamB]) mentions.push(`<@&${coachRoleMap[teamB]}>`);
    const coachMentions = mentions.join(' & ') || `${teamA} Coach & ${teamB} Coach`;
    const welcomeMsg = `Welcome ${coachMentions}!
One coach please set the game info to start your game.`;
    // Create Set Game Info button
    const setGameInfoButton = new ButtonBuilder()
        .setCustomId('set_game_info')
        .setLabel('Set Game Info')
        .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(setGameInfoButton);
    // Debug logging
    console.log(`[sendInitialWelcome] Attempting to send welcome message to thread: ${threadName}`);
    try {
        const sentMsg = await thread.send({ content: welcomeMsg, components: [row] });
        console.log(`[sendInitialWelcome] Message sent to thread: ${threadName}, messageId: ${sentMsg.id}`);
        await sentMsg.pin();
        console.log(`[sendInitialWelcome] Message pinned in thread: ${threadName}`);
    } catch (err) {
        console.error('[sendInitialWelcome] Failed to send or pin welcome message:', err);
    }
}

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const dataManager = new DataManager();
    let season = dataManager.readData('season') || { currentWeek: 1, seasonNo: 1 };
    let weekNum = interaction.options.getInteger('week');
    if (!weekNum) weekNum = (season.currentWeek || 1) + 1;
    if (weekNum < 1 || weekNum > TOTAL_WEEKS) {
        await interaction.editReply({ content: `Invalid week number. Must be between 1 and ${TOTAL_WEEKS}.` });
        return;
    }
    let schedule = dataManager.readData('schedule') || [];
    const matchups = schedule[weekNum] || [];
    const guild = interaction.guild;
    // Try to fetch the dedicated channel (use fetch to ensure latest and handle uncached channels)
    let dedicatedChannel = null;
    try {
        dedicatedChannel = await guild.channels.fetch(DEDICATED_CHANNEL_ID);
    } catch (err) {
        console.error('[advanceweek] Failed to fetch dedicated channel:', err);
    }
    if (!dedicatedChannel) {
        await interaction.editReply({ content: `❌ Dedicated channel not found or bot lacks access. Check DISCORD_GUILD_ID, DEDICATED_CHANNEL_ID, and bot permissions.` });
        return;
    }
    // Ensure channel supports threads
    if (typeof dedicatedChannel.isTextBased === 'function' && !dedicatedChannel.isTextBased()) {
        await interaction.editReply({ content: '❌ Dedicated channel must be a text channel that supports threads.' });
        return;
    }
    let createdThreads = [];
    // Load gameInfo.json once
    let gameInfo = {};
    try {
        gameInfo = JSON.parse(fs.readFileSync('./data/gameInfo.json', 'utf8'));
    } catch (err) { gameInfo = {}; }
    for (const matchup of matchups) {
        // Use short team names for thread names to match coach role naming
        const team1Short = matchup.team1.name.replace('Milwaukee ', '').replace('Portland ', '').replace('Los Angeles ', '').replace('Golden State ', '').replace('New York ', '').replace('San Antonio ', '').replace('Oklahoma City ', '').replace('Charlotte ', '').replace('Philadelphia ', '').replace('Minnesota ', '').replace('Cleveland ', '').replace('Indiana ', '').replace('Sacramento ', '').replace('Toronto ', '').replace('New Orleans ', '').replace('Washington ', '').replace('Atlanta ', '').replace('Brooklyn ', '').replace('Chicago ', '').replace('Dallas ', '').replace('Denver ', '').replace('Detroit ', '').replace('Houston ', '').replace('LA ', '').replace('Memphis ', '').replace('Miami ', '').replace('Orlando ', '').replace('Phoenix ', '').replace('Utah ', '').replace('Boston ', '').replace('Clippers', 'Clippers').replace('Lakers', 'Lakers').replace('Trail Blazers', 'Trail Blazers').replace('Thunder', 'Thunder').replace('Spurs', 'Spurs').replace('Jazz', 'Jazz').replace('Wizards', 'Wizards').replace('Raptors', 'Raptors').replace('Kings', 'Kings').replace('Suns', 'Suns').replace('Magic', 'Magic').replace('Heat', 'Heat').replace('Grizzlies', 'Grizzlies').replace('Bucks', 'Bucks').replace('Mavericks', 'Mavericks').replace('Nuggets', 'Nuggets').replace('Pistons', 'Pistons').replace('Rockets', 'Rockets').replace('Pacers', 'Pacers').replace('Cavaliers', 'Cavaliers').replace('Timberwolves', 'Timberwolves').replace('76ers', '76ers').replace('Hornets', 'Hornets').replace('Bulls', 'Bulls').replace('Nets', 'Nets').replace('Hawks', 'Hawks').replace('Celtics', 'Celtics');
        const team2Short = matchup.team2.name.replace('Milwaukee ', '').replace('Portland ', '').replace('Los Angeles ', '').replace('Golden State ', '').replace('New York ', '').replace('San Antonio ', '').replace('Oklahoma City ', '').replace('Charlotte ', '').replace('Philadelphia ', '').replace('Minnesota ', '').replace('Cleveland ', '').replace('Indiana ', '').replace('Sacramento ', '').replace('Toronto ', '').replace('New Orleans ', '').replace('Washington ', '').replace('Atlanta ', '').replace('Brooklyn ', '').replace('Chicago ', '').replace('Dallas ', '').replace('Denver ', '').replace('Detroit ', '').replace('Houston ', '').replace('LA ', '').replace('Memphis ', '').replace('Miami ', '').replace('Orlando ', '').replace('Phoenix ', '').replace('Utah ', '').replace('Boston ', '').replace('Clippers', 'Clippers').replace('Lakers', 'Lakers').replace('Trail Blazers', 'Trail Blazers').replace('Thunder', 'Thunder').replace('Spurs', 'Spurs').replace('Jazz', 'Jazz').replace('Wizards', 'Wizards').replace('Raptors', 'Raptors').replace('Kings', 'Kings').replace('Suns', 'Suns').replace('Magic', 'Magic').replace('Heat', 'Heat').replace('Grizzlies', 'Grizzlies').replace('Bucks', 'Bucks').replace('Mavericks', 'Mavericks').replace('Nuggets', 'Nuggets').replace('Pistons', 'Pistons').replace('Rockets', 'Rockets').replace('Pacers', 'Pacers').replace('Cavaliers', 'Cavaliers').replace('Timberwolves', 'Timberwolves').replace('76ers', '76ers').replace('Hornets', 'Hornets').replace('Bulls', 'Bulls').replace('Nets', 'Nets').replace('Hawks', 'Hawks').replace('Celtics', 'Celtics');
        const threadName = `${team1Short}-vs-${team2Short}-w${weekNum}`;
        try {
            const thread = await dedicatedChannel.threads.create({
                name: threadName,
                autoArchiveDuration: 1440,
                reason: `Game thread for ${threadName} (Week ${weekNum})`
            });
            createdThreads.push(threadName);
            await sendInitialWelcome(thread);
        } catch (err) {
            console.error(`[advanceweek] Error creating thread:`, err);
        }
    }
    season.currentWeek = weekNum;
    const writeSuccess = dataManager.writeData('season', season);
    if (writeSuccess) {
        console.log(`[advanceweek] Successfully wrote currentWeek=${weekNum} to season.json`);
    } else {
        console.error(`[advanceweek] FAILED to write currentWeek=${weekNum} to season.json`);
    }
    // After advancing week, update standings
    // Run standingsManager.cjs as a child process to update standings (ESM compatible)
    const child_process = await import('child_process');
    child_process.exec('node scripts/standingsManager.cjs', (error, stdout, stderr) => {
        if (error) {
            console.error('[advanceweek] Failed to update standings:', error);
            interaction.editReply({ content: `Week advanced! Current week is now ${season.currentWeek}. Created ${createdThreads.length}/${matchups.length} threads in the dedicated channel. (Standings update failed)` });
            return;
        }
        console.log('[advanceweek] Standings update output:', stdout);
        interaction.editReply({ content: `Week advanced! Current week is now ${season.currentWeek}. Created ${createdThreads.length}/${matchups.length} threads in the dedicated channel. Standings updated.` });
    });
}

export default { data, execute };
