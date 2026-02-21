import { ButtonInteraction, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  loadActiveTrades,
  saveActiveTrades,
  loadTradeCounts,
  saveTradeCounts,
  incrementTradeCounts,
  updateTradeCountsEmbed,
} from '../shared/madden_trade_utils.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

const VALUE_THRESHOLD = 50;

function formatValueSummary(sendTotal, recvTotal, gap, flip = false) {
  const youSend = flip ? recvTotal : sendTotal;
  const theySend = flip ? sendTotal : recvTotal;
  const netRaw = typeof gap === 'number' ? gap : (Number(sendTotal) - Number(recvTotal));
  const net = flip ? -netRaw : netRaw;
  const direction = net === 0 ? 'even' : net > 0 ? 'you send more value' : 'they send more value';
  const netLabel = net === 0 ? 'Net: even' : `Net: ${net > 0 ? '+' : ''}${Number(net).toFixed(1)} (${direction})`;
  const gapAbs = Math.abs(net);
  const thresholdLine = gapAbs <= VALUE_THRESHOLD
    ? `Value check: within limit (gap ${gapAbs.toFixed(1)} ≤ ${VALUE_THRESHOLD})`
    : `Value check: exceeds limit (gap ${gapAbs.toFixed(1)} > ${VALUE_THRESHOLD})`;
  return [
    `You send: ${Number(youSend).toFixed(1)}`,
    `They send: ${Number(theySend).toFixed(1)}`,
    netLabel,
    thresholdLine,
  ].join('\n');
}

function committeeValueText(trade) {
  const sendTotal = Number(trade.sendTotal || 0);
  const recvTotal = Number(trade.recvTotal || 0);
  const net = typeof trade.valueGap === 'number' ? trade.valueGap : (sendTotal - recvTotal);
  if (net === 0) return 'Value gap: even';
  const giver = net > 0 ? (trade.yourTeam || 'One side') : (trade.otherTeam || 'One side');
  const receiver = net > 0 ? (trade.otherTeam || 'other side') : (trade.yourTeam || 'other side');
  const diff = Math.abs(net).toFixed(1);
  return `Value gap: ${giver} sending ${diff} more than ${receiver} (${sendTotal.toFixed(1)} vs ${recvTotal.toFixed(1)})`;
}

function applyCommitteeValueSummary(embed, trade) {
  const fields = embed.data?.fields ? [...embed.data.fields] : [];
  const idx = fields.findIndex(f => f.name === 'Trade Value Check');
  const value = committeeValueText(trade);
  if (idx >= 0) fields[idx] = { ...fields[idx], value };
  else fields.push({ name: 'Trade Value Check', value });
  embed.setFields(fields);
  return embed;
}

function hasTradeCapacity(counts, teams, max = 5) {
  return teams.every(t => (counts[t] || 0) < max);
}

function buildEmbed(trade, tradeId, status, actor) {
  const colors = { approved: 0x3ba55d, denied: 0xed4245 };
  const title = status === 'approved' ? 'Trade Approved' : 'Trade Denied';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .addFields(
      { name: 'Teams', value: `${trade.yourTeam} ↔ ${trade.otherTeam}` },
      { name: 'Assets Sent', value: trade.assetsSent || '—' },
      { name: 'Assets Received', value: trade.assetsReceived || '—' },
    )
    .setColor(colors[status] || 0x5865f2)
    .setTimestamp(new Date())
    .setFooter({ text: `Trade ID ${tradeId}${actor ? ` • ${actor}` : ''}` });
  if (trade.sendTotal !== undefined && trade.recvTotal !== undefined) {
    embed.addFields({
      name: 'Trade Value Check',
      value: formatValueSummary(trade.sendTotal, trade.recvTotal, trade.valueGap, false),
    });
  }
  if (trade.notes) embed.addFields({ name: 'Notes', value: trade.notes });
  return embed;
}

async function deletePendingMessage(client, channelMap, trade) {
  if (!trade?.pendingMsgId) return;
  const pendingId = channelMap['Pending Trades'];
  if (!pendingId) return;
  const channel = await client.channels.fetch(pendingId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const msg = await channel.messages.fetch(trade.pendingMsgId).catch(() => null);
  if (msg) await msg.delete().catch(() => null);
}

export const customId = /^mtrade_b_(approve|deny)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  if (!customId.test(interaction.customId)) return;
  // Ephemeral replies are only supported in guilds; fallback to a normal defer in DMs
  const deferOptions = interaction.inGuild() ? { ephemeral: true } : {};
  try {
    await interaction.deferReply(deferOptions);
  } catch (err) {
    console.error('Failed to defer trade DM response interaction:', err);
    return;
  }

  const tradeId = interaction.customId.replace('mtrade_b_approve_', '').replace('mtrade_b_deny_', '');
  const trades = loadActiveTrades();
  const trade = trades[tradeId];
  if (!trade) {
    await interaction.editReply({ content: 'Trade not found or already processed.' });
    return;
  }
  if (trade.status && trade.status !== 'awaiting_coach_b') {
    await interaction.editReply({ content: `This trade has already been ${trade.status}.` });
    return;
  }
  if (trade.expiresAt && Date.now() > trade.expiresAt) {
    trade.status = 'expired';
    trades[tradeId] = trade;
    saveActiveTrades(trades);
    await interaction.editReply({ content: 'Trade expired (no response within 24h).' });
    return;
  }

  const channelMap = loadChannelMap();
  const roleMap = loadRoleMap();
  const committeeRoleId = '1460399406737002579';
  const committeeMention = `<@&${committeeRoleId}> `;
  // Only ping Trade Committee for voting; do not tag Ghost Legacy here
  const ghostRoleId = null;
  const ghostMention = '';
  const actor = interaction.user?.tag || interaction.user?.username;

  if (interaction.customId.startsWith('mtrade_b_deny_')) {
    trade.status = 'denied';
    trade.closedAt = Date.now();
    trades[tradeId] = trade;
    saveActiveTrades(trades);
    const embed = buildEmbed(trade, tradeId, 'denied', actor);
    // DM proposer only
    if (trade.proposerId) {
      try {
        const userA = await interaction.client.users.fetch(trade.proposerId);
        await userA.send({ embeds: [embed], content: 'Your trade was denied by the other coach.' }).catch(() => null);
      } catch { }
    }
    await deletePendingMessage(interaction.client, channelMap, trade);
    await interaction.editReply({ content: 'Trade denied and proposer notified.' });
    return;
  }

  // Enforce trade limit (5 per team per season)
  const counts = loadTradeCounts();
  const teamsInTrade = [trade.yourTeam, trade.otherTeam].filter(Boolean);
  if (!hasTradeCapacity(counts, teamsInTrade, 5)) {
    await interaction.editReply({ content: 'Trade blocked: one of the teams has reached the 5-trade limit for this season.' });
    if (trade.proposerId) {
      try {
        const userA = await interaction.client.users.fetch(trade.proposerId);
        await userA.send({ content: 'Your trade was blocked because one of the teams has already made 5 trades this season.' }).catch(() => null);
      } catch { }
    }
    return;
  }

  // Approve by Coach B -> send to committee
  trade.status = 'committee';
  trade.closedAt = Date.now();
  trade.approvedBy = interaction.user?.id;
  trades[tradeId] = trade;
  saveActiveTrades(trades);

  const embed = buildEmbed(trade, tradeId, 'approved', actor);
  const committeeId = channelMap['Trade Committee'];
  let committeeMsgId = null;
  if (!committeeId) {
    console.error('[madden_trade_dm_response] No Trade Committee channel configured in channel map.');
    await interaction.editReply({ content: 'Trade approved by other coach, but committee channel is not configured. Please ping an admin.' });
    return;
  }

  const committeeChan = await interaction.client.channels.fetch(committeeId).catch((err) => {
    console.error('[madden_trade_dm_response] Failed to fetch committee channel:', err);
    return null;
  });
  if (committeeChan?.isTextBased()) {
    const approveBtn = new ButtonBuilder().setCustomId(`mtrade_c_approve_${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder().setCustomId(`mtrade_c_deny_${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);
    embed.setDescription(`${committeeMention ? `${committeeMention.trim()}\n` : ''}Trade ID: ${tradeId}`);
    applyCommitteeValueSummary(embed, trade);
    const msg = await committeeChan.send({
      // Mention lives in the embed so it still pings the committee role without doubling in content
      content: null,
      embeds: [embed],
      components: [row],
      allowedMentions: {
        // Explicitly mention only the committee + optional ghost role (no implicit parsing)
        parse: [],
        roles: [committeeRoleId, ghostRoleId].filter(Boolean).map(String),
      },
    }).catch((err) => {
      console.error('[madden_trade_dm_response] Failed to send trade to committee channel:', err);
      return null;
    });
    committeeMsgId = msg?.id || null;
  } else {
    console.error('[madden_trade_dm_response] Committee channel not text based or not found:', committeeId);
  }

  if (!committeeMsgId) {
    await interaction.editReply({ content: 'Trade approved by other coach, but I could not post it to the committee channel. Please ping an admin.' });
    return;
  }
  trade.committeeMsgId = committeeMsgId;
  trades[tradeId] = trade;
  saveActiveTrades(trades);

  await deletePendingMessage(interaction.client, channelMap, trade);
  // DM proposer that Coach B approved
  if (trade.proposerId) {
    try {
      const userA = await interaction.client.users.fetch(trade.proposerId);
      await userA.send({ content: `Your trade with ${trade.otherTeam} was approved by the other coach and sent to committee.`, embeds: [embed] }).catch(() => null);
    } catch { }
  }
  await interaction.editReply({ content: 'Trade approved by other coach and sent to committee.' });
}

export default { customId, execute };
