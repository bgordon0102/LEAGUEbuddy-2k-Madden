import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { canTrade, getSeasonState } from '../utils/seasonUtils.js';

const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');

function readCoachRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getTeamFromMemberRoles(member) {
  const map = readCoachRoleMap(); // Team -> roleId
  if (!member?.roles?.cache) return null;
  const roleToTeam = Object.entries(map).reduce((acc, [team, roleId]) => {
    if (roleId) acc[roleId] = team;
    return acc;
  }, {});
  for (const [roleId] of member.roles.cache) {
    if (roleToTeam[roleId]) return roleToTeam[roleId];
  }
  return null;
}

export const customId = /^trade_for/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  if (!canTrade()) {
    const state = getSeasonState();
    await interaction.reply({
      content: `Trades are open Weeks 1-15 and in the offseason. Locked Weeks 16-29 and during playoffs. Current week: ${state.currentWeek}, phase: ${state.phase}.`,
      ephemeral: true
    });
    return;
  }
  // Parse customId safely.
  let otherTeam = '';
  let playerName = '';
  const cid = interaction.customId;
  if (cid.includes('::')) {
    const parts = cid.split('::'); // trade_for::team::player
    if (parts.length >= 3) {
      otherTeam = decodeURIComponent(parts[1] || '').replace(/_/g, ' ');
      playerName = decodeURIComponent(parts.slice(2).join('::') || '').replace(/_/g, ' ');
    }
  } else {
    // Legacy format: trade_for_<team>_<player...> (player may contain underscores)
    const payload = cid.replace('trade_for_', '');
    const lastUnderscore = payload.lastIndexOf('_');
    if (lastUnderscore === -1) return;
    const otherTeamRaw = payload.slice(0, lastUnderscore);
    const playerToken = payload.slice(lastUnderscore + 1);
    playerName = playerToken.replace(/_/g, ' ');
    otherTeam = otherTeamRaw.replace(/_/g, ' ');
  }
  if (!otherTeam || !playerName) {
    await interaction.reply({ content: 'Could not parse trade target. Please try again.', ephemeral: true });
    return;
  }

  const yourTeam = getTeamFromMemberRoles(interaction.member) || '';

  const modal = new ModalBuilder()
    .setCustomId('trade_modal_submit')
    .setTitle('Propose Trade')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('yourTeam')
          .setLabel('Your Team')
          .setPlaceholder('e.g., Cleveland Cavaliers')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(yourTeam || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('otherTeam')
          .setLabel('Other Team')
          .setPlaceholder('e.g., Los Angeles Lakers')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(otherTeam || '')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsSent')
          .setLabel('Assets You Send')
          .setPlaceholder('Players/picks you are sending')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assetsReceived')
          .setLabel('Assets You Receive')
          .setPlaceholder(`e.g., ${playerName}`)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue(playerName)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Notes')
          .setPlaceholder('Optional terms/notes')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
      ),
    );

  await interaction.showModal(modal);
}

export default { customId, execute };
