import { EmbedBuilder } from 'discord.js';
import { brandTitle } from './madden_branding.js';

export async function resolveRoleUsers(guild, roleIds = []) {
  const users = new Map();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    if (role.members?.size) {
      role.members.forEach((m) => users.set(m.id, m.user));
      continue;
    }
    try {
      const all = await guild.members.fetch();
      all.filter((m) => m.roles.cache.has(roleId)).forEach((m) => users.set(m.id, m.user));
    } catch {
      // ignore
    }
  }
  return [...users.values()];
}

export async function sendCoachReceipt(guild, roleIds, { title, description, fields = [], color = 0xFEE75C } = {}) {
  const users = await resolveRoleUsers(guild, roleIds);
  if (!users.length) return 0;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(brandTitle(title))
    .setDescription(description)
    .setTimestamp();
  if (fields.length) embed.addFields(fields);

  let sent = 0;
  for (const user of users) {
    const ok = await user.send({ embeds: [embed] }).catch(() => null);
    if (ok) sent += 1;
  }
  return sent;
}
