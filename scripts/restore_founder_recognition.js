import fs from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), 'data', 'leaguebuddy_recognition.json');

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function mean(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function usage() {
    console.log('Usage: node scripts/restore_founder_recognition.js --guild <guildId> --season <seasonKey> --user <userId> --impact <n> --legacy <n>');
}

const args = process.argv.slice(2);
const getArg = (name) => {
    const idx = args.indexOf(name);
    if (idx === -1) return null;
    return args[idx + 1] ?? null;
};

const guildId = getArg('--guild');
const seasonKey = getArg('--season');
const userId = getArg('--user');
const impact = Number(getArg('--impact'));
const legacy = Number(getArg('--legacy'));

if (!guildId || !seasonKey || !userId || !Number.isFinite(impact) || !Number.isFinite(legacy)) {
    usage();
    process.exit(1);
}

const store = readJSON(STORE_PATH);
const season = store?.[guildId]?.madden?.seasons?.[seasonKey];
if (!season) {
    console.error('Season not found:', { guildId, seasonKey });
    process.exit(1);
}

season.users = season.users || {};
const users = season.users;

const activities = Object.entries(users)
    .filter(([uid, u]) => uid !== String(userId) && u && typeof u === 'object')
    .map(([, u]) => Number(u.activity || 0));

const avgActivity = mean(activities);
const newActivity = Math.ceil(avgActivity) + 1; // "slightly more" than average

const existing = users[String(userId)] || {};
existing.activity = newActivity;
existing.impact = impact;
existing.legacy = legacy;
existing.spent = existing.spent || { activity: 0, impact: 0, legacy: 0 };
existing.activePerks = existing.activePerks || {};
existing.weeks = existing.weeks || {};
existing.history = Array.isArray(existing.history) ? existing.history : [];
existing.history.push({
    tier: 'impact',
    amount: 0,
    reason: `Founder restore: set totals to Activity ${newActivity} (avg ${avgActivity.toFixed(2)}), Impact ${impact}, Legacy ${legacy}`,
    weekKey: null,
    ts: Date.now(),
});
existing.history = existing.history.slice(-120);

users[String(userId)] = existing;
writeJSON(STORE_PATH, store);

console.log('Updated founder recognition:', {
    guildId,
    seasonKey,
    userId,
    activity: newActivity,
    impact,
    legacy,
});
