import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { updateAvailableTeamsPin } from '../../../madden/available_teams.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];
const ASSIGNABLE = ['Madden Trade Committe', 'Madden Trade Committee'];

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
  .setName('madden-removerole')
  .setDescription('Remove up to two Madden roles (coach or trade committee) from a user (Commish/Co-Commish only).')
  .addUserOption(o => o.setName('user').setDescription('User to update').setRequired(true))
  .addStringOption(o => o.setName('role1').setDescription('First role to remove').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('role2').setDescription('Second role to remove (optional)').setRequired(false).setAutocomplete(true))
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
  let roleName1 = interaction.options.getString('role1');
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

  // Resolve role1; if target doesn't have it, fall back to first assignable role they do have.
  let r1 = resolveRole(roleName1);
  if (r1 && !guildMember.roles.cache.has(r1.id)) {
    r1 = null;
  }
  if (!r1) {
    const assignableRoles = Object.entries(roleMap).filter(([n]) =>
      n.endsWith(' Coach') || ASSIGNABLE.includes(n)
    );
    const found = assignableRoles.find(([, id]) => guildMember.roles.cache.has(id));
    if (found) {
      roleName1 = found[0];
      r1 = resolveRole(roleName1);
    }
  }

  if (!r1) {
    await interaction.editReply({ content: `Could not resolve a coach role to remove for ${target.tag}.` });
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
    await guildMember.roles.remove(r1);
    if (r2) await guildMember.roles.remove(r2);
    await interaction.editReply({ content: `Removed ${r2 ? `"${r1.name}" and "${r2.name}"` : `"${r1.name}"`} from ${target.tag}.` });
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
      console.warn('[madden-removeteam] available teams pin update skipped:', e?.message || e);
    }
  } catch (err) {
    await interaction.editReply({ content: `Failed to remove roles: ${err.message || err}` });
  }
}

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const roleMap = loadRoleMap();
  const focused = interaction.options.getFocused().toLowerCase();

  let filteredRoles = [];
  try {
    const targetOpt = interaction.options.get('user');
    const targetId = targetOpt?.value;
    if (!targetId) {
      await interaction.respond([]);
      return;
    }
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!member) {
      await interaction.respond([]);
      return;
    }
    filteredRoles = roleChoices(roleMap).filter(r => {
      const id = roleMap[r.name];
      return id && member.roles.cache.has(id);
    });
  } catch {
    filteredRoles = [];
  }

  const options = filteredRoles
    .filter(r => r.name.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(options);
}

export default { data, execute, autocomplete };
