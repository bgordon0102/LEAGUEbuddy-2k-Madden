import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

const PLAYOFF_CHANNEL_ID = '1455100196315861126';
const SERIES_STATE_PATH = path.join(process.cwd(), 'data', 'playoff_series.json');

function loadSeriesState() {
  try { return JSON.parse(fs.readFileSync(SERIES_STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveSeriesState(state) {
  try { fs.writeFileSync(SERIES_STATE_PATH, JSON.stringify(state ?? {}, null, 2)); } catch (e) { console.error('[playoffthread] Failed to save series state:', e); }
}

function getSeriesConfig(round) {
  switch (round) {
    case 'Play In Round 1':
    case 'Play In Round 2':
      return { games: 1, wins: 1 };
    case 'First Round':
      return { games: 3, wins: 2 };
    case 'Conference Semifinals':
      return { games: 5, wins: 3 };
    case 'Conference Finals':
      return { games: 5, wins: 3 };
    case 'NBA Finals':
      return { games: 7, wins: 4 };
    default:
      return { games: 3, wins: 2 };
  }
}

export const data = new SlashCommandBuilder()
  .setName('playoffthread')
  .setDescription('Create a playoff coordination thread for two teams')
  .addStringOption(option =>
    option.setName('team1')
      .setDescription('First team')
      .setRequired(true)
      .setAutocomplete(true))
  .addStringOption(option =>
    option.setName('team2')
      .setDescription('Second team')
      .setRequired(true)
      .setAutocomplete(true))
  .addStringOption(option =>
    option.setName('round')
      .setDescription('Playoff round')
      .setRequired(true)
      .addChoices(
        { name: 'Play In Round 1', value: 'Play In Round 1' },
        { name: 'Play In Round 2', value: 'Play In Round 2' },
        { name: 'First Round', value: 'First Round' },
        { name: 'Conference Semifinals', value: 'Conference Semifinals' },
        { name: 'Conference Finals', value: 'Conference Finals' },
        { name: 'NBA Finals', value: 'NBA Finals' },
      ))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const team1 = interaction.options.getString('team1');
  const team2 = interaction.options.getString('team2');
  const round = interaction.options.getString('round');
  const seriesCfg = getSeriesConfig(round);

  try {
    const channel = await interaction.guild.channels.fetch(PLAYOFF_CHANNEL_ID);
    if (!channel) {
      await interaction.editReply({ content: 'Playoff channel not found.' });
      return;
    }

    const threadName = `${round.replace(/\\s+/g, '-')}-${team1}-vs-${team2}`.toLowerCase();
    const thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080, // 7 days
      reason: `Playoff matchup: ${team1} vs ${team2}`,
    });

    // Coach mentions from coachRoleMap.json
    let coachRoleMap = {};
    try {
      coachRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
    } catch (err) {
      console.error('[playoffthread] Failed to read coachRoleMap.json:', err);
    }
    const mentions = [];
    if (coachRoleMap[team1]) mentions.push(`<@&${coachRoleMap[team1]}>`);
    if (coachRoleMap[team2]) mentions.push(`<@&${coachRoleMap[team2]}>`);
    const coachMentions = mentions.join(' & ') || `${team1} Coach & ${team2} Coach`;

    const welcomeMsg = `Welcome ${coachMentions}!\nRound: ${round}\nSeries: Best of ${seriesCfg.games} (first to ${seriesCfg.wins}).\nUse this thread to coordinate your matchup. Report each game result using the buttons below.`;
    const components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: `Game 1: ${team1}`,
            custom_id: `playoff_game_${thread.id}_1_a`,
            disabled: false,
          },
          {
            type: 2,
            style: 1,
            label: `Game 1: ${team2}`,
            custom_id: `playoff_game_${thread.id}_1_b`,
            disabled: false,
          },
        ],
      },
    ];
    if (round === 'NBA Finals') {
      components.push({
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: 'Set Champion (Staff)',
            custom_id: `set_champion_${thread.id}`,
          }
        ]
      });
    }
    const sentMsg = await thread.send({ content: welcomeMsg, components });
    await sentMsg.pin().catch(() => {});

    // Save initial series state
    const state = loadSeriesState();
    state[thread.id] = {
      team1,
      team2,
      round,
      games: seriesCfg.games,
      winsNeeded: seriesCfg.wins,
      scoreA: 0,
      scoreB: 0,
      decided: []
    };
    saveSeriesState(state);

    await interaction.editReply({ content: `Playoff thread created: ${thread.toString()}` });
  } catch (err) {
    console.error('[playoffthread] Failed to create thread:', err);
    await interaction.editReply({ content: 'Failed to create playoff thread. Check logs.' });
  }
}

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const fallbackTeams = [
    'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
    'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors',
    'Houston Rockets', 'Indiana Pacers', 'Los Angeles Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies',
    'Miami Heat', 'Milwaukee Bucks', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'New York Knicks',
    'Oklahoma City Thunder', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns', 'Portland Trail Blazers',
    'Sacramento Kings', 'San Antonio Spurs', 'Toronto Raptors', 'Utah Jazz', 'Washington Wizards'
  ];
  let coachTeams = [];
  try {
    const coachRoleMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'coachRoleMap.json'), 'utf8'));
    coachTeams = Object.keys(coachRoleMap || {});
  } catch (err) {
    console.error('[playoffthread autocomplete] Failed to read coachRoleMap.json:', err);
  }
  // Combine and de-dupe
  const combined = Array.from(new Set([...coachTeams, ...fallbackTeams]));
  const filtered = combined
    .filter(name => name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(name => ({ name, value: name }));
  await interaction.respond(filtered);
}

export default { data, execute, autocomplete };
