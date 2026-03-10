import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { computeWeeklyList } from '../../../madden/top_players.js';

export const data = new SlashCommandBuilder()
  .setName('madden-top100test')
  .setDescription('View the Madden Top 100 (defaults to latest week).')
  .addStringOption(opt =>
    opt.setName('scope')
      .setDescription('week or season (season will still use latest-week data, avoids stale history)')
      .addChoices(
        { name: 'Week', value: 'week' },
        { name: 'Season', value: 'season' }
      )
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (1-based). Defaults to latest week with stats.')
      .setMinValue(1)
  )
  .addBooleanOption(opt =>
    opt.setName('public')
      .setDescription('Post publicly (tags Ghost Legacy). Default: private/ephemeral')
  )
  .setDefaultMemberPermissions(null);

async function safeReply(interaction, payload, { button = false } = {}) {
  // normalize ephemeral
  if (payload?.ephemeral && !payload?.flags) {
    payload.flags = 64;
    delete payload.ephemeral;
  }
  if (button) {
    if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
    return interaction.update(payload);
  }
  if (interaction.replied || interaction.deferred) return interaction.editReply(payload);
  return interaction.reply(payload);
}

function findLatestStage1Week(snapshot) {
  const weeks = (snapshot?.weeklyStats || [])
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
  if (!weeks.length) return null;
  return Math.max(...weeks);
}

function loadTeamEmojis() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'team_emojis.json'), 'utf8'));
  } catch {
    return {};
  }
}

function normalizeTeam(team, emojiMap) {
  if (!team) return '';
  const known = Object.keys(emojiMap);
  if (known.includes(team)) return team;
  const last = team.split(/\s+/).pop();
  if (known.includes(last)) return last;
  const found = known.find(k => team.includes(k));
  return found || team;
}

function makeButtons(scope, weekIdx, page, totalPages, isPublic) {
  const prevPage = Math.max(1, page - 1);
  const nextPage = Math.min(totalPages, page + 1);
  const toId = (action, p) => `madden_top100test_${action}|${scope}|${weekIdx != null ? weekIdx : 'null'}|${p}|${isPublic ? 1 : 0}`;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(toId('prev', prevPage))
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(toId('next', nextPage))
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages)
  );
}

async function render(interaction, opts = {}) {
  const { scope = 'week', weekIdx = null, page = 1, isPublic = false } = opts;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    return safeReply(interaction, { content: 'No league set. Run /madden-set-league first.', flags: 64 }, { button: true });
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`), 'utf8'));
  } catch {
    return safeReply(interaction, { content: 'Could not load league data.', flags: 64 }, { button: true });
  }
  const latestWeekIdx = findLatestStage1Week(snapshot);
  const useWeekIdx = weekIdx != null ? Math.max(0, weekIdx) : latestWeekIdx;
  if (useWeekIdx == null) {
    return safeReply(interaction, { content: 'No Stage 1 stats found yet. Run /madden-weeklyupdate after games are played.', flags: 64 }, { button: true });
  }

  let list;
  try {
    list = computeWeeklyList(snapshot, useWeekIdx);
  } catch (e) {
    console.error('[top100test] computeWeeklyList failed', e);
    list = [];
  }
  if (!list.length) {
    return safeReply(interaction, { content: `No player stats found for Week ${useWeekIdx + 1}.`, flags: 64 }, { button: true });
  }

  // sort by grade desc; trim 100
  list = list.slice().sort((a, b) => Number(b.grade ?? 0) - Number(a.grade ?? 0)).slice(0, 100);

  const emojiMap = loadTeamEmojis();
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  const lines = slice.map((p, idx) => {
    const teamKey = normalizeTeam(p.team || p.teamName, emojiMap);
    const emoji = emojiMap[teamKey] ? `<:${teamKey.replace(/\\s+/g, '_')}:${emojiMap[teamKey]}>` : '';
    const grade = Number(p.grade ?? p.seasonGrade ?? 0).toFixed(2);
    const pos = p.displayPos || p.position || 'UNK';
    return `${start + idx + 1}. ${emoji ? emoji + ' ' : ''}${pos} - ${p.name} | Grade: ${grade}`;
  });

  const title = scope === 'season'
    ? 'Madden Player Grades — Season'
    : `Madden Player Grades — Week ${useWeekIdx + 1}`;

  const embed = {
    title,
    description: lines.join('\n') || 'No players.',
    footer: { text: `Page ${safePage}/${totalPages} • League ${leagueId}` }
  };

  const row = makeButtons(scope, useWeekIdx, safePage, totalPages, isPublic);
  const payload = { embeds: [embed], components: [row] };
  if (isPublic) payload.content = '<@&1460399406397522145>';
  else payload.flags = 64;

  return safeReply(interaction, payload, { button: interaction.isButton?.() });
}

export async function execute(interaction, options = {}) {
  const isButton = interaction.isButton?.() && interaction.customId?.startsWith('madden_top100test_');
  if (isButton) {
    const parts = (interaction.customId || '').split('|');
    const scope = parts[1] || options.scope || 'week';
    const weekIdx = parts[2] === 'null' ? null : Number(parts[2]);
    const page = Number(parts[3] || options.page || 1);
    const isPublic = parts[4] === '1';
    return render(interaction, { scope, weekIdx, page, isPublic });
  }

  // Slash command
  const scopeOpt = interaction.options?.getString?.('scope') || options.scope || 'week';
  const weekOpt = interaction.options?.getInteger?.('week') ?? options.week;
  const isPublic = interaction.options?.getBoolean?.('public') ?? options.public ?? false;
  // Defer according to visibility
  try {
    await interaction.deferReply(isPublic ? {} : { flags: 64 });
  } catch (e) {
    if ([10062, 40060, 50027].includes(e?.code)) return;
  }
  const weekIdx = weekOpt != null ? Math.max(0, weekOpt - 1) : null;
  return render(interaction, { scope: scopeOpt, weekIdx, page: 1, isPublic });
}

export default { data, execute };
