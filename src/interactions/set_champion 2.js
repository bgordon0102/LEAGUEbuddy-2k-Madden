import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getSeasonState } from '../utils/seasonUtils.js';
import { normalizeName } from '../utils/rosterUtils.js';

const ANNOUNCE_CHANNEL_ID = '1455175711001411830';
const GHOST_PARADISE_ROLE_ID = '1428119680572325929';
const COACH_ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const SEASON_FILE = path.join(process.cwd(), 'data', 'season.json');

export const customId = /^set_champion_[0-9]+(?:_.+)?$/;
export const customId_modal = /^set_champion_modal_[0-9]+/;

function readCoachRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(COACH_ROLE_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function findTeamRole(teamName) {
  const map = readCoachRoleMap();
  const target = normalizeName(teamName || '');
  for (const [team, roleId] of Object.entries(map)) {
    if (normalizeName(team) === target) return roleId;
  }
  return null;
}

function findPlayer(playerName) {
  const target = normalizeName(playerName || '');
  const dir = path.join(process.cwd(), 'data', 'teams_rosters');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const arr = Array.isArray(data) ? data : Array.isArray(data.players) ? data.players : [];
      const found = arr.find(p => normalizeName(p.name || '') === target);
      if (found) return found;
    }
  } catch {
    return null;
  }
  return null;
}

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  const state = getSeasonState();
  if (state.phase !== 'playoffs') {
    await interaction.reply({ content: `Champion can only be set during playoffs. (Current phase: ${state.phase})`, ephemeral: true });
    return;
  }
  let prefillChampion = '';
  if (interaction.customId.startsWith('set_champion_')) {
    const parts = interaction.customId.split('_');
    if (parts.length >= 4) {
      const encoded = parts.slice(3).join('_');
      prefillChampion = decodeURIComponent(encoded);
    }
  }
  const modal = new ModalBuilder()
    .setCustomId(`set_champion_modal_${interaction.customId.split('_')[2]}`)
    .setTitle('Set NBA Champion')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('champion')
          .setLabel('Champion Team')
          .setPlaceholder('e.g., Cleveland Cavaliers')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(prefillChampion || ''),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('finals_mvp')
          .setLabel('Finals MVP')
          .setPlaceholder('e.g., Nikola Jokic')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function execute_modal(interaction) {
  if (!interaction.isModalSubmit() || !customId_modal.test(interaction.customId)) return;
  const champion = interaction.fields.getTextInputValue('champion');
   const finalsMvp = interaction.fields.getTextInputValue('finals_mvp');
  await interaction.deferReply({ flags: 64 });

  const state = getSeasonState();
  const coachRoleId = findTeamRole(champion);
  const mvpPlayer = findPlayer(finalsMvp);
  const seasonNo = Number(state.seasonNo || 1);

  try {
    const announceChannel = await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (announceChannel && announceChannel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle(`🏆 Season ${seasonNo} NBA Champion`)
        .setDescription(`${champion} are your champions!`)
        .addFields({ name: 'Finals MVP', value: finalsMvp, inline: true })
        .setColor(0xFFD700)
        .setTimestamp(new Date());
      if (mvpPlayer?.imgUrl || mvpPlayer?.imgURL) {
        embed.setThumbnail(mvpPlayer.imgUrl || mvpPlayer.imgURL);
      }
      await announceChannel.send({
        content: `${coachRoleId ? `<@&${coachRoleId}> ` : ''}<@&${GHOST_PARADISE_ROLE_ID}> 🏆 Congratulations to the ${champion}!`,
        embeds: [embed],
      });
    }
  } catch (err) {
    console.error('[set_champion] Failed to announce champion:', err);
  }

  // Update season phase to offseason
  try {
    let seasonData = {};
    try { seasonData = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8')); } catch {}
    seasonData.phase = 'offseason';
    seasonData.currentWeek = 0;
    fs.writeFileSync(SEASON_FILE, JSON.stringify(seasonData, null, 2));
  } catch (err) {
    console.error('[set_champion] Failed to update season phase:', err);
  }

  await interaction.editReply({ content: `Champion set to ${champion}. Finals MVP: ${finalsMvp}. Offseason can begin.` });
}

export default { customId, execute, customId_modal, execute_modal };
