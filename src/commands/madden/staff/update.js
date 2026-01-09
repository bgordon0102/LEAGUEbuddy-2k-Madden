import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { runSync } from '../sync.js';
import { getMessageForWeek } from '../../../madden/madden_utils.js';
import { SnallabotProvider } from '../../../madden/providers/SnallabotProvider.js';

const data = new SlashCommandBuilder()
  .setName('madden-update')
  .setDescription('Refresh Madden data from EA for the saved league (no league_id needed).')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await interaction.editReply({ content: 'No league set. Run /madden-set-league or provide league_id via /madden-sync once.' });
      return;
    }
    const provider = new SnallabotProvider();
    const summary = await runSync(leagueId, provider);
    const embed = new EmbedBuilder()
      .setTitle('Madden Update Complete')
      .setDescription('Latest data pulled from EA and saved locally.')
      .setColor(0x00cc66)
      .addFields(
        { name: 'League', value: String(summary.leagueId), inline: true },
        { name: 'Week', value: summary.currentWeek ? `${summary.currentWeek} (${getMessageForWeek(summary.currentWeek)})` : 'unknown', inline: true },
        { name: 'Teams', value: String(summary.teamsCount), inline: true },
        { name: 'Standings', value: String(summary.standingsCount), inline: true },
        { name: 'Games', value: String(summary.gamesCount), inline: true },
        { name: 'Saved', value: summary.outPath, inline: false }
      );
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Unknown error';
    const shortMsg = msg.length > 1800 ? `${msg.slice(0, 1797)}...` : msg;
    const embed = new EmbedBuilder()
      .setTitle('Madden Update Failed')
      .setDescription(shortMsg)
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
