import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');

function normalizeTeam(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getStaffRoleIds() {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const allowed = ['Paradise Commish', 'Paradise Co-Commish'];
    return Object.entries(map || {})
      .filter(([name]) => allowed.includes(name))
      .map(([, id]) => id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getStaffMentions() {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const ALLOWED = ['Paradise Commish', 'Paradise Co-Commish'];
    const ids = Array.from(
      new Set(
        Object.entries(map || {})
          .filter(([name]) => ALLOWED.includes(name))
          .map(([, id]) => id)
          .filter(Boolean)
      )
    );
    return ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '';
  } catch {
    return '';
  }
}

function isStaff(member) {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const allowed = ['Paradise Commish', 'Paradise Co-Commish'];
    const allowedIds = Object.entries(map || {})
      .filter(([name]) => allowed.includes(name))
      .map(([, id]) => id);
    return allowedIds.length ? member.roles.cache.some(r => allowedIds.includes(r.id)) : false;
  } catch {
    return false;
  }
}

function canMarkComplete(member, thread) {
  if (!member || !member.roles) return false;
  // Staff check first
  if (isStaff(member)) return true;
  // Only allow the two coaches in this matchup thread
  try {
    const coachMap = JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
    // Helper to resolve a team name (exact or fuzzy) to a role ID
    const resolveRoleId = (name) => {
      if (!name) return null;
      const normTarget = normalizeTeam(name);
      for (const [team, roleId] of Object.entries(coachMap)) {
        const normTeam = normalizeTeam(team);
        if (normTeam === normTarget || normTeam.includes(normTarget) || normTarget.includes(normTeam)) {
          return roleId;
        }
      }
      return null;
    };
    const threadName = thread?.name || '';
    const parts = threadName.split(/-vs-/i).map(s => s.replace(/-w\d+|-week\d+/i, '').trim());
    const teamA = parts[0] || '';
    const teamB = parts[1] || '';
    const allowedRoleIds = new Set(
      [resolveRoleId(teamA), resolveRoleId(teamB), ...getStaffRoleIds()].filter(Boolean)
    );
    // Fallback: if we couldn't resolve from thread name, allow any coach role
    if (!allowedRoleIds.size) {
      Object.values(coachMap || {}).forEach(id => id && allowedRoleIds.add(id));
    }
    return member.roles.cache.some(r => allowedRoleIds.has(r.id));
  } catch {
    return false;
  }
}

export const customId = /^game_complete_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  if (!canMarkComplete(interaction.member, interaction.channel)) {
    await interaction.reply({ content: 'Only the two coaches in this game (or staff) can mark it complete.', ephemeral: true });
    return;
  }
  const thread = interaction.channel;
  const parent = thread?.parent;
  const staffMentions = getStaffMentions();
  const winningCoach = interaction.user;
  const content = `${staffMentions ? staffMentions + ' ' : ''}${winningCoach} marked this game complete.`;

  try {
    // Notify directly in the thread (so staff are tagged there)
    if (thread && thread.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('Game Completed')
        .setDescription(`Marked by: ${winningCoach}`)
        .setTimestamp(new Date())
        .setColor(0x57F287);
      await thread.send({ content, embeds: [embed] });
    } else if (parent && parent.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('Game Completed')
        .setDescription(`Thread: <#${thread?.id}>\nMarked by: ${winningCoach}`)
        .setTimestamp(new Date())
        .setColor(0x57F287);
      await parent.send({ content, embeds: [embed] });
    }
  } catch (err) {
    console.error('[game_complete_button] Failed to send staff notification:', err);
  }

  try {
    await interaction.reply({ content: 'Thanks! Staff have been notified that this game is complete.', ephemeral: true });
  } catch (err) {
    console.error('[game_complete_button] Failed to reply to button interaction:', err);
  }
}

export default { customId, execute };
