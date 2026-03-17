import fs from 'fs';
import path from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { brandTitle } from './madden_branding.js';
import { loadMaddenChannelMap } from './madden_metadata.js';

const QUEUE_FILE = path.join(process.cwd(), 'data', 'madden', 'content_review_queue.json');

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
  return loadMaddenChannelMap();
}

function getReviewChannelId(channelMap = {}, kind = '') {
  if (kind === 'rumor_mill') {
    return channelMap['LG Logs'] || channelMap['League Staff'] || null;
  }
  return channelMap['League Staff'] || channelMap['LG Logs'] || null;
}

const RUMOR_PENDING_TTL_MS = 10 * 60 * 60 * 1000;
const RUMOR_PENDING_TARGET = 6;
const RUMOR_PENDING_HARD_CAP = 10;

export function loadContentQueue() {
  return safeReadJSON(QUEUE_FILE, {});
}

export function saveContentQueue(data) {
  saveJSON(QUEUE_FILE, data || {});
}

export async function cleanupPendingRumorReviews(client, guildId) {
  const queue = loadContentQueue();
  const now = Date.now();
  const pendingRumors = Object.values(queue)
    .filter((item) => item && item.guildId === guildId && item.kind === 'rumor_mill' && item.status === 'pending')
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

  const toExpire = [];
  for (const item of pendingRumors) {
    if ((now - Number(item.createdAt || 0)) > RUMOR_PENDING_TTL_MS) toExpire.push(item);
  }

  const stillPending = pendingRumors.filter((item) => !toExpire.includes(item));
  const overflow = Math.max(0, stillPending.length - RUMOR_PENDING_HARD_CAP);
  if (overflow > 0) {
    toExpire.push(...stillPending.slice(0, overflow));
  }

  if (!toExpire.length) {
    return {
      expired: 0,
      pendingCount: pendingRumors.length,
      target: RUMOR_PENDING_TARGET,
      hardCap: RUMOR_PENDING_HARD_CAP,
    };
  }

  const channelMap = loadChannelMap();
  const reviewChannelId = getReviewChannelId(channelMap, 'rumor_mill');
  const reviewChannel = reviewChannelId ? await client.channels.fetch(reviewChannelId).catch(() => null) : null;

  for (const item of toExpire) {
    if (!item?.id || !queue[item.id]) continue;
    queue[item.id].status = 'expired';
    queue[item.id].reviewedAt = now;
    queue[item.id].reviewedBy = 'system';
    queue[item.id].reviewNote = 'Expired by rumor queue cleanup';
    if (reviewChannel?.isTextBased() && item.reviewMessageId) {
      await reviewChannel.messages.delete(item.reviewMessageId).catch(() => null);
    }
  }
  saveContentQueue(queue);

  const nextPending = Object.values(queue)
    .filter((item) => item && item.guildId === guildId && item.kind === 'rumor_mill' && item.status === 'pending')
    .length;

  return {
    expired: toExpire.length,
    pendingCount: nextPending,
    target: RUMOR_PENDING_TARGET,
    hardCap: RUMOR_PENDING_HARD_CAP,
  };
}

export function getRumorPendingPolicy() {
  return {
    ttlMs: RUMOR_PENDING_TTL_MS,
    target: RUMOR_PENDING_TARGET,
    hardCap: RUMOR_PENDING_HARD_CAP,
  };
}

function reviewButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_content_review|approve|${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`madden_content_review|deny|${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
}

function buildReviewMetaEmbed(item, guild) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(brandTitle('Content Review'))
    .setDescription(`Target: <#${item.targetChannelId}>`)
    .addFields(
      { name: 'Type', value: item.kind || 'content', inline: true },
      { name: 'Queued By', value: item.createdBy ? `<@${item.createdBy}>` : 'System', inline: true },
      { name: 'Server', value: guild?.name || 'Unknown', inline: true },
    )
    .setFooter({ text: `Review ID ${item.id}` })
    .setTimestamp(new Date(item.createdAt || Date.now()));
}

export async function queueMaddenContentReview(client, guildId, item) {
  const channelMap = loadChannelMap();
  const staffChannelId = getReviewChannelId(channelMap, item?.kind);
  if (!staffChannelId) throw new Error('LG Logs / League Staff channel is not configured.');
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const staffChannel = await client.channels.fetch(staffChannelId).catch(() => null);
  if (!staffChannel?.isTextBased()) throw new Error('LG Logs / League Staff channel is not accessible.');

  const queue = loadContentQueue();
  const id = item.id || `content_${Date.now()}`;
  const stored = {
    ...item,
    id,
    guildId,
    status: 'pending',
    createdAt: item.createdAt || Date.now(),
  };

  const sent = await staffChannel.send({
    content: item.content || null,
    embeds: [...(item.embeds || []), buildReviewMetaEmbed(stored, guild)],
    components: [reviewButtons(id)],
    allowedMentions: item.previewAllowedMentions || { parse: [] },
  });

  stored.reviewMessageId = sent.id;
  stored.staffChannelId = staffChannel.id;
  queue[id] = stored;
  saveContentQueue(queue);
  return stored;
}

export default { queueMaddenContentReview, loadContentQueue, saveContentQueue, cleanupPendingRumorReviews, getRumorPendingPolicy };
