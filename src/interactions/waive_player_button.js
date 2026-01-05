import fs from 'fs';
import { readRoster, saveRoster, normalizeName } from '../utils/rosterUtils.js';

export const customId = /^waive_player_(open_modal|confirm)::/;
const FREE_AGENCY_PATH = 'free agency';
const COACH_ROLE_MAP_PATH = './data/coachRoleMap.json';
const STAFF_ROLE_MAP_PATH = './data/staffRoleMap.main.json';

function sortByOvrDesc(players = []) {
  return [...players].sort((a, b) => (Number(b.ovr) || 0) - (Number(a.ovr) || 0));
}

export async function execute(interaction) {
  if (!(interaction?.isButton?.() || interaction?.isModalSubmit?.())) return;
  const parts = interaction.customId.split('::');
  if (parts.length < 2) return;

  // Open modal flow
  if (interaction.customId.startsWith('waive_player_open_modal')) {
    const team = parts[1];
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
    const modal = new ModalBuilder()
      .setCustomId(`waive_player_confirm::${team}`)
      .setTitle(`Waive a player (${team})`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('player')
            .setLabel('Player name (fuzzy match)')
            .setPlaceholder('Type the player to waive')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  // Confirm flow from modal submit
  if (!interaction.isModalSubmit()) return;
  const team = parts[1];
  // Permission check: only team coach or staff can waive
  try {
    const coachMap = JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const teamRoleId = coachMap[team];
    const staffIds = Object.entries(staffMap || {})
      .filter(([name]) => name === 'Paradise Commish' || name === 'Paradise Co-Commish')
      .map(([, id]) => id)
      .filter(Boolean);
    const isCoach = teamRoleId && interaction.member?.roles?.cache?.has(teamRoleId);
    const isStaff = interaction.member?.roles?.cache?.some(r => staffIds.includes(r.id));
    if (!isCoach && !isStaff) {
      await interaction.reply({ content: 'You do not have permission to waive players from this team.', ephemeral: true });
      return;
    }
  } catch (err) {
    console.error('[waive_player] Permission check failed:', err);
    await interaction.reply({ content: 'Permission check failed. Try again.', ephemeral: true });
    return;
  }

  const playerName = interaction.fields.getTextInputValue('player').trim();
  if (!playerName) {
    await interaction.reply({ content: 'No player provided.', ephemeral: true });
    return;
  }

  // Load team roster
  const teamData = readRoster(team);
  if (!teamData) {
    await interaction.reply({ content: `Roster not found for ${team}.`, ephemeral: true });
    return;
  }
  const { rosterPath: teamPath, roster } = teamData;
  const norm = normalizeName(playerName);
  const idx = roster.players.findIndex(p => {
    const n = normalizeName(p.name);
    return n === norm || n.includes(norm) || norm.includes(n);
  });
  if (idx === -1) {
    await interaction.reply({ content: `${playerName} is not on ${team}.`, ephemeral: true });
    return;
  }
  const player = roster.players[idx];
  roster.players.splice(idx, 1);
  saveRoster(teamPath, roster);

  // Add to free agency pool
  const faData = readRoster(FREE_AGENCY_PATH) || { rosterPath: null, roster: { players: [], picks: [] } };
  if (!faData.rosterPath) {
    await interaction.reply({ content: 'Free agency file not found.', ephemeral: true });
    return;
  }
  const faPlayers = faData.roster.players || [];
  const filtered = faPlayers.filter(p => normalizeName(p.name) !== norm);
  filtered.push(player);
  faData.roster.players = sortByOvrDesc(filtered);
  saveRoster(faData.rosterPath, faData.roster);

  await interaction.reply({ content: `${player.name} has been waived by ${team} and added to free agency.`, ephemeral: true });
}

export default { customId, execute };
