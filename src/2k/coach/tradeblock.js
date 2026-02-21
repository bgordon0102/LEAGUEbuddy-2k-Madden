// ...existing code...


import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set your Ghost Paradise role ID here
const GHOST_PARADISE_ROLE_ID = '1460733464721490108';

// Paths to data files
const coachRoleMapPath = path.join(__dirname, '../../../data/coachRoleMap.json');
import { readRoster } from '../../utils/rosterUtils.js';
const tradeBlockPath = path.join(__dirname, '../../../data/tradeblock.json');
const teamsRostersPath = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
const teamsJsonPath = path.join(process.cwd(), 'data', 'teams.json');
const SEASON_PATH = path.join(process.cwd(), 'data', 'season.json');
const TRADE_BLOCK_CHANNEL_ID = process.env.TRADE_BLOCK_CHANNEL_ID_2K || '1432507364468068412';

function computeSeasonAge(birthdate) {
    if (!birthdate) return '';
    let seasonNo = 1;
    try {
        const seasonData = JSON.parse(fs.readFileSync(SEASON_PATH, 'utf8'));
        if (seasonData.seasonNo) seasonNo = Number(seasonData.seasonNo);
    } catch { /* ignore */ }
    const seasonYear = 2024 + seasonNo; // season 1 => 2025 start
    const refDate = new Date(`${seasonYear}-10-20`);
    const birth = new Date(birthdate);
    if (Number.isNaN(birth.getTime())) return '';
    let age = refDate.getFullYear() - birth.getFullYear();
    if (refDate.getMonth() < birth.getMonth() || (refDate.getMonth() === birth.getMonth() && refDate.getDate() < birth.getDate())) {
        age--;
    }
    return age;
}

function getCoachTeamFromRoles(interaction) {
    // Find a role ending in 'Coach' and map to team
    const roles = interaction.member?.roles?.cache;
    if (!roles) return null;
    // First, try the role name pattern (legacy)
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
    // Fallback: use coachRoleMap.json (roleId -> team name like "Phoenix Suns Coach")
    try {
        const coachMap = JSON.parse(fs.readFileSync(coachRoleMapPath, 'utf8'));
        const roleIdToTeam = Object.entries(coachMap || {}).reduce((acc, [teamName, rid]) => {
            if (rid) acc[rid] = teamName;
            return acc;
        }, {});
        for (const [rid] of roles) {
            const teamNameWithCoach = roleIdToTeam[rid];
            if (teamNameWithCoach) {
                const base = teamNameWithCoach.replace(/\\s*Coach$/i, '').trim();
                return base.replace(/\s+/g, '_');
            }
        }
    } catch { /* ignore */ }
    return null;
}

function getTeamPlayers(team) {
    const data = readRoster(team);
    // Support legacy shapes: array, { players: [] }, or { roster: { players: [] } }
    const playersArr = Array.isArray(data)
        ? data
        : Array.isArray(data?.players)
          ? data.players
          : Array.isArray(data?.roster?.players)
            ? data.roster.players
            : [];
    return playersArr.map(p => p.name).filter(Boolean);
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
    // Format team name: remove underscores, capitalize each word
    const formattedTeam = team.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const embed = {
        title: `${formattedTeam} Trade Block`,
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

function buildTeamSlugs(teamName) {
    const raw = (teamName || '').trim();
    const noSpace = raw.replace(/\s+/g, '').toLowerCase();
    const base = raw.replace(/_/g, ' ');
    let abbr = '';
    try {
        const teams = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf8'));
        const hit = teams.find(t => (t.name || '').toLowerCase() === raw.toLowerCase());
        abbr = (hit?.abbreviation || '').toLowerCase();
    } catch { /* ignore */ }
    return new Set([
        raw.toLowerCase(),
        base.toLowerCase(),
        noSpace,
        noSpace.replace(/tradeblock/gi, ''),
        abbr,
    ].filter(Boolean));
}

async function getOrCreateTeamThread(channel, teamName) {
    if (!channel || !channel.isTextBased()) return null;
    if (channel.isThread()) return channel;

    const slugs = buildTeamSlugs(teamName);
    const matchThread = (t) => {
        const name = (t?.name || '').toLowerCase().replace(/[\s_]/g, '');
        return Array.from(slugs).some(s => s && (name.includes(s) || s.includes(name)));
    };

    try {
        // Gather active + archived threads once
        const active = await channel.threads?.fetchActive?.().catch(() => null);
        const archived = await channel.threads?.fetchArchived?.().catch(() => null);
        const candidates = [
            ...(active?.threads?.values?.() || []),
            ...(archived?.threads?.values?.() || []),
        ];
        let thread = candidates.find(matchThread) || null;

        // Create if missing (Forum vs TextChannel)
        if (!thread) {
            if (channel.type === ChannelType.GuildForum) {
                thread = await channel.threads.create({
                    name: `${teamName} Trade Block`,
                    message: { content: `Trade block thread for ${teamName}` },
                    reason: `Trade block thread for ${teamName}`,
                }).catch(() => null);
            } else {
                thread = await channel.threads.create({
                    name: `${teamName} Trade Block`,
                    autoArchiveDuration: 10080, // 7 days
                    reason: `Trade block thread for ${teamName}`,
                }).catch(() => null);
            }
        }
        return thread || null;
    } catch (err) {
        console.error('[tradeblock] thread fetch/create failed', err);
        return null;
    }
}


const data = new SlashCommandBuilder()
    .setName('2k-tradeblock')
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
        let responded = false;
        // Set a timeout to always respond within 2 seconds
        const timeout = setTimeout(async () => {
            if (!responded) {
                responded = true;
                try { await interaction.respond([]); } catch { }
            }
        }, 2000);
        try {
            const focusedOption = interaction.options.getFocused(true);
            if (focusedOption.name === 'action') {
                if (!responded) {
                    responded = true;
                    clearTimeout(timeout);
                    await interaction.respond([
                        { name: 'add', value: 'add' },
                        { name: 'remove', value: 'remove' }
                    ]);
                }
                return;
            }
            const team = getCoachTeamFromRoles(interaction);
            if (!team) {
                if (!responded) {
                    responded = true;
                    clearTimeout(timeout);
                    await interaction.respond([]);
                }
                return;
            }
            const tradeBlock = getTradeBlock();
            if (focusedOption.name === 'player') {
                const action = interaction.options.getString('action');
                if (action === 'add') {
                    const teamPlayers = getTeamPlayers(team);
                    const blocked = tradeBlock[team] || [];
                    const available = teamPlayers.filter(p => !blocked.includes(p));
                    if (!responded) {
                        responded = true;
                        clearTimeout(timeout);
                        await interaction.respond(available.map(p => ({ name: p, value: p })).slice(0, 25));
                    }
                    return;
                } else if (action === 'remove') {
                    const blocked = tradeBlock[team] || [];
                    if (!responded) {
                        responded = true;
                        clearTimeout(timeout);
                        await interaction.respond(blocked.map(p => ({ name: p, value: p })).slice(0, 25));
                    }
                    return;
                }
            }
            if (!responded) {
                responded = true;
                clearTimeout(timeout);
                await interaction.respond([]);
            }
        } catch (err) {
            console.error('TRADEBLOCK AUTOCOMPLETE ERROR:', err);
            if (!responded) {
                responded = true;
                clearTimeout(timeout);
                try {
                    await interaction.respond([{ name: 'Error loading options', value: 'none' }]);
                } catch (e) {
                    // If interaction already acknowledged/expired, just log
                    console.error('TRADEBLOCK AUTOCOMPLETE RESPOND ERROR:', e);
                }
            }
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
        // Always reload trade block from disk to avoid race conditions
        let tradeBlock = getTradeBlock();
        tradeBlock[team] = tradeBlock[team] || [];
        const tradeBlockMessages = getTradeBlockMessages();
        if (action === 'add') {
            // Reload again right before check
            tradeBlock = getTradeBlock();
            tradeBlock[team] = tradeBlock[team] || [];
            if (tradeBlock[team].length >= 5) {
                return interaction.reply({ content: 'You can only have 5 players on your trade block.', ephemeral: true });
            }
            if (tradeBlock[team].includes(player)) {
                console.log(`[DEBUG] Attempted to add duplicate player to trade block: ${player} for team ${team}`);
                return interaction.reply({ content: `${player} is already on your trade block.`, ephemeral: true });
            }
            tradeBlock[team].push(player);
            saveTradeBlock(tradeBlock);

            // Post a player-specific embed to the team thread in trade block channel
            const tradeBlockChannelId = TRADE_BLOCK_CHANNEL_ID;
            const channel = interaction.client.channels.cache.get(tradeBlockChannelId) || await interaction.client.channels.fetch(tradeBlockChannelId).catch(() => null);
            // Find player info from roster file
            const teamFile = path.join(teamsRostersPath, `${team}.json`);
            let position = '';
            let ovr = '';
            let age = '';
            let thumbnailUrl = '';
            if (fs.existsSync(teamFile)) {
                const roster = JSON.parse(fs.readFileSync(teamFile));
                const playerObj = roster.players?.find(p => p.name === player);
                if (playerObj) {
                    position = playerObj.position || '';
                    ovr = playerObj.ovr || '';
                    age = playerObj.age || computeSeasonAge(playerObj.birthdate);
                    // support both imgUrl and imgURL casing
                    thumbnailUrl = playerObj.imgUrl || playerObj.imgURL || `https://cdn.nba2k.com/players/${player.replace(/ /g, '_')}.png`;
                }
            }
            const embed = {
                title: `${player} added to the ${team.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} trade block!`,
                description: `Position: ${position || 'N/A'}${ovr ? `\nOVR: ${ovr}` : ''}${age ? `\nAge: ${age}` : ''}`,
                color: 0x00AE86,
                thumbnail: thumbnailUrl ? { url: thumbnailUrl } : undefined
            };
            const tradeButtonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`trade_for::${encodeURIComponent(team)}::${encodeURIComponent(player)}`)
                    .setLabel('Trade For')
                    .setStyle(ButtonStyle.Primary)
            );
            const target = channel ? await getOrCreateTeamThread(channel, team.replace(/_/g, ' ')) : interaction.channel;
            const sentMsg = await target.send({ content: `<@&${GHOST_PARADISE_ROLE_ID}>`, embeds: [embed], components: [tradeButtonRow] });
            // Store message ID for later removal
            tradeBlockMessages[team] = tradeBlockMessages[team] || {};
            tradeBlockMessages[team][player] = { messageId: sentMsg.id, threadId: target?.id || null };
            saveTradeBlockMessages(tradeBlockMessages);

            return interaction.reply({ content: `${player} added to your trade block.`, ephemeral: true });
        } else if (action === 'remove') {
            if (!tradeBlock[team].includes(player)) {
                return interaction.reply({ content: `${player} is not on your trade block.`, ephemeral: true });
            }
            tradeBlock[team] = tradeBlock[team].filter(p => p !== player);
            saveTradeBlock(tradeBlock);

            // Remove the player-specific embed message
            const tradeBlockChannelId = TRADE_BLOCK_CHANNEL_ID;
            const channel = interaction.client.channels.cache.get(tradeBlockChannelId) || await interaction.client.channels.fetch(tradeBlockChannelId).catch(() => null);
            const msgRef = tradeBlockMessages[team]?.[player];
            const msgId = msgRef?.messageId || msgRef;
            const threadId = msgRef?.threadId;
            const thread = threadId ? await (channel?.threads?.fetch(threadId).catch(()=>null)) : null;
            const target = thread || channel;
            if (target && msgId) {
                try {
                    const msg = await target.messages.fetch(msgId);
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
