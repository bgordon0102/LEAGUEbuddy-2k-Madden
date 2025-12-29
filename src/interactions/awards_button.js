import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { normalizeName } from '../utils/rosterUtils.js';
import { getSeasonState } from '../utils/seasonUtils.js';

const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const GHOST_PARADISE_ROLE_ID = '1428119680572325929';
const AWARDS_CHANNEL_ID = '1425556300405670021';
const SEASON_FILE = path.join(process.cwd(), 'data', 'season.json');
const COACH_ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'coachRoleMap.json');

function readStaffRoles() {
  try {
    return JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getSeasonNumber() {
  try {
    const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
    return data.seasonNo || 1;
  } catch {
    return 1;
  }
}

function findPlayer(playerName) {
  const target = normalizeName(playerName);
  const rostersDir = path.join(process.cwd(), 'data', 'teams_rosters');
  const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(rostersDir, file), 'utf8'));
      const rosterArr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
      // Exact match first
      let found = rosterArr.find(p => normalizeName(p.name || '') === target);
      if (!found) {
        // Fuzzy: includes/contains
        found = rosterArr.find(p => {
          const norm = normalizeName(p.name || '');
          return norm.includes(target) || target.includes(norm);
        });
      }
      if (found) {
        const teamName = file.replace('.json', '').replace(/_/g, ' ');
        return { player: found, teamName };
      }
    } catch {
      continue;
    }
  }
  return { player: null, teamName: null };
}

function findTeamRole(teamName, coachRoleMap = {}) {
  if (!teamName) return null;
  const target = normalizeName(teamName);
  for (const [team, role] of Object.entries(coachRoleMap)) {
    if (normalizeName(team) === target) return role;
  }
  return null;
}

function buildPositionText(p) {
  if (!p) return '-';
  const positions = [];
  if (p.position) positions.push(p.position);
  if (p.position_1) positions.push(p.position_1);
  if (p.position_2) positions.push(p.position_2);
  const uniq = [...new Set(positions.filter(Boolean))];
  return uniq.length ? uniq.join(' / ') : '-';
}

export const customId = /^awards_button$/;
export const customId_modal = /^awards_modal$/;

export async function execute(interaction) {
  if (interaction.customId === 'awards_button') {
    const seasonState = getSeasonState();
    // Awards allowed after regular season ends, before playoffs tip (phase should be regular with week >= playoffStart, or playoffs not started?)
    if (seasonState.phase === 'regular' && seasonState.currentWeek < (seasonState.playoffStart - 0)) {
      await interaction.reply({
        content: `Awards can be submitted after the regular season concludes (week ${seasonState.playoffStart - 1}) and before playoffs begin.`,
        ephemeral: true
      });
      return;
    }
    if (seasonState.phase === 'offseason') {
      await interaction.reply({ content: 'Awards must be submitted after regular season and before playoffs start.', ephemeral: true });
      return;
    }
    // staff gate
    let allowed = false;
    try {
      const staffMap = readStaffRoles();
      const roles = ['Paradise Commish', 'Schedule Tracker']
        .map(r => staffMap[r])
        .filter(Boolean);
      allowed = roles.length ? roles.some(rid => interaction.member?.roles?.cache?.has(rid)) : true;
    } catch {
      allowed = true;
    }
    if (!allowed) {
      await interaction.reply({ content: 'Staff only.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId('awards_modal')
      .setTitle('Enter Award Winners')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('mvp').setLabel('MVP').setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('roy').setLabel('Rookie of the Year').setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sixth').setLabel('Sixth Man of the Year').setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('mip').setLabel('Most Improved Player').setStyle(TextInputStyle.Short).setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('dpoy').setLabel('Defensive Player of the Year').setStyle(TextInputStyle.Short).setRequired(true),
        ),
      );
    await interaction.showModal(modal);
  }
}

export async function execute_modal(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== 'awards_modal') return;
  await interaction.deferReply({ flags: 64 });
  const winners = {
    '🏆 MVP': interaction.fields.getTextInputValue('mvp'),
    '🏆 Rookie of the Year': interaction.fields.getTextInputValue('roy'),
    '🏆 Sixth Man of the Year': interaction.fields.getTextInputValue('sixth'),
    '🏆 Most Improved Player': interaction.fields.getTextInputValue('mip'),
    '🏆 Defensive Player of the Year': interaction.fields.getTextInputValue('dpoy'),
  };
  const seasonNo = getSeasonNumber();
  let coachRoleMap = {};
  try {
    coachRoleMap = JSON.parse(fs.readFileSync(COACH_ROLE_MAP_FILE, 'utf8'));
  } catch {
    coachRoleMap = {};
  }
  try {
    const channel = await interaction.client.channels.fetch(AWARDS_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply({ content: 'Awards channel not found.' });
      return;
    }
    for (const [award, name] of Object.entries(winners)) {
      const { player, teamName } = findPlayer(name);
      const teamRole = findTeamRole(teamName, coachRoleMap);
      const embed = new EmbedBuilder()
        .setTitle(`${award}`)
        .setDescription(`${name} — Season ${seasonNo}`)
        .setColor(0xFFD700);
      if (player?.imgUrl || player?.imgURL) embed.setThumbnail(player.imgUrl || player.imgURL);
      embed.addFields(
        { name: 'Position', value: buildPositionText(player), inline: true },
      );
      await channel.send({
        content: `<@&${GHOST_PARADISE_ROLE_ID}>${teamRole ? ` <@&${teamRole}>` : ''}`,
        embeds: [embed],
      });
    }
    await interaction.editReply({ content: 'Awards posted.' });
  } catch (err) {
    console.error('[awards] Failed:', err);
    await interaction.editReply({ content: 'Failed to post awards. Check logs.' });
  }
}

export default { customId, execute, customId_modal, execute_modal };
