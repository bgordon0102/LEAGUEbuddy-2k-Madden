// Handles the select menu interaction after the trade button
import fs from "fs";
import path from "path";
import { StringSelectMenuInteraction, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

export const customId = [
    "trade_select_players",
    "trade_select_picks",
    "trade_select_partner",
    "trade_select_partner_1",
    "trade_select_partner_2"
];

export async function execute(interaction) {
    if (!(interaction instanceof StringSelectMenuInteraction)) return;
    // Get selections from the interaction
    const { customId, values, user } = interaction;
    // Store selections in a temporary store (could be global, DB, or cache)
    global.activeTradeSelections = global.activeTradeSelections || {};
    const userKey = user.id;
    global.activeTradeSelections[userKey] = global.activeTradeSelections[userKey] || {};
    if (customId === "trade_select_players") {
        global.activeTradeSelections[userKey].players = values;
        await interaction.reply({ content: `Selected players: ${values.join(", ")}`, ephemeral: true });
    } else if (customId === "trade_select_picks") {
        global.activeTradeSelections[userKey].picks = values;
        await interaction.reply({ content: `Selected picks: ${values.join(", ")}`, ephemeral: true });
    } else if (
        customId === "trade_select_partner" ||
        customId === "trade_select_partner_1" ||
        customId === "trade_select_partner_2"
    ) {
        global.activeTradeSelections[userKey].partner = values[0];
        // After partner is selected, show modal for trade notes
        const modal = new ModalBuilder()
            .setCustomId('trade_modal_submit')
            .setTitle('Submit Trade Proposal')
            .addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('notes')
                        .setLabel('Trade Notes (optional)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                )
            );
        await interaction.showModal(modal);
    }
}
