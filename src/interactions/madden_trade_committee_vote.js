import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  loadActiveTrades,
  saveActiveTrades,
} from '../shared/madden_trade_utils.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from '../shared/madden_staff_ops.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const PENDING_PROOFS_PATH = path.join(process.cwd(), 'data', 'madden', 'pending_proofs.json');
const PROOF_CHANNEL_ID = '1482473294769684561'; // pending trades (upload proof)

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

function readPendingProofs() {
  try { return JSON.parse(fs.readFileSync(PENDING_PROOFS_PATH, 'utf8')); } catch { return {}; }
}
function writePendingProofs(data) {
  try { fs.writeFileSync(PENDING_PROOFS_PATH, JSON.stringify(data ?? {}, null, 2)); } catch { }
}

function getCoachRole(roleMap, teamName) {
  if (!teamName) return null;
  const mascot = teamName.split(' ').pop();
  const norm = `${mascot}`.toLowerCase().replace(/[^a-z0-9]/g, '') + 'coach';
  const entry = Object.entries(roleMap || {}).find(([name]) =>
    name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm
  );
  return entry ? entry[1] : null;
}

function formatAssetLines(items = []) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items
    .map((item) => `${item.name || 'Asset'} — ${Number(item.value || 0).toFixed(1)}`)
    .join('\n');
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

const VALUE_THRESHOLD = 50;

function formatCommitteeValueSummary(trade) {
  const sendTotal = Number(trade.sendTotal);
  const recvTotal = Number(trade.recvTotal);
  const net = typeof trade.valueGap === 'number' ? trade.valueGap : (sendTotal - recvTotal);
  const giver = net > 0 ? trade.yourTeam : trade.otherTeam;
  const receiver = net > 0 ? trade.otherTeam : trade.yourTeam;
  const diff = Math.abs(net);
  const headline = net === 0
    ? 'No advantage: trade is even by value.'
    : `${giver || 'One side'} is sending ${diff.toFixed(1)} more value than ${receiver || 'the other side'}.`;
  const thresholdLine = diff <= VALUE_THRESHOLD
    ? `Value check: within limit (gap ${diff.toFixed(1)} ≤ ${VALUE_THRESHOLD})`
    : `Value check: exceeds limit (gap ${diff.toFixed(1)} > ${VALUE_THRESHOLD})`;
  return [
    `${trade.yourTeam || 'Side A'} total: ${sendTotal.toFixed(1)}`,
    `${trade.otherTeam || 'Side B'} total: ${recvTotal.toFixed(1)}`,
    headline,
    thresholdLine,
  ].join('\n');
}

function buildEmbed(trade, tradeId, status) {
  const colors = { approved: 0x3ba55d, denied: 0xed4245, vote: 0x5865f2 };
  const titles = { approved: 'Trade Approved', denied: 'Trade Denied', vote: 'Trade Committee Vote' };
  const embed = new EmbedBuilder()
    .setTitle(titles[status] || titles.vote)
    .addFields(
      { name: 'Teams', value: `${trade.yourTeam} ↔ ${trade.otherTeam}` },
      {
        name: `${trade.yourTeam || 'Side A'} Sends`,
        value: `${formatAssetLines(trade.assetsSentDetails)}\nTotal: ${Number(trade.sendTotal || 0).toFixed(1)}`,
      },
      {
        name: `${trade.otherTeam || 'Side B'} Sends`,
        value: `${formatAssetLines(trade.assetsReceivedDetails)}\nTotal: ${Number(trade.recvTotal || 0).toFixed(1)}`,
      },
    )
    .setColor(colors[status] || colors.vote)
    .setTimestamp(new Date())
    .setFooter({ text: `Trade ID ${tradeId}` });
  if (trade.sendTotal !== undefined && trade.recvTotal !== undefined) {
    embed.addFields({
      name: 'Committee Value Check',
      value: formatCommitteeValueSummary(trade),
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

function normalizeTeam(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function teamRoleMention(teamName, roleMap) {
  if (!teamName) return '';
  const target = normalizeTeam(teamName);
  const mascot = normalizeTeam(teamName.split(/\s+/).pop());
  for (const [key, val] of Object.entries(roleMap)) {
    if (!key.endsWith(' Coach')) continue;
    const base = normalizeTeam(key.replace(/ Coach$/, ''));
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) return `<@&${val}>`;
  }
  return '';
}

function teamRoleId(teamName, roleMap) {
  if (!teamName) return null;
  const target = normalizeTeam(teamName);
  const mascot = normalizeTeam(teamName.split(/\s+/).pop());
  for (const [key, val] of Object.entries(roleMap)) {
    if (!key.endsWith(' Coach')) continue;
    const base = normalizeTeam(key.replace(/ Coach$/, ''));
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) return val;
  }
  return null;
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

  // Track votes
  trade.committeeVotes = trade.committeeVotes || { approve: [], deny: [] };
  const votes = trade.committeeVotes;
  const voterId = interaction.user.id;

  const hasRole = interaction.member?.roles?.cache?.has(votingRoleId);
  if (!hasRole) {
    await interaction.editReply({ content: 'Only Trade Committee members can vote on trades.' });
    return;
  }

  const approveVote = interaction.customId.startsWith('mtrade_c_approve_');
  const denyVote = interaction.customId.startsWith('mtrade_c_deny_');

  // Remove from opposite bucket
  votes.approve = (votes.approve || []).filter(id => id !== voterId);
  votes.deny = (votes.deny || []).filter(id => id !== voterId);
  if (approveVote) votes.approve.push(voterId);
  if (denyVote) votes.deny.push(voterId);

  const approveCount = votes.approve.length;
  const denyCount = votes.deny.length;
  const THRESHOLD = 3;

  let finalized = null;
  if (approveCount >= THRESHOLD) finalized = 'approved';
  if (denyCount >= THRESHOLD) finalized = 'denied';

  if (!finalized) {
    trades[tradeId] = trade;
    saveActiveTrades(trades);
    await interaction.editReply({
      content: `Vote recorded. Approve: ${approveCount}/${THRESHOLD}, Deny: ${denyCount}/${THRESHOLD}. Needs ${THRESHOLD} matching votes to finalize.`,
    });
    return;
  }

  trade.status = finalized;
  trade.closedAt = Date.now();
  trades[tradeId] = trade;
  saveActiveTrades(trades);

  const embed = EmbedBuilder.from(buildEmbed(trade, tradeId, finalized))
    .setDescription(`${channelMentions ? `${channelMentions}\n` : ''}Trade ID: ${tradeId}`);

  if (finalized === 'approved') {
    // Defer final approval until proof is submitted
    trade.status = 'approved_pending_proof';
    trades[tradeId] = trade;
    saveActiveTrades(trades);

    // Queue proof request
    const pending = readPendingProofs();
    pending[tradeId] = { trade };
    writePendingProofs(pending);

    const roleMap = loadRoleMap();
    const coachA = getCoachRole(roleMap, trade.yourTeam);
    const coachB = getCoachRole(roleMap, trade.otherTeam);
    const tags = [coachA && `<@&${coachA}>`, coachB && `<@&${coachB}>`].filter(Boolean).join(' ');

    const proofEmbed = new EmbedBuilder()
      .setTitle('Madden Proof Required')
      .setDescription('Upload a screenshot showing **Valid Trade** for this exact deal.')
      .addFields(
        { name: 'Your Team', value: trade.yourTeam || '—', inline: true },
        { name: 'Other Team', value: trade.otherTeam || '—', inline: true },
        { name: 'Assets Sent', value: trade.assetsSent || '—', inline: false },
        { name: 'Assets Received', value: trade.assetsReceived || '—', inline: false },
      )
      .setFooter({ text: `Trade ID ${tradeId}` })
      .setColor(0x57F287);

    try {
      const proofChan = await interaction.client.channels.fetch(PROOF_CHANNEL_ID).catch(() => null);
      if (proofChan?.isTextBased()) {
        await proofChan.send({
          content: `${tags} Trade approved by committee. Upload Madden proof below.`,
          embeds: [proofEmbed],
          components: [
            new (await import('discord.js')).ActionRowBuilder().addComponents(
              new (await import('discord.js')).ButtonBuilder().setCustomId(`trade_madden_proof|${tradeId}`).setLabel('Upload Madden Proof').setStyle((await import('discord.js')).ButtonStyle.Success),
              new (await import('discord.js')).ButtonBuilder().setCustomId(`trade_madden_cancel|${tradeId}`).setLabel('Cancel Trade').setStyle((await import('discord.js')).ButtonStyle.Danger),
            ),
          ],
          allowedMentions: {
            parse: [],
            roles: [coachA, coachB].filter(Boolean).map(String),
          },
        });
      }
    } catch (err) {
      console.error('[madden_trade_committee_vote] failed to send proof request:', err);
    }

    appendMaddenStaffLog({
      type: 'trade_approved_pending_proof',
      guildId: interaction.guildId,
      tradeId,
      yourTeam: trade.yourTeam,
      otherTeam: trade.otherTeam,
      approveCount,
    });
    await postMaddenStaffLog(
      interaction.client,
      interaction.guildId,
      'Trade Approved Pending Proof',
      `${trade.yourTeam} vs ${trade.otherTeam} cleared committee and is now waiting on proof.`,
      [{ name: 'Trade ID', value: tradeId }],
    ).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'trade approved pending proof').catch(() => null);

    await interaction.editReply({ content: `Trade approved pending proof upload. Trade ID: ${tradeId}` });
    return;
  }

  if (finalized === 'denied' && deniedId) {
    const deniedChan = await interaction.client.channels.fetch(deniedId).catch(() => null);
    if (deniedChan?.isTextBased()) {
      await deniedChan.send({
        content: `Trade ID: ${tradeId}`,
        embeds: [embed],
        allowedMentions: { parse: [], roles: mentionRoleIds },
      }).catch(() => null);
    }
  }

  await dmProposer(interaction.client, trade.proposerId, embed, `Your trade with ${trade.otherTeam} was ${finalized} by committee.`);
  appendMaddenStaffLog({
    type: 'trade_committee_finalized',
    guildId: interaction.guildId,
    tradeId,
    yourTeam: trade.yourTeam,
    otherTeam: trade.otherTeam,
    status: finalized,
  });
  await postMaddenStaffLog(
    interaction.client,
    interaction.guildId,
    'Trade Committee Decision',
    `${trade.yourTeam} vs ${trade.otherTeam} was ${finalized} by committee.`,
    [{ name: 'Trade ID', value: tradeId }],
  ).catch(() => null);
  await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'trade committee decision').catch(() => null);

  await interaction.editReply({ content: `Trade ${finalized} and logged (threshold ${THRESHOLD} votes).` });
}

export default { customId, execute };
