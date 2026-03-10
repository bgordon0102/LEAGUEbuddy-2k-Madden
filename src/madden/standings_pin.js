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

function formatRecord(team) {
  const w = team?.totalWins ?? 0;
  const l = team?.totalLosses ?? 0;
  const t = team?.totalTies ?? 0;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
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

function groupByDivision(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const divisions = new Map();

  if (standings.length === 0) {
    // Fallback: build from teams list with default 0-0
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    teams.forEach(t => {
      const key = t.divName || 'Division';
      if (!divisions.has(key)) divisions.set(key, []);
      divisions.get(key).push({
        divisionName: t.divName,
        teamId: t.teamId,
        totalWins: 0,
        totalLosses: 0,
        totalTies: 0,
        winPct: 0,
        netPts: 0,
      });
    });
    return divisions;
  }

  standings.forEach(s => {
    const key = s.divisionName || 'Division';
    if (!divisions.has(key)) divisions.set(key, []);
    divisions.get(key).push(s);
  });
  return divisions;
}

function sortDivision(list) {
  const allZero = list.every(t => (t.totalWins ?? 0) === 0 && (t.totalLosses ?? 0) === 0 && (t.totalTies ?? 0) === 0);
  if (allZero) {
    // Alphabetical by team name placeholder (we inject name in caller)
    return list;
  }
  return list.sort((a, b) =>
    (b.winPct ?? 0) - (a.winPct ?? 0) ||
    (b.totalWins ?? 0) - (a.totalWins ?? 0) ||
    (b.netPts ?? 0) - (a.netPts ?? 0)
  );
}

export async function updateStandings(client, leagueId) {
  const snapshot = loadSnapshot(leagueId);
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const seasonWeekType = seasonInfo.seasonWeekType;
  const displayWeek = seasonInfo.displayWeek ?? seasonInfo.seasonWeek ?? 0;
  const hasSeasonData = (snapshot?.weeklyStats || []).some(w => Number(w.weekIndex ?? -1) >= 0) ||
    (snapshot?.standings?.teamStandingInfoList || []).length > 0;
  const inPreseason = (seasonWeekType === 0 || displayWeek <= 0) && !hasSeasonData;
  if (inPreseason) {
    await resetStandings(client);
    return;
  }
  const divisions = groupByDivision(snapshot);
  const emojiMap = loadEmojiMap();
  const teams = teamNameMap(snapshot, emojiMap);

  const afcDivs = {};
  const nfcDivs = {};
  const other = {};

  for (const [div, list] of divisions.entries()) {
    const sorted = sortDivision(list);
    const allZero = sorted.every(t => (t.totalWins ?? 0) === 0 && (t.totalLosses ?? 0) === 0 && (t.totalTies ?? 0) === 0);
    const sortedWithNames = allZero
      ? [...sorted].sort((a, b) => (teams[a.teamId] || '').localeCompare(teams[b.teamId] || ''))
      : sorted;
    const lines = sortedWithNames.map(t => {
      const name = teams[t.teamId] || 'Team';
      return `${name} — ${formatRecord(t)}`;
    });
    const lower = (div || '').toLowerCase();
    const value = lines.length ? lines.join('\n') : 'N/A';
    if (lower.includes('afc')) afcDivs[div] = value;
    else if (lower.includes('nfc')) nfcDivs[div] = value;
    else other[div] = value;
  }

  const orderAfc = ['AFC East', 'AFC North', 'AFC South', 'AFC West'];
  const orderNfc = ['NFC East', 'NFC North', 'NFC South', 'NFC West'];

  function buildConferenceBlock(divOrder, divMap) {
    const blocks = divOrder.map(d => {
      const body = divMap[d] || 'N/A';
      return `**${d}**\n${body}`;
    });
    return blocks.join('\n\n');
  }

  const afcBlock = buildConferenceBlock(orderAfc, afcDivs);
  const nfcBlock = buildConferenceBlock(orderNfc, nfcDivs);

  const fields = [
    { name: 'AFC', value: afcBlock, inline: true },
    { name: 'NFC', value: nfcBlock, inline: true },
  ];

  const channelMap = loadChannelMap();
  const channelId = channelMap['Standings'];
  if (!channelId) throw new Error('Standings channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Standings channel not accessible');

  const embed = {
    title: 'Madden Standings',
    color: 0x00b0f4,
    fields,
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('standings');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) {
    console.warn('[standings] pin not found; skipping create');
    return;
  }
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);
}

export async function resetStandings(client) {
  const channelMap = loadChannelMap();
  const channelId = channelMap['Standings'];
  if (!channelId) throw new Error('Standings channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Standings channel not accessible');

  const placeholder = {
    title: 'Madden Standings',
    description: 'Preseason — standings will appear here once the regular season starts.',
    color: 0x00b0f4,
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('standings');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [placeholder], content: null }).catch(() => null);
}

export default { updateStandings };
