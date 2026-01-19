import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { loadLeagueSnapshot, currentWeek } from '../../../madden/madden_data.js';
import { computeWeeklyList } from '../../../madden/top_players.js';
import { EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const DEFAULT_CHANNEL_ID = '1462629502864851069';

export const data = new SlashCommandBuilder()
  .setName('madden-top100test')
  .setDescription('Post the current Top 100 snapshot (test) to the staff channel.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction, options = {}) {
  // If this is a button interaction, use update, else use reply
  const isButton = interaction.isButton && interaction.isButton();
  if (!isButton) await interaction.deferReply({ ephemeral: true });
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
  const week = currentWeek(snapshot);
  let allPlayers = computeWeeklyList(snapshot, week - 1);
  if (!allPlayers.length) {
    if (!isButton) await interaction.editReply('No player stats found for the latest week.');
    else await interaction.update({ content: 'No player stats found for the latest week.', components: [], embeds: [] });
    return;
  }
  // Only show the top 100
  allPlayers = allPlayers.slice(0, 100);
  // Accept page override from options (for button handlers)
  let page = options.page || 1;
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

  const getPageEmbed = (pageNum) => {
    const start = (pageNum - 1) * perPage;
    const slice = allPlayers.slice(start, start + perPage);
    const lines = slice.map((p, idx) => {
      const normalizedTeam = normalizeTeamName(p.team);
      const emoji = getTeamEmoji(normalizedTeam);
      // Log for debugging
      if (!emoji) console.log(`[EMOJI DEBUG] No emoji for team:`, p.team, 'normalized as', normalizedTeam);
      const grade = p.grade != null ? Number(p.grade).toFixed(2) : 'N/A';
      const pos = p.displayPos || p.position || 'UNK';
      return `${start + idx + 1}. ${emoji} ${pos} - ${p.name} | Grade: ${grade}`;
    });
    // Map leagueId to display name (hardcoded for now)
    let leagueDisplayName = leagueId === '16594549' ? 'Ghost Legacy' : leagueId;
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle(`Madden Player Grades — Week ${week}`)
          .setDescription(lines.join('\n') || 'No players.')
          .setFooter({ text: `Page ${pageNum}/${totalPages} • League ${leagueDisplayName}` })
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('madden_top100test_prev')
            .setLabel('Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pageNum === 1),
          new ButtonBuilder()
            .setCustomId('madden_top100test_next')
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
