import { ButtonInteraction, EmbedBuilder } from "discord.js";
import fs from "fs";
import path from "path";

export const customId = /^committee_(approve|deny)_/;
// Handles committee voting for trade proposals
export async function execute(interaction) {
    const APPROVED_CHANNEL_ID = "1425555422063890443";
    const DENIED_CHANNEL_ID = "1425567560241254520";
    const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), "data/staffRoleMap.main.json");

    function getCommitteeRoleId() {
        const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, "utf8"));
        return staffMap["Ghost Paradise Trade Committee"];
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
        await interaction.reply({ content: "Trade not found for this committee vote.", flags: 64 });
        return;
    }
    // Prevent voting if trade is already approved or denied
    if (entry.trade.status === 'approved' || entry.trade.status === 'denied') {
        await interaction.reply({ content: 'This trade has already been ' + entry.trade.status + ' and can no longer be voted on.', flags: 64 });
        return;
    }
    // Log the vote for this user
    entry.votes = entry.votes || {};
    if (interaction.customId.startsWith('committee_approve_')) {
        entry.votes[interaction.user.id] = 'approve';
    } else if (interaction.customId.startsWith('committee_deny_')) {
        entry.votes[interaction.user.id] = 'deny';
    }
    // Count votes
    const votesArr = Object.values(entry.votes);
    const approveCount = votesArr.filter(v => v === 'approve').length;
    const denyCount = votesArr.filter(v => v === 'deny').length;
    let finalized = false;
    if (approveCount >= 3) {
        entry.trade.status = 'approved';
        finalized = true;
    } else if (denyCount >= 3) {
        entry.trade.status = 'denied';
        finalized = true;
    }
    pendingTrades[messageId] = entry;
    try {
        fs.writeFileSync(pendingPath, JSON.stringify(pendingTrades, null, 2));
    } catch (err) {
        console.error('Failed to save committee votes:', err);
    }
    const trade = entry.trade;
    if (!trade) {
        await interaction.reply({ content: "Trade details not found for this committee vote.", flags: 64 });
        return;
    }

    // Prepare embed for notification
    const notifyRoleId = "1428119680572325929";
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
        // Roster update logic
        const teamAFile = path.join(process.cwd(), 'data/teams_rosters', teamToFile(trade.yourTeam));
        const teamBFile = path.join(process.cwd(), 'data/teams_rosters', teamToFile(trade.otherTeam));
        let teamARoster = JSON.parse(fs.readFileSync(teamAFile, 'utf8'));
        let teamBRoster = JSON.parse(fs.readFileSync(teamBFile, 'utf8'));
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
            for (const pick of pickNames) {
                // Find pick index (match ignoring protection)
                const basePick = pick.replace(/\s*\(.*\)/, '');
                const idx = fromRoster.picks.findIndex(p => {
                    if (typeof p === 'string') {
                        return p.replace(/\s*\(.*\)/, '') === basePick;
                    } else if (p && typeof p.pick === 'string') {
                        return p.pick.replace(/\s*\(.*\)/, '') === basePick;
                    }
                    return false;
                });
                if (idx !== -1) {
                    // Determine if pick is 1st or 2nd round
                    const isFirst = /1st/i.test(basePick);
                    const isSecond = /2nd/i.test(basePick);
                    let protection = null;
                    const protectionMatch = pick.match(/top ?(3|5|10)|lottery/i);
                    let newPickObj = {
                        pick: basePick,
                        originalTeam: fromTeamName,
                    };
                    // Only allow protections for 1st round picks
                    if (isFirst && protectionMatch) {
                        protection = protectionMatch[0].toLowerCase();
                        newPickObj.protection = protection;
                    }
                    // Do not allow protections for 2nd round picks
                    toRoster.picks.push(newPickObj);
                    fromRoster.picks.splice(idx, 1);
                }
            }
        }

        // Extract picks from asset string
        function extractPicks(assetStr) {
            return assetStr.split(',').map(s => s.trim()).filter(s => {
                return s.match(/\d{4}|20\d{2} ?(1st|2nd)( |$|\(|top|lottery|unprotected|protected)/i);
            });
        }

        // Move assets
        const sentPlayers = trade.players || trade.assetsSent.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));
        const receivedPlayers = trade.playersTo || trade.assetsReceived.split(',').map(s => s.trim()).filter(s => s && !s.match(/pick/i));
        const sentPicks = trade.picks || extractPicks(trade.assetsSent);
        const receivedPicks = trade.picksTo || extractPicks(trade.assetsReceived);
        movePlayers(sentPlayers, teamARoster, teamBRoster);
        movePlayers(receivedPlayers, teamBRoster, teamARoster);
        movePicks(sentPicks, teamARoster, teamBRoster, trade.yourTeam);
        movePicks(receivedPicks, teamBRoster, teamARoster, trade.otherTeam);
        fs.writeFileSync(teamAFile, JSON.stringify(teamARoster, null, 2));
        fs.writeFileSync(teamBFile, JSON.stringify(teamBRoster, null, 2));
        // Post to approved channel
        let approvedChannel, userA;
        try {
            approvedChannel = await interaction.client.channels.fetch(APPROVED_CHANNEL_ID);
        } catch (err) {
            console.error('Failed to fetch approved channel:', err);
        }
        if (approvedChannel) {
            try {
                await approvedChannel.send({ content: `<@&${notifyRoleId}>`, embeds: [embed] });
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
                await deniedChannel.send({ content: `<@&${notifyRoleId}>`, embeds: [embed] });
            } catch (err) {
                console.error('Failed to send denied trade message:', err);
            }
        }
    }
    if (finalized) {
        await interaction.reply({ content: `Trade ${trade.status}.`, flags: 64 });
    } else {
        await interaction.reply({ content: `Vote recorded: ${approveCount} approve, ${denyCount} deny. First to 3 wins.`, flags: 64 });
    }
}