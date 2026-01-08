import { SlashCommandBuilder } from 'discord.js';

const data = new SlashCommandBuilder()
  .setName('madden-sync')
  .setDescription('Trigger a Madden data sync (stub; wire storage before use)')
  .addStringOption(option =>
    option.setName('league_id')
      .setDescription('Madden league ID')
      .setRequired(true)
  );

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id');
  await interaction.reply({
    content: `Sync requested for Madden league ${leagueId}. Storage/fetch not yet wired.`,
    ephemeral: true
  });
}

export default { data, execute };
