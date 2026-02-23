import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { applyApprovedTrade } from '../shared/tradeApply.js';

const pendingPath = path.join(process.cwd(), 'data/pendingTrades.json');
// Channel where proofs are reviewed (committee)
const COMMITTEE_CHANNEL_ID = "1425555499440410812"; // trade committee channel
const APPROVED_CHANNEL_ID = "1425555422063890443"; // approved trades announcement channel
const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), "data/staffRoleMap.main.json");
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    return {};
  }
}
function writePending(data) {
  fs.writeFileSync(pendingPath, JSON.stringify(data ?? {}, null, 2));
}

function getCommitteeRoleId() {
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, "utf8"));
    return staffMap["Ghost Paradise Trade Committee"];
  } catch {
    return null;
  }
}

function getStaffRoleIds() {
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, "utf8"));
    return Object.values(staffMap || {}).filter(Boolean);
  } catch {
    return [];
  }
}

function getCoachRole(teamName) {
  try {
    const coachMap = JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
    const mascot = teamName.split(' ').pop();
    const norm = mascot.toLowerCase().replace(/[^a-z0-9]/g, '') + 'coach';
    const normalizedKeys = Object.keys(coachMap).map(k => k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    console.log('[DEBUG][getCoachRole] teamName:', teamName, 'mascot:', mascot, 'normalized:', norm, 'normalizedKeys:', normalizedKeys);
    const match = Object.entries(coachMap || {}).find(([name]) => name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
    return match ? match[1] : coachMap[teamName] || null;
  } catch (err) {
    console.error('[getCoachRole] error:', err);
    return null;
  }
}

export const customId = /^(trade_2k_proof\|.+|trade_2k_cancel\|.+|trade_2k_committee\|(approve|deny)\|.+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [action, sub, maybeId] = interaction.customId.split('|');
  // committee buttons shape: trade_2k_committee|approve|<id>
  if (action === 'trade_2k_committee') {
    const vote = sub; const tradeId = maybeId;
    const pending = readPending();
    const entryKey = Object.keys(pending).find(k => pending[k]?.trade?.tradeId === tradeId);
    const entry = entryKey ? pending[entryKey] : null;
    if (!entry) {
      await interaction.reply({ content: 'Trade not found or already processed.', flags: 64 });
      return;
    }
    const committeeRoleId = getCommitteeRoleId();
    const staffRoleIds = getStaffRoleIds();
    const hasRole = (id) => interaction.member?.roles?.cache?.has(id);
    const isStaff = staffRoleIds.some(hasRole);
    const isCommittee = committeeRoleId ? hasRole(committeeRoleId) : false;
    if (!isStaff && !isCommittee) {
      await interaction.reply({ content: 'Only committee or staff can finalize proof.', flags: 64 });
      return;
    }
    const trade = entry.trade;
    console.log('[DEBUG][proof-submit] trade.yourTeam:', trade.yourTeam, 'trade.otherTeam:', trade.otherTeam);
    if (vote === 'approve') {
      try {
        applyApprovedTrade(trade);
        trade.status = 'approved';
        if (entryKey) delete pending[entryKey];
        writePending(pending);
        // Notify approved channel with Ghost Paradise tag and trade details
        try {
          const approvedChannel = await interaction.client.channels.fetch(APPROVED_CHANNEL_ID).catch(() => null);
          if (approvedChannel) {
            const gpTag = "<@&1460733464721490108>";
            const coachRoleA = getCoachRole(trade.yourTeam);
            const coachRoleB = getCoachRole(trade.otherTeam);
            const tags = [
              gpTag,
              coachRoleA && `<@&${coachRoleA}>`,
              coachRoleB && `<@&${coachRoleB}>`
            ].filter(Boolean).join(' ');
            const approvedEmbed = new EmbedBuilder()
              .setTitle('Trade Approved After 2K Proof')
              .addFields(
                { name: 'Your Team', value: trade.yourTeam, inline: true },
                { name: 'Other Team', value: trade.otherTeam, inline: true },
                { name: 'Assets Sent', value: trade.assetsSent || 'N/A', inline: false },
                { name: 'Assets Received', value: trade.assetsReceived || 'N/A', inline: false },
                { name: 'Proof Image', value: trade.proofUrl || 'N/A', inline: false },
              )
              .setColor(0x57F287);
            await approvedChannel.send({ content: tags, embeds: [approvedEmbed] });
          }
        } catch (err) {
          console.error('[trade_2k_proof] failed to post final approved notice', err);
        }
        await interaction.update({ content: '2K proof approved. Trade applied.', components: [] });
      } catch (err) {
        console.error('[trade_2k_proof] committee apply failed', err);
        await interaction.reply({ content: 'Failed to apply trade. See logs.', flags: 64 });
      }
    } else {
      trade.status = 'denied';
      if (entryKey) delete pending[entryKey];
      writePending(pending);
      await interaction.update({ content: '2K proof denied. Trade cancelled.', components: [] });
    }
    return;
  }

  const [act, tradeId] = [action, sub];
  const pending = readPending();
  const entryKey = Object.keys(pending).find(k => pending[k]?.trade?.tradeId === tradeId);
  const entry = entryKey ? pending[entryKey] : null;
  if (!entry) {
    await interaction.reply({ content: 'Trade not found or already processed.', flags: 64 });
    return;
  }
  const trade = entry.trade;

  const committeeRoleId = getCommitteeRoleId();
  const staffRoleIds = getStaffRoleIds();
  const coachRoleA = getCoachRole(trade.yourTeam);
  const coachRoleB = getCoachRole(trade.otherTeam);
  const userRoles = interaction.member?.roles?.cache ? Array.from(interaction.member.roles.cache.keys()) : [];
  const isCoachA = coachRoleA && userRoles.includes(coachRoleA);
  const isCoachB = coachRoleB && userRoles.includes(coachRoleB);
  const isCommittee = committeeRoleId && userRoles.includes(committeeRoleId);
  const isStaff = staffRoleIds.some(id => userRoles.includes(id));
  console.log('[DEBUG][proof-submit] user:', interaction.user.id, 'coachRoleA:', coachRoleA, 'coachRoleB:', coachRoleB, 'userRoles:', userRoles, 'isCoachA:', isCoachA, 'isCoachB:', isCoachB, 'isCommittee:', isCommittee, 'isStaff:', isStaff);
  if (!(isCoachA || isCoachB || isCommittee || isStaff)) {
    await interaction.reply({ content: 'Only a coach from either team, committee, or staff can complete this step.', flags: 64 });
    return;
  }

  if (act === 'trade_2k_cancel') {
    const entryKey = Object.keys(pending).find(k => pending[k] === entry);
    trade.status = 'denied';
    if (entryKey) delete pending[entryKey];
    writePending(pending);
    try {
      const channel = await interaction.client.channels.fetch(APPROVED_CHANNEL_ID).catch(() => null);
      if (channel) {
        await channel.send({ content: `Trade **${trade.tradeId}** cancelled during 2K proof step.` });
      }
    } catch (err) {
      console.error('[trade_2k_proof] failed to notify cancel', err);
    }
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: 'Trade cancelled during 2K proof step.', components: [] });
    } else {
      await interaction.reply({ content: 'Trade cancelled during 2K proof step.', components: [], flags: 64 });
    }
    return;
  }

  try {
    await interaction.reply({ content: 'Please upload a screenshot showing **Valid Trade** in this channel within 24 hours. The first image you post will be used.', flags: 64 });
    const collected = await interaction.channel?.awaitMessages({
      filter: m => m.author.id === interaction.user.id && m.attachments.size > 0,
      max: 1,
      time: 24 * 60 * 60 * 1000, // 24 hours
      errors: ['time']
    }).catch(() => null);
    const attachment = collected?.first()?.attachments?.first();
    if (!attachment) {
      await interaction.followUp({ content: 'No screenshot received in time. Please press the proof button again.', flags: 64 });
      return;
    }
    const url = attachment.url;

    trade.proofUrl = url;
    trade.proofBy = interaction.user.id;
    trade.proofAt = Date.now();
    pending[entryKey] = entry;
    writePending(pending);

    const proofEmbed = new EmbedBuilder()
      .setTitle('2K Proof Submitted — Awaiting Committee Approval')
      .setDescription('Committee: approve or deny this proof. Trade will be applied on approval.')
      .addFields(
        { name: 'Your Team', value: trade.yourTeam, inline: true },
        { name: 'Other Team', value: trade.otherTeam, inline: true },
        { name: 'Assets Sent', value: trade.assetsSent || 'N/A', inline: false },
        { name: 'Assets Received', value: trade.assetsReceived || 'N/A', inline: false },
      )
      .setImage(url)
      .setColor(0xF1C40F);

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_2k_committee|approve|${trade.tradeId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`trade_2k_committee|deny|${trade.tradeId}`)
        .setLabel('Deny')
        .setStyle(ButtonStyle.Danger)
    );
    // Debug log after trade assignment
    console.log('[DEBUG][proof-submit] trade.yourTeam:', trade.yourTeam, 'trade.otherTeam:', trade.otherTeam);

    try {
      const channel = await interaction.client.channels.fetch(COMMITTEE_CHANNEL_ID).catch(() => null);
      if (channel) {
        const tags = '<@&1460734289015603355>';
        await channel.send({
          content: tags,
          embeds: [proofEmbed],
          components: [buttons],
        });
      }
    } catch (err) {
      console.error('[trade_2k_proof] failed to post proof embed', err);
    }

    await interaction.followUp({ content: 'Screenshot received. Committee will review and finalize.', flags: 64 });
  } catch (err) {
    console.error('[trade_2k_proof] apply failed', err);
    await interaction.reply({ content: 'Failed to apply trade after proof. Check logs.', flags: 64 });
  }
}
