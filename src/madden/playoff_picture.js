import fs from 'fs';
import path from 'path';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadSnapshot(leagueId) {
  const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function teamNameMap(snapshot) {
  const map = {};
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  list.forEach(t => {
    if (!t.teamId) return;
    const name = [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
    map[t.teamId] = name || `Team ${t.teamId}`;
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
  const teams = teamNameMap(snapshot);
  const standings = snapshot?.standings?.teamStandingInfoList || [];

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

  // Edit existing bot message if present (pinned preferred)
  try {
    const pins = await channel.messages.fetchPinned().catch(() => null);
    const botPin = pins ? pins.find(m => m.author.id === client.user.id) : null;
    if (botPin) {
      await botPin.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  // Otherwise edit most recent bot message
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const botMsg = recent.find(m => m.author.id === client.user.id);
    if (botMsg) {
      await botMsg.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  // If none exists, post once and pin so future updates can edit
  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch { /* ignore */ }
}

export default { updatePlayoffPicture };
