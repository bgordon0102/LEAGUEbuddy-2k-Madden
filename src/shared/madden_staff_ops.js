import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { buildStoryContext, buildCommitteeReviewData, buildRumorMillItems } from '../madden/storytelling.js';
import { queueMaddenContentReview, loadContentQueue } from './madden_content_review_queue.js';
import { brandText, brandTitle } from './madden_branding.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'staff_activity_log.json');
const SCHEDULER_FILE = path.join(process.cwd(), 'data', 'madden', 'story_scheduler.json');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadChannelMap() {
  return safeReadJSON(CHANNEL_MAP_FILE, {});
}

function getOpsChannelId(channelMap = {}) {
  return channelMap['LG Logs'] || channelMap['League Staff'] || null;
}

function loadRoleMap() {
  return safeReadJSON(ROLE_MAP_FILE, {});
}

function truncate(text = '', max = 400) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function appendMaddenStaffLog(entry) {
  const current = safeReadJSON(LOG_FILE, []);
  const next = Array.isArray(current) ? current : [];
  next.push({ ts: Date.now(), ...entry });
  saveJSON(LOG_FILE, next.slice(-5000));
}

export async function postMaddenStaffLog(client, guildId, title, description, fields = []) {
  const channelMap = loadChannelMap();
  const opsChannelId = getOpsChannelId(channelMap);
  if (!opsChannelId) return;
  const channel = await client.channels.fetch(opsChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(brandTitle(title))
    .setDescription(description)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed] }).catch(() => null);
}

export async function postLeagueStaffOpsSnapshot(client, guildId, reason = 'update') {
  const channelMap = loadChannelMap();
  const opsChannelId = getOpsChannelId(channelMap);
  if (!opsChannelId) return;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const ctx = await buildStoryContext(guild, client);
  if (!ctx) return;
  const review = await buildCommitteeReviewData(ctx);
  const openTrades = [...review.pendingCoach, ...review.pendingCommittee, ...review.pendingProof]
    .slice(0, 6)
    .map((trade) => `${trade.tradeId}: ${trade.yourTeam} vs ${trade.otherTeam} (${String(trade.status).replace(/_/g, ' ')})`)
    .join('\n') || 'None right now.';
  const proofLines = review.proofEntries.slice(0, 5).map((entry) => `${entry.tradeId}: ${entry.yourTeam || 'Unknown'} vs ${entry.otherTeam || 'Unknown'}`).join('\n') || 'No proof items pending.';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(brandTitle('League Staff Ops Snapshot'))
    .setDescription(`Triggered by: ${reason}`)
    .addFields(
      {
        name: 'Trade Queue',
        value: [
          `Awaiting coach approval: ${review.pendingCoach.length}`,
          `In committee: ${review.pendingCommittee.length}`,
          `Approved pending proof: ${review.pendingProof.length}`,
          `Pending proof entries: ${review.proofEntries.length}`,
        ].join('\n'),
        inline: true,
      },
      { name: 'Open Trade Items', value: openTrades, inline: true },
      { name: 'Pending Proof Review', value: proofLines },
      { name: 'At-Risk Matchups', value: review.atRisk.length ? review.atRisk.join('\n') : 'No pending matchups currently flagging as high risk.' },
      { name: 'Sim Strike Leaders', value: review.strikeLeaders.length ? review.strikeLeaders.join('\n') : 'No meaningful sim-strike pressure yet.' },
    )
    .setTimestamp();

  const channel = await client.channels.fetch(opsChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  await channel.send({ embeds: [embed] }).catch(() => null);
}

function rumorFingerprint(items = []) {
  return items.map((item) => String(item || '').trim()).filter(Boolean).join('||');
}

function rumorItemFingerprint(item = '') {
  return String(item || '').trim().toLowerCase();
}

function pendingContentFingerprints(queue = {}, guildId, kind) {
  const fingerprints = new Set();
  for (const item of Object.values(queue || {})) {
    if (!item || item.guildId !== guildId || item.kind !== kind || item.status !== 'pending') continue;
    const embedDescription = item?.embeds?.[0]?.description || '';
    const content = [item.content || '', embedDescription].filter(Boolean).join('\n');
    const fingerprint = rumorItemFingerprint(content);
    if (fingerprint) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

function rotateRumorItems(items = [], startIndex = 0, maxItems = 2) {
  if (!items.length) return [];
  const rotated = [];
  const normalizedStart = Math.max(0, Number(startIndex) || 0) % items.length;
  for (let i = 0; i < items.length && rotated.length < maxItems; i += 1) {
    rotated.push(items[(normalizedStart + i) % items.length]);
  }
  return rotated;
}

function loadRecentRumorHistory(scheduler = {}, guildId) {
  const history = Array.isArray(scheduler?.rumorHistoryByGuild?.[guildId]) ? scheduler.rumorHistoryByGuild[guildId] : [];
  return history.slice(-10);
}

function saveRecentRumorHistory(scheduler = {}, guildId, items = []) {
  scheduler.rumorHistoryByGuild = scheduler.rumorHistoryByGuild || {};
  const current = loadRecentRumorHistory(scheduler, guildId);
  const next = [
    ...current,
    ...items.map((item) => ({
      key: String(item?.key || ''),
      category: String(item?.category || ''),
      queuedAt: Date.now(),
    })),
  ];
  scheduler.rumorHistoryByGuild[guildId] = next.slice(-20);
}

export async function queueScheduledRumorMill(client, guildId, force = false) {
  const scheduler = safeReadJSON(SCHEDULER_FILE, {});
  const queue = loadContentQueue();

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: 'Skipped rumor queue: guild not available.' });
    return false;
  }
  appendMaddenStaffLog({ type: 'rumor_queue_start', guildId, detail: 'Starting scheduled rumor queue build.' });
  const ctx = await buildStoryContext(guild, client);
  if (!ctx) {
    appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: 'Skipped rumor queue: story context unavailable.' });
    return false;
  }
  const recentRumorHistory = loadRecentRumorHistory(scheduler, guildId);
  const rumorItems = buildRumorMillItems(ctx, 12, {
    recentStoryKeys: recentRumorHistory.map((entry) => entry.key).filter(Boolean),
    recentCategories: recentRumorHistory.map((entry) => entry.category).filter(Boolean),
  });
  if (!rumorItems.length) {
    appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: 'Skipped rumor queue: no rumor items generated.' });
    return false;
  }

  const channelMap = loadChannelMap();
  const roleMap = loadRoleMap();
  const ghostRoleId = roleMap['Ghost Legacy'];
  if (!channelMap['Rumor Mill']) {
    appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: 'Skipped rumor queue: Rumor Mill channel not configured.' });
    return false;
  }

  const rumorCursorByGuild = scheduler.rumorCursorByGuild || {};
  const startIndex = Number(rumorCursorByGuild[guildId] || 0);
  const rumorWireItems = rotateRumorItems(rumorItems, startIndex, 3);
  const queuedThisRun = new Set();
  const alreadyPending = pendingContentFingerprints(queue, guildId, 'rumor_mill');
  let queuedCount = 0;
  for (const rumorText of rumorWireItems) {
    const fingerprint = rumorItemFingerprint(rumorText);
    if (fingerprint && queuedThisRun.has(fingerprint)) continue;
    if (fingerprint && alreadyPending.has(fingerprint)) continue;
    try {
      await queueMaddenContentReview(client, guildId, {
        kind: 'rumor_mill',
        createdBy: 'system',
        targetChannelId: channelMap['Rumor Mill'],
        content: ghostRoleId ? `<@&${ghostRoleId}>` : null,
        embeds: [
          {
            title: brandTitle('Madden Rumor Mill'),
            description: rumorText,
            color: 0xffb347,
            timestamp: new Date().toISOString(),
          },
        ],
        previewAllowedMentions: { parse: [] },
        postAllowedMentions: { parse: ['roles'] },
      });
    } catch (error) {
      appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: `Rumor queue send failed: ${error?.message || error}` });
      continue;
    }
    if (fingerprint) {
      queuedThisRun.add(fingerprint);
      queuedCount += 1;
    }
  }

  if (!queuedCount) {
    appendMaddenStaffLog({ type: 'rumor_queue_skip', guildId, detail: 'Skipped rumor queue: all rumor items failed or are already pending.' });
    return false;
  }
  scheduler.lastRumorQueuedAt = Date.now();
  scheduler.rumorCursorByGuild = rumorCursorByGuild;
  scheduler.rumorCursorByGuild[guildId] = rumorItems.length
    ? (startIndex + queuedCount) % rumorItems.length
    : 0;
  saveRecentRumorHistory(scheduler, guildId, rumorWireItems);
  saveJSON(SCHEDULER_FILE, scheduler);
  appendMaddenStaffLog({ type: 'rumor_queue', guildId, detail: `Scheduled rumor wire queued ${queuedCount} item(s) for approval.` });
  await postMaddenStaffLog(client, guildId, 'Rumor Queue', `Scheduled Madden rumor wire queued ${queuedCount} item(s) for approval.`);
  return true;
}

export function initMaddenStoryScheduler(client) {
  const run = async () => {
    for (const guild of client.guilds.cache.values()) {
      await queueScheduledRumorMill(client, guild.id).catch(() => null);
    }
  };
  const firstDelayMs = 5 * 60 * 1000;
  const intervalMs = 15 * 60 * 1000;
  setTimeout(run, firstDelayMs);
  setInterval(run, intervalMs);
}

export default {
  appendMaddenStaffLog,
  postMaddenStaffLog,
  postLeagueStaffOpsSnapshot,
  queueScheduledRumorMill,
  initMaddenStoryScheduler,
};
