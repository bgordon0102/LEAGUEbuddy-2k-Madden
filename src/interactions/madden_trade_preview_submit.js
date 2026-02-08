import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import {
  canTrade,
  loadTradeCounts,
  loadActiveTrades,
  saveActiveTrades,
} from '../shared/madden_trade_utils.js';
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
} from '../shared/trade_draft_store.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

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
    const pickValFromStruct = (item) => {
      const yr = item.year;
      const rnd = item.round;
      const pk = item.pickNum;
      if (!yr || !rnd) return null;
      const currentYear = seasonYear || new Date().getFullYear();
      if (pk && yr === currentYear) {
        return parsePickValue(`${yr} Round ${rnd} Pick ${pk}`, seasonYear)?.value ?? null;
      }
      const parsed = parsePickValue(`${yr} Round ${rnd}`, seasonYear);
      return parsed?.value ?? null;
    };
    const toLabel = (item) => {
      if (!item) return 'Asset';
      if (item.type === 'pick') {
        if (item.pickNum) return `${item.year || seasonYear || ''} Round ${item.round} Pick ${item.pickNum}`;
        if (item.year && item.round) return `${item.year} Round ${item.round}`;
        const parsed = parsePickValue(item.raw, seasonYear);
        return parsed?.label || item.raw || 'Pick';
      }
      return item.label || item.name || 'Player';
    };
    const toLine = (item, valueMap) => {
      if (!item) return null;
      const label = toLabel(item);
      let val = null;
      if (item.type === 'player') {
        val = item.value ?? valueMap.get((item.key || '').toLowerCase())?.value ?? null;
      } else if (item.type === 'pick') {
        val = pickValFromStruct(item);
        if (val == null) val = parsePickValue(item.raw, seasonYear)?.value ?? null;
      }
      val = val == null ? 0 : val;
      return `${label} (${item.pos || ''}) — ${Number(val).toFixed(1)}`.replace(/\(\s*\)/, '').trim();
    };
    let assetsSent = draft.assetsSent || '';
    let assetsReceived = draft.assetsReceived || '';
    let assetsSentValueLines = [];
    let assetsReceivedValueLines = [];
    let sendVal = 0;
    let recvVal = 0;
    let unmatched = [];
    let sendUnmatched = [];
    let recvUnmatched = [];

    if (draft.assets?.your || draft.assets?.other) {
      const yourArr = draft.assets?.your || [];
      const theirArr = draft.assets?.other || [];
      const pickVal = (item) => {
        const fromStruct = pickValFromStruct(item);
        if (fromStruct != null) return fromStruct;
        const parsed = parsePickValue(item.raw, seasonYear);
        return parsed?.value || 0;
      };
      assetsSentValueLines = yourArr.map(i => toLine(i, valueMap)).filter(Boolean);
      assetsReceivedValueLines = theirArr.map(i => toLine(i, valueMap)).filter(Boolean);
      assetsSent = yourArr.map(i => toLabel(i)).join(', ');
      assetsReceived = theirArr.map(i => toLabel(i)).join(', ');
      sendVal = yourArr.reduce((sum, i) => sum + (i.type === 'player' ? (valueMap.get((i.key || '').toLowerCase())?.value || 0) : pickVal(i)), 0);
      recvVal = theirArr.reduce((sum, i) => sum + (i.type === 'player' ? (valueMap.get((i.key || '').toLowerCase())?.value || 0) : pickVal(i)), 0);
    } else {
      const parsedSend = parseAssets(assetsSent, valueMap, seasonYear);
      const parsedRecv = parseAssets(assetsReceived, valueMap, seasonYear);
      sendVal = Number(parsedSend.total || 0);
      recvVal = Number(parsedRecv.total || 0);
      assetsSentValueLines = parsedSend.matched.map(i => `${i.label} (${Number(i.value || 0).toFixed(1)})`);
      assetsReceivedValueLines = parsedRecv.matched.map(i => `${i.label} (${Number(i.value || 0).toFixed(1)})`);
      sendUnmatched = parsedSend.unmatched || [];
      recvUnmatched = parsedRecv.unmatched || [];
      unmatched = [...sendUnmatched, ...recvUnmatched];
    }

    const notes = draft.notes || '';

    // Team trade cap check (5 max per season)
    const overCap = [yourTeam, otherTeam].find(t => (counts?.[t] || 0) >= 5);
    if (overCap) {
      await interaction.editReply({ content: `Trade blocked: ${overCap} has already made 5 trades this season.` });
      return;
    }

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
      assetsSentValueLines,
      assetsReceivedValueLines,
    });
    if (unmatched.length) {
      embed.addFields({ name: 'Unmatched assets', value: unmatched.join(', ') });
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
      unmatchedSend: sendUnmatched,
      unmatchedRecv: recvUnmatched,
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
    let dmError = null;
    if (guild && coachId) {
      const members = [];
      // try direct user id
      const memberById = await guild.members.fetch(coachId).catch(() => null);
      if (memberById && memberById.user.id !== interaction.user.id) members.push(memberById);

      // try role
      if (!memberById) {
        const role = await guild.roles.fetch(coachId).catch(() => null);
        if (role) {
          // ensure member cache is warm
          if (role.members.size === 0) {
            try { await guild.members.fetch(); } catch { }
          }
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
          dmError = e;
        }
      }
    }
    // also DM initiating coach with the proposal for reference (no action buttons)
    try {
      const me = await interaction.client.users.fetch(interaction.user.id);
      await me.send({ content: `You submitted trade ${tradeId}: ${yourTeam} ↔ ${otherTeam}. Waiting on the other coach to approve/deny.`, embeds: [embed], components: [] });
      dmTargets.push(me.tag);
    } catch { }

    const dmNote = dmSent
      ? ` DM sent to: ${dmTargets.join(', ')}`
      : ' DM failed to send to the other coach. Please notify them manually or check team-to-role mapping.';

    await interaction.editReply({
      content: `Trade recorded as ${tradeId}. Sent for approval.${dmNote}`,
      embeds: [embed],
      components: [],
    });
  } catch (err) {
    console.error('trade submit error', err);
    await interaction.editReply({ content: `Trade submission failed: ${err?.message || err}` });
  }
}

export default { customId, execute };
