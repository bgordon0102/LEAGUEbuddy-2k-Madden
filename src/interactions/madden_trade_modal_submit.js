import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade, loadActiveTrades, saveActiveTrades, loadTradeCounts } from '../utils/madden_trade_utils.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function posWeight(position) {
  const map = {
    QB: 1.25, WR: 1.05, CB: 1.05, REDGE: 1.08, LEDGE: 1.08, DT: 1.02,
    LT: 1.05, RT: 1.04, LG: 1.0, RG: 1.0, C: 1.0,
    FS: 1.0, SS: 1.0, MLB: 0.98, WILL: 0.98, SAM: 0.98,
    HB: 0.95, FB: 0.8, TE: 0.98, K: 0.6, P: 0.6, LS: 0.5,
  };
  return map[position] || 1;
}

function devBonus(devTrait) {
  // 0=Normal,1=Star,2=Superstar,3=XFactor
  if (devTrait === 3) return 12;
  if (devTrait === 2) return 8;
  if (devTrait === 1) return 4;
  return 0;
}

export function computePlayerValue(p) {
  if (!p) return 0;
  const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? 0;
  const age = p.age ?? 26;
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  const weight = posWeight(p.position);
  const base = Math.pow(ovr, 1.03) * weight;
  const dev = devBonus(p.devTrait);
  const agePenalty = Math.max(0, age - 27) * 1.2;
  const capPenalty = cap ? Math.min(cap / 12, 10) : 0;
  const raw = base + dev - agePenalty - capPenalty;
  return Math.max(1, Math.round(raw * 10) / 10);
}

function buildValueMap(snapshot) {
  const map = new Map(); // key -> {player, value}
  const rosters = snapshot?.rosters?.teams || {};
  Object.values(rosters).forEach(r => {
    (r?.rosterInfoList || []).forEach(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
      const last = (p.lastName || '').toLowerCase();
      const val = computePlayerValue(p);
      map.set(full, { player: p, value: val });
      if (last) map.set(last, { player: p, value: val });
    });
  });
  return map;
}

function parsePickValue(label, seasonYear) {
  // Patterns like "2026 1st", "1.10", "1.10 26", "2.20", "2027 3rd", "1st rounder 2025"
  const trimmed = label.trim();
  let year = seasonYear;
  let round = null;
  const dotMatch = /^(\d)\.(\d{1,2})(?:\s+(\d{2,4}))?$/.exec(trimmed);
  if (dotMatch) {
    round = Number(dotMatch[1]);
    if (dotMatch[3]) {
      const y = Number(dotMatch[3]);
      year = y < 100 ? 2000 + y : y;
    }
  } else {
    const regex = /(?:(\d{2,4}))?\s*(\d)(?:st|nd|rd|th)?\s*(?:round|rd)?/i;
    const m = regex.exec(trimmed);
    if (!m) return null;
    if (m[1]) {
      const y = Number(m[1]);
      year = y < 100 ? 2000 + y : y;
    }
    round = Number(m[2]);
  }
  if (!round || round < 1 || round > 7) return null;
  const baseChart = { 1: 800, 2: 400, 3: 200, 4: 100, 5: 60, 6: 40, 7: 20 };
  const base = baseChart[round] || 10;
  let decay = 1;
  if (seasonYear && year && year > seasonYear) {
    const diff = year - seasonYear;
    // 0: same year, 1: next year 0.85, 2+: 0.7
    decay = diff === 1 ? 0.85 : 0.7;
  }
  return Math.max(5, Math.round(base * decay));
}

function parseAssets(text, valueMap, seasonYear) {
  const parts = (text || '').split(',').map(t => t.trim()).filter(Boolean);
  let total = 0;
  const matched = [];
  const unmatched = [];
  parts.forEach(part => {
    const key = part.toLowerCase();
    let entry = null;
    // picks first
    const pickVal = parsePickValue(part, seasonYear);
    if (pickVal) {
      total += pickVal;
      matched.push({ label: part, player: null, value: pickVal });
      return;
    }
    // direct
    if (valueMap.has(key)) entry = valueMap.get(key);
    else {
      // fuzzy contains
      for (const [k, v] of valueMap.entries()) {
        if (k.includes(key) || key.includes(k)) { entry = v; break; }
      }
    }
    if (entry) {
      total += entry.value;
      matched.push({ label: part, player: entry.player, value: entry.value });
    } else {
      unmatched.push(part);
    }
  });
  return { total, matched, unmatched };
}

function resolveTeamRoleId(teamName, snapshot, roleMap) {
  if (!teamName) return null;
  const target = teamName.toLowerCase();
  const variants = new Set([target]);

  // Direct map match
  for (const [name, id] of Object.entries(roleMap)) {
    if (!name.endsWith(' Coach')) continue;
    const base = name.replace(/ Coach$/, '').toLowerCase();
    if (base === target) return id;
    if (base.includes(target) || target.includes(base)) return id;
  }

  // Try matching against league snapshot (display/nick/abbr/city)
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const team = teams.find(t => {
    const cands = [
      t.displayName,
      t.nickName,
      t.abbrName,
      t.cityName,
    ].map(x => (x || '').toLowerCase());
    cands.forEach(c => variants.add(c));
    return cands.includes(target) || cands.some(c => c.includes(target) || target.includes(c));
  });
  if (team) {
    const candidates = [
      team.displayName,
      team.nickName,
      team.abbrName,
      team.cityName,
    ].filter(Boolean).map(x => x.toLowerCase());
    candidates.forEach(c => variants.add(c));
    for (const [name, id] of Object.entries(roleMap)) {
      if (!name.endsWith(' Coach')) continue;
      const base = name.replace(/ Coach$/, '').toLowerCase();
      if (candidates.includes(base) || variants.has(base) || base.includes(target) || target.includes(base)) return id;
    }
  }

  return null;
}

function teamDisplay(snapshot, teamName) {
  if (!teamName) return teamName;
  const t = (snapshot?.teams?.leagueTeamInfoList || []).find(tt => {
    const cands = [
      tt.displayName,
      tt.nickName,
      tt.abbrName,
      tt.cityName,
    ].map(x => (x || '').toLowerCase());
    return cands.includes(teamName.toLowerCase());
  });
  return t ? (t.displayName || t.nickName || t.cityName) : teamName;
}

function formatValueSummary(sendTotal, recvTotal, gap, flip = false) {
  const youSend = flip ? recvTotal : sendTotal;
  const theySend = flip ? sendTotal : recvTotal;
  const netRaw = typeof gap === 'number' ? gap : (Number(sendTotal) - Number(recvTotal));
  const net = flip ? -netRaw : netRaw;
  const direction = net === 0 ? 'even' : net > 0 ? 'you send more value' : 'they send more value';
  const netLabel = net === 0 ? 'Net: even' : `Net: ${net > 0 ? '+' : ''}${Number(net).toFixed(1)} (${direction})`;
  return [
    `You send: ${Number(youSend).toFixed(1)}`,
    `They send: ${Number(theySend).toFixed(1)}`,
    netLabel,
  ].join('\n');
}

function buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes, valueSummary, hideInstructions = false }) {
  const embed = new EmbedBuilder()
    .setTitle('Trade Proposal')
    .setDescription(hideInstructions ? null : 'List the exact players/picks going each way. Example send: “WR J. Smith (OVR 88), 2027 2nd” and receive: “LT R. Jones (OVR 85)”. Trades lock after Week 8.')
    .addFields(
      { name: 'Your Team', value: yourTeam, inline: true },
      { name: 'Other Team', value: otherTeam, inline: true },
      { name: 'Assets You Send', value: assetsSent || '—' },
      { name: 'Assets You Receive', value: assetsReceived || '—' },
    )
    .setColor(0x5865f2);
  if (valueSummary) {
    embed.addFields({ name: 'Trade Value Check', value: valueSummary });
  }
  if (notes) embed.addFields({ name: 'Notes', value: notes });
  return embed;
}

export const customId = 'madden_trade_modal_submit';

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== customId) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  if (!canTrade(leagueId)) {
    await interaction.reply({ content: 'Trades are locked starting Week 9. Try again next season.', ephemeral: true });
    return;
  }
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch { return; }

  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const yourTeamRaw = interaction.fields.getTextInputValue('yourTeam');
    const otherTeamRaw = interaction.fields.getTextInputValue('otherTeam');
    const assetsSent = interaction.fields.getTextInputValue('assetsSent');
    const assetsReceived = interaction.fields.getTextInputValue('assetsReceived');
    const notes = interaction.fields.getTextInputValue('notes');
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
    const valueMap = buildValueMap(snapshot);
    const sendVal = parseAssets(assetsSent, valueMap, seasonYear);
    const recvVal = parseAssets(assetsReceived, valueMap, seasonYear);
    const gap = sendVal.total - recvVal.total;
    const valueSummary = formatValueSummary(sendVal.total, recvVal.total, gap, false);
    const unmatched = [...sendVal.unmatched, ...recvVal.unmatched];

    const yourTeam = teamDisplay(snapshot, yourTeamRaw);
    const otherTeam = teamDisplay(snapshot, otherTeamRaw);

    // Enforce per-team trade cap before sending proposal
    const counts = loadTradeCounts();
    const overCap = [yourTeam, otherTeam].find(t => t && (counts[t] || 0) >= 5);
    if (overCap) {
      await interaction.editReply({ content: `Trade blocked: ${overCap} has already made 5 trades this season.` });
      return;
    }

    const embed = buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes, valueSummary });
    const tradeId = `${Date.now()}`;
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const expiresStamp = `<t:${Math.floor(expiresAt / 1000)}:R>`;

    // Prepare DM buttons (Coach B approval)
    const approveBtn = new ButtonBuilder().setCustomId(`mtrade_b_approve_${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder().setCustomId(`mtrade_b_deny_${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    // DM other coach
    let otherRoleId = resolveTeamRoleId(otherTeam, snapshot, roleMap);
    let dmSent = false;
    if (interaction.guild) {
      // Fallback: try to find role by fuzzy name if map missed
      if (!otherRoleId) {
        const target = (otherTeam || '').toLowerCase();
        const found = interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes(target));
        if (found) otherRoleId = found.id;
      }

      if (otherRoleId) {
        let role = await interaction.guild.roles.fetch(otherRoleId).catch(() => null);
        // If no cached members, try fetching guild members to populate
        if (role && role.members.size === 0) {
          await interaction.guild.members.fetch().catch(() => null);
          role = await interaction.guild.roles.fetch(otherRoleId).catch(() => role);
        }
        if (role) {
          // Build a swapped embed for the recipient so perspective is correct
          const recipientEmbed = buildTradeEmbed({
            yourTeam: otherTeam,
            otherTeam: yourTeam,
            assetsSent: assetsReceived,
            assetsReceived: assetsSent,
            notes,
            valueSummary: formatValueSummary(sendVal.total, recvVal.total, gap, true),
            hideInstructions: true,
          });
        for (const m of role.members.values()) {
          await m.send({
            embeds: [recipientEmbed],
            components: [row],
            content: `Trade ID: ${tradeId}. Please approve/deny within 24h (expires ${expiresStamp}).`,
          }).catch(() => null);
          dmSent = true;
        }
      }
    }
    }

    if (!dmSent) {
      await interaction.editReply({ content: `Trade submitted (ID ${tradeId}), but I couldn't DM the other coach (no matching role members found).${unmatched.length ? ` Unmatched assets: ${unmatched.join(', ')}` : ''}`, ephemeral: true });
      return;
    }

    // Persist active trade
    const active = loadActiveTrades();
    active[tradeId] = {
      tradeId,
      yourTeam,
      otherTeam,
      assetsSent,
      assetsReceived,
      notes,
      sendTotal: sendVal.total,
      recvTotal: recvVal.total,
      valueGap: gap,
      unmatched,
      status: 'awaiting_coach_b',
      createdAt: Date.now(),
      expiresAt,
      proposerId: interaction.user.id,
      otherRoleId,
      guildId: interaction.guildId,
    };
    saveActiveTrades(active);

    await interaction.editReply({ content: `Trade submitted (ID ${tradeId}).${dmSent ? ' Sent to other coach for approval.' : ''}\n${valueSummary}${unmatched.length ? `\nUnmatched assets (not valued): ${unmatched.join(', ')}` : ''}`, ephemeral: true });
  } catch (e) {
    await interaction.editReply({ content: `Trade submission failed: ${e?.message || e}` });
  }
}

export default { customId, execute };
