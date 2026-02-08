import { ButtonInteraction } from 'discord.js';
import { loadLeagueSnapshot } from '../madden/madden_data.js';
import { buildRosterEmbeds } from '../madden/coach/roster.js';

export const customId = /^madden_roster_page_(\d+)_([0-9]+)_([0-9]+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = customId.exec(interaction.customId);
  if (!match) return;
  const leagueId = match[1];
  const teamId = match[2];
  let page = Number(match[3]) || 0;
  try {
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
    const result = buildRosterEmbeds(snapshot, `${team.cityName} ${team.displayName || team.nickName}`);
    if (result.error) {
      await interaction.reply({ content: result.error, ephemeral: true });
      return;
    }
    const embeds = result.embeds;
    page = Math.max(0, Math.min(page, embeds.length - 1));
    const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');
    const baseId = `madden_roster_page_${leagueId}_${teamId}`;
    const row = embeds.length > 1
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${baseId}_${page - 1}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
          new ButtonBuilder()
            .setCustomId(`${baseId}_${page + 1}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= embeds.length - 1)
        )
      : null;
    await interaction.update({ embeds: [embeds[page]], components: row ? [row] : [] });
  } catch (err) {
    console.error('[madden_roster_page] failed:', err);
    try {
      await interaction.reply({ content: 'Failed to load roster page.', ephemeral: true });
    } catch {}
  }
}

export default { customId, execute };
