import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');

const data = new SlashCommandBuilder()
  .setName('2k-mycommands')
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
      { name: '/2k-mycommands', value: 'Show this menu' },
      { name: '/2k-startleague', value: 'Start/reset league data (use /2k-advanceseason for next year)' },
      { name: '/2k-advanceseason <seasonno>', value: 'Promote current rosters/picks, start next season' },
      { name: '/2k-advanceweek', value: 'Advance the league week and update schedule state' },
      { name: '/2k-mergedraft [classno]', value: 'Merge draft results into rosters (season # default)' },
      { name: '/2k-playoffthread', value: 'Create a playoff matchup thread' },
      { name: '/2k-clearplayoffthreads', value: 'Remove playoff threads' },
      { name: '/2k-assignrole', value: 'Assign a coach role to a user' },
      { name: '/2k-availableteams', value: 'List open teams (and roles)' },
      { name: '/2k-recruiting', value: 'View ESPN-style Top 50 recruits (current phase)' },
      { name: '/2k-clearmessages', value: 'Bulk clear messages in a thread/channel' },
      { name: '/2k-deletegamechannel', value: 'Delete a game thread' },
      { name: '/2k-remindgame', value: 'Send a scheduled game reminder' },
      { name: '/2k-removeretires', value: 'Remove retirees (OCR or autocomplete)' },
      { name: '/2k-resetnbaroles', value: 'Reset NBA coach roles' },
      { name: '/2k-resetscouting', value: 'Reset all scouting data' },
      { name: '/2k-ping', value: 'Bot health check' }
    )
    .setFooter({ text: 'Staff access only' });

  const coachEmbed = new EmbedBuilder()
    .setColor(0x1E90FF)
    .setTitle('⭐ Coach Commands')
    .setDescription('Everyday coach tools (brief).')
    .addFields(
      { name: '/2k-mycommands', value: 'Show this menu' },
      { name: '/2k-bigboard', value: 'View the draft big board' },
      { name: '/2k-player name', value: 'View player card (team/FA, pos, OVR, age, image)' },
      { name: '/2k-roster [team]', value: 'Show a team roster (default yours)' },
      { name: '/2k-schedule [team]', value: 'Show schedule (default yours)' },
      { name: '/2k-scout name', value: 'Scout a player from the big board' },
      { name: '/2k-tradeblock add|remove', value: 'Manage your trade block' },
      { name: '/2k-recruiting', value: 'View ESPN-style Top 50 recruits (current phase)' }
    )
    .setFooter({ text: 'Coach access only' });

  await interaction.editReply({ embeds: [staffView ? staffEmbed : coachEmbed] });
}

export default { data, execute };
