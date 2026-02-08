// Handle submit score button interaction
import path from 'path';
import fs from 'fs';

const scoresPath = path.join(process.cwd(), 'data', 'scores.json');
const standingsPath = path.join(process.cwd(), 'data', 'standings.json');

function readJson(file) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
}
function writeJson(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Handle submit score button interaction
export async function handleSubmitScore(interaction, winner, loser, winnerScore, loserScore) {
    const scores = Array.isArray(readJson(scoresPath)) ? readJson(scoresPath) : [];
    scores.push({
        winner,
        loser,
        winnerScore,
        loserScore,
        submittedBy: interaction.user.id,
        status: 'pending',
        timestamp: Date.now()
    });
    writeJson(scoresPath, scores);
    await interaction.reply({
        content: `Score submitted: ${winner} ${winnerScore} - ${loser} ${loserScore}. Awaiting approval.`,
        components: [
            {
                type: 1,
                components: [
                    { type: 2, style: 3, label: 'Approve', custom_id: 'approve_score' },
                    { type: 2, style: 4, label: 'Deny', custom_id: 'deny_score' }
                ]
            }
        ]
    });
}

// Handler for Approve button
export async function handleApproveScore(interaction, scoreIndex) {
    const scores = Array.isArray(readJson(scoresPath)) ? readJson(scoresPath) : [];
    const standings = readJson(standingsPath);
    const score = scores[scoreIndex];
    if (!score || score.status !== 'pending') return interaction.reply({ content: 'Score not found or already processed.', ephemeral: true });

    // Update standings
    standings[score.winner].wins += 1;
    standings[score.winner].games += 1;
    standings[score.winner].pointsFor += score.winnerScore;
    standings[score.winner].pointsAgainst += score.loserScore;

    standings[score.loser].losses += 1;
    standings[score.loser].games += 1;
    standings[score.loser].pointsFor += score.loserScore;
    standings[score.loser].pointsAgainst += score.winnerScore;

    score.status = 'approved';
    writeJson(scoresPath, scores);
    writeJson(standingsPath, standings);

    await interaction.update({ content: 'Score approved and standings updated.', components: [] });
}

// Handler for Deny button
export async function handleDenyScore(interaction, scoreIndex) {
    const scores = Array.isArray(readJson(scoresPath)) ? readJson(scoresPath) : [];
    const score = scores[scoreIndex];
    if (!score || score.status !== 'pending') return interaction.reply({ content: 'Score not found or already processed.', ephemeral: true });

    score.status = 'denied';
    writeJson(scoresPath, scores);

    await interaction.update({ content: 'Score denied. Please resubmit if needed.', components: [] });
}
export const customId_submit_team_comparison = 'submit_team_comparison';
export const customId_modal_set_game_info = 'modal_set_game_info';
export async function execute_modal_set_game_info(interaction) {
    await handleSetGameInfoModal(interaction);
}

// Utility: Normalize team names to full names
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
function normalize(name) {
    if (!name) return null;
    name = name.replace(/[^a-zA-Z ]/g, '').trim();
    return teamMap[name] || name;
}
import { DataManager } from '../utils/dataManager.js';
import { ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import Tesseract from 'tesseract.js';
import https from 'https';

// Track threads awaiting score uploads; exported so app.js can check membership
export const pendingScoreThreads = new Set();

function markThreadPendingScore(threadId) {
    pendingScoreThreads.add(threadId);
}

// Handle Set Game Info button (shows modal)
async function handleSetGameInfo(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('modal_set_game_info')
        .setTitle('Set Game Info')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('2k_date')
                    .setLabel('2K In-Game Date')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

// Handle Set Game Info modal submit (moved to top-level)
async function handleSetGameInfoModal(interaction) {
    const date = interaction.fields.getTextInputValue('2k_date');
    const threadName = interaction.channel.name || '';
    const parts = threadName.split(/-vs-/i).map(s => s.replace(/-w\d+|-week\d+/i, '').trim());
    let teamA = normalize(parts[0] || 'Team A');
    let teamB = normalize(parts[1] || 'Team B');
    let coachRoleMap = {};
    try {
        coachRoleMap = JSON.parse(fs.readFileSync('./data/coachRoleMap.json', 'utf8'));
    } catch (err) { }
    const mentions = [];
    if (coachRoleMap[teamA]) mentions.push(`<@&${coachRoleMap[teamA]}>`);
    if (coachRoleMap[teamB]) mentions.push(`<@&${coachRoleMap[teamB]}>`);
    const coachMentions = mentions.join(' & ') || `${teamA} Coach & ${teamB} Coach`;
    let content = `**Game Info: ${date}**\nWelcome ${coachMentions}!\nPlease coordinate your matchup here. Each coach must submit their own Box Score image for stat tracking.\n\n:warning: **Box Score Submission Instructions:**\n1. After your game, exit and go to your game on the calendar.\n2. Select the game on the calendar and hit 'View Box Score'.\n3. Each coach: Take a clear picture of your team's Box Score page.\n4. Winning coach: Take a clear picture of the Team Comparison page.\n5. Use your phone's gallery settings to convert all images to mono filter (grayscale photo). This is the only way for the bot to pick up the info correctly.\n6. Press your team's submit button below to send your Box Score image.\n7. Winning coach: Press the Team Comparison button below and upload the Team Comparison image.\n8. The bot will read the images and process your stats automatically.\n\n**Note:** Both Box Score images and the Team Comparison image are required for a valid submission.`;
    let components = [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('submit_score')
                .setLabel('Submit Score')
                .setStyle(ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('approve_score')
                .setLabel('Approve')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('deny_score')
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger)
        )
    ];
    const pins = await interaction.channel.messages.fetchPinned();
    const botPin = pins.find(m => m.author.id === interaction.client.user.id);
    if (botPin) await botPin.edit({ content, components });
    await interaction.reply({ content: 'Game info set!', ephemeral: true });
}

// ...existing code for other handlers...

// Stub: handleBoxScoreImage
// Box score image logic removed for new workflow

// Stub: handleTeamComparisonImage
// Team comparison image logic removed for new workflow

// ...existing code for exports...
export const customId_set_game_info = 'set_game_info';
export async function execute_set_game_info(interaction) {
    await handleSetGameInfo(interaction);
}
export {
    markThreadPendingScore,
    handleSetGameInfo,
    handleSetGameInfoModal,
};
