function ensurePickArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === "string") {
        return val
            .split(/[,\n]/)
            .map(s => s.trim())
            .filter(Boolean);
    }
    return [];
}
// Calculate approve/deny counts for logging and replies
// ...existing code...
import { ButtonInteraction, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = /^committee_(approve|deny)_/;
// Handles committee voting for trade proposals
export async function execute(interaction) {
    console.log('[DEBUG] trade_committee_vote handler called', { customId: interaction.customId, messageId: interaction.message?.id, interactionId: interaction.id });
    const APPROVED_CHANNEL_ID = "1425555422063890443";
    const COMMITTEE_CHANNEL_ID = "1425555499440410812";
    const DENIED_CHANNEL_ID = "1425567560241254520";
    const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), "data/staffRoleMap.main.json");

    function getCommitteeRoleId() {
        const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, "utf8"));
        return staffMap["Ghost Paradise Trade Committee"];
    }

    function getCoachRole(teamName) {
        try {
            const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
            // Use mascot only, append ' Coach' for lookup
            let mascot = teamName.split(' ').pop();
            let key = mascot.charAt(0).toUpperCase() + mascot.slice(1).toLowerCase() + ' Coach';
            return coachMap[key] || null;
        } catch {
            return null;
        }
    }

    function teamToFile(team) {
        const map = {
            "cavaliers": "cleveland_cavaliers.json",
            "cleveland cavaliers": "cleveland_cavaliers.json",
            "hawks": "atlanta_hawks.json",
            "atlanta hawks": "atlanta_hawks.json",
            "celtics": "boston_celtics.json",
            "boston celtics": "boston_celtics.json",
            "nets": "brooklyn_nets.json",
            "brooklyn nets": "brooklyn_nets.json",
            "hornets": "charlotte_hornets.json",
            "charlotte hornets": "charlotte_hornets.json",
            "bulls": "chicago_bulls.json",
            "chicago bulls": "chicago_bulls.json",
            "mavericks": "dallas_mavericks.json",
            "dallas mavericks": "dallas_mavericks.json",
            "nuggets": "denver_nuggets.json",
            "denver nuggets": "denver_nuggets.json",
            "pistons": "detroit_pistons.json",
            "detroit pistons": "detroit_pistons.json",
            "warriors": "golden_state_warriors.json",
            "golden state warriors": "golden_state_warriors.json",
            "rockets": "houston_rockets.json",
            "houston rockets": "houston_rockets.json",
            "pacers": "indiana_pacers.json",
            "indiana pacers": "indiana_pacers.json",
            "clippers": "los_angeles_clippers.json",
            "los angeles clippers": "los_angeles_clippers.json",
            "lakers": "los_angeles_lakers.json",
            "los angeles lakers": "los_angeles_lakers.json",
            "grizzlies": "memphis_grizzlies.json",
            "memphis grizzlies": "memphis_grizzlies.json",
            "heat": "miami_heat.json",
            "miami heat": "miami_heat.json",
            "bucks": "milwaukee_bucks.json",
            "milwaukee bucks": "milwaukee_bucks.json",
            "timberwolves": "minnesota_timberwolves.json",
            "minnesota timberwolves": "minnesota_timberwolves.json",
            "knicks": "new_york_knicks.json",
            "new york knicks": "new_york_knicks.json",
            "thunder": "oklahoma_city_thunder.json",
            "oklahoma city thunder": "oklahoma_city_thunder.json",
            "magic": "orlando_magic.json",
            "orlando magic": "orlando_magic.json",
            "76ers": "philadelphia_76ers.json",
            "philadelphia 76ers": "philadelphia_76ers.json",
            "suns": "phoenix_suns.json",
            "phoenix suns": "phoenix_suns.json",
            "trail blazers": "portland_trail_blazers.json",
            "portland trail blazers": "portland_trail_blazers.json",
            "kings": "sacramento_kings.json",
            "sacramento kings": "sacramento_kings.json",
            "spurs": "san_antonio_spurs.json",
            "san antonio spurs": "san_antonio_spurs.json",
            "raptors": "toronto_raptors.json",
            "toronto raptors": "toronto_raptors.json",
            "jazz": "utah_jazz.json",
            "utah jazz": "utah_jazz.json",
            "wizards": "washington_wizards.json",
            "washington wizards": "washington_wizards.json"
        };
        const key = team.toLowerCase().trim();
        if (map[key]) return map[key];
        return key.replace(/ /g, '_') + '.json';
    }

    // Load pendingTrades.json and get trade/votes for this interaction/message
    const messageId = interaction.message?.id || interaction.id;
    const pendingPath = path.join(process.cwd(), 'data/pendingTrades.json');
    let pendingTrades = {};
    if (fs.existsSync(pendingPath)) {
        try {
            pendingTrades = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        } catch { }
    }
    let entry = pendingTrades[messageId];
    if (!entry) {
        console.log('[DEBUG] Early return: No entry found for messageId', { messageId });
        await interaction.reply({ content: "Trade not found for this committee vote.", flags: 64 });
        return;
    }
    // Prevent voting if trade is already approved or denied
    if (entry.trade.status === 'approved' || entry.trade.status === 'denied') {
        // Trade already finalized, ignore further votes
        return;
    }
    // Log the vote for this user and finalize immediately for 2K
    entry.votes = entry.votes || {};
    // Record vote
    if (interaction.customId.startsWith('committee_approve_')) {
        entry.votes[interaction.user.id] = 'approve';
    } else if (interaction.customId.startsWith('committee_deny_')) {
        entry.votes[interaction.user.id] = 'deny';
    }

    const approveCount = Object.values(entry.votes).filter(v => v === 'approve').length;
    const denyCount = Object.values(entry.votes).filter(v => v === 'deny').length;
    // Threshold: first to 1 decides
    let finalized = false;
    if (approveCount >= 1) {
        entry.trade.status = 'approved_pending_2k';
        finalized = true;
    } else if (denyCount >= 1) {
        entry.trade.status = 'denied';
        finalized = true;
    } else {
        entry.trade.status = 'pending';
    }
    console.log('[DEBUG] Vote count', { approveCount, denyCount, finalized, tradeStatus: entry.trade.status });
    pendingTrades[messageId] = entry;
    try {
        fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2));
    } catch (err) {
        console.error('Failed to save committee votes:', err);
    }
    const trade = entry.trade;
    if (!trade) {
        console.log('[DEBUG] Early return: No trade object found', { entry });
        await interaction.reply({ content: "Trade details not found for this committee vote.", flags: 64 });
        return;
    }

    // Prepare embed for notification
    const notifyRoleId = getCommitteeRoleId();
    const GHOST_PARADISE_ROLE_ID = "1460733464721490108";
    // Compute gap if available (stored in trade.gap or recompute from assets if numeric values present)
    let gapLine = null;
    if (typeof trade.gap === 'number' && Number.isFinite(trade.gap)) {
        gapLine = `Gap (you - them): ${trade.gap.toFixed(1)}`;
    } else if (typeof trade.assetsSentTotal === 'number' && typeof trade.assetsReceivedTotal === 'number') {
        const gap = trade.assetsSentTotal - trade.assetsReceivedTotal;
        gapLine = `Gap (you - them): ${gap.toFixed(1)}`;
    }

    const embed = new EmbedBuilder()
        .setTitle(trade.status === 'approved' ? "Trade Approved" : trade.status === 'denied' ? "Trade Denied" : "Trade Committee Vote Required")
        .addFields(
            { name: "Your Team", value: trade.yourTeam, inline: true },
            { name: "Other Team", value: trade.otherTeam, inline: true },
            { name: "Assets Sent", value: trade.assetsSent },
            { name: "Assets Received", value: trade.assetsReceived }
        );
    if (gapLine) embed.addFields({ name: "Value Gap", value: gapLine });
    if (trade.notes) embed.addFields({ name: "Notes", value: trade.notes });
    embed.setColor(trade.status === 'approved' || trade.status === 'approved_pending_2k' ? 0x57F287 : trade.status === 'denied' ? 0xED4245 : 0x5865F2);

    // Only update rosters/picks and post to correct channel based on trade status
    if (finalized && trade.status === 'approved_pending_2k') {
        // Avoid duplicate prompts
        if (entry.proofRequested) {
            await interaction.reply({ content: 'Proof request already sent. Waiting for 2K proof.', flags: 64 });
            return;
        }
        entry.proofRequested = true;
        pendingTrades[messageId] = entry;
        try { fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2)); } catch { }

        const coachRoleA = getCoachRole(trade.yourTeam);
        const coachRoleB = getCoachRole(trade.otherTeam);
        const proofEmbed = new EmbedBuilder()
            .setTitle("Trade Approved — 2K Proof Required")
            .setDescription("Proposer: upload a 2K screenshot showing **Valid Trade** for this exact deal. Once submitted, rosters will update.")
            .addFields(
                { name: "Your Team", value: trade.yourTeam, inline: true },
                { name: "Other Team", value: trade.otherTeam, inline: true },
                { name: "Assets Sent", value: trade.assetsSent || 'N/A', inline: false },
                { name: "Assets Received", value: trade.assetsReceived || 'N/A', inline: false }
            )
            .setColor(0x57F287);
        const proofButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`trade_2k_proof|${trade.tradeId}`).setLabel('Upload 2K Proof').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`trade_2k_cancel|${trade.tradeId}`).setLabel('Cancel Trade').setStyle(ButtonStyle.Danger),
        );

        // Notify committee channel we're waiting for proof
        try {
            const approvedChannel = await interaction.client.channels.fetch(APPROVED_CHANNEL_ID);
            if (approvedChannel) {
                // Always read from the pending trade data for team names
                const pendingPath = path.join(process.cwd(), 'data/pendingTrades.json');
                let pendingTrades = {};
                if (fs.existsSync(pendingPath)) {
                    try {
                        pendingTrades = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
                    } catch { }
                }
                // Find the entry for this trade
                let entry = Object.values(pendingTrades).find(e => e?.trade?.tradeId === trade.tradeId);
                let yourTeam = entry?.trade?.yourTeam || trade.yourTeam;
                let otherTeam = entry?.trade?.otherTeam || trade.otherTeam;
                const coachRoleA = getCoachRole(yourTeam);
                const coachRoleB = getCoachRole(otherTeam);
                let tags = '';
                if (coachRoleA && coachRoleB) {
                    tags = `<@&${coachRoleA}> <@&${coachRoleB}>`;
                } else if (coachRoleA) {
                    tags = `<@&${coachRoleA}>`;
                } else if (coachRoleB) {
                    tags = `<@&${coachRoleB}>`;
                }
                console.log('[DEBUG][approved-trades] yourTeam:', yourTeam, 'otherTeam:', otherTeam, 'coachRoleA:', coachRoleA, 'coachRoleB:', coachRoleB, 'tags:', tags);
                await approvedChannel.send({
                    content: `${tags} Trade approved by committee. Waiting for 2K proof.`.trim(),
                    embeds: [proofEmbed],
                    components: [proofButtons],
                });
            }
        } catch (err) {
            console.error('[trade_committee_vote] Failed to post waiting-for-proof notice', err);
        }
    } else if (finalized && trade.status === 'approved') {
        // Post to denied channel
        let deniedChannel;
        try {
            deniedChannel = await interaction.client.channels.fetch(DENIED_CHANNEL_ID);
        } catch (err) {
            console.error('Failed to fetch denied channel:', err);
        }
        if (deniedChannel) {
            try {
                // Tag Ghost Paradise and both coaches for denied trades too
                const tags = [
                    GHOST_PARADISE_ROLE_ID ? `<@&${GHOST_PARADISE_ROLE_ID}>` : null,
                    getCoachRole(trade.yourTeam) ? `<@&${getCoachRole(trade.yourTeam)}>` : null,
                    getCoachRole(trade.otherTeam) ? `<@&${getCoachRole(trade.otherTeam)}>` : null,
                ].filter(Boolean).join(' ');
                const tagLine = tags || null;
                await deniedChannel.send({ content: tagLine, embeds: [embed] });
            } catch (err) {
                console.error('Failed to send denied trade message:', err);
            }
        }
    }
    // Clean up pending trade entry when finalized
    if (finalized) {
        try {
            if (trade.status === 'approved_pending_2k') {
                pendingTrades[messageId] = entry; // keep until proof submitted
            } else {
                delete pendingTrades[messageId];
            }
            fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2));
        } catch (err) {
            console.error('Failed to prune pendingTrades after finalization:', err);
        }
        const note = trade.status === 'approved_pending_2k'
            ? 'Trade approved by committee. Waiting for 2K proof.'
            : `Trade ${trade.status}.`;
        await interaction.reply({ content: note, flags: 64 });
    } else {
        await interaction.reply({ content: `Vote recorded: ${approveCount} approve, ${denyCount} deny. First to 1 decides.`, flags: 64 });
    }
}
