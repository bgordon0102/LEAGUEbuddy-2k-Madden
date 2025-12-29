export const customId = /^mergedraft_cancel_(\d+)/;

export async function execute(interaction) {
  try {
    await interaction.update({ content: 'Draft merge cancelled.', components: [] });
  } catch (err) {
    console.error('[mergedraft cancel] Failed:', err);
    try {
      await interaction.reply({ content: 'Failed to cancel merge.', ephemeral: true });
    } catch (e) {
      // ignore
    }
  }
}

export default { customId, execute };
