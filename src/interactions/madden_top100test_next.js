// src/interactions/madden_top100test_next.js
export const customId = 'madden_top100test_next';

export async function execute(interaction) {
    // Get the current page from the embed footer
    const embed = interaction.message.embeds[0];
    if (!embed) return;
    const footer = embed.footer?.text || '';
    const match = footer.match(/Page (\d+)[^\d]+(\d+)/);
    let page = match ? parseInt(match[1], 10) : 1;
    const totalPages = match ? parseInt(match[2], 10) : 1;
    if (page < totalPages) page++;
    // Re-run the command logic to get the new page
    const { execute: top100test } = await import('../commands/madden/staff/top100test.js');
    // Simulate the command with the new page
    await top100test(interaction, { page });
}
