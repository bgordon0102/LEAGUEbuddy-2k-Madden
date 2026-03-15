import { ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadLeagueSnapshot } from '../madden/madden_data.js';
import { buildPickPages } from '../madden/coach/pickvalue.js';

export const customId = /^madden_pickvalue_page_(\d+)_([0-9]+)_(\d+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = customId.exec(interaction.customId);
  if (!match) return;
  const leagueId = match[1];
  let startYear = Number(match[2]);
  let page = Number(match[3]) || 0;
  try {
    const snapshot = loadLeagueSnapshot(leagueId) || {};
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
      || snapshot?.info?.calendarYear
      || new Date().getFullYear();
    const baseYear = Math.max(2027, seasonYear);
    // Map legacy small numbers (1,2,3) to actual years relative to current calendar year
    if (startYear >= 1 && startYear <= 10 && startYear < 1900) {
      startYear = baseYear + (startYear - 1);
    }
    const { embeds, baseId } = buildPickPages(startYear, baseYear, leagueId);
    if (!embeds?.length) {
      await interaction.update({ content: 'No pick pages available for that year.', components: [], embeds: [] }).catch(() => {});
      return;
    }
    page = Math.max(0, Math.min(page, embeds.length - 1));
    const row = embeds.length > 1
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${baseId}_${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
          new ButtonBuilder().setCustomId(`${baseId}_${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(page >= embeds.length - 1),
        )
      : null;
    await interaction.update({ embeds: [embeds[page]], components: row ? [row] : [] });
  } catch (err) {
    console.error('[madden_pickvalue_page] failed:', err);
    try { await interaction.reply({ content: 'Failed to load pick values.', ephemeral: true }); } catch {}
  }
}

export default { customId, execute };
