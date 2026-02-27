import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const SCOUT_PATH = path.join(process.cwd(), 'data', 'scout_points.json');

function loadScouts() {
  try {
    if (!fs.existsSync(SCOUT_PATH)) return {};
    return JSON.parse(fs.readFileSync(SCOUT_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

export const data = new SlashCommandBuilder()
  .setName('2k-myscouts')
  .setDescription('View the players you have scouted in 2K');

export async function execute(interaction) {
  const scouts = loadScouts();
  const userData = scouts[interaction.user.id];
  const players = Object.keys(userData?.playersScouted || {});

  if (!players.length) {
    await interaction.reply({ content: 'You have no recorded scouting entries yet.', ephemeral: true });
    return;
  }

  const lines = players.map((p, idx) => `${idx + 1}. ${p}`);
  const embed = new EmbedBuilder()
    .setTitle('Your 2K Scouting')
    .setDescription(lines.join('\n').slice(0, 4000)) // stay under embed limit
    .setColor(0x1f8b4c)
    .setFooter({ text: `Total scouted: ${players.length}` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export default { data, execute };
