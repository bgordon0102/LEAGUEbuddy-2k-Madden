import fs from 'fs';
import path from 'path';
import { buildLiveDraftContext, getUpcomingDraftYear } from './coach/draft_live_data.js';
import { applyPickTrades, deriveTeamNeeds, draftOrder } from './coach/mockdraft.js';
import {
  ensureStrikeSeason,
  weightedCount,
  formatBreakdown,
  completionRate,
  communicationSummary,
} from '../shared/madden_strikes.js';
import { getFullTeamName } from '../shared/madden_team_names.js';
import { loadRoleMap } from './staff/staffUtils.js';
import { getScoutSummaryForSeason } from './coach/scout_store.js';

const STRIKES_PATH = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const SCOUT_POINTS_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_points.json');
const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'madden', 'active_trades.json');
const TOP_PLAYERS_PATH = path.join(process.cwd(), 'data', 'madden', 'top_players.json');

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

function seededText(seedKey, templates = [], replacements = {}) {
  const seed = [...String(seedKey || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  let template = templates.length ? templates[Math.abs(seed) % templates.length] : '';
  for (const [key, value] of Object.entries(replacements || {})) {
    template = template.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return template;
}

function average(values = []) {
  const nums = values.map((value) => Number(value || 0)).filter((value) => Number.isFinite(value));
  if (!nums.length) return 0;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function recordScore(standing) {
  if (!standing) return 0;
  return Number(standing.totalWins || 0) - Number(standing.totalLosses || 0);
}

function formatRecord(standing) {
  if (!standing) return '0-0';
  const wins = Number(standing.totalWins || 0);
  const losses = Number(standing.totalLosses || 0);
  const ties = Number(standing.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatNeedLabel(need) {
  const labels = {
    QB: 'Quarterback',
    OT: 'Offensive Tackle',
    IOL: 'Interior OL',
    WR: 'Wide Receiver',
    TE: 'Tight End',
    RB: 'Running Back',
    EDGE: 'Edge Rusher',
    DT: 'Defensive Tackle',
    LB: 'Linebacker',
    CB: 'Cornerback',
    S: 'Safety',
    BPA: 'Best Player Available',
  };
  return labels[need] || need || 'Need';
}

function playerName(player) {
  return player?.displayName || `${player?.firstName || ''} ${player?.lastName || ''}`.trim() || player?.name || 'Unknown';
}

function playerOvr(player) {
  return Number(player?.playerBestOvr ?? player?.teamSchemeOvr ?? player?.overallRating ?? player?.overall ?? 0);
}

function playerDevTier(player) {
  const raw = player?.devTrait ?? player?.raw?.devTrait ?? player?.developmentTrait ?? player?.raw?.developmentTrait;
  if (raw == null) return 0;
  if (typeof raw === 'number') return Number(raw);
  const text = String(raw).toUpperCase();
  if (text.includes('XFACTOR')) return 3;
  if (text.includes('SUPERSTAR')) return 2;
  if (text.includes('STAR')) return 1;
  return 0;
}

function playerDevLabel(player) {
  const tier = playerDevTier(player);
  return ({ 3: 'X-Factor', 2: 'Superstar', 1: 'Star', 0: 'Normal' })[tier] || 'Normal';
}

function developmentPushLine(player) {
  if (!player) return null;
  const name = playerName(player);
  const pos = String(player?.position || '').toUpperCase();
  const tier = playerDevTier(player);
  const label = playerDevLabel(player);
  const role = ['WR', 'TE', 'HB', 'RB', 'FB'].includes(pos)
    ? 'touches'
    : ['CB', 'FS', 'SS', 'MLB', 'ROLB', 'LOLB', 'LE', 'RE', 'DT', 'DE', 'EDGE'].includes(pos)
      ? 'impact snaps'
      : ['QB'].includes(pos)
        ? 'usage'
        : 'snaps';

  if (tier === 2) {
    return `${name} (${label} ${pos}) is a real X-Factor push candidate if you keep giving him ${role}.`;
  }
  if (tier === 1) {
    return `${name} (${label} ${pos}) is worth leaning into if you want to give him a real Superstar runway.`;
  }
  return `${name} (${label} ${pos}) is worth more ${role} right now.`;
}

function resolveCoachRole(teamName) {
  const roleMap = loadRoleMap();
  for (const [name, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(name)) continue;
    const base = name.replace(/ coach$/i, '').trim();
    if (normalizeName(base) === normalizeName(teamName)) {
      return { roleId, roleName: name };
    }
  }
  return { roleId: null, roleName: null };
}

function resolveCoachUserId(teamName, guild, fallbackUserId = null) {
  if (fallbackUserId) return fallbackUserId;
  const { roleId } = resolveCoachRole(teamName);
  if (!guild || !roleId) return null;
  const role = guild.roles?.cache?.get(roleId);
  return role?.members?.first?.()?.id || null;
}

function buildTeamMaps(league) {
  const teamsById = new Map();
  const standingsById = new Map();
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    teamsById.set(Number(team.teamId), getFullTeamName(team, `Team ${team.teamId}`));
  }
  for (const standing of league?.standings?.teamStandingInfoList || []) {
    standingsById.set(Number(standing.teamId), standing);
  }
  return { teamsById, standingsById };
}

function findTeamIdByName(league, teamName) {
  const target = normalizeName(teamName);
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    const full = getFullTeamName(team, `Team ${team.teamId}`);
    const mascot = String(team?.displayName || team?.nickName || '').trim();
    const city = String(team?.cityName || '').trim();
    const abbr = String(team?.abbrName || '').trim();
    const candidates = [full, mascot, city, abbr].map(normalizeName).filter(Boolean);
    if (candidates.includes(target)) return Number(team.teamId);
    if (candidates.some((candidate) => candidate.includes(target) || target.includes(candidate))) {
      return Number(team.teamId);
    }
  }
  return null;
}

function rankWithin(list = [], targetTeamId) {
  const idx = list.findIndex((entry) => Number(entry.teamId) === Number(targetTeamId));
  return idx >= 0 ? idx + 1 : null;
}

function teamTopPlayers(top100 = [], teamName, limit = 3) {
  return top100
    .filter((player) => normalizeName(player.team) === normalizeName(teamName))
    .sort((a, b) => Number(b.grade || 0) - Number(a.grade || 0))
    .slice(0, limit);
}

function rosterCorePlayers(rosterPlayers = [], limit = 3) {
  return [...rosterPlayers]
    .sort((a, b) => {
      const ovrDiff = playerOvr(b) - playerOvr(a);
      if (ovrDiff !== 0) return ovrDiff;
      return Number(a.age || 99) - Number(b.age || 99);
    })
    .slice(0, limit)
    .map((player) => `${playerName(player)} (${player.position}) ${playerOvr(player)} OVR`);
}

function positionGroupCount(rosterPlayers = [], targetPos) {
  const needMap = {
    QB: ['QB'],
    OT: ['LT', 'RT'],
    IOL: ['LG', 'C', 'RG'],
    WR: ['WR'],
    TE: ['TE'],
    RB: ['HB', 'RB', 'FB'],
    EDGE: ['LE', 'RE', 'DE', 'EDGE', 'ROLB', 'LOLB'],
    DT: ['DT'],
    LB: ['MLB', 'LB'],
    CB: ['CB'],
    S: ['FS', 'SS'],
  };
  const group = new Set(needMap[targetPos] || [targetPos]);
  return rosterPlayers.filter((player) => group.has(String(player?.position || '').toUpperCase())).length;
}

function expiringCore(rosterPlayers = [], limit = 3) {
  return rosterPlayers
    .filter((player) => Number(player.contractYearsLeft ?? 99) <= 1 && playerOvr(player) >= 80)
    .sort((a, b) => playerOvr(b) - playerOvr(a))
    .slice(0, limit);
}

function extensionCandidates(rosterPlayers = [], limit = 3) {
  return rosterPlayers
    .filter((player) => Number(player.contractYearsLeft ?? 99) <= 1 && playerOvr(player) >= 83 && Number(player.age || 0) <= 29)
    .sort((a, b) => playerOvr(b) - playerOvr(a))
    .slice(0, limit);
}

function agingCore(rosterPlayers = [], limit = 3) {
  return rosterPlayers
    .filter((player) => Number(player.age || 0) >= 29 && playerOvr(player) >= 80)
    .sort((a, b) => Number(b.age || 0) - Number(a.age || 0) || playerOvr(b) - playerOvr(a))
    .slice(0, limit);
}

function youngDevelopmentPieces(rosterPlayers = [], limit = 3) {
  return rosterPlayers
    .filter((player) => Number(player.age || 99) <= 24 && playerOvr(player) >= 74)
    .sort((a, b) =>
      playerOvr(b) - playerOvr(a) ||
      Number(a.age || 99) - Number(b.age || 99))
    .slice(0, limit);
}

function usageTotalForPlayer(player = {}) {
  const passVolume = Number(player.passAtt || 0) + Number(player.passTDs || 0) * 4;
  const skillVolume =
    Number(player.rushAtt || 0) * 1.2 +
    Number(player.recYds || 0) / 12 +
    Number(player.rushYds || 0) / 12 +
    Number(player.recTDs || 0) * 5 +
    Number(player.rushTDs || 0) * 5;
  const defenseVolume =
    Number(player.def?.tackles || player.tackles || 0) +
    Number(player.sacks || 0) * 6 +
    Number(player.interceptions || 0) * 8 +
    Number(player.def?.pds || 0) * 1.5;
  return passVolume + skillVolume + defenseVolume;
}

function usageDevelopmentCandidates(rosterPlayers = [], live = null, teamId = null, limit = 2) {
  const teamPlayers = (live?.currentPlayersByTeamId?.[Number(teamId)] || [])
    .filter((player) => Number(player?.teamId) === Number(teamId));
  const playerStatsByRosterId = live?.playerStatsByRosterId || {};
  const merged = rosterPlayers.map((player) => {
    const stats = playerStatsByRosterId[player?.rosterId] || teamPlayers.find((entry) => Number(entry?.rosterId) === Number(player?.rosterId)) || {};
    const volume = usageTotalForPlayer(stats);
    return {
      ...player,
      usageVolume: volume,
      usageStats: stats,
    };
  });

  return merged
    .filter((player) => Number(player.age || 99) <= 24 && playerOvr(player) >= 74)
    .filter((player) => !['K', 'P'].includes(String(player.position || '').toUpperCase()))
    .filter((player) => Number(player.usageVolume || 0) <= 18)
    .sort((a, b) =>
      (playerDevTier(b) - playerDevTier(a)) ||
      (playerOvr(b) - playerOvr(a)) ||
      (Number(a.usageVolume || 0) - Number(b.usageVolume || 0)) ||
      (Number(a.age || 99) - Number(b.age || 99)))
    .slice(0, limit);
}

function cutCandidates(rosterPlayers = [], limit = 3) {
  return rosterPlayers
    .filter((player) => {
      const ovr = playerOvr(player);
      const age = Number(player.age || 0);
      const yearsLeft = Number(player.contractYearsLeft ?? 99);
      const capHit = Number(player.capHit || 0);
      const savings = Number(player.capReleaseNetSavings || 0);
      const penalty = Number(player.capReleasePenalty || 0);
      return ovr <= 75 && age >= 26 && capHit >= 2 && savings >= penalty;
    })
    .sort((a, b) =>
      (Number(b.capReleaseNetSavings || 0) - Number(a.capReleaseNetSavings || 0)) ||
      (Number(b.age || 0) - Number(a.age || 0)) ||
      (playerOvr(a) - playerOvr(b)))
    .slice(0, limit);
}

function shopCandidates(rosterPlayers = [], topNeeds = [], limit = 3) {
  const premiumNeedGroups = new Set(topNeeds.slice(0, 2));
  return rosterPlayers
    .filter((player) => Number(player.contractYearsLeft ?? 99) <= 1 && playerOvr(player) >= 80)
    .filter((player) => !premiumNeedGroups.has(String(player.position || '').toUpperCase()))
    .sort((a, b) => playerOvr(b) - playerOvr(a))
    .slice(0, limit);
}

function formatCapFigure(player) {
  const cap = Number(player?.capHit || 0);
  if (!cap) return null;
  const millions = cap >= 100000 ? cap / 1000000 : cap;
  const rounded = Math.round(millions * 10) / 10;
  return `$${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}M`;
}

function formatActionPlayer(player, opts = {}) {
  if (!player) return null;
  const bits = [`${playerName(player)} (${player.position})`, `${playerOvr(player)} OVR`];
  const age = Number(player.age || 0);
  if (age) bits.push(`age ${age}`);
  if (opts.includeContract && Number(player.contractYearsLeft ?? 99) <= 2) {
    bits.push(`${Number(player.contractYearsLeft || 0)}y left`);
  }
  const cap = formatCapFigure(player);
  if (opts.includeCap && cap) bits.push(cap);
  return bits.join(' • ');
}

function scoutingSummaryForUser(scoutPoints, userId, classId, seasonYear, weekNumber) {
  const user = getScoutSummaryForSeason(scoutPoints || {}, userId, `year_${seasonYear}`);
  const scoped = user?.players?.[classId] || {};
  const entries = Object.entries(scoped);
  const fullCount = entries.filter(([, unlocked]) => Array.isArray(unlocked) && unlocked.length >= 3).length;
  const partialCount = entries.filter(([, unlocked]) => Array.isArray(unlocked) && unlocked.length > 0 && unlocked.length < 3).length;
  const weekKey = `year_${seasonYear}_week_${weekNumber}`;
  const seasonKey = `year_${seasonYear}`;
  const currentPoints = user?.weeklyPoints?.[weekKey];
  const bonus = Number(user?.scoutingBonus || 0);
  return {
    fullCount,
    partialCount,
    currentPoints: Number.isFinite(Number(currentPoints)) ? Number(currentPoints) : null,
    bonus,
  };
}

function scoutingIdentitySignal(scoutLog, teamName, classId, seasonYear) {
  const teamEntries = (scoutLog || []).filter((entry) =>
    normalizeName(entry?.teamName || entry?.team || '') === normalizeName(teamName) &&
    normalizeName(entry?.classId || '') === normalizeName(classId) &&
    Number(entry?.seasonYear || seasonYear) === Number(seasonYear)
  );
  const counts = {};
  for (const entry of teamEntries) {
    const pos = String(entry?.position || '').toUpperCase();
    if (!pos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked.slice(0, 3).map(([pos]) => pos);
}

function countTeamTrades(activeTrades, teamName) {
  const trades = Object.values(activeTrades || {}).filter((trade) =>
    [trade?.yourTeam, trade?.otherTeam].some((name) => normalizeName(name) === normalizeName(teamName))
  );
  return {
    total: trades.length,
    accepted: trades.filter((trade) => ['committee', 'approved_pending_proof'].includes(trade?.status)).length,
    pendingCoach: trades.filter((trade) => trade?.status === 'awaiting_coach_b').length,
  };
}

function countTeamPicks(league, teamName) {
  const year = getUpcomingDraftYear(league);
  const order = applyPickTrades(draftOrder(league), year);
  const picks = order.filter((pick) => normalizeName(pick.team) === normalizeName(teamName));
  const firsts = picks.filter((pick) => Number(pick.round) === 1).length;
  return { year, total: picks.length, firsts };
}

function identityForTeam({ record, avgAge, pickInfo, tradeInfo, scoutFocus, needs, standing, topPlayers }) {
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const score = wins - losses;
  const premiumScout = scoutFocus.some((pos) => ['QB', 'OT', 'WR', 'EDGE', 'CB'].includes(pos));
  if (tradeInfo.accepted >= 2 || tradeInfo.total >= 3) {
    return {
      short: 'Active market team',
      line: 'The front office profile still reads aggressive. This team is willing to use the market instead of waiting for the board to fix everything.',
    };
  }
  if (score >= 2 && avgAge >= 27.4) {
    return {
      short: 'Win-now build',
      line: 'This still reads like a win-now roster. The front office posture is about patching live holes around a team expected to compete now.',
    };
  }
  if (pickInfo.firsts >= 2 || (pickInfo.total >= 8 && avgAge <= 26.5)) {
    return {
      short: 'Capital-heavy build',
      line: 'The front office has enough extra capital to stay patient. This looks more like a roster that can pick its spots than one that has to force urgency.',
    };
  }
  if (premiumScout || needs.some((need) => ['QB', 'OT', 'CB', 'EDGE'].includes(need))) {
    return {
      short: 'Premium-position hunting',
      line: 'The front office profile points toward premium positions first. Quarterback, tackle, corner, and edge pressure still shape the way this team should build.',
    };
  }
  if (avgAge <= 26.2 || topPlayers.some((player) => Number(player?.yearsPro ?? 99) <= 1)) {
    return {
      short: 'Young-core build',
      line: 'This still feels like a young-core build. The priority is protecting the foundation and adding clean long-term fits, not chasing short-term noise.',
    };
  }
  return {
    short: 'Balanced build',
    line: 'The front office profile is fairly balanced right now. This is more about staying disciplined on needs and timing than forcing one extreme direction.',
  };
}

function seasonStateLine({ seasonContext, standing, teamName }) {
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const week = Number(seasonContext?.completedRegularWeeks || 0);
  if (seasonContext?.phase === 'postseason') {
    return `${teamName} are in the postseason now. Every weakness gets exposed faster at this point of the year.`;
  }
  if (seasonContext?.phase === 'offseason') {
    return `${teamName} are in offseason mode now. The focus shifts from surviving the week to protecting the roster and pushing the next move cleanly.`;
  }
  if (wins === 0 && losses >= 4) {
    return `${teamName} are already in a real pressure pocket. At ${formatRecord(standing)}, every week starts carrying some season-shape urgency.`;
  }
  if (seasonContext?.phase === 'late_regular' && wins < losses) {
    return `${teamName} are running out of soft weeks. The rest of the season is more about leverage and staying alive than patience.`;
  }
  if (seasonContext?.phase === 'early_regular') {
    return `${teamName} are still in the part of the season where identity matters more than panic, but the bigger pressure points are already visible.`;
  }
  if (seasonContext?.phase === 'mid_regular') {
    return `${teamName} are into the part of the season where the roster starts telling the truth. Record, depth, and real weak spots all matter more now.`;
  }
  if (week >= 10) {
    return `${teamName} are into the stretch where the roster has to carry more of the story. Clean holes do not stay hidden for long this late in the year.`;
  }
  return `${teamName} are still in a live weekly push. The shape of the roster matters now, but the season still has room to move.`;
}

function playoffContextLine(league, standing, teamId, teamName) {
  const conference = String(standing?.conferenceName || '').toLowerCase();
  const confTeams = (league?.standings?.teamStandingInfoList || [])
    .filter((team) => String(team?.conferenceName || '').toLowerCase() === conference)
    .slice()
    .sort((a, b) => Number(b?.winPct || 0) - Number(a?.winPct || 0) || Number(b?.totalWins || 0) - Number(a?.totalWins || 0));
  const confRank = rankWithin(confTeams, teamId);
  if (!confRank) return `${teamName} do not have a clean playoff read from the current standings export.`;
  if (confRank <= 3) return `${teamName} are near the top of the conference picture. The question is less about survival and more about holding leverage.`;
  if (confRank <= 7) return `${teamName} are in the current playoff picture. The pressure is on protecting ground, not giving it back.`;
  return `${teamName} are outside the current playoff picture. The next stretch has to look cleaner if they want real race relevance.`;
}

function rosterPressureLine(needs, expiring, aging, teamName) {
  const topNeed = formatNeedLabel(needs[0] || 'BPA').toLowerCase();
  const secondNeed = formatNeedLabel(needs[1] || needs[0] || 'BPA').toLowerCase();
  if (expiring.length) {
    return `${teamName} have real contract pressure at ${expiring.map((player) => player.position).join(', ')}. That makes ${topNeed} and ${secondNeed} harder to ignore.`;
  }
  if (aging.length) {
    return `${teamName} have enough age pressure on core snaps that ${topNeed} and ${secondNeed} feel more like upkeep than luxury.`;
  }
  return `${teamName} are mostly staring at roster-shape pressure, not one emergency. ${topNeed} and ${secondNeed} are still the cleanest ways to move the roster forward.`;
}

function tradePostureLine({ standing, identity, expiring, pickInfo, needs, tradeInfo, teamName }) {
  const wins = Number(standing?.totalWins || 0);
  const losses = Number(standing?.totalLosses || 0);
  const primaryNeed = formatNeedLabel(needs[0] || 'BPA').toLowerCase();
  const secondaryNeed = formatNeedLabel(needs[1] || needs[0] || 'BPA').toLowerCase();
  if (wins - losses >= 2) {
    return {
      short: 'Buyer lean',
      line: `${teamName} should be open to buying if the market fits. Consolidating depth or picks for a real ${primaryNeed} answer is the cleanest push.`,
    };
  }
  if (losses - wins >= 2 && expiring.length) {
    return {
      short: 'Seller lean',
      line: `${teamName} should be listening on expiring veterans. If they move, the cleanest return is more capital or a younger ${primaryNeed}/${secondaryNeed} fit.`,
    };
  }
  if (pickInfo.firsts >= 2) {
    return {
      short: 'Flexible hold',
      line: `${teamName} have enough draft leverage to stay flexible. The better trade posture is patience unless a premium ${primaryNeed} solution actually comes loose.`,
    };
  }
  if (tradeInfo.accepted > 0 || identity.short === 'Active market team') {
    return {
      short: 'Market-active',
      line: `${teamName} already look active enough in the market. The best next move is quality over volume: one real starter move, not three smaller ones.`,
    };
  }
  return {
    short: 'Selective hold',
    line: `${teamName} do not need to force movement. If they push a deal, it should clearly improve ${primaryNeed} or ${secondaryNeed}, not just shuffle depth.`,
  };
}

function findTradeTargets(league, ownTeamId, needs = [], limit = 3) {
  const standings = new Map((league?.standings?.teamStandingInfoList || []).map((row) => [Number(row.teamId), row]));
  const allTeams = league?.rosters?.teams || {};
  const targets = [];
  for (const [teamIdRaw, team] of Object.entries(allTeams)) {
    const teamId = Number(teamIdRaw);
    if (teamId === Number(ownTeamId)) continue;
    const standing = standings.get(teamId);
    const sellerLean = Number(standing?.totalLosses || 0) > Number(standing?.totalWins || 0);
    const players = team?.rosterInfoList || [];
    const topLocked = [...players]
      .slice()
      .sort((a, b) => playerOvr(b) - playerOvr(a))
      .slice(0, 2)
      .map((player) => Number(player?.rosterId));
    for (const need of needs.slice(0, 3)) {
      const groupCount = positionGroupCount(players, need);
      const candidates = players
        .filter((player) => {
          const pos = String(player?.position || '').toUpperCase();
          const map = {
            QB: ['QB'],
            OT: ['LT', 'RT'],
            IOL: ['LG', 'C', 'RG'],
            WR: ['WR'],
            TE: ['TE'],
            RB: ['HB', 'RB', 'FB'],
            EDGE: ['LE', 'RE', 'DE', 'EDGE', 'ROLB', 'LOLB'],
            DT: ['DT'],
            LB: ['MLB', 'LB', 'ROLB', 'LOLB'],
            CB: ['CB'],
            S: ['FS', 'SS'],
          };
          return (map[need] || [need]).includes(pos);
        })
        .filter((player) => playerOvr(player) >= 77 && playerOvr(player) <= 89 && Number(player.age || 0) <= 30)
        .filter((player) => !topLocked.includes(Number(player?.rosterId)))
        .filter((player) => sellerLean || Number(player.contractYearsLeft ?? 99) <= 1 || groupCount >= 4)
        .sort((a, b) => {
          const aScore = playerOvr(a) + (sellerLean ? 6 : 0) + (Number(a.contractYearsLeft ?? 99) <= 1 ? 4 : 0) + Math.max(0, groupCount - 2) - Math.max(0, playerOvr(a) - 86);
          const bScore = playerOvr(b) + (sellerLean ? 6 : 0) + (Number(b.contractYearsLeft ?? 99) <= 1 ? 4 : 0) + Math.max(0, groupCount - 2) - Math.max(0, playerOvr(b) - 86);
          return bScore - aScore;
        });
      const best = candidates[0];
      if (!best) continue;
      targets.push({
        player: best,
        teamId,
        teamName: getFullTeamName((league?.teams?.leagueTeamInfoList || []).find((t) => Number(t.teamId) === teamId), `Team ${teamId}`),
        need,
        sellerLean,
        depth: groupCount,
      });
    }
  }
  return targets
    .sort((a, b) =>
      Number(b.sellerLean) - Number(a.sellerLean) ||
      (b.depth - a.depth) ||
      (playerOvr(b.player) - playerOvr(a.player)))
    .filter((entry, index, arr) => arr.findIndex((other) => other.player?.rosterId === entry.player?.rosterId) === index)
    .slice(0, limit);
}

function buildActionPlanParagraph(teamName, actions = {}, identity, tradePosture, seasonContext = {}) {
  const extend = actions.extend?.[0];
  const extendBase = extend ? String(extend).split(' • ')[0] : null;
  const shop = (actions.shop || []).find((entry) => String(entry).split(' • ')[0] !== extendBase) || actions.shop?.[0];
  const cut = actions.cut?.[0];
  const target = (actions.targets || []).find((entry) => {
    const base = String(entry).split(' • ')[0];
    return base !== extendBase && base !== (shop ? String(shop).split(' • ')[0] : null);
  }) || actions.targets?.[0];
  const young = (actions.young || []).find((entry) => {
    const base = String(entry).split(' • ')[0];
    return base !== extendBase && base !== (shop ? String(shop).split(' • ')[0] : null);
  }) || actions.young?.[0];
  const parts = [];
  const phase = seasonContext?.phase || 'offseason';
  const shortPlayer = (text = '') => String(text).replace(/\s*•\s*age\s+\d+/i, '').replace(/\s*•\s*\d+y left/i, '').replace(/\s*•\s*\$[\d.]+M/i, '').replace(/\s*•\s*save\s+\$[\d.]+M/i, '').trim();
  if (phase === 'offseason') {
    if (extend) parts.push(`Start with an extension call on ${shortPlayer(extend)}.`);
    if (shop) parts.push(`If one veteran moves, start with ${shortPlayer(shop)}.`);
    if (target) parts.push(`One realistic outside check: ${shortPlayer(target)}.`);
    if (cut) parts.push(`Easy cap cleanup starts with ${shortPlayer(cut)}.`);
  } else if (phase === 'postseason') {
    if (extend) parts.push(`Keep the next contract call ready on ${shortPlayer(extend)}.`);
    if (target) parts.push(`First outside fit to watch: ${shortPlayer(target)}.`);
    if (shop) parts.push(`Future trade call to keep open: ${shortPlayer(shop)}.`);
  } else {
    if (extend) parts.push(`Keep the contract call ready on ${shortPlayer(extend)}.`);
    if (shop) parts.push(`If you move first, shop ${shortPlayer(shop)}.`);
    if (target) parts.push(`One outside fit worth a call: ${shortPlayer(target)}.`);
    if (cut && phase !== 'early_regular') parts.push(`Cap cleanup can still start with ${shortPlayer(cut)}.`);
  }
  if (young) parts.push(`More snaps are worth finding for ${shortPlayer(young)}.`);
  if (!parts.length) {
    parts.push(`${teamName} do not need a forced move right now. The cleaner play is patience and keeping the roster flexible.`);
  }
  return parts.slice(0, 3).filter(Boolean).join(' ');
}

function buildFrontOfficeParagraph(teamName, identity, pressureLine, tradePosture, actionPlan, seasonContext = {}) {
  const phase = seasonContext?.phase || 'offseason';
  const phaseLead = phase === 'offseason'
    ? seededText(`fo_phase:${teamName}:${phase}`, [
        `{team} are in roster-shaping season now.`,
        `This is the part of the year where {team} need cleaner roster calls than big swings.`,
      ], { team: teamName })
    : phase === 'postseason'
      ? seededText(`fo_phase:${teamName}:${phase}`, [
          `The postseason is clarifying what {team} still need to solve.`,
          `With the playoff lens on everything, the roster picture around {team} is sharper now.`,
        ], { team: teamName })
      : seededText(`fo_phase:${teamName}:${phase}`, [
          `The roster read on {team} is starting to settle in.`,
          `{team} are at the point of the season where the real pressure spots are easier to see.`,
        ], { team: teamName });

  const identityShort = identity?.short === 'Premium-position hunting'
    ? `${teamName} still need premium positions to lead the build.`
    : identity?.short === 'Win-now build'
      ? `${teamName} still need to be handled like a win-now roster.`
      : identity?.short === 'Young-core build'
        ? `${teamName} still look more like a young-core roster than a one-move fix.`
        : identity?.short === 'Capital-heavy build'
          ? `${teamName} can stay patient if the market gets noisy.`
          : `${teamName} need clean, disciplined moves more than volume.`;

  const pressureShort = seededText(`fo_pressure_short:${teamName}:${phase}`, [
    `${String(pressureLine || '').replace(`${teamName} `, '')}`,
    `The clearest pressure still sits in ${String(pressureLine || '')
      .replace(`${teamName} have real contract pressure at `, '')
      .replace(`${teamName} have enough age pressure on core snaps that `, '')
      .replace(`${teamName} are mostly staring at roster-shape pressure, not one emergency. `, '')
      .replace(/\.$/, '')}.`,
  ]);

  const tradeShort = tradePosture?.short === 'Seller lean'
    ? `If the year keeps sliding, turn expiring value into younger fits or picks.`
    : tradePosture?.short === 'Buyer lean'
      ? `If you push the market, make it for a real starter and not a depth shuffle.`
      : tradePosture?.short === 'Flexible hold'
        ? `The extra draft leverage lets you wait for the right fit.`
        : tradePosture?.short === 'Market-active'
          ? `The next move should be quality over volume.`
          : `There is no need to force a move unless it clearly upgrades a weak spot.`;
  const actionShort = String(actionPlan || '')
    .split(/(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);
  const orderPatterns = [
    [phaseLead, pressureShort, tradeShort, ...actionShort],
    [identityShort, phaseLead, ...actionShort, tradeShort],
    [phaseLead, ...actionShort, pressureShort, tradeShort],
    [tradeShort, phaseLead, pressureShort, ...actionShort],
  ];
  const seed = [...`${teamName}:${phase}:${tradePosture?.short || ''}`].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const ordered = orderPatterns[Math.abs(seed) % orderPatterns.length]
    .filter(Boolean)
    .slice(0, 4)
    .map((sentence) => String(sentence).trim());
  return ordered.join(' ');
}

function buildFranchiseReadParagraph(profileLike = {}) {
  const {
    teamName,
    stateLine,
    playoffLine,
    buildAround,
    contractLine,
    developmentLine,
    needs = [],
    frontOfficeParagraph,
    awardLine,
    record,
    identity,
    tradePosture,
  } = profileLike;

  const needLine = needs.length
    ? seededText(`fr_read_needs:${teamName}:${record}`, [
        `The cleanest need stack still reads ${needs.slice(0, 3).join(', ')}.`,
        `Need order still points first to ${needs.slice(0, 3).join(', ')}.`,
      ])
    : null;

  const shortState = seededText(`fr_read_state:${teamName}:${record}`, [
    `${stateLine}`,
    `${playoffLine}`,
  ]);

  const shortRoster = seededText(`fr_read_roster:${teamName}:${record}`, [
    `${buildAround}`,
    `${contractLine}`,
  ]);

  const shortIdentity = identity?.short && tradePosture?.short
    ? seededText(`fr_read_identity:${teamName}:${identity.short}:${tradePosture.short}`, [
        `${teamName} are reading like a ${String(identity.short).toLowerCase()} with a ${String(tradePosture.short).toLowerCase()}.`,
        `${String(identity.short).replace(/^[A-Z]/, (m) => m.toLowerCase())} still fits this roster, and the market posture stays ${String(tradePosture.short).toLowerCase()}.`,
      ])
    : null;

  const orderPatterns = [
    [shortState, shortRoster, frontOfficeParagraph],
    [shortRoster, developmentLine, frontOfficeParagraph],
    [shortState, developmentLine, frontOfficeParagraph],
    [shortIdentity, shortRoster, frontOfficeParagraph],
    [shortState, awardLine, frontOfficeParagraph],
  ];
  const seed = [...`${teamName}:${record}:${identity?.short || ''}:${tradePosture?.short || ''}`]
    .reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const ordered = (orderPatterns[Math.abs(seed) % orderPatterns.length] || [shortState, shortRoster, frontOfficeParagraph])
    .filter(Boolean)
    .slice(0, 3);
  return ordered.join(' ');
}

function awardRaceSignal(topPlayers = [], teamName) {
  const teamPlayers = topPlayers.filter((player) => normalizeName(player.team) === normalizeName(teamName));
  const mvp = teamPlayers.find((player) => String(player.position || '').toUpperCase() === 'QB');
  const rookie = teamPlayers.find((player) => Number(player?.yearsPro ?? 99) <= 1);
  const defender = teamPlayers.find((player) => ['CB', 'FS', 'SS', 'LE', 'RE', 'DT', 'EDGE', 'ROLB', 'LOLB', 'MLB'].includes(String(player.position || '').toUpperCase()));
  if (mvp && Number(mvp.grade || 0) >= 90) return `${mvp.name} is keeping ${teamName} in real award-race conversation.`;
  if (rookie && Number(rookie.grade || 0) >= 88) return `${rookie.name} is giving ${teamName} live rookie-race juice right now.`;
  if (defender && Number(defender.grade || 0) >= 89) return `${defender.name} is playing well enough to keep ${teamName} in the defensive-awards conversation.`;
  return null;
}

export function buildFranchiseProfileContext(league, guild = null) {
  if (!league) return null;
  const live = buildLiveDraftContext(league);
  const { teamsById, standingsById } = buildTeamMaps(league);
  const top100All = safeReadJSON(TOP_PLAYERS_PATH, {});
  const leagueId = String(league?.info?.leagueId || league?.leagueId || '');
  const top100 = top100All?.[leagueId]?.top100 || [];
  return {
    league,
    guild,
    live,
    seasonContext: live?.seasonContext || null,
    teamsById,
    standingsById,
    needsByTeam: deriveTeamNeeds(league),
    strikes: safeReadJSON(STRIKES_PATH, {}),
    scoutPoints: safeReadJSON(SCOUT_POINTS_PATH, {}),
    scoutLog: safeReadJSON(SCOUT_LOG_PATH, []),
    activeTrades: safeReadJSON(ACTIVE_TRADES_PATH, {}),
    top100,
    pickInfoYear: getUpcomingDraftYear(league),
  };
}

export function buildFranchiseProfile(ctx, teamName, options = {}) {
  if (!ctx?.league || !teamName) return null;
  const teamId = findTeamIdByName(ctx.league, teamName);
  if (teamId == null) return null;
  const seasonYear = Number(ctx?.seasonContext?.calendarYear || ctx?.league?.info?.careerHubInfo?.seasonInfo?.calendarYear || new Date().getFullYear());
  const weekNumber = Number(ctx?.seasonContext?.currentWeek || ctx?.league?.currentWeek || 1);
  const classId = (() => {
    const seasonInfo = ctx.league?.info?.careerHubInfo?.seasonInfo || {};
    const seasonOrdinal = Number(seasonInfo?.seasonYear ?? ctx.league?.info?.seasonYear ?? ctx.league?.seasonYear);
    if (Number.isFinite(seasonOrdinal) && seasonOrdinal >= 0 && seasonOrdinal < 50) {
      return `cus_${String(seasonOrdinal + 1).padStart(2, '0')}`;
    }
    const calendarYear = Number(seasonInfo?.calendarYear || ctx.league?.info?.calendarYear || ctx.league?.calendarYear || 2025);
    return `cus_${String(Math.max(1, calendarYear - 2024)).padStart(2, '0')}`;
  })();

  const standing = ctx.standingsById.get(teamId);
  const teamNeeds = ctx.needsByTeam[normalizeName(teamName)] || ['BPA'];
  const roster = ctx.league?.rosters?.teams?.[String(teamId)]?.rosterInfoList || [];
  const core = rosterCorePlayers(roster, 3);
  const topPlayers = teamTopPlayers(ctx.top100, teamName, 3);
  const avgAge = average(roster.map((player) => player.age));
  const expiring = expiringCore(roster, 3);
  const extensions = extensionCandidates(roster, 3);
  const aging = agingCore(roster, 3);
  const young = youngDevelopmentPieces(roster, 3);
  const usageYoung = usageDevelopmentCandidates(roster, ctx.live, teamId, 2);
  const cuts = cutCandidates(roster, 3);
  const shops = shopCandidates(roster, teamNeeds, 3);
  const pickInfo = countTeamPicks(ctx.league, teamName);
  const tradeInfo = countTeamTrades(ctx.activeTrades, teamName);
  const tradeTargets = findTradeTargets(ctx.league, teamId, teamNeeds, 3);
  const scoutFocus = scoutingIdentitySignal(ctx.scoutLog, teamName, classId, seasonYear);
  const identity = identityForTeam({
    record: formatRecord(standing),
    avgAge,
    pickInfo,
    tradeInfo,
    scoutFocus,
    needs: teamNeeds,
    standing,
    topPlayers,
  });
  const tradePosture = tradePostureLine({
    standing,
    identity,
    expiring,
    pickInfo,
    needs: teamNeeds,
    tradeInfo,
    teamName,
  });
  const stateLine = seasonStateLine({ seasonContext: ctx.seasonContext, standing, teamName });
  const playoffLine = playoffContextLine(ctx.league, standing, teamId, teamName);
  const pressureLine = rosterPressureLine(teamNeeds, expiring, aging, teamName);
  const coachUserId = resolveCoachUserId(teamName, ctx.guild, options.coachUserId || null);
  const strikeSeason = ensureStrikeSeason(ctx.strikes, `year_${seasonYear}`);
  const strikeTotal = coachUserId ? weightedCount(strikeSeason, coachUserId) : 0;
  const strikeBreakdown = coachUserId ? formatBreakdown(strikeSeason, coachUserId) : 'Clean';
  const strikeCommunication = coachUserId ? communicationSummary(strikeSeason, coachUserId) : { responded: 0, silent: 0, consecutiveSilent: 0, onTime: 0 };
  const playRate = coachUserId ? completionRate(strikeSeason, coachUserId) : null;
  const scouting = coachUserId ? scoutingSummaryForUser(ctx.scoutPoints, coachUserId, classId, seasonYear, weekNumber) : {
    fullCount: 0,
    partialCount: 0,
    currentPoints: null,
    bonus: 0,
  };
  const awardLine = awardRaceSignal(ctx.top100, teamName);
  const buildAround = topPlayers[0]
    ? `${topPlayers[0].name} (${topPlayers[0].position}) is still the cleanest piece to build around.`
    : core[0]
      ? `${core[0].split(' (')[0]} is still one of the clearest core pieces on the roster.`
      : `${teamName} do not have one obvious centerpiece right now.`;
  const contractLine = expiring[0]
    ? `${playerName(expiring[0])} (${expiring[0].position}) is the clearest contract decision on the roster.`
    : aging[0]
      ? `${playerName(aging[0])} (${aging[0].position}) is the clearest age-pressure spot on the roster.`
    : `There is no single contract cliff forcing the next move right now.`;
  const actionPlan = buildActionPlanParagraph(teamName, {
    extend: extensions.map((player) => formatActionPlayer(player, { includeContract: true })),
    young: usageYoung.length
      ? usageYoung.map((player) => `${formatActionPlayer(player, { includeContract: true })} • ${playerDevLabel(player)} • low usage`)
      : young.map((player) => formatActionPlayer(player, { includeContract: true })),
      cut: cuts.map((player) => {
        const savings = Number(player.capReleaseNetSavings || 0);
        const savingsMillions = savings >= 100000 ? savings / 1000000 : savings;
        const rounded = Math.round(savingsMillions * 10) / 10;
        const savingsLabel = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
        return `${formatActionPlayer(player, { includeCap: true })}${savings ? ` • save $${savingsLabel}M` : ''}`;
      }),
    shop: shops.map((player) => formatActionPlayer(player, { includeContract: true, includeCap: true })),
    targets: tradeTargets.map((entry) =>
      `${formatActionPlayer(entry.player, { includeContract: true })} • ${entry.teamName}`),
  }, identity, tradePosture, ctx.seasonContext);
  const frontOfficeParagraph = buildFrontOfficeParagraph(
    teamName,
    identity,
    pressureLine,
    tradePosture,
    actionPlan,
    ctx.seasonContext,
  );
  const developmentLine = usageYoung[0]
    ? developmentPushLine(usageYoung[0])
    : young[0]
      ? developmentPushLine(young[0])
      : null;
  const franchiseRead = buildFranchiseReadParagraph({
    teamName,
    stateLine,
    playoffLine,
    buildAround,
    contractLine,
    developmentLine,
    needs: teamNeeds,
    frontOfficeParagraph,
    awardLine,
    record: formatRecord(standing),
    identity,
    tradePosture,
  });

  return {
    teamId,
    teamName,
    record: formatRecord(standing),
    standing,
    stateLine,
    playoffLine,
    identity,
    tradePosture,
    pressureLine,
    buildAround,
    contractLine,
    core,
    needs: teamNeeds,
    pickInfo,
    tradeInfo,
    actions: {
      extend: extensions.map((player) => formatActionPlayer(player, { includeContract: true })),
      young: usageYoung.length
        ? usageYoung.map((player) => `${formatActionPlayer(player, { includeContract: true })} • ${playerDevLabel(player)} • low usage`)
        : young.map((player) => formatActionPlayer(player, { includeContract: true })),
      cut: cuts.map((player) => {
        const savings = Number(player.capReleaseNetSavings || 0);
        const savingsMillions = savings >= 100000 ? savings / 1000000 : savings;
        const rounded = Math.round(savingsMillions * 10) / 10;
        const savingsLabel = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
        return `${formatActionPlayer(player, { includeCap: true })}${savings ? ` • save $${savingsLabel}M` : ''}`;
      }),
      shop: shops.map((player) => formatActionPlayer(player, { includeContract: true, includeCap: true })),
      targets: tradeTargets.map((entry) =>
        `${formatActionPlayer(entry.player, { includeContract: true })} • ${entry.teamName}`),
    },
    actionPlan,
    frontOfficeParagraph,
    franchiseRead,
    awardLine,
    developmentLine,
    accountability: {
      coachUserId,
      strikeTotal,
      strikeBreakdown,
      playRate,
      silentWeeks: strikeCommunication.silent,
      consecutiveSilentWeeks: strikeCommunication.consecutiveSilent,
      respondedWeeks: strikeCommunication.responded,
      scouting,
    },
    summaryLines: [
      stateLine,
      playoffLine,
      identity.line,
      pressureLine,
      tradePosture.line,
    ].filter(Boolean),
  };
}
