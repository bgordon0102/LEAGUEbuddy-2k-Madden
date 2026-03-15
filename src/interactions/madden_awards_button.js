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
import { getFullTeamName } from '../shared/madden_team_names.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];

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
      getFullTeamName(t, '')
    ];
    return names.some(n => {
      const norm = normalize(n);
      return norm === target || norm.includes(target) || target.includes(norm);
    });
  }) || null;
}

function teamEmoji(team, emojiMap) {
  if (!team) return '';
  const name = getFullTeamName(team, '');
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

function titleCase(str) {
  return (str || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
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
        new TextInputBuilder().setCustomId('opdpoy').setLabel('OPOY / DPOY (offense | defense)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rookies').setLabel('OROY / DROY (offense | defense)').setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sbcombo').setLabel('Super Bowl (champ team | MVP player)').setStyle(TextInputStyle.Short).setRequired(true),
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
  const awardsChannelId = channelMap['Yearly awards'] || channelMap['Yearly Awards'] || channelMap['Awards'];
  // Fallback season year: use config.json if snapshot lacks seasonYear
  let seasonYear =
    snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear ||
    snapshot?.info?.seasonInfo?.seasonYear ||
    snapshot?.seasonYear ||
    null;
  if (!seasonYear) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'config.json'), 'utf8'));
      seasonYear = config?.seasonYear || config?.season || null;
    } catch { /* ignore */ }
  }
  if (!seasonYear || Number(seasonYear) === 0) {
    const current = new Date().getFullYear();
    seasonYear = current;
  }

  const fields = {
    mvp: 'MVP',
    coy: 'Coach of the Year',
    opdpoy: 'OPOY / DPOY (offense | defense)',
    rookies: 'OROY / DROY (offense | defense)',
    sbcombo: 'Super Bowl (champ team | MVP player)',
  };
  const inputs = {};
  Object.keys(fields).forEach(k => inputs[k] = interaction.fields.getTextInputValue(k));

  const splitPair = (text) => {
    const parts = (text || '').split(/[,|/]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts[1]];
    if (parts.length === 1) return [parts[0], parts[0]];
    return ['', ''];
  };

  const posts = [];
  const addPlayerAward = (key, label) => {
    const player = findPlayer(snapshot, inputs[key]);
    const teamId = player?.teamId;
    const team = (snapshot?.teams?.leagueTeamInfoList || []).find(t => t.teamId === teamId);
    const emoji = teamEmoji(team, emojiMap);
    const teamName = team ? getFullTeamName(team, 'Unknown Team') : 'Unknown Team';
    const coachRole = coachTag(teamName, roleMap);
    const playerName = player ? `${player.firstName || ''} ${player.lastName || ''}`.trim() : titleCase(inputs[key]);
    const title = `🏆 ${label} — Season ${seasonYear}`;
    const desc = `${emoji ? emoji + ' ' : ''}${playerName} — ${teamName}${coachRole ? ` (${coachRole})` : ''}`;
    const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFFD700);
    posts.push({ embed, content: null });
  };
  const addTeamAward = (key, label) => {
    const team = findTeam(snapshot, inputs[key]);
    const teamName = team ? getFullTeamName(team, titleCase(inputs[key])) : titleCase(inputs[key]);
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
    const [opoyVal, dpoyVal] = splitPair(inputs.opdpoy);
    const [oroyVal, droyVal] = splitPair(inputs.rookies);
    const [sbChampVal, sbMvpVal] = splitPair(inputs.sbcombo);

    inputs.opoy = opoyVal;
    inputs.dpoy = dpoyVal;
    inputs.oroy = oroyVal;
    inputs.droy = droyVal;
    inputs.sbchamp = sbChampVal;
    inputs.sbmvp = sbMvpVal;

    addPlayerAward('opoy', 'Offensive Player of the Year');
    addPlayerAward('dpoy', 'Defensive Player of the Year');
    addPlayerAward('oroy', 'Offensive Rookie of the Year');
    addPlayerAward('droy', 'Defensive Rookie of the Year');
    addTeamAward('sbchamp', 'Super Bowl Champion');
    addPlayerAward('sbmvp', 'Super Bowl MVP');
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
