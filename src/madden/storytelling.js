import fs from 'fs';
import path from 'path';
import { deriveTeamNeeds, draftOrder, applyPickTrades } from './coach/mockdraft.js';
import { buildLiveDraftContext, loadLatestLeagueSnapshot, getUpcomingDraftYear } from './coach/draft_live_data.js';
import { loadRoleMap } from './staff/staffUtils.js';
import { getFullTeamName, getFullTeamNameFromParts } from '../shared/madden_team_names.js';

const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'madden', 'active_trades.json');
const PENDING_PROOFS_PATH = path.join(process.cwd(), 'data', 'madden', 'pending_proofs.json');
const THREAD_STATE_PATH = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const FAIRSIMS_PATH = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const TOP_PLAYERS_PATH = path.join(process.cwd(), 'data', 'madden', 'top_players.json');
const WEEKLY_RECAP_HISTORY_PATH = path.join(process.cwd(), 'data', 'madden', 'weekly_recap_history.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleCase(text = '') {
  return String(text).replace(/\b\w/g, (c) => c.toUpperCase());
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function toDisplayTeam(team = '') {
  return String(team || '').replace(/\bcoach\b/ig, '').trim();
}

function buildTeamCoachMentionMap(roleMap = {}) {
  const map = new Map();
  for (const [name, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(name) || !roleId) continue;
    const team = name.replace(/ coach$/i, '').trim();
    map.set(normalizeName(team), `<@&${roleId}>`);
    const mascot = normalizeName(team.split(/\s+/).pop());
    if (mascot) map.set(mascot, `<@&${roleId}>`);
  }
  return map;
}

function addLeagueTeamCoachAliases(map, league) {
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    const fullName = getFullTeamName(team, '').trim();
    const mascot = String(team?.displayName || team?.nickName || '').trim();
    const abbr = String(team?.abbrName || '').trim();
    const mention =
      map.get(normalizeName(fullName)) ||
      map.get(normalizeName(mascot)) ||
      map.get(normalizeName(abbr));
    if (!mention) continue;
    if (fullName) map.set(normalizeName(fullName), mention);
    if (mascot) map.set(normalizeName(mascot), mention);
    if (abbr) map.set(normalizeName(abbr), mention);
  }
  return map;
}

function coachMentionFor(teamName, mentionMap) {
  const team = toDisplayTeam(teamName);
  const norm = normalizeName(team);
  return mentionMap.get(norm) || mentionMap.get(normalizeName(team.split(/\s+/).pop())) || '';
}

function formatRecord(standing) {
  if (!standing) return '0-0';
  const wins = Number(standing.totalWins || 0);
  const losses = Number(standing.totalLosses || 0);
  const ties = Number(standing.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatStatLine(player) {
  const totals = player?.totals || {};
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    return `${Number(totals.passYds || 0)} pass yds, ${Number(totals.passTDs || 0)} pass TD, ${Number(totals.passInts || 0)} INT${Number(totals.rushYds || 0) ? `, ${Number(totals.rushYds || 0)} rush yds` : ''}`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${Number(totals.rushYds || 0)} rush yds, ${Number(totals.rushTDs || 0)} rush TD${Number(totals.recYds || 0) ? `, ${Number(totals.recYds || 0)} rec yds` : ''}`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${Number(totals.recYds || 0)} rec yds, ${Number(totals.recTDs || 0)} rec TD, ${Number(totals.recCatches || 0)} catches`;
  }
  if (['CB', 'FS', 'SS', 'MLB', 'LB', 'WILL', 'MIKE', 'SAM', 'REDGE', 'LEDGE', 'DE', 'DT', 'LE', 'RE', 'EDGE'].includes(pos)) {
    const sacks = Number(totals.defSacks || 0);
    const ints = Number(totals.defInts || 0);
    const tackles = Number(totals.defTotalTackles || 0);
    const pd = Number(totals.defPassDeflections || 0);
    return `${tackles} tackles${sacks ? `, ${sacks} sacks` : ''}${ints ? `, ${ints} INT` : ''}${pd ? `, ${pd} PD` : ''}`;
  }
  return player?.statLine || 'impact game';
}

function formatGrade(value) {
  return Number(value || 0).toFixed(1);
}

function isBadStatLine(player) {
  const pos = String(player?.position || '').toUpperCase();
  const totals = player?.totals || {};
  if (pos === 'QB') {
    return Number(totals.passInts || 0) >= 2 || ((Number(totals.passYds || 0) <= 180) && Number(totals.passTDs || 0) === 0 && Number(totals.passInts || 0) >= 1);
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return Number(totals.rushFumblesLost || 0) >= 1 || (Number(totals.rushAtt || 0) >= 12 && Number(totals.rushYds || 0) <= 35);
  }
  if (['WR', 'TE'].includes(pos)) {
    return Number(totals.recDrops || 0) >= 2 || (Number(totals.recCatches || 0) >= 5 && Number(totals.recYds || 0) <= 35);
  }
  return false;
}

function describePerformanceRumor(player, mode = 'heat') {
  const totals = player?.totals || {};
  const pos = String(player?.position || '').toUpperCase();
  const grade = formatGrade(player?.grade);
  const team = player?.team || 'That team';
  const name = player?.name || 'That player';
  const line = formatStatLine(player);

  if (pos === 'QB') {
    const passYds = Number(totals.passYds || 0);
    const passTDs = Number(totals.passTDs || 0);
    const passInts = Number(totals.passInts || 0);
    const rushYds = Number(totals.rushYds || 0);
    const rushTDs = Number(totals.rushTDs || 0);
    if (mode === 'heat') {
      if (passInts >= 2 && (passTDs >= 3 || passYds >= 300 || rushYds >= 60 || rushTDs >= 1)) {
        return `${team} are still talking through an up-and-down day from ${name}. ${line} showed how much stress he can put on a defense, but the interceptions kept the full review mixed.`;
      }
      if (rushYds >= 60 || rushTDs >= 1) {
        return `${team} keep getting stronger buzz behind ${name}. A ${grade} grade and a line like ${line} showed both the arm talent and the rushing pressure he can add to an offense.`;
      }
      return `${team} keep getting stronger buzz behind ${name}. A ${grade} grade and a line like ${line} changes the ceiling fast.`;
    }
    if (passInts >= 2 && (passTDs >= 3 || passYds >= 300 || rushYds >= 60 || rushTDs >= 1)) {
      return `${team} are catching mixed reviews around ${name} after ${line}. The creation was obvious, but so was the volatility.`;
    }
    return `${team} are catching some bad noise around ${name} after ${line}. That is the kind of quarterback week that usually follows a team for a few days.`;
  }

  if (['HB', 'RB', 'FB'].includes(pos)) {
    const rushYds = Number(totals.rushYds || 0);
    const rushTDs = Number(totals.rushTDs || 0);
    const fumbles = Number(totals.rushFumblesLost || 0);
    if (mode === 'heat') {
      if (fumbles >= 1 && (rushYds >= 100 || rushTDs >= 2)) {
        return `${team} got an explosive but uneven day from ${name}. ${line} was big enough to matter, but the ball-security issues kept it from reading cleanly.`;
      }
      return `${team} are getting real juice from ${name}. A ${grade} grade and ${line} is the kind of backfield production that gets noticed fast.`;
    }
    return `${team} are hearing some frustration around ${name} after ${line}. The yardage only goes so far if the mistakes stay in the frame.`;
  }

  if (['WR', 'TE'].includes(pos)) {
    const recYds = Number(totals.recYds || 0);
    const recTDs = Number(totals.recTDs || 0);
    const drops = Number(totals.recDrops || 0);
    if (mode === 'heat') {
      if (drops >= 2 && (recYds >= 100 || recTDs >= 1)) {
        return `${team} got a loud but uneven receiver day from ${name}. ${line} moved the offense, but the drops kept the reviews mixed.`;
      }
      return `${team} have a real offensive spark with ${name}. A ${grade} grade and ${line} is the kind of passing-game heat that changes coverage math.`;
    }
    return `${team} are hearing mixed reaction to ${name} after ${line}. The production showed up, but so did the inconsistency.`;
  }

  if (['CB', 'FS', 'SS', 'MLB', 'LB', 'WILL', 'MIKE', 'SAM', 'REDGE', 'LEDGE', 'DE', 'DT', 'LE', 'RE', 'EDGE'].includes(pos)) {
    const sacks = Number(totals.defSacks || 0);
    const ints = Number(totals.defInts || 0);
    const tackles = Number(totals.defTotalTackles || 0);
    const pd = Number(totals.defPassDeflections || 0);
    if (mode === 'heat') {
      return `${team} are getting real defensive noise from ${name}. A ${grade} grade backed up ${line}, and that is the kind of line evaluators buy into.`;
    }
    if (sacks || ints || pd || tackles >= 8) {
      return `${team} are still sorting out what to make of ${name}'s line: ${line}. The activity was real, even if the full review was more complicated than the raw numbers suggest.`;
    }
    return `${team} are not thrilled with how ${name}'s week landed. ${line} was not enough to quiet the questions.`;
  }

  return mode === 'heat'
    ? `${team} are getting stronger buzz around ${name} after a ${grade} grade week.`
    : `${team} are hearing more criticism around ${name} after a rougher week.`;
}

function teamNamesFromGameEntry(entry) {
  return [entry?.away, entry?.home].filter(Boolean);
}

function pickDistinctItems(items, getTeams, blockedTeams = new Set(), limit = 1) {
  const selected = [];
  const used = new Set([...blockedTeams].map((team) => normalizeName(team)));
  for (const item of items || []) {
    const teams = (getTeams(item) || []).filter(Boolean);
    const hasConflict = teams.some((team) => used.has(normalizeName(team)));
    if (hasConflict && selected.length < limit) continue;
    selected.push(item);
    teams.forEach((team) => used.add(normalizeName(team)));
    if (selected.length >= limit) break;
  }
  if (selected.length >= limit) return selected;
  for (const item of items || []) {
    if (selected.includes(item)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function pickTemplate(templates = [], seed = 0) {
  if (!templates.length) return '';
  return templates[Math.abs(Number(seed) || 0) % templates.length];
}

function describeNeedPressureRumor(team, coachTag, need) {
  const side = coachTag ? `${coachTag} may have to` : `${team} may have to`;
  const key = String(need || '').toUpperCase();
  switch (key) {
    case 'QB':
      return `${team} are being tied to a bigger-picture reset. The read around the league is that ${side} settle the quarterback future before anything else really comes into focus.`;
    case 'OT':
    case 'LT':
    case 'RT':
      return `${team} are drawing real offensive-line scrutiny. The sense around the league is that ${side} stabilize tackle before the offense can feel settled.`;
    case 'WR':
      return `${team} are getting tied to help on the perimeter. Around the league, the feeling is that ${side} add another receiver who can actually change coverages.`;
    case 'RB':
    case 'HB':
      return `${team} are drawing quiet backfield questions. The read around the league is that ${side} find more explosive runner help before the offense feels complete.`;
    case 'TE':
      return `${team} are being linked to another option in the middle of the field. The sense around the league is that ${side} find a tighter answer at tight end.`;
    case 'CB':
      return `${team} are hearing more noise about the secondary. The feeling around the league is that ${side} find another corner who can hold up on an island.`;
    case 'S':
    case 'FS':
    case 'SS':
      return `${team} are getting tied to help on the back end. Around the league, there is a sense that ${side} get safer at safety before the defense settles.`;
    case 'EDGE':
    case 'REDGE':
    case 'LEDGE':
    case 'DE':
    case 'LE':
    case 'RE':
      return `${team} are being tied to pass-rush help. The feeling around the league is that ${side} find more edge pressure before the defense can really climb.`;
    case 'DT':
      return `${team} are being linked to interior help up front. Around the league, people think ${side} get sturdier inside before the front feels complete.`;
    case 'LB':
    case 'MLB':
    case 'WILL':
    case 'MIKE':
    case 'SAM':
      return `${team} are getting tied to second-level help. The league read is that ${side} clean up linebacker before the defense really settles down.`;
    case 'IOL':
    case 'G':
    case 'LG':
    case 'RG':
    case 'C':
      return `${team} are drawing pressure around the middle of the line. The sense around the league is that ${side} get stronger inside before the offense feels stable.`;
    default:
      return `${team} are being tied to a bigger-picture reset. The read around the league is that ${side} solve ${titleCase(need || 'the roster')} before anything else settles down.`;
  }
}

function leagueKeyFromContext(ctx) {
  return String(ctx?.league?.info?.leagueId || ctx?.league?.leagueId || 'default');
}

function getRecentFeaturedTeams(ctx, currentWeek) {
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  return new Set(
    leagueHistory
      .filter((entry) => Number(entry?.week) !== Number(currentWeek))
      .slice(-2)
      .flatMap((entry) => entry?.teams || [])
      .map((team) => normalizeName(team)),
  );
}

function saveFeaturedTeamsForWeek(ctx, currentWeek, teams) {
  if (currentWeek == null) return;
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  const filtered = leagueHistory.filter((entry) => Number(entry?.week) !== Number(currentWeek));
  filtered.push({
    week: Number(currentWeek),
    teams: [...new Set((teams || []).filter(Boolean))],
    updatedAt: Date.now(),
  });
  history[leagueKey] = filtered.slice(-6);
  saveJSON(WEEKLY_RECAP_HISTORY_PATH, history);
}

function getYoungHeadlinePlayer(ctx, teamName) {
  return (ctx.top100 || []).find((player) => {
    if (normalizeName(player?.team || '') !== normalizeName(teamName)) return false;
    const yearsPro = Number(player?.yearsPro ?? 99);
    const age = Number(player?.age ?? 99);
    return yearsPro <= 1 || age <= 24;
  }) || null;
}

function scoreRecapGame(ctx, game, recentTeamSet) {
  const away = ctx.teams.get(Number(game.awayTeamId));
  const home = ctx.teams.get(Number(game.homeTeamId));
  const awayScore = Number(game.awayScore || 0);
  const homeScore = Number(game.homeScore || 0);
  const winner = awayScore > homeScore ? away : home;
  const margin = Math.abs(awayScore - homeScore);
  const closeGameBonus = margin <= 3 ? 22 : margin <= 7 ? 14 : 0;
  const blowoutBonus = Math.min(18, margin * 1.2);
  const totalPointsBonus = Math.min(14, (awayScore + homeScore) * 0.22);
  const winnerStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
  const wins = Number(winnerStanding?.totalWins || 0);
  const losses = Number(winnerStanding?.totalLosses || 0);
  const recordWeight = (wins + losses) >= 4 ? 10 : 4;
  const awayYoung = getYoungHeadlinePlayer(ctx, away);
  const homeYoung = getYoungHeadlinePlayer(ctx, home);
  const youngBonus = (awayYoung ? 9 : 0) + (homeYoung ? 9 : 0);
  const recentPenalty =
    (recentTeamSet.has(normalizeName(away)) ? 18 : 0) +
    (recentTeamSet.has(normalizeName(home)) ? 18 : 0);
  return {
    game,
    away,
    home,
    awayYoung,
    homeYoung,
    score: blowoutBonus + closeGameBonus + totalPointsBonus + recordWeight + youngBonus - recentPenalty,
    margin,
  };
}

function selectRecapGames(ctx, recentGames, currentWeek) {
  const recentTeamSet = getRecentFeaturedTeams(ctx, currentWeek);
  const scored = recentGames.map((game) => scoreRecapGame(ctx, game, recentTeamSet)).sort((a, b) => b.score - a.score);
  const targetCount = Math.min(4, Math.max(3, recentGames.length));
  const selected = [];
  const usedThisWeek = new Set();

  for (const candidate of scored) {
    const awayKey = normalizeName(candidate.away);
    const homeKey = normalizeName(candidate.home);
    const conflictsCurrent = usedThisWeek.has(awayKey) || usedThisWeek.has(homeKey);
    const conflictsRecent = recentTeamSet.has(awayKey) || recentTeamSet.has(homeKey);
    if (conflictsCurrent) continue;
    if (selected.length < targetCount - 1 && conflictsRecent) continue;
    selected.push(candidate);
    usedThisWeek.add(awayKey);
    usedThisWeek.add(homeKey);
    if (selected.length >= targetCount) break;
  }

  for (const candidate of scored) {
    if (selected.length >= targetCount) break;
    if (selected.some((entry) => entry.game === candidate.game)) continue;
    selected.push(candidate);
  }

  saveFeaturedTeamsForWeek(ctx, currentWeek, selected.flatMap((entry) => [entry.away, entry.home]));
  return selected;
}

function recordScore(standing) {
  if (!standing) return 0;
  return Number(standing.totalWins || 0) - Number(standing.totalLosses || 0);
}

function classIdForLeague(league) {
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const seasonOrdinal = Number(seasonInfo?.seasonYear ?? league?.info?.seasonYear ?? league?.seasonYear);
  if (Number.isFinite(seasonOrdinal) && seasonOrdinal >= 0 && seasonOrdinal < 50) {
    return `cus_${String(seasonOrdinal + 1).padStart(2, '0')}`;
  }
  const calendarYear = Number(seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 2025);
  const idx = Math.max(1, calendarYear - 2024);
  return `cus_${String(idx).padStart(2, '0')}`;
}

function findDraftClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const files = fs.readdirSync(DRAFT_DIR).filter((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith('.json') && lower.includes(classId.toLowerCase()) && lower.includes('big board');
  });
  if (!files.length) return null;
  return path.join(DRAFT_DIR, files.sort()[0]);
}

function loadDraftClassForLeague(league) {
  const classId = classIdForLeague(league);
  const file = findDraftClassFile(classId);
  return {
    classId,
    players: file ? Object.values(safeReadJSON(file, {})).filter((p) => p?.name) : [],
  };
}

function teamNameMap(league) {
  const map = new Map();
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    const display = getFullTeamName(team, String(team.teamId));
    map.set(Number(team.teamId), display);
  }
  return map;
}

function standingsMap(league) {
  const map = new Map();
  for (const standing of league?.standings?.teamStandingInfoList || []) {
    map.set(Number(standing.teamId), standing);
  }
  return map;
}

function previousSnapshotFor(latestFile) {
  if (!latestFile) return null;
  const prevFile = path.join(path.dirname(latestFile), 'previous', path.basename(latestFile));
  if (!fs.existsSync(prevFile)) return null;
  return safeReadJSON(prevFile, null);
}

function listCompletedGames(league, weekIndex = null) {
  return (league?.schedule?.schedules || []).filter((game) => {
    const stage = Number(game?.stageIndex ?? game?.stage ?? -1);
    const status = Number(game?.status ?? 0);
    const gameWeek = Number(game?.weekIndex ?? -1);
    const weekMatch = weekIndex == null ? true : gameWeek === weekIndex;
    return [1, 2].includes(stage) && weekMatch && status >= 2;
  });
}

function latestCompletedWeek(league) {
  const weeks = listCompletedGames(league).map((game) => Number(game.weekIndex));
  if (!weeks.length) return null;
  return Math.max(...weeks);
}

function buildRecentForm(league) {
  const completedWeek = latestCompletedWeek(league);
  if (completedWeek == null) return new Map();
  const relevantWeeks = [completedWeek, completedWeek - 1].filter((week) => week >= 0);
  const form = new Map();
  for (const week of relevantWeeks) {
    for (const game of listCompletedGames(league, week)) {
      const awayTeamId = Number(game.awayTeamId);
      const homeTeamId = Number(game.homeTeamId);
      const awayScore = Number(game.awayScore || 0);
      const homeScore = Number(game.homeScore || 0);
      const ensure = (teamId) => {
        if (!form.has(teamId)) form.set(teamId, { wins: 0, losses: 0, pf: 0, pa: 0 });
        return form.get(teamId);
      };
      const away = ensure(awayTeamId);
      const home = ensure(homeTeamId);
      away.pf += awayScore;
      away.pa += homeScore;
      home.pf += homeScore;
      home.pa += awayScore;
      if (awayScore > homeScore) {
        away.wins += 1;
        home.losses += 1;
      } else if (homeScore > awayScore) {
        home.wins += 1;
        away.losses += 1;
      }
    }
  }
  return form;
}

async function buildCoachUserTeamMap(guild) {
  const roleMap = loadRoleMap();
  const out = new Map();
  for (const [name, roleId] of Object.entries(roleMap)) {
    if (!/ coach$/i.test(name)) continue;
    const teamName = name.replace(/ coach$/i, '').trim();
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    if (role.members?.size) {
      role.members.forEach((member) => out.set(member.id, teamName));
      continue;
    }
    try {
      const members = await guild.members.fetch();
      members.filter((member) => member.roles.cache.has(roleId)).forEach((member) => out.set(member.id, teamName));
    } catch {
      // ignore
    }
  }
  return out;
}

function loadTop100(leagueId) {
  const all = safeReadJSON(TOP_PLAYERS_PATH, {});
  return all?.[leagueId]?.top100 || [];
}

function chooseProspectForNeed(need, draftClass) {
  const mapNeed = (player) => {
    const pos = String(player?.position || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['LT', 'RT'].includes(pos)) return 'OT';
    if (['LG', 'RG', 'C'].includes(pos)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE'].includes(pos)) return 'EDGE';
    if (['DT', 'NT'].includes(pos)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    if (pos === 'CB') return 'CB';
    if (['FS', 'SS'].includes(pos)) return 'S';
    if (pos === 'TE') return 'TE';
    if (pos === 'WR') return 'WR';
    if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
    return 'BPA';
  };
  return draftClass
    .slice()
    .sort((a, b) => Number(a.RNK ?? 9999) - Number(b.RNK ?? 9999))
    .find((player) => mapNeed(player) === need) || null;
}

function buildPhaseLanguage(seasonContext = {}) {
  const phase = seasonContext?.phase || 'offseason';
  if (phase === 'early_regular') {
    return {
      recapIntro: `With the league still settling in through ${seasonContext.completedRegularWeeks || 0} games, the week felt more like an identity check than a final verdict.`,
      rumorFrame: 'It is still early enough that one result can shift the conversation fast.',
    };
  }
  if (phase === 'mid_regular') {
    return {
      recapIntro: 'By the middle of the season, the league starts looking a lot less theoretical and a lot more honest.',
      rumorFrame: 'At this point in the season, trends stop feeling accidental.',
    };
  }
  if (phase === 'late_regular') {
    return {
      recapIntro: 'With the stretch run underway, every result is starting to carry playoff weight or draft-position fallout.',
      rumorFrame: 'This late in the year, the league is reading everything through pressure, urgency, and leverage.',
    };
  }
  if (phase === 'postseason') {
    return {
      recapIntro: 'With the postseason lens on everything now, even league chatter starts sounding sharper.',
      rumorFrame: 'In the postseason window, the conversation naturally shifts toward pressure, roster direction, and what comes next.',
    };
  }
  return {
    recapIntro: 'With the calendar flipped to offseason mode, the league conversation moves from results to roster building.',
    rumorFrame: 'This part of the cycle is more about roster direction, draft posture, and who is positioning to move next.',
  };
}

function buildMockDraftSignals(ctx, limit = 3) {
  const draftPlayers = ctx?.draftClassInfo?.players || [];
  if (!draftPlayers.length) return [];
  const seasonYear = getUpcomingDraftYear(ctx.league);
  const order = applyPickTrades(draftOrder(ctx.league), seasonYear).slice(0, Math.max(limit * 2, 8));
  const signals = [];
  for (const pick of order) {
    const team = String(pick.team || '').replace(/\(via.*$/i, '').trim();
    if (!team) continue;
    const needKey = normalizeName(team);
    const primaryNeed = (ctx.needs[needKey] || ['BPA'])[0];
    const prospect = chooseProspectForNeed(primaryNeed, draftPlayers);
    if (!prospect) continue;
    const pickLabel = pick.pickNum ? `No. ${pick.pickNum}` : `Round ${pick.round}`;
    signals.push({
      team,
      prospect,
      text: `The latest mock draft has ${team} taking ${prospect.name} (${prospect.position}) at ${pickLabel}.`,
      key: `mock:${team}:${pickLabel}`,
    });
    if (signals.length >= limit) break;
  }
  return signals;
}

async function collectThreadParticipation(client, guild, threadInfo) {
  const thread = await client.channels.fetch(threadInfo.threadId).catch(() => null);
  if (!thread || !thread.isTextBased()) return { awayCount: 0, homeCount: 0 };
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return { awayCount: 0, homeCount: 0 };
  const awayUserIds = new Set();
  const homeUserIds = new Set();
  for (const roleId of threadInfo.awayRoleIds || []) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    role?.members?.forEach((member) => awayUserIds.add(member.id));
  }
  for (const roleId of threadInfo.homeRoleIds || []) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    role?.members?.forEach((member) => homeUserIds.add(member.id));
  }
  let awayCount = 0;
  let homeCount = 0;
  for (const message of messages.values()) {
    if (message.author?.bot) continue;
    if (awayUserIds.has(message.author.id)) awayCount += 1;
    if (homeUserIds.has(message.author.id)) homeCount += 1;
  }
  return { awayCount, homeCount };
}

export async function buildStoryContext(guild, client, options = {}) {
  const latest = loadLatestLeagueSnapshot();
  const league = latest?.league || null;
  if (!league) return null;
  const live = buildLiveDraftContext(league);
  const prevLeague = previousSnapshotFor(latest.file);
  const needs = deriveTeamNeeds(league);
  const teams = teamNameMap(league);
  const standings = standingsMap(league);
  const prevStandings = standingsMap(prevLeague);
  const draftClassInfo = loadDraftClassForLeague(league);
  const roleMap = loadRoleMap();
  const teamCoachMentions = addLeagueTeamCoachAliases(buildTeamCoachMentionMap(roleMap), league);
  const coachUserTeamMap = (guild && !options.skipCoachUserTeamMap) ? await buildCoachUserTeamMap(guild) : new Map();
  return {
    latest,
    league,
    live,
    seasonContext: live?.seasonContext || null,
    needs,
    teams,
    standings,
    prevStandings,
    draftClassInfo,
    activeTrades: safeReadJSON(ACTIVE_TRADES_PATH, {}),
    pendingProofs: safeReadJSON(PENDING_PROOFS_PATH, {}),
    threadState: safeReadJSON(THREAD_STATE_PATH, { threads: {} }),
    fairsims: safeReadJSON(FAIRSIMS_PATH, {}),
    scoutLog: safeReadJSON(SCOUT_LOG_PATH, []),
    top100: loadTop100(String(league?.info?.leagueId || league?.leagueId || '')),
    coachUserTeamMap,
    teamCoachMentions,
    roleMap,
    client,
    guild,
  };
}

export function buildRumorMillItems(ctx, limit = 8) {
  const items = [];
  const completedWeek = latestCompletedWeek(ctx.league);
  const recentForm = buildRecentForm(ctx.league);
  const draftYear = getUpcomingDraftYear(ctx.league);
  const seasonContext = ctx.seasonContext || {};
  const phaseLanguage = buildPhaseLanguage(seasonContext);
  const mockSignals = buildMockDraftSignals(ctx, 3);
  const add = (score, text, key, category = 'misc') => items.push({ score, text, key, category });

  if (seasonContext.isInSeason) {
    for (const [teamId, standing] of ctx.standings.entries()) {
      const prev = ctx.prevStandings.get(teamId);
      if (!prev) continue;
      const delta = recordScore(standing) - recordScore(prev);
      const team = ctx.teams.get(teamId);
      const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
      if (delta >= 1) {
        add(
          78 + delta,
          `${coachTag ? `${coachTag} and ` : ''}${team} are climbing. The move from ${formatRecord(prev)} to ${formatRecord(standing)} has people around the league treating them more seriously.`,
          `rise:${team}`,
          'trend_up',
        );
      }
      if (delta <= -1) {
        add(
          84 + Math.abs(delta),
          `${coachTag ? `${coachTag} and ` : ''}${team} are slipping. The drop from ${formatRecord(prev)} to ${formatRecord(standing)} is creating more pressure than anyone there would want.`,
          `slide:${team}`,
          'trend_down',
        );
      }
    }
  }

  for (const [teamId, standing] of ctx.standings.entries()) {
    const team = ctx.teams.get(teamId);
    if (!team) continue;
    const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
    const wins = Number(standing.totalWins || 0);
    const losses = Number(standing.totalLosses || 0);
    const teamKey = normalizeName(team);
    const needs = ctx.needs[teamKey] || ['BPA'];
    const openTradeCount = Object.values(ctx.activeTrades || {}).filter((trade) =>
      ['awaiting_coach_b', 'committee', 'approved_pending_proof'].includes(trade?.status) &&
      [trade.yourTeam, trade.otherTeam].includes(team)
    ).length;
    if (wins >= 3 && openTradeCount > 0) {
      add(86 + openTradeCount, `${coachTag ? `${coachTag} and ` : ''}${team} are getting buyer buzz. The record says push, and the rest of the league expects them to stay aggressive.`, `buyer:${team}`, 'trade');
    }
    if (losses >= 3 && openTradeCount > 0) {
      add(85 + openTradeCount, `${coachTag ? `${coachTag} and ` : ''}${team} are drawing seller chatter. The record is forcing the question, and rival teams are waiting to see if a veteran hits the market.`, `seller:${team}`, 'trade');
    }
    if (losses >= 3 && ['QB', 'OT', 'CB', 'EDGE'].includes(needs[0])) {
      add(80, describeNeedPressureRumor(team, coachTag, needs[0]), `pressure:${team}`, 'pressure');
    }
  }

  if (seasonContext.isInSeason) {
    for (const [teamId, form] of recentForm.entries()) {
      const team = ctx.teams.get(teamId);
      if (!team) continue;
      const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
      const margin = Number(form.pf || 0) - Number(form.pa || 0);
      if (form.wins >= 2) add(82 + form.wins, `${coachTag ? `${coachTag} have ` : ''}${team} rolling. ${form.wins} straight wins and a ${margin} scoring margin over that stretch is the kind of form people notice.`, `run:${team}`, 'trend_up');
      if (form.losses >= 2) add(88 + form.losses, `${coachTag ? `${coachTag} just watched ` : ''}${team} drop ${form.losses} straight while getting outscored by ${Math.abs(margin)}. The urgency is real.`, `cold:${team}`, 'trend_down');
    }
  }

  const leagueTop = ctx.top100.slice(0, 25);
  const qbBuzz = leagueTop.find((player) => player.position === 'QB');
  const wrBuzz = leagueTop.find((player) => player.position === 'WR');
  const edgeBuzz = leagueTop.find((player) => ['LE', 'RE', 'EDGE', 'REDGE', 'LEDGE', 'DE'].includes(String(player.position || '').toUpperCase()));
  const rookieBuzz = leagueTop.find((player) => Number(player?.yearsPro ?? 99) <= 1);
  if (qbBuzz) add(90, `${coachMentionFor(qbBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(qbBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(qbBuzz, 'heat')}`, `player:${qbBuzz.name}`, 'player_heat');
  if (wrBuzz) add(83, `${coachMentionFor(wrBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(wrBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(wrBuzz, 'heat')}`, `player:${wrBuzz.name}`, 'player_heat');
  if (edgeBuzz) add(79, `${coachMentionFor(edgeBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(edgeBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(edgeBuzz, 'heat')}`, `player:${edgeBuzz.name}`, 'player_heat');
  if (rookieBuzz) add(84, `${coachMentionFor(rookieBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(rookieBuzz.team, ctx.teamCoachMentions)} and ` : ''}${rookieBuzz.team} have a young name turning into real conversation with ${rookieBuzz.name}. When a rookie starts stacking ${formatGrade(rookieBuzz.grade)}-level weeks, people notice fast.`, `rookie:${rookieBuzz.name}`, 'player_heat');

  const roughLeaguePlayers = ctx.top100
    .slice()
    .reverse()
    .filter((player) => isBadStatLine(player))
    .slice(0, 6);
  for (const player of roughLeaguePlayers.slice(0, 3)) {
    add(
      82,
      `${coachMentionFor(player.team, ctx.teamCoachMentions) ? `${coachMentionFor(player.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(player, 'struggle')}`,
      `rough:${player.team}:${player.name}`,
      'player_struggle',
    );
  }

  const tradeStates = Object.values(ctx.activeTrades || {}).filter((trade) => ['awaiting_coach_b', 'committee', 'approved_pending_proof'].includes(trade?.status));
  const tradeCountsByTeam = new Map();
  for (const trade of tradeStates) {
    for (const team of [trade.yourTeam, trade.otherTeam]) {
      if (!team) continue;
      tradeCountsByTeam.set(team, (tradeCountsByTeam.get(team) || 0) + 1);
    }
  }
  for (const [team, count] of tradeCountsByTeam.entries()) {
    const acceptedCount = tradeStates.filter((trade) => ['committee', 'approved_pending_proof'].includes(trade?.status) && [trade.yourTeam, trade.otherTeam].includes(team)).length;
    if (acceptedCount > 0) {
      add(84 + acceptedCount, `${coachMentionFor(team, ctx.teamCoachMentions) ? `${coachMentionFor(team, ctx.teamCoachMentions)} and ` : ''}${team} keep showing up around the trade desk. With ${acceptedCount} accepted process${acceptedCount === 1 ? '' : 'es'} alive, the expectation is movement.`, `trade:${team}`, 'trade');
    }
  }
  for (const trade of tradeStates.slice(0, 4)) {
    const teamA = trade.yourTeam;
    const teamB = trade.otherTeam;
    if (!teamA || !teamB) continue;
    if (trade.status === 'awaiting_coach_b') {
      const offeredBy = trade.createdByTeam || trade.createdByTeamName || teamA;
      const targetTeam = normalizeName(offeredBy) === normalizeName(teamA) ? teamB : teamA;
      const offeredAssets = String(
        normalizeName(offeredBy) === normalizeName(teamA)
          ? (trade.assetsSent || trade.assetsReceived || '')
          : (trade.assetsReceived || trade.assetsSent || '')
      ).split(/\n|,/).map((s) => s.trim()).filter(Boolean);
      const headlineAsset = offeredAssets[0];
      add(
        81,
        `${coachMentionFor(offeredBy, ctx.teamCoachMentions) ? `${coachMentionFor(offeredBy, ctx.teamCoachMentions)} and ` : ''}${offeredBy} reportedly submitted an offer${headlineAsset ? ` centered on ${headlineAsset}` : ''} to ${coachMentionFor(targetTeam, ctx.teamCoachMentions) ? `${coachMentionFor(targetTeam, ctx.teamCoachMentions)} and ` : ''}${targetTeam}, according to league chatter.`,
        `trade_offer:${trade.tradeId || `${teamA}:${teamB}`}`,
        'trade',
      );
      continue;
    }
    const statusMap = {
      committee: 'is sitting with committee',
      approved_pending_proof: 'is waiting on proof to clear',
    };
    add(
      87,
      `${coachMentionFor(teamA, ctx.teamCoachMentions) || teamA} and ${coachMentionFor(teamB, ctx.teamCoachMentions) || teamB} still have live business on the board. The deal ${statusMap[trade.status] || 'is still moving through the process'}.`,
      `trade_pair:${trade.tradeId || `${teamA}:${teamB}`}`,
      'trade',
    );
  }

  const leagueTeamInfos = ctx.league?.teams?.leagueTeamInfoList || [];
  for (const teamInfo of leagueTeamInfos) {
    const team = getFullTeamNameFromParts(teamInfo.cityName, teamInfo.displayName, teamInfo.nickName, teamInfo.displayName);
    const teamKey = normalizeName(team);
    const teamNeeds = ctx.needs[teamKey] || ['BPA'];
    const primaryNeed = teamNeeds[0];
    const prospect = chooseProspectForNeed(primaryNeed, ctx.draftClassInfo.players);
    const standing = ctx.standings.get(Number(teamInfo.teamId));
    if (!prospect || !standing) continue;
    if (Number(standing.totalWins || 0) >= 3 || Number(standing.totalLosses || 0) >= 3) {
      add(76, `League evaluators keep tying ${coachMentionFor(team, ctx.teamCoachMentions) ? `${coachMentionFor(team, ctx.teamCoachMentions)} and ` : ''}${team} to ${titleCase(primaryNeed)} help in the ${draftYear} class. ${prospect.name} from ${prospect.school || 'that board'} is one name that keeps surfacing.`, `need:${team}`, 'draft');
    }
  }

  const currentClass = ctx.draftClassInfo.classId;
  const seasonYear = Number(ctx.league?.info?.careerHubInfo?.seasonInfo?.calendarYear || ctx.league?.info?.calendarYear || ctx.league?.calendarYear || 2025);
  const scoutCounts = new Map();
  for (const entry of ctx.scoutLog || []) {
    if (!entry || String(entry.classId || '').toLowerCase() !== String(currentClass).toLowerCase()) continue;
    if (Number(entry.seasonYear || seasonYear) !== seasonYear) continue;
    const team = ctx.coachUserTeamMap.get(entry.userId);
    if (!team) continue;
    const key = `${team}|${entry.player}`;
    const current = scoutCounts.get(key) || { team, player: entry.player, position: entry.position, school: entry.school, count: 0 };
    current.count += 1;
    scoutCounts.set(key, current);
  }
  const topLinks = [...scoutCounts.values()].filter((entry) => entry.count >= 2).sort((a, b) => b.count - a.count).slice(0, 4);
  for (const link of topLinks) {
    add(85 + link.count, `There is real smoke around ${coachMentionFor(link.team, ctx.teamCoachMentions) ? `${coachMentionFor(link.team, ctx.teamCoachMentions)} and ` : ''}${link.team} with ${link.player}${link.position ? ` (${link.position})` : ''}. At this point, it reads like more than random scouting noise.`, `scout:${link.team}:${link.player}`, 'scouting');
  }

  for (const signal of mockSignals) {
    add(78, `${phaseLanguage.rumorFrame} ${signal.text}`, signal.key, 'draft');
  }

  for (const [teamIdRaw, roster] of Object.entries(ctx.league?.rosters?.teams || {})) {
    const teamId = Number(teamIdRaw);
    const team = ctx.teams.get(teamId);
    if (!team) continue;
    const injured = (roster?.rosterInfoList || [])
      .filter((player) => Number(player?.injuryLength || 0) >= 4)
      .sort((a, b) => Number(b.playerBestOvr || b.teamSchemeOvr || 0) - Number(a.playerBestOvr || a.teamSchemeOvr || 0))[0];
    if (!injured) continue;
    const name = `${injured.firstName || ''} ${injured.lastName || ''}`.trim() || injured.displayName || 'A starter';
    add(81, `${team} have an injury variable to manage. ${name} missing ${Number(injured.injuryLength || 0)} weeks is the kind of hit that can force a pivot.`, `injury:${team}:${name}`, 'injury');
  }

  const categoryCaps = seasonContext.phase === 'offseason'
    ? {
        trade: 2,
        scouting: 1,
        draft: 2,
        player_heat: 1,
        player_struggle: 1,
        trend_up: 0,
        trend_down: 1,
        pressure: 1,
        injury: 1,
        misc: 1,
      }
    : {
        trade: 2,
        scouting: 1,
        draft: seasonContext.phase === 'late_regular' || seasonContext.phase === 'postseason' ? 2 : 1,
        player_heat: 2,
        player_struggle: 1,
        trend_up: 1,
        trend_down: 2,
        pressure: 1,
        injury: 1,
        misc: 1,
      };
  const categoryCounts = new Map();
  const selected = [];
  for (const item of items
    .sort((a, b) => b.score - a.score)
    .filter((item, index, arr) => arr.findIndex((other) => other.key === item.key) === index)) {
    const count = categoryCounts.get(item.category) || 0;
    const cap = categoryCaps[item.category] ?? 1;
    if (count >= cap) continue;
    selected.push(item);
    categoryCounts.set(item.category, count + 1);
    if (selected.length >= limit) break;
  }

  if (selected.length < limit) {
    for (const item of items
      .sort((a, b) => b.score - a.score)
      .filter((item, index, arr) => arr.findIndex((other) => other.key === item.key) === index)) {
      if (selected.some((entry) => entry.key === item.key)) continue;
      selected.push(item);
      if (selected.length >= limit) break;
    }
  }

  return selected.map((item) => item.text);
}

export function buildWeeklyRecapData(ctx) {
  const currentWeek = latestCompletedWeek(ctx.league);
  const seasonContext = ctx.seasonContext || {};
  const phaseLanguage = buildPhaseLanguage(seasonContext);
  const mockSignals = buildMockDraftSignals(ctx, 2);
  const recentGames = currentWeek == null ? [] : listCompletedGames(ctx.league, currentWeek);
  const selectedGames = selectRecapGames(ctx, recentGames, currentWeek);
  const sortedGames = selectedGames.map((entry) => entry.game);
  const gameStoryEntries = selectedGames.map((entry, idx) => {
    const awayScore = Number(entry.game.awayScore || 0);
    const homeScore = Number(entry.game.homeScore || 0);
    const winner = awayScore > homeScore ? entry.away : entry.home;
    const loser = awayScore > homeScore ? entry.home : entry.away;
    const winnerCoach = coachMentionFor(winner, ctx.teamCoachMentions);
    const loserCoach = coachMentionFor(loser, ctx.teamCoachMentions);
    const featuredYoung = awayScore > homeScore ? entry.awayYoung : entry.homeYoung;
    const scoreLine = `${Math.max(awayScore, homeScore)}-${Math.min(awayScore, homeScore)}`;
    const winnerStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
    const loserStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === loser)?.[1];
    const prevWinnerStanding = [...ctx.prevStandings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
    const prevLoserStanding = [...ctx.prevStandings.entries()].find(([teamId]) => ctx.teams.get(teamId) === loser)?.[1];
    const winnerDelta = recordScore(winnerStanding) - recordScore(prevWinnerStanding);
    const loserDelta = recordScore(loserStanding) - recordScore(prevLoserStanding);
    const upsetScore = (recordScore(loserStanding) - recordScore(winnerStanding));
    const collapseSignal = loserDelta <= -1 || entry.margin >= 14 || upsetScore >= 2;
    const riseSignal = winnerDelta >= 1 || entry.margin >= 14;
    const winTemplates = [
      `${winnerCoach ? `${winnerCoach} watched ` : ''}${winner} beat ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}, and the bigger takeaway was the continued rise of ${featuredYoung?.name || winner}. ${featuredYoung ? 'Young production like that changes the shape of a week.' : 'That was the kind of result that felt bigger than one Sunday.'}`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} came out of the week with one of the cleaner statements on the board, putting away ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. A result like that usually changes how the rest of the league talks about you.`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} got the kind of win that travels, beating ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. ${entry.margin <= 7 ? 'It took four quarters.' : `The ${entry.margin}-point margin gave it extra weight.`}`,
    ];
    const lossTemplates = [
      `${loserCoach ? `${loserCoach} and ` : ''}${loser} took the week’s roughest hit, falling ${scoreLine} to ${winnerCoach ? `${winnerCoach} and ` : ''}${winner}. For a team already dealing with pressure, that was the kind of result that sticks.`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} did more than win ${scoreLine} over ${loserCoach ? `${loserCoach} and ` : ''}${loser}; they shoved ${loser} deeper into a bad week. The score only tells part of why that one felt loud.`,
      `${loserCoach ? `${loserCoach} and ` : ''}${loser} walked out of the week with more heat after a ${scoreLine} loss to ${winnerCoach ? `${winnerCoach} and ` : ''}${winner}. Whether it was expectation, momentum, or timing, that result landed hard.`,
    ];
    const neutralTemplates = [
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} survived one of the tighter games on the board, getting past ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. Those are the kind of finishes that can carry weight later in the season.`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} edged out ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine} in one of the week’s cleaner coin-flip games.`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} found a way through ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. In a week full of noise, that one came down to execution late.`,
    ];
    const emphasis = collapseSignal ? 'negative' : (riseSignal ? 'positive' : 'neutral');
    const text = pickTemplate(
      emphasis === 'negative' ? lossTemplates : emphasis === 'positive' ? winTemplates : neutralTemplates,
      currentWeek + idx,
    );
    const leadScore =
      (collapseSignal ? 18 : 0) +
      (riseSignal ? 12 : 0) +
      Math.min(16, entry.margin) +
      (featuredYoung ? 8 : 0) +
      Math.max(0, upsetScore * 6);
    return {
      entry,
      winner,
      loser,
      teams: [winner, loser],
      featuredYoung,
      emphasis,
      text,
      leadScore,
    };
  });

  const movers = [];
  for (const [teamId, standing] of ctx.standings.entries()) {
    const prev = ctx.prevStandings.get(teamId);
    if (!prev) continue;
    const delta = recordScore(standing) - recordScore(prev);
    if (delta !== 0) {
      movers.push({
        delta,
        text: `${coachMentionFor(ctx.teams.get(teamId), ctx.teamCoachMentions) ? `${coachMentionFor(ctx.teams.get(teamId), ctx.teamCoachMentions)}: ` : ''}${ctx.teams.get(teamId)} moved from ${formatRecord(prev)} to ${formatRecord(standing)}.`,
      });
    }
  }

  const topPerformerEntries = ctx.top100.slice(0, 8).map((player) => ({
    team: player.team,
    text: `${player.name} gave ${coachMentionFor(player.team, ctx.teamCoachMentions) || player.team} a true feature performance with a ${formatGrade(player.grade)} grade. The line: ${formatStatLine(player)}.`,
    player,
  }));
  const roughPerformerEntries = ctx.top100
    .slice()
    .reverse()
    .filter((player) => isBadStatLine(player))
    .slice(0, 6)
    .map((player) => ({
      team: player.team,
      text: `${coachMentionFor(player.team, ctx.teamCoachMentions) || player.team} also had to wear a rough outing from ${player.name}. The line was hard to ignore: ${formatStatLine(player)}.`,
      player,
    }));

  const rumors = buildRumorMillItems(ctx, 4);

  const leadGameEntry = gameStoryEntries.slice().sort((a, b) => b.leadScore - a.leadScore)[0] || null;
  const leadGame = leadGameEntry?.entry?.game || null;
  let leadStory = 'The week did not produce a clean lead story from completed game data.';
  if (leadGameEntry) {
    leadStory = leadGameEntry.text;
  }

  const notebookEntries = movers
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map((entry) => ({ team: ctx.teams.get([...ctx.standings.entries()].find(([teamId, standing]) => entry.text.includes(ctx.teams.get(teamId)))?.[0]), text: entry.text.replace(' moved from ', ' changed its footing from ') }));
  const watchEntries = rumors.map((text) => {
    const matchedTeams = [...ctx.teams.values()].filter((team) => String(text).includes(team));
    return { teams: matchedTeams, text };
  });
  const leadTeams = leadGameEntry?.teams || (leadGame ? [ctx.teams.get(Number(leadGame.awayTeamId)), ctx.teams.get(Number(leadGame.homeTeamId))].filter(Boolean) : []);
  const secondaryGameNotes = pickDistinctItems(
    gameStoryEntries.filter((story) => story !== leadGameEntry),
    (story) => story.teams,
    new Set(leadTeams),
    2,
  ).map((story) => story.text).filter(Boolean);
  const notebook = pickDistinctItems(notebookEntries, (entry) => [entry.team], new Set(leadTeams), 2).map((entry) => entry.text);
  const featureEntry = pickDistinctItems(topPerformerEntries, (entry) => [entry.team], new Set([...leadTeams, ...notebookEntries.map((entry) => entry.team).filter(Boolean)]), 1)[0] || topPerformerEntries[0];
  const featurePlayer = featureEntry?.player || null;
  const roughEntry = pickDistinctItems(roughPerformerEntries, (entry) => [entry.team], new Set([...leadTeams, featurePlayer?.team].filter(Boolean)), 1)[0] || null;
  const feature = featurePlayer
    ? pickTemplate([
      `${featurePlayer.name} was the cleanest feature piece on the board this week for ${coachMentionFor(featurePlayer.team, ctx.teamCoachMentions) || featurePlayer.team}. A ${formatGrade(featurePlayer.grade)} grade backed it up, and the production matched the mark: ${formatStatLine(featurePlayer)}.`,
      `${coachMentionFor(featurePlayer.team, ctx.teamCoachMentions) || featurePlayer.team} got a true star turn from ${featurePlayer.name}, who posted a ${formatGrade(featurePlayer.grade)} grade with a line that deserved the attention: ${formatStatLine(featurePlayer)}.`,
      `One performance that kept showing up in every conversation belonged to ${featurePlayer.name}. For ${coachMentionFor(featurePlayer.team, ctx.teamCoachMentions) || featurePlayer.team}, the ${formatGrade(featurePlayer.grade)} grade and ${formatStatLine(featurePlayer)} line made him impossible to leave out of the week.`,
      `If the week needed an individual centerpiece, it was ${featurePlayer.name}. ${coachMentionFor(featurePlayer.team, ctx.teamCoachMentions) || featurePlayer.team} got a ${formatGrade(featurePlayer.grade)} grade and a stat line that read loudly enough on its own: ${formatStatLine(featurePlayer)}.`,
      `${featurePlayer.name} ended up carrying one of the week’s clearest individual stories. The grade hit ${formatGrade(featurePlayer.grade)}, and ${coachMentionFor(featurePlayer.team, ctx.teamCoachMentions) || featurePlayer.team} got every bit of the production: ${formatStatLine(featurePlayer)}.`,
    ], currentWeek + 11)
    : 'No feature performance was available from the current Top 100 pull.';
  const storylineEntries = pickDistinctItems(
    watchEntries,
    (entry) => entry.teams,
    new Set([...leadTeams, featurePlayer?.team, roughEntry?.team].filter(Boolean)),
    2,
  );
  const watchList = pickDistinctItems(
    watchEntries.filter((entry) => !storylineEntries.includes(entry)),
    (entry) => entry.teams,
    new Set([...leadTeams, featurePlayer?.team, roughEntry?.team].filter(Boolean)),
    2,
  ).map((entry) => entry.text);
  const gameParagraph = secondaryGameNotes.length
    ? secondaryGameNotes.join(' ')
    : (gameStoryEntries.length ? gameStoryEntries.slice(0, 2).map((story) => story.text).join(' ') : 'No completed games created a strong enough game note for this recap window.');
  const notebookParagraph = notebook.length
    ? pickTemplate([
      `Around the league, ${notebook.join(' ')}`,
      `${notebook.join(' ')} Those shifts gave the standings a little more shape coming out of the week.`,
      `Not every story came from the headline game. ${notebook.join(' ')}`,
    ], currentWeek + 3)
    : 'The standings did not shift hard enough this week to create a major notebook item.';
  const storylineParagraph = storylineEntries.length
    ? pickTemplate([
      `The week also kept pushing a few bigger league conversations forward. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `Away from the scores themselves, a couple league storylines kept building. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `There was more moving around the league than just the scoreboard. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `The scoreboard never tells the whole story, and this week was no different. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `A lot of the week’s real movement happened outside the final scores. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
    ], currentWeek + 5)
    : null;
  const draftParagraph = mockSignals.length
    ? pickTemplate([
      `The draft conversation also kept creeping into the week. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `Even with the current week still fresh, the mock draft lens is already shaping some of the talk around the league. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `A few front-office conversations are already drifting toward April. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `The latest mock draft also gave the week a little extra shape. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `Some of the week’s quieter talk was already pointing toward the next draft. ${mockSignals.map((signal) => signal.text).join(' ')}`,
    ], currentWeek + 9)
    : null;
  const buzzParagraph = watchList.length
    ? pickTemplate([
      `${watchList.join(' ')}`,
      `A few leaguewide conversations also kept building as the week moved along. ${watchList.join(' ')}`,
      `Beyond the box scores, the league left the week with a couple storylines still hanging in the air: ${watchList.join(' ')}`,
      `The week also left a little noise behind it. ${watchList.join(' ')}`,
      `A few threads are still hanging over the league coming out of this one. ${watchList.join(' ')}`,
    ], currentWeek + 7)
    : 'Leaguewide buzz stayed relatively quiet coming out of this week.';
  const setbackParagraph = roughEntry?.text || null;

  const paragraphBlocks = {
    lead: leadStory,
    phase: phaseLanguage.recapIntro,
    games: gameParagraph,
    notebook: notebookParagraph,
    storylines: storylineParagraph,
    draft: draftParagraph,
    feature,
    setback: setbackParagraph,
    buzz: buzzParagraph,
  };
  const orderPatterns = [
    ['lead', 'phase', 'games', 'storylines', 'feature', 'notebook', 'buzz'],
    ['lead', 'feature', 'phase', 'games', 'storylines', 'buzz', 'notebook'],
    ['lead', 'storylines', 'phase', 'games', 'notebook', 'feature', 'buzz'],
    ['lead', 'games', 'notebook', 'storylines', 'draft', 'buzz', 'feature'],
  ];
  const chosenOrder = orderPatterns[Math.abs(Number(currentWeek) || 0) % orderPatterns.length];
  const paragraphs = [];
  chosenOrder.forEach((key, idx) => {
    const text = paragraphBlocks[key];
    if (text) paragraphs.push(text);
    if (setbackParagraph && idx === 1) paragraphs.push(setbackParagraph);
  });
  if (setbackParagraph && !paragraphs.includes(setbackParagraph)) paragraphs.push(setbackParagraph);

  return {
    currentWeek,
    leadStory,
    biggestWins: gameStoryEntries.map((story) => story.text),
    movers: movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4).map((entry) => entry.text),
    notebook,
    tradeDesk: [],
    topPerformers: topPerformerEntries.map((entry) => entry.text),
    feature,
    watchList,
    rumors,
    paragraphs,
  };
}

export async function buildCommitteeReviewData(ctx) {
  const queue = Object.entries(ctx.activeTrades || {}).map(([tradeId, trade]) => ({ tradeId, ...trade }));
  const pendingCoach = queue.filter((trade) => trade.status === 'awaiting_coach_b');
  const pendingCommittee = queue.filter((trade) => trade.status === 'committee');
  const pendingProof = queue.filter((trade) => trade.status === 'approved_pending_proof');
  const proofEntries = Object.entries(ctx.pendingProofs || {}).map(([tradeId, proof]) => ({ tradeId, ...proof }));

  const fairCounts = ctx.fairsims?.[`year_${ctx.live?.seasonContext?.calendarYear || new Date().getFullYear()}`]?.counts || {};
  const strikeLeaders = Object.entries(fairCounts)
    .filter(([key]) => !String(key).startsWith('team:'))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([userId, count]) => `<@${userId}>: ${count}/5`);

  const pendingThreads = Object.entries(ctx.threadState?.threads || {})
    .filter(([, info]) => info?.status === 'pending' && info?.deadlineAt)
    .map(([threadId, info]) => ({ threadId, ...info }));
  const atRisk = [];
  for (const thread of pendingThreads.slice(0, 12)) {
    const counts = await collectThreadParticipation(ctx.client, ctx.guild, thread);
    const msLeft = Number(thread.deadlineAt || 0) - Date.now();
    const hoursLeft = Math.max(0, Math.round(msLeft / 3600000));
    if (counts.awayCount === 0 || counts.homeCount === 0 || hoursLeft <= 24) {
      const quiet = counts.awayCount === 0 && counts.homeCount === 0
        ? 'both sides silent'
        : counts.awayCount === 0
          ? `${thread.awayTeam} silent`
          : counts.homeCount === 0
            ? `${thread.homeTeam} silent`
            : 'both sides talking but unresolved';
      atRisk.push(`<#${thread.threadId}> • ${thread.awayTeam} vs ${thread.homeTeam} • ${quiet} • ${hoursLeft}h left`);
    }
  }

  return {
    pendingCoach,
    pendingCommittee,
    pendingProof,
    proofEntries,
    strikeLeaders,
    atRisk: atRisk.slice(0, 6),
  };
}
