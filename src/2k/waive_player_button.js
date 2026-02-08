import fs from 'fs';
import { readRoster, saveRoster, normalizeName } from '../shared/rosterUtils.js';

export const customId = /^waive_player_(open_modal|confirm)::/;
const FREE_AGENCY_PATH = 'free agency';
const COACH_ROLE_MAP_PATH = './data/coachRoleMap.json';
const STAFF_ROLE_MAP_PATH = './data/staffRoleMap.main.json';

function sortByOvrDesc(players = []) {
  return [...players].sort((a, b) => (Number(b.ovr) || 0) - (Number(a.ovr) || 0));
}

// Simple in-process lock to avoid double waiver submissions
const activeWaives = new Set();

export async function execute(interaction) {
  if (!(interaction?.isButton?.() || interaction?.isModalSubmit?.())) return;
  const parts = interaction.customId.split('::');
  if (parts.length < 2) return;

  // Open modal flow
  if (interaction.customId.startsWith('waive_player_open_modal')) {
    const team = parts[1];
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = await import('discord.js');
    if (interaction.replied || interaction.deferred) return;
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
    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err?.code !== 10062) {
        console.error('[waive_player] showModal failed:', err);
      }
    }
    return;
  }

  // Confirm flow from modal submit
  if (!interaction.isModalSubmit()) return;
  const team = parts[1];
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if (err?.code === 10062) return;
    throw err;
  }
  // Permission check: only team coach or staff can waive
  try {
    const coachMap = JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const teamRoleId = (() => {
      if (coachMap[team]) return coachMap[team];
      const norm = normalizeName(team);
      const match = Object.entries(coachMap || {}).find(([k]) => normalizeName(k) === norm);
      return match ? match[1] : null;
    })();
    const staffIds = Object.entries(staffMap || {})
      .filter(([name]) => name === 'Paradise Commish' || name === 'Paradise Co-Commish')
      .map(([, id]) => id)
      .filter(Boolean);
    const isCoach = teamRoleId && interaction.member?.roles?.cache?.has(teamRoleId);
    const isStaff = interaction.member?.roles?.cache?.some(r => staffIds.includes(r.id));
    if (!isCoach && !isStaff) {
      await interaction.editReply({ content: 'You do not have permission to waive players from this team.' });
      return;
    }
  } catch (err) {
    console.error('[waive_player] Permission check failed:', err);
    await interaction.editReply({ content: 'Permission check failed. Try again.' });
    return;
  }

  const playerName = interaction.fields.getTextInputValue('player').trim();
  if (!playerName) {
    await interaction.editReply({ content: 'No player provided.' });
    return;
  }
  const lockKey = `${team}::${normalizeName(playerName)}`;
  if (activeWaives.has(lockKey)) {
    await interaction.editReply({ content: 'A waiver for that player is already processing. Please try again in a moment.' });
    return;
  }
  activeWaives.add(lockKey);

  // Load team roster
  const teamData = readRoster(team);
  if (!teamData) {
    await interaction.editReply({ content: `Roster not found for ${team}.` });
    return;
  }
  const { rosterPath: teamPath, roster } = teamData;
  const norm = normalizeName(playerName);
  const idxExact = roster.players.findIndex(p => normalizeName(p.name) === norm);
  let foundIdx = idxExact;
  if (foundIdx === -1) {
    foundIdx = roster.players.findIndex(p => {
      const n = normalizeName(p.name);
      return n.includes(norm) || norm.includes(n);
    });
  }
  if (foundIdx === -1) {
    await interaction.editReply({ content: `${playerName} is not on ${team}.` });
    activeWaives.delete(lockKey);
    return;
  }
  const player = roster.players[foundIdx];
  roster.players.splice(foundIdx, 1);
  saveRoster(teamPath, roster);

  // Add to free agency pool
  const faData = readRoster(FREE_AGENCY_PATH) || { rosterPath: null, roster: { players: [], picks: [] } };
  if (!faData.rosterPath) {
    await interaction.editReply({ content: 'Free agency file not found.' });
    return;
  }
  const faPlayers = faData.roster.players || [];
  const filtered = faPlayers.filter(p => normalizeName(p.name) !== norm);
  const playerCopy = { ...player };
  if (!playerCopy.imgUrl && playerCopy.img) playerCopy.imgUrl = playerCopy.img;
  if (!playerCopy.imgURL && playerCopy.imgUrl) playerCopy.imgURL = playerCopy.imgUrl;
  if (!playerCopy.thumbnail && (playerCopy.imgURL || playerCopy.imgUrl || playerCopy.img)) {
    playerCopy.thumbnail = playerCopy.imgURL || playerCopy.imgUrl || playerCopy.img;
  }
  playerCopy.lastSigned = 'waived';
  playerCopy.lastUpdatedAt = new Date().toISOString();
  filtered.push(playerCopy);
  faData.roster.players = sortByOvrDesc(filtered);
  saveRoster(faData.rosterPath, faData.roster);

  await interaction.editReply({ content: `${player.name} has been waived by ${team} and added to free agency.` });
  activeWaives.delete(lockKey);
}

export default { customId, execute };
