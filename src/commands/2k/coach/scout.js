import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getSeasonState } from '../../utils/seasonUtils.js';

export const data = new SlashCommandBuilder()
    .setName('2k-scout')
    .setDescription('Scout a player from the current big board');

export async function execute(interaction) {
    console.log(`[SCOUT EXECUTE] Called by user: ${interaction.user?.tag || interaction.user?.id}, interactionId: ${interaction.id}, createdAt: ${interaction.createdAt}`);
    const userId = interaction.user.id;
    let deferred = false;

    try {
        await interaction.deferReply({ flags: 64 });
        deferred = true;
    } catch (err) {
        console.error('Failed to defer reply in /scout:', err?.message || err);
        // If we can't defer, the interaction is expired or invalid; do not continue
        return;
    }
    try {
        const seasonState = getSeasonState();
        if (seasonState.scoutingClosed) {
            await interaction.editReply({ content: 'Scouting is closed after the draft merge.' });
            return;
        }
        if (seasonState.phase === 'playoffs') {
            await interaction.editReply({ content: 'Scouting is available Weeks 1-29 and during the offseason until draft merge. It is locked during playoffs.' });
            return;
        }
        const currentWeek = seasonState.currentWeek ?? 0;
        if (seasonState.phase === 'regular' && currentWeek < 1) {
            const msg = 'Big board and scouting features unlock in Week 1.';
            await interaction.editReply({ content: msg });
            return;
        }

        // Resolve the current season's big board file
        const seasonNo = seasonState.seasonNo || 1;
        const classString = `CUS${seasonNo.toString().padStart(2, '0')}`;
        const boardDir = path.join(process.cwd(), 'bot', 'draft classes', 'big boards');
        const boardFile = fs.existsSync(boardDir)
            ? fs.readdirSync(boardDir).find(f => f.includes(classString) && f.includes('Big Board.json'))
            : null;
        const boardFilePath = boardFile ? path.join(boardDir, boardFile) : null;
        if (!fs.existsSync(boardFilePath)) {
            if (deferred) await interaction.editReply({ content: 'Big board file not found.' });
            else await interaction.reply({ content: 'Big board file not found.', ephemeral: true });
            return;
        }
        const bigBoardData = JSON.parse(fs.readFileSync(boardFilePath, 'utf8'));
        const allPlayers = Object.values(bigBoardData).filter(player => player && player.name && player.position_1);

        // Load scouting data
        const scoutPath = path.join(process.cwd(), 'data/scout_points.json');
        let scoutData = fs.existsSync(scoutPath) ? JSON.parse(fs.readFileSync(scoutPath, 'utf8')) : {};
        if (!scoutData[userId]) {
            scoutData[userId] = { playersScouted: {}, weeklyPoints: {} };
        }
        const userData = scoutData[userId];
        const pointsKey = seasonState.phase === 'offseason' ? 'offseason' : `week_${currentWeek}`;
        const defaultPoints = seasonState.phase === 'offseason' ? 100 : 40;
        if (!userData.weeklyPoints[pointsKey]) {
            userData.weeklyPoints[pointsKey] = defaultPoints;
        }
        if (userData.weeklyPoints[pointsKey] <= 0) {
            await interaction.editReply({ content: 'You have no scouting points left.' });
            return;
        }

        // Create select menus grouped by 15
        const numMenus = Math.ceil(allPlayers.length / 15);

        const components = [];
        for (let i = 0; i < numMenus; i++) {
            const startIdx = i * 15;
            const boardPlayers = allPlayers.slice(startIdx, startIdx + 15);
            if (boardPlayers.length === 0) continue;
            let customId = `scout_select_${i + 1}`;
            const selectOptions = boardPlayers.map((player, idx) => ({
                label: `${startIdx + idx + 1}. ${player.name}`,
                description: `${player.position_1} - ${player.team}`,
                value: player.id_number ? player.id_number.toString() : `${startIdx + idx + 1}`
            }));
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(`Select a player to scout (${startIdx + 1}-${startIdx + boardPlayers.length})`)
                .addOptions(selectOptions)
                .setMinValues(1)
                .setMaxValues(1); // Enforce single-select
            const row = new ActionRowBuilder().addComponents(selectMenu);
            components.push(row);
        }

        const embed = new EmbedBuilder()
            .setTitle('Big Board')
            .setColor(0x1e90ff)
            .setDescription(allPlayers.map((p, idx) => `${idx + 1}: ${p.position_1} ${p.name} - ${p.team}`).join('\n'))
            .setFooter({ text: `You have ${userData.weeklyPoints[pointsKey]} scouting points left this ${seasonState.phase === 'offseason' ? 'offseason' : 'week'}.` })
            .setThumbnail('https://cdn.discordapp.com/icons/1153432333259530240/leaguebuddy_logo.png');

        if (deferred) await interaction.editReply({ embeds: [embed], components });
    } catch (err) {
        console.error('Failed to execute /scout:', err?.message || err);
        if (deferred) {
            try {
                await interaction.editReply({ content: 'There was an error while executing this command!' });
            } catch (editErr) {
                console.error('Failed to send error message in /scout:', editErr?.message || editErr);
            }
        }
    }
}
// New interaction handlers for each select menu
export async function handleScoutSelect(interaction, menuIndex) {
    // Always defer immediately to avoid interaction expiration
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (err) {
        console.error('Failed to defer reply in handleScoutSelect:', err?.message || err);
        return;
    }
    const userId = interaction.user.id;
    const seasonState = getSeasonState();
    if (seasonState.scoutingClosed) {
        await interaction.editReply({ content: 'Scouting is closed after the draft merge.' });
        return;
    }
    if (seasonState.phase === 'playoffs') {
        await interaction.editReply({ content: 'Scouting is available Weeks 1-29 and during the offseason until draft merge. It is locked during playoffs.' });
        return;
    }
    const currentWeek = seasonState.currentWeek ?? 0;
    if (seasonState.phase === 'regular' && currentWeek < 1) {
        await interaction.editReply({ content: 'Scouting features unlock in Week 1. Only the recruit board is available during preseason.' });
        return;
    }
    // Resolve the current season's big board file
    const seasonNo = seasonState.seasonNo || 1;
    const classString = `CUS${seasonNo.toString().padStart(2, '0')}`;
    const boardDir = path.join(process.cwd(), 'bot', 'draft classes', 'big boards');
    const boardFile = fs.existsSync(boardDir)
        ? fs.readdirSync(boardDir).find(f => f.includes(classString) && f.includes('Big Board.json'))
        : null;
    const boardFilePath = boardFile ? path.join(boardDir, boardFile) : null;
    if (!boardFilePath || !fs.existsSync(boardFilePath)) {
        await interaction.editReply({ content: `Board file not found for season ${seasonNo}.` });
        return;
    }
    const bigBoardData = JSON.parse(fs.readFileSync(boardFilePath, 'utf8'));
    const allPlayers = Object.values(bigBoardData).filter(player => player && player.name && player.position_1);
    const startIdx = (menuIndex - 1) * 15;
    const players = allPlayers.slice(startIdx, startIdx + 15);
    const playerId = interaction.values[0];
    const player = players.find(p => p.id_number.toString() === playerId);
    if (!player) {
        await safeReplyOrEdit({ content: 'Player not found.', flags: 64 });
        return;
    }
    const playerName = player.name;
    // Helper to reply or editReply depending on state
    async function safeReplyOrEdit(options) {
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(options);
            } else {
                await interaction.reply(options);
            }
        } catch (err) {
            console.error('Failed to send reply/editReply:', err?.message || err);
        }
    }
    if (!player) {
        await safeReplyOrEdit({ content: 'Player not found.', flags: 64 });
        return;
    }

    // Load scouting data
    const scoutPath = path.join(process.cwd(), 'data/scout_points.json');
    let scoutData = fs.existsSync(scoutPath) ? JSON.parse(fs.readFileSync(scoutPath, 'utf8')) : {};
    if (!scoutData[userId]) {
        scoutData[userId] = { playersScouted: {}, weeklyPoints: {} };
    }
    const userData = scoutData[userId];
    // Only set to 40 if not already set for this week
    const pointsKey = seasonState.phase === 'offseason' ? 'offseason' : `week_${currentWeek}`;
    const defaultPoints = seasonState.phase === 'offseason' ? 100 : 40;
    if (userData.weeklyPoints[pointsKey] === undefined) {
        userData.weeklyPoints[pointsKey] = defaultPoints;
    }
    let pointsLeft = userData.weeklyPoints[pointsKey];
    if (pointsLeft <= 0) {
        await safeReplyOrEdit({ content: 'You have no scouting points left this week.', flags: 64 });
        return;
    }
    // Unlock order: build, draft_score, overall, potential
    const categories = ['build', 'draft_score', 'overall', 'potential'];
    // Persist unlocks across all phases: if unlocked in any phase, keep them
    let unlocked = userData.playersScouted[playerName] || [];
    // Guard: Only allow one unlock per interaction, even if handler is called twice
    const alreadyUnlocked = unlocked.length;
    // Find the next locked category
    const nextCat = categories.find(cat => !unlocked.includes(cat));
    let pointsUsed = 0;
    if (nextCat && pointsLeft >= 10 && unlocked.length === alreadyUnlocked) {
        unlocked = [...unlocked, nextCat];
        pointsLeft -= 10;
        pointsUsed = 10;
    }
    userData.playersScouted[playerName] = unlocked;
    userData.weeklyPoints[pointsKey] = pointsLeft;
    fs.writeFileSync(scoutPath, JSON.stringify(scoutData, null, 2));
    // Always use editReply after deferReply
    // Build small player card showing all unlocked info, or a message if none
    const card = new EmbedBuilder()
        .setTitle(`${player.position_1} ${player.name} - ${player.team}`)
        .setThumbnail(player.image)
        .setColor(0x1e90ff);
    const displayOrder = ['build', 'draft_score', 'overall', 'potential'];
    let anyUnlocked = false;
    let info = [];
    displayOrder.forEach(cat => {
        if (unlocked.includes(cat)) {
            anyUnlocked = true;
            if (cat === 'build') info.push(`**Build:** ${player.build}`);
            if (cat === 'draft_score') info.push(`**Draft Score:** ${player.draft_score}`);
            if (cat === 'overall') info.push(`**Overall:** ${player.overall}`);
            if (cat === 'potential') info.push(`**Potential:** ${player.potential}`);
        }
    });
    if (anyUnlocked) {
        card.setDescription(info.join(' | '));
    } else {
        card.setDescription('No info unlocked yet. Use your scouting points to unlock player details.');
    }
    let footerMsg = `You have ${pointsLeft} scouting points left this week.`;
    if (pointsUsed > 0) {
        footerMsg = `You used ${pointsUsed} points. ${pointsLeft} points left this week.`;
    }
    card.setFooter({ text: footerMsg });
    await safeReplyOrEdit({ embeds: [card], components: [], flags: 64 });
}

export default { data, execute };
