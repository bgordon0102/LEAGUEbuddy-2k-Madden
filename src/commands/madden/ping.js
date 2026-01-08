import { SlashCommandBuilder } from 'discord.js';

const data = new SlashCommandBuilder()
  .setName('madden-ping')
  .setDescription('Verify Madden commands are live.');

async function execute(interaction) {
  await interaction.reply({ content: 'Madden module is online. Use /madden-sync to pull from EA.', ephemeral: true });
}

export default { data, execute };
