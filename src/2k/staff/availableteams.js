import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const cleanTeamName = (name) => (name || '').replace(/\s+Coach$/i, '');

export const data = new SlashCommandBuilder()
    .setName('2k-availableteams')
    .setDescription('List all teams with no coach assigned (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    try {
        // Only allow staff (role-based check with fallback to ManageChannels)
        const member = await interaction.guild.members.fetch(interaction.user.id);
        let isStaff = member.permissions.has(PermissionFlagsBits.ManageChannels);
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
            coachRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/coachRoleMap.json'), 'utf8'));
        } catch (err) {
            await interaction.editReply({ content: 'Could not load coachRoleMap.json.' });
            return;
        }

        const guild = interaction.guild;
        let availableTeams = [];
        for (const [team, roleId] of Object.entries(coachRoleMap)) {
            let assigned = false;
            if (roleId) {
                const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
                const count = role?.members ? role.members.size : 0;
                assigned = count > 0;
            }
            if (assigned) continue;
            availableTeams.push(cleanTeamName(team));
        }
        // Build embed
        const embed = new EmbedBuilder()
            .setTitle('Available Teams')
            .setColor(0xFFD700)
            .setDescription(availableTeams.length > 0 ? availableTeams.join('\n') : 'All teams have a coach assigned.');
        await interaction.editReply({ embeds: [embed] }).catch(async err => {
            if (err?.code === 10008 && interaction.channel?.isTextBased()) {
                // Interaction message vanished; fallback with a normal message
                await interaction.channel.send({ embeds: [embed] });
                return;
            }
            throw err;
        });
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
