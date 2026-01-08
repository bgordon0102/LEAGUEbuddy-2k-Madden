import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';

const SCOUTING_FILE = './data/scouting.json';


function writeJSON(file, data) {
  try {
    if (typeof data === 'undefined') {
      console.error(`[writeJSON] Tried to write undefined data to ${file}`);
      return;
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[writeJSON] Failed to write to ${file}:`, err);
  }
}

function safeReadJSON(file, fallback) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (!data) throw new Error('Empty file');
    return JSON.parse(data);
  } catch {
    console.warn(`[resetscouting] File ${file} missing or invalid, using fallback.`);
    writeJSON(file, fallback);
    return fallback;
  }
}

export const data = new SlashCommandBuilder()
  .setName('resetscouting')
  .setDescription('Reset all coaches weekly scouting points and info.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    // Reset scouting.json (legacy or other use)
    const scoutingData = safeReadJSON(SCOUTING_FILE, {});
    for (const coachId in scoutingData) {
      if (scoutingData[coachId]) {
        scoutingData[coachId].weeklyPoints = 40;
        scoutingData[coachId].weekScoutedPlayers = {};
      }
    }
    writeJSON(SCOUTING_FILE, scoutingData);

    // Reset scout_points.json (actual scouted info)
    const scoutPointsPath = './data/scout_points.json';
    let scoutPointsData = safeReadJSON(scoutPointsPath, {});
    for (const coachId in scoutPointsData) {
      if (scoutPointsData[coachId]) {
        scoutPointsData[coachId].playersScouted = {};
        scoutPointsData[coachId].weeklyPoints = {};
      }
    }
    writeJSON(scoutPointsPath, scoutPointsData);

    await interaction.editReply({ content: 'All coaches weekly scouting points and scouted info have been reset.' });
  } catch (err) {
    console.error('Error in resetscouting:', err);
    await interaction.editReply({ content: 'Error resetting scouting data.' });
  }
}

export default { data, execute };
