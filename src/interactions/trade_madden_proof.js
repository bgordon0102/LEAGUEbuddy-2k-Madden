import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { loadActiveTrades, saveActiveTrades, loadTradeCounts, saveTradeCounts, updateTradeCountsEmbed, computeApprovedTradeCounts } from '../shared/madden_trade_utils.js';
import { addPickOverridesFromTrade } from '../madden/pick_overrides_store.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffDecision } from '../shared/madden_staff_ops.js';

const PENDING_PATH = path.join(process.cwd(), 'data', 'madden', 'pending_proofs.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function readPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')); } catch { return {}; }
}
function writePending(data) {
  try { fs.writeFileSync(PENDING_PATH, JSON.stringify(data ?? {}, null, 2)); } catch { }
}
function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}
function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
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
function getCommitteeRole(roleMap) {
  const entry = Object.entries(roleMap || {}).find(([name]) => /trade committee/i.test(name));
  return entry ? entry[1] : null;
}
function getStaffRoles(roleMap) {
  return Object.entries(roleMap || {})
    .filter(([k]) => /commish/i.test(k) || /ghost legacy$/i.test(k.trim()))
    .map(([, v]) => v)
    .filter(Boolean);
}

export const customId = /^(trade_madden_proof\|.+|trade_madden_cancel\|.+|trade_madden_committee\|(approve|deny)\|.+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [action, sub, maybeId] = interaction.customId.split('|');
  const roleMap = loadRoleMap();
  const committeeRole = getCommitteeRole(roleMap);
  const staffRoles = getStaffRoles(roleMap);
  const hasRole = (id) => interaction.member?.roles?.cache?.has(id);
  const isStaff = staffRoles.some(hasRole);
  const isCommittee = committeeRole ? hasRole(committeeRole) : false;

  // Committee approval/denial flow
  if (action === 'trade_madden_committee') {
    const vote = sub; const tradeId = maybeId;
    const pending = readPending();
    const entry = pending[tradeId];
    if (!entry?.trade) {
      await interaction.reply({ content: 'Trade not found or already processed.', flags: 64 });
      return;
    }
    if (!isStaff && !isCommittee) {
      await interaction.reply({ content: 'Only committee or staff can finalize proof.', flags: 64 });
      return;
    }
    const trade = entry.trade;
    const channelMap = loadChannelMap();
    const approvedChan = await interaction.client.channels.fetch(channelMap['Approved trades']).catch(() => null);
    const deniedChan = await interaction.client.channels.fetch(channelMap['Denied trades']).catch(() => null);

    // Load active trades to update status/counts
    const trades = loadActiveTrades();
    const activeTrade = trades[tradeId] || trade;

    if (vote === 'approve') {
      activeTrade.status = 'approved';
      activeTrade.closedAt = Date.now();
      try {
        addPickOverridesFromTrade({
          fromTeam: activeTrade.yourTeam,
          toTeam: activeTrade.otherTeam,
          fromAssets: activeTrade.yourStructAssets || [],
          toAssets: activeTrade.theirStructAssets || [],
          seasonYear: activeTrade.seasonYear,
        });
      } catch (err) {
        console.warn('[trade_madden_proof] could not persist pick overrides:', err?.message || err);
      }
      trades[tradeId] = activeTrade;
      saveActiveTrades(trades);

      const counts = computeApprovedTradeCounts(trades);
      saveTradeCounts(counts);
      await updateTradeCountsEmbed(interaction.client, channelMap, counts);

      const embed = new EmbedBuilder()
        .setTitle('Trade Approved (Proof Verified)')
        .addFields(
          { name: 'Your Team', value: trade.yourTeam, inline: true },
          { name: 'Other Team', value: trade.otherTeam, inline: true },
          { name: 'Assets Sent', value: trade.assetsSent || 'N/A', inline: false },
          { name: 'Assets Received', value: trade.assetsReceived || 'N/A', inline: false },
          { name: 'Proof Image', value: trade.proofUrl || 'N/A', inline: false },
        )
        .setColor(0x57F287)
        .setFooter({ text: `Trade ID ${tradeId}` });
      const coachA = getCoachRole(roleMap, trade.yourTeam);
      const coachB = getCoachRole(roleMap, trade.otherTeam);
      const tags = [coachA && `<@&${coachA}>`, coachB && `<@&${coachB}>`].filter(Boolean).join(' ');
      if (approvedChan?.isTextBased()) {
        await approvedChan.send({
          content: `${tags} Trade ID: ${tradeId}`.trim(),
          embeds: [embed],
          allowedMentions: { parse: [], roles: [coachA, coachB].filter(Boolean).map(String) },
        }).catch((err) => {
          console.error('[trade_madden_proof] failed to post final approved notice:', err);
          return null;
        });
      }
      delete pending[tradeId];
      writePending(pending);
      appendMaddenStaffLog({
        type: 'trade_proof_approved',
        guildId: interaction.guildId,
        tradeId,
        yourTeam: activeTrade.yourTeam,
        otherTeam: activeTrade.otherTeam,
      });
      await postMaddenStaffDecision(
        interaction.client,
        interaction.guildId,
        'Trade Proof Approved',
        `${activeTrade.yourTeam} vs ${activeTrade.otherTeam} was finalized after proof approval.`,
        [{ name: 'Trade ID', value: tradeId }],
      ).catch(() => null);
      await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'trade proof approved').catch(() => null);
      await interaction.update({ content: 'Proof approved. Trade finalized.', components: [] });
      return;
    }

    // Deny path
    activeTrade.status = 'denied';
    activeTrade.closedAt = Date.now();
    trades[tradeId] = activeTrade;
    saveActiveTrades(trades);
    delete pending[tradeId];
    writePending(pending);

    const embed = new EmbedBuilder()
      .setTitle('Trade Denied (Proof)')
      .addFields(
        { name: 'Your Team', value: trade.yourTeam, inline: true },
        { name: 'Other Team', value: trade.otherTeam, inline: true },
        { name: 'Assets Sent', value: trade.assetsSent || 'N/A', inline: false },
        { name: 'Assets Received', value: trade.assetsReceived || 'N/A', inline: false },
      )
      .setColor(0xED4245)
      .setFooter({ text: `Trade ID ${tradeId}` });
    const coachA = getCoachRole(roleMap, trade.yourTeam);
    const coachB = getCoachRole(roleMap, trade.otherTeam);
    const tags = [coachA && `<@&${coachA}>`, coachB && `<@&${coachB}>`].filter(Boolean).join(' ');
    if (deniedChan?.isTextBased()) {
      await deniedChan.send({
        content: `${tags} Trade ID: ${tradeId}`.trim(),
        embeds: [embed],
        allowedMentions: { parse: [], roles: [coachA, coachB].filter(Boolean).map(String) },
      }).catch((err) => {
        console.error('[trade_madden_proof] failed to post denied proof notice:', err);
        return null;
      });
    }
    appendMaddenStaffLog({
      type: 'trade_proof_denied',
      guildId: interaction.guildId,
      tradeId,
      yourTeam: activeTrade.yourTeam,
      otherTeam: activeTrade.otherTeam,
    });
    await postMaddenStaffDecision(
      interaction.client,
      interaction.guildId,
      'Trade Proof Denied',
      `${activeTrade.yourTeam} vs ${activeTrade.otherTeam} was denied at the proof stage.`,
      [{ name: 'Trade ID', value: tradeId }],
    ).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'trade proof denied').catch(() => null);
    await interaction.update({ content: 'Proof denied. Trade cancelled.', components: [] });
    return;
  }

  // Proof upload & cancel buttons
  const [act, tradeId] = [action, sub];
  const pending = readPending();
  const entry = pending[tradeId];
  if (!entry?.trade) {
    await interaction.reply({ content: 'Trade not found or already processed.', flags: 64 });
    return;
  }
  const trade = entry.trade;
  const coachA = getCoachRole(roleMap, trade.yourTeam);
  const coachB = getCoachRole(roleMap, trade.otherTeam);
  const userRoles = interaction.member?.roles?.cache ? Array.from(interaction.member.roles.cache.keys()) : [];
  const isCoachA = coachA && userRoles.includes(coachA);
  const isCoachB = coachB && userRoles.includes(coachB);

  if (!(isCoachA || isCoachB || isStaff || isCommittee)) {
    await interaction.reply({ content: 'Only a coach from either team, committee, or staff can complete this step.', flags: 64 });
    return;
  }

  if (act === 'trade_madden_cancel') {
    const trades = loadActiveTrades();
    const activeTrade = trades[tradeId];
    if (activeTrade) {
      activeTrade.status = 'cancelled';
      activeTrade.closedAt = Date.now();
      trades[tradeId] = activeTrade;
      saveActiveTrades(trades);
    }
    delete pending[tradeId];
    writePending(pending);
    await interaction.update({ content: 'Trade cancelled during proof step.', components: [] });
    return;
  }

  // trade_madden_proof
  try {
    await interaction.reply({ content: 'Upload a screenshot showing **Valid Trade** for this deal. The first image you post will be used.', flags: 64 });
    const collected = await interaction.channel?.awaitMessages({
      filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
      max: 1,
      time: 24 * 60 * 60 * 1000,
      errors: ['time']
    }).catch(() => null);
    const attachment = collected?.first()?.attachments?.first();
    if (!attachment) {
      await interaction.followUp({ content: 'No screenshot received in time. Press the proof button again if needed.', flags: 64 });
      return;
    }
    trade.proofUrl = attachment.url;
    trade.proofBy = interaction.user.id;
    trade.proofAt = Date.now();
    pending[tradeId] = { trade };
    writePending(pending);

    const committeeButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade_madden_committee|approve|${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`trade_madden_committee|deny|${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    const proofEmbed = new EmbedBuilder()
      .setTitle('Madden Proof Submitted — Committee Review')
      .addFields(
        { name: 'Your Team', value: trade.yourTeam, inline: true },
        { name: 'Other Team', value: trade.otherTeam, inline: true },
        { name: 'Assets Sent', value: trade.assetsSent || 'N/A', inline: false },
        { name: 'Assets Received', value: trade.assetsReceived || 'N/A', inline: false },
        { name: 'Proof Image', value: trade.proofUrl || 'N/A', inline: false },
      )
      .setImage(trade.proofUrl || null)
      .setFooter({ text: `Trade ID ${tradeId}` })
      .setColor(0x5865f2);

    const channelMap = loadChannelMap();
    const committeeChannelId = channelMap['Trade Committee'];
    if (!committeeChannelId) {
      console.error('[trade_madden_proof] no Trade Committee channel configured');
      await interaction.followUp({ content: 'Proof saved, but no Trade Committee channel is configured. Please ping staff.', flags: 64 });
      return;
    }

    const committeeChan = await interaction.client.channels.fetch(committeeChannelId).catch((err) => {
      console.error('[trade_madden_proof] failed to fetch committee channel:', committeeChannelId, err);
      return null;
    });
    const tags = [committeeRole && `<@&${committeeRole}>`].filter(Boolean).join(' ');
    if (!committeeChan?.isTextBased()) {
      console.error('[trade_madden_proof] committee channel not found or not text-based:', committeeChannelId);
      await interaction.followUp({ content: 'Proof saved, but I could not access the Trade Committee channel. Please ping staff.', flags: 64 });
      return;
    }

    try {
      await committeeChan.send({
        content: `${tags} Madden proof submitted. Review and approve/deny.`,
        embeds: [proofEmbed],
        components: [committeeButtons],
        allowedMentions: { parse: [], roles: [committeeRole].filter(Boolean).map(String) },
      });
    } catch (err) {
      console.error('[trade_madden_proof] failed to post proof embed:', err);
      await interaction.followUp({ content: 'Proof saved, but posting to Trade Committee failed. Please ping staff.', flags: 64 });
      return;
    }

    appendMaddenStaffLog({
      type: 'trade_proof_submitted',
      guildId: interaction.guildId,
      tradeId,
      yourTeam: trade.yourTeam,
      otherTeam: trade.otherTeam,
      proofBy: interaction.user.id,
    });
    await postMaddenStaffDecision(
      interaction.client,
      interaction.guildId,
      'Trade Proof Submitted',
      `${trade.yourTeam} vs ${trade.otherTeam} now has proof pending committee review.`,
      [{ name: 'Trade ID', value: tradeId }],
    ).catch(() => null);
    await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'trade proof submitted').catch(() => null);

    await interaction.followUp({ content: 'Proof submitted. Committee has been notified.', flags: 64 });
  } catch (err) {
    console.error('[trade_madden_proof] error:', err);
    await interaction.followUp({ content: 'Failed to submit proof. Try again.', flags: 64 }).catch(() => null);
  }
}

export default { customId, execute };
