import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { runSync } from '../sync.js';
import { getMessageForWeek } from '../../../madden/madden_utils.js';
import { SnallabotProvider } from '../../../madden/providers/SnallabotProvider.js';
import { updateStatLeaders, resetStatLeaders } from '../../../madden/stat_leaders.js';
import { updateStandings, resetStandings } from '../../../madden/standings_pin.js';
import { updatePlayoffPicture, resetPlayoffPicture } from '../../../madden/playoff_picture.js';
import { updatePowerRankings, resetPowerRankings } from '../../../madden/power_rankings.js';
import { updateTransactions } from '../../../madden/transactions.js';
import { updatePlayerChanges } from '../../../madden/player_changes.js';
import { updateInjuries } from '../../../madden/injuries.js';
import { Stage } from '../../../madden/ea_client.js';
import { saveTradeCounts, updateTradeCountsEmbed } from '../../../shared/madden_trade_utils.js';
import { updateAwards, gatherWeeklyStats } from '../../../madden/awards.js';
import { maybePostDraftGrades } from '../../../madden/draft_grades_auto.js';
import { updateTopPlayers } from '../../../madden/top_players.js';
import { updateWeeklyGameLog } from '../weekly_game_log.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';
import { buildStoryContext, buildWeeklyRecapData } from '../storytelling.js';
import { queueMaddenContentReview } from '../../shared/madden_content_review_queue.js';
import { brandText, brandTitle } from '../../shared/madden_branding.js';
import { appendMaddenStaffLog } from '../../shared/madden_staff_ops.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const POWER_RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');
const SCOUT_POINTS_FILE = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const WEEKLY_UPDATE_OVERRIDES_FILE = path.join(process.cwd(), 'data', 'madden', 'weekly_update_overrides.json');

function median(values = []) {
  const nums = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function loadWeeklyUpdateOverrides() {
  try {
    return JSON.parse(fs.readFileSync(WEEKLY_UPDATE_OVERRIDES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveWeeklyUpdateOverrides(overrides) {
  fs.mkdirSync(path.dirname(WEEKLY_UPDATE_OVERRIDES_FILE), { recursive: true });
  fs.writeFileSync(WEEKLY_UPDATE_OVERRIDES_FILE, JSON.stringify(overrides ?? {}, null, 2));
}

const data = new SlashCommandBuilder()
  .setName('madden-weeklyupdate')
  .setDescription('Run after each advance. Use week only for backfills or fixes.')
  .addIntegerOption(o => o.setName('week').setDescription('Backfill/fix a specific week. Leave empty for normal use.').setRequired(false))
  .addBooleanOption(o => o.setName('force_awards').setDescription('Backfill only: force awards for the chosen week').setRequired(false))
  .addBooleanOption(o => o.setName('queue_recap_review').setDescription('Backfill only: queue a recap draft for the chosen week').setRequired(false))
  .setDefaultMemberPermissions(null);

async function execute(interaction) {
  let weekOverride = null;
  await interaction.deferReply();
  try {
    const criticalFailures = [];
    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
      return;
    }
    weekOverride = interaction.options.getInteger('week');
    const forceAwardsOption = interaction.options.getBoolean('force_awards') === true;
    const queueRecapReviewOption = interaction.options.getBoolean('queue_recap_review') === true;
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
      return;
    }
    const provider = new SnallabotProvider();
    const summary = await runSync(leagueId, provider, { week: weekOverride });
    const weeklyUpdateOverrides = loadWeeklyUpdateOverrides();
    const leagueOverride = weeklyUpdateOverrides?.[leagueId] || {};
    const forceAwardsOnce = forceAwardsOption || leagueOverride?.forceAwardsOnce === true;
    // Load the freshly written snapshot so we can use richer context (stage per week, season info flags)
    const snapPath = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
    let snap = null;
    try {
      snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    } catch { }
    const seasonInfo = snap?.info?.careerHubInfo?.seasonInfo || {};
    // Derive a week if missing: prefer summary.currentWeek, else displayWeek, else highest regular-season weeklyStats index + 1
    const derivedWeekFromStats = (() => {
      const regWeeks = (snap?.weeklyStats || []).filter(w => Number(w.stage !== undefined ? w.stage : (w.stageIndex !== undefined ? w.stageIndex : 1)) === 1);
      if (!regWeeks.length) return 0;
      const maxIdx = Math.max(...regWeeks.map(w => Number(w.weekIndex !== undefined ? w.weekIndex : -1)).filter(n => n >= 0));
      return maxIdx >= 0 ? maxIdx + 1 : 0;
    })();
    // If caller explicitly passed a week, honor it for all downstream grading/awards.
    const currentWeekValue = weekOverride && weekOverride > 0
      ? weekOverride
      : (summary.currentWeek && summary.currentWeek > 0
        ? summary.currentWeek
        : (seasonInfo.displayWeek && seasonInfo.displayWeek > 0
          ? seasonInfo.displayWeek
          : derivedWeekFromStats));
    // Define effectiveCurrentWeek for downstream use
    // Use currentWeekValue as the effective current week
    const effectiveCurrentWeek = currentWeekValue;
    const currentWeekIndex = currentWeekValue > 0 ? currentWeekValue - 1 : null;
    const weekEntry = snap?.weeklyStats?.find(w => w.weekIndex === currentWeekIndex);
    const seasonWeekType = seasonInfo.seasonWeekType;
    // Derive stage: prefer seasonWeekType (0=pre,1=reg,2=post), else summary.stage.
    let stageForWeek = typeof seasonWeekType === 'number' ? seasonWeekType : Stage.SEASON;
    if (typeof seasonWeekType === 'number') {
      stageForWeek = seasonWeekType;
    } else if (summary.stage !== undefined) {
      stageForWeek = summary.stage;
    }
    if (weekEntry?.stage !== undefined && (weekEntry.weekIndex !== undefined ? weekEntry.weekIndex : 0) >= 18) {
      stageForWeek = weekEntry.stage;
    }
    // Only correct obvious preseason mislabels for active in-season weeks; preserve postseason.
    if (currentWeekValue >= 1 && stageForWeek === Stage.PRESEASON && Number(currentWeekValue) <= 18) {
      stageForWeek = Stage.SEASON;
    }
    const offStageValue = summary.offSeasonStage !== undefined ? summary.offSeasonStage : (seasonInfo.offSeasonStage !== undefined ? seasonInfo.offSeasonStage : 0);
    let inOffseason = offStageValue > 0;
    // If we're clearly in a numbered week, treat as in-season even if offSeasonStage lingered
    if (stageForWeek === Stage.SEASON && currentWeekValue >= 1) {
      inOffseason = false;
    }
    // If explicitly overriding, force regular-season handling
    if (weekOverride && weekOverride > 0 && Number(weekOverride) <= 18) {
      stageForWeek = Stage.SEASON;
      inOffseason = false;
    }
    // Determine effective target and week using available stats
    // (effectiveTargetWeekIdx/effectiveCurrentWeekUsed computed later after we know if we have stats)
    const targetWeekIdx = currentWeekValue ? currentWeekValue - 1 : null;
    const countPlayers = (wk) => {
      const buckets = [
        wk?.passing?.playerPassingStatInfoList,
        wk?.rushing?.playerRushingStatInfoList,
        wk?.receiving?.playerReceivingStatInfoList,
        wk?.defense?.playerDefensiveStatInfoList,
      ];
      return buckets.reduce((acc, b) => acc + (Array.isArray(b) ? b.length : 0), 0);
    };
    const weekEntries = (snap?.weeklyStats || []).filter(w => Number(w.weekIndex) === Number(targetWeekIdx));
    const stageInfo = weekEntries.map(w => ({
      stage: w.stage !== undefined ? w.stage : (w.stageIndex !== undefined ? w.stageIndex : 0),
      playerCount: countPlayers(w)
    }));
    const targetWeekPlayerCount = Math.max(0, ...stageInfo.map((entry) => Number(entry.playerCount || 0)));
    const weekData = targetWeekIdx !== null && snap ? gatherWeeklyStats(snap, targetWeekIdx) : null;
    const hasWeeklyPlayers = !!weekData;
    // Fallback: if the current week has no stats, use the latest Stage 1 week with stats
    const latestStage1WithStats = (() => {
      const weeks = (snap?.weeklyStats || [])
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
    })();
    const effectiveTargetWeekIdx = hasWeeklyPlayers ? targetWeekIdx : latestStage1WithStats;
    const effectiveCurrentWeekUsed = hasWeeklyPlayers
      ? currentWeekValue
      : (latestStage1WithStats != null ? latestStage1WithStats + 1 : currentWeekValue);
    const hasWeeklyPlayersEffective = effectiveTargetWeekIdx != null
      ? !!gatherWeeklyStats(snap, effectiveTargetWeekIdx)
      : false;
    const isWildcard = Number(effectiveCurrentWeekUsed ?? currentWeekValue ?? 0) === 19;
    const backfillOnlyAwards = !!weekOverride;
    const missingWeeks = (summary.missingWeeks || []).filter(w => ((w.playerCount !== undefined ? w.playerCount : 0)) > 0);
    const deduped = [];
    const seen = new Map();
    missingWeeks.forEach(w => {
      const key = `${w.stage}-${w.weekIndex}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      const existing = deduped.find(d => `${d.stage}-${d.weekIndex}` === key);
      if (!existing) {
        deduped.push({ ...w, runs: 1 });
      } else {
        existing.runs += 1;
        existing.playerCount = w.playerCount !== undefined ? w.playerCount : existing.playerCount;
      }
    });
    const usedFallbackWeek = Number(effectiveCurrentWeekUsed) !== Number(currentWeekValue);
    const targetWeekMissing = deduped.some((entry) => Number(entry.weekIndex) === Number(targetWeekIdx));
    const recentRegularWeekCounts = (snap?.weeklyStats || [])
      .filter((entry) => Number(entry?.stage ?? entry?.stageIndex ?? 0) === 1)
      .filter((entry) => Number(entry?.weekIndex ?? -1) < Number(targetWeekIdx))
      .map((entry) => countPlayers(entry))
      .filter((count) => count > 0)
      .slice(-4);
    const recentMedianCount = median(recentRegularWeekCounts);
    const lowPlayerCountWeek =
      !backfillOnlyAwards &&
      Number(targetWeekIdx) >= 0 &&
      recentMedianCount > 0 &&
      targetWeekPlayerCount > 0 &&
      targetWeekPlayerCount < (recentMedianCount * 0.7);
    const statsPartial = !backfillOnlyAwards && (usedFallbackWeek || targetWeekMissing || !hasWeeklyPlayersEffective || lowPlayerCountWeek);

    console.log('[madden-weeklyupdate] week targeting', {
      weekOverride,
      effectiveCurrentWeek: currentWeekValue,
      effectiveCurrentWeekUsed,
      targetWeekIdx,
      effectiveTargetWeekIdx,
      stageForWeek,
      stageInfo,
      targetWeekPlayerCount,
      recentMedianCount,
      hasWeeklyPlayers,
      hasWeeklyPlayersEffective,
      lowPlayerCountWeek,
      statsPartial,
      forceAwardsOnce
    });
    if (!hasWeeklyPlayersEffective && effectiveTargetWeekIdx !== null) {
      console.warn('[madden-weeklyupdate] no stage 1 player stats found for selected week; skipping top players and awards if requested');
    }

    // Determine if we are in preseason (stageForWeek is PRESEASON and week is 0 or 1)
    const inPreseason = stageForWeek === Stage.PRESEASON || currentWeekValue === 0;
    // Allow pin updates when in regular season or when a week override was provided
    const allowPinnedUpdates = !inPreseason || backfillOnlyAwards;

    // Open/reset scouting at Week 1 of the regular season
    if (!backfillOnlyAwards && stageForWeek === Stage.SEASON && currentWeekValue === 1) {
      try {
        fs.writeFileSync(SCOUT_POINTS_FILE, JSON.stringify({}, null, 2));
        console.log('[madden-weeklyupdate] Scouting reset/opened for Week 1');
      } catch (e) {
        console.warn('[madden-weeklyupdate] Failed to reset scouting points:', e?.message || e);
      }
    }

    // On the first week of a new season (preseason), reset trade counts but keep pins
    if (!backfillOnlyAwards && inPreseason) {
      try {
        const channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8'));
        const emptyCounts = {};
        saveTradeCounts(emptyCounts);
        await updateTradeCountsEmbed(interaction.client, channelMap, emptyCounts);
      } catch (e) {
        console.warn('[madden-weeklyupdate] trade counts reset skipped:', e?.message || e);
      }
      // Reset stored power ranks for this league so new-entrant messages fire
      try {
        const ranks = fs.existsSync(POWER_RANKS_FILE) ? JSON.parse(fs.readFileSync(POWER_RANKS_FILE, 'utf8')) : {};
        if (ranks[leagueId]) {
          delete ranks[leagueId];
          fs.writeFileSync(POWER_RANKS_FILE, JSON.stringify(ranks, null, 2));
        }
      } catch (e) {
        console.warn('[madden-weeklyupdate] power ranks reset skipped:', e?.message || e);
      }
    }

    // Stat leaders: reset in preseason/new season, otherwise update
    if (inPreseason) {
      // Preseason: keep placeholders (no stat updates)
      try {
        await resetStatLeaders(interaction.client);
      } catch (e) {
        console.warn('[madden-weeklyupdate] stat leaders reset skipped:', e?.message || e);
      }
      try {
        await resetStandings(interaction.client);
      } catch (e) {
        console.warn('[madden-weeklyupdate] standings reset skipped:', e?.message || e);
      }
      try {
        await resetPlayoffPicture(interaction.client);
      } catch (e) {
        console.warn('[madden-weeklyupdate] playoff picture reset skipped:', e?.message || e);
      }
      try {
        await resetPowerRankings(interaction.client);
      } catch (e) {
        console.warn('[madden-weeklyupdate] power rankings reset skipped:', e?.message || e);
      }
    } else if (!backfillOnlyAwards && allowPinnedUpdates && !statsPartial) {
      try {
        await updateStatLeaders(interaction.client, leagueId);
      } catch (e) {
        criticalFailures.push('Stat leaders');
        console.warn('[madden-weeklyupdate] stat leaders update skipped:', e?.message || e);
      }
    } else if (statsPartial) {
      console.warn('[madden-weeklyupdate] stat leaders skipped: target week still partial');
    } else if (backfillOnlyAwards) {
      console.warn('[madden-weeklyupdate] stat leaders skipped: backfill mode only updates requested week outputs');
    } else {
      console.warn('[madden-weeklyupdate] stat leaders skipped (not regular season)');
    }

    if (!backfillOnlyAwards && allowPinnedUpdates) {
      try {
        await updateStandings(interaction.client, leagueId);
      } catch (e) {
        criticalFailures.push('Standings');
        console.warn('[madden-weeklyupdate] standings update skipped:', e?.message || e);
      }
      try {
        await updatePlayoffPicture(interaction.client, leagueId);
      } catch (e) {
        criticalFailures.push('Playoff picture');
        console.warn('[madden-weeklyupdate] playoff picture update skipped:', e?.message || e);
      }
      try {
        await updatePowerRankings(interaction.client, leagueId);
      } catch (e) {
        criticalFailures.push('Power rankings');
        console.warn('[madden-weeklyupdate] power rankings update skipped:', e?.message || e);
      }
    } else {
      console.warn(backfillOnlyAwards
        ? '[madden-weeklyupdate] standings/playoff picture/power rankings skipped: backfill mode only updates requested week outputs'
        : '[madden-weeklyupdate] standings/playoff picture/power rankings skipped (offseason/preseason or after Wild Card)');
    }
    try {
      updateWeeklyGameLog(leagueId, snap);
    } catch (e) {
      criticalFailures.push('Weekly game log');
      console.warn('[madden-weeklyupdate] weekly game log update skipped:', e?.message || e);
    }
    // Post weekly transactions
    if (!backfillOnlyAwards) {
      try {
        await updateTransactions(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] transactions update skipped:', e?.message || e);
      }
    }
    const isSuperBowlBye = effectiveCurrentWeek === 22;
    // Player change log (position/attribute/dev changes) — skip bye week
    if (!backfillOnlyAwards && !isSuperBowlBye) {
      try {
        await updatePlayerChanges(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] player changes update skipped:', e?.message || e);
      }
      // Injuries
      try {
        await updateInjuries(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] injuries update skipped:', e?.message || e);
      }
    } else {
      console.warn(backfillOnlyAwards
        ? '[madden-weeklyupdate] player changes/injuries skipped: backfill mode only updates requested week outputs'
        : '[madden-weeklyupdate] bye week between Conference and Super Bowl: skipping player changes/injuries/awards');
    }
    // Draft grades auto-post (after draft recap)
    // Skip automatic draft grades; post only manually if needed
    // Weekly Top 30 log + running Top 100 (use current formula even during backfill)
    const allowTopPlayers = !inOffseason && !inPreseason && hasWeeklyPlayers && !statsPartial;
    if (allowTopPlayers) {
      // If user passed a specific week, clear old history so Top100 reflects that week only
      if (weekOverride && leagueId) {
        try {
          const histDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
          fs.rmSync(histDir, { recursive: true, force: true });
          console.log('[madden-weeklyupdate] cleared top_players_history for override week', { leagueId, weekOverride });
        } catch (e) {
          console.warn('[madden-weeklyupdate] failed to clear top_players_history:', e?.message || e);
        }
      }
      try {
        await updateTopPlayers(interaction.client, leagueId, snap, effectiveCurrentWeekUsed, {
          isWildcard,
          postChannelId: '1462629502864851069'
        });
      } catch (e) {
        criticalFailures.push('Top players');
        console.warn('[madden-weeklyupdate] top players update skipped:', e?.message || e);
      }
    }
    // Weekly awards (derived locally) — skip offseason and preseason
    try {
      const canPostAwards =
        hasWeeklyPlayersEffective &&
        (
          forceAwardsOnce ||
          (
            !statsPartial &&
            (!backfillOnlyAwards && !inOffseason && !inPreseason && seasonInfo.isWeeklyAwardsPeriodActive !== false && effectiveCurrentWeekUsed && effectiveCurrentWeekUsed <= 23)
          )
        );
      if (canPostAwards) {
        await updateAwards(interaction.client, leagueId, effectiveCurrentWeekUsed);
        if (forceAwardsOnce) {
          if (weeklyUpdateOverrides[leagueId]) {
            delete weeklyUpdateOverrides[leagueId].forceAwardsOnce;
            if (!Object.keys(weeklyUpdateOverrides[leagueId]).length) delete weeklyUpdateOverrides[leagueId];
            saveWeeklyUpdateOverrides(weeklyUpdateOverrides);
          }
          console.log('[madden-weeklyupdate] consumed one-time awards override', { leagueId, week: effectiveCurrentWeekUsed });
        }
      } else if (statsPartial) {
        console.warn('[madden-weeklyupdate] awards skipped: target week still partial');
      } else if (!hasWeeklyPlayersEffective) {
        console.warn('[madden-weeklyupdate] awards skipped: no player stats found for requested week');
      } else {
        console.warn('[madden-weeklyupdate] awards skipped (offseason, preseason, or awards period inactive)');
      }
    } catch (e) {
      criticalFailures.push('Awards');
      console.warn('[madden-weeklyupdate] awards update skipped:', e?.message || e);
    }
    // Debug: report which weeks have player stats
    try {
      const snapPath = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const ws = snap.weeklyStats || [];
      const withData = ws
        .filter(w => {
          const buckets = [
            w?.passing?.playerPassingStatInfoList,
            w?.rushing?.playerRushingStatInfoList,
            w?.receiving?.playerReceivingStatInfoList,
            w?.defense?.playerDefensiveStatInfoList,
          ];
          return buckets.some(b => Array.isArray(b) && b.length > 0);
        })
        .map(w => `W${w.weekIndex} (stage ${w.stage !== undefined ? w.stage : (w.stageIndex !== undefined ? w.stageIndex : 0)})`);
      console.log('[madden-weeklyupdate] weeklyStats with player data:', withData.join(', ') || 'none');
    } catch (e) {
      console.warn('[madden-weeklyupdate] weeklyStats debug skipped:', e?.message || e);
    }
    const weekLabel = (stage, wk, offSeasonStage = 0, seasonWeekType = stage) => {
      const st = seasonWeekType !== undefined ? seasonWeekType : stage;
      if (offSeasonStage > 0 && st === Stage.PRESEASON) return `Offseason Stage ${offSeasonStage}`;
      if (st === Stage.PRESEASON && wk >= 0 && wk <= 3) return `Preseason Week ${wk + 1}`;
      const display = wk + 1;
      if (st === Stage.SEASON && display >= 1 && display <= 18) return `Week ${display}`;
      if (display === 19) return 'Wildcard Round';
      if (display === 20) return 'Divisional Round';
      if (display === 21) return 'Conference Championship';
      if (display === 22) return 'Super Bowl Bye';
      if (display === 23) return 'Super Bowl';
      return `Stage ${st} Week ${wk + 1}`;
    };
    const displayWeekLabel = (stage, currentWeek, offSeasonStage = 0, seasonWeekType = stage) => {
      const st = seasonWeekType !== undefined ? seasonWeekType : stage;
      if (offSeasonStage > 0 && st === Stage.PRESEASON) return `Offseason Stage ${offSeasonStage}`;
      if (currentWeek === null || currentWeek === undefined) return 'unknown';
      const wkIdx = Math.max(0, Number(currentWeek) - 1);
      return weekLabel(st !== undefined ? st : 1, wkIdx, offSeasonStage, st);
    };
    let missingField = deduped.length
      ? deduped.map(w => `${weekLabel(w.stage, w.weekIndex, summary.offSeasonStage !== undefined ? summary.offSeasonStage : 0)} (players: ${w.playerCount})${w.runs && w.runs > 1 ? ` x${w.runs}` : ''}`).join('\n')
      : 'None';
    if (inOffseason && deduped.length === 0) {
      missingField = 'Offseason – no weekly player stats expected';
    }

    const offStageShown = inOffseason ? (summary.offSeasonStage !== undefined ? summary.offSeasonStage : (seasonInfo.offSeasonStage !== undefined ? seasonInfo.offSeasonStage : 0)) : 0;
    const weekLabelPretty = effectiveCurrentWeek
      ? displayWeekLabel(
        stageForWeek !== undefined ? stageForWeek : summary.stage,
        effectiveCurrentWeek,
        offStageShown,
        seasonInfo.seasonWeekType !== undefined ? seasonInfo.seasonWeekType : (stageForWeek !== undefined ? stageForWeek : summary.stage)
      )
      : (inOffseason ? `Offseason Stage ${offStageShown || 'unknown'}` : 'unknown');
    const weekFieldValue = weekLabelPretty;

    const partialUpdate = statsPartial;

    const embed = new EmbedBuilder()
      .setTitle(brandTitle(partialUpdate ? 'Madden Weekly Update Partial' : 'Madden Weekly Update Complete'))
      .setDescription(
        partialUpdate
          ? 'League data saved, but the target week still looks incomplete. Run it again once the week is fully finished.'
          : 'Latest data pulled and saved locally.'
      )
      .setColor(partialUpdate ? 0xf1c40f : 0x00cc66)
      .addFields(
        { name: 'League', value: String(summary.leagueId), inline: true },
        { name: 'Week', value: weekFieldValue, inline: true },
        { name: 'Teams', value: String(summary.teamsCount), inline: true },
        { name: 'Standings', value: String(summary.standingsCount), inline: true },
        { name: 'Games', value: String(summary.gamesCount), inline: true },
        { name: 'Missing player stats', value: missingField, inline: false },
        { name: 'Saved', value: summary.outPath, inline: false }
      );

    if (partialUpdate) {
      const notes = [];
      if (usedFallbackWeek) notes.push(`Used last completed week with stats: Week ${Number(effectiveCurrentWeekUsed || 0)}`);
      if (targetWeekMissing) notes.push('The current target week still looks incomplete.');
      if (lowPlayerCountWeek) notes.push(`Week ${Number(targetWeekIdx) + 1} player volume looks incomplete for this export.`);
      embed.addFields({ name: 'Update status', value: notes.join('\n').slice(0, 1024) || 'Partial update' });
    } else if (criticalFailures.length) {
      embed.addFields({
        name: 'Needs attention',
        value: `Some outputs need a follow-up check: ${[...new Set(criticalFailures)].join(', ')}`.slice(0, 1024),
      });
    }

    await interaction.editReply({ embeds: [embed] });

    try {
      const channelMap = JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8'));
      appendMaddenStaffLog({
        type: 'weekly_recap_queue_attempt',
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        hasWeeklyRecapChannel: Boolean(channelMap['Weekly Recap']),
      });
      const recapTargetWeek = queueRecapReviewOption && effectiveCurrentWeekUsed ? Number(effectiveCurrentWeekUsed) : null;
      const ctx = await buildStoryContext(interaction.guild, interaction.client, {
        skipCoachUserTeamMap: true,
        targetWeek: recapTargetWeek,
      });
      if (!ctx) {
        appendMaddenStaffLog({
          type: 'weekly_recap_queue_skipped_no_context',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
        });
      } else if (!channelMap['Weekly Recap']) {
        appendMaddenStaffLog({
          type: 'weekly_recap_queue_skipped_no_channel',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
        });
      } else {
        appendMaddenStaffLog({
          type: 'weekly_recap_context_ready',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
          targetWeek: recapTargetWeek,
        });
        const recap = buildWeeklyRecapData(ctx, { targetWeek: recapTargetWeek });
        const weekLabel = recap.currentWeek == null ? 'League Update Recap' : `Week ${recap.currentWeek + 1} Recap`;
        const recapEmbed = new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle(brandTitle(weekLabel))
          .setDescription((recap.paragraphs || [recap.leadStory]).join('\n\n'))
          .setTimestamp();

        appendMaddenStaffLog({
          type: queueRecapReviewOption ? 'weekly_recap_built_forced' : 'weekly_recap_built',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
          paragraphCount: Array.isArray(recap.paragraphs) ? recap.paragraphs.length : 0,
          targetWeek: recapTargetWeek,
        });

        const ghostRoleId = roleMap['Ghost Legacy'];

        await queueMaddenContentReview(interaction.client, interaction.guildId, {
          kind: 'weekly_recap',
          createdBy: interaction.user.id,
          targetChannelId: channelMap['Weekly Recap'],
          content: ghostRoleId ? `<@&${ghostRoleId}>` : null,
          embeds: [recapEmbed.toJSON()],
          previewAllowedMentions: { parse: [] },
          postAllowedMentions: { parse: ['roles'] },
        });
        appendMaddenStaffLog({
          type: queueRecapReviewOption ? 'weekly_recap_queued_forced' : 'weekly_recap_queued',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
          targetChannelId: channelMap['Weekly Recap'],
          targetWeek: recapTargetWeek,
        });
      }
    } catch (e) {
      criticalFailures.push('Weekly recap');
      console.warn('[madden-weeklyupdate] content/staff posts skipped:', e?.message || e);
      appendMaddenStaffLog({
        type: 'weekly_recap_queue_failed',
        guildId: interaction.guildId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        error: e?.message || String(e),
      });
    }
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Unknown error';
    // Surface more detail to the server logs for debugging (week override, stack)
    console.error('[madden-weeklyupdate] failed', {
      weekOverride,
      message: err?.message,
      stack: err?.stack
    });
    const lower = msg.toLowerCase();
    let shortType = 'Unknown';
    let guidance = 'Try again shortly.';
    if (lower.includes('no local ea tokens')) {
      shortType = 'Tokens missing';
      guidance = 'Run `/madden-auth` (or `/madden-auth reset` then `/madden-auth`), then rerun `/madden-weeklyupdate`.';
    } else if (lower.includes('no sessionkey') || lower.includes('auth_err_invalid_token') || lower.includes('server information was not found')) {
      shortType = 'Auth/session';
      guidance = 'Tokens look bad. Run `/madden-auth reset` then `/madden-auth` (PS5 Madden 2026 account), ensure `EA_CONSOLE=ps5` / `EA_GAME_YEAR=2026`, then rerun `/madden-weeklyupdate`.';
    } else if (lower.includes('deleted') || lower.includes('league')) {
      shortType = 'League ID';
      guidance = 'Check the league ID. Run `/madden-set-league <your_league_id>` then rerun `/madden-weeklyupdate`.';
    }
    const shortMsg = shortType;
    const embed = new EmbedBuilder()
      .setTitle(brandTitle('Madden Update Failed'))
      .setDescription(shortMsg)
      .addFields({ name: 'Next steps', value: guidance })
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
