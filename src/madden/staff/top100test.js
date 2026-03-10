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
  .addBooleanOption(opt =>
    opt.setName('public')
      .setDescription('Post publicly (tags Ghost Legacy). Default: private')
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (for weekly scope)')
      .setMinValue(1)
  );

export async function execute(interaction, options = {}) {
  // If this is a button interaction, use update, else use reply
  const isButton = interaction.isButton && interaction.isButton();
  let isPublic = interaction.options?.getBoolean?.('public') ?? options.public ?? false;
  let roleMap = {};
  let ghostRoleId = '1460399406397522145';
  let member;
  try {
    roleMap = loadRoleMap();
    ghostRoleId = roleMap['Ghost Legacy'] || ghostRoleId;
    member = await interaction.guild.members.fetch(interaction.user.id);
    const noAccessMsg = 'Only Ghost Legacy Commish/Co-Commish can use this command.';
    if (!hasStaffRole(member, roleMap)) {
      if (isButton) {
        const responder = interaction.deferred || interaction.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
        try {
          await responder({ content: noAccessMsg, ephemeral: true });
        } catch (err) {
          console.error('[top100test] Failed to send noAccessMsg:', err);
        }
      } else {
        try {
          await interaction.editReply({ content: noAccessMsg });
        } catch (err) {
          console.error('[top100test] Failed to editReply noAccessMsg:', err);
        }
      }
      return;
    }
  } catch (err) {
    console.error('[top100test] Error in role check:', err);
    try {
      if (!isButton) await interaction.editReply({ content: 'Error checking permissions.' });
    } catch (e2) {
      console.error('[top100test] Failed to send error after role check:', e2);
    }
    return;
  }
  const parseButtonState = () => {
    const id = interaction.customId || '';
    if (!id.startsWith('madden_top100test')) return {};
    const parts = id.split('|');
    if (parts.length < 5) return {};
    const scope = parts[1];
    const weekStr = parts[2];
    const pageStr = parts[3];
    const pubStr = parts[4];
    const week = weekStr === 'null' ? null : Number(weekStr);
    const page = Number(pageStr);
    const isPublicParsed = pubStr === '1';
    return { scope, week, page, isPublic: isPublicParsed };
  };
  const parsed = isButton ? parseButtonState() : {};
  console.log('[top100test] parsed', parsed, { isButton });
  if (isButton && (parsed.page === undefined || parsed.scope === undefined)) {
    try {
      await interaction.update({ content: 'Interaction expired. Please rerun `/madden-top100test`.', components: [], embeds: [] });
    } catch { /* swallow */ }
    return;
  }
  if (parsed.isPublic !== undefined) isPublic = parsed.isPublic;
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
  const scope = options.scope || parsed.scope || interaction.options?.getString?.('scope') || 'season';
  const weekOpt = options.week ?? parsed.week ?? interaction.options?.getInteger?.('week');
  console.log('[top100test] start', { scope, weekOpt, parsedWeek: parsed.week, isButton, isPublic, leagueId });
  const snapshotPath = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  let snapshotMtime = null;
  try { snapshotMtime = fs.statSync(snapshotPath).mtimeMs; } catch {}
  const historyDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
  const historyFresh = () => {
    try {
      const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json'));
      if (!files.length || !snapshotMtime) return false;
      const newest = Math.max(...files.map(f => fs.statSync(path.join(historyDir, f)).mtimeMs));
      return newest >= snapshotMtime - 2000; // allow slight clock drift
    } catch {
      return false;
    }
  };
  // Defer after knowing visibility
  if (!isButton) {
    try {
      await interaction.deferReply(isPublic ? {} : { flags: 64 });
    } catch (err) {
      if (err?.code === 10062) return;
      console.error('[top100test] Failed to deferReply:', err);
      try { await interaction.reply({ content: 'Discord temporarily unavailable. Try again in a moment.', flags: 64 }); } catch {}
      return;
    }
  }
  // Convert user-facing week number (1-based) to 0-based index for file lookups
  const week = scope === 'week'
    ? Math.max(0, (weekOpt != null ? weekOpt - 1 : currentWeek(snapshot) - 1))
    : null;

  let allPlayers;
  if (scope === 'season') {
    // Prefer fresh history; if stale/missing, compute from current snapshot's latest Stage 1 week
    if (historyFresh()) {
      try {
        allPlayers = computeSeasonTop100FromHistory(leagueId) || [];
      } catch {
        allPlayers = [];
      }
    }
    if (!allPlayers.length) {
      // compute from latest stage1 week in snapshot
      const stage1Weeks = (snapshot?.weeklyStats || [])
        .filter(w => Number(w.stage ?? w.stageIndex ?? 0) === 1)
        .filter(w => {
          const buckets = [
            w?.passing?.playerPassingStatInfoList,
            w?.rushing?.playerRushingStatInfoList,
            w?.receiving?.playerReceivingStatInfoList,
            w?.defense?.playerDefensiveStatInfoList,
          ];
          return buckets.some(b => Array.isArray(b) && b.length > 0);
        })
        .map(w => Number(w.weekIndex));
      const latest = stage1Weeks.length ? Math.max(...stage1Weeks) : null;
      if (latest != null) {
        allPlayers = computeWeeklyList(snapshot, latest);
      }
    }
    if (!allPlayers.length) {
      const msg = 'No season Top 100 available yet. Run weekly update first.';
      if (!isButton) await interaction.editReply(msg); else await interaction.update({ content: msg, components: [], embeds: [] });
      return;
    }
  } else {
    // For weekly scope always compute from the current snapshot to avoid stale history bleed
    console.log('[top100test] computing weekly list from snapshot', { week });
    allPlayers = computeWeeklyList(snapshot, week);
  }
  if (!allPlayers.length) {
    if (!isButton) await interaction.editReply('No player stats found for the latest week.');
    else await interaction.update({ content: 'No player stats found for the latest week.', components: [], embeds: [] });
    return;
  }
  // Ensure sorted by grade desc for display, then trim to 100
  allPlayers = allPlayers
    .slice()
    .sort((a, b) => {
      const ga = scope === 'season'
        ? Number(a.seasonGrade ?? a.seasonScore ?? a.avgGrade ?? a.grade ?? 0)
        : Number(a.grade ?? a.seasonGrade ?? 0);
      const gb = scope === 'season'
        ? Number(b.seasonGrade ?? b.seasonScore ?? b.avgGrade ?? b.grade ?? 0)
        : Number(b.grade ?? b.seasonGrade ?? 0);
      return gb - ga;
    });
  // Only show the top 100
  allPlayers = allPlayers.slice(0, 100);
  // Accept page override from options (for button handlers)
  let page = options.page || parsed.page || 1;
  const perPage = 10;
  const totalPages = Math.ceil(allPlayers.length / perPage);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;
  // Build select menu choices of available weeks if scope=week
  let weekChoices = [];
  if (scope === 'week') {
    const historyDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
    try {
      const weekFiles = fs.readdirSync(historyDir).filter(f =>
        /^week-\\d+-all\\.json$/.test(f) ||
        /^week_\\d+(_all)?\\.json$/.test(f)
      );
      weekChoices = weekFiles
        .map(f => Number(f.replace(/\\D/g, '')))
        .filter(n => Number.isFinite(n))
        .sort((a, b) => b - a) // desc
        .slice(0, 25);
    } catch { }
  }


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
    const pub = isPublic ? 1 : 0;
    return `madden_top100test_${action}|${scope}|${w}|${targetPage}|${pub}`;
  };

  const getPageEmbed = (pageNum) => {
    const start = (pageNum - 1) * perPage;
    const slice = allPlayers.slice(start, start + perPage);
    console.log('[top100test] render page', { scope, week, pageNum, totalPlayers: allPlayers.length, start, end: start + perPage });
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
    const baseButtons = [
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
    ];
    const rows = [];
    if (scope === 'week' && weekChoices.length) {
      const menu = new StringSelectMenuBuilder()
        .setCustomId('madden_top100test_week_select')
        .setPlaceholder('Select week')
        .addOptions(weekChoices.map(w => new StringSelectMenuOptionBuilder().setLabel(`Week ${w + 1}`).setValue(String(w))));
      rows.push(new ActionRowBuilder().addComponents(...baseButtons, menu));
    } else {
      rows.push(new ActionRowBuilder().addComponents(...baseButtons));
    }
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Madden Player Grades — ${titleScope}`)
          .setDescription(lines.join('\n') || 'No players.')
          .setFooter({ text: `Page ${pageNum}/${totalPages} • League ${leagueDisplayName}` })
      ],
      components: rows
    };
  };

  // Send first page privately or update for button
  if (isButton) {
    await interaction.update({ content: isPublic ? `<@&${ghostRoleId}>` : undefined, ...getPageEmbed(page) });
  } else {
    await interaction.editReply({ content: isPublic ? `<@&${ghostRoleId}>` : undefined, ...getPageEmbed(page) });
  }
}

export default { data, execute };
