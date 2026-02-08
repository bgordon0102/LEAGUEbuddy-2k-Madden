import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { loadTokens as loadTokensDb, loadLeague as loadLeagueDb } from '../../../madden/madden_db.js';
import { getLeagueForGuild } from '../../../madden/madden_config.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const TOKEN_FILE = path.join(process.cwd(), 'data', 'madden', 'tokens.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export const data = new SlashCommandBuilder()
  .setName('madden-health')
  .setDescription('Show Madden bot health (staff only).')
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
      return;
    }
    const envConsole = process.env.EA_CONSOLE || 'unset';
    const envYear = process.env.EA_GAME_YEAR || 'unset';

    const tokensDb = loadTokensDb();
    const tokensFile = fileExists(TOKEN_FILE);
    const leagueDb = loadLeagueDb();
    const leagueCfg = getLeagueForGuild(interaction.guildId);

    const snapshots = fileExists(SNAPSHOT_DIR)
      ? fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json'))
      : [];

    const channels = loadJson(CHANNEL_MAP_FILE) || {};
    const roles = loadJson(ROLE_MAP_FILE) || {};

    const status = [
      { name: 'EA Console', value: envConsole, inline: true },
      { name: 'EA Game Year', value: envYear, inline: true },
      { name: 'Tokens (DB)', value: tokensDb ? 'present' : 'missing', inline: true },
      { name: 'Tokens (file)', value: tokensFile ? 'present' : 'missing', inline: true },
      { name: 'League (DB)', value: leagueDb || 'not set', inline: true },
      { name: 'League (guild)', value: leagueCfg || 'not set', inline: true },
      { name: 'Snapshots', value: snapshots.length ? snapshots.join(', ') : 'none', inline: false },
      { name: 'Channels configured', value: Object.keys(channels).length ? `${Object.keys(channels).length}` : 'none', inline: true },
      { name: 'Roles configured', value: Object.keys(roles).length ? `${Object.keys(roles).length}` : 'none', inline: true },
    ];

    const embed = new EmbedBuilder()
      .setTitle('Madden Health')
      .setColor(0x00cc66)
      .addFields(status);

    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    await interaction.editReply({ content: `Health check failed: ${e?.message || e}` });
  }
}

export default { data, execute };
