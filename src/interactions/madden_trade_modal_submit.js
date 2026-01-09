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

function teamRoleMap(roleMap) {
  const map = {};
  Object.entries(roleMap).forEach(([name, id]) => {
    if (!name.endsWith(' Coach')) return;
    const base = name.replace(/ Coach$/, '');
    map[base.toLowerCase()] = id;
  });
  return map;
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

    // Prepare DM buttons
    const approveBtn = new ButtonBuilder().setCustomId(`madden_trade_dm_approve_${tradeId}`).setLabel('Approve').setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder().setCustomId(`madden_trade_dm_deny_${tradeId}`).setLabel('Deny').setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    // Pending channel post
    const pendingId = channelMap['Pending Trades'];
    let pendingMsgId = null;
    if (pendingId) {
      const pendingChan = await interaction.client.channels.fetch(pendingId).catch(() => null);
      if (pendingChan?.isTextBased()) {
        const pendingMsg = await pendingChan.send({ embeds: [embed], content: `Trade ID: ${tradeId}` }).catch(() => null);
        pendingMsgId = pendingMsg?.id || null;
      }
    }

    // DM other coach
    const coachMap = teamRoleMap(roleMap);
    const otherRoleId = coachMap[(otherTeam || '').toLowerCase()];
    let dmSent = false;
    if (otherRoleId && interaction.guild) {
      const role = await interaction.guild.roles.fetch(otherRoleId).catch(() => null);
      if (role) {
        for (const m of role.members.values()) {
          await m.send({ embeds: [embed], components: [row], content: `Trade ID: ${tradeId}. You have 24h to approve/deny.` }).catch(() => null);
          dmSent = true;
        }
      }
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
      pendingMsgId,
      status: 'pending',
      createdAt: Date.now(),
    };
    saveActiveTrades(active);

    await interaction.editReply({ content: `Trade submitted (ID ${tradeId}).${dmSent ? ' Sent to other coach for approval.' : ''}`, ephemeral: true });
  } catch (e) {
    await interaction.editReply({ content: `Trade submission failed: ${e?.message || e}` });
  }
}

export default { customId, execute };
