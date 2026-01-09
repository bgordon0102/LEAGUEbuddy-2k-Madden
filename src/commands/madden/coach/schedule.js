import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, currentWeek, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-schedule')
  .setDescription('Show a team’s Madden season schedule (from latest sync).')
  .addStringOption(opt =>
    opt.setName('team')
      .setDescription('NFL team name')
      .setRequired(true)
      .setAutocomplete(true)
  );

function normalizeName(name) {
  if (!name) return '';
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs') return 'Buccaneers';
  if (lower === 'pats') return 'Patriots';
  if (lower === 'bolts') return 'Chargers';
  if (lower === 'pack') return 'Packers';
  if (lower === 'vikes') return 'Vikings';
  return name;
}

function buildTeamMap(snapshot) {
  const map = {};
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  list.forEach(t => {
    if (!t?.teamId) return;
    const base =
      normalizeName(t.displayName) ||
      normalizeName(t.nickName) ||
      normalizeName(t.abbrName) ||
      normalizeName(t.cityName);
    const name = base || `Team ${t.teamId}`;
    map[t.teamId] = name;
  });
  return map;
}

function allTeamNames(snapshot) {
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  const names = list.map(t =>
    normalizeName(t.displayName) ||
    normalizeName(t.nickName) ||
    normalizeName(t.abbrName) ||
    normalizeName(t.cityName)
  ).filter(Boolean);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}

function findTeamByName(snapshot, input) {
  if (!input) return null;
  const target = normalizeName(input).toLowerCase();
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  return list.find(t => {
    const candidates = [
      t.displayName,
      t.nickName,
      t.abbrName,
      t.cityName
    ].filter(Boolean).map(normalizeName).map(n => n.toLowerCase());
    return candidates.includes(target);
  });
}

async function autocomplete(interaction) {
  let responded = false;
  const timeout = setTimeout(async () => {
    if (!responded) {
      responded = true;
      try { await interaction.respond([]); } catch {}
    }
  }, 1800);
  try {
    const leagueId = getDefaultLeagueId();
    if (!leagueId) throw new Error('no league');
    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = allTeamNames(snapshot);
    const focused = interaction.options.getFocused() || '';
    const filtered = focused
      ? teams.filter(n => n.toLowerCase().includes(focused.toLowerCase()))
      : teams;
    if (!responded) {
      responded = true;
      clearTimeout(timeout);
      await interaction.respond(filtered.slice(0, 25).map(n => ({ name: n, value: n })));
    }
  } catch (e) {
    if (!responded) {
      responded = true;
      clearTimeout(timeout);
      try { await interaction.respond([]); } catch {}
    }
  }
}

function formatScheduleLines(snapshot, team) {
  const teamMap = buildTeamMap(snapshot);
  const schedules = snapshot?.schedule?.schedules || [];
  const teamId = team?.teamId;
  const current = currentWeek(snapshot) ?? 1;
  const lines = [];
  // regular season (stageIndex 1)
  schedules
    .filter(g => Number(g.stageIndex ?? g.stage ?? 1) === 1)
    .sort((a, b) => (a.weekIndex ?? a.seasonWeek ?? 0) - (b.weekIndex ?? b.seasonWeek ?? 0))
    .forEach(g => {
      if (g.homeTeamId !== teamId && g.awayTeamId !== teamId) return;
      const weekIdx = Number(g.weekIndex ?? g.seasonWeek ?? g.seasonWeekIndex ?? g.week ?? 0);
      const weekNum = weekIdx + 1;
      const isHome = g.homeTeamId === teamId;
      const oppId = isHome ? g.awayTeamId : g.homeTeamId;
      const opp = teamMap[oppId] || 'Opponent';
      const marker = weekNum === current ? '➡️ ' : '';
      const prefix = isHome ? 'vs' : '@';
      lines.push(`${marker}W${weekNum}: ${prefix} ${opp}`);
    });
  return { lines, current };
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = getDefaultLeagueId();
    if (!leagueId) throw new Error('No synced Madden league found. Run /madden-weeklyupdate first.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const teamInput = interaction.options.getString('team');
    const team = findTeamByName(snapshot, teamInput);
    if (!team) throw new Error('Team not found. Make sure you pick from the autocomplete list.');
    const { lines, current } = formatScheduleLines(snapshot, team);
    const embed = new EmbedBuilder()
      .setTitle(`Madden Schedule — ${normalizeName(team.displayName) || normalizeName(team.nickName) || 'Team'}`)
      .setDescription(lines.length ? lines.join('\n') : 'No games found in snapshot.')
      .addFields({ name: 'Current Week', value: String(current ?? '?'), inline: true })
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load schedule: ${err.message}` });
  }
}

export default { data, execute, autocomplete };
