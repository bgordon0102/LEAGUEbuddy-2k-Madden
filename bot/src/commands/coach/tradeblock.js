// ...existing code...


import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set your Ghost Paradise role ID here
const GHOST_PARADISE_ROLE_ID = '1428119680572325929';

// Paths to data files
const coachRoleMapPath = path.join(__dirname, '../../../data/coachRoleMap.json');
const teamsRostersPath = path.join(__dirname, '../../../data/teams_rosters');
const tradeBlockPath = path.join(__dirname, '../../../data/tradeblock.json');

function getCoachTeamFromRoles(interaction) {
    // Find a role ending in 'Coach' and map to team
    const roles = interaction.member?.roles?.cache;
    if (!roles) return null;
    for (const [roleId, role] of roles) {
        if (role.name.endsWith('Coach')) {
            // Map role name to team file name
            // e.g. 'Hawks Coach' -> 'Atlanta_Hawks', 'Lakers Coach' -> 'Los_Angeles_Lakers'
            const base = role.name.replace(' Coach', '');
            // Map base to full team name (add more mappings as needed)
            const teamMap = {
                'Hawks': 'Atlanta_Hawks',
                'Celtics': 'Boston_Celtics',
                'Nets': 'Brooklyn_Nets',
                'Hornets': 'Charlotte_Hornets',
                'Bulls': 'Chicago_Bulls',
                'Cavaliers': 'Cleveland_Cavaliers',
                'Mavericks': 'Dallas_Mavericks',
                'Nuggets': 'Denver_Nuggets',
                'Pistons': 'Detroit_Pistons',
                'Warriors': 'Golden_State_Warriors',
                'Rockets': 'Houston_Rockets',
                'Pacers': 'Indiana_Pacers',
                'Clippers': 'Los_Angeles_Clippers',
                'Lakers': 'Los_Angeles_Lakers',
                'Grizzlies': 'Memphis_Grizzlies',
                'Heat': 'Miami_Heat',
                'Bucks': 'Milwaukee_Bucks',
                'Timberwolves': 'Minnesota_Timberwolves',
                'Pelicans': 'New_Orleans_Pelicans',
                'Knicks': 'New_York_Knicks',
                'Thunder': 'Oklahoma_City_Thunder',
                'Magic': 'Orlando_Magic',
                '76ers': 'Philadelphia_76ers',
                'Suns': 'Phoenix_Suns',
                'Trail Blazers': 'Portland_Trail_Blazers',
                'Kings': 'Sacramento_Kings',
                'Spurs': 'San_Antonio_Spurs',
                'Raptors': 'Toronto_Raptors',
                'Jazz': 'Utah_Jazz',
                'Wizards': 'Washington_Wizards'
            };
            return teamMap[base] || null;
        }
    }
    return null;
}

function getTeamPlayers(team) {
    const teamFile = path.join(teamsRostersPath, `${team}.json`);
    if (!fs.existsSync(teamFile)) return [];
    const roster = JSON.parse(fs.readFileSync(teamFile));
    return roster.players ? roster.players.map(p => p.name) : [];
}

function getTradeBlock() {
    if (!fs.existsSync(tradeBlockPath)) return {};
    return JSON.parse(fs.readFileSync(tradeBlockPath));
}

function getTradeBlockMessages() {
    const msgPath = tradeBlockPath.replace('.json', '_messages.json');
    if (!fs.existsSync(msgPath)) return {};
    return JSON.parse(fs.readFileSync(msgPath));
}

function saveTradeBlockMessages(msgMap) {
    const msgPath = tradeBlockPath.replace('.json', '_messages.json');
    fs.writeFileSync(msgPath, JSON.stringify(msgMap, null, 2));
}

function saveTradeBlock(tradeBlock) {
    fs.writeFileSync(tradeBlockPath, JSON.stringify(tradeBlock, null, 2));
}

async function postTradeBlockEmbed(interaction, team, players) {
    // Post or update an embed in the dedicated trade block channel
    let thumbnailUrl = null;
    if (players.length === 1) {
        // Example: Use a predictable image URL based on player name
        // You may need to adjust this to match your actual image hosting
        const playerName = players[0].replace(/ /g, '_');
        thumbnailUrl = `https://cdn.nba2k.com/players/${playerName}.png`;
    }
    const embed = {
        title: `${team} Trade Block`,
        description: players.length ? players.map((p, i) => `${i + 1}. ${p}`).join('\n') : 'No players on trade block.',
        color: 0x00AE86,
        thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined
    };
    const tradeBlockChannelId = '1432507364468068412';
    const channel = interaction.client.channels.cache.get(tradeBlockChannelId);
    if (channel) {
        await channel.send({ embeds: [embed] });
    } else {
        // fallback to current channel if not found
        await interaction.channel.send({ embeds: [embed] });
    }
}


const data = new SlashCommandBuilder()
    .setName('tradeblock')
    .setDescription('Manage your team’s trade block')
    .addStringOption(option =>
        option.setName('action')
            .setDescription('Add or remove a player')
            .setRequired(true)
            .setAutocomplete(true)
    )
    .addStringOption(option =>
        option.setName('player')
            .setDescription('Player to add/remove')
            .setRequired(true)
            .setAutocomplete(true)
    );


export default {
    data,
    async autocomplete(interaction) {
        try {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'action') {
                return interaction.respond([
                    { name: 'add', value: 'add' },
                    { name: 'remove', value: 'remove' }
                ]);
            }
            const team = getCoachTeamFromRoles(interaction);
            if (!team) {
                return interaction.respond([]);
            }
            const tradeBlock = getTradeBlock();
            if (focusedOption.name === 'player') {
                const action = interaction.options.getString('action');
                if (action === 'add') {
                    const teamPlayers = getTeamPlayers(team);
                    const blocked = tradeBlock[team] || [];
                    const available = teamPlayers.filter(p => !blocked.includes(p));
                    return interaction.respond(available.map(p => ({ name: p, value: p })).slice(0, 25));
                } else if (action === 'remove') {
                    const blocked = tradeBlock[team] || [];
                    return interaction.respond(blocked.map(p => ({ name: p, value: p })).slice(0, 25));
                }
            }
            return interaction.respond([]);
        } catch (err) {
            console.error('TRADEBLOCK AUTOCOMPLETE ERROR:', err);
            try {
                await interaction.respond([{ name: 'Error loading options', value: 'none' }]);
            } catch { }
        }
    },
    async execute(interaction) {
        const team = getCoachTeamFromRoles(interaction);
        if (!team) return interaction.reply({ content: 'You are not mapped to a team.', ephemeral: true });
        const action = interaction.options.getString('action');
        const player = interaction.options.getString('player');
        const teamPlayers = getTeamPlayers(team);
        if (!teamPlayers.includes(player)) {
            return interaction.reply({ content: 'You can only add/remove players from your own team.', ephemeral: true });
        }
        let tradeBlock = getTradeBlock();
        tradeBlock[team] = tradeBlock[team] || [];
        const tradeBlockMessages = getTradeBlockMessages();
        if (action === 'add') {
            if (tradeBlock[team].length >= 5) {
                return interaction.reply({ content: 'You can only have 5 players on your trade block.', ephemeral: true });
            }
            if (tradeBlock[team].includes(player)) {
                return interaction.reply({ content: `${player} is already on your trade block.`, ephemeral: true });
            }
            tradeBlock[team].push(player);
            saveTradeBlock(tradeBlock);

            // Post a player-specific embed to the trade block channel
            const tradeBlockChannelId = '1432507364468068412';
            const channel = interaction.client.channels.cache.get(tradeBlockChannelId);
            // Find player info from roster file
            const teamFile = path.join(teamsRostersPath, `${team}.json`);
            let position = '';
            let thumbnailUrl = '';
            if (fs.existsSync(teamFile)) {
                const roster = JSON.parse(fs.readFileSync(teamFile));
                const playerObj = roster.players?.find(p => p.name === player);
                if (playerObj) {
                    position = playerObj.position || '';
                    thumbnailUrl = playerObj.imgUrl || `https://cdn.nba2k.com/players/${player.replace(/ /g, '_')}.png`;
                }
            }
            const embed = {
                title: `${player} added to the ${team} trade block!`,
                description: `<@&${GHOST_PARADISE_ROLE_ID}>\nPosition: ${position}`,
                color: 0x00AE86,
                thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined
            };
            let sentMsg;
            if (channel) {
                sentMsg = await channel.send({ embeds: [embed] });
            } else {
                sentMsg = await interaction.channel.send({ embeds: [embed] });
            }
            // Store message ID for later removal
            tradeBlockMessages[team] = tradeBlockMessages[team] || {};
            tradeBlockMessages[team][player] = sentMsg.id;
            saveTradeBlockMessages(tradeBlockMessages);

            return interaction.reply({ content: `${player} added to your trade block.`, ephemeral: true });
        } else if (action === 'remove') {
            if (!tradeBlock[team].includes(player)) {
                return interaction.reply({ content: `${player} is not on your trade block.`, ephemeral: true });
            }
            tradeBlock[team] = tradeBlock[team].filter(p => p !== player);
            saveTradeBlock(tradeBlock);

            // Remove the player-specific embed message
            const tradeBlockChannelId = '1432507364468068412';
            const channel = interaction.client.channels.cache.get(tradeBlockChannelId);
            const msgId = tradeBlockMessages[team]?.[player];
            if (channel && msgId) {
                try {
                    const msg = await channel.messages.fetch(msgId);
                    await msg.delete();
                } catch (err) {
                    // Message may have already been deleted
                }
                // Remove from tracking
                delete tradeBlockMessages[team][player];
                if (Object.keys(tradeBlockMessages[team]).length === 0) {
                    delete tradeBlockMessages[team];
                }
                saveTradeBlockMessages(tradeBlockMessages);
            }
            return interaction.reply({ content: `${player} removed from your trade block.`, ephemeral: true });
        } else {
            return interaction.reply({ content: 'Invalid action.', ephemeral: true });
        }
    }
};
