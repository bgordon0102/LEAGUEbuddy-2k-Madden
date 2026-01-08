import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { getMessageForWeek } from '../../madden/madden_utils.js';

const dataDir = path.join(process.cwd(), 'src', 'data', 'madden');
const leagueDir = path.join(dataDir, 'leagues');

const data = new SlashCommandBuilder()
  .setName('madden-import')
  .setDescription('Import Madden league data from a JSON file (Snallabot-style export).')
  .addStringOption(option =>
    option.setName('league_id')
      .setDescription('League ID (used as filename)')
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('file')
      .setDescription('Path to JSON file relative to src/data/madden (e.g., imports/league123.json)')
      .setRequired(true)
  );

async function ensureDirs() {
  await fs.mkdir(leagueDir, { recursive: true });
}

async function loadImportFile(relPath) {
  const fullPath = path.join(dataDir, relPath);
  const content = await fs.readFile(fullPath, 'utf-8');
  return JSON.parse(content);
}

function summarize(importData) {
  const teams = importData?.teams?.length || 0;
  const schedule = importData?.schedule?.length || 0;
  const standings = importData?.standings?.length || 0;
  const players = importData?.players?.length || 0;
  let weekInfo = '';
  const week = importData?.currentWeek ?? importData?.week;
  if (week) {
    try {
      weekInfo = ` (${getMessageForWeek(Number(week))})`;
    } catch {
      weekInfo = ` (week ${week})`;
    }
  }
  return { teams, schedule, standings, players, weekInfo };
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id');
  const relFile = interaction.options.getString('file');

  await interaction.deferReply({ ephemeral: true });

  try {
    await ensureDirs();
    const importData = await loadImportFile(relFile);

    // Basic required fields check based on Snallabot export shape
    if (!importData.teams || !importData.schedule || !importData.standings) {
      throw new Error('Import JSON missing required keys: teams, schedule, standings');
    }

    const outPath = path.join(leagueDir, `${leagueId}.json`);
    await fs.writeFile(outPath, JSON.stringify(importData, null, 2), 'utf-8');

    const summary = summarize(importData);
    await interaction.editReply({
      content: `Imported league ${leagueId} to ${outPath}\nTeams: ${summary.teams}, Standings: ${summary.standings}, Games: ${summary.schedule}, Players: ${summary.players}${summary.weekInfo}`
    });
  } catch (err) {
    console.error('❌ Madden import failed:', err);
    await interaction.editReply({ content: `Import failed: ${err.message}` });
  }
}

export default { data, execute };
