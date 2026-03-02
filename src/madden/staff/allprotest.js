import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot, currentWeek } from '../../../madden/madden_data.js';
import { computeWeeklyList, computeSeasonTop100FromHistory } from '../../../madden/top_players.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const POSITION_NEEDS = {
  // Offense
  QB: 1, HB: 1, FB: 1,
  LT: 1, LG: 1, C: 1, RG: 1, RT: 1,
  WR: 3, TE: 1,
  // Defense
  LEDG: 1, REDG: 1,
  DT: 2,
  SAM: 1, MIKE: 1, WILL: 1,
  CB: 3, FS: 1, SS: 1,
};

const POS_ALIAS = {
  EDGE: 'REDG',
  REDGE: 'REDG',
  LEDGE: 'LEDG',
};

function bestListByPos(players, needs, excludedIds = new Set()) {
  const grouped = {};
  players.forEach(p => {
    let pos = (p.position || '').toUpperCase();
    if (POS_ALIAS[pos]) pos = POS_ALIAS[pos];
    if (!needs[pos]) return;
    const grade = Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0);
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...p, grade, displayPos: pos });
  });
  Object.keys(grouped).forEach(k => grouped[k].sort((a, b) => b.grade - a.grade));
  const team = [];
  const takePlayer = (p, pos) => {
    team.push({ ...p, displayPos: pos, grade: p.grade });
    excludedIds.add(p.id || p.name);
  };
  for (const [pos, count] of Object.entries(needs)) {
    const bucket = grouped[pos] || [];
    let taken = 0;
    for (const p of bucket) {
      if (excludedIds.has(p.id || p.name)) continue;
      takePlayer(p, pos);
      taken += 1;
      if (taken >= count) break;
    }
    // Fallback for OL slots: pull best remaining any-OL if still short
    if (taken < count && ['LT','LG','C','RG','RT'].includes(pos)) {
      const remaining = players
        .filter(p => !excludedIds.has(p.id || p.name))
        .filter(p => {
          let pp = (p.position || '').toUpperCase();
          if (POS_ALIAS[pp]) pp = POS_ALIAS[pp];
          return ['LT','LG','C','RG','RT'].includes(pp);
        })
        .sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
      for (const p of remaining) {
        takePlayer(p, pos);
        taken += 1;
        if (taken >= count) break;
      }
    }
    // Fallback for SAM: pick best remaining LB if empty
    if (taken < count && pos === 'SAM') {
      const remaining = players
        .filter(p => !excludedIds.has(p.id || p.name))
        .filter(p => {
          let pp = (p.position || '').toUpperCase();
          if (POS_ALIAS[pp]) pp = POS_ALIAS[pp];
          return ['SAM','MIKE','WILL','LB'].includes(pp);
        })
        .sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
      for (const p of remaining) {
        takePlayer(p, pos);
        taken += 1;
        if (taken >= count) break;
      }
    }
  }
  return team;
}

function formatTeamName(team) {
  return team || 'UNK';
}

function loadTeamEmojis() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'team_emojis.json'), 'utf8'));
  } catch {
    return {};
  }
}

function emojiForTeam(teamName, teamEmojis) {
  if (!teamName) return '';
  const name = teamName.trim().split(/\s+/).pop();
  const id = teamEmojis[name];
  if (!id) return '';
  const safe = name.replace(/[^A-Za-z0-9]/g, '');
  return `<:${safe}:${id}>`;
}

function getCoachMention(teamName, roleMap = {}) {
  if (!teamName) return '';
  const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entry = Object.entries(roleMap || {}).find(([name]) => {
    if (!/coach$/i.test(name)) return false;
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n.includes(norm) || norm.includes(n);
  });
  return entry ? `<@&${entry[1]}>` : '';
}

function buildAllProEmbeds(firstTeam, secondTeam, leagueName, scopeLabel, roleMap) {
  const teamEmojis = loadTeamEmojis();
  const fmtLine = (p) => {
    const em = emojiForTeam(p.team, teamEmojis);
    const coach = getCoachMention(p.team, roleMap);
    return `${em ? em + ' ' : ''}${p.displayPos} — ${p.name} (${formatTeamName(p.team)}) • ${p.grade.toFixed(2)} ${coach}`;
  };
  const firstOff = firstTeam.filter(p => ['QB','HB','FB','LT','LG','C','RG','RT','WR','TE'].includes(p.displayPos));
  const firstDef = firstTeam.filter(p => !firstOff.includes(p));
  const secondOff = secondTeam.filter(p => ['QB','HB','FB','LT','LG','C','RG','RT','WR','TE'].includes(p.displayPos));
  const secondDef = secondTeam.filter(p => !secondOff.includes(p));

  const embed1 = new EmbedBuilder()
    .setTitle(`All-Pro First Team — ${scopeLabel}`)
    .addFields(
      { name: 'Offense', value: firstOff.map(fmtLine).join('\n') || '—' },
      { name: 'Defense', value: firstDef.map(fmtLine).join('\n') || '—' }
    )
    .setFooter({ text: leagueName });

  const embed2 = new EmbedBuilder()
    .setTitle(`All-Pro Second Team — ${scopeLabel}`)
    .addFields(
      { name: 'Offense', value: secondOff.map(fmtLine).join('\n') || '—' },
      { name: 'Defense', value: secondDef.map(fmtLine).join('\n') || '—' }
    )
    .setFooter({ text: leagueName });

  return [embed1, embed2];
}

function loadSeasonList(leagueId) {
  try {
    return computeSeasonTop100FromHistory(leagueId) || [];
  } catch {
    return [];
  }
}

function loadWeeklyList(snapshot, weekIndex) {
  try {
    return computeWeeklyList(snapshot, weekIndex);
  } catch {
    return [];
  }
}

export const data = new SlashCommandBuilder()
  .setName('madden-allprotest')
  .setDescription('Post All-Pro First/Second teams (staff-only).')
  .setDefaultMemberPermissions(null)
  .addStringOption(opt =>
    opt.setName('scope')
      .setDescription('Use season or a specific week list')
      .addChoices(
        { name: 'Season (end of year)', value: 'season' },
        { name: 'Week', value: 'week' }
      )
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (for weekly scope)')
      .setMinValue(1)
  )
  .addBooleanOption(opt =>
    opt.setName('public')
      .setDescription('Post publicly and tag Ghost Legacy')
  );

export async function execute(interaction, options = {}) {
  const isButton = interaction.isButton && interaction.isButton();
  let isPublic = interaction.options?.getBoolean?.('public') ?? options.public ?? false;
  const roleMap = loadRoleMap();
  const ghostRoleId = roleMap['Ghost Legacy'] || '1460399406397522145';

  // Defer replies
  if (!isButton) {
    try {
      await interaction.deferReply(isPublic ? {} : { flags: 64 });
    } catch (err) {
      if (err?.code === 10062) return;
      console.error('[allprotest] defer failed:', err);
      try { await interaction.reply({ content: 'Discord temporarily unavailable.', flags: 64 }); } catch {}
      return;
    }
  }

  // Auth
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      const msg = 'Only Ghost Legacy Commish/Co-Commish can use this command.';
      if (isButton) return interaction.update({ content: msg, components: [], embeds: [] });
      return interaction.editReply({ content: msg });
    }
  } catch (err) {
    console.error('[allprotest] role check error:', err);
    if (!isButton) await interaction.editReply({ content: 'Error checking permissions.' });
    return;
  }

  // Parse button state (for future extension; not using pagination now)
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    if (isButton) return interaction.update({ content: 'No league configured.', components: [], embeds: [] });
    return interaction.editReply({ content: 'No league configured. Run /madden-set-league first.' });
  }

  // Load list
  const snapshot = loadLeagueSnapshot(leagueId);
  const scope = 'season'; // force final season scope
  const weekIdx = null;

  let list = [];
  if (scope === 'season') {
    list = loadSeasonList(leagueId);
  } else {
    list = loadWeeklyList(snapshot, weekIdx);
  }
  if (!list.length) {
    const msg = 'No player data found for that scope.';
    if (isButton) return interaction.update({ content: msg, components: [], embeds: [] });
    return interaction.editReply({ content: msg });
  }

  // Select first and second teams
  const sorted = list
    .map(p => ({ ...p, grade: Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0) }))
    .sort((a, b) => b.grade - a.grade);
  const used = new Set();
  const firstTeam = bestListByPos(sorted, POSITION_NEEDS, used);
  const secondTeam = bestListByPos(sorted, POSITION_NEEDS, used);

  const scopeLabel = scope === 'season' ? 'Season' : `Week ${weekIdx + 1}`;
  const leagueName = leagueId === '16594549' ? 'Ghost Legacy' : leagueId;
  const [embed1, embed2] = buildAllProEmbeds(firstTeam, secondTeam, leagueName, scopeLabel, roleMap);
  const content = isPublic ? `<@&${ghostRoleId}>` : undefined;

  if (isButton) {
    await interaction.update({ content, embeds: [embed1, embed2], components: [] });
  } else {
    await interaction.editReply({ content, embeds: [embed1, embed2] });
  }
}

export default { data, execute };
