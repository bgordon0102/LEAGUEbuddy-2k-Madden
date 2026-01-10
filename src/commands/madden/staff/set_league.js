import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { setGuildLeague } from '../../../madden/madden_config.js';
import { saveLeague as saveLeagueDb } from '../../../madden/madden_db.js';
import fs from 'fs';
import path from 'path';
import { loadTradeCounts, saveTradeCounts, updateTradeCountsEmbed } from '../../../utils/madden_trade_utils.js';
import { resetStatLeaders } from '../../../madden/stat_leaders.js';

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const POWER_RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');
const AVAILABLE_TEAMS_PIN_FILE = path.join(process.cwd(), 'data', 'madden', 'pins_available_teams.json');
const SCOUT_POINTS_FILE = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const TRADE_BLOCK_FILE = path.join(process.cwd(), 'data', 'madden', 'trade_block.json');
const TRADE_COUNTS_FILE = path.join(process.cwd(), 'data', 'madden', 'trade_counts.json');
const ACTIVE_TRADES_FILE = path.join(process.cwd(), 'data', 'madden', 'active_trades.json');
const PLAYER_CHANGES_FILE = path.join(process.cwd(), 'data', 'madden', 'player_changes.json');
const INJURIES_FILE = path.join(process.cwd(), 'data', 'madden', 'injuries.json');
const TRANSACTIONS_FILE = path.join(process.cwd(), 'data', 'madden', 'transactions.json');
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');

const PIN_CHANNEL_KEYS = {
  standings: 'Standings',
  stat_leaders: 'Stat Leaders',
  playoff_picture: 'Playoff Picture',
  power_rankings: 'Power Rankings',
  trade_counts: 'Trade Counts',
};

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
      // clear previous snapshots too
      const prevDir = path.join(SNAPSHOT_DIR, 'previous');
      if (fs.existsSync(prevDir)) {
        for (const f of fs.readdirSync(prevDir)) {
          fs.unlinkSync(path.join(prevDir, f));
        }
      }
    } catch {}
    // Reset power rankings/history and available teams pin ids for a clean slate on new league
    try { fs.existsSync(POWER_RANKS_FILE) && fs.unlinkSync(POWER_RANKS_FILE); } catch {}
    try { fs.existsSync(AVAILABLE_TEAMS_PIN_FILE) && fs.unlinkSync(AVAILABLE_TEAMS_PIN_FILE); } catch {}
    // Reset scouting and trade state so prior season data doesn't leak
    try { fs.existsSync(SCOUT_POINTS_FILE) && fs.unlinkSync(SCOUT_POINTS_FILE); } catch {}
    try { fs.existsSync(TRADE_BLOCK_FILE) && fs.unlinkSync(TRADE_BLOCK_FILE); } catch {}
    try { fs.existsSync(TRADE_COUNTS_FILE) && fs.unlinkSync(TRADE_COUNTS_FILE); } catch {}
    try { fs.existsSync(ACTIVE_TRADES_FILE) && fs.unlinkSync(ACTIVE_TRADES_FILE); } catch {}
    try { fs.existsSync(PLAYER_CHANGES_FILE) && fs.unlinkSync(PLAYER_CHANGES_FILE); } catch {}
    try { fs.existsSync(INJURIES_FILE) && fs.unlinkSync(INJURIES_FILE); } catch {}
    try { fs.existsSync(TRANSACTIONS_FILE) && fs.unlinkSync(TRANSACTIONS_FILE); } catch {}
    try { fs.existsSync(AWARDS_FILE) && fs.unlinkSync(AWARDS_FILE); } catch {}
    // Keep existing pin ids so messages continue to update across seasons
    // Recreate baseline trade counts pin with zeros
    try {
      const channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8'));
      const counts = {};
      saveTradeCounts(counts);
      await updateTradeCountsEmbed(interaction.client, channelMap, counts);
    } catch { /* ignore */ }
    // Reset stat leaders pin to blank for the new league
    try {
      await resetStatLeaders(interaction.client);
    } catch { /* ignore */ }

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
