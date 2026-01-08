import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';

export const data = new SlashCommandBuilder()
    .setName('remindgame')
    .setDescription('Send a reminder to play the game in this thread (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
        // Only allow staff
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const isStaff = member.permissions.has(PermissionFlagsBits.ManageChannels);
        if (!isStaff) {
            await interaction.editReply({ content: 'Only staff can use this command.' });
            return;
        }
        // Get channel and coach roles
        const channel = interaction.channel;
        // Robustly parse channel name for team names (handles Cavaliers-vs-Kings-w1, etc)
        const threadMatch = channel.name.match(/([a-zA-Z ]+)-vs-([a-zA-Z ]+)/);
        if (!threadMatch) {
            await interaction.editReply({ content: 'This command can only be used in a game thread.' });
            return;
        }
        // Normalize team names (capitalize, trim, handle abbreviations)
        function normalizeTeamName(name) {
            name = name.replace(/-/g, ' ').replace(/\bw\d+$/i, '').trim();
            // Special handling for Clippers
            if (/^clippers$/i.test(name) || /^lac$/i.test(name)) return 'Los Angeles Clippers';
            // Map abbreviations to full names
            const abbrToFull = {
                ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', CHA: 'Charlotte Hornets', CHI: 'Chicago Bulls', CLE: 'Cleveland Cavaliers', DAL: 'Dallas Mavericks', DEN: 'Denver Nuggets', DET: 'Detroit Pistons', GSW: 'Golden State Warriors', HOU: 'Houston Rockets', IND: 'Indiana Pacers', LAC: 'Los Angeles Clippers', LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies', MIA: 'Miami Heat', MIL: 'Milwaukee Bucks', MIN: 'Minnesota Timberwolves', NOP: 'New Orleans Pelicans', NYK: 'New York Knicks', OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns', POR: 'Portland Trail Blazers', SAC: 'Sacramento Kings', SAS: 'San Antonio Spurs', TOR: 'Toronto Raptors', UTA: 'Utah Jazz', WAS: 'Washington Wizards'
            };
            let upper = name.toUpperCase();
            if (abbrToFull[upper]) return abbrToFull[upper];
            // Try to match by partial name
            for (const full of Object.values(abbrToFull)) {
                if (full.toUpperCase().includes(upper)) return full;
            }
            // Capitalize each word
            return name.replace(/\b\w/g, c => c.toUpperCase());
        }
        const team1Raw = threadMatch[1].trim();
        const team2Raw = threadMatch[2].trim();
        const team1Full = normalizeTeamName(team1Raw);
        const team2Full = normalizeTeamName(team2Raw);
        let coachRoleMap = {};
        try {
            const guildId = process.env.DISCORD_GUILD_ID;
            let coachRoleMapFile = './data/coachRoleMap.json';
            if (guildId === '1415452215044473036') {
                coachRoleMapFile = './data/coachRoleMap.main.json';
            } else if (guildId === '1407111281147641976') {
                coachRoleMapFile = './data/coachRoleMap.dev.json';
            }
            coachRoleMap = JSON.parse(fs.readFileSync(coachRoleMapFile, 'utf8'));
        } catch { }
        const team1RoleId = coachRoleMap[team1Full];
        const team2RoleId = coachRoleMap[team2Full];
        // Calculate deadline (24 hours from channel creation)
        const deadline = Math.floor(channel.createdTimestamp / 1000) + 24 * 3600;
        let content = '';
        if (team1RoleId && team2RoleId) {
            content += `Reminder: <@&${team1RoleId}> <@&${team2RoleId}> please play your game!\n`;
        } else if (team1RoleId) {
            content += `Reminder: <@&${team1RoleId}> please play your game!\n`;
            console.log(`[remindgame] Missing team2RoleId for ${team2Full}`);
        } else if (team2RoleId) {
            content += `Reminder: <@&${team2RoleId}> please play your game!\n`;
            console.log(`[remindgame] Missing team1RoleId for ${team1Full}`);
        } else {
            content += `Reminder: Coaches, please play your game!\n`;
            console.log(`[remindgame] Missing both coach role IDs for ${team1Full} and ${team2Full}`);
        }
        content += `:alarm_clock: **Score must be submitted within <t:${deadline}:R> (<t:${deadline}:f>)**`;
        // Send a visible message tagging coaches in the channel
        await channel.send({ content });
        await interaction.editReply({ content: 'Reminder sent to channel.' });
    } catch (err) {
        console.error('Error in remindgame:', err);
        await interaction.editReply({ content: 'Error sending reminder.' });
    }
}

export default { data, execute };
