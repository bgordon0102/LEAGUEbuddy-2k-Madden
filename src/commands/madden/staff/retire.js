import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const RETIRED_FILE = path.join(process.cwd(), 'data', 'madden', 'retired_players.json');
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

function buildPlayerKey(p) {
  // Prefer rosterId; fall back to presentationId + birthdate.
  if (p?.rosterId) return `rid:${p.rosterId}`;
  const pid = p?.presentationId || '';
  const bY = p?.birthYear || '';
  const bM = p?.birthMonth || '';
  const bD = p?.birthDay || '';
  return `p:${pid}-${bY}-${bM}-${bD}`;
}

function listFromSnapshot(snapshot) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const teamRosters = snapshot?.rosters?.teams || {};
  const faRoster = snapshot?.rosters?.freeAgents?.rosterInfoList || [];
  const players = [];
  teams.forEach(t => {
    const r = teamRosters[t.teamId]?.rosterInfoList || [];
    r.forEach(p => players.push({ ...p, teamId: t.teamId, teamName: t.displayName || t.nickName || t.cityName }));
  });
  faRoster.forEach(p => players.push({ ...p, teamId: 0, teamName: 'Free Agents' }));
  return players;
}

export const data = new SlashCommandBuilder()
  .setName('madden-retire')
  .setDescription('Find and mark players who have retired (staff-only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadJson(ROLE_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
    return;
  }

  try {
    const current = loadLeagueSnapshot(leagueId);
    const prevPath = path.join(process.cwd(), 'data', 'madden', 'leagues', 'previous', `${leagueId}.json`);
    const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : null;
    if (!prev) {
      await interaction.editReply({ content: 'No previous snapshot to compare. Run a weekly update first, then rerun /madden-retire.' });
      return;
    }

    const existingRetired = loadJson(RETIRED_FILE, {});
    const retiredSet = new Set(existingRetired[leagueId] || []);

    const currPlayers = listFromSnapshot(current);
    const prevPlayers = listFromSnapshot(prev);

    const currKeys = new Set(currPlayers.map(buildPlayerKey));
    const newlyRetired = [];

    prevPlayers.forEach(p => {
      const key = buildPlayerKey(p);
      if (!currKeys.has(key) && !retiredSet.has(key)) {
        newlyRetired.push(p);
        retiredSet.add(key);
      }
    });

    existingRetired[leagueId] = Array.from(retiredSet);
    fs.mkdirSync(path.dirname(RETIRED_FILE), { recursive: true });
    fs.writeFileSync(RETIRED_FILE, JSON.stringify(existingRetired, null, 2));

    const embed = new EmbedBuilder()
      .setTitle('Madden Retire Check')
      .setColor(newlyRetired.length ? 0xffcc00 : 0x00cc66)
      .setDescription(newlyRetired.length
        ? `Found ${newlyRetired.length} newly retired players.`
        : 'No newly retired players found.')
      .addFields(
        { name: 'League', value: String(leagueId), inline: true },
        { name: 'Checked vs previous snapshot', value: prevPath, inline: false },
      );

    if (newlyRetired.length) {
      const list = newlyRetired
        .slice(0, 15)
        .map(p => `${p.position || ''} ${p.firstName || ''} ${p.lastName || ''} (${p.teamName || 'Unknown'})`.trim())
        .join('\n');
      embed.addFields({ name: 'Sample', value: list || 'n/a' });
      if (newlyRetired.length > 15) {
        embed.addFields({ name: 'More', value: `${newlyRetired.length - 15} more...` });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Retire check failed: ${err.message || err}` });
  }
}

export default { data, execute };
