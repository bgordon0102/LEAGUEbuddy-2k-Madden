// Handles submit_progression_button interaction
import { EmbedBuilder } from "discord.js";
import * as progressionApproveDeny from './progression_approve_deny.js';

const PROGRESSION_CHANNEL_ID = "1425555037328773220";

export const customId = "submit_progression_button";

export async function execute(interaction) {
    // Route approve/deny button to progression_approve_deny.js
    if (interaction.customId.startsWith('progression_approve_') || interaction.customId.startsWith('progression_deny_')) {
        await progressionApproveDeny.execute(interaction);
        return;
    }
    // Delegate to the new progression modal flow
    const { execute: submitPlayerProgression } = await import("./submit_player_progression.js");
    await submitPlayerProgression(interaction);
}
