// Progression disabled: respond with notice
export const customId = "submit_progression_button";

export async function execute(interaction) {
  try {
    await interaction.reply({
      content: 'Player progression/regression features are disabled for this league.',
      ephemeral: true,
    });
  } catch (err) {
    // best-effort, swallow errors
  }
}

export default { customId, execute };
