import fs from 'fs';
import path from 'path';
import { DataManager } from './dataManager.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const COACHROLEMAP_FILE = path.join(DATA_DIR, 'coachRoleMap.json');
const SEASON_FILE = path.join(DATA_DIR, 'season.json');
const TEAMS_FILE = path.join(DATA_DIR, 'teams.json');
const LEAGUE_FILE = path.join(DATA_DIR, 'league.json');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
// const BIGBOARD_FILE = path.join(DATA_DIR, 'bigboard.json'); // REMOVED: No longer used
const SCOUTING_FILE = path.join(DATA_DIR, 'scouting.json');
const RECRUITS_FILE = path.join(DATA_DIR, 'recruits.json');
const SCOUT_POINTS_FILE = path.join(DATA_DIR, 'scout_points.json');
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');

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

function safeReadJSON(file, fallback) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        if (!data) throw new Error('Empty file');
        return JSON.parse(data);
    } catch {
        writeJSON(file, fallback);
        return fallback;
    }
}

export function runSeasonSetup(seasonno, guild) {
    // ...copy logic from resetSeasonData in startseason.js...
    // For brevity, you can import and call resetSeasonData if exported
    // Or duplicate the logic here
    // Returns true if successful
    // For now, just call resetSeasonData
    // You may want to refactor for more granular control
    return true;
}

export function runAdvanceWeek(weekNum, guild) {
    // ...copy logic from advanceweek.js, but without Discord interaction...
    // Returns true if successful
    // For now, just a stub
    return true;
}
