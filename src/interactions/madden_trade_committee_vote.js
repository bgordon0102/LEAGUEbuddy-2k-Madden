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

function formatValueSummary(sendTotal, recvTotal, gap) {
  const net = typeof gap === 'number' ? gap : (Number(sendTotal) - Number(recvTotal));
  const direction = net === 0 ? 'even' : net > 0 ? 'you send more value' : 'you receive more value';
  const netLabel = net === 0 ? 'Net: even' : `Net: ${net > 0 ? '+' : ''}${Number(net).toFixed(1)} (${direction})`;
  return [
    `You send: ${Number(sendTotal).toFixed(1)}`,
    `They send: ${Number(recvTotal).toFixed(1)}`,
    netLabel,
  ].join('\n');
}

function formatCommitteeValueSummary(trade) {
  const sendTotal = Number(trade.sendTotal);
  const recvTotal = Number(trade.recvTotal);
  const net = typeof trade.valueGap === 'number' ? trade.valueGap : (sendTotal - recvTotal);
  const giver = net > 0 ? trade.yourTeam : trade.otherTeam;
  const diff = Math.abs(net);
  const headline = net === 0
    ? 'Value gap: even'
    : `Value gap: ${giver || 'One side'} sending ${diff.toFixed(1)} more value`;
  return [
    `You send: ${sendTotal.toFixed(1)}`,
    `They send: ${recvTotal.toFixed(1)}`,
    headline,
  ].join('\n');
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
      value: formatCommitteeValueSummary(trade),
    });
    // Detailed value breakdown if available
    if (Array.isArray(trade.assetsSentDetails) || Array.isArray(trade.assetsReceivedDetails)) {
      let sentBreakdown = '';
      let recvBreakdown = '';
      if (Array.isArray(trade.assetsSentDetails)) {
        sentBreakdown = trade.assetsSentDetails.map(a => `- ${a.name}: ${a.value}`).join('\n');
      }
      if (Array.isArray(trade.assetsReceivedDetails)) {
        recvBreakdown = trade.assetsReceivedDetails.map(a => `- ${a.name}: ${a.value}`).join('\n');
      }
      if (sentBreakdown) {
        embed.addFields({ name: 'Your Side Value Breakdown', value: sentBreakdown });
      }
      if (recvBreakdown) {
        embed.addFields({ name: 'Other Side Value Breakdown', value: recvBreakdown });
      }
    }
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

function teamRoleId(teamName, roleMap) {
  if (!teamName) return null;
  const target = (teamName || '').toLowerCase();
  for (const [key, val] of Object.entries(roleMap)) {
    if (!key.endsWith(' Coach')) continue;
    const base = key.replace(/ Coach$/, '').toLowerCase();
    if (base === target) return val;
  }
  return null;
}

export const customId = /^mtrade_c_(approve|deny)_/;

export async function execute(interaction) {
  console.log('Trade committee vote execute called');
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
  const coachRoleId = roleMap['Ghost Legacy'];
  const coachRoleMention = coachRoleId ? `<@&${coachRoleId}> ` : '';
  const committeeRoleId = '1460399406737002579';
  // Only tag Ghost Legacy + the two team roles on final approve/deny
  const teamMentions = [
    teamRoleMention(trade.yourTeam, roleMap),
    teamRoleMention(trade.otherTeam, roleMap),
  ].filter(Boolean).join(' ');
  const channelMentions = `${coachRoleMention}${teamMentions}`.trim();
  const mentionRoleIds = [
    coachRoleId,
    teamRoleId(trade.yourTeam, roleMap),
    teamRoleId(trade.otherTeam, roleMap),
  ].filter(Boolean).map(String);

  const channelMap = loadChannelMap();
  const approvedId = channelMap['Approved trades'];
  const deniedId = channelMap['Denied trades'];

  // Permission: only Trade Committee role can vote
  const votingRoleId = committeeRoleId;
  if (votingRoleId && !interaction.member?.roles?.cache?.has(votingRoleId)) {
    await interaction.editReply({ content: 'Only Trade Committee members can vote on trades.' });
    return;
  }

  if (interaction.customId.startsWith('mtrade_c_deny_')) {
    trade.status = 'denied';
    trade.closedAt = Date.now();
    trades[tradeId] = trade;
    saveActiveTrades(trades);
    const embed = EmbedBuilder.from(buildEmbed(trade, tradeId, 'denied'))
      .setDescription(`${channelMentions ? `${channelMentions}\n` : ''}Trade ID: ${tradeId}`);
    if (deniedId) {
      const deniedChan = await interaction.client.channels.fetch(deniedId).catch(() => null);
      if (deniedChan?.isTextBased()) {
        await deniedChan.send({
          content: `Trade ID: ${tradeId}`,
          embeds: [embed],
          allowedMentions: {
            parse: [],
            roles: mentionRoleIds,
          },
        }).catch(() => null);
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
  const embed = EmbedBuilder.from(buildEmbed(trade, tradeId, 'approved'))
    .setDescription(`${channelMentions ? `${channelMentions}\n` : ''}Trade ID: ${tradeId}`);
  if (approvedId) {
    const approvedChan = await interaction.client.channels.fetch(approvedId).catch(() => null);
    if (approvedChan?.isTextBased()) {
      await approvedChan.send({
        // Mention stays in the embed so the tagged roles still ping without doubling in content
        content: `Trade ID: ${tradeId}`,
        embeds: [embed],
        allowedMentions: {
          parse: [],
          roles: mentionRoleIds,
        },
      }).catch((err) => {
        console.error('Error sending approved trade message:', err);
      });
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
