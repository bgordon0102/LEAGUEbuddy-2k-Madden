import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-teams')
  .setDescription('List teams from the last /madden-sync snapshot.')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  );

function formatTeam(team) {
  const name = team?.displayName || team?.teamName || `Team ${team?.teamId}`;
  return `${team?.teamId}: ${name}`;
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    const lines = teams.slice(0, 32).map(formatTeam);
    const embed = new EmbedBuilder()
      .setTitle(`Madden Teams — League ${leagueId}`)
      .setDescription(lines.join('\n') || 'No teams found in snapshot.')
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load teams: ${err.message}` });
  }
}

export default { data, execute };
