import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { updateAvailableTeamsPin } from '../../../madden/available_teams.js';
import { updateFairSimBoard } from '../../shared/fairsim_board.js';
import { setCoachAssignment } from '../../shared/madden_coach_assignments.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];
const ASSIGNABLE = ['Ghost Legacy Trade Committee', 'Ghost Legacy'];

function loadRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

const roleChoices = (roleMap) => Object.keys(roleMap)
  .filter(name =>
    name.endsWith(' Coach') ||
    ASSIGNABLE.includes(name)
  )
  .map(name => ({ name, value: name }));

export const data = new SlashCommandBuilder()
  .setName('madden-assignrole')
  .setDescription('Assign up to two Madden roles (coach or trade committee) to a user (Commish/Co-Commish only).')
  .addUserOption(o => o.setName('user').setDescription('User to assign').setRequired(true))
  .addStringOption(o => o.setName('role1').setDescription('First role to assign').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('role2').setDescription('Second role to assign (optional)').setRequired(false).setAutocomplete(true))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  await interaction.deferReply({ ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }
  const target = interaction.options.getUser('user');
  const roleName1 = interaction.options.getString('role1');
  const roleName2 = interaction.options.getString('role2');

  const guildMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  if (!guildMember) {
    await interaction.editReply({ content: 'User not found in this server.' });
    return;
  }

  const resolveRole = (name) => {
    const id = roleMap[name];
    return id ? interaction.guild.roles.cache.get(id) : null;
  };

  const r1 = resolveRole(roleName1);
  if (!r1) {
    await interaction.editReply({ content: `Role "${roleName1}" not found.` });
    return;
  }
  let r2 = null;
  if (roleName2) {
    r2 = resolveRole(roleName2);
    if (!r2) {
      await interaction.editReply({ content: `Role "${roleName2}" not found.` });
      return;
    }
  }

  try {
    await guildMember.roles.add(r1);
    if (r2) await guildMember.roles.add(r2);
    for (const role of [r1, r2].filter(Boolean)) {
      if (!/ coach$/i.test(role.name)) continue;
      const teamName = role.name.replace(/ coach$/i, '').trim();
      setCoachAssignment({
        guildId: interaction.guildId,
        userId: target.id,
        teamName,
        roleId: role.id,
        assignedByUserId: interaction.user.id,
        assignedByTag: interaction.user.tag,
      });
    }
    await interaction.editReply({ content: `Assigned ${r2 ? `"${r1.name}" and "${r2.name}"` : `"${r1.name}"`} to ${target.tag}.` });
    // Refresh available teams pin
    try {
      await updateAvailableTeamsPin(interaction.client, interaction.guildId, {
        allowCreate: true,
        delayMs: 0,
        retries: 3,
        retryDelayMs: 800,
        guild: interaction.guild,
        // fetch members to keep availability accurate right after role change
        skipMemberFetch: false
      });
    } catch (e) {
      console.warn('[madden-assignteam] available teams pin update skipped:', e?.message || e);
    }
    // Refresh sim strike board to reflect new coach assignment
    try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch (e) { console.warn('[madden-assignteam] fair sim board update skipped:', e?.message || e); }
  } catch (err) {
    await interaction.editReply({ content: `Failed to assign roles: ${err.message || err}` });
  }
}

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const roleMap = loadRoleMap();
  const focused = interaction.options.getFocused().toLowerCase();
  const options = roleChoices(roleMap)
    .filter(r => r.name.toLowerCase().includes(focused))
    .slice(0, 25);
  try {
    await interaction.respond(options);
  } catch (err) {
    // Ignore stale/unknown interaction errors; they occur if the client cancels the autocomplete
    console.warn('[madden-assignrole autocomplete] respond failed:', err?.message || err);
  }
}

export default { data, execute, autocomplete };
