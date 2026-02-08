import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import fsPromises from 'fs/promises';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const COACHROLEMAP_FILE = path.join(DATA_DIR, 'coachRoleMap.json');
const SEASON_FILE = path.join(DATA_DIR, 'season.json');
const TEAMS_FILE = path.join(DATA_DIR, 'teams.json');
const LEAGUE_FILE = path.join(DATA_DIR, 'league.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');

// Use the draft class file directly for big board operations
// Use the draft class file directly for big board operations (no CUS01 folder)
const BIGBOARD_FILE = path.join(process.cwd(), 'draft classes/2k26_CUS01 - Big Board.json');
const SCOUTING_FILE = path.join(DATA_DIR, 'scouting.json');
const RECRUITS_FILE = path.join(DATA_DIR, 'recruits.json');
const SCOUT_POINTS_FILE = path.join(DATA_DIR, 'scout_points.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

// Helper to write JSON
// Helper to copy all team rosters to backup folder
function backupAllRosters() {
    const rostersDir = path.join(process.cwd(), 'data', 'teams_rosters');
    const backupDir = path.join(process.cwd(), 'data', 'rosters_backup');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const src = path.join(rostersDir, file);
        const dest = path.join(backupDir, file);
        fs.copyFileSync(src, dest);
    }
    console.log('[startseason] Backed up all team rosters to rosters_backup');
}

// Helper to restore all team rosters from backup folder
// Helper to restore all team rosters from master folder
// Helper to restore team picks from master file
function restoreTeamPicksFromMaster() {
    const picksFile = path.join(process.cwd(), 'data', 'team_picks.json');
    const masterFile = path.join(process.cwd(), 'data', 'team_picks_master.json');
    if (!fs.existsSync(masterFile)) {
        console.error('[startseason] No master picks file found to restore team picks.');
        return;
    }
    fs.copyFileSync(masterFile, picksFile);
    console.log('[startseason] Restored team picks from team_picks_master.json');
}
function restoreAllRostersFromMaster() {
    const rostersDir = path.join(process.cwd(), 'data', 'teams_rosters');
    const masterDir = path.join(process.cwd(), 'data', 'teams_rosters_master');
    if (!fs.existsSync(masterDir)) {
        console.error('[startseason] No master folder found to restore rosters.');
        return;
    }
    const files = fs.readdirSync(masterDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
        const src = path.join(masterDir, file);
        const dest = path.join(rostersDir, file);
        fs.copyFileSync(src, dest);
    }
    console.log('[startseason] Restored all team rosters from teams_rosters_master');
}
function writeJSON(file, data) {
    try {
        if (typeof data === 'undefined') {
            console.error(`[writeJSON] Tried to write undefined data to ${file}`);
            return;
        }
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`[writeJSON] Failed to write to ${file}:`, err);
    }
}

function clearDataFiles() {
    const targets = [
        { file: 'activeTrades.json', data: {} },
        { file: 'pendingTrades.json', data: {} },
        { file: 'committeeVotes.json', data: {} },
        { file: 'trade_block.json', data: {} },
        { file: 'tradeblock.json', data: {} },
        { file: 'tradeblock_messages.json', data: {} },
        { file: 'gameStats.json', data: {} },
        { file: 'playoffpicture.json', data: {} },
        { file: 'prospectBoards.json', data: {} },
        { file: 'regressionEmbeds.json', data: {} },
        { file: 'regression.json', data: {} },
        // { file: 'freeagency.json', data: [] },
        { file: 'freeagency_entries.json', data: [] },
        { file: 'freeagency_offers.json', data: [] },
        { file: 'freeagency_log.json', data: [] },
        { file: 'resignings.json', data: [] },
        { file: 'resigning_log.json', data: [] },
        { file: 'recruiting.json', data: [] },
    ];
    for (const { file, data } of targets) {
        try {
            const fullPath = path.join(DATA_DIR, file);
            writeJSON(fullPath, data);
        } catch (err) {
            console.error(`[startseason] Failed to clear ${file}:`, err);
        }
    }
}

// Extracted season reset logic (no Discord interaction)
// NOTE: This function should NEVER respond to any Discord interaction object.
// NEVER modify or overwrite coachRoleMap.json or any trade-related state in this function.
// Only read coachRoleMap.json to snapshot for the new season. The trade system relies on the persistent file.
export async function resetSeasonData(seasonno, guild, caller = 'unknown', useCurrentRosters = false) {
    // Restore all rosters and picks from master before reset unless using current as baseline
    if (!useCurrentRosters) {
        restoreAllRostersFromMaster();
        restoreTeamPicksFromMaster();
    }
    // Clear gameInfo.json for new season
    try {
        fs.writeFileSync(path.join(DATA_DIR, 'gameInfo.json'), '{}');
        console.log('[resetSeasonData] Cleared gameInfo.json for new season');
        // Clear progressionRequests.json for new season
        fs.writeFileSync(path.join(DATA_DIR, 'progressionRequests.json'), '[]');
        console.log('[resetSeasonData] Cleared progressionRequests.json for new season');
        // Clear additional league state for fresh season
        clearDataFiles();
    } catch (err) {
        console.error('[resetSeasonData] Failed to clear gameInfo.json:', err);
    }
    console.log('[resetSeasonData] STARTED for seasonno:', seasonno, 'guild:', guild?.id, 'caller:', caller);
    // Load coachRoleMap from file at the very top
    let coachRoleMap = {};
    try {
        const data = await fsPromises.readFile(COACHROLEMAP_FILE, 'utf8');
        coachRoleMap = JSON.parse(data);
        console.log('[resetSeasonData] Loaded coachRoleMap.json');
    } catch (err) {
        console.error(`[resetSeasonData] Failed to load coachRoleMap.json:`, err);
    }
    console.log(`[resetSeasonData] Called from: ${caller}`);
    console.log(`[resetSeasonData] process.cwd():`, process.cwd());
    // New season length: 14 games (single round vs conference only)
    const gameno = 14;
    // Static NBA team list (shuffled for random schedule)
    // Dynamically build team list from teams_rosters directory
    const teamsRostersDir = path.join(process.cwd(), 'data', 'teams_rosters');
    const teamFiles = fs.readdirSync(teamsRostersDir).filter(f => f.endsWith('.json') && f !== 'Free_Agency.json');
    const nbaTeams = teamFiles.map((file, idx) => {
        const name = file.replace('.json', '').replace(/_/g, ' ');
        // Try to infer abbreviation from file name (first 3 letters of each word)
        const abbr = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3);
        return { id: idx + 1, name, abbreviation: abbr };
    });
    // Shuffle for random schedule
    const staticTeams = nbaTeams.map(team => ({ ...team, coach: null }));
    for (let i = staticTeams.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [staticTeams[i], staticTeams[j]] = [staticTeams[j], staticTeams[i]];
    }

    // --- Self-healing file logic ---
    function safeReadJSON(file, fallback) {
        try {
            const data = fs.readFileSync(file, 'utf8');
            if (!data) throw new Error('Empty file');
            return JSON.parse(data);
        } catch {
            console.warn(`[startseason] File ${file} missing or invalid, recreating with defaults.`);
            writeJSON(file, fallback);
            return fallback;
        }
    }

    // Coach Role Map: never rewrite or update coachRoleMap.json in startseason. Always use the existing file as-is.
    // If you need to update coachRoleMap.json, do it manually.

    // Schedule
    const schedule = generateWeekBasedSchedule(staticTeams, gameno);
    // Validate schedule: must be non-empty array of arrays
    if (!Array.isArray(schedule) || schedule.length === 0 || !Array.isArray(schedule[0])) {
        console.error('[startseason] Generated schedule is invalid, writing fallback.');
        console.log('[startseason] Writing schedule.json: fallback');
        writeJSON(SCHEDULE_FILE, [{ error: 'No schedule generated' }]);
    } else {
        console.log('[startseason] Writing schedule.json:', SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
        writeJSON(SCHEDULE_FILE, schedule);
        console.log('[startseason] Wrote schedule.json');
    }

    // Teams
    console.log('[startseason] Writing teams.json:', TEAMS_FILE, JSON.stringify(staticTeams, null, 2));
    writeJSON(TEAMS_FILE, staticTeams);
    console.log('[startseason] Wrote teams.json');

    // --- DRAFT CLASS SELECTION LOGIC ---
    // Only use the draft class files for big board data. Recruiting is deprecated and not regenerated.

    // Standings
    const standings = {};
    staticTeams.forEach(team => {
        standings[team.name] = { wins: 0, losses: 0, games: 0, pointsFor: 0, pointsAgainst: 0 };
    });
    writeJSON(path.join(DATA_DIR, 'standings.json'), standings);

    // Scores: always reset to empty array
    writeJSON(path.join(DATA_DIR, 'scores.json'), []);
    // Do not regenerate recruiting.json or recruits.json

    // Season file: always use the freshly generated coachRoleMap
    const seasonData = {
        currentWeek: 0,
        seasonNo: seasonno,
        coachRoleMap: coachRoleMap,
        phase: 'regular',
        tradeCutoffWeek: 10,
        playoffStartWeek: 15, // playoffs after 14-game regular season
        offseasonStartWeek: 17, // offseason begins after playoffs conclude
        scoutingClosed: false,
    };
    if (!seasonData || typeof seasonData !== 'object' || Object.keys(seasonData).length === 0) {
        console.error('[resetSeasonData] seasonData is invalid, not writing to season.json');
    } else {
        writeJSON(SEASON_FILE, seasonData);
    }

    // League, Players, Bigboard, Scouting, Recruits, Scout Points
    // League: always write a valid league object with seasonNo and teams
    const leagueData = {
        seasonNo: seasonno,
        teams: staticTeams.map(t => ({ id: t.id, name: t.name, abbreviation: t.abbreviation }))
    };
    console.log('[startseason] Writing league.json:', LEAGUE_FILE, JSON.stringify(leagueData, null, 2));
    writeJSON(LEAGUE_FILE, leagueData);
    console.log('[startseason] Wrote league.json');
    writeJSON(PLAYERS_FILE, []);
    writeJSON(SCOUTING_FILE, {});
    // Do not regenerate recruits.json
    writeJSON(SCOUT_POINTS_FILE, {});

    return staticTeams.length;
}

// Generate a 14-game schedule: single round robin within each conference (East/West), one game per week
function generateWeekBasedSchedule(teams, gameno) {
    const eastNames = new Set([
        'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
        'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks',
        'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
    ]);
    const westNames = new Set([
        'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers',
        'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder',
        'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
    ]);

    const isEast = (name) => eastNames.has(name);
    const east = [];
    const west = [];
    for (const t of teams) {
        if (isEast(t.name)) east.push(t); else if (westNames.has(t.name)) west.push(t); else west.push(t);
    }

    const buildRoundRobin = (list, startId) => {
        const schedule = [];
        let id = startId;
        let arr = [...list];
        if (arr.length % 2 !== 0) arr.push(null);
        const n = arr.length;
        const rounds = n - 1;
        const half = n / 2;
        for (let round = 0; round < rounds; round++) {
            const week = [];
            for (let i = 0; i < half; i++) {
                const a = arr[i];
                const b = arr[n - 1 - i];
                if (a && b) week.push({ id: id++, team1: a, team2: b });
            }
            schedule.push(week);
            // rotate
            arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
        }
        return { weeks: schedule, nextId: id };
    };

    // Add week 0 (no games)
    const combined = [[]];
    const eastSchedule = buildRoundRobin(east, 0);
    const westSchedule = buildRoundRobin(west, eastSchedule.nextId);
    const totalRounds = Math.max(eastSchedule.weeks.length, westSchedule.weeks.length);
    for (let i = 0; i < totalRounds; i++) {
        const weekGames = [
            ...(eastSchedule.weeks[i] || []),
            ...(westSchedule.weeks[i] || []),
        ];
        combined.push(weekGames);
    }
    return combined;
}

// Discord command builder and execute function
export const data = new SlashCommandBuilder()
    .setName('2k-startleague')
    .setDescription('Start a brand-new league at Season 1 (confirmation required).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

import { DataManager } from '../../utils/dataManager.js';

export async function execute(interaction) {
    // Only handle valid slash commands
    if (!interaction.isChatInputCommand()) {
        console.warn('[startseason] Ignored non-slash command interaction');
        return;
    }
    // Debug log for every execution
    console.log(`[startseason] execute called for interaction ID: ${interaction.id}, user: ${interaction.user?.tag || interaction.user?.id}`);
    try {
        // Use flags for ephemeral reply to avoid deprecation warning
        await interaction.deferReply({ flags: 64 }); // 64 = EPHEMERAL
    } catch (err) {
        console.error('[startseason] Error during deferReply:', err);
        return;
    }
    // Always show confirmation button before resetting season
    const seasonno = 1;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`startseason_confirm_${seasonno}`)
            .setLabel('Are you sure? This will reset all season data!')
            .setStyle(ButtonStyle.Danger)
    );
    await interaction.editReply({
        content: 'Are you sure you want to start a new season? This will clear ALL season data and cannot be undone.',
        components: [row]
    });
    return;
}

export default { data, execute };
