import fs from 'fs';
import path from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { brandTitle } from './madden_branding.js';

const QUEUE_FILE = path.join(process.cwd(), 'data', 'madden', 'content_review_queue.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

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

function getReviewChannelId(channelMap = {}) {
  return channelMap['LG Logs'] || channelMap['League Staff'] || null;
}

export function loadContentQueue() {
  return safeReadJSON(QUEUE_FILE, {});
}

export function saveContentQueue(data) {
  saveJSON(QUEUE_FILE, data || {});
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
  const staffChannelId = getReviewChannelId(channelMap);
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

export default { queueMaddenContentReview, loadContentQueue, saveContentQueue };
