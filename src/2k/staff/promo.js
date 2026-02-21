import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const cleanTeamName = (name) => (name || '').replace(/\s+Coach$/i, '');

const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');

const ALLOWED_STAFF = ['Paradise Commish', 'Paradise Co-Commish', 'Schedule Tracker'];

function safeEditReply(interaction, payload) {
  return interaction.editReply(payload).catch(async (err) => {
    if ([50027, 10015, 10062].includes(err?.code) && interaction.channel?.isTextBased()) {
      return interaction.channel.send(typeof payload === 'string' ? payload : { ...payload, ephemeral: false });
    }
    throw err;
  });
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export const data = new SlashCommandBuilder()
  .setName('2k-promo')
  .setDescription('Staff: Post promo + available 2K teams.')
  .addBooleanOption(o =>
    o.setName('link')
      .setDescription('Include the public join link at the bottom')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: false });

  // Staff gate
  const staffMap = loadJson(STAFF_ROLE_MAP_PATH);
  const allowedRoleIds = Object.entries(staffMap || {})
    .filter(([name]) => ALLOWED_STAFF.includes(name))
    .map(([, id]) => id)
    .filter(Boolean);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const isStaff = allowedRoleIds.length
    ? member.roles.cache.some(r => allowedRoleIds.includes(r.id))
    : member.permissions.has('Administrator');
  if (!isStaff) {
    await interaction.editReply({ content: 'Only staff can use this command.' });
    return;
  }

  const includeLink = interaction.options.getBoolean('link') ?? false;

  // Load coach role map
  const coachRoleMap = loadJson(COACH_ROLE_MAP_PATH);

  // Determine available teams
  const availableTeams = [];
  for (const [team, roleId] of Object.entries(coachRoleMap || {})) {
    let assigned = false;
    if (roleId) {
      const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
      const count = role?.members ? role.members.size : 0;
      assigned = count > 0;
    }
    if (!assigned) availableTeams.push(cleanTeamName(team));
  }

  // Promo text
  const lines = [
    '🌴 **Ghost Paradise + LEAGUEbuddy**',
    'The 2K league that runs itself — so you can just hoop.',
    '',
    '**Powered by LEAGUEbuddy — your all-in-one league manager built for serious competitors.**',
    '• Full up-to-date 2K rosters — viewable directly in Discord',
    '• Custom-built schedule to keep games flowing — 48hr advances',
    '• Auto game threads',
    '• In-Discord scouting + trade tools',
    '• Custom draft classes',
    '',
    '**Available Teams Below ⬇️**',
    availableTeams.length ? availableTeams.join('\n') : 'No open teams right now.',
    '',
    includeLink ? '🔗 **Join:** https://discord.gg/ghostsgaming' : null,
  ].filter(Boolean).join('\n\n');

  await safeEditReply(interaction, { content: lines });
}

export default { data, execute };
