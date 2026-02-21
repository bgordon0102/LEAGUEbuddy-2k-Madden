import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const ACTIVE_TRADES_FILE = path.join(process.cwd(), 'data', 'activeTrades.json');
const TRADE_COUNTS_FILE = path.join(process.cwd(), 'data', '2k', 'trade_counts.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', '2k', 'team_emojis.json');
const PINS_FILE = path.join(process.cwd(), 'data', '2k', 'pins.json');

// Channel and message provided by user for the trade counts message (do not recreate)
const TRADE_COUNT_CHANNEL_ID = '1425555600330326016';
const TRADE_COUNT_MESSAGE_ID = process.env.TRADE_COUNT_MESSAGE_ID || '1470803938327658509';

function loadPins() {
  try { return JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')); } catch { return {}; }
}
function savePins(pins) {
  fs.mkdirSync(path.dirname(PINS_FILE), { recursive: true });
  fs.writeFileSync(PINS_FILE, JSON.stringify(pins ?? {}, null, 2));
}
function getPinId(key) {
  const pins = loadPins();
  return pins[key] || null;
}
function setPinId(key, id) {
  const pins = loadPins();
  pins[key] = id;
  savePins(pins);
}

export function loadActiveTrades2k() {
  try {
    return JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
  } catch {
    fs.mkdirSync(path.dirname(ACTIVE_TRADES_FILE), { recursive: true });
    fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify({}, null, 2));
    return {};
  }
}

export function loadTradeCounts2k() {
  try {
    return JSON.parse(fs.readFileSync(TRADE_COUNTS_FILE, 'utf8'));
  } catch {
    fs.mkdirSync(path.dirname(TRADE_COUNTS_FILE), { recursive: true });
    fs.writeFileSync(TRADE_COUNTS_FILE, JSON.stringify({}, null, 2));
    return {};
  }
}

export function saveTradeCounts2k(counts) {
  fs.mkdirSync(path.dirname(TRADE_COUNTS_FILE), { recursive: true });
  fs.writeFileSync(TRADE_COUNTS_FILE, JSON.stringify(counts ?? {}, null, 2));
}

export function computeApprovedTradeCounts2k(trades) {
  const counts = {};
  Object.values(trades || {}).forEach(tr => {
    if (tr?.status !== 'approved') return;
    [tr.yourTeam, tr.otherTeam].forEach(t => {
      if (!t) return;
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return counts;
}

export function incrementTradeCounts2k(counts, teams) {
  teams.forEach(t => {
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

export async function updateTradeCountsEmbed2k(client, counts) {
  const channelId = TRADE_COUNT_CHANNEL_ID;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const teamEmojis = (() => {
    try { return JSON.parse(fs.readFileSync(TEAM_EMOJIS_FILE, 'utf8')); } catch { return {}; }
  })();

  const allTeams = Array.from(new Set([...Object.keys(teamEmojis), ...Object.keys(counts || {})])).sort((a,b)=>a.localeCompare(b));
  const lines = allTeams.map(team => {
    const cnt = counts[team] || 0;
    const emojiId = teamEmojis[team];
    const emoji = emojiId ? `<:${team.replace(/\s+/g,'')}:${emojiId}>` : '';
    return `${emoji ? emoji + ' ' : ''}${team}: ${cnt}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Trade Counts (2K)')
    .setDescription(lines.length ? lines.join('\n') : 'No trades yet.')
    .setColor(0x00b0f4)
    .setTimestamp(new Date());

  // Only update the known message ID; do not create new pins
  const targetId = TRADE_COUNT_MESSAGE_ID || getPinId('trade_counts_2k');
  if (!targetId) return;
  const msg = await channel.messages.fetch(targetId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);
}
