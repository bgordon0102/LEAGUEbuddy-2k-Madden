import { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-export')
  .setDescription('Send the last /madden-sync snapshot JSON for a league.')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  );

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const filePath = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
    const buf = fs.readFileSync(filePath);
    const attachment = new AttachmentBuilder(buf, { name: `${leagueId}.json` });
    const embed = new EmbedBuilder()
      .setTitle('Madden Export')
      .setDescription(`Latest snapshot for league ${leagueId}`)
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed], files: [attachment] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to export: ${err.message}` });
  }
}

export default { data, execute };
