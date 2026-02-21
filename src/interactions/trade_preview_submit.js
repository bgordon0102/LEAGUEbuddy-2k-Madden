import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { canTrade as canTradeMadden, loadTradeCounts } from '../shared/madden_trade_utils.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { buildValueMap, parsePickValue, buildTradeEmbed, formatValueSummary } from './madden_trade_modal_submit.js';
import { getTradeDraft, deleteTradeDraft } from '../shared/trade_draft_store.js';
import { readRoster, normalizeName, computePlayerValue2k, computePickValue2k, parsePickValue2k } from '../shared/rosterUtils.js';

const ROLE_MAP_FILE_2K = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const STAFF_ROLE_MAP = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'activeTrades.json');
const PENDING_TRADES_PATH = path.join(process.cwd(), 'data', 'pendingTrades.json');

// Channels/roles already used by existing 2K flow
const SUBMISSION_CHANNEL_ID = "1425555037328773220"; // main trade channel
const COMMITTEE_CHANNEL_ID = "1425555499440410812";
const APPROVED_CHANNEL_ID = "1425555422063890443";
const DENIED_CHANNEL_ID = "1425567560241254520";
const COMMITTEE_ROLE_ID = "1428100787225235526";

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (err) { console.error('[trade_preview_submit] write fail', err); }
}

function valuePick2k(raw, seasonYear) {
  const parsed = parsePickValue2k(raw, seasonYear);
  return parsed?.value ?? 0;
}

function summarize2k(draft) {
  const sumSide = (arr = []) => {
    let total = 0; const lines = []; const picks = [];
    arr.forEach(it => {
      if (it.type === 'player') {
        const val = computePlayerValue2k(it);
        total += val; lines.push(`${it.label} (${it.pos || 'UNK'}) — ${val.toFixed(1)}`);
      } else if (it.type === 'pick') {
        const parsed = parsePickValue2k(it.raw, draft.seasonYear);
        const val = parsed?.value ?? 0;
        const label = parsed?.label || it.raw || 'Pick';
        total += val; lines.push(`${label} — ${val.toFixed(1)}`);
        picks.push(label);
      }
    });
    return { total, lines, picks };
  };
  return { your: sumSide(draft.assets?.your), other: sumSide(draft.assets?.other) };
}

export const customId = /^trade_preview_submit\|/;

export async function execute(interaction) {
  if (!interaction.isButton() || !customId.test(interaction.customId)) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade draft expired. Please start again.', ephemeral: true });
    return;
  }

  // If Madden mode, fall back to existing handler logic
  if (draft.mode !== '2k') {
    // Let the old handler pick it up (kept for compatibility)
    return;
  }

  try { await interaction.deferReply({ ephemeral: true }); } catch { return; }

  // 2K coach approval -> committee flow (mirrors Madden with coach DM step)
  const summary = summarize2k(draft);
  const gap = summary.your.total - summary.other.total;
  const assetsSent = summary.your.lines.join('\n') || draft.assetsSent || '—';
  const assetsReceived = summary.other.lines.join('\n') || draft.assetsReceived || '—';

  // Hard guard: trades must be within 50 value points
  const GAP_LIMIT = 50;
  if (Math.abs(gap) > GAP_LIMIT) {
    await interaction.editReply({
      content: `Trade not submitted: value gap is ${gap.toFixed(1)}. Trades must be within ${GAP_LIMIT} points.`,
      components: [],
    });
    return;
  }

  // Build trade object (pending coach B approval)
  const trades = loadJson(ACTIVE_TRADES_PATH, {});
  const tradeId = draftId;
  const coachMap = loadJson(ROLE_MAP_FILE_2K, {});
  const coachKey = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  const normalize = (str='') => String(str).toLowerCase().replace(/[^a-z0-9]/g,'');
  let coachBRoleId = coachMap[coachKey] || null;
  if (!coachBRoleId && coachKey) {
    const teamNorm = normalize(coachKey);
    for (const [k,v] of Object.entries(coachMap)) {
      const keyNorm = normalize(k.replace(/coach$/i,''));
      if (!keyNorm) continue;
      if (teamNorm.includes(keyNorm) || keyNorm.includes(teamNorm)) {
        coachBRoleId = v;
        break;
      }
    }
  }
  const trade = {
    tradeId,
    proposerId: interaction.user.id,
    coachBId: coachBRoleId, // role id for other coach
    yourTeam: draft.yourTeamName || draft.yourTeamId || '—',
    otherTeam: draft.otherTeamName || draft.otherTeamId || '—',
    assetsSent,
    assetsReceived,
    picksSent: summary.your.picks,
    picksReceived: summary.other.picks,
    notes: draft.notes || '',
    guildId: interaction.guildId,
    status: 'pending', // waiting on Coach B
    postedToCommittee: false,
    submittedAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24h
  };
  trades[tradeId] = trade;
  writeJson(ACTIVE_TRADES_PATH, trades);

  // DM Coach B with approve/deny buttons
  const dmEmbed = new EmbedBuilder()
    .setTitle('Trade Proposal Approval Needed')
    .setDescription(`Gap (you - them): ${gap.toFixed(1)}`)
    .addFields(
      { name: 'From Team', value: trade.yourTeam, inline: true },
      { name: 'To Team', value: trade.otherTeam, inline: true },
      { name: 'They Send', value: assetsSent || '—' },
      { name: 'They Receive', value: assetsReceived || '—' },
    )
    .setColor(0x5865f2);
  if (trade.notes) dmEmbed.addFields({ name: 'Notes', value: trade.notes });

  const dmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`trade_dm_approve_${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`trade_dm_deny_${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  let coachRoleLabel = coachKey || 'their coach';
  let dmSent = 0;
  // DM coach B (role members) WITH buttons
  try {
    const guild = await interaction.client.guilds.fetch(interaction.guildId);
    // hydrate member cache so role.members is accurate
    try { await guild.members.fetch(); } catch { /* ignore */ }
    if (coachBRoleId) {
      const role = await guild.roles.fetch(coachBRoleId).catch(() => null);
      if (role?.name) coachRoleLabel = `${role.name}`;
      const members = role?.members?.map?.(m => m.user) || [];
      await Promise.all(
        members.map(async user => {
          try {
            await user.send({ embeds: [dmEmbed], components: [dmRow] });
            dmSent += 1;
          } catch (err) {
            console.error('[trade_preview_submit] DM coachB failed:', err);
          }
        })
      );
    }
  } catch { /* ignore */ }

  // DM proposer WITHOUT buttons (FYI only)
  try {
    const proposer = await interaction.client.users.fetch(trade.proposerId, { force: true });
    await proposer.send({ embeds: [dmEmbed], components: [] });
  } catch (err) {
    console.error('[trade_preview_submit] DM proposer failed:', err);
  }

  deleteTradeDraft(draftId);
  const statusMsg = dmSent > 0
    ? `Trade sent to ${coachRoleLabel} for approval (DM). It will go to committee after they approve.`
    : `Trade created, but I could not DM ${coachRoleLabel} (no role members found). Add the coach to that role and restart the trade.`;
  await interaction.editReply({ content: statusMsg, components: [] });
}

export default { customId, execute };
