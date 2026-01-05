// commands/roster.js
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import fs from "fs";
import path from "path";
import { readRoster } from "../../utils/rosterUtils.js";
import { normalizeName } from "../../utils/rosterUtils.js";

const data = new SlashCommandBuilder()
    .setName("roster")
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
        console.log(`[DEBUG] focusedValue: '${focusedValue}'`);
        const teamsPath = path.join(process.cwd(), "data/teams.json");
        let teams = [];
        if (fs.existsSync(teamsPath)) {
            try {
                teams = JSON.parse(fs.readFileSync(teamsPath, "utf8"));
                console.log(`[DEBUG] Loaded teams: ${teams.length}`);
            } catch (e) {
                console.error('[roster autocomplete] Failed to parse teams.json:', e);
            }
        } else {
            console.error(`[DEBUG] teams.json does not exist at ${teamsPath}`);
        }
        // Support searching by name or abbreviation
        const filtered = teams.filter(team => {
            const name = team.name?.toLowerCase() || "";
            const abbr = team.abbreviation?.toLowerCase() || "";
            const search = focusedValue.toLowerCase();
            return name.includes(search) || abbr.includes(search);
        });
        console.log(`[DEBUG] Filtered teams: ${filtered.length}`);
        // If nothing matches, show all teams
        const options = (filtered.length ? filtered : teams)
            .map(team => ({ name: `${team.name} (${team.abbreviation})`, value: team.name }))
            .slice(0, 25);
        console.log('[DEBUG] Autocomplete options:', options);
        await interaction.respond(options);
        return;
    } catch (err) {
        // Avoid noisy logs/replies on expired or already-acknowledged interactions
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
        const data = readRoster(team);
        if (!data) {
            await interaction.editReply({ content: `No roster found for ${team}.` });
            return;
        }
        const { rosterPath, roster } = data;
        // Determine if the viewer is the coach of this team (for waive button visibility)
        let canWaive = false;
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
            const isStaff = interaction.member?.roles?.cache?.some(r =>
                Object.entries(staffMap || {})
                    .filter(([name]) => name === 'Paradise Commish' || name === 'Paradise Co-Commish')
                    .map(([, id]) => id)
                    .includes(r.id)
            );
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
        // Handle new roster format: object with players and picks
        let playersArr = Array.isArray(roster) ? roster : roster.players || [];
        if (!Array.isArray(playersArr) || playersArr.length === 0) {
            await interaction.editReply({ content: `No players found for ${team}.` });
            return;
        }
        // Sort roster by OVR descending
        const sortedRoster = [...playersArr].sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0));
        // Format roster for embed and build action rows for each player
        const lines = [];
        for (const player of sortedRoster) {
            lines.push(`**${player.name}** | ${player.position} | OVR: ${player.ovr}`);
        }

        // Load draft picks for this team from roster file
        let teamPicks = Array.isArray(roster.picks) ? roster.picks : [];
        // Group and format picks by year for embed
        function formatPicksByYear(picks, teamName) {
            const grouped = {};
            for (const pick of picks) {
                let pickStr = typeof pick === 'string' ? pick : pick.pick || '';
                let yearMatch = pickStr.match(/\d{4}/);
                let year = yearMatch ? yearMatch[0] : 'Other';
                let line = pickStr;
                if (typeof pick === 'object') {
                    if (pick.protection && pick.protection !== 'unprotected') {
                        line += ` (${pick.protection} protected)`;
                    }
                    if (pick.originalTeam && pick.originalTeam !== teamName) {
                        line += ` (from ${pick.originalTeam})`;
                    }
                }
                if (!grouped[year]) grouped[year] = [];
                grouped[year].push(line);
            }
            let result = '';
            Object.keys(grouped).sort().forEach(year => {
                result += `**${year}**\n`;
                result += grouped[year].map(p => `• ${p}`).join('\n') + '\n';
            });
            return result.trim();
        }
        let pickLines = teamPicks.length ? formatPicksByYear(teamPicks, team) : '';

        const embed = new EmbedBuilder()
            .setTitle(`Roster for ${team}`)
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
