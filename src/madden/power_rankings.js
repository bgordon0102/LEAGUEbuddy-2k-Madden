import fs from 'fs';
import path from 'path';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');

function loadSnapshot(leagueId) {
  const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
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

function rankTeams(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const allZero = standings.every(s => (s.totalWins ?? 0) === 0 && (s.totalLosses ?? 0) === 0 && (s.totalTies ?? 0) === 0);
  if (!standings.length || allZero) return [];
  const sorted = [...standings].sort((a, b) =>
    (b.winPct ?? 0) - (a.winPct ?? 0) ||
    (b.totalWins ?? 0) - (a.totalWins ?? 0) ||
    (b.netPts ?? 0) - (a.netPts ?? 0) ||
    (b.offTotalYds ?? 0) - (a.offTotalYds ?? 0)
  );
  return sorted.slice(0, 10);
}

function loadPrevRanks() {
  try {
    return JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveRanks(map) {
  fs.mkdirSync(path.dirname(RANKS_FILE), { recursive: true });
  fs.writeFileSync(RANKS_FILE, JSON.stringify(map, null, 2));
}

export async function updatePowerRankings(client, leagueId) {
  const snapshot = loadSnapshot(leagueId);
  const teams = teamNameMap(snapshot);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const coachRoleId = roleMap['Madden Coach'];
  const coachTag = coachRoleId ? `<@&${coachRoleId}>` : null;

  const ranked = rankTeams(snapshot);
  const prevMap = loadPrevRanks();
  const prev = prevMap[leagueId] || {};
  const fields = [];
  let lines = [];
  if (ranked.length === 0) {
    lines = Array.from({ length: 10 }, (_, i) => `${i + 1}) N/A`);
    // reset previous ranks for a fresh season
    prevMap[leagueId] = {};
    saveRanks(prevMap);
  } else {
    lines = ranked.map((s, idx) => {
      const name = teams[s.teamId] || 'Team';
      const rec = formatRecord(s);
      const currentRank = idx + 1;
      const prevRank = prev[s.teamId];
      let move = '(=)';
      if (prevRank === undefined) {
        move = '(new)';
      } else {
        const diff = prevRank - currentRank;
        if (diff > 0) move = `+${diff}`;
        else if (diff < 0) move = `${diff}`;
      }
      return `${currentRank}) ${name} — ${rec} ${move}`;
    });
    while (lines.length < 10) lines.push(`${lines.length + 1}) N/A`);
    // Save current ranks for next comparison
    const nextMap = { ...prevMap, [leagueId]: Object.fromEntries(ranked.map((s, idx) => [s.teamId, idx + 1])) };
    saveRanks(nextMap);
  }
  fields.push({ name: 'Top 10', value: lines.join('\n'), inline: false });

  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const channelId = channelMap['Power Rankings'];
  if (!channelId) throw new Error('Power Rankings channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Power Rankings channel not accessible');

  const embed = {
    title: 'Madden Power Rankings',
    color: 0xffcc00,
    fields,
    timestamp: new Date().toISOString(),
  };

  // Edit existing bot message if present (pinned preferred)
  try {
    const pins = await channel.messages.fetchPinned().catch(() => null);
    const botPin = pins ? pins.find(m => m.author.id === client.user.id) : null;
    if (botPin) {
      await botPin.edit({ embeds: [embed], content: coachTag || null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  // Otherwise edit most recent bot message
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const botMsg = recent.find(m => m.author.id === client.user.id);
    if (botMsg) {
      await botMsg.edit({ embeds: [embed], content: coachTag || null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  // If none exists, post once and pin so future updates can edit
  const msg = await channel.send({ content: coachTag || null, embeds: [embed] });
  try { await msg.pin(); } catch { /* ignore */ }
}

export default { updatePowerRankings };
