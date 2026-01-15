import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
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
import { saveTradeCounts, updateTradeCountsEmbed } from '../../../utils/madden_trade_utils.js';
import { updateAwards } from '../../../madden/awards.js';
import { maybePostDraftGrades } from '../../../madden/draft_grades_auto.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const POWER_RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');

const data = new SlashCommandBuilder()
  .setName('madden-weeklyupdate')
  .setDescription('Refresh Madden data for the saved league (staff-only, run after each advance).')
  .addIntegerOption(o => o.setName('week').setDescription('Override current week for sync (optional)').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

async function execute(interaction) {
  await interaction.deferReply();
  try {
    const weekOverride = interaction.options.getInteger('week');
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
      return;
    }
    const provider = new SnallabotProvider();
    const summary = await runSync(leagueId, provider, { week: weekOverride });
    // Load the freshly written snapshot so we can use richer context (stage per week, season info flags)
    const snapPath = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
    let snap = null;
    try {
      snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    } catch { }
    const seasonInfo = snap?.info?.careerHubInfo?.seasonInfo || {};
    // Derive a week if missing: prefer summary.currentWeek, else displayWeek, else highest regular-season weeklyStats index + 1
    const derivedWeekFromStats = (() => {
      const regWeeks = (snap?.weeklyStats || []).filter(w => Number(w.stage ?? w.stageIndex ?? 1) === 1);
      if (!regWeeks.length) return 0;
      const maxIdx = Math.max(...regWeeks.map(w => Number(w.weekIndex ?? -1)).filter(n => n >= 0));
      return maxIdx >= 0 ? maxIdx + 1 : 0;
    })();
    const currentWeekValue = summary.currentWeek && summary.currentWeek > 0
      ? summary.currentWeek
      : (seasonInfo.displayWeek && seasonInfo.displayWeek > 0
        ? seasonInfo.displayWeek
        : derivedWeekFromStats);
    const currentWeekIndex = currentWeekValue > 0 ? currentWeekValue - 1 : null;
    const weekEntry = snap?.weeklyStats?.find(w => w.weekIndex === currentWeekIndex);
    const seasonWeekType = seasonInfo.seasonWeekType;
    // Derive stage: prefer seasonWeekType (0=pre,1=reg,2=post), else weekEntry.stage for playoffs, else summary.stage
    let stageForWeek = Stage.SEASON;
    if (typeof seasonWeekType === 'number') {
      stageForWeek = seasonWeekType === 0 ? Stage.PRESEASON : Stage.SEASON;
    } else if (summary.stage !== undefined) {
      stageForWeek = summary.stage;
    }
    if (weekEntry?.stage !== undefined && (weekEntry.weekIndex ?? 0) >= 18) {
      stageForWeek = weekEntry.stage;
    }
    // If we have a numbered week (>=1), force SEASON stage even if the export mislabels it as preseason
    if (currentWeekValue >= 1) {
      stageForWeek = Stage.SEASON;
    }
    let inOffseason = (summary.offSeasonStage ?? seasonInfo.offSeasonStage ?? 0) > 0;
    // If we're clearly in a numbered week, treat as in-season even if offSeasonStage lingered
    if (stageForWeek === Stage.SEASON && currentWeekValue >= 1) {
      inOffseason = false;
    }
    const inPreseason = stageForWeek === Stage.PRESEASON && currentWeekValue < 1;
    const inRegularSeason = stageForWeek === Stage.SEASON && currentWeekValue >= 1 && currentWeekValue <= 18 && !inOffseason && !inPreseason;
    const isWildcard = currentWeekValue === 19; // allow one last pull to capture Week 18 data
    // Update pins during regular season and Wild Card week; freeze afterward
    const allowPinnedUpdates = (inRegularSeason || isWildcard) && !inOffseason && !inPreseason;
    const effectiveCurrentWeek = currentWeekValue;

    // On the first week of a new season (preseason), reset trade counts but keep pins
    if (inPreseason) {
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
    } else if (allowPinnedUpdates) {
      try {
        await updateStatLeaders(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] stat leaders update skipped:', e?.message || e);
      }
    } else {
      console.warn('[madden-weeklyupdate] stat leaders skipped (not regular season)');
    }

    if (allowPinnedUpdates) {
      try {
        await updateStandings(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] standings update skipped:', e?.message || e);
      }
      try {
        await updatePlayoffPicture(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] playoff picture update skipped:', e?.message || e);
      }
      try {
        await updatePowerRankings(interaction.client, leagueId);
      } catch (e) {
        console.warn('[madden-weeklyupdate] power rankings update skipped:', e?.message || e);
      }
    } else {
      console.warn('[madden-weeklyupdate] standings/playoff picture/power rankings skipped (offseason/preseason or after Wild Card)');
    }
    // Post weekly transactions
    try {
      await updateTransactions(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] transactions update skipped:', e?.message || e);
    }
    const isSuperBowlBye = effectiveCurrentWeek === 22;
    // Player change log (position/attribute/dev changes) — skip bye week
    if (!isSuperBowlBye) {
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
      // Weekly awards (derived locally) — skip offseason and preseason
      try {
        if (!inOffseason && !inPreseason && seasonInfo.isWeeklyAwardsPeriodActive !== false && effectiveCurrentWeek && effectiveCurrentWeek <= 23) {
          await updateAwards(interaction.client, leagueId, effectiveCurrentWeek);
        } else {
          console.warn('[madden-weeklyupdate] awards skipped (offseason, preseason, or awards period inactive)');
        }
      } catch (e) {
        console.warn('[madden-weeklyupdate] awards update skipped:', e?.message || e);
      }
    } else {
      console.warn('[madden-weeklyupdate] bye week between Conference and Super Bowl: skipping player changes/injuries/awards');
    }
    // Draft grades auto-post (after draft recap)
    try {
      await maybePostDraftGrades(interaction.client, leagueId);
    } catch (e) {
      console.warn('[madden-weeklyupdate] draft grades skipped:', e?.message || e);
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
        .map(w => `W${w.weekIndex} (stage ${w.stage ?? w.stageIndex ?? 0})`);
      console.log('[madden-weeklyupdate] weeklyStats with player data:', withData.join(', ') || 'none');
    } catch (e) {
      console.warn('[madden-weeklyupdate] weeklyStats debug skipped:', e?.message || e);
    }
    // Only surface weeks where we actually missed players
    const missingWeeks = (summary.missingWeeks || []).filter(w => (w.playerCount ?? 0) > 0);
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
        existing.playerCount = w.playerCount ?? existing.playerCount;
      }
    });
    const weekLabel = (stage, wk, offSeasonStage = 0, seasonWeekType = stage) => {
      const st = seasonWeekType ?? stage;
      if (offSeasonStage > 0) return `Offseason Stage ${offSeasonStage}`;
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
      const st = seasonWeekType ?? stage;
      if (offSeasonStage > 0) return `Offseason Stage ${offSeasonStage}`;
      if (currentWeek === null || currentWeek === undefined) return 'unknown';
      const wkIdx = Math.max(0, Number(currentWeek) - 1);
      return weekLabel(st ?? 1, wkIdx, offSeasonStage, st);
    };
    let missingField = deduped.length
      ? deduped.map(w => `${weekLabel(w.stage, w.weekIndex, summary.offSeasonStage ?? 0)} (players: ${w.playerCount})${w.runs && w.runs > 1 ? ` x${w.runs}` : ''}`).join('\n')
      : 'None';
    if (inOffseason && deduped.length === 0) {
      missingField = 'Offseason – no weekly player stats expected';
    }

    const weekLabelPretty = effectiveCurrentWeek
      ? displayWeekLabel(
          stageForWeek ?? summary.stage,
          effectiveCurrentWeek,
          summary.offSeasonStage ?? (seasonInfo.offSeasonStage ?? 0),
          seasonInfo.seasonWeekType ?? stageForWeek ?? summary.stage
        )
      : (inOffseason ? `Offseason Stage ${summary.offSeasonStage ?? (seasonInfo.offSeasonStage ?? 'unknown')}` : 'unknown');
    const weekFieldValue = weekLabelPretty;

    const embed = new EmbedBuilder()
      .setTitle('Madden Weekly Update Complete')
      .setDescription('Latest data pulled and saved locally.')
      .setColor(0x00cc66)
      .addFields(
        { name: 'League', value: String(summary.leagueId), inline: true },
        { name: 'Week', value: weekFieldValue, inline: true },
        { name: 'Teams', value: String(summary.teamsCount), inline: true },
        { name: 'Standings', value: String(summary.standingsCount), inline: true },
        { name: 'Games', value: String(summary.gamesCount), inline: true },
        { name: 'Missing player stats', value: missingField, inline: false },
        { name: 'Saved', value: summary.outPath, inline: false }
      );
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Unknown error';
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
      .setTitle('Madden Update Failed')
      .setDescription(shortMsg)
      .addFields({ name: 'Next steps', value: guidance })
      .setColor(0xcc0000);
    await interaction.editReply({ embeds: [embed] });
  }
}

export default { data, execute };
