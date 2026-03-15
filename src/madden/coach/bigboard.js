import { SlashCommandBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { classIdForSeason, buildPages } from '../../../madden/helpers/bigboard_helpers.js';

export const data = new SlashCommandBuilder()
  .setName('madden-bigboard')
  .setDescription('View the Madden draft big board (paged, 32 prospects per page)');

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ flags: 64 }); } catch (_) {}
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    const payload = { content: 'No league set. Run /madden-set-league first.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const calendarYear =
      snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
      || snapshot?.info?.calendarYear
      || snapshot?.calendarYear;

    const classId = classIdForSeason(calendarYear);
    const { embeds, baseId } = buildPages(snapshot, classId, leagueId);

    const components = [];
    if (embeds.length > 1) {
      const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${baseId}_0`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`${baseId}_1`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(embeds.length <= 1),
      );
      components.push(row);
    }

    await interaction.editReply({ embeds: [embeds[0]], components });
  } catch (err) {
    console.error('[madden-bigboard] failed:', err);
    try {
      await interaction.editReply({ content: 'Failed to load big board.' });
    } catch (_) {}
  }
}

export default { data, execute };
