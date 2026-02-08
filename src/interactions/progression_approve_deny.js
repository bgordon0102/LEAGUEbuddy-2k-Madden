// Catch-all for legacy progression approve/deny buttons
export const customId = /^progression_(approve|deny)_.+/;

export async function execute(interaction) {
  try {
    await interaction.reply({
      content: 'Player progression/regression features are disabled for this league.',
      ephemeral: true,
    });
  } catch {}
}

export default { customId, execute };
