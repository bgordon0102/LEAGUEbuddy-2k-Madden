export const customId = "trade_modal_submit";
// Handles trade modal submission, DM to other coach, and committee flow
import fs from "fs";
import path from "path";
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";

// Channel IDs
const SUBMISSION_CHANNEL_ID = "1425555037328773220";
const COMMITTEE_CHANNEL_ID = "1425555499440410812"; // Committee channel
const APPROVED_CHANNEL_ID = "1425555422063890443";
const DENIED_CHANNEL_ID = "1425567560241254520";

// Helper to get coach Discord ID from team name
function getCoachId(teamName) {
    // Use teamRoleMap to get the role ID for the team
    const teamRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/teamRoleMap.json"), "utf8"));
    // Try exact match first
    let roleId = teamRoleMap[teamName];
    if (!roleId) {
        // Try case-insensitive and keyword match
        const normalized = teamName.trim().toLowerCase();
        for (const [fullName, rId] of Object.entries(teamRoleMap)) {
            if (fullName.toLowerCase().includes(normalized)) {
                roleId = rId;
                break;
            }
        }
    }
    return roleId || null;
}

// Helper to build trade embed
function buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes }) {
    const embed = new EmbedBuilder()
        .setTitle("Trade Proposal")
        .addFields(
            { name: "Your Team", value: yourTeam, inline: true },
            { name: "Other Team", value: otherTeam, inline: true },
            { name: "Assets Sent", value: assetsSent },
            { name: "Assets Received", value: assetsReceived }
        );
    if (notes) embed.addFields({ name: "Notes", value: notes });
    embed.setColor(0x5865F2);
    return embed;
}

export async function execute(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== "trade_modal_submit") return;
    const yourTeam = interaction.fields.getTextInputValue("yourTeam");
    const otherTeam = interaction.fields.getTextInputValue("otherTeam");
    const assetsSent = interaction.fields.getTextInputValue("assetsSent");
    const assetsReceived = interaction.fields.getTextInputValue("assetsReceived");
    const notes = interaction.fields.getTextInputValue("notes");

    // Build embed for proposer (Coach A)
    const embed = buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes });

    // Find Coach B
    const coachBId = getCoachId(otherTeam);
    if (!coachBId) {
        await interaction.reply({ content: `Could not find coach for team: ${otherTeam}`, ephemeral: true });
        return;
    }

    // DM Coach B with Approve/Deny buttons
    const approveBtn = new ButtonBuilder().setCustomId("trade_dm_approve").setLabel("Approve").setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder().setCustomId("trade_dm_deny").setLabel("Deny").setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

    // Store trade info for later (in-memory or DB, here just ephemeral for demo)
    // TODO: Implement persistent storage for trade proposals
    global.activeTrades = global.activeTrades || {};
    const tradeId = `${Date.now()}`;
    const tradeObj = {
        tradeId,
        proposerId: interaction.user.id,
        coachBId,
        yourTeam,
        otherTeam,
        assetsSent,
        assetsReceived,
        notes,
        submittedAt: Date.now(),
        status: "pending"
    };
    global.activeTrades[tradeId] = tradeObj;
    // Store in pendingTrades.json for persistence
    // No persistence to pendingTrades.json here. Only log after Coach B approves in pin_trade_channel_message.js.

    // Send DM to all users with the coach role for the team
    let sent = false;
    let sentUsernames = [];
    let roleName = otherTeam;
    try {
        // Try to get the role name from teamRoleMap
        const teamRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/teamRoleMap.json"), "utf8"));
        for (const [name, id] of Object.entries(teamRoleMap)) {
            if (id === getCoachId(otherTeam)) {
                roleName = name + ' Coach';
                break;
            }
        }
    } catch { }
    try {
        const guild = interaction.guild || interaction.client.guilds.cache.first();
        if (guild) {
            const roleId = getCoachId(otherTeam);
            if (roleId) {
                const members = guild.members.cache.filter(m => m.roles.cache.has(roleId));
                for (const member of members.values()) {
                    // Build embed for Coach B (reverse assets)
                    const coachBEmbed = buildTradeEmbed({
                        yourTeam: otherTeam,
                        otherTeam: yourTeam,
                        assetsSent: assetsReceived,
                        assetsReceived: assetsSent,
                        notes
                    });
                    await member.user.send({ embeds: [coachBEmbed], components: [row], content: `You have 24 hours to approve or deny this trade proposal.` });
                    sent = true;
                    sentUsernames.push(`${member.user.tag} (${member.user.id})`);
                }
            }
        }
    } catch (e) {
        sent = false;
    }
    if (sent && sentUsernames.length) {
        await interaction.reply({ content: `Trade proposal sent to ${roleName} for approval: ${sentUsernames.map(u => u.split(' ')[0]).join(", ")}`, ephemeral: true });
    } else {
        await interaction.reply({ content: `Could not DM coach for team: ${roleName}. They may not be in the server or have the correct role.`, ephemeral: true });
    }
}
