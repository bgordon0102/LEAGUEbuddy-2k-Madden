import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rostersDir = path.join(__dirname, '../teams_rosters');
const simplePicks = [
    "2026 1st",
    "2026 2nd",
    "2027 1st",
    "2027 2nd",
    "2028 1st",
    "2028 2nd",
    "2029 1st",
    "2029 2nd",
    "2030 1st",
    "2030 2nd"
];

fs.readdirSync(rostersDir).forEach(file => {
    if (file.endsWith('.json')) {
        // Skip Free Agency file
        if (file.toLowerCase().includes('free_agency')) {
            console.log(`Skipped ${file}`);
            return;
        }
        const filePath = path.join(rostersDir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let newData;
        if (Array.isArray(data)) {
            newData = { players: data, picks: simplePicks };
        } else {
            newData = { ...data };
            if (!Array.isArray(newData.players)) {
                newData.players = [];
            }
            newData.picks = simplePicks;
        }
        fs.writeFileSync(filePath, JSON.stringify(newData, null, 2));
        console.log(`Updated ${file}`);
    }
});

console.log('Batch conversion and picks update complete.');
