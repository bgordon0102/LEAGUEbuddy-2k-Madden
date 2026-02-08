export const customId = "player_progression_modal_submit";

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== customId) return;
  try {
    await interaction.reply({
      content: 'Player progression/regression features are disabled for this league.',
      ephemeral: true,
    });
  } catch {}
}

export default { customId, execute };
