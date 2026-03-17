import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import { inferRecognitionContext } from '../shared/league_recognition.js';
import { buildSportsbookPrivateView } from '../shared/madden_sportsbook.js';

export const customId = /^madden_sportsbook_(open|view|card|board)\|/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const parts = interaction.customId.split('|');
  const action = parts[0].replace('madden_sportsbook_', '');
  const weekNumber = Number(parts[1] || 0);
  const rawMode = parts[2] || 'board';
  const mode = action === 'board'
    ? 'leaderboard'
    : action === 'card'
      ? 'card'
      : rawMode === 'tab_board' || rawMode === 'page_prev' || rawMode === 'page_next'
        ? 'board'
        : rawMode === 'tab_card'
          ? 'card'
          : rawMode === 'tab_leaderboard'
            ? 'leaderboard'
            : rawMode;
  const index = Number(parts[3] || 0);
  const context = inferRecognitionContext('madden', interaction.guildId);
  const seasonKey = context?.seasonKey;
  if (!seasonKey) {
    await interaction.reply({ content: 'Sportsbook season context is not ready yet.', flags: 64 });
    return;
  }
  const payload = buildSportsbookPrivateView({
    seasonKey,
    weekNumber,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    mode,
    index,
  });
  if (action === 'view') {
    await interaction.update(payload);
    return;
  }
  await interaction.reply({ ...payload, flags: 64 });
}

export default { customId, execute };
