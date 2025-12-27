import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

export const data = new SlashCommandBuilder()
    .setName('scout')
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
        // Load current week
        const seasonPath = path.join(process.cwd(), 'data/season.json');
        const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
        const currentWeek = seasonData.currentWeek ?? 0;
        if (currentWeek < 1) {
            const msg = 'Big board and scouting features unlock in Week 1.';
            if (deferred) await interaction.editReply({ content: msg });
            else await interaction.reply({ content: msg, ephemeral: true });
            return;
        }

        // Use only the single big board file for all weeks (flat structure)
        const boardFilePath = path.join(process.cwd(), 'draft classes', `2k26_CUS01 - Big Board.json`);
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
        if (!userData.weeklyPoints[`week_${currentWeek}`]) {
            userData.weeklyPoints[`week_${currentWeek}`] = 40;
        }
        if (userData.weeklyPoints[`week_${currentWeek}`] <= 0) {
            if (deferred) await interaction.editReply({ content: 'You have no scouting points left this week.' });
            return;
        }

        // Create select menus grouped by 15, just like prospectboard
        // Always use 2 select menus for consistency (or adjust as needed)
        let numMenus = 4;

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
            .setFooter({ text: `You have ${userData.weeklyPoints[`week_${currentWeek}`]} scouting points left this week.` })
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
    const seasonPath = path.join(process.cwd(), 'data/season.json');
    const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
    const currentWeek = seasonData.currentWeek ?? 0;
    if (currentWeek < 1) {
        await interaction.editReply({ content: 'Scouting features unlock in Week 1. Only the recruit board is available during preseason.' });
        return;
    }
    // Always use the single big board file (flat structure)
    const boardFilePath = path.join(process.cwd(), 'draft classes', `2k26_CUS01 - Big Board.json`);
    if (!fs.existsSync(boardFilePath)) {
        await interaction.editReply({ content: `Board file not found at resolved path: ${boardFilePath}` });
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
    if (userData.weeklyPoints[`week_${currentWeek}`] === undefined) {
        userData.weeklyPoints[`week_${currentWeek}`] = 40;
    }
    let pointsLeft = userData.weeklyPoints[`week_${currentWeek}`];
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
    userData.weeklyPoints[`week_${currentWeek}`] = pointsLeft;
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
