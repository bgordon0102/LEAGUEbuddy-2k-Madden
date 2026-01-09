import { ButtonInteraction, EmbedBuilder } from 'discord.js';
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

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
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

export const customId = /^madden_trade_dm_(approve|deny)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  if (!customId.test(interaction.customId)) return;
  try { await interaction.deferReply({ ephemeral: true }); } catch { return; }

  const tradeId = interaction.customId.replace('madden_trade_dm_approve_', '').replace('madden_trade_dm_deny_', '');
  const trades = loadActiveTrades();
  const trade = trades[tradeId];
  if (!trade) {
    await interaction.editReply({ content: 'Trade not found or already processed.' });
    return;
  }
  if (trade.status && trade.status !== 'pending') {
    await interaction.editReply({ content: `This trade has already been ${trade.status}.` });
    return;
  }

  const channelMap = loadChannelMap();
  const actor = interaction.user?.tag || interaction.user?.username;

  if (interaction.customId.startsWith('madden_trade_dm_deny_')) {
    trade.status = 'denied';
    trade.closedAt = Date.now();
    trades[tradeId] = trade;
    saveActiveTrades(trades);

    const embed = buildEmbed(trade, tradeId, 'denied', actor);
    const deniedId = channelMap['Denied trades'];
    if (deniedId) {
      const deniedChan = await interaction.client.channels.fetch(deniedId).catch(() => null);
      if (deniedChan?.isTextBased()) {
        await deniedChan.send({ embeds: [embed] }).catch(() => null);
      }
    }
    await deletePendingMessage(interaction.client, channelMap, trade);
    await interaction.editReply({ content: 'Trade denied and logged.' });
    return;
  }

  // Approve
  trade.status = 'approved';
  trade.closedAt = Date.now();
  trade.approvedBy = interaction.user?.id;
  trades[tradeId] = trade;
  saveActiveTrades(trades);

  const embed = buildEmbed(trade, tradeId, 'approved', actor);
  const approvedId = channelMap['Approved trades'];
  if (approvedId) {
    const approvedChan = await interaction.client.channels.fetch(approvedId).catch(() => null);
    if (approvedChan?.isTextBased()) {
      await approvedChan.send({ embeds: [embed] }).catch(() => null);
    }
  }

  // Update trade counts
  const counts = incrementTradeCounts(loadTradeCounts(), [trade.yourTeam, trade.otherTeam]);
  saveTradeCounts(counts);
  await updateTradeCountsEmbed(interaction.client, channelMap, counts);

  await deletePendingMessage(interaction.client, channelMap, trade);
  await interaction.editReply({ content: 'Trade approved and recorded.' });
}

export default { customId, execute };
