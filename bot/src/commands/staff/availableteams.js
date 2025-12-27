import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import fs from 'fs';

export const data = new SlashCommandBuilder()
    .setName('availableteams')
    .setDescription('List all teams with no coach assigned (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    try {
        // Only allow staff
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const isStaff = member.permissions.has(PermissionFlagsBits.ManageChannels);
        if (!isStaff) {
            await interaction.editReply({ content: 'Only staff can use this command.' });
            return;
        }
        // Load coachRoleMap
        let coachRoleMap = {};
        try {
            coachRoleMap = JSON.parse(fs.readFileSync('./data/coachRoleMap.json', 'utf8'));
        } catch (err) {
            await interaction.editReply({ content: 'Could not load coachRoleMap.json.' });
            return;
        }
        // Force-fetch all members to ensure cache is up to date
        const guild = interaction.guild;
        await guild.members.fetch();
        let availableTeams = [];
        // Load standings
        let standings = {};
        try {
            standings = JSON.parse(fs.readFileSync('./data/standings.json', 'utf8'));
        } catch (err) {
            await interaction.editReply({ content: 'Could not load standings.json.' });
            return;
        }
        for (const [team, roleId] of Object.entries(coachRoleMap)) {
            const role = guild.roles.cache.get(roleId);
            // Only list if role exists and has zero members (unoccupied)
            if (role && role.members.size === 0) {
                let record = '';
                if (standings[team]) {
                    const { wins = 0, losses = 0 } = standings[team];
                    record = `(${wins}-${losses})`;
                } else {
                    record = '(0-0)';
                }
                availableTeams.push(`${team} ${record}`);
            }
        }
        // Build embed
        const embed = new EmbedBuilder()
            .setTitle('Available Teams')
            .setColor(0xFFD700)
            .setDescription(availableTeams.length > 0 ? availableTeams.join('\n') : 'All teams have a coach assigned.');
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        await interaction.editReply({ content: 'Error listing available teams.' });
    }
}

export default { data, execute };
