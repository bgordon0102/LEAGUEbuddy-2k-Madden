import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadRoleMap } from '../staff/staffUtils.js';
import { buildFranchiseProfileContext, buildFranchiseProfile } from '../franchise_profile.js';

const data = new SlashCommandBuilder()
  .setName('madden-franchisehub')
  .setDescription('Private team hub with roster state, league status, accountability, and front-office direction.');

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findCoachTeam(member, snapshot) {
  const roleMap = loadRoleMap();
  const teamInfos = snapshot?.teams?.leagueTeamInfoList || [];
  const teamCandidates = teamInfos.map((team) => ({
    teamId: Number(team.teamId),
    fullName: getFullTeamName(team, `Team ${team.teamId}`),
    mascot: String(team.displayName || team.nickName || '').trim(),
    city: String(team.cityName || '').trim(),
    abbr: String(team.abbrName || '').trim(),
  }));
  for (const role of member?.roles?.cache?.values?.() || []) {
    for (const [name] of Object.entries(roleMap || {})) {
      if (!/ coach$/i.test(name)) continue;
      if (name !== role.name) continue;
      const base = name.replace(/ coach$/i, '').trim();
      const norm = normalizeName(base);
      const match = teamCandidates.find((team) =>
        [team.fullName, team.mascot, team.city, team.abbr].some((value) => normalizeName(value) === norm));
      if (match) return match.fullName;
    }
  }
  return null;
}

function scoutingLine(accountability) {
  const scouting = accountability?.scouting || {};
  const parts = [
    `${scouting.fullCount || 0} fully scouted`,
    `${scouting.partialCount || 0} in progress`,
  ];
  if (scouting.currentPoints != null) parts.push(`${scouting.currentPoints} pts left`);
  if (Number(scouting.bonus || 0) > 0) parts.push(`+${scouting.bonus} weekly bonus`);
  return parts.join(' • ');
}

function accountabilityLine(accountability) {
  const parts = [
    `${Number(accountability?.strikeTotal || 0).toFixed(1)}/5 strikes`,
    accountability?.strikeBreakdown || 'Clean',
  ];
  if (accountability?.playRate != null) parts.push(`${accountability.playRate}% played`);
  if (Number(accountability?.consecutiveSilentWeeks || 0) > 0) {
    parts.push(`${accountability.consecutiveSilentWeeks} straight silent`);
  } else if (Number(accountability?.silentWeeks || 0) > 0) {
    parts.push(`${accountability.silentWeeks} silent week${accountability.silentWeeks === 1 ? '' : 's'}`);
  } else {
    parts.push('communication clear');
  }
  return parts.join(' • ');
}

const POS_ALIAS = { EDGE: 'REDG', REDGE: 'REDG', LEDGE: 'LEDG' };
const POSITION_NEEDS = {
  QB: 1, HB: 1, FB: 1,
  LT: 1, LG: 1, C: 1, RG: 1, RT: 1,
  WR: 3, TE: 1,
  LEDG: 1, REDG: 1,
  DT: 2,
  SAM: 1, MIKE: 1, WILL: 1,
  CB: 3, FS: 1, SS: 1,
};

function buildAllProTeams(list = []) {
  const grouped = {};
  for (const p of list) {
    let pos = String(p.position || p.displayPos || '').toUpperCase();
    if (POS_ALIAS[pos]) pos = POS_ALIAS[pos];
    if (!POSITION_NEEDS[pos]) continue;
    const grade = Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0);
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...p, displayPos: pos, grade });
  }
  for (const key of Object.keys(grouped)) grouped[key].sort((a, b) => b.grade - a.grade);
  const used = new Set();
  const first = [];
  const second = [];
  const fill = (target, countMap) => {
    for (const [pos, count] of Object.entries(countMap)) {
      let taken = 0;
      for (const p of grouped[pos] || []) {
        const id = p.id || `${p.name}-${p.teamId || ''}`;
        if (used.has(id)) continue;
        target.push(p);
        used.add(id);
        taken += 1;
        if (taken >= count) break;
      }
    }
  };
  fill(first, POSITION_NEEDS);
  fill(second, POSITION_NEEDS);
  return { first, second };
}

function chunkFieldText(text, maxLen = 1024) {
  const clean = String(text || '').trim();
  if (!clean) return ['No additional context.'];
  if (clean.length <= maxLen) return [clean];

  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.55)) cut = remaining.lastIndexOf('. ', maxLen);
    if (cut < Math.floor(maxLen * 0.55)) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.slice(0, 3);
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No Madden league is set yet.' });
    return;
  }

  const snapshot = loadLeagueSnapshot(leagueId);
  if (!snapshot) {
    await interaction.editReply({ content: 'League snapshot not found.' });
    return;
  }

  const teamName = findCoachTeam(interaction.member, snapshot);
  if (!teamName) {
    await interaction.editReply({ content: 'Could not determine your team from your coach role.' });
    return;
  }

  const ctx = buildFranchiseProfileContext(snapshot, interaction.guild);
  const profile = buildFranchiseProfile(ctx, teamName, { coachUserId: interaction.user.id });
  if (!profile) {
    await interaction.editReply({ content: 'Could not build your franchise hub from the current league snapshot.' });
    return;
  }

  const teamTop100Count = (ctx.top100 || []).filter((player) => normalizeName(player.team) === normalizeName(profile.teamName)).length;
  const { first: allProFirst, second: allProSecond } = buildAllProTeams(ctx.top100 || []);
  const teamAllProFirst = allProFirst.filter((player) => normalizeName(player.team || '') === normalizeName(profile.teamName)).length;
  const teamAllProSecond = allProSecond.filter((player) => normalizeName(player.team || '') === normalizeName(profile.teamName)).length;
  const franchiseRead = profile.franchiseRead || profile.frontOfficeParagraph || profile.actionPlan || 'No additional franchise read was available.';
  const franchiseReadChunks = chunkFieldText(franchiseRead, 700);

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`${profile.teamName} — Franchise Hub`)
    .setDescription(`${profile.record} • ${teamTop100Count} Top 100 • ${teamAllProFirst} All-Pro 1st • ${teamAllProSecond} All-Pro 2nd • ${profile.tradePosture.short}`)
    .addFields(
      {
        name: 'Franchise Read',
        value: franchiseReadChunks[0],
      },
      ...franchiseReadChunks.slice(1).map((chunk, index) => ({
        name: `Franchise Read ${index + 2}`,
        value: chunk,
      })),
      {
        name: 'Accountability',
        value: [
          accountabilityLine(profile.accountability),
          `Scouting: ${scoutingLine(profile.accountability)}`,
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Private league status hub' });

  await interaction.editReply({ embeds: [embed] });
}

function formatNeedLabel(need) {
  const labels = {
    QB: 'QB',
    OT: 'OT',
    IOL: 'IOL',
    WR: 'WR',
    TE: 'TE',
    RB: 'RB',
    EDGE: 'EDGE',
    DT: 'DT',
    LB: 'LB',
    CB: 'CB',
    S: 'S',
    BPA: 'BPA',
  };
  return labels[need] || need || 'BPA';
}

export default { data, execute };
