import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function coachTeamFromMember(member, roleMap, snapshot) {
  if (!member) return null;
  const roles = member.roles?.cache;
  if (!roles) return null;
  // Try explicit map
  for (const [name, id] of Object.entries(roleMap)) {
    if (!name.endsWith(' Coach')) continue;
    if (roles.has(id)) return name.replace(/ Coach$/, '');
  }
  // Fallback: fuzzy match against team list
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  for (const r of roles.values()) {
    const base = r.name.replace(/ Coach$/, '').toLowerCase();
    const match = teams.find(t => {
      const cands = [t.displayName, t.nickName, t.abbrName, t.cityName].map(x => (x || '').toLowerCase());
      return cands.includes(base);
    });
    if (match) return match.displayName || match.nickName || match.cityName || 'Team';
  }
  return null;
}

export const data = new SlashCommandBuilder()
  .setName('madden-streamlink')
  .setDescription('Post your game stream link to the Streaming links channel.')
  .addStringOption(o => o.setName('link').setDescription('Streaming URL').setRequired(true))
  .addStringOption(o => o.setName('note').setDescription('Optional note/opponent info').setRequired(false))
  .setDMPermission(false);

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-setleague first.', ephemeral: true });
    return;
  }
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const streamingChannelId = channelMap['Streaming links'];
  const ghostRoleId = roleMap['Ghost Legacy'];
  const ghostMention = ghostRoleId ? `<@&${ghostRoleId}>` : null;
  if (!streamingChannelId) {
    await interaction.reply({ content: 'Streaming links channel not configured.', ephemeral: true });
    return;
  }
  const channel = await interaction.client.channels.fetch(streamingChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ content: 'Streaming links channel not accessible.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const link = interaction.options.getString('link');
  const note = interaction.options.getString('note');
  const snapshot = loadLeagueSnapshot(leagueId);
  const team = coachTeamFromMember(interaction.member, roleMap, snapshot);
  const embed = new EmbedBuilder()
    .setTitle(team ? `${team} Stream` : 'Stream Link')
    .setDescription(link)
    .setColor(0x5865f2)
    .setFooter({ text: interaction.user.tag })
    .setTimestamp(new Date());
  if (note) embed.addFields({ name: 'Note', value: note });

  await channel.send({
    content: ghostMention || null,
    embeds: [embed],
    allowedMentions: {
      parse: [],
      roles: ghostRoleId ? [ghostRoleId] : [],
    },
  }).catch(() => null);
  await interaction.editReply({ content: 'Stream link posted.' });
}

export default { data, execute };
