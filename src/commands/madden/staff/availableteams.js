import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadRoleMap() {
  try {
    const raw = fs.readFileSync(ROLE_MAP_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeName(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs') return 'Buccaneers';
  if (lower === 'pats') return 'Patriots';
  if (lower === 'bolts') return 'Chargers';
  if (lower === 'pack') return 'Packers';
  return name;
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function formatTeamName(team) {
  const nick = normalizeName(team?.displayName) || normalizeName(team?.nickName);
  const city = team?.cityName;
  if (city && nick) return `${city} ${nick}`;
  return nick || city || `Team ${team?.teamId}`;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Madden Commish/Co-Commish can use this command.' });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
    return;
  }

  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    const standings = snapshot?.standings?.teamStandingInfoList || [];
    const standingsByTeam = new Map();
    standings.forEach(s => standingsByTeam.set(s.teamId, s));

    const lines = teams.map(t => {
      const roleName = `${normalizeName(t.displayName) || normalizeName(t.nickName) || normalizeName(t.abbrName) || normalizeName(t.cityName)} Coach`;
      const roleId = roleMap[roleName];
      const role = roleId ? interaction.guild.roles.cache.get(roleId) : null;
      const assigned = role ? role.members.size > 0 : false;
      const rec = standingsByTeam.get(t.teamId);
      const wins = rec?.totalWins ?? rec?.wins ?? 0;
      const losses = rec?.totalLosses ?? rec?.losses ?? 0;
      const ties = rec?.totalTies ?? rec?.ties ?? 0;
      const record = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
      return { text: `${formatTeamName(t)}: ${record}`, assigned };
    }).filter(entry => !entry.assigned).map(entry => entry.text);

    const embed = new EmbedBuilder()
      .setTitle('Madden Available Teams')
      .setDescription(lines.length ? lines.join('\n') : 'No open teams.')
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load teams: ${err.message || err}` });
  }
}

const data = new SlashCommandBuilder()
  .setName('madden-availableteams')
  .setDescription('List unassigned teams (staff-only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export default { data, execute };
