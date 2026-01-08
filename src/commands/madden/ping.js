import { SlashCommandBuilder } from 'discord.js';

const data = new SlashCommandBuilder()
  .setName('madden-ping')
  .setDescription('Verify Madden commands are live and the bot can respond.');

async function execute(interaction) {
  await interaction.reply({ content: 'Madden module is online. Configure storage and sync when ready.', ephemeral: true });
}

export default { data, execute };
