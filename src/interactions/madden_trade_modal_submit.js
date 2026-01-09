import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade, loadActiveTrades, saveActiveTrades } from '../utils/madden_trade_utils.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
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

function buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes }) {
  const embed = new EmbedBuilder()
    .setTitle('Trade Proposal')
    .setDescription('List the exact players/picks going each way. Example send: “WR J. Smith (OVR 88), 2027 2nd” and receive: “LT R. Jones (OVR 85)”. Trades lock after Week 8.')
    .addFields(
      { name: 'Your Team', value: yourTeam, inline: true },
      { name: 'Other Team', value: otherTeam, inline: true },
      { name: 'Assets You Send', value: assetsSent || '—' },
      { name: 'Assets You Receive', value: assetsReceived || '—' },
    )
    .setColor(0x5865f2);
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

    const yourTeam = teamDisplay(snapshot, yourTeamRaw);
    const otherTeam = teamDisplay(snapshot, otherTeamRaw);

    const embed = buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes });
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
      await interaction.editReply({ content: `Trade submitted (ID ${tradeId}), but I couldn't DM the other coach (no matching role members found).`, ephemeral: true });
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
      status: 'awaiting_coach_b',
      createdAt: Date.now(),
      expiresAt,
      proposerId: interaction.user.id,
      otherRoleId,
      guildId: interaction.guildId,
    };
    saveActiveTrades(active);

    await interaction.editReply({ content: `Trade submitted (ID ${tradeId}).${dmSent ? ' Sent to other coach for approval.' : ''}`, ephemeral: true });
  } catch (e) {
    await interaction.editReply({ content: `Trade submission failed: ${e?.message || e}` });
  }
}

export default { customId, execute };
