import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot, getDefaultLeagueId } from '../../../madden/madden_data.js';

const data = new SlashCommandBuilder()
  .setName('madden-standings')
  .setDescription('Show league standings from the last /madden-sync snapshot.')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID (defaults to most recent synced league)')
      .setRequired(false)
  );

function formatStanding(team) {
  const name = team?.teamName || team?.teamNickname || `Team ${team?.teamId}`;
  const w = team?.wins ?? 0;
  const l = team?.losses ?? 0;
  const t = team?.ties ?? 0;
  return `${name} — ${w}-${l}${t ? `-${t}` : ''}`;
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || getDefaultLeagueId();
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!leagueId) throw new Error('No league_id provided and no synced leagues found.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const standings = snapshot?.standings?.teamStandingInfoList || [];
    const sorted = standings
      .slice()
      .sort((a, b) => (b?.wins ?? 0) - (a?.wins ?? 0) || (a?.losses ?? 0) - (b?.losses ?? 0))
      .slice(0, 24);
    const lines = sorted.map(formatStanding);
    const embed = new EmbedBuilder()
      .setTitle(`Madden Standings — League ${leagueId}`)
      .setDescription(lines.join('\n') || 'No standings in snapshot')
      .setColor(0x00b0f4);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load standings: ${err.message}` });
  }
}

export default { data, execute };
