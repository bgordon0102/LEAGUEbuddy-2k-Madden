import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const NBA_TEAMS = [
  'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons',
  'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves',
  'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs', 'Raptors', 'Jazz', 'Wizards'
];

const STAFF_ROLES = ['Commish', 'Schedule Tracker', 'Gameplay Mod'];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const data = new SlashCommandBuilder()
  .setName('resetnbaroles')
  .setDescription('Delete existing NBA roles and recreate them properly.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const guild = interaction.guild;
    const allRoleNames = [...NBA_TEAMS.map(t => `${t} Coach`), ...STAFF_ROLES];
    let deletedCount = 0;
    for (const roleName of allRoleNames) {
      const existingRoles = guild.roles.cache.filter(r => r.name === roleName);
      for (const role of existingRoles.values()) {
        try {
          await role.delete('Resetting NBA roles');
          deletedCount++;
        } catch (err) {
          console.error(`Delete failed: ${role.name} - ${err.message}`);
        }
      }
    }
    await interaction.followUp({ content: `Deleted ${deletedCount} roles. Creating ${allRoleNames.length} new ones...`, ephemeral: true });
    let createdCount = 0;
    for (const roleName of allRoleNames) {
      try {
        await guild.roles.create({
          name: roleName,
          mentionable: true,
          reason: 'NBA role creation'
        });
        createdCount++;
      } catch (err) {
        console.error(`Create failed: ${roleName} - ${err.message}`);
      }
      if (createdCount % 5 === 0) {
        await interaction.followUp({
          content: `Progress: ${createdCount}/${allRoleNames.length} roles created...`, ephemeral: true
        });
      }
      await delay(1000);
    }
    await interaction.editReply({ content: `✅ All roles reset and created!`, ephemeral: true });
  } catch (err) {
    console.error('Error in resetnbaroles:', err);
    await interaction.editReply({ content: 'Error resetting NBA roles.' });
  }
}

export { data, execute };
export default { data, execute };