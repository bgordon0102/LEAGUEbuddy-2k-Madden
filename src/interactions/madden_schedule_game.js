import { getDefaultLeagueId, loadLeagueSnapshot } from '../../madden/madden_data.js';
import { buildGameDetailView, buildScheduleWeekView } from '../madden/coach/schedule.js';

export const customId = /^madden_schedule_game\|/;

export async function execute(interaction) {
  const [, weekRaw] = interaction.customId.split('|');
  const leagueId = getDefaultLeagueId();
  if (!leagueId) {
    await interaction.reply({ content: 'No Madden league is set.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const weekIndex = Number(weekRaw || 0);
  const scheduleId = interaction.values?.[0];
  const detail = buildGameDetailView(snapshot, weekIndex, scheduleId);
  if (!detail) {
    const fallback = buildScheduleWeekView(snapshot, weekIndex);
    await interaction.update({
      content: 'Could not open that game from the current export.',
      embeds: [fallback.embed],
      components: fallback.components,
    });
    return;
  }
  await interaction.update({ embeds: [detail.embed], components: detail.components });
}

export default { customId, execute };
