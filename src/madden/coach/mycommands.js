import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { coachCommandDescription, coachPanelIntro, coachVoiceFooter, coachVoiceTitle } from '../../shared/madden_coach_voice.js';

const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const data = new SlashCommandBuilder()
  .setName('madden-mycommands')
  .setDescription(coachCommandDescription('mycommands'));

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
    .setTitle(coachVoiceTitle('staffCommands', 'Madden Staff Commands'))
    .setDescription(coachPanelIntro('staffCommands'))
    .addFields(
      { name: '/madden-mycommands', value: 'Show this menu' },
      { name: '/madden-set-league', value: 'Set or reset the active Madden league' },
      { name: '/madden-weeklyupdate', value: 'Refresh league data, pins, logs, and weekly content' },
      { name: '/madden-auth', value: 'Link EA account for league data' },
      { name: '/madden-activitycheck', value: 'Post activity check with countdown' },
      { name: '/madden-leagues', value: 'List linked leagues' },
      { name: '/madden-assignrole', value: 'Assign a Madden coach role' },
      { name: '/madden-removerole', value: 'Remove a Madden coach role' },
      { name: '/madden-availableteams', value: 'Show and refresh the available teams board' },
      { name: '/madden-promo', value: 'Post the recruiting / open teams promo' },
      { name: '/madden-creategamethreads', value: 'Create weekly/playoff game threads' },
      { name: '/madden-deletegamethreads', value: 'Delete weekly/playoff game threads' },
      { name: '/madden-awards', value: 'Run or post weekly awards' },
      { name: '/madden-draftexport', value: 'Export the draft results file' }
    )
    .setFooter({ text: coachVoiceFooter('staffOnly', 'Testing and maintenance-only commands are hidden from this menu.') });

  const coachEmbed = new EmbedBuilder()
    .setColor(0x1e90ff)
    .setTitle(coachVoiceTitle('coachCommands', 'Madden Coach Commands'))
    .setDescription(coachPanelIntro('coachCommands'))
    .addFields(
      { name: '/madden-mycommands', value: 'Show this menu' },
      { name: '/madden-schedule', value: 'View your schedule' },
      { name: '/madden-roster [team]', value: 'View a team roster' },
      { name: '/madden-playersearch name', value: 'Search any player and view a card' },
      { name: '/madden-franchisehub', value: 'Private hub for your team state, accountability, and front-office direction' },
      { name: '/madden-gamestrategy', value: 'Private matchup strategy for your current opponent' },
      { name: '/madden-draftprimer [team]', value: 'Get a strategic draft primer' },
      { name: '/madden-mockdraft', value: 'Generate the current mock draft' },
      { name: '/madden-bigboard', value: 'View the active draft class big board' },
      { name: '/madden-tradeblock add|remove', value: 'Manage your trade block' },
      { name: '/madden-tradevalue', value: 'Check player trade values' },
      { name: '/madden-pickvalue', value: 'Check pick trade values' },
      { name: '/madden-streamlink', value: 'Post your streaming link to the channel' },
      { name: '/madden-scout', value: 'Scout draft prospects' },
      { name: '/madden-myscouts', value: 'View and move your scouting board' },
      { name: '/madden-recruiting', value: 'View recruiting data' }
    )
    .setFooter({ text: coachVoiceFooter('coachOnly', 'Coach access only') });

  await interaction.editReply({ embeds: [staffView ? staffEmbed : coachEmbed] });
}

export default { data, execute };
