import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { setGuildLeague } from '../../../madden/madden_config.js';
import { saveLeague as saveLeagueDb } from '../../../madden/madden_db.js';
import fs from 'fs';
import path from 'path';

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

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
    // Persist to DB as well
    saveLeagueDb(leagueId);
    // Ensure runtime env (for auto-sync) points to this league going forward
    process.env.MADDEN_LEAGUE_ID = `${leagueId}`;
    process.env.MADDEN_AUTO_SYNC_LEAGUE_ID = `${leagueId}`;
    // Clear old snapshots for other leagues to avoid stale data confusion
    try {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      const files = fs.readdirSync(SNAPSHOT_DIR);
      for (const f of files) {
        if (f.endsWith('.json') && f !== `${leagueId}.json`) {
          fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
        }
      }
    } catch {}

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
