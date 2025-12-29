export const customId = "trade_modal_submit";
// Handles trade modal submission, DM to other coach, and committee flow
import fs from "fs";
import path from "path";
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { canTrade, getSeasonState } from "../utils/seasonUtils.js";

const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'activeTrades.json');
// Channel IDs
const SUBMISSION_CHANNEL_ID = "1425555037328773220";
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
        console.error('[trade_modal_submit] Failed to persist activeTrades:', err);
    }
}

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
    console.log('[trade_modal_submit] Handler entered for interaction', interaction.id);
    let responded = false;
    if (!canTrade()) {
        const state = getSeasonState();
        await interaction.reply({ content: `Trades are only available during the regular season through week ${state.tradeCutoff ?? 15}. Current phase: ${state.phase}.`, flags: 64 });
        return;
    }
    // Defer reply immediately to avoid interaction expiry
    try {
        await interaction.deferReply({ flags: 64 });
    } catch (err) {
        console.error('[trade_modal_submit] deferReply failed (interaction may be expired):', err);
        return;
    }
    try {
    const yourTeam = interaction.fields.getTextInputValue("yourTeam");
    const otherTeam = interaction.fields.getTextInputValue("otherTeam");
    const assetsSent = interaction.fields.getTextInputValue("assetsSent");
    const assetsReceived = interaction.fields.getTextInputValue("assetsReceived");
    const notes = interaction.fields.getTextInputValue("notes");
    console.log('[trade_modal_submit] Parsed fields', { yourTeam, otherTeam, assetsSentLen: assetsSent?.length, assetsReceivedLen: assetsReceived?.length });

    // Build embed for proposer (Coach A)
    const embed = buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes });
    console.log('[trade_modal_submit] Built proposer embed');

    // Find Coach B (robust lookup)
    let coachMap = {};
    try {
        coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
    } catch (err) {
        console.error('[trade_modal_submit] Failed to read coachRoleMap.json:', err);
        await interaction.editReply({ content: 'Internal error reading coach map.', flags: 64 });
        return;
    }
    let coachBId = coachMap[otherTeam];
    if (!coachBId) {
        // Try case-insensitive and partial match
        const normalized = otherTeam.trim().toLowerCase();
        for (const [team, id] of Object.entries(coachMap)) {
            if (team.toLowerCase() === normalized || team.toLowerCase().includes(normalized) || normalized.includes(team.toLowerCase())) {
                coachBId = id;
                console.log(`[trade_modal_submit] Matched team '${otherTeam}' to '${team}' with ID '${id}'`);
                break;
            }
        }
    }
    if (!coachBId) {
        console.log(`[trade_modal_submit] Could not find coach for team: ${otherTeam}`);
        await interaction.editReply({ content: `Could not find coach for team: ${otherTeam}`, flags: 64 });
        responded = true;
        return;
    }
    console.log('[trade_modal_submit] coachBId resolved', coachBId);

    // DM Coach B with Approve/Deny buttons
    // Store trade info for later (persist to survive restarts)
    global.activeTrades = global.activeTrades || {};
    const tradeId = `${Date.now()}`;
    const approveBtn = new ButtonBuilder().setCustomId(`trade_dm_approve_${tradeId}`).setLabel("Approve").setStyle(ButtonStyle.Success);
    const denyBtn = new ButtonBuilder().setCustomId(`trade_dm_deny_${tradeId}`).setLabel("Deny").setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

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
        guildId: interaction.guildId || interaction.guild?.id || interaction.client.guilds.cache.first()?.id || null,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        status: "pending"
    };
    global.activeTrades[tradeId] = tradeObj;
    const persisted = readActiveTrades();
    persisted[tradeId] = tradeObj;
    writeActiveTrades(persisted);
    console.log('[trade_modal_submit] Trade persisted with id', tradeId);
    // Store in pendingTrades.json for persistence
    // No persistence to pendingTrades.json here. Only log after Coach B approves in pin_trade_channel_message.js.

    // Send DM to the coach user or role members
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
        const membersToDm = [];
        if (guild) {
            // Try as user ID directly (do not fetch entire guild)
            const memberById = await guild.members.fetch(coachBId).catch(() => null);
            if (memberById && memberById.user.id !== interaction.user.id) membersToDm.push(memberById);
            // If not a user, try as role ID
            if (!memberById) {
                const role = await guild.roles.fetch(coachBId).catch(() => null);
                if (role) {
                    role.members.forEach(m => {
                        if (m.user.id !== interaction.user.id) membersToDm.push(m);
                    });
                }
            }
        }
        if (membersToDm.length) {
            for (const member of membersToDm) {
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
                console.log(`[trade_modal_submit] DM sent to user: ${member.user.tag} (${member.user.id})`);
            }
        } else {
            console.log(`[trade_modal_submit] No user or role found for coachBId: ${coachBId}`);
        }
    } catch (e) {
        sent = false;
        console.log('[trade_modal_submit] Error in DM logic:', e);
    }
    if (sent && sentUsernames.length) {
        await interaction.editReply({ content: `Trade proposal sent to ${roleName} for approval: ${sentUsernames.map(u => u.split(' ')[0]).join(", ")}`, flags: 64 });
        responded = true;
    } else {
        await interaction.editReply({ content: `Could not DM coach for team: ${roleName}. They may not be in the server or have the correct role. Trade was recorded with ID ${tradeId}.`, flags: 64 });
        responded = true;
    }
    } catch (err) {
        console.error('[trade_modal_submit] Fatal error handling trade submission:', err);
        if (!responded) {
            try {
                await interaction.editReply({ content: 'Error submitting trade. Please try again.', flags: 64 });
                responded = true;
            } catch {}
        }
    } finally {
        if (!responded) {
            try {
                await interaction.editReply({ content: 'Trade submitted. If you do not see a DM to Coach B, please verify their role/ID.', flags: 64 });
                responded = true;
            } catch (finalErr) {
                console.error('[trade_modal_submit] Final reply failed:', finalErr);
                try { await interaction.followUp({ content: 'Trade submitted.', flags: 64 }); responded = true; } catch {}
            }
        }
    }
}
