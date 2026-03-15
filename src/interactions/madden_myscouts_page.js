import { buildPagesForUser, buildMyScoutsComponents } from '../madden/coach/myscouts.js';

export const customId = /^madden_myscouts_page\|/;

export async function execute(interaction) {
  const parts = interaction.customId.split('|');
  if (parts.length < 3) return;
  const targetUserId = parts[1];
  const pageIdx = Number(parts[2]);
  if (interaction.user.id !== targetUserId) {
    await interaction.reply({ content: 'This menu is not yours.', ephemeral: true });
    return;
  }
  const { pages, error, classKey, activeName } = buildPagesForUser(targetUserId, interaction.guildId);
  if (error) {
    await interaction.update({ content: error, embeds: [], components: [] });
    return;
  }
  const total = pages.length;
  const idx = Math.max(0, Math.min(total - 1, pageIdx));

  await interaction.update({
    embeds: [pages[idx].embed],
    components: buildMyScoutsComponents(idx, pages, targetUserId, classKey, activeName),
  });
}

export default { customId, execute };
