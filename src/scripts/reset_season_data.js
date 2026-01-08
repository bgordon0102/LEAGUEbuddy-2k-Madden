// Script to clear progression and regression data for a new season
const fs = require('fs');
const path = require('path');

// Clear progression from all team rosters
const rostersDir = path.join(__dirname, '../data/teams_rosters');
const rosterFiles = fs.readdirSync(rostersDir);
rosterFiles.forEach(file => {
    const filePath = path.join(rostersDir, file);
    const roster = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const players = Array.isArray(roster) ? roster : roster.players || [];
    players.forEach(p => { delete p.progression; });
    if (Array.isArray(roster)) {
        fs.writeFileSync(filePath, JSON.stringify(players, null, 2));
    } else {
        roster.players = players;
        fs.writeFileSync(filePath, JSON.stringify(roster, null, 2));
    }
});

// Clear regressionCounts.json
const regressionPath = path.join(__dirname, '../data/regressionCounts.json');
if (fs.existsSync(regressionPath)) {
    fs.writeFileSync(regressionPath, JSON.stringify({}, null, 2));
}

console.log('Season data reset: progression and regression cleared.');
