// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...
// ...existing code...

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';


const data = new SlashCommandBuilder()
    .setName('mycommands')
    .setDescription('Shows a list of commands available to you.');

async function execute(interaction) {
    const member = interaction.member;
    let responded = false;
    try {
        await interaction.deferReply({ ephemeral: true });
        // Staff role names
        const staffRoles = ['Admin', 'Commish', 'Schedule Tracker', 'Gameplay Mod'];
        const hasStaffRole = member.roles.cache.some(role => staffRoles.includes(role.name));
        let embed;
        if (hasStaffRole) {
            embed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('⭐ Staff Commands')
                .setDescription('Here are the commands available to Staff:')
                .addFields(
                    { name: '/mycommands ⭐', value: 'Shows this menu' },
                    { name: '/bigboard', value: 'View the big board' },
                    { name: '/advanceweek', value: 'Advance the league to the next week' },
                    { name: '/assignrole', value: 'Assign a coach role to a user' },
                    { name: '/clearmessages', value: 'Clear messages from a specified thread' },
                    { name: '/deletegamechannel', value: 'Delete a game thread' },
                    { name: '/generaterandomscores', value: 'Simulate and approve random scores for all games up to a given week' },
                    { name: '/ping', value: 'Ping the bot to check responsiveness' },
                    { name: '/remindgame', value: 'Send a reminder for a scheduled game' },
                    { name: '/resetnbaroles', value: 'Reset NBA coach roles for all teams' },
                    { name: '/resetscouting', value: 'Reset all scouting data' },
                    { name: '/runtestseason', value: 'Run a test season simulation' },
                    { name: '/schedule', value: 'Show a team’s NBA season schedule' },
                    { name: '/scout', value: 'Scout a player from the big board' },
                    { name: '/startseason', value: 'Start or reset the NBA season and all league data files' }
                )
                .setFooter({ text: 'Staff access only' });
        } else {
            embed = new EmbedBuilder()
                .setColor(0x1E90FF)
                .setTitle('⭐ Coach Commands')
                .setDescription('Here are the commands available to Coaches:')
                .addFields(
                    { name: '/mycommands ⭐', value: 'Shows this menu' },
                    { name: '/bigboard', value: 'View the big board' },
                    { name: '/schedule', value: 'Show a team’s NBA season schedule' },
                    { name: '/scout', value: 'Scout a player from the big board' }
                )
                .setFooter({ text: 'Coach access only' });
        }
        if (!responded) {
            responded = true;
            await interaction.editReply({ embeds: [embed] });
        }
    } catch (err) {
        console.error(err);
        if (!responded) {
            responded = true;
            await interaction.editReply({ content: 'Failed to show commands.' });
        }
    }
}

export default { data, execute };


