import fs from 'fs';
import path from 'path';
import { draftOrder, applyPickTrades } from '../src/madden/coach/mockdraft.js';

function latestLeagueFile() {
    const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.file || null;
}

const file = latestLeagueFile();
const league = JSON.parse(fs.readFileSync(file, 'utf8'));
const seasonYear = Number(league?.info?.careerHubInfo?.seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 0) + 1;

const order = applyPickTrades(draftOrder(league), seasonYear);
console.log(JSON.stringify({ seasonYear, currentWeek: league.currentWeek, order }, null, 2));
