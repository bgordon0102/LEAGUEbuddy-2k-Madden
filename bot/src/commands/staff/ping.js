import { SlashCommandBuilder } from 'discord.js';

const data = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies with Pong!');

async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ content: 'Pong!' });
    // ...existing code...
}

export default { data, execute };
