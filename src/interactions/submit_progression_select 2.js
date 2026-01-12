// Handles submit_progression_select interaction (player dropdown)
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = "submit_progression_select";

export async function execute(interaction) {
    // Get coach's team from coachRoleMap.json
    const coachMap = JSON.parse(fs.readFileSync("data/coachRoleMap.json", "utf8"));
    const userId = interaction.user.id;
    const teamName = coachMap[userId];
    if (!teamName) {
        await interaction.reply({ content: "Could not find your team.", ephemeral: true });
        return;
    }
    // Load roster
    const fileName = teamName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase() + ".json";
    const rosterPath = path.join(process.cwd(), "data/teams_rosters", fileName);
    if (!fs.existsSync(rosterPath)) {
        await interaction.reply({ content: "Roster file not found.", ephemeral: true });
        return;
    }
    const roster = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
    const players = Array.isArray(roster) ? roster : roster.players || [];
    // Build select menu options
    const options = players.map(p => ({ label: p.name, value: p.name })).slice(0, 25);
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId("progression_player_select")
        .setPlaceholder("Select a player to upgrade")
        .addOptions(options);
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: "Choose a player to upgrade:", components: [row], ephemeral: true });
}
