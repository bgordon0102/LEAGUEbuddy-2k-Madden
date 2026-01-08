import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { setGuildLeague } from '../../../madden/madden_config.js';

const data = new SlashCommandBuilder()
  .setName('madden-set-league')
  .setDescription('Set the default Madden league for this server (used by other Madden commands).')
  .addStringOption(opt =>
    opt.setName('league_id')
      .setDescription('League ID to set as default')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id');
  await interaction.deferReply({ ephemeral: true });
  try {
    if (!interaction.guildId) throw new Error('This command must be used in a guild.');
    setGuildLeague(interaction.guildId, leagueId);
    const embed = new EmbedBuilder()
      .setTitle('Madden League Saved')
      .setDescription(`Default league for this server set to **${leagueId}**.\nOther Madden commands will use this automatically.`)
      .setColor(0x57f287);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    await interaction.editReply({ content: `Failed to set league: ${err.message}` });
  }
}

export default { data, execute };
