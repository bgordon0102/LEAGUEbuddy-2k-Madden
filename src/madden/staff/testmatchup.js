import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import path from 'path';
import fs from 'fs';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { registerThread } from '../../shared/madden_thread_notifier.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const COMMISH_ROLE_IDS = ['1460399404241522759', '1460399405436768431'];

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

function findTeam(snapshot, name) {
  const norm = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  return teams.find(t => {
    const aliases = [
      t.displayName, t.nickName, t.cityName, t.abbrName,
      `${t.cityName} ${t.nickName}`,
    ].map(x => (x || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
    const extra = new Set(aliases);
    extra.add('sanfrancisco49ers');
    extra.add('49ers');
    return aliases.includes(norm) || extra.has(norm);
  });
}

export const data = new SlashCommandBuilder()
  .setName('madden-testmatchup')
  .setDescription('Staff: create a single test matchup thread with the new buttons')
  .addStringOption(o => o.setName('away').setDescription('Away team name (e.g., Denver Broncos)').setRequired(false))
  .addStringOption(o => o.setName('home').setDescription('Home team name (e.g., San Francisco 49ers)').setRequired(false))
  .addRoleOption(o => o.setName('away_coach_role').setDescription('Away coach role to tag (optional)').setRequired(false))
  .addRoleOption(o => o.setName('home_coach_role').setDescription('Home coach role to tag (optional)').setRequired(false))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = loadLeagueSnapshot(leagueId);

  const awayRole = interaction.options.getRole('away_coach_role');
  const homeRole = interaction.options.getRole('home_coach_role');
  const nameFromRole = (role) => role ? role.name.replace(/\\s*Coach$/i, '').trim() : null;
  const awayName = interaction.options.getString('away') || nameFromRole(awayRole) || 'Denver Broncos';
  const homeName = interaction.options.getString('home') || nameFromRole(homeRole) || 'San Francisco 49ers';
  // Use provided names for display; attempt lookup only for stats/ids
  const awayTeam = findTeam(snapshot, awayName);
  const homeTeam = findTeam(snapshot, homeName);
  const deadline = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000);

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.reply({ content: 'Run this in a text channel.', ephemeral: true });
    return;
  }
  const thread = await channel.threads.create({
    name: `${awayName} vs ${homeName} - TEST`,
    autoArchiveDuration: 10080,
    reason: 'Test matchup thread',
  });

  const mentions = [];
  if (awayRole || homeRole) {
    if (awayRole) mentions.push(`<@&${awayRole.id}>`);
    if (homeRole) mentions.push(`<@&${homeRole.id}>`);
  } else {
    if (awayTeam?.displayName && roleMap[`${awayTeam.displayName} Coach`]) mentions.push(`<@&${roleMap[`${awayTeam.displayName} Coach`]}>`);
    if (homeTeam?.displayName && roleMap[`${homeTeam.displayName} Coach`]) mentions.push(`<@&${roleMap[`${homeTeam.displayName} Coach`]}>`);
  }
  const commishIds = ['1460399404241522759', '1460399405436768431'].filter(Boolean);
  const mentionText = [...mentions, ...commishIds.map(id => `<@&${id}>`)].filter(Boolean).join(' ') || null;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_game_status_complete|${thread.id}`).setLabel('Game Completed 🏁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`madden_game_status_fairsim|${thread.id}`).setLabel('Fair Sim ⚖️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_homewin|${thread.id}`).setLabel('Home Win 🏠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_awaywin|${thread.id}`).setLabel('Away Win 🛫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_cpu|${thread.id}`).setLabel('CPU 🤖').setStyle(ButtonStyle.Secondary),
  );
  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_game_status_staffstrikeaway|${thread.id}`).setLabel('Staff Strike Away 🚫').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`madden_game_status_staffstrikehome|${thread.id}`).setLabel('Staff Strike Home 🚫').setStyle(ButtonStyle.Danger),
  );

  const embed = {
    title: 'LEAGUEbuddy Matchup (TEST)',
    description: [
      `Schedule and play your game. Use the buttons when needed:`,
      `🏁 Game Completed — both coaches press; clears reminders.`,
      `⚖️ Fair Sim — both coaches press; each gets 1 sim strike (max 5/season).`,
      `🏠 Home Win — only the AWAY coach or staff may press; HOME ready, AWAY couldn’t (away gets 1 strike).`,
      `🛫 Away Win — only the HOME coach or staff may press; AWAY ready, HOME couldn’t (home gets 1 strike).`,
      `🤖 CPU — for CPU matchups; no strikes, just stops reminders.`,
      `🚫 Staff Strike — staff-only; adds 1 strike to the chosen team when unresponsive.`,
      `Deadline: <t:${deadline}:R> (<t:${deadline}:f>)`
    ].join('\n'),
    color: 0x00b0f4,
    timestamp: new Date().toISOString(),
  };

  await thread.send({
    content: mentionText,
    embeds: [embed],
    components: [row, staffRow],
    allowedMentions: mentionText ? { parse: ['roles'] } : { parse: [] },
  });
  try { registerThread(thread.id, mentionText || ''); } catch {}
  await interaction.reply({ content: `Test matchup thread created: <#${thread.id}>`, ephemeral: true });
}

export default { data, execute };
