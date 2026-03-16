import { getDefaultLeagueId, loadLeagueSnapshot } from '../../madden/madden_data.js';
import { buildScheduleWeekView } from '../madden/coach/schedule.js';

export const customId = /^madden_schedule_page(?:\|.*)?$/;

export async function execute(interaction) {
  const weekRaw = interaction.isStringSelectMenu() ? interaction.values?.[0] : interaction.customId.split('|')[1];
  const leagueId = getDefaultLeagueId();
  if (!leagueId) {
    await interaction.reply({ content: 'No Madden league is set.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const view = buildScheduleWeekView(snapshot, Number(weekRaw || 0));
  await interaction.update({ embeds: [view.embed], components: view.components });
}

export default { customId, execute };
