// Handles upgrade modal submission, posts to progression/regression channel
import fs from "fs";
import path from "path";
import { EmbedBuilder } from "discord.js";

// Channel IDs (replace with your actual channel IDs)
const PROGRESSION_CHANNEL_ID = "1425555037328773220";

export const customId = "upgrade_modal_submit";

export async function execute(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== "upgrade_modal_submit") return;
    const playerName = interaction.fields.getTextInputValue("playerName");
    const upgradeDetails = interaction.fields.getTextInputValue("upgradeDetails");

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
    const norm = str => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const idx = players.findIndex(p => norm(p.name) === norm(playerName));
    if (idx === -1) {
        await interaction.reply({ content: "Player not found in your roster.", ephemeral: true });
        return;
    }

    // Apply upgrade (customize this logic as needed)
    players[idx].upgrades = players[idx].upgrades || [];
    players[idx].upgrades.push({ details: upgradeDetails, date: new Date().toISOString() });

    // Save changes
    if (Array.isArray(roster)) {
        fs.writeFileSync(rosterPath, JSON.stringify(players, null, 2));
    } else {
        roster.players = players;
        fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
    }

    const embed = new EmbedBuilder()
        .setTitle("Progression/Upgrade Request")
        .addFields(
            { name: "Player Name", value: playerName },
            { name: "Details", value: upgradeDetails }
        )
        .setColor(0x00FF00);

    // Post to progression channel
    const channel = await interaction.client.channels.fetch(PROGRESSION_CHANNEL_ID);
    if (channel) {
        await channel.send({ embeds: [embed] });
        await interaction.reply({ content: `Upgrade for ${playerName} submitted and saved!`, ephemeral: true });
    } else {
        await interaction.reply({ content: `Error: Progression channel not found, but upgrade was saved.`, ephemeral: true });
    }
}
