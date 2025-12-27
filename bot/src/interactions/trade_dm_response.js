export const customId = /^trade_dm_(approve|deny)$/;
// Handles DM Approve/Deny buttons for trade proposals
import { ButtonInteraction, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import fs from "fs";
import path from "path";

const COMMITTEE_CHANNEL_ID = "1425555499440410812"; // Committee channel
const APPROVED_CHANNEL_ID = "1425555422063890443";
const DENIED_CHANNEL_ID = "1425567560241254520";

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    const customId = interaction.customId;
    // Find trade info: allow any user with the coach role for the team to approve/deny
    let tradeId = null;
    for (const id of Object.keys(global.activeTrades || {})) {
        const t = global.activeTrades[id];
        if (t && t.status === "pending") {
            // Check if user has the coach role for the team
            const guild = interaction.guild || interaction.client.guilds.cache.first();
            if (guild) {
                const roleId = t.coachBId;
                const member = guild.members.cache.get(interaction.user.id);
                if (member && member.roles.cache.has(roleId)) {
                    tradeId = id;
                    break;
                }
            }
        }
    }
    if (!tradeId) {
        await interaction.reply({ content: "Trade not found or expired.", ephemeral: true });
        return;
    }
    const trade = global.activeTrades[tradeId];
    // Check 24 hour expiry
    if (Date.now() - trade.submittedAt > 24 * 60 * 60 * 1000) {
        trade.status = "expired";
        await interaction.reply({ content: "Trade has expired.", ephemeral: true });
        return;
    }
    if (customId === "trade_dm_deny") {
        trade.status = "denied";
        // Notify Coach A with robust DM logic
        try {
            const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
            console.log(`[DM Attempt] Notifying Coach A (ID: ${trade.proposerId}) for team ${trade.yourTeam}`);
            await userA.send({ content: `Your trade proposal with ${trade.otherTeam} was denied.` });
            await interaction.reply({ content: "Trade denied. Coach A has been notified.", ephemeral: true });
        } catch (err) {
            console.error(`[DM Error] Could not DM Coach A (ID: ${trade.proposerId}):`, err);
            // Retry after 2 seconds
            setTimeout(async () => {
                try {
                    const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
                    await userA.send({ content: `Your trade proposal with ${trade.otherTeam} was denied.` });
                } catch (err2) {
                    console.error(`[DM Retry Error] Could not DM Coach A (ID: ${trade.proposerId}):`, err2);
                }
            }, 2000);
            await interaction.reply({ content: `Trade denied, but could not DM Coach A (ID: ${trade.proposerId}).`, ephemeral: true });
        }
        return;
    }
    if (customId === "trade_dm_approve") {
        trade.status = "committee";
        // Post to committee channel
        const embed = new EmbedBuilder()
            .setTitle("Trade Committee Vote Required")
            .addFields(
                { name: "Your Team", value: trade.yourTeam, inline: true },
                { name: "Other Team", value: trade.otherTeam, inline: true },
                { name: "Assets Sent", value: trade.assetsSent },
                { name: "Assets Received", value: trade.assetsReceived }
            );
        if (trade.notes) embed.addFields({ name: "Notes", value: trade.notes });
        embed.setColor(0x5865F2);
        const committeeRoleId = "1428100787225235526";
        const approveBtn = new ButtonBuilder().setCustomId(`committee_approve_${tradeId}`).setLabel("Approve").setStyle(ButtonStyle.Success);
        const denyBtn = new ButtonBuilder().setCustomId(`committee_deny_${tradeId}`).setLabel("Deny").setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);
        const committeeChannel = await interaction.client.channels.fetch(COMMITTEE_CHANNEL_ID);
        const committeeMsg = await committeeChannel.send({ content: `<@&${committeeRoleId}>`, embeds: [embed], components: [row] });
        // Save trade data in pendingTrades.json using committeeMsg.id as key
        const pendingPath = path.join(process.cwd(), 'data/pendingTrades.json');
        let pendingTrades = {};
        if (fs.existsSync(pendingPath)) {
            try {
                pendingTrades = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
            } catch { pendingTrades = {}; }
        }
        pendingTrades[committeeMsg.id] = { trade, votes: {} };
        try {
            fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2));
        } catch (err) {
            console.error('Failed to save pending trade for committee:', err);
        }
        // Robust DM logic for Coach B
        try {
            const userB = await interaction.client.users.fetch(trade.coachBId, { force: true });
            console.log(`[DM Attempt] Notifying Coach B (ID: ${trade.coachBId}) for team ${trade.otherTeam}`);
            await userB.send({ content: `Your trade proposal with ${trade.yourTeam} was approved and sent to committee for voting.` });
        } catch (err) {
            console.error(`[DM Error] Could not DM Coach B (ID: ${trade.coachBId}):`, err);
            // Retry after 2 seconds
            setTimeout(async () => {
                try {
                    const userB = await interaction.client.users.fetch(trade.coachBId, { force: true });
                    await userB.send({ content: `Your trade proposal with ${trade.yourTeam} was approved and sent to committee for voting.` });
                } catch (err2) {
                    console.error(`[DM Retry Error] Could not DM Coach B (ID: ${trade.coachBId}):`, err2);
                }
            }, 2000);
        }
        await interaction.reply({ content: "Trade sent to committee for voting.", ephemeral: true });
        return;
    }
}
