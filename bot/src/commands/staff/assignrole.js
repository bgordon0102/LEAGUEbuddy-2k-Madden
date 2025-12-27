// Role name to ID mapping for reliable assignment
const ROLE_ID_MAP = {
    "Commish": "1428100771513237654",
    "Schedule Tracker": "1428100777229942895",
    "Gameplay Mod": "1428100782246330398",
    // "Trade Committee": "1428100787225235526", // removed
    "Ghost Paradise": "1428119680572325929",
    "Hawks Coach": "1428100606622695485",
    "Celtics Coach": "1428100611395817604",
    "Nets Coach": "1428100616982368367",
    "Hornets Coach": "1428100621931778153",
    "Bulls Coach": "1428100628017840128",
    "Cavaliers Coach": "1428100633898127532",
    "Mavericks Coach": "1428100638486822913",
    "Nuggets Coach": "1428100644916428864",
    "Pistons Coach": "1428100650423550074",
    "Warriors Coach": "1428100655267971214",
    "Rockets Coach": "1428100664516415548",
    "Pacers Coach": "1428100669453242479",
    "Clippers Coach": "1428100674750644345",
    "Lakers Coach": "1428100680018559076",
    "Grizzlies Coach": "1428100684892344552",
    "Heat Coach": "1428100690479284246",
    "Bucks Coach": "1428100695416111165",
    "Timberwolves Coach": "1428100700688351303",
    "Pelicans Coach": "1428100705776046211",
    "Knicks Coach": "1428100710997954651",
    "Thunder Coach": "1428100717243138061",
    "Magic Coach": "1428100723077419008",
    "76ers Coach": "1428100728194470012",
    "Suns Coach": "1428100733416374475",
    "Trail Blazers Coach": "1428100738566979594",
    "Kings Coach": "1428100744992788651",
    "Spurs Coach": "1428100749966966784",
    "Raptors Coach": "1428100754585026767",
    "Jazz Coach": "1428100759936831639",
    "Wizards Coach": "1428100764877848787"
};
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const NBA_TEAMS = [
    'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons',
    'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves',
    'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards'
];

const STAFF_ROLES = ['Commish', 'Schedule Tracker', 'Gameplay Mod', 'Ghost Paradise'];

export const data = new SlashCommandBuilder()
    .setName('assignrole')
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
