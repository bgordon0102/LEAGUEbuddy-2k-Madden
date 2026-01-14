// Role name to ID mapping for reliable assignment
const ROLE_ID_MAP = {
    "Ghost Paradise": "1460733464721490108",
    "Ghost Paradise Commish": "1460734128935665817",
    "Ghost Paradise Co-Commish": "1460734222238220326",
    "Ghost Paradise Trade Committee": "1460734289015603355",
    "76ers Coach": "1460734581325172807",
    "Bucks Coach": "1460734654901653525",
    "Bulls Coach": "1460734780600619193",
    "Cavaliers Coach": "1460734885667934373",
    "Celtics Coach": "1460734967934877902",
    "Clippers Coach": "1460735025455829225",
    "Grizzlies Coach": "1460735084566155555",
    "Hawks Coach": "1460735211137532059",
    "Heat Coach": "1460735288174313534",
    "Hornets Coach": "1460735355568525413",
    "Jazz Coach": "1460735407531626791",
    "Kings Coach": "1460735481128947823",
    "Knicks Coach": "1460735531271848180",
    "Lakers Coach": "1460735640835719382",
    "Magic Coach": "1460735694761754698",
    "Mavericks Coach": "1460735750319378585",
    "Nets Coach": "1460735822742425732",
    "Nuggets Coach": "1460735894276542484",
    "Pacers Coach": "1460735962719191183",
    "Pelicans Coach": "1460736030029385790",
    "Pistons Coach": "1460736087499604180",
    "Raptors Coach": "1460736152788144398",
    "Rockets Coach": "1460736215178285209",
    "Spurs Coach": "1460736265682026779",
    "Suns Coach": "1460736336150528094",
    "Thunder Coach": "1460736393465696300",
    "Timberwolves Coach": "1460736451473051739",
    "Trail Blazers Coach": "1460736507206697081",
    "Warriors Coach": "1460736566103244808",
    "Wizards Coach": "1460736622390935562"
};
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { updateAvailable2KTeamsPin } from '../../../2k/available_teams.js';

const NBA_TEAMS = [
    'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons',
    'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves',
    'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards'
];

const STAFF_ROLES = ['Commish', 'Schedule Tracker', 'Gameplay Mod', 'Ghost Paradise'];

export const data = new SlashCommandBuilder()
    .setName('2k-assignrole')
    .setDescription('Assign up to two roles to a user quickly.')
    .addUserOption(option =>
        option.setName('user')
            .setDescription('The user to assign the role to')
            .setRequired(true))
    .addStringOption(option =>
        option.setName('role1')
            .setDescription('The first role to assign')
            .setRequired(true)
            .setAutocomplete(true))
    .addStringOption(option =>
        option.setName('role2')
            .setDescription('The second role to assign (optional)')
            .setRequired(false)
            .setAutocomplete(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
    if (!interaction.isChatInputCommand()) {
        console.warn('assignrole execute called for non-chat input interaction. Skipping deferReply.');
        return;
    }
    let replyFailed = false;
    let replyMethod = async (msg, forceSuccess = false) => {
        let finalMsg = msg;
        if (forceSuccess) finalMsg = '✅ Success! ' + (msg || 'Role(s) assigned.');
        if (!replyFailed) {
            try {
                await interaction.editReply({ content: finalMsg });
            } catch (e) {
                replyFailed = true;
            }
        }
        if (replyFailed) {
            try {
                await interaction.followUp({ content: finalMsg, ephemeral: true });
            } catch (e) {
                console.log(`[assignrole] Could not send follow-up for interaction ${interaction.id}`);
            }
        }
    };
    try {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.deferReply({ ephemeral: true });
        }
    } catch (err) {
        console.error('Error deferring reply:', err);
        replyFailed = true;
    }
    const user = interaction.options.getUser('user');
    const roleName1 = interaction.options.getString('role1');
    const roleName2 = interaction.options.getString('role2');
    const member = interaction.guild.members.cache.get(user.id);
    if (!member) {
        await replyMethod('User not found in this server.');
        return;
    }
    // Use role ID mapping for assignment
    const roleId1 = ROLE_ID_MAP[roleName1];
    const role1 = roleId1 ? interaction.guild.roles.cache.get(roleId1) : null;
    if (!role1) {
        await replyMethod(`Role "${roleName1}" not found.`);
        return;
    }
    let role2 = null;
    if (roleName2) {
        const roleId2 = ROLE_ID_MAP[roleName2];
        role2 = roleId2 ? interaction.guild.roles.cache.get(roleId2) : null;
        if (!role2) {
            await replyMethod(`Role "${roleName2}" not found.`);
            return;
        }
    }
    try {
        await member.roles.add(role1);
        let msg = `Assigned role "${role1.name}" to ${user.tag}.`;
        if (role2) {
            await member.roles.add(role2);
            msg = `Assigned roles "${role1.name}" and "${role2.name}" to ${user.tag}.`;
        }
        await replyMethod(msg, true);
        // Update the available teams pin after assignment
        try {
            await updateAvailable2KTeamsPin(interaction.client, interaction.guildId, { allowCreate: true });
        } catch (pinErr) {
            console.error('[2k-assignrole] Failed to update available teams pin:', pinErr);
        }
    } catch (err) {
        console.error('Error assigning role:', err);
        await replyMethod('Error assigning role. Check bot permissions.');
    }
}

export async function autocomplete(interaction) {
    if (!interaction.isAutocomplete()) return;
    try {
        const focusedValue = interaction.options.getFocused();
        // Create list of all available roles
        const allRoles = [
            ...NBA_TEAMS.map(team => `${team} Coach`),
            ...STAFF_ROLES
        ];
        // Filter roles based on what user typed
        const filtered = allRoles.filter(role =>
            role.toLowerCase().includes(focusedValue.toLowerCase())
        );
        // Return up to 25 choices (Discord limit)
        console.log(`[assignrole autocomplete] Responding with ${filtered.slice(0, 25).length} choices for value: '${focusedValue}'`);
        await interaction.respond(
            filtered.slice(0, 25).map(role => ({ name: role, value: role }))
        );
    } catch (err) {
        // Only log error, do not attempt to respond again
        console.error('Autocomplete error in /assignrole:', err?.message || err);
    }
}

export default { data, execute, autocomplete };
