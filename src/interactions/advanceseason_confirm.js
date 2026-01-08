import { ButtonInteraction } from 'discord.js';
import { runAdvanceSeason } from '../commands/2k/staff/advanceseason.js';

export const customId = /^advanceseason_(confirm|cancel)_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [_, action, seasonStr] = interaction.customId.split('_');
  const seasonno = parseInt(seasonStr, 10);
  if (Number.isNaN(seasonno)) {
    await interaction.reply({ content: 'Invalid season number.', ephemeral: true });
    return;
  }
  if (action === 'cancel') {
    await interaction.update({ content: 'Advance season canceled.', components: [] });
    return;
  }
  await interaction.update({ content: `Advancing to Season ${seasonno}...`, components: [] });
  try {
    const { teamsCount } = await runAdvanceSeason(seasonno, interaction.guild);
    await interaction.followUp({ content: `Started season ${seasonno}. Teams initialized: ${teamsCount}. Masters unchanged.`, flags: 64 });
  } catch (err) {
    console.error('[advanceseason_confirm] Failed:', err);
    try {
      await interaction.followUp({ content: 'Failed to advance season. Check logs.', flags: 64 });
    } catch {}
  }
}

export default { customId, execute };
