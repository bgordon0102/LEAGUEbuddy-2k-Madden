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
    return aliases.includes(norm);
  });
}

const cleanName = (name) => (name || '').replace(/\bcoach\b/ig, '').trim();
const mascot = (name) => {
  const cleaned = cleanName(name);
  if (!cleaned) return 'Team';
  const parts = cleaned.split(/\s+/);
  return parts[parts.length - 1] || cleaned;
};

export const data = new SlashCommandBuilder()
  .setName('madden-testmatchup')
  .setDescription('Staff: create a single test matchup thread with full Madden-style embed + mascot buttons')
  .addStringOption(o => o.setName('away').setDescription('Away team name (e.g., Denver Broncos)').setRequired(false))
  .addStringOption(o => o.setName('home').setDescription('Home team name (e.g., Cleveland Browns)').setRequired(false))
  .addRoleOption(o => o.setName('away_coach_role').setDescription('Away coach role to tag (optional)').setRequired(false))
  .addRoleOption(o => o.setName('home_coach_role').setDescription('Home coach role to tag (optional)').setRequired(false))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  try { await interaction.deferReply({ flags: 64 }); } catch (err) { if (err?.code === 10062) return; }

  const roleMap = loadRoleMap();
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = loadLeagueSnapshot(leagueId);

  const awayRole = interaction.options.getRole('away_coach_role');
  const homeRole = interaction.options.getRole('home_coach_role');
  const nameFromRole = (role) => role ? cleanName(role.name) : null;
  const awayNameInput = interaction.options.getString('away') || nameFromRole(awayRole) || 'Denver Broncos';
  const homeNameInput = interaction.options.getString('home') || nameFromRole(homeRole) || 'Cleveland Browns';

  const awayTeam = findTeam(snapshot, awayNameInput);
  const homeTeam = findTeam(snapshot, homeNameInput);
  const awayLabel = mascot(awayTeam?.displayName || awayNameInput);
  const homeLabel = mascot(homeTeam?.displayName || homeNameInput);

  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: 'Run this in a text channel.' }).catch(() => {});
    return;
  }

  const thread = await channel.threads.create({
    name: `${awayLabel} vs ${homeLabel} - TEST`,
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
  const mentionText = [...mentions, ...COMMISH_ROLE_IDS.map(id => `<@&${id}>`)].filter(Boolean).join(' ') || null;

  const deadline = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000);
  const embed = {
    title: 'LEAGUEbuddy Matchup (TEST)',
    fields: [
      { name: 'Game Completed', value: '🏁 Both coaches press; clears reminders.', inline: false },
      { name: 'Fair Sim', value: '⚖️ Both coaches press; each gets 1 sim strike (max 5/season).', inline: false },
      { name: 'Home Win', value: '🏠 Only the AWAY coach or staff may press; HOME ready, AWAY couldn’t (away gets 1 strike).', inline: false },
      { name: 'Away Win', value: '🛫 Only the HOME coach or staff may press; AWAY ready, HOME couldn’t (home gets 1 strike).', inline: false },
      { name: 'CPU', value: '🤖 For CPU matchups; no strikes, just stops reminders.', inline: false },
      { name: 'Staff Strike', value: '🚫 Staff-only; adds 1 strike to the chosen team when unresponsive.', inline: false },
      { name: 'Deadline', value: `<t:${deadline}:R> (<t:${deadline}:F>)`, inline: false },
    ],
    color: 0x00b0f4,
    timestamp: new Date().toISOString(),
  };

  const encAway = encodeURIComponent(awayTeam?.displayName || awayNameInput);
  const encHome = encodeURIComponent(homeTeam?.displayName || homeNameInput);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_game_status_complete|${thread.id}|${encAway}|${encHome}`).setLabel('Game Completed 🏁').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`madden_game_status_fairsim|${thread.id}|${encAway}|${encHome}`).setLabel('Fair Sim ⚖️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_homewin|${thread.id}|${encAway}|${encHome}`).setLabel(`${homeLabel} Win 🏠`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_awaywin|${thread.id}|${encAway}|${encHome}`).setLabel(`${awayLabel} Win 🛫`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`madden_game_status_cpu|${thread.id}|${encAway}|${encHome}`).setLabel('CPU 🤖').setStyle(ButtonStyle.Secondary),
  );
  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`madden_game_status_staffstrikeaway|${thread.id}|${encAway}|${encHome}`).setLabel(`Staff Strike ${awayLabel} 🚫`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`madden_game_status_staffstrikehome|${thread.id}|${encAway}|${encHome}`).setLabel(`Staff Strike ${homeLabel} 🚫`).setStyle(ButtonStyle.Danger),
  );

  await thread.send({
    content: mentionText || null,
    embeds: [embed],
    components: [row, staffRow],
    allowedMentions: mentionText ? { parse: ['roles'] } : { parse: [] },
  }).catch(() => {});

  try { registerThread(thread.id, mentionText || ''); } catch {}
  try { await interaction.editReply({ content: `Test matchup thread created: <#${thread.id}>` }); } catch {}
}

export default { data, execute };
