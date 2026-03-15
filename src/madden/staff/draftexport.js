import { SlashCommandBuilder } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const EXPORT_DIR = path.join(process.cwd(), 'data', 'madden', 'draft_exports');
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

function devLabel(devTrait) {
  switch (Number(devTrait)) {
    case 3: return 'X-Factor';
    case 2: return 'Superstar';
    case 1: return 'Star';
    case 0: return 'Normal';
    default: return 'Unknown';
  }
}

function collectDraft(snapshot) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const rosters = snapshot?.rosters?.teams || {};
  const all = [];
  teams.forEach(t => {
    const roster = rosters[t.teamId]?.rosterInfoList || [];
    const rookies = roster.filter(p => Number(p.yearsPro ?? 1) === 0);
    rookies.forEach(p => {
      const round = Number.isFinite(p.draftRound) ? Number(p.draftRound) : 99;
      const pick = Number.isFinite(p.draftPick) ? Number(p.draftPick) : 9999;
      const pickNumber = (round - 1) * 32 + pick; // approximate ordering
      all.push({
        teamId: t.teamId,
        teamName: getFullTeamName(t, `Team ${t.teamId}`),
        position: p.position,
        firstName: p.firstName,
        lastName: p.lastName,
        ovr: p.playerBestOvr,
        devTrait: p.devTrait,
        devLabel: devLabel(p.devTrait),
        draftRound: round,
        draftPick: pick,
        pickNumber,
        college: p.college,
        height: p.height,
        weight: p.weight,
        age: p.age,
        rosterId: p.rosterId,
        presentationId: p.presentationId,
      });
    });
  });
  // Order from first pick to last pick
  all.sort((a, b) => (a.pickNumber ?? 99999) - (b.pickNumber ?? 99999));
  return all;
}

export const data = new SlashCommandBuilder()
  .setName('madden-draftexport')
  .setDescription('Export the current draft class (rookies) as JSON (staff-only).')
  .setDefaultMemberPermissions(null);

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
    const snapshot = loadLeagueSnapshot(leagueId);
    if (!snapshot) {
      await interaction.editReply({ content: 'No snapshot found. Run /madden-weeklyupdate first.' });
      return;
    }
    const draft = collectDraft(snapshot);
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const filePath = path.join(EXPORT_DIR, `${leagueId}_draft_export.json`);
    const payload = {
      leagueId,
      fetchedAt: snapshot.fetchedAt || new Date().toISOString(),
      seasonYear: snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear,
      rookies: draft,
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    await interaction.editReply({ content: `Draft export ready (${draft.length} players).`, files: [filePath] });
  } catch (e) {
    await interaction.editReply({ content: `Draft export failed: ${e.message || e}` });
  }
}

export default { data, execute };
