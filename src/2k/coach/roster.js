// commands/roster.js
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fs from "fs";
import path from "path";
import { readRoster, normalizeName, computePlayerValue2k, computePickValue2k, deriveAge, get2kRostersDir } from "../../utils/rosterUtils.js";
const teamEmojisPath = path.join(process.cwd(), "data", "2k", "team_emojis.json");
let teamEmojis = {};
try { teamEmojis = JSON.parse(fs.readFileSync(teamEmojisPath, "utf8")); } catch { teamEmojis = {}; }

function findTeamEmoji(teamName) {
    if (!teamName) return null;
    const mascot = teamName.trim().split(/\s+/).pop().toLowerCase();
    const matchKey = Object.keys(teamEmojis).find(k => k.toLowerCase() === mascot);
    if (!matchKey) return null;
    const emojiId = teamEmojis[matchKey];
    const emojiName = matchKey.replace(/\s+/g, '');
    return `<:${emojiName}:${emojiId}>`;
}

const data = new SlashCommandBuilder()
    .setName("2k-roster")
    .setDescription("Show a team's NBA 2K roster")
    .addStringOption((option) =>
        option
            .setName("team")
            .setDescription("The NBA team to view the roster for")
            .setRequired(true)
            .setAutocomplete(true)
    );

async function autocomplete(interaction) {
    try {
        console.log('[DEBUG] roster autocomplete called');
        const focusedValue = interaction.options.getFocused() || "";
        const rostersDir = get2kRostersDir();
        let teams = [];
        if (fs.existsSync(rostersDir)) {
            teams = fs.readdirSync(rostersDir)
                .filter(f => f.endsWith('.json') && f.toLowerCase() !== 'free_agency.json')
                .map(f => f.replace('.json', '').replace(/_/g, ' '))
                .sort((a, b) => a.localeCompare(b));
        }
        let filtered = teams;
        if (focusedValue) {
            filtered = teams.filter(name => name.toLowerCase().includes(focusedValue.toLowerCase()));
        }
        // dedupe by normalized name to avoid duplicates (e.g., path variants)
        const seen = new Set();
        filtered = filtered.filter(name => {
            const key = normalizeName(name);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        const options = filtered.map(name => ({ name, value: name })).slice(0, 25);
        await interaction.respond(options);
        return;
    } catch (err) {
        if (err?.code === 10062 || err?.code === 40060) return;
        console.error('[roster autocomplete] Fatal error:', err);
        try { await interaction.respond([{ name: 'No teams found', value: 'none' }]); } catch (e) {
            if (e?.code !== 10062 && e?.code !== 40060) console.error('[roster autocomplete] respond failed:', e);
        }
        return;
    }
}

async function execute(interaction) {
    let responded = false;
    try {
        try {
            await interaction.deferReply({ ephemeral: true });
        } catch (err) {
            if (err?.code === 10062) return; // interaction expired
            throw err;
        }
        responded = true;
        const team = interaction.options.getString("team");
        // Load roster using shared helper to honor aliases and fuzzy matches
        const data = readRoster(team, { force2k: true });
        const rosterObj = data?.roster || {};
        let playersArr = Array.isArray(rosterObj.players) ? rosterObj.players : [];
        let teamPicks = Array.isArray(rosterObj.picks)
            ? rosterObj.picks.map(p => {
                if (typeof p === 'object' && p.pick && p.value != null) return p;
                const pickStr = typeof p === 'string' ? p : p?.pick || '';
                const val = p?.value != null ? Number(p.value) : null;
                return val != null ? { pick: pickStr, value: val } : { pick: pickStr };
              })
            : [];
        if (!Array.isArray(playersArr) || playersArr.length === 0) {
            await interaction.editReply({ content: `No players found for ${team}.` });
            return;
        }
        // Determine if the viewer is the coach of this team (for waive button visibility)
        let canWaive = false;
        const COMMISH_ROLE_IDS = ['1460734222238220326', '1460734128935665817'];
        try {
            const coachMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
            const staffMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/staffRoleMap.main.json'), 'utf8'));
            const teamRoleId = (() => {
                if (coachMap[team]) return coachMap[team];
                const norm = normalizeName(team);
                const match = Object.entries(coachMap || {}).find(([k]) => normalizeName(k) === norm);
                return match ? match[1] : null;
            })();
            const isCoach = teamRoleId && interaction.member?.roles?.cache?.has(teamRoleId);
            const staffIds = [
                ...Object.entries(staffMap || {})
                    .filter(([name]) => name === 'Paradise Commish' || name === 'Paradise Co-Commish')
                    .map(([, id]) => id)
                    .filter(Boolean),
                ...COMMISH_ROLE_IDS,
            ];
            const isStaff = interaction.member?.roles?.cache?.some(r => staffIds.includes(r.id));
            if (isCoach || isStaff) {
                canWaive = true;
            }
            // Optional: allow direct user ID match if map stores user IDs
            if (!canWaive && teamRoleId === interaction.user.id) {
                canWaive = true;
            }
        } catch {
            // ignore
        }
        // playersArr and teamPicks are now declared above for all formats
        if (!Array.isArray(playersArr) || playersArr.length === 0) {
            await interaction.editReply({ content: `No players found for ${team}.` });
            return;
        }
        // Sort roster by OVR descending
        const sortedRoster = [...playersArr].sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0));
        // Format roster for embed and build action rows for each player
        const lines = [];
        for (const player of sortedRoster) {
            const val = computePlayerValue2k(player);
            const age = deriveAge(player);
            lines.push(`**${player.name}** | ${player.position} | Age: ${age} | OVR: ${player.ovr} | Val: ${val.toFixed(1)}`);
        }
        // Group and format picks by year for embed, including pick values
        function parsePick(pickStr) {
            const yearMatch = pickStr.match(/(20\d{2})/);
            const roundMatch = pickStr.match(/\b(1st|2nd|first|second)\b/i);
            const pickNumMatch = pickStr.match(/#?(\d{1,2})/);
            const year = yearMatch ? Number(yearMatch[1]) : null;
            const round = roundMatch ? (roundMatch[1].toLowerCase().startsWith('1') ? 1 : 2) : null;
            const pickNum = pickNumMatch ? Number(pickNumMatch[1]) : null;
            return { year, round, pickNum };
        }
        function getSeasonYear() {
            try {
                const fs = require('fs');
                const path = require('path');
                const seasonPath = path.join(process.cwd(), 'data', 'season.json');
                if (fs.existsSync(seasonPath)) {
                    const s = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
                    if (s.seasonYear) return Number(s.seasonYear);
                    if (s.seasonNo) return 2025 + Number(s.seasonNo); // season 1 -> 2026
                }
            } catch {
                /* ignore */
            }
            return new Date().getFullYear();
        }
        const seasonYear = getSeasonYear();

        function formatPicksByYear(picks, teamName) {
            const grouped = {};
            for (const pick of picks) {
                let pickStr = typeof pick === 'string' ? pick : pick.pick || '';
                const { year, round, pickNum } = parsePick(pickStr);
                const displayYear = year || 'Other';
                let line = pickStr;
                const storedVal = (typeof pick === 'object' && pick.value != null) ? Number(pick.value) : null;
                // Keep traded pick value stable: use stored value if present; otherwise only compute when not VIA
                const val = storedVal != null
                  ? storedVal
                  : (year && round && !pickStr.includes('VIA')
                    ? computePickValue2k(year, round, pickNum, seasonYear)
                    : null);
                if (val != null) {
                    line += ` (Val: ${Number(val).toFixed(0)})`;
                }
                if (typeof pick === 'object') {
                    if (pick.protection && pick.protection !== 'unprotected') {
                        line += ` (${pick.protection} protected)`;
                    }
                    if (pick.originalTeam && pick.originalTeam !== teamName) {
                        line += ` (from ${pick.originalTeam})`;
                    }
                }
                if (!grouped[displayYear]) grouped[displayYear] = [];
                grouped[displayYear].push(line);
            }
            let result = '';
            Object.keys(grouped).sort().forEach(year => {
                result += `**${year}**\n`;
                result += grouped[year].map(p => `• ${p}`).join('\n') + '\n';
            });
            return result.trim();
        }
        let pickLines = teamPicks.length ? formatPicksByYear(teamPicks, team) : '';

        const emoji = findTeamEmoji(team);
        const title = `${emoji ? `${emoji} ` : ''}Roster for ${team}`;

        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(lines.join("\n\n").slice(0, 4000) || "No players found.")
            .setColor(0x1E90FF);
        embed.addFields({
            name: 'Draft Picks',
            value: pickLines ? pickLines.slice(0, 1024) : 'No draft picks found.'
        });
        // Debug: show sorted roster and picks in console
        console.log('[ROSTER DEBUG] Sorted roster:', sortedRoster.map(p => `${p.name} (${p.ovr})`).join(', '));
        console.log('[ROSTER DEBUG] Picks:', pickLines);
        const components = [];
        if (canWaive) {
            const waiveBtn = new ButtonBuilder()
                .setCustomId(`waive_player_open_modal::${team}`)
                .setLabel('Waive a player')
                .setStyle(ButtonStyle.Danger);
            components.push(new ActionRowBuilder().addComponents(waiveBtn));
        }

        await interaction.editReply({ embeds: [embed], components });
    } catch (err) {
        console.error('Error in roster:', err);
        if (responded) {
            try {
                await interaction.editReply({ content: 'Failed to load roster.' });
            } catch (e) {
                if (e?.code !== 10062) throw e;
            }
        } else {
            try {
                await interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
            } catch (e) {
                if (e?.code !== 10062) throw e;
            }
        }
    }
}

export default { data, execute, autocomplete };
