import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { DataManager } from '../../utils/dataManager.js';

const TOTAL_WEEKS = 14;
const TRADE_DEADLINE_WEEK = 8;

const data = new SlashCommandBuilder()
  .setName('2k-advancephase')
  .setDescription('Set the league phase to regular season, playoffs, or offseason (staff only).')
  .addStringOption(option =>
    option.setName('phase')
      .setDescription('Target phase')
      .setRequired(true)
      .addChoices(
        { name: 'Regular Season', value: 'regular' },
        { name: 'Playoffs', value: 'playoffs' },
        { name: 'Offseason', value: 'offseason' },
      ))
  .addIntegerOption(option =>
    option.setName('week')
      .setDescription('Optional week to set when switching back to regular season (default: 1)')
      .setMinValue(1)
      .setMaxValue(TOTAL_WEEKS)
      .setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    console.error('[advancephase] defer failed:', err);
    return;
  }

  const target = interaction.options.getString('phase');
  const weekArg = interaction.options.getInteger('week');
  const dataManager = new DataManager();
  const season = dataManager.readData('season') || { currentWeek: 1, seasonNo: 1, phase: 'regular' };

  if (target === 'regular') {
    season.phase = 'regular';
    season.currentWeek = weekArg || 1;
    season.tradeCutoffWeek = TRADE_DEADLINE_WEEK;
  } else if (target === 'playoffs') {
    season.phase = 'playoffs';
    // Set currentWeek to end-of-regular + 1 so week gates remain consistent
    season.currentWeek = (season.playoffStartWeek || TOTAL_WEEKS + 1);
  } else if (target === 'offseason') {
    season.phase = 'offseason';
    season.currentWeek = season.offseasonStartWeek || TOTAL_WEEKS + 3; // keep gates closed for reg/playoffs
  } else {
    await interaction.editReply({ content: 'Invalid phase.' });
    return;
  }

  const ok = dataManager.writeData('season', season);
  if (!ok) {
    await interaction.editReply({ content: 'Failed to update season data.' });
    return;
  }

  await interaction.editReply({
    content: `Phase set to **${season.phase}** (week ${season.currentWeek}). Trade deadline set to week ${season.tradeCutoffWeek || TRADE_DEADLINE_WEEK}.`,
  });
}

export default { data, execute };
