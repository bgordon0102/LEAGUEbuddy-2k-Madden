import { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { DataManager } from '../../utils/dataManager.js';
import { resolveTeamNameForRoster } from '../../utils/rosterUtils.js';
// Removed score submitting, pin, welcome, button, modal, OCR, and result logic for rebuild
import fs from 'fs';
import path from 'path';

export const data = new SlashCommandBuilder()
    .setName('2k-creategamethreads')
    .setDescription('Create weekly game threads (advance week) for NBA 2K')
    .addIntegerOption(option =>
        option.setName('week')
            .setDescription('The week number to advance to (optional)')
            .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const TOTAL_WEEKS = 15; // 15 rounds for 15-team conferences (one bye each week)

const DEFAULT_CONFIG = {
    dedicatedChannelId: '1428417230000885830',
    announceChannelId: '1425555647167987792', // weekly announcements
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
    // Tag commish roles every time a game thread is created
    let commishMentions = '';
    try {
        const roleMapPath = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
        const roleMap = JSON.parse(fs.readFileSync(roleMapPath, 'utf8'));
        const commishRoles = [
            roleMap['Ghost Paradise Commish'],
            roleMap['Ghost Paradise Co-Commish']
        ].filter(Boolean);
        if (commishRoles.length) {
            commishMentions = commishRoles.map(id => `<@&${id}>`).join(' ');
        }
    } catch (err) {
        console.warn('[sendInitialWelcome] Could not load commish roles for tagging:', err);
    }

    const welcomeMsg = [commishMentions, coachMentions].filter(Boolean).join(' ');
    const embed = {
        title: `${teamA} vs ${teamB}`,
        description: [
            'Use this thread to coordinate your matchup, share availability, and confirm tip-off.',
            '',
            '**In-game date:** _not set (tap Set Game Info below)_',
            `**Deadline:** <t:${deadline}:F> (<t:${deadline}:R>)`
        ].join('\n'),
        color: 0x1E90FF
    };
    // Debug logging
    console.log(`[sendInitialWelcome] Attempting to send welcome message to thread: ${thread.name}`);
    try {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`set_game_info_${thread.id}`)
                .setLabel('Set Game Info')
                .setStyle(ButtonStyle.Primary)
        );
        const sentMsg = await thread.send({ content: welcomeMsg || null, embeds: [embed], components: [row] });
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
    // Load schedule.json week
    const schedulePath = path.join(process.cwd(), 'data', 'schedule.json');
    if (!fs.existsSync(schedulePath)) {
        await interaction.editReply({ content: 'schedule.json not found. Run the schedule generator first.' });
        return;
    }
    const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
    const weekData = schedule[weekNum - 1] || [];

    const matchups = weekData.map((g, idx) => ({
        id: g.id ?? idx,
        team1: { name: g.team1?.name || g.team1?.abbreviation || 'Team1' },
        team2: { name: g.team2?.name || g.team2?.abbreviation || 'Team2' }
    }));
    const byes = []; // computed below

    // Preview + validation only: list matchups and highlight issues (no threads created)
    const normalized = matchups.map(m => ({
        t1: m.team1.name,
        t2: m.team2.name,
        id: m.id
    }));

    // Build team list from roster files
    const rosterDir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
    const allTeams = (() => {
        try {
            const names = fs.readdirSync(rosterDir)
                .filter(f => f.endsWith('.json'))
                .filter(f => !/free[_ ]?agency/i.test(f))
                .filter(f => !/profile/i.test(f)) // drop stray player profile exports
                .map(f => f.replace('.json', '').replace(/_/g, ' '));
            return Array.from(new Set(names.map(n => resolveTeamNameForRoster(n))));
        } catch { return []; }
    })();

    const counts = {};
    normalized.forEach(m => {
        counts[m.t1] = (counts[m.t1] || 0) + 1;
        counts[m.t2] = (counts[m.t2] || 0) + 1;
    });
    const duplicates = Object.entries(counts).filter(([, c]) => c > 1).map(([t, c]) => `${t} (${c}x)`);
    const playingTeams = new Set(Object.keys(counts));
    const missingTeams = allTeams.filter(t => !playingTeams.has(t));
    const expectedGames = 14; // 28 teams playing, 2 byes (one per conference)
    const issues = [];
    if (normalized.length !== expectedGames) issues.push(`Expected ${expectedGames} games, found ${normalized.length}.`);
    if (duplicates.length) issues.push(`Duplicates: ${duplicates.join(', ')}`);
    if (missingTeams.length !== 2) {
        issues.push(`Missing/bye teams detected: ${missingTeams.join(', ') || 'none'}. Expected 2 byes.`);
    }
    // If validation fails, stop and report
    if (issues.length) {
        const lines = normalized.map((m, i) => `W${weekNum} G${i + 1}: ${m.t1} vs ${m.t2}`).join('\n') || 'No games found for this week.';
        await interaction.editReply({
            content: `Week ${weekNum} validation failed; no threads created.\n${lines}\nIssues: ${issues.join(' | ')}`,
        });
        return;
    }

    // Proceed to create threads
    const guild = interaction.guild;
    // Try to fetch the dedicated channel
    let dedicatedChannel = null;
    try {
        dedicatedChannel = await guild.channels.fetch(advanceCfg.dedicatedChannelId);
    } catch (err) {
        console.error('[advanceweek] Failed to fetch dedicated channel:', err);
    }
    if (!dedicatedChannel) {
        await interaction.editReply({ content: `❌ Dedicated channel not found or bot lacks access. Check config.advanceweek.dedicatedChannelId.` });
        return;
    }
    if (typeof dedicatedChannel.isTextBased === 'function' && !dedicatedChannel.isTextBased()) {
        await interaction.editReply({ content: '❌ Dedicated channel must support threads.' });
        return;
    }

    // Load gameInfo tracking
    const gameInfo = dataManager.readData('gameInfo') || {};
    gameInfo.weekThreads = gameInfo.weekThreads || {};
    const weekThreads = gameInfo.weekThreads[weekNum] || {};

    // Create threads
    const buildThreadName = (m) => {
        const t1 = m.t1.split(' ').pop();
        const t2 = m.t2.split(' ').pop();
        return `${t1} vs ${t2} - W${weekNum}`;
    };

    let created = 0;
    for (const m of normalized) {
        const existingId = weekThreads[m.id];
        if (existingId) {
            try {
                const existing = await interaction.client.channels.fetch(existingId);
                if (existing) { created++; continue; }
            } catch { /* recreate */ }
        }
        try {
            const thread = await dedicatedChannel.threads.create({
                name: buildThreadName(m),
                autoArchiveDuration: 1440,
                reason: `Week ${weekNum} game: ${m.t1} vs ${m.t2}`
            });
            weekThreads[m.id] = thread.id;
            created++;
            await sendInitialWelcome(thread, m.t1, m.t2, advanceCfg.deadlineHours);
        } catch (err) {
            console.error('[advanceweek] Error creating thread for', m, err);
        }
    }
    gameInfo.weekThreads[weekNum] = weekThreads;
    dataManager.writeData('gameInfo', gameInfo);
    season.currentWeek = weekNum;
    dataManager.writeData('season', season);

    // Announce in league announcements channel with 48h countdown
    try {
        const announceChannel = await guild.channels.fetch(advanceCfg.announceChannelId);
        if (announceChannel) {
            const hours = Number.isFinite(advanceCfg.deadlineHours) ? advanceCfg.deadlineHours : DEFAULT_CONFIG.deadlineHours;
            const deadline = Math.floor((Date.now() + hours * 60 * 60 * 1000) / 1000);
            // Tag Ghost Paradise role if available
            let ghostTag = '';
            try {
                const roleMapPath = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
                const roleMap = JSON.parse(fs.readFileSync(roleMapPath, 'utf8'));
                if (roleMap['Ghost Paradise']) ghostTag = `<@&${roleMap['Ghost Paradise']}> `;
            } catch { /* ignore */ }
            const embed = new EmbedBuilder()
                .setTitle(`Week ${weekNum} Threads Live`)
                .setDescription(`All game threads are posted. Set your in-game date in your thread and confirm tip-off.\n\nDeadline: <t:${deadline}:F> (<t:${deadline}:R>)`)
                .setColor(0x1E90FF);
            await announceChannel.send({
                content: `${ghostTag}<@&${advanceCfg.leagueRoleId}>`,
                embeds: [embed]
            });
        }
    } catch (err) {
        console.error('[advanceweek] Failed to send announcement embed:', err);
    }

    const byeTeams = allTeams.filter(t => !playingTeams.has(t));
    await interaction.editReply({
        content: `Created ${created}/${normalized.length} game threads for Week ${weekNum}. Byes: ${byeTeams.join(', ') || 'none'}.`,
    });
}

export default { data, execute };
