// scripts/fixStandings.js
// Usage: node scripts/fixStandings.js
// This script recalculates standings from scores.json and outputs a summary for debugging.

const fs = require('fs');
const SCORES_FILE = './data/scores.json';
const TEAMS_FILE = './data/teams.json';

function readScores() {
    if (!fs.existsSync(SCORES_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
}
function readTeams() {
    if (!fs.existsSync(TEAMS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
}

function calculateStandings() {
    const teams = readTeams();
    const scores = readScores().filter(s => s.approved && s.teamA && s.teamB && s.week);
    // Deduplicate by [week, teamA, teamB] sorted
    const uniqueScoresMap = new Map();
    for (const s of scores) {
        const teamsSorted = [s.teamA.trim().toUpperCase(), s.teamB.trim().toUpperCase()].sort();
        const key = `${s.week}|${teamsSorted[0]}|${teamsSorted[1]}`;
        if (!uniqueScoresMap.has(key)) {
            uniqueScoresMap.set(key, s);
        }
    }
    const uniqueScores = Array.from(uniqueScoresMap.values());
    // Initialize standings
    const standings = {};
    for (const team of teams) {
        standings[team.name] = {
            wins: 0,
            losses: 0,
            games: 0,
            pointsFor: 0,
            pointsAgainst: 0
        };
    }
    // Helper to match team names flexibly
    function matchTeam(name) {
        name = name.trim().toUpperCase();
        for (const team of teams) {
            if (team.name.toUpperCase() === name || team.abbreviation === name || team.name.toUpperCase().includes(name)) {
                return team.name;
            }
        }
        return name;
    }
    // Calculate standings
    for (const s of uniqueScores) {
        const teamA = matchTeam(s.teamA);
        const teamB = matchTeam(s.teamB);
        if (!standings[teamA] || !standings[teamB]) continue;
        standings[teamA].games++;
        standings[teamB].games++;
        standings[teamA].pointsFor += Number(s.scoreA);
        standings[teamA].pointsAgainst += Number(s.scoreB);
        standings[teamB].pointsFor += Number(s.scoreB);
        standings[teamB].pointsAgainst += Number(s.scoreA);
        if (Number(s.scoreA) > Number(s.scoreB)) {
            standings[teamA].wins++;
            standings[teamB].losses++;
        } else if (Number(s.scoreB) > Number(s.scoreA)) {
            standings[teamB].wins++;
            standings[teamA].losses++;
        }
        // If scores are equal, do not increment wins/losses (no ties allowed)
    }
    return standings;
}

function printStandings(standings) {
    for (const [team, s] of Object.entries(standings)) {
        const winPct = s.games > 0 ? s.wins / s.games : 0;
        console.log(`${team}: ${s.wins}-${s.losses} (${winPct.toFixed(3)}) Games: ${s.games}`);
    }
}

const standings = calculateStandings();
printStandings(standings);
