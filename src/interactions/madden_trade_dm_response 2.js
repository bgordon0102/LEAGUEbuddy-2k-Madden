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
} from '../utils/madden_trade_utils.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
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
  try { await interaction.deferReply({ ephemeral: true }); } catch { return; }

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
  const committeeRoleId = roleMap['Madden Trade Committe'] || roleMap['Madden Trade Committee'];
  const committeeMention = committeeRoleId ? `<@&${committeeRoleId}> ` : '';
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
      } catch {}
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
      } catch {}
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
  if (committeeId) {
    const committeeChan = await interaction.client.channels.fetch(committeeId).catch(() => null);
    if (committeeChan?.isTextBased()) {
      const approveBtn = new ButtonBuilder().setCustomId(`mtrade_c_approve_${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success);
      const denyBtn = new ButtonBuilder().setCustomId(`mtrade_c_deny_${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);
      embed.setDescription(`${committeeMention}Trade ID: ${tradeId}`);
      const msg = await committeeChan.send({
        embeds: [embed],
        components: [row],
      }).catch(() => null);
      committeeMsgId = msg?.id || null;
    }
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
    } catch {}
  }
  await interaction.editReply({ content: 'Trade approved by other coach and sent to committee.' });
}

export default { customId, execute };
