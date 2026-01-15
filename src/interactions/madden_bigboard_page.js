import { ButtonInteraction } from 'discord.js';
import { loadLeagueSnapshot } from '../madden/madden_data.js';
import { buildPages } from '../madden/helpers/bigboard_helpers.js';

export const customId = /^madden_bigboard_page_(\d+)_([a-z0-9_]+)_([0-9]+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = customId.exec(interaction.customId);
  if (!match) return;
  const leagueId = match[1];
  const classId = match[2];
  let page = Number(match[3]) || 0;
  try {
    const snapshot = loadLeagueSnapshot(leagueId) || {};
    const { embeds, baseId } = buildPages(snapshot, classId, leagueId);
    page = Math.max(0, Math.min(page, embeds.length - 1));
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');
    const row = embeds.length > 1
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${baseId}_${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
          new ButtonBuilder().setCustomId(`${baseId}_${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(page >= embeds.length - 1),
        )
      : null;
    await interaction.update({ embeds: [embeds[page]], components: row ? [row] : [] });
  } catch (err) {
    console.error('[madden_bigboard_page] failed:', err);
    try { await interaction.reply({ content: 'Failed to load big board page.', ephemeral: true }); } catch {}
  }
}

export default { customId, execute };
