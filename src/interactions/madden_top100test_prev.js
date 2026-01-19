// src/interactions/madden_top100test_prev.js
export const customId = 'madden_top100test_prev';

export async function execute(interaction) {
    const embed = interaction.message.embeds[0];
    if (!embed) return;
    const footer = embed.footer?.text || '';
    const match = footer.match(/Page (\d+)[^\d]+(\d+)/);
    let page = match ? parseInt(match[1], 10) : 1;
    const totalPages = match ? parseInt(match[2], 10) : 1;
    if (page > 1) page--;
    const { execute: top100test } = await import('../commands/madden/staff/top100test.js');
    await top100test(interaction, { page });
}
