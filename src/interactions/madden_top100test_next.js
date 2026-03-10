// src/interactions/madden_top100test_next.js
// Accept button IDs that carry state, e.g. madden_top100test_next|week|0|2
export const customId = /^madden_top100test_next/;

export async function execute(interaction) {
  console.log('[madden_top100test_next] Button handler called:', interaction.customId);
  if (!interaction.isButton()) return;
  try {
    const parts = (interaction.customId || '').split('|');
    const scope = parts[1] || 'season';
    const week = parts[2] === 'null' ? null : Number(parts[2]);
    const page = Number(parts[3] || 1);
    const isPublic = parts[4] === '1';
    const mod = await import('../commands/madden/staff/top100test.js');
    const top100test = mod?.execute || mod?.default;
    if (typeof top100test !== 'function') throw new Error('top100test handler missing');
    console.log('[madden_top100test_next] Calling top100test handler...', { scope, week, page, isPublic });
    await top100test(interaction, { scope, week, page, public: isPublic });
    console.log('[madden_top100test_next] top100test handler completed.');
  } catch (err) {
    console.error('[madden_top100test_next] failed:', err);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Interaction expired. Please run `/madden-top100test` again.', flags: 64 });
        console.log('[madden_top100test_next] Sent reply for expired interaction.');
      } else {
        await interaction.followUp({ content: 'Interaction expired. Please run `/madden-top100test` again.', flags: 64 });
        console.log('[madden_top100test_next] Sent followUp for expired interaction.');
      }
    } catch (e2) {
      console.error('[madden_top100test_next] Failed to send error message:', e2);
    }
  }
}
