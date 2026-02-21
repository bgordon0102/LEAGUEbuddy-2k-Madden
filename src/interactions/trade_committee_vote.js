// Calculate approve/deny counts for logging and replies
const votesArr = Object.values(entry.votes);
const approveCount = votesArr.filter(v => v === 'approve').length;
const denyCount = votesArr.filter(v => v === 'deny').length;
// Calculate approve/deny counts for logging and replies
// ...existing code...
import { ButtonInteraction, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = /^committee_(approve|deny)_/;
// Handles committee voting for trade proposals
export async function execute(interaction) {
    console.log('[DEBUG] trade_committee_vote handler called', { customId: interaction.customId, messageId: interaction.message?.id, interactionId: interaction.id });
    const APPROVED_CHANNEL_ID = "1425555422063890443";
    const DENIED_CHANNEL_ID = "1425567560241254520";
    const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), "data/staffRoleMap.main.json");

    function getCommitteeRoleId() {
        const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, "utf8"));
        return staffMap["Ghost Paradise Trade Committee"];
    }

    function getCoachRole(teamName) {
        try {
            const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
            const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
            const match = Object.entries(coachMap || {}).find(([name]) => name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
            return match ? match[1] : coachMap[teamName] || null;
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
    let finalized = false;
    if (interaction.customId.startsWith('committee_approve_')) {
        entry.votes[interaction.user.id] = 'approve';
        entry.trade.status = 'approved';
        finalized = true;
    } else if (interaction.customId.startsWith('committee_deny_')) {
        entry.votes[interaction.user.id] = 'deny';
        entry.trade.status = 'denied';
        finalized = true;
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
    const embed = new EmbedBuilder()
        .setTitle(trade.status === 'approved' ? "Trade Approved" : trade.status === 'denied' ? "Trade Denied" : "Trade Committee Vote Required")
        .addFields(
            { name: "Your Team", value: trade.yourTeam, inline: true },
            { name: "Other Team", value: trade.otherTeam, inline: true },
            { name: "Assets Sent", value: trade.assetsSent },
            { name: "Assets Received", value: trade.assetsReceived }
        );
    if (trade.notes) embed.addFields({ name: "Notes", value: trade.notes });
    embed.setColor(trade.status === 'approved' ? 0x57F287 : trade.status === 'denied' ? 0xED4245 : 0x5865F2);

    // Only update rosters/picks and post to correct channel based on trade status
    if (finalized && trade.status === 'approved') {
        console.log('[DEBUG] Trade approval block reached', { trade });
        console.log('[DEBUG] Entering roster update block for approved trade:', {
            messageId,
            yourTeam: trade.yourTeam,
            otherTeam: trade.otherTeam,
            assetsSent: trade.assetsSent,
            assetsReceived: trade.assetsReceived,
            sentPicks: trade.picks || trade.picksSent,
            receivedPicks: trade.picksTo || trade.picksReceived
        });
        // Roster update logic
        // ...existing code...
        // Roster update logic
        const rosterDir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
        const teamAFile = path.join(rosterDir, teamToFile(trade.yourTeam));
        const teamBFile = path.join(rosterDir, teamToFile(trade.otherTeam));
        const coachRoleA = getCoachRole(trade.yourTeam);
        const coachRoleB = getCoachRole(trade.otherTeam);
        let teamARoster, teamBRoster;
        try {
            teamARoster = JSON.parse(fs.readFileSync(teamAFile, 'utf8'));
            teamBRoster = JSON.parse(fs.readFileSync(teamBFile, 'utf8'));
        } catch (err) {
            console.error('Failed to read roster files for trade:', err);
            await interaction.reply({ content: 'Trade approved but roster files missing/corrupt; manual fix required.', flags: 64 });
            return;
        }
        if (Array.isArray(teamARoster)) teamARoster = { players: teamARoster, picks: [] };
        if (Array.isArray(teamBRoster)) teamBRoster = { players: teamBRoster, picks: [] };
        teamARoster.players = Array.isArray(teamARoster.players) ? teamARoster.players : [];
        teamBRoster.players = Array.isArray(teamBRoster.players) ? teamBRoster.players : [];
        teamARoster.picks = Array.isArray(teamARoster.picks) ? teamARoster.picks : [];
        teamBRoster.picks = Array.isArray(teamBRoster.picks) ? teamBRoster.picks : [];
        function normalize(str) {
            return str.toLowerCase().replace(/[^a-z0-9]/gi, '');
        }
        // Move players
        function movePlayers(playerNames, fromRoster, toRoster) {
            for (const name of playerNames) {
                const normName = normalize(name);
                const idx = fromRoster.players.findIndex(p => {
                    const normRosterName = normalize(p.name);
                    return normRosterName === normName || normRosterName.includes(normName) || normName.includes(normRosterName);
                });
                if (idx !== -1) {
                    toRoster.players.push(fromRoster.players[idx]);
                    fromRoster.players.splice(idx, 1);
                }
            }
        }
        // Move picks
        function movePicks(pickNames, fromRoster, toRoster, fromTeamName) {
            function parsePick(val) {
                let str = typeof val === 'string' ? val : val.pick || val.label || '';
                // Remove (Val: ...) annotation for matching
                str = str.replace(/\(val: [^)]+\)/gi, '').toLowerCase();
                const yearMatch = str.match(/(20\d{2})/);
                const year = yearMatch ? Number(yearMatch[1]) : null;
                let round = null;
                // Accept multiple formats: '2026 1st', '2026 Round 1', '2026 First', etc.
                if (/1st|first|round 1/.test(str)) round = 1;
                else if (/2nd|second|round 2/.test(str)) round = 2;
                else if (/3rd|third|round 3/.test(str)) round = 3;
                else if (/4th|fourth|round 4/.test(str)) round = 4;
                else {
                    const roundMatch = str.match(/round\s*(\d)/);
                    if (roundMatch) round = Number(roundMatch[1]);
                }
                // Extract protection annotation if present
                const protectionMatch = str.match(/\(([^)]+protected[^)]*)\)/);
                const protection = protectionMatch ? protectionMatch[1] : null;
                return { year, round, protection, raw: val };
            }
            for (const pick of pickNames) {
                const tradePick = parsePick(pick);
                console.log('[movePicks][TRADE PICK PARSED]', { pick, tradePick });
                if (!tradePick.year || !tradePick.round) {
                    console.log('[movePicks][INVALID TRADE PICK]', { pick, tradePick });
                    continue;
                }
                let idx = -1;
                for (let i = 0; i < fromRoster.picks.length; i++) {
                    const rosterPick = parsePick(fromRoster.picks[i]);
                    console.log('[movePicks][COMPARE]', {
                        rosterPickRaw: fromRoster.picks[i],
                        rosterPick,
                        tradePick,
                        matchYear: rosterPick.year === tradePick.year,
                        matchRound: rosterPick.round === tradePick.round,
                        protection: rosterPick.protection,
                        skip: !!rosterPick.protection
                    });
                    // Prevent moving picks that already have protection annotation
                    if (rosterPick.year === tradePick.year && rosterPick.round === tradePick.round && !rosterPick.protection) {
                        idx = i;
                        break;
                    }
                }
                if (idx === -1) {
                    console.log('[movePicks][MISS]', {
                        pick,
                        tradePick,
                        fromRosterPicks: fromRoster.picks.map(p => parsePick(p)),
                        fromRosterRaw: fromRoster.picks,
                        reason: 'No matching pick found or pick has protection annotation.'
                    });
                    continue;
                }
                let movedPick = fromRoster.picks[idx];
                // If the traded pick has protection, annotate it for the receiving roster
                if (tradePick.protection) {
                    // Format: "2027 1st (lottery protected)"
                    const basePick = movedPick.replace(/\(([^)]+protected[^)]*)\)/, '').trim();
                    movedPick = `${basePick} (${tradePick.protection})`;
                }
                console.log('[movePicks][MOVE]', {
                    movedPick,
                    fromTeam: fromTeamName,
                    toRosterBefore: [...toRoster.picks],
                    fromRosterBefore: [...fromRoster.picks]
                });
                toRoster.picks.push(movedPick);
                fromRoster.picks.splice(idx, 1);
                console.log('[movePicks][AFTER MOVE]', {
                    toRosterAfter: [...toRoster.picks],
                    fromRosterAfter: [...fromRoster.picks]
                });
            }
        }
        // Robust pick extraction from trade object
        function extractPicks(assetStr) {
            if (!assetStr) return [];
            // Only allow picks that do NOT already have protection annotation
            return assetStr.split(/[,\n]/)
                .map(s => s.trim())
                .filter(s => s.match(/20\d{2}/))
                .filter(s => !s.match(/\(([^)]+protected[^)]*)\)/));
        }
        // Move assets
        const sentPlayers = trade.players || trade.assetsSent.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));
        const receivedPlayers = trade.playersTo || trade.assetsReceived.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));
        // Robust pick extraction
        const sentPicks = trade.picks || trade.picksSent || extractPicks(trade.assetsSent);
        const receivedPicks = trade.picksTo || trade.picksReceived || extractPicks(trade.assetsReceived);
        console.log('[DEBUG] Calling movePicks', {
            sentPicks,
            receivedPicks,
            teamARosterPicks: teamARoster.picks,
            teamBRosterPicks: teamBRoster.picks,
            tradeObj: trade
        });
        movePlayers(sentPlayers, teamARoster, teamBRoster);
        movePlayers(receivedPlayers, teamBRoster, teamARoster);
        movePicks(sentPicks, teamARoster, teamBRoster, trade.yourTeam);
        movePicks(receivedPicks, teamBRoster, teamARoster, trade.otherTeam);
        try {
            fs.writeFileSync(teamAFile, JSON.stringify(teamARoster, null, 2));
            fs.writeFileSync(teamBFile, JSON.stringify(teamBRoster, null, 2));
        } catch (err) {
            console.error('Failed to write updated rosters:', err);
        }
        try {
            approvedChannel = await interaction.client.channels.fetch(APPROVED_CHANNEL_ID);
        } catch (err) {
            console.error('Failed to fetch approved channel:', err);
        }
        if (approvedChannel) {
            try {
                const tagLine = `${GHOST_PARADISE_ROLE_ID ? `<@&${GHOST_PARADISE_ROLE_ID}> ` : ''}${coachRoleA ? `<@&${coachRoleA}>` : ''}${coachRoleB ? ` <@&${coachRoleB}>` : ''}`;
                await approvedChannel.send({
                    content: tagLine || null,
                    embeds: [embed],
                });
            } catch (err) {
                console.error('Failed to send approved trade message:', err);
            }
        }
        try {
            userA = await interaction.client.users.fetch(trade.proposerId);
            await userA.send({ embeds: [embed] });
        } catch (dmErr) {
            console.error('Failed to send DM to Coach A (proposerId):', trade.proposerId, dmErr);
        }
    } else if (finalized && trade.status === 'denied') {
        // Post to denied channel
        let deniedChannel;
        try {
            deniedChannel = await interaction.client.channels.fetch(DENIED_CHANNEL_ID);
        } catch (err) {
            console.error('Failed to fetch denied channel:', err);
        }
        if (deniedChannel) {
            try {
                // Only tag Ghost Paradise role if trade is denied
                const tagLine = GHOST_PARADISE_ROLE_ID ? `<@&${GHOST_PARADISE_ROLE_ID}>` : null;
                await deniedChannel.send({ content: tagLine, embeds: [embed] });
            } catch (err) {
                console.error('Failed to send denied trade message:', err);
            }
        }
    }
    // Clean up pending trade entry when finalized
    if (finalized) {
        try {
            delete pendingTrades[messageId];
            fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2));
        } catch (err) {
            console.error('Failed to prune pendingTrades after finalization:', err);
        }
        await interaction.reply({ content: `Trade ${trade.status}.`, flags: 64 });
    } else {
        await interaction.reply({ content: `Vote recorded: ${approveCount} approve, ${denyCount} deny. First to 3 decides.`, flags: 64 });
    }
}
