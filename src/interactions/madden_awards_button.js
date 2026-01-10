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
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findPlayer(snapshot, name) {
  if (!name) return null;
  const target = normalize(name);
  const rosters = snapshot?.rosters?.teams || {};
  for (const roster of Object.values(rosters)) {
    const list = roster?.rosterInfoList || [];
    for (const p of list) {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim();
      const norm = normalize(full);
      if (norm === target || norm.includes(target) || target.includes(norm)) {
        return p;
      }
    }
  }
  return null;
}

function findTeam(snapshot, input) {
  if (!input) return null;
  const target = normalize(input);
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  return teams.find(t => {
    const names = [
      t.displayName, t.nickName, t.cityName,
      `${t.cityName || ''} ${t.displayName || t.nickName || ''}`.trim()
    ];
    return names.some(n => {
      const norm = normalize(n);
      return norm === target || norm.includes(target) || target.includes(norm);
    });
  }) || null;
}

function teamEmoji(team, emojiMap) {
  if (!team) return '';
  const name = `${team.cityName || ''} ${team.displayName || team.nickName || ''}`.trim();
  const target = normalize(name);
  for (const [k, v] of Object.entries(emojiMap || {})) {
    const norm = normalize(k);
    if (norm === target || target.includes(norm) || norm.includes(target)) {
      return `<:${k.replace(/\s+/g, '')}:${v}>`;
    }
  }
  return '';
}

function coachTag(teamName, roleMap) {
  if (!teamName) return '';
  const parts = teamName.split(/\s+/);
  const mascot = parts[parts.length - 1];
  const candidates = [`${teamName} Coach`, `${mascot} Coach`];
  for (const c of candidates) {
    if (roleMap[c]) return `<@&${roleMap[c]}>`;
  }
  return '';
}

export const customId = /^madden_awards_button$/;
export const customId_modal = /^madden_awards_modal$/;

export async function execute(interaction) {
  if (interaction.customId !== 'madden_awards_button') return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  const roleMap = loadJson(ROLE_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId('madden_awards_modal')
    .setTitle('Enter Madden Yearly Awards')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('mvp').setLabel('MVP (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('coy').setLabel('Coach of the Year (team)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('opoy').setLabel('Offensive Player of the Year (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('dpoy').setLabel('Defensive Player of the Year (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('oroy').setLabel('Offensive Rookie of the Year (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('droy').setLabel('Defensive Rookie of the Year (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sbchamp').setLabel('Super Bowl Champion (team)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sbmvp').setLabel('Super Bowl MVP (player)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
  await interaction.showModal(modal);
}

export async function execute_modal(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== 'madden_awards_modal') return;
  await interaction.deferReply({ ephemeral: true });
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const emojiMap = loadJson(TEAM_EMOJIS_FILE);
  const awardsChannelId = channelMap['Yearly Awards'] || channelMap['Awards'];
  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear || 'Unknown';

  const fields = {
    mvp: 'MVP',
    coy: 'Coach of the Year',
    opoy: 'Offensive Player of the Year',
    dpoy: 'Defensive Player of the Year',
    oroy: 'Offensive Rookie of the Year',
    droy: 'Defensive Rookie of the Year',
    sbchamp: 'Super Bowl Champion',
    sbmvp: 'Super Bowl MVP',
  };
  const inputs = {};
  Object.keys(fields).forEach(k => inputs[k] = interaction.fields.getTextInputValue(k));

  const posts = [];
  const addPlayerAward = (key, label) => {
    const player = findPlayer(snapshot, inputs[key]);
    const teamId = player?.teamId;
    const team = (snapshot?.teams?.leagueTeamInfoList || []).find(t => t.teamId === teamId);
    const emoji = teamEmoji(team, emojiMap);
    const teamName = team ? `${team.cityName} ${team.displayName || team.nickName || ''}`.trim() : 'Unknown Team';
    const coachRole = coachTag(teamName, roleMap);
    const title = `🏆 ${label} — Season ${seasonYear}`;
    const desc = `${emoji ? emoji + ' ' : ''}${inputs[key]} — ${teamName}${coachRole ? ` (${coachRole})` : ''}`;
    const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFFD700);
    posts.push({ embed, content: null });
  };
  const addTeamAward = (key, label) => {
    const team = findTeam(snapshot, inputs[key]);
    const teamName = team ? `${team.cityName} ${team.displayName || team.nickName || ''}`.trim() : inputs[key];
    const emoji = teamEmoji(team, emojiMap);
    const coachRole = coachTag(teamName, roleMap);
    const title = `🏆 ${label} — Season ${seasonYear}`;
    const desc = `${emoji ? emoji + ' ' : ''}${teamName}${coachRole ? ` (${coachRole})` : ''}`;
    const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFFD700);
    posts.push({ embed, content: null });
  };

  try {
    addPlayerAward('mvp', fields.mvp);
    addTeamAward('coy', fields.coy);
    addPlayerAward('opoy', fields.opoy);
    addPlayerAward('dpoy', fields.dpoy);
    addPlayerAward('oroy', fields.oroy);
    addPlayerAward('droy', fields.droy);
    addTeamAward('sbchamp', fields.sbchamp);
    addPlayerAward('sbmvp', fields.sbmvp);
  } catch (e) {
    console.error('[madden_awards_modal] compose failed:', e);
  }

  try {
    const channel = await interaction.client.channels.fetch(awardsChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply({ content: 'Awards channel not found.' });
      return;
    }
    for (const p of posts) {
      await channel.send({ content: p.content ?? null, embeds: [p.embed] });
    }
    await interaction.editReply({ content: 'Yearly awards posted.' });
  } catch (err) {
    console.error('[madden_awards] Failed:', err);
    await interaction.editReply({ content: 'Failed to post awards. Check logs.' });
  }
}

export default { customId, execute, customId_modal, execute_modal };
