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
import { appendMaddenStaffLog, postMaddenStaffLog } from '../../shared/madden_staff_ops.js';
import { applyRecognitionBackfill, finalizeRecognitionWeek, getRecognitionLeaderboard, RECOGNITION_ECONOMY, resolveRecognitionDoubleOrNothing, resolveRecognitionGameOfWeek, resolveRecognitionWeeklyLegacy } from '../../shared/league_recognition.js';
import { settleSportsbookWeek } from '../../shared/madden_sportsbook.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { getCoachAssignmentMap, setCoachAssignment } from '../../shared/madden_coach_assignments.js';
import { getMaddenSeasonKey } from '../../shared/madden_metadata.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const POWER_RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');
const SCOUT_POINTS_FILE = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const WEEKLY_UPDATE_OVERRIDES_FILE = path.join(process.cwd(), 'data', 'madden', 'weekly_update_overrides.json');
const SCOUT_LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const STAFF_ACTIVITY_LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'staff_activity_log.json');
const FAIRSIMS_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const WEEKLY_GAME_LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'weekly_game_log.json');
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');
const RECOGNITION_BACKFILL_VERSION = 'metadata_v12_recent_legacy_profile';

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

function safeReadJSON(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeName(name = '') {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodeSignedByte(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return num > 127 ? num - 256 : num;
}

function loadHistoricalSnapshot(leagueId, currentYear) {
  const snapshot = safeReadJSON(path.join(process.cwd(), 'data', 'madden', 'leagues', 'previous', `${leagueId}.json`), null);
  const snapshotYear = Number(snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || 0);
  if (!snapshot || !snapshotYear || snapshotYear >= Number(currentYear || 0)) return null;
  return snapshot;
}

function buildSnapshotTeamEntries(snap = null) {
  const teams = snap?.teams?.leagueTeamInfoList || [];
  return teams.map((team) => {
    const aliases = new Set([
      team?.displayName,
      team?.nickName,
      team?.cityName,
      team?.abbrName,
      getFullTeamName(team, `Team ${team.teamId}`),
    ].filter(Boolean).map((value) => normalizeName(value)));
    return {
      teamId: Number(team.teamId),
      aliases,
      fullName: getFullTeamName(team, `Team ${team.teamId}`),
      divisionId: team?.divisionId,
    };
  });
}

function findSnapshotTeamForCoachBase(baseName, teamEntries = []) {
  const target = normalizeName(baseName);
  if (!target) return null;
  for (const entry of teamEntries) {
    if (entry.aliases.has(target)) return entry;
  }
  for (const entry of teamEntries) {
    if ([...entry.aliases].some((alias) => alias.includes(target) || target.includes(alias))) return entry;
  }
  return null;
}

async function buildCoachAssignmentIndex(guild, roleMap = {}, snap = null) {
  const aliasToUserIds = new Map();
  const teamIdToUserIds = new Map();
  const coachUserIds = new Set();
  const teamEntries = buildSnapshotTeamEntries(snap);
  const persistedAssignments = getCoachAssignmentMap({ guildId: guild?.id });

  try {
    await guild?.members?.fetch?.();
  } catch (error) {
    console.warn('[madden-weeklyupdate] coach assignment member fetch skipped:', error?.message || error);
  }

  for (const [roleName, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(roleName)) continue;
    const role = guild?.roles?.cache?.get(roleId);
    const cachedRoleMembers = [...(role?.members?.keys?.() || [])].map(String);
    const scannedRoleMembers = guild?.members?.cache
      ? [...guild.members.cache.values()]
          .filter((member) => member?.roles?.cache?.has?.(roleId))
          .map((member) => String(member.id))
      : [];
    const userIds = [...new Set([...cachedRoleMembers, ...scannedRoleMembers])];
    if (!userIds.length) continue;
    const baseName = roleName.replace(/ coach$/i, '').trim();
    const teamEntry = findSnapshotTeamForCoachBase(baseName, teamEntries);
    for (const userId of userIds) {
      setCoachAssignment({
        guildId: guild?.id,
        userId,
        teamName: baseName,
        roleId,
      });
    }
    aliasToUserIds.set(normalizeName(baseName), userIds);
    if (teamEntry) {
      teamIdToUserIds.set(Number(teamEntry.teamId), userIds);
      for (const alias of teamEntry.aliases) aliasToUserIds.set(alias, userIds);
    }
    for (const userId of userIds) coachUserIds.add(userId);
  }

  for (const [normalizedTeam, userIdSet] of persistedAssignments.teamToUserIds.entries()) {
    const userIds = [...userIdSet].map(String);
    if (!userIds.length) continue;
    const teamEntry = teamEntries.find((entry) => [...entry.aliases].some((alias) => alias === normalizedTeam));
    aliasToUserIds.set(normalizedTeam, userIds);
    if (teamEntry) {
      teamIdToUserIds.set(Number(teamEntry.teamId), userIds);
      for (const alias of teamEntry.aliases) aliasToUserIds.set(alias, userIds);
    }
    for (const userId of userIds) coachUserIds.add(userId);
  }

  return {
    coachUserIds,
    resolveByTeam(teamId, teamName) {
      if (teamIdToUserIds.has(Number(teamId))) return teamIdToUserIds.get(Number(teamId)) || [];
      return aliasToUserIds.get(normalizeName(teamName)) || [];
    },
  };
}

function addBackfillAward(bucket, userId, tier, amount, reason, weekKey = null) {
  const normalizedUserId = String(userId || '');
  const normalizedTier = String(tier || '');
  const points = Number(amount || 0);
  if (!normalizedUserId || !['activity', 'impact', 'legacy'].includes(normalizedTier) || points <= 0) return;
  bucket.push({
    userId: normalizedUserId,
    tier: normalizedTier,
    amount: points,
    reason,
    weekKey,
  });
}

async function buildRecognitionBackfillPayload({
  guildId,
  leagueId,
  seasonKey,
  currentWeekValue,
  snap,
  guild,
  roleMap,
}) {
  const year = Number(String(seasonKey || '').replace(/^year_/, '')) || new Date().getFullYear();
  const priorYear = year - 1;
  const seasonStartTs = new Date(year, 0, 1).getTime();
  const priorSeasonStartTs = new Date(priorYear, 0, 1).getTime();
  const currentSeasonStartTs = seasonStartTs;
  const closedWeekLimit = Math.max(1, Number(currentWeekValue || 1));
  const awards = [];
  const interactionCounts = {};
  const summary = {
    activity: { coaches: 0, points: 0 },
    impact: { coaches: 0, points: 0 },
    legacy: { coaches: 0, points: 0 },
    carryover2025: { coaches: 0, points: 0 },
  };
  const coachIndex = await buildCoachAssignmentIndex(guild, roleMap, snap);
  const coachUserIds = coachIndex.coachUserIds;
  const touchedByTier = {
    activity: new Set(),
    impact: new Set(),
    legacy: new Set(),
  };
  const carryoverCoaches = new Set();

  const recordSummary = (userId, tier, amount) => {
    if (amount <= 0) return;
    summary[tier].points += amount;
    touchedByTier[tier].add(String(userId));
  };

  const scoutLog = safeReadJSON(SCOUT_LOG_FILE, []);
  const staffLog = safeReadJSON(STAFF_ACTIVITY_LOG_FILE, []);
  const fairsimStore = safeReadJSON(FAIRSIMS_FILE, {});
  const weeklyGameLog = safeReadJSON(WEEKLY_GAME_LOG_FILE, {});
  const awardsStore = safeReadJSON(AWARDS_FILE, {});
  const knownCoachUserIds = new Set([...coachUserIds]);

  const seasonFairsim = fairsimStore?.[seasonKey] || {};
  const comms = seasonFairsim?.communication || {};
  const weightedCounts = seasonFairsim?.weightedCounts || {};
  for (const userId of Object.keys(comms || {})) knownCoachUserIds.add(String(userId));
  for (const userId of Object.keys(weightedCounts || {})) knownCoachUserIds.add(String(userId));
  for (const userId of coachIndex.coachUserIds || []) {
    addBackfillAward(awards, userId, 'impact', 40, 'Recognition backfill: launch impact grant for current coach');
    recordSummary(userId, 'impact', 40);
  }
  for (const userId of knownCoachUserIds) {
    const comm = comms?.[userId];
    if (!comm) continue;
    const respondedWeeks = Number(comm.respondedWeeks || 0);
    const onTimeOutcomes = Number(comm.onTimeOutcomes || 0);
    const faultOutcomes = Number(comm.faultOutcomes || 0);
    const weighted = Number(weightedCounts?.[userId] || 0);
    if (respondedWeeks > 0) {
      addBackfillAward(awards, userId, 'activity', respondedWeeks, 'Recognition backfill: responded game-thread weeks');
      recordSummary(userId, 'activity', respondedWeeks);
    }
    if (onTimeOutcomes > 0) {
      const points = onTimeOutcomes * 2;
      addBackfillAward(awards, userId, 'activity', points, 'Recognition backfill: on-time game outcomes');
      recordSummary(userId, 'activity', points);
    }
    if (respondedWeeks >= 3 && faultOutcomes === 0 && weighted === 0) {
      addBackfillAward(awards, userId, 'activity', 2, 'Recognition backfill: clean reliability history');
      recordSummary(userId, 'activity', 2);
    }
  }

  const priorSeasonKey = `year_${priorYear}`;
  const priorSeasonFairsim = fairsimStore?.[priorSeasonKey] || {};
  const priorComms = priorSeasonFairsim?.communication || {};
  const priorWeightedCounts = priorSeasonFairsim?.weightedCounts || {};
  for (const userId of Object.keys(priorComms || {})) knownCoachUserIds.add(String(userId));
  for (const userId of Object.keys(priorWeightedCounts || {})) knownCoachUserIds.add(String(userId));
  for (const userId of knownCoachUserIds) {
    const comm = priorComms?.[userId];
    if (!comm) continue;
    const respondedWeeks = Number(comm.respondedWeeks || 0);
    const onTimeOutcomes = Number(comm.onTimeOutcomes || 0);
    const faultOutcomes = Number(comm.faultOutcomes || 0);
    const weighted = Number(priorWeightedCounts?.[userId] || 0);
    let carryover = 0;
    if (respondedWeeks >= 4) carryover += Math.min(2, Math.floor(respondedWeeks / 4));
    if (onTimeOutcomes >= 4) carryover += 1;
    if (respondedWeeks >= 6 && faultOutcomes === 0 && weighted === 0) carryover += 1;
    if (carryover > 0) {
      addBackfillAward(awards, userId, 'activity', carryover, `Recognition backfill: ${priorYear} carryover reliability`);
      recordSummary(userId, 'activity', carryover);
      summary.carryover2025.points += carryover;
      carryoverCoaches.add(String(userId));
    }
  }

  const scoutByUser = new Map();
  for (const entry of Array.isArray(scoutLog) ? scoutLog : []) {
    if (String(entry?.guildId || '') !== String(guildId)) continue;
    if (Number(entry?.seasonYear || 0) !== year) continue;
    if (!knownCoachUserIds.has(String(entry?.userId || ''))) knownCoachUserIds.add(String(entry?.userId || ''));
    const currentWeek = Number(entry?.currentWeek || 0);
    if (currentWeek <= 0 || currentWeek >= closedWeekLimit) continue;
    const userId = String(entry.userId);
    const current = scoutByUser.get(userId) || { weeks: new Set(), total: 0 };
    current.weeks.add(currentWeek);
    current.total += 1;
    scoutByUser.set(userId, current);
  }
  for (const [userId, data] of scoutByUser.entries()) {
    const weekPoints = data.weeks.size;
    const volumeBonus = Math.min(4, Math.floor(Number(data.total || 0) / 8));
    if (weekPoints > 0) {
      addBackfillAward(awards, userId, 'activity', weekPoints, 'Recognition backfill: scouting weeks already logged');
      recordSummary(userId, 'activity', weekPoints);
    }
    if (volumeBonus > 0) {
      addBackfillAward(awards, userId, 'activity', volumeBonus, 'Recognition backfill: deeper scouting volume already logged');
      recordSummary(userId, 'activity', volumeBonus);
    }
  }

  const priorScoutByUser = new Map();
  for (const entry of Array.isArray(scoutLog) ? scoutLog : []) {
    if (String(entry?.guildId || '') !== String(guildId)) continue;
    if (Number(entry?.seasonYear || 0) !== priorYear) continue;
    if (!knownCoachUserIds.has(String(entry?.userId || ''))) knownCoachUserIds.add(String(entry?.userId || ''));
    const userId = String(entry.userId);
    const current = priorScoutByUser.get(userId) || { weeks: new Set(), total: 0 };
    current.weeks.add(Number(entry?.currentWeek || 0));
    current.total += 1;
    priorScoutByUser.set(userId, current);
  }
  for (const [userId, data] of priorScoutByUser.entries()) {
    const carryover = Math.min(3, Math.floor(Number(data.total || 0) / 20) + (data.weeks.size >= 5 ? 1 : 0));
    if (carryover > 0) {
      addBackfillAward(awards, userId, 'activity', carryover, `Recognition backfill: ${priorYear} scouting carryover`);
      recordSummary(userId, 'activity', carryover);
      summary.carryover2025.points += carryover;
      carryoverCoaches.add(String(userId));
    }
  }

  const commandStats = new Map();
  for (const entry of Array.isArray(staffLog) ? staffLog : []) {
    if (entry?.type !== 'command') continue;
    if (String(entry?.guildId || '') !== String(guildId)) continue;
    if (Number(entry?.ts || 0) < seasonStartTs) continue;
    const userId = String(entry?.userId || '');
    const command = String(entry?.command || '');
    if (!command.startsWith('madden-')) continue;
    if (command === 'madden-weeklyupdate') continue;
    knownCoachUserIds.add(userId);
    const current = commandStats.get(userId) || { total: 0, strategy: 0, stream: 0, frontOffice: 0 };
    current.total += 1;
    if (command === 'madden-gamestrategy') current.strategy += 1;
    if (command === 'madden-streamlink') current.stream += 1;
    if (['madden-scout', 'madden-myscouts', 'madden-draftprimer', 'madden-franchisehub', 'madden-recruiting', 'madden-tradeblock', 'madden-mockdraft'].includes(command)) {
      current.frontOffice += 1;
    }
    commandStats.set(userId, current);
  }
  for (const [userId, data] of commandStats.entries()) {
    interactionCounts[userId] = (interactionCounts[userId] || 0) + Number(data.total || 0);
    const engagementBonus = Math.min(3, Math.floor(Number(data.total || 0) / 8));
    const strategyBonus = Number(data.strategy || 0) >= 2 ? 1 : 0;
    const streamBonus = Number(data.stream || 0) >= 2 ? 1 : 0;
    const frontOfficeBonus = Number(data.frontOffice || 0) >= 4 ? 1 : 0;
    const totalPoints = engagementBonus + strategyBonus + streamBonus + frontOfficeBonus;
    if (totalPoints > 0) {
      addBackfillAward(awards, userId, 'activity', totalPoints, 'Recognition backfill: existing bot interaction and prep usage');
      recordSummary(userId, 'activity', totalPoints);
    }
  }

  const priorCommandStats = new Map();
  for (const entry of Array.isArray(staffLog) ? staffLog : []) {
    if (entry?.type !== 'command') continue;
    if (String(entry?.guildId || '') !== String(guildId)) continue;
    const ts = Number(entry?.ts || 0);
    if (ts < priorSeasonStartTs || ts >= currentSeasonStartTs) continue;
    const userId = String(entry?.userId || '');
    const command = String(entry?.command || '');
    if (!command.startsWith('madden-')) continue;
    if (command === 'madden-weeklyupdate') continue;
    knownCoachUserIds.add(userId);
    const current = priorCommandStats.get(userId) || { total: 0, strategy: 0, stream: 0, frontOffice: 0 };
    current.total += 1;
    if (command === 'madden-gamestrategy') current.strategy += 1;
    if (command === 'madden-streamlink') current.stream += 1;
    if (['madden-scout', 'madden-myscouts', 'madden-draftprimer', 'madden-franchisehub', 'madden-recruiting', 'madden-tradeblock', 'madden-mockdraft'].includes(command)) {
      current.frontOffice += 1;
    }
    priorCommandStats.set(userId, current);
  }
  for (const [userId, data] of priorCommandStats.entries()) {
    const carryoverInteraction = Math.min(6, Math.floor(Number(data.total || 0) / 6));
    if (carryoverInteraction > 0) interactionCounts[userId] = (interactionCounts[userId] || 0) + carryoverInteraction;
    const carryoverPoints = Math.min(2, Math.floor(Number(data.total || 0) / 12)) + (Number(data.strategy || 0) >= 4 ? 1 : 0);
    if (carryoverPoints > 0) {
      addBackfillAward(awards, userId, 'activity', carryoverPoints, `Recognition backfill: ${priorYear} bot engagement carryover`);
      recordSummary(userId, 'activity', carryoverPoints);
      summary.carryover2025.points += carryoverPoints;
      carryoverCoaches.add(String(userId));
    }
  }

  const leagueGameLog = weeklyGameLog?.[String(leagueId)] || {};
  const regularSeasonGames = [...(leagueGameLog?.games || [])]
    .filter((game) => Number(game?.stageIndex ?? game?.stage ?? 1) === 1)
    .filter((game) => game?.played === true)
    .filter((game) => Number(game?.weekIndex ?? -1) + 1 < closedWeekLimit)
    .sort((a, b) => {
      const weekDiff = Number(a?.weekIndex ?? 0) - Number(b?.weekIndex ?? 0);
      if (weekDiff) return weekDiff;
      return Number(a?.scheduleId ?? 0) - Number(b?.scheduleId ?? 0);
    });
  const recentGamesByTeam = new Map();
  const pushRecentGame = (teamId, game) => {
    const key = Number(teamId);
    if (!recentGamesByTeam.has(key)) recentGamesByTeam.set(key, []);
    recentGamesByTeam.get(key).push(game);
  };
  const records = new Map();
  const ensureRecord = (teamId) => {
    if (!records.has(Number(teamId))) records.set(Number(teamId), { wins: 0, losses: 0 });
    return records.get(Number(teamId));
  };
  for (const game of regularSeasonGames) {
    const awayTeamId = Number(game.awayTeamId);
    const homeTeamId = Number(game.homeTeamId);
    const awayRecord = ensureRecord(awayTeamId);
    const homeRecord = ensureRecord(homeTeamId);
    const awayWins = Number(awayRecord.wins || 0);
    const awayLosses = Number(awayRecord.losses || 0);
    const homeWins = Number(homeRecord.wins || 0);
    const homeLosses = Number(homeRecord.losses || 0);
    const awayGames = awayWins + awayLosses;
    const homeGames = homeWins + homeLosses;
    const awayScore = Number(game.awayScore || 0);
    const homeScore = Number(game.homeScore || 0);
    if (awayScore === homeScore) continue;
    pushRecentGame(awayTeamId, {
      weekNumber: Number(game.weekIndex) + 1,
      pointsFor: awayScore,
      pointsAgainst: homeScore,
      opponentTeamId: homeTeamId,
      won: awayScore > homeScore,
      margin: awayScore - homeScore,
    });
    pushRecentGame(homeTeamId, {
      weekNumber: Number(game.weekIndex) + 1,
      pointsFor: homeScore,
      pointsAgainst: awayScore,
      opponentTeamId: awayTeamId,
      won: homeScore > awayScore,
      margin: homeScore - awayScore,
    });

    const winnerIsAway = awayScore > homeScore;
    const winnerTeamId = winnerIsAway ? awayTeamId : homeTeamId;
    const loserTeamId = winnerIsAway ? homeTeamId : awayTeamId;
    const winnerWins = winnerIsAway ? awayWins : homeWins;
    const winnerGames = winnerIsAway ? awayGames : homeGames;
    const loserWins = winnerIsAway ? homeWins : awayWins;
    const loserGames = winnerIsAway ? homeGames : awayGames;
    const winnerTeam = winnerIsAway ? game.awayTeam : game.homeTeam;
    const margin = Math.abs(awayScore - homeScore);
    const winnerWinPct = winnerGames > 0 ? winnerWins / winnerGames : 0;
    const loserWinPct = loserGames > 0 ? loserWins / loserGames : 0;
    const upset = (loserWins - winnerWins) >= 2 || (winnerGames >= 2 && loserGames >= 2 && (loserWinPct - winnerWinPct) >= 0.25);
    const statement = !upset && margin >= 14 && (loserWins >= loserGames || loserWins >= 3);
    const weekKey = `week_${Number(game.weekIndex) + 1}`;
    const winnerUserIds = coachIndex.resolveByTeam(winnerTeamId, winnerTeam);
    if (upset) {
      for (const userId of winnerUserIds) {
        addBackfillAward(awards, userId, 'impact', 2, 'Recognition backfill: upset win already on the books', weekKey);
        recordSummary(userId, 'impact', 2);
      }
    } else if (statement) {
      for (const userId of winnerUserIds) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: statement win already on the books', weekKey);
        recordSummary(userId, 'impact', 1);
      }
    }

    if (winnerIsAway) {
      awayRecord.wins += 1;
      homeRecord.losses += 1;
    } else {
      homeRecord.wins += 1;
      awayRecord.losses += 1;
    }
  }

  const leagueAwards = awardsStore?.[String(leagueId)] || {};
  const teamAwardTotals = new Map();
  const recentAwardTotals = new Map();
  const recentWeekFloor = Math.max(1, closedWeekLimit - 5);
  for (const [weekRaw, weeklyAwards] of Object.entries(leagueAwards || {})) {
    const weekNumber = Number(weekRaw || 0);
    if (!weekNumber || weekNumber >= closedWeekLimit) continue;
    const perUserWeek = new Map();
    for (const award of Object.values(weeklyAwards || {})) {
      if (!award) continue;
      const userIds = coachIndex.resolveByTeam(award.teamId, award.teamName || award.team);
      for (const userId of userIds) {
        perUserWeek.set(userId, (perUserWeek.get(userId) || 0) + 1);
        teamAwardTotals.set(userId, (teamAwardTotals.get(userId) || 0) + 1);
        if (weekNumber >= recentWeekFloor) {
          recentAwardTotals.set(userId, (recentAwardTotals.get(userId) || 0) + 1);
        }
      }
    }
    for (const [userId, count] of perUserWeek.entries()) {
      const points = Math.min(2, Number(count || 0));
      if (points <= 0) continue;
      addBackfillAward(awards, userId, 'impact', points, 'Recognition backfill: weekly award representation', `week_${weekNumber}`);
      recordSummary(userId, 'impact', points);
    }
  }

  const standings = snap?.standings?.teamStandingInfoList || [];
  const standingsByTeamId = new Map(standings.map((standing) => [Number(standing?.teamId), standing]));
  const historicalSnapshot = loadHistoricalSnapshot(leagueId, year);
  const historicalStandings = historicalSnapshot?.standings?.teamStandingInfoList || [];
  for (const standing of standings) {
    const userIds = coachIndex.resolveByTeam(standing.teamId, standing.teamName);
    if (!userIds.length) continue;
    const wins = Number(standing.totalWins || 0);
    const losses = Number(standing.totalLosses || 0);
    const netPts = Number(standing.netPts || 0);
    const seed = Number(standing.seed || 99);
    const offRank = Number(standing.offTotalYdsRank || 99);
    const defRank = Number(standing.defTotalYdsRank || 99);
    const streakValue = decodeSignedByte(standing.winLossStreak);
    const gamesPlayed = wins + losses;
    const winPct = gamesPlayed > 0 ? wins / gamesPlayed : 0;
    for (const userId of userIds) {
      let seasonProfileImpact = 0;
      if (winPct >= 0.8) seasonProfileImpact += 5;
      else if (winPct >= 0.6) seasonProfileImpact += 4;
      else if (winPct >= 0.5) seasonProfileImpact += 3;
      else if (winPct >= 0.4) seasonProfileImpact += 2;
      else seasonProfileImpact += 1;
      if (netPts >= 50) seasonProfileImpact += 2;
      else if (netPts >= 20) seasonProfileImpact += 1;
      if (seed > 0 && seed <= 4) seasonProfileImpact += 2;
      else if (seed > 0 && seed <= 7) seasonProfileImpact += 1;
      addBackfillAward(awards, userId, 'impact', seasonProfileImpact, 'Recognition backfill: current season profile');
      recordSummary(userId, 'impact', seasonProfileImpact);

      if (wins >= 4 && winPct >= 0.6) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: strong current form already established');
        recordSummary(userId, 'impact', 1);
      }
      if (netPts >= 35) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: driving convincing weekly results');
        recordSummary(userId, 'impact', 1);
      }
      if (streakValue >= 3) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: active win streak');
        recordSummary(userId, 'impact', 1);
      }
      if (offRank > 0 && offRank <= 5) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: top-five offense profile');
        recordSummary(userId, 'impact', 1);
      }
      if (defRank > 0 && defRank <= 5) {
        addBackfillAward(awards, userId, 'impact', 1, 'Recognition backfill: top-five defense profile');
        recordSummary(userId, 'impact', 1);
      }
      if (seed > 0 && seed <= RECOGNITION_ECONOMY.legacy.currentSeason.earlyPlayoffPositioning.seedMax) {
        addBackfillAward(awards, userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.earlyPlayoffPositioning.amount, 'Recognition backfill: early playoff positioning');
        recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.earlyPlayoffPositioning.amount);
      }
    }
  }

  if (historicalStandings.length) {
    const historicalDivisionLeaders = new Map();
    for (const standing of historicalStandings) {
      const divisionId = String(standing?.divisionId || '');
      const current = historicalDivisionLeaders.get(divisionId);
      const score = [Number(standing?.winPct || 0), Number(standing?.totalWins || 0), Number(standing?.netPts || 0)];
      const currentScore = current
        ? [Number(current?.winPct || 0), Number(current?.totalWins || 0), Number(current?.netPts || 0)]
        : null;
      if (!current || score[0] > currentScore[0] || (score[0] === currentScore[0] && score[1] > currentScore[1]) || (score[0] === currentScore[0] && score[1] === currentScore[1] && score[2] > currentScore[2])) {
        historicalDivisionLeaders.set(divisionId, standing);
      }
    }
    for (const leader of historicalDivisionLeaders.values()) {
      const userIds = coachIndex.resolveByTeam(leader.teamId, leader.teamName);
      for (const userId of userIds) {
        addBackfillAward(awards, userId, 'legacy', 1, `Recognition backfill: ${priorYear} division lead carryover`);
        recordSummary(userId, 'legacy', 1);
      }
    }
    for (const standing of historicalStandings) {
      const userIds = coachIndex.resolveByTeam(standing.teamId, standing.teamName);
      if (!userIds.length) continue;
      const wins = Number(standing.totalWins || 0);
      const losses = Number(standing.totalLosses || 0);
      const seed = Number(standing.seed || 0);
      const netPts = Number(standing.netPts || 0);
      for (const userId of userIds) {
        if (wins >= 10) {
          addBackfillAward(awards, userId, 'impact', 1, `Recognition backfill: ${priorYear} strong season carryover`);
          recordSummary(userId, 'impact', 1);
        }
        if (seed === 1) {
          addBackfillAward(awards, userId, 'legacy', 1, `Recognition backfill: ${priorYear} conference top seed carryover`);
          recordSummary(userId, 'legacy', 1);
        }
        if (netPts >= 80) {
          addBackfillAward(awards, userId, 'impact', 1, `Recognition backfill: ${priorYear} dominant scoring profile carryover`);
          recordSummary(userId, 'impact', 1);
        }
        if (wins >= 10 && losses === 0) {
          addBackfillAward(awards, userId, 'impact', 2, `Recognition backfill: ${priorYear} undefeated run carryover`);
          recordSummary(userId, 'impact', 2);
          addBackfillAward(awards, userId, 'legacy', 2, `Recognition backfill: ${priorYear} undefeated run carryover`);
          recordSummary(userId, 'legacy', 2);
        }
      }
    }
  }

  const divisionLeaders = new Map();
  for (const standing of standings) {
    const divisionId = String(standing?.divisionId || '');
    const current = divisionLeaders.get(divisionId);
    const score = [Number(standing?.winPct || 0), Number(standing?.totalWins || 0), Number(standing?.netPts || 0)];
    const currentScore = current
      ? [Number(current?.winPct || 0), Number(current?.totalWins || 0), Number(current?.netPts || 0)]
      : null;
    if (!current || score[0] > currentScore[0] || (score[0] === currentScore[0] && score[1] > currentScore[1]) || (score[0] === currentScore[0] && score[1] === currentScore[1] && score[2] > currentScore[2])) {
      divisionLeaders.set(divisionId, standing);
    }
  }
  for (const leader of divisionLeaders.values()) {
    const userIds = coachIndex.resolveByTeam(leader.teamId, leader.teamName);
    for (const userId of userIds) {
      addBackfillAward(awards, userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.divisionLead.amount, 'Recognition backfill: current division lead');
      recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.divisionLead.amount);
    }
  }
  for (const standing of standings) {
    const userIds = coachIndex.resolveByTeam(standing.teamId, standing.teamName);
    if (!userIds.length) continue;
    const wins = Number(standing.totalWins || 0);
    const losses = Number(standing.totalLosses || 0);
    const seed = Number(standing.seed || 0);
    for (const userId of userIds) {
      const awardVolumeBonus = Math.min(
        RECOGNITION_ECONOMY.legacy.currentSeason.awardVolume.max,
        Math.floor(Number(teamAwardTotals.get(String(userId)) || 0) / RECOGNITION_ECONOMY.legacy.currentSeason.awardVolume.perAwards),
      );
      const recentGames = (recentGamesByTeam.get(Number(standing.teamId)) || [])
        .slice()
        .sort((a, b) => Number(b?.weekNumber || 0) - Number(a?.weekNumber || 0))
        .slice(0, 5);
      const recentWins = recentGames.filter((game) => game?.won).length;
      const recentAvgPoints = recentGames.length
        ? recentGames.reduce((sum, game) => sum + Number(game?.pointsFor || 0), 0) / recentGames.length
        : 0;
      const recentAvgAllowed = recentGames.length
        ? recentGames.reduce((sum, game) => sum + Number(game?.pointsAgainst || 0), 0) / recentGames.length
        : 0;
      const recentAvgMargin = recentGames.length
        ? recentGames.reduce((sum, game) => sum + Number(game?.margin || 0), 0) / recentGames.length
        : 0;
      const decisiveWins = recentGames.filter((game) => game?.won && Number(game?.margin || 0) >= 10).length;
      const qualityWins = recentGames.filter((game) => {
        if (!game?.won) return false;
        const oppStanding = standingsByTeamId.get(Number(game?.opponentTeamId));
        const oppWins = Number(oppStanding?.totalWins || 0);
        const oppLosses = Number(oppStanding?.totalLosses || 0);
        return oppWins >= oppLosses;
      }).length;
      const recentAwardCount = Number(recentAwardTotals.get(String(userId)) || 0);
      let recentLegacyProfile = 0;
      if (wins >= RECOGNITION_ECONOMY.legacy.currentSeason.strongSeasonFoundation.wins) {
        addBackfillAward(awards, userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.strongSeasonFoundation.amount, 'Recognition backfill: strong season foundation already established');
        recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.strongSeasonFoundation.amount);
      }
      if (
        losses >= RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.minLosses &&
        wins <= RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.maxWins
      ) {
        addBackfillAward(
          awards,
          userId,
          'legacy',
          RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.amount,
          'Recognition backfill: season still has life if the slide gets stopped now',
        );
        recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.amount);
      }
      if (wins >= RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.wins && losses <= RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.lossesMax) {
        addBackfillAward(awards, userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.amount, 'Recognition backfill: undefeated run still intact');
        recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.amount);
      }
      if (seed === RECOGNITION_ECONOMY.legacy.currentSeason.conferenceTopSeed.seed) {
        addBackfillAward(awards, userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.conferenceTopSeed.amount, 'Recognition backfill: current conference top seed');
        recordSummary(userId, 'legacy', RECOGNITION_ECONOMY.legacy.currentSeason.conferenceTopSeed.amount);
      }
      if (awardVolumeBonus > 0) {
        addBackfillAward(awards, userId, 'legacy', awardVolumeBonus, 'Recognition backfill: sustained weekly award presence');
        recordSummary(userId, 'legacy', awardVolumeBonus);
      }
      if (recentGames.length >= 4) {
        if (recentWins >= 4) recentLegacyProfile += 2;
        else if (recentWins >= 3) recentLegacyProfile += 1;
        if (recentAvgMargin >= 10 || decisiveWins >= 2) recentLegacyProfile += 1;
        if (recentAvgPoints >= 28 || recentAvgAllowed <= 17) recentLegacyProfile += 1;
        if ((qualityWins >= 2 && recentWins >= 2) || recentAwardCount >= 2) recentLegacyProfile += 1;
      }
      recentLegacyProfile = Math.min(4, recentLegacyProfile);
      if (recentLegacyProfile > 0) {
        addBackfillAward(
          awards,
          userId,
          'legacy',
          recentLegacyProfile,
          'Recognition backfill: recent five-game profile and team output',
        );
        recordSummary(userId, 'legacy', recentLegacyProfile);
      }
    }
  }

  summary.activity.coaches = touchedByTier.activity.size;
  summary.impact.coaches = touchedByTier.impact.size;
  summary.legacy.coaches = touchedByTier.legacy.size;
  summary.totalCoaches = knownCoachUserIds.size;
  summary.awardEntries = awards.length;
  summary.interactionUsers = Object.keys(interactionCounts).filter((userId) => Number(interactionCounts[userId] || 0) > 0).length;
  summary.carryover2025.coaches = carryoverCoaches.size;

  return { awards, interactionCounts, summary };
}

const data = new SlashCommandBuilder()
  .setName('madden-weeklyupdate')
  .setDescription('Run after each advance. Use week only for backfills or fixes.')
  .addIntegerOption(o => o.setName('week').setDescription('Backfill/fix a specific week. Leave empty for normal use.').setRequired(false))
  .addBooleanOption(o => o.setName('force_awards').setDescription('Backfill only: force awards for the chosen week').setRequired(false))
  .addBooleanOption(o => o.setName('recap').setDescription('Queue the weekly recap review. Default: true').setRequired(false))
  .addBooleanOption(o => o.setName('queue_recap_review').setDescription('Backfill only: queue a recap draft for the chosen week').setRequired(false))
  .addBooleanOption(o => o.setName('backfill_recognition').setDescription('One-time current-season recognition backfill').setRequired(false))
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
    const recapEnabled = interaction.options.getBoolean('recap') !== false;
    const queueRecapReviewOption = interaction.options.getBoolean('queue_recap_review') === true;
    const backfillRecognitionOption = interaction.options.getBoolean('backfill_recognition') === true;
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
    } else if (!backfillOnlyAwards && !statsPartial) {
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
      console.warn('[madden-weeklyupdate] stat leaders skipped: no eligible update path');
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
    let weeklyGameLog = null;
    let recognitionBackfillResult = null;
    const recognitionSeasonKey = getMaddenSeasonKey(snap);
    try {
      weeklyGameLog = updateWeeklyGameLog(leagueId, snap);
    } catch (e) {
      criticalFailures.push('Weekly game log');
      console.warn('[madden-weeklyupdate] weekly game log update skipped:', e?.message || e);
    }
    if (backfillRecognitionOption) {
      try {
        const backfillKey = `${recognitionSeasonKey}_${RECOGNITION_BACKFILL_VERSION}`;
        const payload = await buildRecognitionBackfillPayload({
          guildId: interaction.guildId,
          leagueId,
          seasonKey: recognitionSeasonKey,
          currentWeekValue,
          snap,
          guild: interaction.guild,
          roleMap,
        });
        recognitionBackfillResult = applyRecognitionBackfill({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: recognitionSeasonKey,
          backfillKey,
          awards: payload.awards,
          interactionCounts: payload.interactionCounts,
          metadata: payload.summary,
        });
        console.log('[madden-weeklyupdate] recognition backfill', {
          seasonKey: recognitionSeasonKey,
          backfillKey,
          ok: recognitionBackfillResult?.ok === true,
          alreadyApplied: recognitionBackfillResult?.alreadyApplied === true,
          summary: recognitionBackfillResult?.summary || null,
        });
        appendMaddenStaffLog({
          type: recognitionBackfillResult?.alreadyApplied ? 'recognition_backfill_skipped' : 'recognition_backfill',
          guildId: interaction.guildId,
          userId: interaction.user.id,
          username: interaction.user.tag,
          seasonKey: recognitionSeasonKey,
          backfillKey,
          summary: recognitionBackfillResult?.summary || payload.summary,
        });
        if (recognitionBackfillResult?.ok || recognitionBackfillResult?.alreadyApplied) {
          const s = recognitionBackfillResult.summary || payload.summary;
          await postMaddenStaffLog(
            interaction.client,
            interaction.guildId,
            recognitionBackfillResult?.alreadyApplied ? 'Recognition Backfill Skipped' : 'Recognition Backfill Applied',
            recognitionBackfillResult?.alreadyApplied
              ? `Recognition metadata backfill already exists for ${recognitionSeasonKey}.`
              : `Applied current-season recognition backfill for ${recognitionSeasonKey}.`,
            [
              { name: 'Activity', value: `+${Number(s?.totals?.activity || 0)} across ${Number(s?.metadata?.activity?.coaches ?? s?.activity?.coaches ?? 0)} coaches`, inline: true },
              { name: 'Impact', value: `+${Number(s?.totals?.impact || 0)} across ${Number(s?.metadata?.impact?.coaches ?? s?.impact?.coaches ?? 0)} coaches`, inline: true },
              { name: 'Legacy', value: `+${Number(s?.totals?.legacy || 0)} across ${Number(s?.metadata?.legacy?.coaches ?? s?.legacy?.coaches ?? 0)} coaches`, inline: true },
            ],
          );
        }
      } catch (e) {
        criticalFailures.push('Recognition backfill');
        console.warn('[madden-weeklyupdate] recognition backfill skipped:', e?.message || e);
      }
    }
    if (weeklyGameLog && !statsPartial && Number(stageForWeek) === Stage.SEASON && Number(effectiveCurrentWeekUsed || 0) > 0) {
      try {
        const weekKey = `week_${Number(effectiveCurrentWeekUsed)}`;
        const coachIndex = await buildCoachAssignmentIndex(interaction.guild, roleMap, snap);
        const leagueAwards = safeReadJSON(AWARDS_FILE, {})?.[String(leagueId)] || {};
        const teamAwardTotals = new Map();
        for (const [weekRaw, weeklyAwards] of Object.entries(leagueAwards || {})) {
          const weekNumber = Number(weekRaw || 0);
          if (!weekNumber || weekNumber > Number(effectiveCurrentWeekUsed || 0)) continue;
          for (const award of Object.values(weeklyAwards || {})) {
            if (!award) continue;
            const userIds = coachIndex.resolveByTeam(award.teamId, award.teamName || award.team);
            for (const userId of userIds) {
              teamAwardTotals.set(String(userId), (teamAwardTotals.get(String(userId)) || 0) + 1);
            }
          }
        }
        const standings = snap?.standings?.teamStandingInfoList || [];
        const divisionLeaders = new Map();
        for (const standing of standings) {
          const divisionId = String(standing?.divisionId || '');
          const current = divisionLeaders.get(divisionId);
          const score = [Number(standing?.winPct || 0), Number(standing?.totalWins || 0), Number(standing?.netPts || 0)];
          const currentScore = current
            ? [Number(current?.winPct || 0), Number(current?.totalWins || 0), Number(current?.netPts || 0)]
            : null;
          if (!current || score[0] > currentScore[0] || (score[0] === currentScore[0] && score[1] > currentScore[1]) || (score[0] === currentScore[0] && score[1] === currentScore[1] && score[2] > currentScore[2])) {
            divisionLeaders.set(divisionId, standing);
          }
        }
        const weeklyLegacyAwards = [];
        for (const standing of standings) {
          const userIds = coachIndex.resolveByTeam(standing.teamId, standing.teamName);
          if (!userIds.length) continue;
          const wins = Number(standing?.totalWins || 0);
          const losses = Number(standing?.totalLosses || 0);
          const seed = Number(standing?.seed || 0);
          const divisionLeader = divisionLeaders.get(String(standing?.divisionId || ''));
          for (const userId of userIds) {
            let amount = 0;
            const reasons = [];
            if (seed > 0 && seed <= RECOGNITION_ECONOMY.legacy.currentSeason.earlyPlayoffPositioning.seedMax) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.earlyPlayoffPositioning.amount;
              reasons.push('early playoff positioning');
            }
            if (Number(divisionLeader?.teamId) === Number(standing?.teamId)) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.divisionLead.amount;
              reasons.push('division lead');
            }
            if (wins >= RECOGNITION_ECONOMY.legacy.currentSeason.strongSeasonFoundation.wins) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.strongSeasonFoundation.amount;
              reasons.push('strong season foundation');
            }
            if (
              losses >= RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.minLosses &&
              wins <= RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.maxWins
            ) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.stopTheSlide.amount;
              reasons.push('stop the slide');
            }
            if (
              wins >= RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.wins &&
              losses <= RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.lossesMax
            ) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.undefeatedRun.amount;
              reasons.push('undefeated run');
            }
            if (seed === RECOGNITION_ECONOMY.legacy.currentSeason.conferenceTopSeed.seed) {
              amount += RECOGNITION_ECONOMY.legacy.currentSeason.conferenceTopSeed.amount;
              reasons.push('conference top seed');
            }
            const awardVolumeBonus = Math.min(
              RECOGNITION_ECONOMY.legacy.currentSeason.awardVolume.max,
              Math.floor(Number(teamAwardTotals.get(String(userId)) || 0) / RECOGNITION_ECONOMY.legacy.currentSeason.awardVolume.perAwards),
            );
            if (awardVolumeBonus > 0) {
              amount += awardVolumeBonus;
              reasons.push('award volume');
            }
            if (amount > 0) {
              weeklyLegacyAwards.push({
                userId: String(userId),
                amount,
                reason: `Weekly legacy recognition: ${reasons.join(', ')}`,
              });
            }
          }
        }
        finalizeRecognitionWeek({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: getMaddenSeasonKey(snap),
          weekKey,
        });
        resolveRecognitionWeeklyLegacy({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: getMaddenSeasonKey(snap),
          weekKey,
          awards: weeklyLegacyAwards,
        });
        resolveRecognitionGameOfWeek({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: getMaddenSeasonKey(snap),
          weekKey,
          games: (weeklyGameLog.games || []).filter((game) => Number(game.stageIndex) === 1 && Number(game.weekIndex) === Number(effectiveCurrentWeekUsed) - 1),
        });
        resolveRecognitionDoubleOrNothing({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: getMaddenSeasonKey(snap),
          weekKey,
        });
        await settleSportsbookWeek({
          client: interaction.client,
          guildId: interaction.guildId,
          seasonKey: getMaddenSeasonKey(snap),
          weekNumber: Number(effectiveCurrentWeekUsed),
          games: (weeklyGameLog.games || []).filter((game) => Number(game.stageIndex) === 1 && Number(game.weekIndex) === Number(effectiveCurrentWeekUsed) - 1),
        });
      } catch (e) {
        console.warn('[madden-weeklyupdate] recognition finalize skipped:', e?.message || e);
      }
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
    const canFallbackTopPlayers = latestStage1WithStats != null;
    const topPlayersWeekValue = (statsPartial && canFallbackTopPlayers)
      ? Number(latestStage1WithStats) + 1
      : Number(effectiveCurrentWeekUsed || currentWeekValue || 0);
    const allowTopPlayers = !inOffseason && !inPreseason && topPlayersWeekValue > 0;
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
        await updateTopPlayers(interaction.client, leagueId, snap, topPlayersWeekValue, {
          isWildcard,
          postChannelId: '1462629502864851069'
        });
      } catch (e) {
        criticalFailures.push('Top players');
        console.warn('[madden-weeklyupdate] top players update skipped:', e?.message || e);
      }
    } else if (statsPartial) {
      console.warn('[madden-weeklyupdate] top players skipped: no reliable week available for fallback');
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
    if (backfillRecognitionOption) {
      if (recognitionBackfillResult?.ok) {
        embed.addFields({
          name: 'Recognition backfill',
          value: [
            `Applied current-season coach backfill.`,
            `Activity +${Number(recognitionBackfillResult.summary?.totals?.activity || 0)}`,
            `Impact +${Number(recognitionBackfillResult.summary?.totals?.impact || 0)}`,
            `Legacy +${Number(recognitionBackfillResult.summary?.totals?.legacy || 0)}`,
          ].join('\n').slice(0, 1024),
        });
        const recognitionLeaders = getRecognitionLeaderboard({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: recognitionSeasonKey,
          tier: 'total',
          limit: 8,
        });
        if (recognitionLeaders.length) {
          const leaderLines = recognitionLeaders.map((row, index) => (
            `${index + 1}. <@${row.userId}> - ${row.total} total (A ${row.activity} / I ${row.impact} / L ${row.legacy})`
          ));
          embed.addFields({
            name: 'League recognition',
            value: leaderLines.join('\n').slice(0, 1024),
          });
        }
      } else if (recognitionBackfillResult?.alreadyApplied) {
        embed.addFields({
          name: 'Recognition backfill',
          value: 'Current-season metadata backfill was already applied earlier.',
        });
        const recognitionLeaders = getRecognitionLeaderboard({
          guildId: interaction.guildId,
          league: 'madden',
          seasonKey: recognitionSeasonKey,
          tier: 'total',
          limit: 8,
        });
        if (recognitionLeaders.length) {
          const leaderLines = recognitionLeaders.map((row, index) => (
            `${index + 1}. <@${row.userId}> - ${row.total} total (A ${row.activity} / I ${row.impact} / L ${row.legacy})`
          ));
          embed.addFields({
            name: 'League recognition',
            value: leaderLines.join('\n').slice(0, 1024),
          });
        }
      }
    }

    await interaction.editReply({ embeds: [embed] });

    if (recapEnabled || queueRecapReviewOption) {
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
          const recap = buildWeeklyRecapData(ctx, {
            targetWeek: recapTargetWeek,
            variantSeed: Date.now() + Math.floor(Math.random() * 1000000),
          });
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
