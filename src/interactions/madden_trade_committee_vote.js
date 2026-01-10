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
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

function buildEmbed(trade, tradeId, status) {
  const colors = { approved: 0x3ba55d, denied: 0xed4245, vote: 0x5865f2 };
  const titles = { approved: 'Trade Approved', denied: 'Trade Denied', vote: 'Trade Committee Vote' };
  const embed = new EmbedBuilder()
    .setTitle(titles[status] || titles.vote)
    .addFields(
      { name: 'Teams', value: `${trade.yourTeam} ↔ ${trade.otherTeam}` },
      { name: 'Assets Sent', value: trade.assetsSent || '—' },
      { name: 'Assets Received', value: trade.assetsReceived || '—' },
    )
    .setColor(colors[status] || colors.vote)
    .setTimestamp(new Date())
    .setFooter({ text: `Trade ID ${tradeId}` });
  if (trade.sendTotal !== undefined && trade.recvTotal !== undefined) {
    const gap = trade.valueGap ?? (trade.sendTotal - trade.recvTotal);
    embed.addFields({
      name: 'Trade Value Check',
      value: [
        `Your side total: ${Number(trade.sendTotal).toFixed(1)}`,
        `Other side total: ${Number(trade.recvTotal).toFixed(1)}`,
        gap === 0 ? 'Balance: even' : `Balance: ${gap > 0 ? '+' : ''}${Number(gap).toFixed(1)} (positive = you send more)`,
      ].join('\n'),
    });
  }
  if (trade.notes) embed.addFields({ name: 'Notes', value: trade.notes });
  return embed;
}

async function dmProposer(client, userId, embed, statusText) {
  if (!userId) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content: statusText, embeds: [embed] }).catch(() => null);
  } catch { /* ignore DM failures */ }
}

function teamRoleMention(teamName, roleMap) {
  if (!teamName) return '';
  const target = (teamName || '').toLowerCase();
  for (const [key, val] of Object.entries(roleMap)) {
    if (!key.endsWith(' Coach')) continue;
    const base = key.replace(/ Coach$/, '').toLowerCase();
    if (base === target) return `<@&${val}>`;
  }
  return '';
}

export const customId = /^mtrade_c_(approve|deny)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  if (!customId.test(interaction.customId)) return;
  try { await interaction.deferReply({ ephemeral: true }); } catch { return; }

  const tradeId = interaction.customId.replace('mtrade_c_approve_', '').replace('mtrade_c_deny_', '');
  const trades = loadActiveTrades();
  const trade = trades[tradeId];
  if (!trade) {
    await interaction.editReply({ content: 'Trade not found or already processed.' });
    return;
  }
  if (trade.status && (trade.status === 'approved' || trade.status === 'denied')) {
    await interaction.editReply({ content: `Trade already ${trade.status}.` });
    return;
  }

  const roleMap = loadRoleMap();
  const coachRoleMention = roleMap['Madden Coach'] ? `<@&${roleMap['Madden Coach']}> ` : '';
  const teamMentions = [
    teamRoleMention(trade.yourTeam, roleMap),
    teamRoleMention(trade.otherTeam, roleMap),
  ].filter(Boolean).join(' ');
  const channelMentions = `${coachRoleMention}${teamMentions}`.trim();

  const channelMap = loadChannelMap();
  const approvedId = channelMap['Approved trades'];
  const deniedId = channelMap['Denied trades'];

  // Permission: only Trade Committee role can vote
  const committeeRoleId = roleMap['Madden Trade Committe'] || roleMap['Madden Trade Committee'];
  if (committeeRoleId && !interaction.member?.roles?.cache?.has(committeeRoleId)) {
    await interaction.editReply({ content: 'Only Trade Committee members can vote on trades.' });
    return;
  }

  if (interaction.customId.startsWith('mtrade_c_deny_')) {
    trade.status = 'denied';
    trade.closedAt = Date.now();
    trades[tradeId] = trade;
    saveActiveTrades(trades);
    const embed = buildEmbed(trade, tradeId, 'denied');
    if (deniedId) {
      const deniedChan = await interaction.client.channels.fetch(deniedId).catch(() => null);
      if (deniedChan?.isTextBased()) {
        const tagged = channelMentions ? `${channelMentions} Trade ID: ${tradeId}` : `Trade ID: ${tradeId}`;
        const taggedEmbed = EmbedBuilder.from(embed).setDescription(tagged);
        await deniedChan.send({ embeds: [taggedEmbed] }).catch(() => null);
      }
    }
    await dmProposer(interaction.client, trade.proposerId, embed, `Your trade with ${trade.otherTeam} was denied by committee.`);
    await interaction.editReply({ content: 'Trade denied and logged.' });
    return;
  }

  // Approve
  trade.status = 'approved';
  trade.closedAt = Date.now();
  trades[tradeId] = trade;
  saveActiveTrades(trades);
  const embed = buildEmbed(trade, tradeId, 'approved');
  if (approvedId) {
    const approvedChan = await interaction.client.channels.fetch(approvedId).catch(() => null);
    if (approvedChan?.isTextBased()) {
      const tagged = channelMentions ? `${channelMentions} Trade ID: ${tradeId}` : `Trade ID: ${tradeId}`;
      const taggedEmbed = EmbedBuilder.from(embed).setDescription(tagged);
      await approvedChan.send({ embeds: [taggedEmbed] }).catch(() => null);
    }
  }
  // Update trade counts
  const counts = incrementTradeCounts(loadTradeCounts(), [trade.yourTeam, trade.otherTeam]);
  saveTradeCounts(counts);
  await updateTradeCountsEmbed(interaction.client, channelMap, counts);

  await dmProposer(interaction.client, trade.proposerId, embed, `Your trade with ${trade.otherTeam} was approved by committee.`);

  await interaction.editReply({ content: 'Trade approved and logged.' });
}

export default { customId, execute };
