import { SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { updateAvailable2KTeamsPin } from '../../../2k/available_teams.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
const STAFF_MAP_FILE = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const STAFF_ROLES = ['Paradise Commish', 'Paradise Co-Commish', 'Schedule Tracker', 'Gameplay Mod', 'Ghost Paradise'];

function loadRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function loadStaffIds() {
  try {
    return JSON.parse(fs.readFileSync(STAFF_MAP_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function isStaff(member) {
  const staffMap = loadStaffIds();
  const allowedIds = STAFF_ROLES.map(name => staffMap[name]).filter(Boolean);
  if (allowedIds.some(id => member.roles.cache.has(id))) return true;
  return member.permissions.has(PermissionsBitField.Flags.ManageChannels) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

export const data = new SlashCommandBuilder()
  .setName('2k-removerole')
  .setDescription('Remove up to two NBA roles from a user (Commish/Co-Commish staff only).')
  .addUserOption(o => o.setName('user').setDescription('User to update').setRequired(true))
  .addStringOption(o => o.setName('role1').setDescription('First role to remove').setRequired(true).setAutocomplete(true))
  .addStringOption(o => o.setName('role2').setDescription('Second role to remove (optional)').setRequired(false).setAutocomplete(true))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply({ ephemeral: true });

  const invoker = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!invoker || !isStaff(invoker)) {
    await interaction.editReply({ content: 'Only Commish/Co-Commish staff can use this command.' });
    return;
  }

  const roleMap = loadRoleMap();
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
  if (!r1 || !guildMember.roles.cache.has(r1.id)) {
    await interaction.editReply({ content: `${target.tag} does not have "${roleName1}".` });
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
    if (r2 && guildMember.roles.cache.has(r2.id)) {
      await guildMember.roles.remove(r2);
    }
    await interaction.editReply({ content: `Removed ${r2 ? `"${r1.name}" and "${r2.name}"` : `"${r1.name}"`} from ${target.tag}.` });
    try {
      await updateAvailable2KTeamsPin(interaction.client, interaction.guildId, { allowCreate: true });
    } catch (pinErr) {
      console.error('[2k-removerole] Failed to update available teams pin:', pinErr);
    }
  } catch (err) {
    await interaction.editReply({ content: `Failed to remove roles: ${err.message || err}` });
  }
}

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const roleMap = loadRoleMap();
  const focused = interaction.options.getFocused().toLowerCase();
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

  const choices = Object.entries(roleMap)
    .filter(([name, id]) => member.roles.cache.has(id))
    .map(([name]) => ({ name, value: name }))
    .filter(c => c.name.toLowerCase().includes(focused))
    .slice(0, 25);

  try {
    await interaction.respond(choices);
  } catch (err) {
    console.warn('[2k-removerole autocomplete] respond failed:', err?.message || err);
  }
}

export default { data, execute, autocomplete };
