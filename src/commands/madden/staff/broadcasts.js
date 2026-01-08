import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const data = new SlashCommandBuilder()
  .setName('madden-broadcast')
  .setDescription('Post a Madden broadcast message to this channel.')
  .addStringOption(opt =>
    opt.setName('title')
      .setDescription('Title for the broadcast')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('message')
      .setDescription('Body text')
      .setRequired(true)
  );

async function execute(interaction) {
  const title = interaction.options.getString('title');
  const message = interaction.options.getString('message');
  await interaction.deferReply({ ephemeral: true });
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(0x5865f2);
  await interaction.channel.send({ embeds: [embed] });
  await interaction.editReply({ content: 'Broadcast sent.' });
}

export default { data, execute };
