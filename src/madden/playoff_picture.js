import fs from 'fs';
import path from 'path';
import { getPinId, setPinId } from './pins_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

function loadSnapshot(leagueId) {
  const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}
function loadEmojiMap() {
  try { return JSON.parse(fs.readFileSync(TEAM_EMOJIS_FILE, 'utf8')); } catch { return {}; }
}

function teamEmoji(name, emojiMap) {
  if (!name) return '';
  const target = name.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(emojiMap || {})) {
    const base = key.toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<:${key.replace(/\s+/g, '')}:${val}>`;
    }
  }
  return '';
}

function teamNameMap(snapshot, emojiMap) {
  const map = {};
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  list.forEach(t => {
    if (!t.teamId) return;
    const name = [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
    const emoji = teamEmoji(name, emojiMap);
    map[t.teamId] = emoji || name || `Team ${t.teamId}`;
  });
  return map;
}

function formatRecord(s) {
  const w = s?.totalWins ?? 0;
  const l = s?.totalLosses ?? 0;
  const t = s?.totalTies ?? 0;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function seedSort(a, b) {
  const aSeed = a.seed ?? 0;
  const bSeed = b.seed ?? 0;
  if (aSeed && bSeed) return aSeed - bSeed;
  if (aSeed && !bSeed) return -1;
  if (!aSeed && bSeed) return 1;
  return (b.winPct ?? 0) - (a.winPct ?? 0)
    || (b.totalWins ?? 0) - (a.totalWins ?? 0)
    || (b.netPts ?? 0) - (a.netPts ?? 0);
}

function topSeeds(standings, conferenceName, teams) {
  const list = standings.filter(s => (s.conferenceName || '').toLowerCase().includes(conferenceName));
  if (!list.length) return Array.from({ length: 7 }, (_, i) => `${i + 1}) N/A`);
  list.sort(seedSort);
  const seeds = list.slice(0, 7).map((s, idx) => {
    const name = teams[s.teamId] || 'Team';
    const record = formatRecord(s);
    const seed = s.seed || idx + 1;
    return `${seed}) ${name} — ${record}`;
  });
  while (seeds.length < 7) seeds.push(`${seeds.length + 1}) N/A`);
  return seeds;
}

export async function updatePlayoffPicture(client, leagueId) {
  const snapshot = loadSnapshot(leagueId);
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const displayWeek = seasonInfo.displayWeek ?? seasonInfo.seasonWeek ?? 0;
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const hasSeasonData = (snapshot?.weeklyStats || []).some(w => Number(w.weekIndex ?? -1) >= 0) || standings.length > 0;
  const inPreseason = displayWeek <= 0 && !hasSeasonData;
  if (inPreseason) {
    await resetPlayoffPicture(client);
    return;
  }
  const emojiMap = loadEmojiMap();
  const teams = teamNameMap(snapshot, emojiMap);

  const afcSeeds = topSeeds(standings, 'afc', teams);
  const nfcSeeds = topSeeds(standings, 'nfc', teams);

  const channelMap = loadChannelMap();
  const channelId = channelMap['Playoff Picture'];
  if (!channelId) throw new Error('Playoff Picture channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Playoff Picture channel not accessible');

  const embed = {
    title: 'Madden Playoff Picture',
    color: 0x00b0f4,
    fields: [
      { name: 'AFC', value: afcSeeds.join('\n'), inline: true },
      { name: 'NFC', value: nfcSeeds.join('\n'), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('playoff_picture');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) {
    console.warn('[playoff_picture] pin not found; skipping create');
    return;
  }
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);
}

export async function resetPlayoffPicture(client) {
  const channelMap = loadChannelMap();
  const channelId = channelMap['Playoff Picture'];
  if (!channelId) throw new Error('Playoff Picture channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Playoff Picture channel not accessible');

  const embed = {
    title: 'Madden Playoff Picture',
    description: 'Preseason — playoff picture will appear once the regular season starts.',
    color: 0x00b0f4,
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('playoff_picture');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) {
    console.warn('[playoff_picture] pin not found; skipping create');
    return;
  }
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);
}

export default { updatePlayoffPicture };
