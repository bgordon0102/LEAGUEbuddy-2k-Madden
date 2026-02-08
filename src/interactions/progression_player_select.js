export const customId = "progression_player_select";

export async function execute(interaction) {
  try {
    await interaction.reply({
      content: 'Player progression/regression features are disabled for this league.',
      ephemeral: true,
    });
  } catch {}
}

export default { customId, execute };
