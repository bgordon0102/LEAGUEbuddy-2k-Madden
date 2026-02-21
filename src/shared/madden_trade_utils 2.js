import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getPinId, setPinId } from '../madden/pins_store.js';

const ACTIVE_TRADES_FILE = path.join(process.cwd(), 'data', 'madden', 'active_trades.json');
const TRADE_COUNTS_FILE = path.join(process.cwd(), 'data', 'madden', 'trade_counts.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

export function canTrade(leagueId) {
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const wk = snapshot?.currentWeek ?? snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? 1;
    return Number(wk) < 13; // lock starting Week 13
  } catch {
    return true;
  }
}

export function loadActiveTrades() {
  try { return JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8')); } catch { return {}; }
}

export function saveActiveTrades(data) {
  fs.mkdirSync(path.dirname(ACTIVE_TRADES_FILE), { recursive: true });
  fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(data ?? {}, null, 2));
}

export function loadTradeCounts() {
  try { return JSON.parse(fs.readFileSync(TRADE_COUNTS_FILE, 'utf8')); } catch { return {}; }
}

export function saveTradeCounts(data) {
  fs.mkdirSync(path.dirname(TRADE_COUNTS_FILE), { recursive: true });
  fs.writeFileSync(TRADE_COUNTS_FILE, JSON.stringify(data ?? {}, null, 2));
}

export function incrementTradeCounts(counts, teams) {
  teams.forEach(t => {
    counts[t] = (counts[t] || 0) + 1;
  });
  return counts;
}

export async function updateTradeCountsEmbed(client, channelMap, counts) {
  const channelId = channelMap['Trade Counts'];
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const teamEmojis = (() => {
    try { return JSON.parse(fs.readFileSync(TEAM_EMOJIS_FILE, 'utf8')); } catch { return {}; }
  })();
  const roleMap = (() => {
    try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
  })();
  // Build full list with zeros for all teams we know
  const keys = Object.keys(teamEmojis).length ? Object.keys(teamEmojis) : Object.keys(counts || {});
  const allTeams = Array.from(new Set(keys));
  allTeams.sort((a, b) => (a || '').localeCompare(b || ''));

  const lines = allTeams.map(team => {
    const cnt = counts[team] || 0;
    const emojiId = teamEmojis[team];
    const emoji = emojiId ? `<:${team.replace(/\s+/g, '')}:${emojiId}>` : '';
    return `${emoji ? emoji + ' ' : ''}${team}: ${cnt}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Trade Counts')
    .setDescription(lines.length ? lines.join('\n') : 'No trades yet.')
    .setColor(0x00b0f4)
    .setTimestamp(new Date());

  try {
    const pins = await channel.messages.fetchPinned().catch(() => null);
    const botPin = pins ? pins.find(m => m.author.id === client.user.id) : null;
    if (botPin) {
      await botPin.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch {}

  try {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    const botMsg = recent ? recent.find(m => m.author.id === client.user.id) : null;
    if (botMsg) {
      await botMsg.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  } catch {}

  const pinId = getPinId('trade_counts');
  if (pinId) {
    const msg = await channel.messages.fetch(pinId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], content: null }).catch(() => null);
      return;
    }
  }
  const msg = await channel.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  setPinId('trade_counts', msg.id);
}
