import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('madden-retires')
  .setDescription('Find and retire players no longer in the league (stub; staff-only).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await interaction.editReply({ content: 'Retire logic not implemented yet. Pending data source/criteria.' });
}

export default { data, execute };
