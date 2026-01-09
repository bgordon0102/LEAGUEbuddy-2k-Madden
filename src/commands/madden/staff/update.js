import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { runSync } from '../sync.js';
import { getMessageForWeek } from '../../../madden/madden_utils.js';
import { SnallabotProvider } from '../../../madden/providers/SnallabotProvider.js';
import { updateStatLeaders } from '../../../madden/stat_leaders.js';
import { updateStandings } from '../../../madden/standings_pin.js';
import { updatePlayoffPicture } from '../../../madden/playoff_picture.js';
import { updatePowerRankings } from '../../../madden/power_rankings.js';
import { updateTransactions } from '../../../madden/transactions.js';
import { updatePlayerChanges } from '../../../madden/player_changes.js';
import { updateInjuries } from '../../../madden/injuries.js';

const data = new SlashCommandBuilder()
  .setName('madden-weeklyupdate')
  .setDescription('Refresh Madden data for the saved league (staff-only, run after each advance).')
  .addIntegerOption(o => o.setName('week').setDescription('Override current week for sync (optional)').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const weekOverride = interaction.options.getInteger('week');
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
      return;
    }
    const provider = new SnallabotProvider();
    const summary = await runSync(leagueId, provider, { week: weekOverride });
    // Update stat leaders embed if channel configured
    try {
      await updateStatLeaders(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] stat leaders update skipped:', e?.message || e);
    }
    // Update standings embed
    try {
      await updateStandings(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] standings update skipped:', e?.message || e);
    }
    // Update playoff picture embed
    try {
      await updatePlayoffPicture(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] playoff picture update skipped:', e?.message || e);
    }
    // Update power rankings embed
    try {
      await updatePowerRankings(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] power rankings update skipped:', e?.message || e);
    }
    // Post weekly transactions
    try {
      await updateTransactions(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] transactions update skipped:', e?.message || e);
    }
    // Player change log (position/attribute/dev changes)
    try {
      await updatePlayerChanges(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] player changes update skipped:', e?.message || e);
    }
    // Injuries
    try {
      await updateInjuries(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] injuries update skipped:', e?.message || e);
    }
    const embed = new EmbedBuilder()
      .setTitle('Madden Weekly Update Complete')
      .setDescription('Latest data pulled and saved locally.')
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
    const lower = msg.toLowerCase();
    let shortType = 'Unknown';
    let guidance = 'Try again shortly.';
    if (lower.includes('no local ea tokens')) {
      shortType = 'Tokens missing';
      guidance = 'Run `/madden-auth` (or `/madden-auth reset` then `/madden-auth`), then rerun `/madden-weeklyupdate`.';
    } else if (lower.includes('no sessionkey') || lower.includes('auth_err_invalid_token') || lower.includes('server information was not found')) {
      shortType = 'Auth/session';
      guidance = 'Tokens look bad. Run `/madden-auth reset` then `/madden-auth` (PS5 Madden 2026 account), ensure `EA_CONSOLE=ps5` / `EA_GAME_YEAR=2026`, then rerun `/madden-weeklyupdate`.';
    } else if (lower.includes('deleted') || lower.includes('league')) {
      shortType = 'League ID';
      guidance = 'Check the league ID. Run `/madden-set-league <your_league_id>` then rerun `/madden-weeklyupdate`.';
    }
    const shortMsg = shortType;
    const embed = new EmbedBuilder()
      .setTitle('Madden Update Failed')
      .setDescription(shortMsg)
      .addFields({ name: 'Next steps', value: guidance })
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
