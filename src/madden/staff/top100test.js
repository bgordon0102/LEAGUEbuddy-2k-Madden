import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { loadLeagueSnapshot, currentWeek } from '../../../madden/madden_data.js';
import { computeWeeklyList, computeSeasonTop100FromHistory } from '../../../madden/top_players.js';
import { EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const DEFAULT_CHANNEL_ID = '1462629502864851069';
const SEASON_FILE = path.join(process.cwd(), 'data', 'madden', 'top_players.json');

export const data = new SlashCommandBuilder()
  .setName('madden-top100test')
  .setDescription('Post the current Top 100 snapshot (test) to the staff channel.')
  .setDefaultMemberPermissions(null)
  .addStringOption(opt =>
    opt.setName('scope')
      .setDescription('Show a specific week or season list')
      .addChoices(
        { name: 'Week', value: 'week' },
        { name: 'Season (end of year)', value: 'season' }
      )
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (for weekly scope)')
      .setMinValue(1)
  );

export async function execute(interaction, options = {}) {
  // If this is a button interaction, use update, else use reply
  const isButton = interaction.isButton && interaction.isButton();
  if (!isButton) await interaction.deferReply({ ephemeral: true });
  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const noAccessMsg = 'Only Ghost Legacy Commish/Co-Commish can use this command.';
  if (!hasStaffRole(member, roleMap)) {
    if (isButton) {
      const responder = interaction.deferred || interaction.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
      await responder({ content: noAccessMsg, ephemeral: true });
    } else {
      await interaction.editReply({ content: noAccessMsg });
    }
    return;
  }
  const parseButtonState = () => {
    const id = interaction.customId || '';
    if (!id.startsWith('madden_top100test')) return {};
    const parts = id.split('|');
    if (parts.length < 4) return {};
    const scope = parts[1];
    const weekStr = parts[2];
    const pageStr = parts[3];
    const week = weekStr === 'null' ? null : Number(weekStr);
    const page = Number(pageStr);
    return { scope, week, page };
  };
  const parsed = isButton ? parseButtonState() : {};
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    if (!isButton) await interaction.editReply('No league configured. Run /madden-set-league first.');
    else await interaction.update({ content: 'No league configured. Run /madden-set-league first.', components: [], embeds: [] });
    return;
  }
  // Grade all players for the latest week and show a private paginated embed
  let snapshot;
  try {
    snapshot = loadLeagueSnapshot(leagueId);
  } catch (e) {
    if (!isButton) await interaction.editReply('Could not load league data.');
    else await interaction.update({ content: 'Could not load league data.', components: [], embeds: [] });
    return;
  }
  const scope = parsed.scope || interaction.options?.getString?.('scope') || options.scope || 'week';
  const weekOpt = parsed.week ?? interaction.options?.getInteger?.('week') ?? options.week;
  // Convert user-facing week number (1-based) to 0-based index for file lookups
  const week = scope === 'week'
    ? Math.max(0, (weekOpt != null ? weekOpt - 1 : currentWeek(snapshot) - 1))
    : null;

  let allPlayers;
  if (scope === 'season') {
    try {
      const data = JSON.parse(fs.readFileSync(SEASON_FILE, 'utf8'));
      const leagueBlob = data?.[leagueId] || data; // tolerate legacy shape
      allPlayers = Array.isArray(leagueBlob?.seasonTop100)
        ? leagueBlob.seasonTop100
        : Array.isArray(leagueBlob?.top100)
          ? leagueBlob.top100
          : Array.isArray(data)
            ? data
            : [];
    } catch {
      allPlayers = [];
    }
    // Fallback: compute from history if not saved yet
    if (!allPlayers.length) {
      try {
        allPlayers = computeSeasonTop100FromHistory(leagueId);
      } catch {
        allPlayers = [];
      }
    }
    if (!allPlayers.length) {
      const msg = 'No season Top 100 saved yet. Run the season exporter first.';
      if (!isButton) await interaction.editReply(msg); else await interaction.update({ content: msg, components: [], embeds: [] });
      return;
    }
  } else {
    const historyDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
    const file = path.join(historyDir, `week-${week}.json`);
    const allFile = path.join(historyDir, `week-${week}-all.json`);
    let loaded = [];
    try {
      const data = JSON.parse(fs.readFileSync(allFile, 'utf8'));
      if (Array.isArray(data?.players)) loaded = data.players;
    } catch {}
    if (!loaded.length) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(data?.top100)) loaded = data.top100;
      } catch {}
    }
    if (!loaded.length) {
      loaded = computeWeeklyList(snapshot, week);
    }
    allPlayers = loaded;
  }
  if (!allPlayers.length) {
    if (!isButton) await interaction.editReply('No player stats found for the latest week.');
    else await interaction.update({ content: 'No player stats found for the latest week.', components: [], embeds: [] });
    return;
  }
  // Ensure sorted by grade desc for display, then trim to 100
  allPlayers = allPlayers
    .slice()
    .sort((a, b) => (Number(b.grade || 0) - Number(a.grade || 0)) || 0);
  // Build select menu of available weeks if scope=week
  let components = [];
  if (scope === 'week') {
    const historyDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
    let weekFiles = [];
    try {
      weekFiles = fs.readdirSync(historyDir).filter(f => /^week-\\d+-all\\.json$/.test(f));
    } catch {}
    const weekChoices = weekFiles
      .map(f => Number(f.replace(/\\D/g, '')))
      .filter(n => Number.isFinite(n))
      .sort((a, b) => b - a) // desc
      .slice(0, 25);
    if (weekChoices.length) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('madden_top100test_week_select')
        .setPlaceholder('Select week')
        .addOptions(weekChoices.map(w => new StringSelectMenuOptionBuilder().setLabel(`Week ${w + 1}`).setValue(String(w))));
      components = [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('madden_top100test_prev')
            .setLabel('Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 1),
          new ButtonBuilder()
            .setCustomId('madden_top100test_next')
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page === totalPages),
          menu
        )
      ];
    }
  }
  // Only show the top 100
  allPlayers = allPlayers.slice(0, 100);
  // Accept page override from options (for button handlers)
  let page = parsed.page || options.page || 1;
  const perPage = 10;
  const totalPages = Math.ceil(allPlayers.length / perPage);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;


  // Load team emoji mapping
  let teamEmojis = {};
  try {
    teamEmojis = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'team_emojis.json'), 'utf8'));
  } catch { }

  // Helper to get emoji for a team name
  function getTeamEmoji(teamName) {
    const emojiId = teamEmojis[teamName];
    if (!emojiId) return '';
    // Discord custom emoji format: <:_name_:_id_>
    const safeName = teamName.toLowerCase().replace(/\s+/g, '_');
    return `<:team_${safeName}:${emojiId}>`;
  }

  // perPage, totalPages, and page are now declared above
  const normalizeTeamName = (team) => {
    if (!team) return '';
    // Remove city if present, match to known keys
    const known = Object.keys(teamEmojis);
    // Try exact match first
    if (known.includes(team)) return team;
    // Try last word (e.g., 'San Francisco 49ers' -> '49ers')
    const lastWord = team.split(' ').pop();
    if (known.includes(lastWord)) return lastWord;
    // Try contains
    const found = known.find(k => team.includes(k));
    if (found) return found;
    // Fallback: log for debugging
    console.log('[EMOJI DEBUG] No emoji match for team:', team);
    return team;
  };

  const makeButtonId = (action, targetPage) => {
    const w = scope === 'week' ? week : 'null';
    return `madden_top100test_${action}|${scope}|${w}|${targetPage}`;
  };

  const getPageEmbed = (pageNum) => {
    const start = (pageNum - 1) * perPage;
    const slice = allPlayers.slice(start, start + perPage);
    const lines = slice.map((p, idx) => {
      const normalizedTeam = normalizeTeamName(p.team);
      const emoji = getTeamEmoji(normalizedTeam);
      // Log for debugging
      if (!emoji) console.log(`[EMOJI DEBUG] No emoji for team:`, p.team, 'normalized as', normalizedTeam);
      // Show seasonGrade when scope=season; otherwise use weekly grade
      const gradeValue = scope === 'season'
        ? (p.seasonGrade != null ? p.seasonGrade : (p.avgGrade != null ? p.avgGrade : p.grade))
        : p.grade;
      const grade = gradeValue != null ? Number(gradeValue).toFixed(2) : 'N/A';
      const pos = p.displayPos || p.position || 'UNK';
      return `${start + idx + 1}. ${emoji} ${pos} - ${p.name} | Grade: ${grade}`;
    });
    // Map leagueId to display name (hardcoded for now)
    let leagueDisplayName = leagueId === '16594549' ? 'Ghost Legacy' : leagueId;
    const titleScope = scope === 'season' ? 'Season' : `Week ${week + 1}`;
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Madden Player Grades — ${titleScope}`)
          .setDescription(lines.join('\n') || 'No players.')
          .setFooter({ text: `Page ${pageNum}/${totalPages} • League ${leagueDisplayName}` })
      ],
      components: components.length ? components : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(makeButtonId('prev', pageNum - 1))
            .setLabel('Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageNum === 1),
          new ButtonBuilder()
            .setCustomId(makeButtonId('next', pageNum + 1))
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(pageNum === totalPages)
        )
      ]
    };
  };

  // Send first page privately or update for button
  if (isButton) {
    await interaction.update(getPageEmbed(page));
  } else {
    await interaction.editReply(getPageEmbed(page));
  }
}

export default { data, execute };
