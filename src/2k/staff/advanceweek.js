import { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { DataManager } from '../../utils/dataManager.js';
import { resolveTeamNameForRoster } from '../../utils/rosterUtils.js';
// Removed score submitting, pin, welcome, button, modal, OCR, and result logic for rebuild
import fs from 'fs';

export const data = new SlashCommandBuilder()
    .setName('2k-creategamethreads')
    .setDescription('Create weekly game threads (advance week) for NBA 2K')
    .addIntegerOption(option =>
        option.setName('week')
            .setDescription('The week number to advance to (optional)')
            .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const TOTAL_WEEKS = 14;

const DEFAULT_CONFIG = {
    dedicatedChannelId: '1428417230000885830',
    announceChannelId: '1425555647167987792',
    phaseAnnounceChannelId: '1425555647167987792',
    leagueRoleId: '1460733464721490108',
    deadlineHours: 48,
};

function loadAdvanceConfig(dataManager) {
    const cfg = dataManager.readData('config');
    const userCfg = cfg?.advanceweek || {};
    return { ...DEFAULT_CONFIG, ...userCfg, deadlineHours: 48 };
}

function mascotOnly(name) {
    const n = (name || '').trim();
    if (!n) return 'Team';
    if (/trail\s*blazers/i.test(n)) return 'Trail Blazers';
    if (/timberwolves/i.test(n)) return 'Timberwolves';
    if (/76ers|seventy\s*sixers/i.test(n)) return '76ers';
    const parts = n.split(/\s+/);
    return parts[parts.length - 1] || n;
}

function loadCoachRoleMap() {
    try {
        return JSON.parse(fs.readFileSync('./data/coachRoleMap.json', 'utf8'));
    } catch (err) {
        return {};
    }
}

function findCoachRoleId(teamName, coachRoleMap) {
    if (!teamName) return null;
    const normalized = teamName.trim().toLowerCase();
    if (coachRoleMap[`${teamName} Coach`]) return coachRoleMap[`${teamName} Coach`];
    const entries = Object.entries(coachRoleMap || {}).map(([name, id]) => ({
        raw: name,
        base: name.replace(/\s+coach$/i, '').trim().toLowerCase(),
        id,
    }));
    const tokens = normalized.split(/\s+/);
    const last = tokens[tokens.length - 1];
    const lastTwo = tokens.slice(-2).join(' ');
    const nickname = tokens.slice(1).join(' ');

    // Exact/base matches
    const exact = entries.find(e =>
        e.base === normalized ||
        e.raw.toLowerCase() === normalized ||
        e.raw.toLowerCase() === `${normalized} coach`
    );
    if (exact) return exact.id;

    // Nickname / trailing words
    const nickHit = entries.find(e =>
        (nickname && e.base === nickname) ||
        (lastTwo && e.base === lastTwo) ||
        (last && e.base === last) ||
        (last && e.raw.toLowerCase().includes(last))
    );
    if (nickHit) return nickHit.id;

    // Contains fallback
    const contains = entries.find(e =>
        normalized.includes(e.base) || e.base.includes(normalized)
    );
    return contains ? contains.id : null;
}

async function sendInitialWelcome(thread, teamA, teamB, deadlineHours) {
    const coachRoleMap = loadCoachRoleMap();
    const teamARole = findCoachRoleId(teamA, coachRoleMap);
    const teamBRole = findCoachRoleId(teamB, coachRoleMap);
    console.log(`[sendInitialWelcome] Role lookup: ${teamA} -> ${teamARole || 'none'}, ${teamB} -> ${teamBRole || 'none'}`);
    const mentions = [];
    if (teamARole) mentions.push(`<@&${teamARole}>`);
    if (teamBRole) mentions.push(`<@&${teamBRole}>`);
    const coachMentions = mentions.join(' ') || `${teamA} Coach & ${teamB} Coach`;
    const hours = Number.isFinite(deadlineHours) ? deadlineHours : DEFAULT_CONFIG.deadlineHours;
    const deadline = Math.floor((Date.now() + hours * 60 * 60 * 1000) / 1000); // UNIX seconds
    const welcomeMsg = `Welcome ${coachMentions}!\nUse this thread to coordinate your matchup. Share availability and confirm tip-off here.\n\nSet the in-game date using the button below so staff can sim if needed.\n\n**In-game date:** _not set (tap Set Game Info)_\n\nDeadline: <t:${deadline}:F> (<t:${deadline}:R>)`;
    // Debug logging
    console.log(`[sendInitialWelcome] Attempting to send welcome message to thread: ${thread.name}`);
    try {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`set_game_info_${thread.id}`)
                .setLabel('Set Game Info')
                .setStyle(ButtonStyle.Primary)
        );
        const sentMsg = await thread.send({ content: welcomeMsg, components: [row] });
        console.log(`[sendInitialWelcome] Message sent to thread: ${thread.name}, messageId: ${sentMsg.id}`);
        await sentMsg.pin();
        console.log(`[sendInitialWelcome] Message pinned in thread: ${thread.name}`);
    } catch (err) {
        console.error('[sendInitialWelcome] Failed to send or pin welcome message:', err);
    }
}

export async function execute(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (err) {
        if (err?.code === 10062 || err?.code === 40060) return;
        console.error('[advanceweek] Error deferring reply:', err);
        return;
    }
    const dataManager = new DataManager();
    const advanceCfg = loadAdvanceConfig(dataManager);
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
        dedicatedChannel = await guild.channels.fetch(advanceCfg.dedicatedChannelId);
    } catch (err) {
        console.error('[advanceweek] Failed to fetch dedicated channel:', err);
    }
    if (!dedicatedChannel) {
        await interaction.editReply({ content: `❌ Dedicated channel not found or bot lacks access. Check DISCORD_GUILD_ID and config.advanceweek.dedicatedChannelId.` });
        return;
    }
    // Ensure channel supports threads
    if (typeof dedicatedChannel.isTextBased === 'function' && !dedicatedChannel.isTextBased()) {
        await interaction.editReply({ content: '❌ Dedicated channel must be a text channel that supports threads.' });
        return;
    }
    let createdThreads = [];
    // Load gameInfo.json once and prepare per-week tracking for idempotency
    const gameInfo = dataManager.readData('gameInfo') || {};
    gameInfo.weekThreads = gameInfo.weekThreads || {};
    const weekThreads = gameInfo.weekThreads[weekNum] || {};

    const buildThreadName = (m) => {
        const t1Full = resolveTeamNameForRoster(m.team1?.name || m.team1?.abbreviation || 'Team1');
        const t2Full = resolveTeamNameForRoster(m.team2?.name || m.team2?.abbreviation || 'Team2');
        const t1 = mascotOnly(t1Full);
        const t2 = mascotOnly(t2Full);
        return `${t1} vs ${t2} - W${weekNum}`;
    };
    const teamsUsed = new Set();
    for (const matchup of matchups) {
        matchup.team1.name = resolveTeamNameForRoster(matchup.team1.name || matchup.team1.abbreviation);
        matchup.team2.name = resolveTeamNameForRoster(matchup.team2.name || matchup.team2.abbreviation);

        // Skip duplicate appearances in the same week (bad schedule data safeguard)
        if (teamsUsed.has(matchup.team1.name) || teamsUsed.has(matchup.team2.name)) {
            console.warn(`[advanceweek] Skipping duplicate matchup for week ${weekNum}: ${matchup.team1.name} vs ${matchup.team2.name}`);
            continue;
        }
        teamsUsed.add(matchup.team1.name);
        teamsUsed.add(matchup.team2.name);

        const threadName = buildThreadName(matchup);

        // Idempotency: skip if we already created a thread for this matchup and it still exists
        const existingThreadId = weekThreads[matchup.id];
        if (existingThreadId) {
            try {
                const existing = await interaction.client.channels.fetch(existingThreadId);
                if (existing) {
                    createdThreads.push(threadName);
                    continue;
                }
            } catch (err) {
                console.warn(`[advanceweek] Stored thread ${existingThreadId} missing, recreating for ${threadName}`);
            }
        }
        try {
            const thread = await dedicatedChannel.threads.create({
                name: threadName,
                autoArchiveDuration: 1440,
                reason: `Game thread for ${threadName} (Week ${weekNum})`
            });
            createdThreads.push(threadName);
            weekThreads[matchup.id] = thread.id;
            await sendInitialWelcome(thread, matchup.team1.name, matchup.team2.name, advanceCfg.deadlineHours);
        } catch (err) {
            console.error(`[advanceweek] Error creating thread:`, err);
        }
    }
    gameInfo.weekThreads[weekNum] = weekThreads;
    dataManager.writeData('gameInfo', gameInfo);
    season.currentWeek = weekNum;
    const writeSuccess = dataManager.writeData('season', season);
    if (writeSuccess) {
        console.log(`[advanceweek] Successfully wrote currentWeek=${weekNum} to season.json`);
    } else {
        console.error(`[advanceweek] FAILED to write currentWeek=${weekNum} to season.json`);
    }
    // Send global announcement with countdown to next advance
    try {
        const announceChannel = await guild.channels.fetch(advanceCfg.announceChannelId);
        if (announceChannel) {
            const hours = Number.isFinite(advanceCfg.deadlineHours) ? advanceCfg.deadlineHours : DEFAULT_CONFIG.deadlineHours;
            const deadline = Math.floor((Date.now() + hours * 60 * 60 * 1000) / 1000);
            await announceChannel.send({
                content: `<@&${advanceCfg.leagueRoleId}> Week ${weekNum} threads created. Deadline to play/tag staff: <t:${deadline}:F> (<t:${deadline}:R>).`
            });
        }
    } catch (err) {
        console.error('[advanceweek] Failed to send announcement:', err);
    }
    await interaction.editReply({ content: `Week advanced! Current week is now ${season.currentWeek}. Created ${createdThreads.length}/${matchups.length} threads in the dedicated channel.` });
}

export default { data, execute };
