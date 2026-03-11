import { SlashCommandBuilder, PermissionsBitField } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('server-list')
  .setDescription('List all servers the bot is in (staff only, shows member counts).')
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  // Restrict to admins to avoid exposing guild info broadly
  const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  if (!isAdmin) {
    await interaction.reply({ content: 'Only admins can run this.', ephemeral: true });
    return;
  }

  const lines = interaction.client.guilds.cache
    .map(g => `${g.name} (${g.id}) — ${g.memberCount ?? '??'} members`)
    .sort((a, b) => a.localeCompare(b));

  const header = `Serving ${lines.length} server${lines.length === 1 ? '' : 's'}:`;
  const body = lines.join('\n') || 'None';
  await interaction.reply({ content: `${header}\n${body}`.slice(0, 1900), ephemeral: true });
}

export default { data, execute };
