import { loadLeagueSnapshot } from '../madden/madden_data.js';
import { buildRosterEmbeds } from '../commands/madden/coach/roster.js';

export const customId = 'madden_roster_select';

export async function execute(interaction) {
  if (!interaction.isStringSelectMenu() || interaction.customId !== customId) return;
  const teamId = interaction.values[0];
  if (!teamId) {
    await interaction.reply({ content: 'Team not found.', ephemeral: true });
    return;
  }
  try {
    const leagueId = process.env.MADDEN_LEAGUE_ID || null;
    const snapshot = loadLeagueSnapshot(leagueId);
    if (!snapshot) {
      await interaction.reply({ content: 'Could not load the current Madden league snapshot.', ephemeral: true });
      return;
    }
    const team = (snapshot?.teams?.leagueTeamInfoList || []).find(t => String(t.teamId) === String(teamId));
    if (!team) {
      await interaction.reply({ content: 'Team not found.', ephemeral: true });
      return;
    }
    const result = buildRosterEmbeds(snapshot, `${team.cityName} ${team.nickName}`);
    if (result.error) {
      await interaction.reply({ content: result.error, ephemeral: true });
      return;
    }
    await interaction.update({ content: null, embeds: result.embeds, components: [] });
  } catch (err) {
    console.error('[madden_roster_select] failed:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to load roster.' });
    } else {
      await interaction.reply({ content: 'Failed to load roster.', ephemeral: true });
    }
  }
}

export default { customId, execute };
