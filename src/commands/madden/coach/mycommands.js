import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const data = new SlashCommandBuilder()
  .setName('madden-mycommands')
  .setDescription('Shows a list of Madden commands available to you.');

function isStaff(member) {
  try {
    const map = JSON.parse(fs.readFileSync(ROLE_MAP_PATH, 'utf8'));
    const commishIds = Object.entries(map || {})
      .filter(([key]) => key.toLowerCase().includes('commish'))
      .map(([, id]) => id);
    if (commishIds.length && member?.roles?.cache) {
      return member.roles.cache.some(r => commishIds.includes(r.id));
    }
  } catch {
    // ignore and fall back to name check
  }
  const fallbackNames = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];
  return member?.roles?.cache?.some(r => fallbackNames.includes(r.name)) ?? false;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const staffView = isStaff(interaction.member);

  const staffEmbed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle('🏈 Madden Staff Commands')
    .setDescription('Core staff tools (brief).')
    .addFields(
      { name: '/madden-mycommands', value: 'Show this menu' },
      { name: '/madden-activitycheck', value: 'Post activity check with countdown' },
      { name: '/madden-auth', value: 'Link EA account for league data' },
      { name: '/madden-set_league', value: 'Set/reset league for this server' },
      { name: '/madden-update', value: 'Pull latest data, refresh pins/messages' },
      { name: '/madden-leagues', value: 'List linked leagues' },
      { name: '/madden-assignteam', value: 'Assign a coach role to a user' },
      { name: '/madden-removeteam', value: 'Remove a coach role from a user' },
      { name: '/madden-availableteams', value: 'Show open teams (with pin auto-update)' },
      { name: '/madden-creategamethreads', value: 'Create weekly/playoff game threads' },
      { name: '/madden-deletegamethreads', value: 'Delete weekly/playoff game threads' },
      { name: '/madden-remindgame', value: 'Remind coaches in a game thread' },
      { name: '/madden-health', value: 'Bot health check' },
      { name: '/madden-retire', value: 'Detect newly retired players' },
      { name: '/madden-draftexport', value: 'Export full draft results JSON' }
    )
    .setFooter({ text: 'Staff access only' });

  const coachEmbed = new EmbedBuilder()
    .setColor(0x1e90ff)
    .setTitle('🏈 Madden Coach Commands')
    .setDescription('Everyday coach tools (brief).')
    .addFields(
      { name: '/madden-mycommands', value: 'Show this menu' },
      { name: '/madden-schedule [team]', value: 'View schedule (default your team)' },
      { name: '/madden-standings', value: 'View standings' },
      { name: '/madden-teams', value: 'List teams (with emojis)' },
      { name: '/madden-player name', value: 'View player card' },
      { name: '/madden-playersearch name', value: 'Search any player and view a card' },
      { name: '/madden-tradeblock add|remove', value: 'Manage your trade block' },
      { name: '/madden-streamlink', value: 'Post your streaming link to the channel' },
      { name: '/madden-scout', value: 'Scout draft prospects' },
      { name: '/madden-myscouts', value: 'View your scouted prospects' }
    )
    .setFooter({ text: 'Coach access only' });

  await interaction.editReply({ embeds: [staffView ? staffEmbed : coachEmbed] });
}

export default { data, execute };
