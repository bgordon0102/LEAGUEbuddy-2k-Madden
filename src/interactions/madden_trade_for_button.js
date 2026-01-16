import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade } from '../utils/madden_trade_utils.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

export const customId = /^madden_trade_for|^mtrade/;

function parseTeamAndPlayer(customId) {
  if (customId.startsWith('mtrade:')) {
    const parts = customId.split(':');
    // mtrade:team:rosterId:label
    const team = decodeURIComponent(parts[1] || '');
    const label = decodeURIComponent(parts[3] || '');
    return { team, player: label === ':' ? '' : label };
  }
  // New format: madden_trade_for:team:rosterId:label
  if (customId.includes(':')) {
    const parts = customId.split(':');
    if (parts.length >= 4) {
      const team = decodeURIComponent(parts[1] || '');
      const labelRaw = decodeURIComponent(parts.slice(3).join(':') || '');
      const label = labelRaw === ':' ? '' : labelRaw;
      return { team, player: label };
    }
  }
  // Legacy format fallback
  let team = '';
  let player = '';
  if (customId.includes('::')) {
    const parts = customId.split('::');
    if (parts.length >= 3) {
      team = decodeURIComponent(parts[1] || '').replace(/_/g, ' ');
      player = decodeURIComponent(parts.slice(2).join('::') || '').replace(/_/g, ' ');
    }
  }
  return { team, player };
}

function getCoachTeamFromRoles(interaction, snapshot) {
  const member = interaction.member;
  const roles = member?.roles?.cache;
  if (!roles) return null;
  // First, try explicit role map matching
  const roleMap = loadRoleMap();
  for (const [name, id] of Object.entries(roleMap)) {
    if (!name.endsWith(' Coach')) continue;
    if (roles.has(id)) {
      return name.replace(/ Coach$/, '');
    }
  }
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  for (const r of roles.values()) {
    if (!r.name.endsWith('Coach')) continue;
    const base = r.name.replace(/ Coach$/, '').toLowerCase();
    const match = teams.find(t => {
      const candidates = [
        t.displayName,
        t.nickName,
        t.abbrName,
        t.cityName,
      ].map(x => (x || '').toLowerCase());
      return candidates.includes(base);
    });
    if (match) return match.displayName || match.nickName || match.cityName || 'Team';
  }
  return null;
}

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  if (!customId.test(interaction.customId)) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  if (!canTrade(leagueId)) {
    await interaction.reply({ content: 'Trades are locked starting Week 9. Try again next season.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const { team, player } = parseTeamAndPlayer(interaction.customId);
  const yourTeam = getCoachTeamFromRoles(interaction, snapshot) || '';

  const modal = new ModalBuilder()
    .setCustomId('madden_trade_modal_submit')
    .setTitle('Propose Trade')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('yourTeam')
          .setLabel('Your Team')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(yourTeam || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('otherTeam')
          .setLabel('Other Team')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(team || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsSent')
          .setLabel('Assets You Send')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('e.g., QB Bo Nix, 2027 1st Round, 2027 3rd Round, 2028 1st Round')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsReceived')
          .setLabel('Assets You Receive')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(player || '')
          .setPlaceholder('e.g., QB Lamar Jackson, 2027 5th Round')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Notes')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder('Optional context: cap reasons, depth, future picks, etc.')
      ),
    );

  await interaction.showModal(modal);
}

export default { customId, execute };
