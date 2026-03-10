import { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';

const cleanTeamName = (name) => (name || '').replace(/\s+Coach$/i, '');
const DEBUG = process.env.AVAIL_TEAMS_DEBUG === 'true';
const log = (...args) => console.log('[2k-availableteams]', ...args);
const TEAM_EMOJI_FILE = path.join(process.cwd(), 'data', '2k', 'team_emojis.json');
// Match the in-game conference order
const CONFERENCES = {
    East: [
        '76ers', 'Bucks', 'Bulls', 'Cavaliers', 'Celtics', 'Hawks', 'Heat', 'Hornets', 'Knicks', 'Magic', 'Nets', 'Pacers', 'Pistons', 'Raptors', 'Wizards'
    ],
    West: [
        'Clippers', 'Grizzlies', 'Jazz', 'Kings', 'Lakers', 'Mavericks', 'Nuggets', 'Pelicans', 'Suns', 'Spurs', 'Thunder', 'Timberwolves', 'Trail Blazers', 'Warriors', 'Rockets'
    ]
};
const TEAM_ORDER = [...CONFERENCES.East, ...CONFERENCES.West];

async function roleHasMembers(guild, roleId) {
    if (!roleId) return false;
    const start = Date.now();
    try {
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId);
        if (!role) return false;
        if (role.members?.size) return true;
        // Fetch members with this role; cap wait to avoid hanging
        const fetchPromise = guild.members.fetch({ role: roleId });
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 1800));
        const result = await Promise.race([fetchPromise, timeoutPromise]).catch((err) => {
            if (DEBUG) log('roleHasMembers fetch error', { roleId, err: err?.code || err?.message });
            return 'error';
        });
        const col = (result === 'timeout' || result === 'error') ? null : result;
        const ms = Date.now() - start;
        if (DEBUG && ms > 800) log('roleHasMembers slow fetch', { roleId, ms, size: col?.size ?? 0, timeout: result === 'timeout' });
        if (result === 'timeout' || result === 'error') return null; // unknown (likely missing Member intent)
        return (col?.size ?? 0) > 0;
    } catch (e) {
        if (DEBUG) {
            const ms = Date.now() - start;
            log('roleHasMembers error', { roleId, ms, err: e?.code || e?.message });
        }
        return null; // unknown
    }
}

export const data = new SlashCommandBuilder()
    .setName('2k-availableteams')
    .setDescription('List all teams with no coach assigned (staff only)')
    // Allow role-gated staff (co-commish) even if they lack ManageChannels; we enforce checks at runtime.
    .setDefaultMemberPermissions(null);

export async function execute(interaction) {
    await interaction.deferReply({ flags: 0 }); // public reply; avoids deprecated ephemeral option
    try {
        const runId = Date.now();
        // Only allow staff (role-based check with fallback to ManageChannels)
        const member = await interaction.guild.members.fetch(interaction.user.id);
        let isStaff = member.permissions.has(PermissionsBitField.Flags.ManageChannels);
        try {
            const staffMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/staffRoleMap.main.json'), 'utf8'));
            const allowedNames = ['Paradise Commish', 'Paradise Co-Commish', 'Schedule Tracker'];
            const allowedIds = Object.entries(staffMap || {})
                .filter(([name]) => allowedNames.includes(name))
                .map(([, id]) => id)
                .filter(Boolean);
            if (allowedIds.length && member.roles.cache.some(r => allowedIds.includes(r.id))) {
                isStaff = true;
            }
        } catch {
            // ignore staff map load errors, fallback to permission check
        }
        if (!isStaff) {
            await interaction.editReply({ content: 'Only staff can use this command.' });
            return;
        }
        // Load coachRoleMap
        let coachRoleMap = {};
        try {
            // Prefer workspace data file; fallback to src copy if present
            const primary = path.join(process.cwd(), 'data/coachRoleMap.json');
            const alt = path.join(process.cwd(), 'src', 'data', 'coachRoleMap.json');
            const file = fs.existsSync(primary) ? primary : alt;
            coachRoleMap = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            await interaction.editReply({ content: 'Could not load coachRoleMap.json.' });
            return;
        }

        const guild = interaction.guild;
        const startAll = Date.now();
        const totalEntries = Object.keys(coachRoleMap || {}).length;
        log('start', { user: interaction.user.id, entries: totalEntries, guild: interaction.guildId });
        // Only consider NBA coach roles (keys ending in 'Coach'), using team nicknames (e.g., "Wizards Coach")
        const entries = Object.entries(coachRoleMap || {}).filter(([k]) => /coach$/i.test(k));
        if (DEBUG) log('filtered entries', { total: Object.keys(coachRoleMap || {}).length, coachOnly: entries.length, keys: entries.map(([k])=>k).slice(0,5) });
        // Fetch all members once to mirror Madden's robustness
        let roleCounts = null;
        try {
            const members = await guild.members.fetch();
            roleCounts = {};
            members.forEach(m => {
                m.roles.cache.forEach(r => {
                    roleCounts[r.id] = (roleCounts[r.id] || 0) + 1;
                });
            });
        } catch (e) {
            if (DEBUG) log('member fetch skipped', e?.message || e);
            roleCounts = null;
        }

        const availability = await Promise.all(entries.map(async ([team, roleId]) => {
            let assigned = null;
            if (roleCounts) {
                const count = roleCounts[roleId] || 0;
                assigned = count > 0;
            } else {
                assigned = await roleHasMembers(guild, roleId); // true | false | null
            }
            return { team, assigned };
        }));
        const emojiMap = (() => {
            try { return JSON.parse(fs.readFileSync(TEAM_EMOJI_FILE, 'utf8')); } catch { return {}; }
        })();
        const fmtLine = (team, suffix = 'Open') => {
            const key = team.replace(/\s+Coach$/i, '').trim();
            const emojiId = emojiMap[key];
            const emojiName = `team_${key.toLowerCase().replace(/\s+/g, '_')}`;
            const emoji = emojiId ? `<:${emojiName}:${emojiId}> ` : '';
            return `${emoji}${key} — ${suffix}`;
        };
        const orderIdx = (team) => {
            const key = cleanTeamName(team);
            const idx = TEAM_ORDER.indexOf(key);
            return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
        };
        const openLines = availability
            .filter(a => a.assigned === false || a.assigned === null) // null (unknown intent) treated as open, consistent with Madden resiliency
            .map(a => cleanTeamName(a.team))
            .sort((a, b) => orderIdx(a) - orderIdx(b))
            .map(t => fmtLine(t));
        const unknownLines = []; // folded into open
        log('done', { ms: Date.now() - startAll, open: openLines.length, entries: totalEntries });

        // Build embed (match Madden wording/layout)
        let description = openLines.length ? openLines.join('\n') : 'No open teams.';
        if (description.length > 4000) description = description.slice(0, 3996) + '…';

        const embed = new EmbedBuilder()
            .setTitle('2K Available Teams')
            .setColor(0x00b0f4)
            .setDescription(description);
        try {
            await interaction.editReply({ embeds: [embed] });
            log('reply sent', { open: openLines.length });
        } catch (err) {
            log('editReply error', { code: err?.code, message: err?.message });
            if (err?.code === 10008 && interaction.channel?.isTextBased()) {
                try {
                    await interaction.channel.send({ embeds: [embed] });
                    log('fallback send used');
                    return;
                } catch (e2) {
                    log('fallback send failed', { code: e2?.code, message: e2?.message });
                }
            }
            throw err;
        }
    } catch (err) {
        console.error('[availableteams] Error:', err);
        try {
            await interaction.editReply({ content: 'Error listing available teams.' });
        } catch (e) {
            // ignore further failures
        }
    }
}

export default { data, execute };
