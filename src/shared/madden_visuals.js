import fs from 'fs';
import path from 'path';
import { getFullTeamName } from './madden_team_names.js';

const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

export const RECOGNITION_EMOJIS = {
  legacy: '<:legacy:1482989680994549792>',
  impact: '<:impact:1482989570185363466>',
  activity: '<:activity:1482989470591484024>',
};

function normalizeName(name = '') {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

let cachedTeamEmojiMap = null;

export function loadTeamEmojiMap() {
  if (cachedTeamEmojiMap) return cachedTeamEmojiMap;
  try {
    cachedTeamEmojiMap = JSON.parse(fs.readFileSync(TEAM_EMOJIS_FILE, 'utf8'));
  } catch {
    cachedTeamEmojiMap = {};
  }
  return cachedTeamEmojiMap;
}

export function getTeamEmojiByName(teamName = '') {
  const emojiMap = loadTeamEmojiMap();
  const normalized = normalizeName(teamName);
  if (!normalized) return '';
  for (const [key, id] of Object.entries(emojiMap || {})) {
    const normKey = normalizeName(key);
    if (!normKey) continue;
    if (normalized === normKey || normalized.endsWith(normKey) || normKey.endsWith(normalized)) {
      const safeName = key.replace(/[^A-Za-z0-9]/g, '') || 'team';
      return `<:${safeName}:${id}>`;
    }
  }
  return '';
}

export function getTeamEmoji(team = null) {
  if (!team) return '';
  return getTeamEmojiByName(
    getFullTeamName(team, '') ||
    team?.displayName ||
    team?.nickName ||
    team?.cityName ||
    '',
  );
}

export function formatTeamLabelWithEmoji(teamName = '') {
  const emoji = getTeamEmojiByName(teamName);
  return emoji ? `${emoji} ${teamName}` : teamName;
}
