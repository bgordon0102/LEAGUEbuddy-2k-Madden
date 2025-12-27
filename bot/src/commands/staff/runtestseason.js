import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { runSeasonSetup, runAdvanceWeek } from '../../utils/seasonTestUtils.js';

export const data = new SlashCommandBuilder()
    .setName('runtestseason')
    .setDescription('Run a full season simulation for healthcheck')
    .addIntegerOption(option =>
        option.setName('season')
            .setDescription('Season number to test')
            .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    const seasonNo = interaction.options.getInteger('season');
    const draftClassFolder = seasonNo === 1 ? 'CUS01' : 'CUS02';
    const path = (await import('path')).default;
    const draftClassPath = path.join(process.cwd(), 'draft classes', draftClassFolder);
    try {
        // Always reset all data before running the test season
        try {
            const { resetSeasonData } = await import('./startseason.js');
            resetSeasonData(seasonNo, interaction.guild, 'runtestseason');
            await interaction.editReply({ content: `✅ startseason for season ${seasonNo} (reset all data)` });
        } catch (err) {
            await interaction.editReply({ content: `❌ startseason error: ${err && err.message ? err.message : err}` });
            return;
        }
        const TOTAL_WEEKS = 29;
        const { DataManager } = await import('../../utils/dataManager.js');
        // Removed score submitting, pin, welcome, button, modal, OCR, and result logic for rebuild
        const dataManager = new DataManager();
        const fs = (await import('fs')).default;
        // Load big board from draft class folder
        const bigBoardPath = path.join(draftClassPath, `2k26_${draftClassFolder} - Big Board.json`);
        let bigBoard = [];
        try {
            bigBoard = Object.values(JSON.parse(fs.readFileSync(bigBoardPath, 'utf8')));
        } catch (err) {
            await interaction.editReply({ content: `❌ Error loading big board: ${err && err.message ? err.message : err}` });
            return;
        }
        for (let week = 1; week <= TOTAL_WEEKS; week++) {
            // Update currentWeek in season.json for each simulated week
            try {
                const seasonPath = path.join(process.cwd(), 'data/season.json');
                let seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
                seasonData.currentWeek = week;
                fs.writeFileSync(seasonPath, JSON.stringify(seasonData, null, 2));
            } catch (err) {
                await interaction.editReply({ content: `❌ Error updating currentWeek in season.json: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
            // 1. Create threads for each matchup
            let createdThreads = [];
            try {
                let schedule = dataManager.readData('schedule') || [];
                const matchups = schedule[week] || [];
                for (const matchup of matchups) {
                    // Pin/welcome/score logic removed for rebuild
                }
                await interaction.editReply({ content: `✅ Created ${createdThreads.length}/${matchups.length} threads for week ${week}.` });
            } catch (err) {
                await interaction.editReply({ content: `❌ Error creating threads: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
            // 2. Scout one player from big board for 3 coaches
            try {
                if (Array.isArray(bigBoard) && bigBoard.length >= week) {
                    const player = bigBoard[week - 1];
                    if (!player) throw new Error('No player found for this week');
                    const scout = (await import('../../commands/coach/scout.js'));
                    const bigboard = (await import('../../commands/coach/bigboard.js'));
                    // Get 3 coaches from coachRoleMap
                    const seasonPath = path.join(process.cwd(), 'data/season.json');
                    const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
                    // Always include Cavaliers coach in the 3
                    let coachEntries = Object.entries(seasonData.coachRoleMap).slice(0, 3);
                    const cavsEntry = Object.entries(seasonData.coachRoleMap).find(([team, _]) => team === 'Cleveland Cavaliers');
                    if (cavsEntry) {
                        // Replace last entry with Cavs if not already included
                        if (!coachEntries.some(([team, _]) => team === 'Cleveland Cavaliers')) {
                            coachEntries[2] = cavsEntry;
                        }
                    }
                    let scoutedCount = 0;
                    for (const [teamName, coachId] of coachEntries) {
                        const mockScoutInteraction = {
                            user: { id: coachId, tag: teamName },
                            deferReply: async () => { },
                            editReply: async (data) => { await interaction.followUp(data); },
                            replied: false,
                            deferred: true,
                            options: { getInteger: () => week },
                            values: [player.id_number ? player.id_number.toString() : (week).toString()],
                        };
                        await scout.handleScoutSelect(mockScoutInteraction, 1);
                        scoutedCount++;
                    }
                    // Optionally, show big board after scouting
                    const mockBigboardInteraction = {
                        deferReply: async () => { },
                        editReply: async (data) => { await interaction.followUp(data); },
                        replied: false,
                        deferred: true,
                    };
                    await bigboard.execute(mockBigboardInteraction);
                    await interaction.editReply({ content: `✅ Scouted player for ${scoutedCount} coaches for week ${week}.` });
                } else {
                    throw new Error('Big board does not have enough players for this week');
                }
            } catch (err) {
                await interaction.editReply({ content: `❌ Error scouting player: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
            // 3. Generate random scores for all games
            try {
                const generaterandomscores = (await import('./generaterandomscores.js')).execute;
                const mockInteraction = {
                    deferReply: async () => { },
                    editReply: async ({ content }) => { await interaction.followUp({ content }); },
                    options: { getInteger: () => week },
                };
                await generaterandomscores(mockInteraction);
            } catch (err) {
                await interaction.editReply({ content: `❌ Error generating scores: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
            // Always update standings and playoff picture pins after scores
            try {
                const standingsModule = await import('../../commands/coach/standings.js');
                const playoffModule = await import('../../commands/coach/playoffpicture.js');
                const { EmbedBuilder } = await import('discord.js');
                const standings = standingsModule.getStandings();
                if (!standings || !standings.east || !standings.west) {
                    await interaction.editReply({ content: `❌ Error updating standings/playoff pins: Standings data is missing or invalid` });
                    await interaction.editReply({ content: `❌ Test season failed: Standings data is missing or invalid` });
                    return;
                }
                function formatRow(s, i) {
                    if (!s || !s.team) return 'TBD';
                    return `**${i + 1}. ${s.team}**  ${s.wins ?? 0}-${s.losses ?? 0}  (.${String(Math.round((s.winPct ?? 0) * 1000)).padStart(3, '0')})  GB: ${(s.gb ?? '-') === 0 ? '-' : s.gb ?? '-'}`;
                }
                const eastRows = Array.isArray(standings.east) && standings.east.length > 0 ? standings.east.map(formatRow).join('\n') : 'No games played';
                const westRows = Array.isArray(standings.west) && standings.west.length > 0 ? standings.west.map(formatRow).join('\n') : 'No games played';
                const standingsEmbed = new EmbedBuilder()
                    .setTitle('NBA League Standings')
                    .addFields(
                        { name: 'Eastern Conference', value: eastRows, inline: false },
                        { name: 'Western Conference', value: westRows, inline: false }
                    )
                    .setColor(0x1D428A)
                    .setFooter({ text: 'W-L | Win% | Games Behind (GB)' });
                const standingsChannelId = '1428159168904167535';
                const playoffChannelId = '1428159324341141576';
                const guild = interaction.guild;
                async function updatePinnedEmbed(channelId, embedArr) {
                    const channel = await guild.channels.fetch(channelId);
                    if (!channel) throw new Error('Channel not found for updating pins');
                    const pins = await channel.messages.fetchPinned();
                    let pinnedMsg = pins.find(m => m.author.id === guild.client.user.id);
                    if (pinnedMsg) {
                        await pinnedMsg.edit({ embeds: embedArr });
                    } else {
                        const sentMsg = await channel.send({ embeds: embedArr });
                        await sentMsg.pin();
                    }
                }
                await updatePinnedEmbed(standingsChannelId, [standingsEmbed]);
                // Playoff picture
                const playoffStandings = playoffModule.getStandings();
                if (!playoffStandings || !playoffStandings.east || !playoffStandings.west) {
                    await interaction.editReply({ content: `❌ Error updating standings/playoff pins: Playoff standings data is missing or invalid` });
                    await interaction.editReply({ content: `❌ Test season failed: Playoff standings data is missing or invalid` });
                    return;
                }
                function getTeamName(arr, idx) {
                    return Array.isArray(arr) && arr[idx] && arr[idx].team ? arr[idx].team : 'TBD';
                }
                function playoffMatchups(conf) {
                    if (!Array.isArray(conf) || conf.length < 8) return 'No playoff matchups';
                    return [
                        `1️⃣ ${getTeamName(conf, 0)} vs 8️⃣ ${getTeamName(conf, 7)}`,
                        `2️⃣ ${getTeamName(conf, 1)} vs 7️⃣ ${getTeamName(conf, 6)}`,
                        `3️⃣ ${getTeamName(conf, 2)} vs 6️⃣ ${getTeamName(conf, 5)}`,
                        `4️⃣ ${getTeamName(conf, 3)} vs 5️⃣ ${getTeamName(conf, 4)}`
                    ].join('\n');
                }
                function playinMatchups(conf) {
                    if (!Array.isArray(conf) || conf.length < 10) return 'No play-in matchups';
                    return [
                        `7️⃣ ${getTeamName(conf, 6)} vs 🏟️ ${getTeamName(conf, 9)}`,
                        `8️⃣ ${getTeamName(conf, 7)} vs 9️⃣ ${getTeamName(conf, 8)}`
                    ].join('\n');
                }
                const eastEmbed = new EmbedBuilder()
                    .setTitle('🏆 Eastern Conference Playoff Bracket')
                    .addFields(
                        { name: 'Playoff Matchups', value: playoffMatchups(playoffStandings.east), inline: false },
                        { name: 'Play-In Matchups', value: playinMatchups(playoffStandings.east), inline: false }
                    )
                    .setColor(0x1D428A)
                    .setFooter({ text: 'Top 6: Playoff | 7-10: Play-In' });
                const westEmbed = new EmbedBuilder()
                    .setTitle('🏆 Western Conference Playoff Bracket')
                    .addFields(
                        { name: 'Playoff Matchups', value: playoffMatchups(playoffStandings.west), inline: false },
                        { name: 'Play-In Matchups', value: playinMatchups(playoffStandings.west), inline: false }
                    )
                    .setColor(0xE03A3E)
                    .setFooter({ text: 'Top 6: Playoff | 7-10: Play-In' });
                await updatePinnedEmbed(playoffChannelId, [eastEmbed, westEmbed]);
            } catch (err) {
                await interaction.editReply({ content: `❌ Error updating standings/playoff pins: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
            // 4. Delete current week threads
            try {
                const dedicatedChannelId = '1428141604761374792';
                const dedicatedChannel = interaction.guild.channels.cache.get(dedicatedChannelId);
                if (!dedicatedChannel || !dedicatedChannel.threads) {
                    await interaction.followUp({ content: '❌ Dedicated channel or threads not found.' });
                    await interaction.editReply({ content: `❌ Test season failed: Dedicated channel or threads not found.` });
                    return;
                }
                const threads = await dedicatedChannel.threads.fetchActive();
                let deleted = 0;
                for (const thread of threads.threads.values()) {
                    if (thread.name.includes(`week ${week}`) || thread.name.match(/-vs-/i)) {
                        try {
                            await thread.delete();
                            deleted++;
                        } catch (e) {
                            // log error but continue
                        }
                    }
                }
                await interaction.editReply({ content: `✅ Deleted ${deleted} threads for week ${week}.` });
            } catch (err) {
                await interaction.editReply({ content: `❌ Error deleting week threads: ${err && err.message ? err.message : err}` });
                await interaction.editReply({ content: `❌ Test season failed: ${err && err.message ? err.message : err}` });
                return;
            }
        }
    } catch (err) {
        await interaction.editReply({ content: `❌ Unexpected error: ${err && err.message ? err.message : err}` });
    }
}

export default { data, execute };
