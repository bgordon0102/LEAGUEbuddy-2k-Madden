import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, currentWeek, findScheduleForWeek, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-schedule')
  .setDescription('Show games for a given week from the last /madden-sync snapshot.')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (defaults to current)')
      .setRequired(false)
  );

function formatGame(g) {
  const home = g?.homeTeam?.teamName || g?.homeTeam?.teamNickname || 'Home';
  const away = g?.awayTeam?.teamName || g?.awayTeam?.teamNickname || 'Away';
  const homeScore = g?.homeTeam?.score ?? '-';
  const awayScore = g?.awayTeam?.score ?? '-';
  return `${away} ${awayScore} @ ${home} ${homeScore}`;
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  const weekOpt = interaction.options.getInteger('week');
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const wk = weekOpt ?? currentWeek(snapshot) ?? 1;
    const games = findScheduleForWeek(snapshot, wk);
    const lines = games.map(formatGame).slice(0, 20);
    const embed = new EmbedBuilder()
      .setTitle(`Madden Schedule — League ${leagueId}`)
      .setDescription(lines.join('\n') || 'No games found for this week in snapshot.')
      .addFields({ name: 'Week', value: `${wk}`, inline: true })
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load schedule: ${err.message}` });
  }
}

export default { data, execute };
