export const customId = /^trade_dm_(approve|deny)_/;
// Handles DM Approve/Deny buttons for trade proposals
import { ButtonInteraction, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import fs from "fs";
import path from "path";

const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'activeTrades.json');

const COMMITTEE_CHANNEL_ID = "1425555499440410812"; // Committee channel
const APPROVED_CHANNEL_ID = "1425555422063890443";
const DENIED_CHANNEL_ID = "1425567560241254520";

function readActiveTrades() {
    try {
        return JSON.parse(fs.readFileSync(ACTIVE_TRADES_PATH, 'utf8'));
    } catch {
        return {};
    }
}
function writeActiveTrades(trades) {
    try {
        fs.writeFileSync(ACTIVE_TRADES_PATH, JSON.stringify(trades ?? {}, null, 2));
    } catch (err) {
        console.error('[trade_dm_response] Failed to write activeTrades:', err);
    }
}

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    // Defer immediately to avoid "Unknown interaction" when async work is long
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (err) {
        console.error('[trade_dm_response] deferReply failed:', err);
        return;
    }
    const customId = interaction.customId;
    const tradeId = customId.replace('trade_dm_approve_', '').replace('trade_dm_deny_', '');
    const trades = { ...global.activeTrades, ...readActiveTrades() };
    const trade = trades[tradeId];
    if (!trade) {
        await interaction.editReply({ content: "Trade not found or expired.", components: [] });
        return;
    }
    if (trade.status && trade.status !== "pending") {
        await interaction.editReply({ content: `This trade has already been processed (${trade.status}).`, components: [] });
        return;
    }
    // Check 24 hour expiry
    if (trade.expiresAt && Date.now() > trade.expiresAt) {
        trade.status = "expired";
        trades[tradeId] = trade;
        writeActiveTrades(trades);
        try {
            const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
            await userA.send({ content: `Your trade with ${trade.otherTeam} expired (no response within 24 hours).` });
        } catch (err) { console.error('[DM Error] Could not DM proposer about expiry:', err); }
        await interaction.editReply({ content: "Trade has expired.", components: [] });
        return;
    }
    if (customId.startsWith("trade_dm_deny_")) {
        trade.status = "denied";
        trades[tradeId] = trade;
        writeActiveTrades(trades);
        // Notify Coach A with the reviewer name
        try {
            const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
            console.log(`[DM Attempt] Notifying Coach A (ID: ${trade.proposerId}) for team ${trade.yourTeam}`);
            await userA.send({ content: `Your trade proposal with ${trade.otherTeam} was denied by ${interaction.user.username}.` });
            await interaction.editReply({ content: `Trade denied by ${interaction.user.username}. Proposer notified.`, components: [] });
        } catch (err) {
            console.error(`[DM Error] Could not DM Coach A (ID: ${trade.proposerId}):`, err);
            // Retry after 2 seconds
            setTimeout(async () => {
                try {
                    const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
                    await userA.send({ content: `Your trade proposal with ${trade.otherTeam} was denied by ${interaction.user.username}.` });
                } catch (err2) {
                    console.error(`[DM Retry Error] Could not DM Coach A (ID: ${trade.proposerId}):`, err2);
                }
            }, 2000);
            await interaction.editReply({ content: `Trade denied by ${interaction.user.username}, but could not DM proposer (${trade.proposerId}).`, components: [] });
        }
        return;
    }
    if (customId.startsWith("trade_dm_approve_")) {
        if (trade.postedToCommittee) {
            await interaction.editReply({ content: "This trade has already been sent to committee.", components: [] });
            return;
        }
        trade.status = "committee";
        trade.postedToCommittee = true;
        trades[tradeId] = trade;
        writeActiveTrades(trades);
        // Notify Coach A that Coach B approved and committee is next
        try {
            const userA = await interaction.client.users.fetch(trade.proposerId, { force: true });
            await userA.send({ content: `Your trade with ${trade.otherTeam} was approved by ${interaction.user.username} and sent to committee.` });
        } catch (err) {
            console.error('[DM Error] Could not DM Coach A about committee submission:', err);
        }
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
        // Robust DM logic for Coach B (handle role IDs)
        let notifiedB = false;
        // Try user ID first
        try {
            const userB = await interaction.client.users.fetch(trade.coachBId, { force: true });
            console.log(`[DM Attempt] Notifying Coach B (ID: ${trade.coachBId}) for team ${trade.otherTeam}`);
            await userB.send({ content: `Your trade proposal with ${trade.yourTeam} was approved and sent to committee for voting.` });
            notifiedB = true;
        } catch (err) {
            console.error(`[DM Error] Could not DM Coach B (ID may be role):`, err);
        }
        // If coachBId is a role, DM members with that role in the guild
        if (!notifiedB && trade.guildId) {
            try {
                const guild = await interaction.client.guilds.fetch(trade.guildId);
                const role = await guild.roles.fetch(trade.coachBId).catch(() => null);
                if (role) {
                    const members = role.members;
                    for (const member of members.values()) {
                        if (member.user.id === trade.proposerId) continue; // don’t DM proposer
                        try {
                            await member.user.send({ content: `Your trade proposal with ${trade.yourTeam} was approved and sent to committee for voting.` });
                            notifiedB = true;
                        } catch (innerErr) {
                            console.error('[DM Error] Could not DM role member:', innerErr);
                        }
                    }
                }
            } catch (err) {
                console.error('[DM Error] Could not resolve role members for Coach B:', err);
            }
        }
        await interaction.editReply({ content: "Trade sent to committee for voting.", components: [] });
        return;
    }
}
