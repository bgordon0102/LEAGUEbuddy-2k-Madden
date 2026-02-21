// src/interactions/madden_top100test_prev.js
// Accept button IDs that carry state, e.g. madden_top100test_prev|week|0|1
export const customId = /^madden_top100test_prev/;

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  try {
    const mod = await import('../commands/madden/staff/top100test.js');
    const top100test = mod?.execute || mod?.default;
    if (typeof top100test !== 'function') throw new Error('top100test handler missing');
    await top100test(interaction);
  } catch (err) {
    console.error('[madden_top100test_prev] failed:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Interaction expired. Please rerun `/madden-top100test`.', flags: 64 }).catch(() => {});
    } else {
      await interaction.followUp({ content: 'Interaction expired. Please rerun `/madden-top100test`.', flags: 64 }).catch(() => {});
    }
  }
}
