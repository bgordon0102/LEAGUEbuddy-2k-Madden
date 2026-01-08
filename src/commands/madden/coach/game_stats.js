import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, findScheduleForWeek, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-game')
  .setDescription('Show a game from the last /madden-sync snapshot (by week + index).')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (required)')
      .setRequired(true)
  )
  .addIntegerOption(opt =>
    opt.setName('index')
      .setDescription('Game index in that week (1-based)')
      .setRequired(true)
  );

function summarizeGame(g) {
  const home = g?.homeTeam?.teamName || g?.homeTeam?.teamNickname || 'Home';
  const away = g?.awayTeam?.teamName || g?.awayTeam?.teamNickname || 'Away';
  const homeScore = g?.homeTeam?.score ?? '-';
  const awayScore = g?.awayTeam?.score ?? '-';
  return { home, away, homeScore, awayScore };
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  const week = interaction.options.getInteger('week');
  const idx = interaction.options.getInteger('index');
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const games = findScheduleForWeek(snapshot, week);
    const game = games[idx - 1];
    if (!game) {
      await interaction.editReply({ content: `No game at index ${idx} for week ${week}.` });
      return;
    }
    const info = summarizeGame(game);
    const embed = new EmbedBuilder()
      .setTitle(`Game — Week ${week} — ${info.away} @ ${info.home}`)
      .setDescription(`Score: ${info.away} ${info.awayScore} - ${info.homeScore} ${info.home}`)
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load game: ${err.message}` });
  }
}

export default { data, execute };
