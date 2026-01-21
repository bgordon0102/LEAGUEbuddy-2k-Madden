// src/interactions/madden_top100test_next.js
// Accept button IDs that carry state, e.g. madden_top100test_next|week|0|2
export const customId = /^madden_top100test_next/;

export async function execute(interaction) {
  const { execute: top100test } = await import('../commands/madden/staff/top100test.js');
  // top100test will parse the customId to retain scope/week/page
  await top100test(interaction);
}
