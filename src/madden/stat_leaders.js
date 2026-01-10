import fs from 'fs';
import path from 'path';
import { getPinId, setPinId } from './pins_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadSnapshot(leagueId) {
  const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function teamMap(snapshot, emojiMap) {
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

function teamEmoji(name, emojiMap) {
  if (!name) return '';
  const target = name.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(emojiMap || {})) {
    const base = key.toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<:${key.replace(/\\s+/g, '')}:${val}>`;
    }
  }
  return '';
}

function shortName(fullName) {
  if (!fullName) return 'Unknown';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'jr.', 'sr.']);
  let last = parts.pop();
  let suffix = '';
  if (last && suffixes.has(last.toLowerCase())) {
    suffix = last;
    last = parts.pop();
  }
  const first = parts[0]?.[0] || '';
  const lastPortion = suffix ? `${last} ${suffix}` : last;
  return `${first}. ${lastPortion}`;
}

function sumCategory(weeklyStats, key, listKey, fields) {
  const agg = new Map();
  weeklyStats.forEach(wk => {
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

function topDefenseSacks(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'defense', 'playerDefensiveStatInfoList', ['defSacks', 'defTacklesForLoss', 'defTotalTackles']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.defSacks ?? 0) - (a.totals.defSacks ?? 0)
    || (b.totals.defTacklesForLoss ?? 0) - (a.totals.defTacklesForLoss ?? 0)
    || (b.totals.defTotalTackles ?? 0) - (a.totals.defTotalTackles ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — SACK ${p.totals.defSacks ?? 0}, TFL ${p.totals.defTacklesForLoss ?? 0}, TAK ${p.totals.defTotalTackles ?? 0}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topDefenseCoverage(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'defense', 'playerDefensiveStatInfoList', ['defInts', 'defPassDeflections', 'defTotalTackles']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.defInts ?? 0) - (a.totals.defInts ?? 0)
    || (b.totals.defPassDeflections ?? 0) - (a.totals.defPassDeflections ?? 0)
    || (b.totals.defTotalTackles ?? 0) - (a.totals.defTotalTackles ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — INT ${p.totals.defInts ?? 0}, PD ${p.totals.defPassDeflections ?? 0}, TAK ${p.totals.defTotalTackles ?? 0}`;
  });
  while (lines.length < 10) lines.push(`${lines.length + 1}. N/A`);
  return lines;
}

function topDefenseTackles(weeklyStats, teams) {
  const agg = sumCategory(weeklyStats, 'defense', 'playerDefensiveStatInfoList', ['defTotalTackles', 'defSoloTackles', 'defInts']);
  const arr = Array.from(agg.values());
  arr.sort((a, b) => (b.totals.defTotalTackles ?? 0) - (a.totals.defTotalTackles ?? 0)
    || (b.totals.defSoloTackles ?? 0) - (a.totals.defSoloTackles ?? 0)
    || (b.totals.defInts ?? 0) - (a.totals.defInts ?? 0));
  const lines = arr.slice(0, 10).map((p, i) => {
    const team = teams[p.teamId] || '—';
    const name = `${shortName(p.fullName)} (${team})`;
    return `${i + 1}. ${name} — TAK ${p.totals.defTotalTackles ?? 0}, SOLO ${p.totals.defSoloTackles ?? 0}, INT ${p.totals.defInts ?? 0}`;
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
  const emojiMap = loadJson(TEAM_EMOJIS_FILE, {});
  const teams = teamMap(snapshot, emojiMap);
  const weeklyStats = snapshot?.weeklyStats || [];
  const fields = [];

  const sections = [
    ['Passing', topPassing],
    ['Rushing', topRushing],
    ['Receiving', topReceiving],
    ['Defense (Sacks/TFL)', topDefenseSacks],
    ['Defense (INT/PD)', topDefenseCoverage],
    ['Defense (Tackles)', topDefenseTackles],
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

  const pinId = getPinId('stat_leaders');
  if (pinId) {
    const msg = await channel.messages.fetch(pinId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  }
  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch { /* ignore */ }
  setPinId('stat_leaders', msg.id);
}
