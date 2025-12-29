import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');

const data = new SlashCommandBuilder()
  .setName('mycommands')
  .setDescription('Shows a list of commands available to you.');

function isStaff(member) {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    const staffRoleIds = Object.values(map || {});
    if (staffRoleIds.length && member?.roles?.cache) {
      return member.roles.cache.some(r => staffRoleIds.includes(r.id));
    }
  } catch {
    // fallback to name check
  }
  const fallbackNames = ['Admin', 'Commish', 'Schedule Tracker', 'Gameplay Mod', 'Paradise Commish'];
  return member?.roles?.cache?.some(r => fallbackNames.includes(r.name)) ?? false;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const staffView = isStaff(interaction.member);

  const staffEmbed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('⭐ Staff Commands')
    .setDescription('Core staff tools (brief).')
    .addFields(
      { name: '/mycommands', value: 'Show this menu' },
      { name: '/startseason', value: 'Start/reset league data (use /advanceseason for next year)' },
      { name: '/advanceseason <seasonno>', value: 'Promote current rosters/picks, start next season' },
      { name: '/advanceweek', value: 'Advance the league week and update schedule state' },
      { name: '/mergedraft [classno]', value: 'Merge draft results into rosters (season # default)' },
      { name: '/playoffthread', value: 'Create a playoff matchup thread' },
      { name: '/clearplayoffthreads', value: 'Remove playoff threads' },
      { name: '/assignrole', value: 'Assign a coach role to a user' },
      { name: '/availableteams', value: 'List open teams (and roles)' },
      { name: '/clearmessages', value: 'Bulk clear messages in a thread/channel' },
      { name: '/deletegamechannel', value: 'Delete a game thread' },
      { name: '/remindgame', value: 'Send a scheduled game reminder' },
      { name: '/removeretires', value: 'Remove retirees (OCR or autocomplete)' },
      { name: '/resetnbaroles', value: 'Reset NBA coach roles' },
      { name: '/resetscouting', value: 'Reset all scouting data' },
      { name: '/ping', value: 'Bot health check' }
    )
    .setFooter({ text: 'Staff access only' });

  const coachEmbed = new EmbedBuilder()
    .setColor(0x1E90FF)
    .setTitle('⭐ Coach Commands')
    .setDescription('Everyday coach tools (brief).')
    .addFields(
      { name: '/mycommands', value: 'Show this menu' },
      { name: '/bigboard', value: 'View the draft big board' },
      { name: '/player name', value: 'View player card (team/FA, pos, OVR, age, image)' },
      { name: '/roster [team]', value: 'Show a team roster (default yours)' },
      { name: '/schedule [team]', value: 'Show schedule (default yours)' },
      { name: '/scout name', value: 'Scout a player from the big board' },
      { name: '/tradeblock add|remove', value: 'Manage your trade block' }
    )
    .setFooter({ text: 'Coach access only' });

  await interaction.editReply({ embeds: [staffView ? staffEmbed : coachEmbed] });
}

export default { data, execute };
