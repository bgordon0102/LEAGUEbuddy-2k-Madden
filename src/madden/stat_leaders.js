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

function teamMap(snapshot) {
  const map = {};
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  list.forEach(t => {
    if (!t.teamId) return;
    const name = [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
    map[t.teamId] = name || `Team ${t.teamId}`;
  });
  return map;
}

function shortName(fullName) {
  if (!fullName) return 'Unknown';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0][0] || '';
  const last = parts[parts.length - 1];
  return `${first}. ${last}`;
}

function sumCategory(weeklyStats, key, listKey, fields) {
  const agg = new Map();
  weeklyStats.forEach(wk => {
    if (Number(wk.stage) !== 1 && Number(wk.stageIndex) !== 1) return; // regular season only
    const list = wk?.[key]?.[listKey];
    if (!Array.isArray(list)) return;
    list.forEach(p => {
      const id = p.rosterId || `${p.fullName}-${p.teamId || ''}`;
      if (!id) return;
      const cur = agg.get(id) || { fullName: p.fullName || 'Unknown', teamId: p.teamId, totals: {} };
      fields.forEach(f => {
        const val = Number(p[f] ?? 0);
        cur.totals[f] = (cur.totals[f] || 0) + (Number.isFinite(val) ? val : 0);
      });
      agg.set(id, cur);
    });
  });
  return agg;
}

function topPassing(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'passing', 'playerPassingStatInfoList', ['passYds', 'passTDs', 'passInts']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.passYds ?? 0) - (a.totals.passYds ?? 0)
    || (b.totals.passTDs ?? 0) - (a.totals.passTDs ?? 0)
    || (a.totals.passInts ?? 0) - (b.totals.passInts ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — YDS ${Math.round(p.totals.passYds)}, TD ${p.totals.passTDs ?? 0}, INT ${p.totals.passInts ?? 0}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topRushing(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'rushing', 'playerRushingStatInfoList', ['rushYds', 'rushTDs', 'rushAtt']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.rushYds ?? 0) - (a.totals.rushYds ?? 0)
    || (b.totals.rushTDs ?? 0) - (a.totals.rushTDs ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    const avg = p.totals.rushAtt ? (p.totals.rushYds / p.totals.rushAtt).toFixed(1) : '0.0';
    return `${i + 1}. ${name} — YDS ${Math.round(p.totals.rushYds)}, TD ${p.totals.rushTDs ?? 0}, Y/A ${avg}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topReceiving(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'receiving', 'playerReceivingStatInfoList', ['recYds', 'recTDs', 'recCatches']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.recYds ?? 0) - (a.totals.recYds ?? 0)
    || (b.totals.recTDs ?? 0) - (a.totals.recTDs ?? 0)
    || (b.totals.recCatches ?? 0) - (a.totals.recCatches ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — YDS ${Math.round(p.totals.recYds)}, TD ${p.totals.recTDs ?? 0}, REC ${p.totals.recCatches ?? 0}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topDefense(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'defense', 'playerDefensiveStatInfoList', ['defTotalTackles', 'defSacks', 'defInts']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.defTotalTackles ?? 0) - (a.totals.defTotalTackles ?? 0)
    || (b.totals.defSacks ?? 0) - (a.totals.defSacks ?? 0)
    || (b.totals.defInts ?? 0) - (a.totals.defInts ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — TAK ${p.totals.defTotalTackles ?? 0}, SACK ${p.totals.defSacks ?? 0}, INT ${p.totals.defInts ?? 0}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topKicking(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'kicking', 'playerKickingStatInfoList', ['fGMade', 'fGAtt', 'fGLongest']);
  const arr = Array.from(agg.values()).map(p => {
    const made = p.totals.fGMade ?? 0;
    const att = p.totals.fGAtt ?? 0;
    return { ...p, pct: att ? (made / att) * 100 : 0 };
  });
  arr.sort((a, b) => (b.totals.fGMade ?? 0) - (a.totals.fGMade ?? 0)
    || (b.pct ?? 0) - (a.pct ?? 0)
    || (b.totals.fGLongest ?? 0) - (a.totals.fGLongest ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const made = p.totals.fGMade ?? 0;
    const att = p.totals.fGAtt ?? 0;
    const pct = att ? `${(p.pct).toFixed(1)}%` : '0%';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — FG ${made}/${att}, ${pct}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topPunting(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'punting', 'playerPuntingStatInfoList', ['puntYds', 'puntAtt', 'puntNetYds']);
  const arr = Array.from(agg.values()).map(p => {
    const att = p.totals.puntAtt ?? 0;
    return { ...p, avg: att ? (p.totals.puntYds / att) : 0, net: att ? (p.totals.puntNetYds / att) : 0 };
  });
  arr.sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0)
    || (b.net ?? 0) - (a.net ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const avg = (p.avg || 0).toFixed(1);
    const net = (p.net || 0).toFixed(1);
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — AVG ${avg}, NET ${net}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

export async function updateStatLeaders(client, leagueId) {
  const snapshot = loadSnapshot(leagueId);
  const teams = teamMap(snapshot);
  const weeklyStats = snapshot?.weeklyStats || [];
  const fields = [];

  const sections = [
    ['Passing', topPassing],
    ['Rushing', topRushing],
    ['Receiving', topReceiving],
    ['Defense', topDefense],
    ['Kicking', topKicking],
    ['Punting', topPunting],
  ];

  sections.forEach(([title, fn]) => {
    const lines = fn(weeklyStats, teams);
    fields.push({
      name: title,
      value: lines.length ? lines.join('\n') : 'No data yet.',
      inline: true,
    });
  });

  const channelMap = loadChannelMap();
  const channelId = channelMap['Stat Leaders'];
  if (!channelId) throw new Error('Stat Leaders channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Stat Leaders channel not accessible');

  const embed = {
    title: 'Madden Stat Leaders (Season-to-Date)',
    color: 0x00b0f4,
    fields,
    timestamp: new Date().toISOString(),
  };

  // Edit existing bot message; do not create new pins/messages if missing.
  try {
    const pins = await channel.messages.fetchPinned().catch(() => null);
    const botPin = pins ? pins.find(m => m.author.id === client.user.id) : null;
    if (botPin) {
      await botPin.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  // If no pin, try to find the latest bot-authored message in the channel and edit it.
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const botMsg = recent.find(m => m.author.id === client.user.id);
    if (botMsg) {
      await botMsg.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch { /* ignore */ }

  throw new Error('Stat Leaders message not found; run the pin_stat_leaders script once to create it.');
}
