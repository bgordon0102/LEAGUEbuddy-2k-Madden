import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  canTrade,
  loadTradeCounts,
  loadActiveTrades,
  saveActiveTrades,
} from '../utils/madden_trade_utils.js';
import {
  resolveLeagueIdWithConfig,
  loadLeagueSnapshot,
} from '../madden/madden_data.js';
import {
  parseAssets,
  buildValueMap,
  buildTradeEmbed,
  formatValueSummary,
  parsePickValue,
} from './madden_trade_modal_submit.js';
import {
  getTradeDraft,
  deleteTradeDraft,
} from '../utils/trade_draft_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

function resolveTeamRoleId(teamName, snapshot, roleMap) {
  if (!teamName) return null;
  const target = teamName.toLowerCase();
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const team = teams.find(t => {
    const cands = [
      t.displayName,
      t.nickName,
      t.abbrName,
      t.cityName,
    ].map(x => (x || '').toLowerCase());
    return cands.includes(target) || cands.some(c => c.includes(target) || target.includes(c));
  });
  const candidates = new Set([target]);
  if (team) {
    [team.displayName, team.nickName, team.abbrName, team.cityName].forEach(v => v && candidates.add(v.toLowerCase()));
  }
  for (const [name, id] of Object.entries(roleMap || {})) {
    if (!name.endsWith(' Coach')) continue;
    const base = name.replace(/ Coach$/, '').toLowerCase();
    if (candidates.has(base) || base.includes(target) || target.includes(base)) return id;
  }
  return null;
}

function buildDecisionButtons(tradeId, isOtherCoach) {
  const approveId = isOtherCoach ? `mtrade_b_approve_${tradeId}` : `mtrade_c_approve_${tradeId}`;
  const denyId = isOtherCoach ? `mtrade_b_deny_${tradeId}` : `mtrade_c_deny_${tradeId}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(approveId).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(denyId).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );
  return row;
}

export const customId = /^madden_trade_preview_submit\|/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade draft expired. Please reopen using Modify and resubmit.', ephemeral: true });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  if (!canTrade(leagueId)) {
    await interaction.reply({ content: 'Trades are locked starting Week 9. Try again next season.', ephemeral: true });
    return;
  }

  try { await interaction.deferReply({ ephemeral: true }); } catch { return; }

  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const valueMap = buildValueMap(snapshot);
    const counts = loadTradeCounts();
    const roleMap = loadRoleMap();

    const yourTeam = draft.yourTeam || draft.yourTeamName || draft.yourTeamId || draft.yourTeamRaw;
    const otherTeam = draft.otherTeam || draft.otherTeamName || draft.otherTeamId || draft.otherTeamRaw;
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear || draft.seasonYear;

    // Prefer structured assets from the builder if available
    const toLabel = (item) => {
      if (!item) return 'Asset';
      if (item.type === 'pick') {
        const parsed = parsePickValue(item.raw, seasonYear);
        return parsed?.label || item.raw || 'Pick';
      }
      return item.label || item.name || 'Player';
    };
    const toLine = (item, valueMap) => {
      if (!item) return null;
      const label = toLabel(item);
      const entry = item.type === 'player' ? valueMap.get((item.key || '').toLowerCase()) : null;
      const val = item.value ?? entry?.value ?? 0;
      return `${label} (${item.pos || ''}) — ${Number(val).toFixed(1)}`.replace(/\(\s*\)/, '').trim();
    };
    let assetsSent = draft.assetsSent || '';
    let assetsReceived = draft.assetsReceived || '';
    let assetsSentValueLines = [];
    let assetsReceivedValueLines = [];
    if (draft.assets?.your || draft.assets?.other) {
      const yourArr = draft.assets?.your || [];
      const theirArr = draft.assets?.other || [];
      assetsSentValueLines = yourArr.map(i => toLine(i, valueMap)).filter(Boolean);
      assetsReceivedValueLines = theirArr.map(i => toLine(i, valueMap)).filter(Boolean);
      assetsSent = yourArr.map(i => toLabel(i)).join(', ');
      assetsReceived = theirArr.map(i => toLabel(i)).join(', ');
    }
    const notes = draft.notes || '';

    // Team trade cap check (5 max per season)
    const overCap = [yourTeam, otherTeam].find(t => (counts?.[t] || 0) >= 5);
    if (overCap) {
      await interaction.editReply({ content: `Trade blocked: ${overCap} has already made 5 trades this season.` });
      return;
    }

    const sendParsed = parseAssets(assetsSent, valueMap, seasonYear);
    const recvParsed = parseAssets(assetsReceived, valueMap, seasonYear);
    const sendVal = Number(sendParsed.total || 0);
    const recvVal = Number(recvParsed.total || 0);
    const gap = sendVal - recvVal;
    const valueSummary = formatValueSummary(sendVal, recvVal, gap, false);

    const embed = buildTradeEmbed({
      yourTeam,
      otherTeam,
      assetsSent,
      assetsReceived,
      notes,
      valueSummary,
      hideInstructions: true,
      assetsSentValueLines: assetsSentValueLines.length ? assetsSentValueLines : sendParsed.matched.map(i => `${i.label} (${Number(i.value || 0).toFixed(1)})`),
      assetsReceivedValueLines: assetsReceivedValueLines.length ? assetsReceivedValueLines : recvParsed.matched.map(i => `${i.label} (${Number(i.value || 0).toFixed(1)})`),
    });
    if (sendParsed.unmatched?.length || recvParsed.unmatched?.length) {
      embed.addFields({
        name: 'Unmatched assets',
        value: [
          sendParsed.unmatched?.length ? `You send (unmatched): ${sendParsed.unmatched.join(', ')}` : null,
          recvParsed.unmatched?.length ? `They send (unmatched): ${recvParsed.unmatched.join(', ')}` : null,
        ].filter(Boolean).join('\n'),
      });
    }

    // Store trade
    const trades = loadActiveTrades();
    const tradeId = `trade_${Date.now()}`;
    trades[tradeId] = {
      yourTeam,
      otherTeam,
      assetsSent,
      assetsReceived,
      notes,
      sendTotal: sendVal,
      recvTotal: recvVal,
      valueGap: gap,
      unmatchedSend: sendParsed.unmatched || [],
      unmatchedRecv: recvParsed.unmatched || [],
      createdBy: interaction.user.id,
      createdAt: Date.now(),
      status: 'awaiting_coach_b',
      proposerId: interaction.user.id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    };
    saveActiveTrades(trades);
    deleteTradeDraft(draftId);

    // DM other coach (role members or user) with approve/deny buttons
    const guild = interaction.guild || interaction.client.guilds.cache.first();
    const coachId = resolveTeamRoleId(otherTeam, snapshot, roleMap);
    const rowCoach = buildDecisionButtons(tradeId, true);
    let dmSent = false;
    let dmTargets = [];
    if (guild && coachId) {
      const members = [];
      const memberById = await guild.members.fetch(coachId).catch(() => null);
      if (memberById && memberById.user.id !== interaction.user.id) members.push(memberById);
      if (!memberById) {
        const role = await guild.roles.fetch(coachId).catch(() => null);
        if (role) {
          role.members.forEach(m => {
            if (m.user.id !== interaction.user.id) members.push(m);
          });
        }
      }
      for (const m of members) {
        try {
          await m.user.send({ content: `Trade proposal: ${yourTeam} ↔ ${otherTeam}`, embeds: [embed], components: [rowCoach] });
          dmSent = true;
          dmTargets.push(m.user.tag);
        } catch (e) {
          // ignore DM failures
        }
      }
    }
    // also DM initiating coach with the proposal for reference
    try {
      const me = await interaction.client.users.fetch(interaction.user.id);
      await me.send({ content: `You submitted trade ${tradeId}: ${yourTeam} ↔ ${otherTeam}`, embeds: [embed], components: [rowCoach] });
      dmTargets.push(me.tag);
    } catch {}

    await interaction.editReply({
      content: `Trade recorded as ${tradeId}. Sent for approval.${dmSent ? ` DM sent to: ${dmTargets.join(', ')}` : ''}`,
      embeds: [embed],
      components: [],
    });
  } catch (err) {
    console.error('trade submit error', err);
    await interaction.editReply({ content: `Trade submission failed: ${err?.message || err}` });
  }
}

export default { customId, execute };
