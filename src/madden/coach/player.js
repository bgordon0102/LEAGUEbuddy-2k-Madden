import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-player')
  .setDescription('Lookup a player (requires roster data in snapshot; limited for now).')
  .addStringOption(opt =>
    opt.setName('name')
      .setDescription('Player name to search')
      .setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  );

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  const name = interaction.options.getString('name')?.toLowerCase();
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    // Without roster exports, we can only match team names. Surface a helpful message.
    const embed = new EmbedBuilder()
      .setTitle('Player lookup limited')
      .setDescription([
        'Rosters were not included in the last sync; /madden-sync currently pulls league info/teams/standings/schedule only.',
        'Run a fuller export (or extend sync to include rosters), then re-run this command.',
        `Searched for: ${name}`,
        `Teams available: ${teams.length}`,
      ].join('\n'))
      .setColor(0xffcc00);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to lookup player: ${err.message}` });
  }
}

export default { data, execute };
