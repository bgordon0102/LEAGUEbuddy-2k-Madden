// src/interactions/madden_top100test_prev.js
// Accept button IDs that carry state, e.g. madden_top100test_prev|week|0|1
export const customId = /^madden_top100test_prev/;

export async function execute(interaction) {
  const { execute: top100test } = await import('../commands/madden/staff/top100test.js');
  // top100test will parse the customId to retain scope/week/page
  await top100test(interaction);
}
