import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { computeSeasonTop100FromHistory } from '../../../madden/top_players.js';
import fs from 'fs';
import path from 'path';

// Slash command builder
export const data = new SlashCommandBuilder()
  .setName('madden-top100test')
  .setDescription('View the Madden Top 100 players (season aggregation)')
  .setDefaultMemberPermissions(null);

async function safeRespond(interaction, payload, { button = false } = {}) {
  try {
    // Replace deprecated ephemeral with flags where possible
    if (payload?.ephemeral && !payload?.flags) {
      payload.flags = 64; // EPHEMERAL
      delete payload.ephemeral;
    }
    if (button) {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.update(payload);
      }
    } else {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    }
    return true;
  } catch (err) {
    if ([10062, 40060, 50027].includes(err?.code)) {
      // Interaction is gone; best effort ephemeral follow-up, otherwise silently drop.
      try {
        await interaction.followUp({ content: 'Interaction expired. Please run /madden-top100test again.', flags: 64 });
      } catch { /* ignore */ }
      return false;
    }
    throw err;
  }
}

// Shared renderer for both slash and button interactions
async function render(interaction, page = 1, opts = {}) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await safeRespond(interaction, { content: 'No league set. Run /madden-set-league first.', ephemeral: true }, opts);
    return;
  }

  // Always compute from weekly history (uses files in data/madden/top_players_history)
  let list = [];
  try { list = computeSeasonTop100FromHistory(leagueId) || []; } catch { list = []; }
  if (!list.length) {
    await safeRespond(interaction, { content: 'No season Top 100 found. Save weekly files first.', ephemeral: true }, opts);
    return;
  }
  // Sort by season grade desc
  list = list
    .slice()
    .sort((a, b) => Number(b.seasonGrade ?? b.seasonScore ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.seasonScore ?? a.grade ?? 0));

  // Team emojis
  let teamEmojis = {};
  try {
    teamEmojis = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'team_emojis.json'), 'utf8'));
  } catch { }
  const normalizeTeam = (team) => {
    if (!team) return '';
    const known = Object.keys(teamEmojis);
    if (known.includes(team)) return team;
    const last = team.split(/\s+/).pop();
    if (known.includes(last)) return last;
    const found = known.find(k => team.includes(k));
    return found || team;
  };
  const getEmoji = (team) => {
    const key = normalizeTeam(team);
    const id = teamEmojis[key];
    if (!id) return '';
    const safe = key.replace(/[^A-Za-z0-9_]/g, '_');
    return `<:${safe}:${id}>`;
  };
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);

  const lines = slice.map((p, idx) => {
    const grade = Number(p.seasonGrade ?? p.seasonScore ?? p.grade ?? 0).toFixed(1);
    const emoji = getEmoji(p.team || p.teamName);
    const pos = p.position || p.displayPos || 'UNK';
    const teamTxt = p.team || p.teamName || '';
    return `${start + idx + 1}. ${emoji ? emoji + ' ' : ''}${pos} - ${p.name}${teamTxt ? ` (${teamTxt})` : ''} | Grade: ${grade}`;
  });

  const embed = {
    title: 'NFL Top 100 — Season',
    description: lines.join('\n') || 'No players.',
    footer: { text: `Page ${safePage}/${totalPages} • League ${leagueId}` }
  };

  const prevPage = Math.max(1, safePage - 1);
  const nextPage = Math.min(totalPages, safePage + 1);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_top100test_prev|season|null|${prevPage}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 1),
    new ButtonBuilder()
      .setCustomId(`madden_top100test_next|season|null|${nextPage}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(safePage >= totalPages)
  );

  const replyPayload = { embeds: [embed], components: [row], ephemeral: true };

  await safeRespond(interaction, replyPayload, opts);
}

export async function execute(interaction) {
  const isButton = interaction.isButton?.() && interaction.customId?.startsWith('madden_top100test_');
  if (isButton) {
    const parts = interaction.customId.split('|'); // e.g., madden_top100test_next|season|null|2
    const targetPage = Number(parts[3]) || 1; // page is encoded directly in the button id
    return render(interaction, targetPage, { button: true });
  }

  // Slash command
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if ([10062, 40060, 50027].includes(err?.code)) return;
  }
  return render(interaction, 1, { button: false });
}

export default { data, execute };
