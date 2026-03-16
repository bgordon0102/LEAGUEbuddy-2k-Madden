import fs from 'fs';
import path from 'path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { loadStrikeStore, ensureStrikeSeason, weightedCount, formatBreakdown, strikeHistory } from './madden_strikes.js';
import { brandTitle } from './madden_branding.js';
import { sendCoachReceipt } from './madden_coach_receipts.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const REVIEW_FILE = path.join(process.cwd(), 'data', 'madden', 'removal_reviews.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadChannelMap() {
  return readJson(CHANNEL_MAP_FILE, {});
}

function getReviewChannelId(channelMap = {}) {
  return channelMap['LG Logs'] || channelMap['League Staff'] || null;
}

function loadReviewState() {
  return readJson(REVIEW_FILE, {});
}

function formatHistory(history = []) {
  const strikeOnly = history.filter((entry) => entry?.kind === 'strike').slice(-10).reverse();
  if (!strikeOnly.length) return 'No strike history recorded.';
  return strikeOnly.map((entry) => {
    const date = new Date(entry.ts || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${date} • ${entry.label} • ${entry.weight}`;
  }).join('\n');
}

export async function queueRemovalReview(client, guildId, {
  seasonKey,
  userId,
  roleId,
  teamName,
} = {}) {
  if (!userId || !roleId || !seasonKey) return false;

  const channelMap = loadChannelMap();
  const staffChannelId = getReviewChannelId(channelMap);
  if (!staffChannelId) return false;
  const state = loadReviewState();
  const reviewKey = `${guildId}:${seasonKey}:${userId}:${roleId}`;
  if (state[reviewKey]?.status === 'pending') return false;

  const store = loadStrikeStore();
  const seasonData = ensureStrikeSeason(store, seasonKey);
  const total = weightedCount(seasonData, userId);
  if (total <= 5) return false;

  const historyText = formatHistory(strikeHistory(seasonData, userId));
  const breakdown = formatBreakdown(seasonData, userId);

  const channel = await client.channels.fetch(staffChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(brandTitle('Coach Removal Review'))
    .setDescription(`<@${userId}> has crossed the hard strike limit and is now in removal range.`)
    .addFields(
      { name: 'Coach', value: `<@${userId}>`, inline: true },
      { name: 'Team', value: teamName || 'Unknown', inline: true },
      { name: 'Total', value: `${total}/5`, inline: true },
      { name: 'Breakdown', value: breakdown || 'N/A' },
      { name: 'Strike Receipt', value: historyText },
      { name: 'Policy', value: '5.0 is the hard limit. The next strike puts the coach in removal review.' },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_remove_coach_role_review|${userId}|${roleId}`)
      .setLabel('Remove Coach Role')
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return false;

  state[reviewKey] = {
    status: 'pending',
    messageId: sent.id,
    channelId: staffChannelId,
    seasonKey,
    userId,
    roleId,
    teamName,
    total,
    createdAt: Date.now(),
  };
  saveJson(REVIEW_FILE, state);
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (guild) {
    await sendCoachReceipt(guild, [roleId], {
      title: 'Strike Limit Reached',
      description: `${teamName || 'Your team'} has crossed the hard strike limit and is now in removal review.`,
      fields: [
        { name: 'Total', value: `${total}/5` },
        { name: 'Strike Receipt', value: historyText },
      ],
      color: 0xED4245,
    }).catch(() => null);
  }
  return true;
}

export function markRemovalReviewResolved(guildId, seasonKey, userId, roleId) {
  const state = loadReviewState();
  const reviewKey = `${guildId}:${seasonKey}:${userId}:${roleId}`;
  if (!state[reviewKey]) return;
  state[reviewKey].status = 'resolved';
  state[reviewKey].resolvedAt = Date.now();
  saveJson(REVIEW_FILE, state);
}

export async function queueImmediateRemedyReview(client, guildId, {
  seasonKey,
  userId,
  roleId,
  teamName,
} = {}) {
  if (!userId || !roleId || !seasonKey) return false;
  const channelMap = loadChannelMap();
  const staffChannelId = getReviewChannelId(channelMap);
  if (!staffChannelId) return false;
  const state = loadReviewState();
  const reviewKey = `immediate:${guildId}:${seasonKey}:${userId}:${roleId}`;
  if (state[reviewKey]?.status === 'pending') return false;

  const store = loadStrikeStore();
  const seasonData = ensureStrikeSeason(store, seasonKey);
  const comm = seasonData.communication?.[userId] || {};
  const consecutiveSilent = Number(comm.consecutiveSilentWeeks) || 0;
  if (consecutiveSilent < 2) return false;

  const historyText = formatHistory(strikeHistory(seasonData, userId));
  const total = weightedCount(seasonData, userId);
  const breakdown = formatBreakdown(seasonData, userId);

  const channel = await client.channels.fetch(staffChannelId).catch(() => null);
  if (!channel?.isTextBased()) return false;

  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle(brandTitle('Immediate Remedy Review'))
    .setDescription(`<@${userId}> has logged ${consecutiveSilent} straight silent weeks and is flagged for immediate remedy review.`)
    .addFields(
      { name: 'Coach', value: `<@${userId}>`, inline: true },
      { name: 'Team', value: teamName || 'Unknown', inline: true },
      { name: 'Total', value: `${total}/5`, inline: true },
      { name: 'Breakdown', value: breakdown || 'Clean' },
      { name: 'Strike Receipt', value: historyText },
      { name: 'Policy', value: 'Two straight silent weeks triggers immediate remedy review, even before the hard limit.' },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_remove_coach_role_review|${userId}|${roleId}`)
      .setLabel('Remove Coach Role')
      .setStyle(ButtonStyle.Danger),
  );

  const sent = await channel.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return false;

  state[reviewKey] = {
    status: 'pending',
    messageId: sent.id,
    channelId: staffChannelId,
    seasonKey,
    userId,
    roleId,
    teamName,
    total,
    createdAt: Date.now(),
  };
  saveJson(REVIEW_FILE, state);

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (guild) {
    await sendCoachReceipt(guild, [roleId], {
      title: 'Immediate Remedy Review',
      description: `${teamName || 'Your team'} has been flagged for immediate remedy review after two straight silent weeks.`,
      fields: [
        { name: 'Total', value: `${total}/5` },
        { name: 'Strike Receipt', value: historyText },
      ],
      color: 0xED4245,
    }).catch(() => null);
  }
  return true;
}
