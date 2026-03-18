import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { getPinId } from './pins_store.js'; // unused but kept in case future pinning is desired
import { computeGradeFromRank } from './top_players.js';
import { computeWeeklyList } from './top_players.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const SEASON_STATE_FILE = path.join(process.cwd(), 'data', 'madden', 'season_state.json');

// Cache of yearsPro by rosterId to correctly determine rookie status even when stats omit the field.
const rosterYearsPro = new Map();

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadSnapshot(leagueId) {
  const file = path.join(LEAGUE_DIR, `${leagueId}.json`);
  return loadJson(file, null);
}

function snapshotMtimeMs(leagueId) {
  const file = path.join(LEAGUE_DIR, `${leagueId}.json`);
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function conferenceMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const div = (t.divisionName || t.divName || '').toUpperCase();
    if (div.includes('AFC')) map[t.teamId] = 'AFC';
    else if (div.includes('NFC')) map[t.teamId] = 'NFC';
  });
  return map;
}

function teamNameMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const name = getFullTeamName(t, `Team ${t.teamId}`);
    map[t.teamId] = name || `Team ${t.teamId}`;
  });
  return map;
}

function reverseTeamLookup(teamNameMapObj) {
  const rev = new Map();
  Object.entries(teamNameMapObj || {}).forEach(([id, name]) => {
    rev.set((name || '').toLowerCase(), Number(id));
  });
  return rev;
}

function coachMention(teamName, roleMap) {
  if (!teamName) return null;
  const target = teamName.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(roleMap || {})) {
    if (!key.endsWith(' Coach')) continue;
    const base = key.replace(/ Coach$/, '').toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<@&${val}>`;
    }
  }
  return null;
}

function teamEmoji(teamName, emojiMap) {
  if (!teamName) return '';
  const target = teamName.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(emojiMap || {})) {
    const base = key.toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<:${key.replace(/\s+/g, '')}:${val}>`;
    }
  }
  return '';
}

function loadGradedWeek(leagueId, weekNumber, minMtimeMs = null) {
  const base = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
  const candidates = [
    path.join(base, `week-${weekNumber}-top.json`),
    path.join(base, `week-${weekNumber}-all.json`),
    path.join(base, `week-${weekNumber}.json`)
  ];
  // Also try 0-based alias (weekIndex) since top_players saves using that scheme
  const zeroBased = Number(weekNumber) - 1;
  if (zeroBased >= 0) {
    candidates.push(path.join(base, `week-${zeroBased}-top.json`));
    candidates.push(path.join(base, `week-${zeroBased}-all.json`));
    candidates.push(path.join(base, `week-${zeroBased}.json`));
  }
  for (const file of candidates) {
    try {
      if (minMtimeMs) {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < minMtimeMs - 5000) { // older than snapshot -> likely prior season
          continue;
        }
      }
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data?.top100)) return data.top100;
      if (Array.isArray(data)) return data;
      if (Array.isArray(data?.top100)) return data.top100;
      if (Array.isArray(data?.players)) return data.players;
    } catch (e) {
      // ignore missing
    }
  }
  return null;
}

function isRookie(player) {
  if (!player) return false;
  if (player.isRookie === true) return true;
  // Treat rookie as yearsPro === 0 only; yearsPro 1+ are not rookies
  if (player.yearsPro !== undefined && player.yearsPro !== null) return Number(player.yearsPro) === 0;
  if (player.rosterId != null && rosterYearsPro.has(player.rosterId)) {
    return Number(rosterYearsPro.get(player.rosterId)) === 0;
  }
  return false; // be conservative—if we can't prove rookie, don't mislabel
}

function buildRosterYearsPro(snapshot) {
  rosterYearsPro.clear();
  const addList = (list) => {
    (list || []).forEach(p => {
      if (p?.rosterId == null) return;
      if (p.yearsPro !== undefined && p.yearsPro !== null) {
        rosterYearsPro.set(p.rosterId, Number(p.yearsPro));
      }
    });
  };
  Object.values(snapshot?.rosters?.teams || {}).forEach(team => {
    addList(team?.rosterInfoList || team?.rosterPlayerInfoList);
  });
  addList(snapshot?.rosters?.freeAgents?.rosterInfoList || snapshot?.rosters?.freeAgents);
}

export function gatherWeeklyStats(snapshot, weekIndex) {
  const list = snapshot?.weeklyStats || [];
  const matches = list.filter(w => Number(w.weekIndex) === Number(weekIndex));
  const stageOneCurrent = list.filter(w => Number(w.weekIndex) === Number(weekIndex) && Number(w.stage ?? w.stageIndex ?? 0) === 1);
  const pickHighestStage = (arr) => {
    const copy = [...arr];
    copy.sort((a, b) => (Number(b.stage ?? b.stageIndex ?? 0)) - (Number(a.stage ?? a.stageIndex ?? 0)));
    return copy[0];
  };
  const hasPlayerData = (wk) => {
    const buckets = [
      wk?.passing?.playerPassingStatInfoList,
      wk?.rushing?.playerRushingStatInfoList,
      wk?.receiving?.playerReceivingStatInfoList,
      wk?.defense?.playerDefensiveStatInfoList,
    ];
    return buckets.some(b => Array.isArray(b) && b.length > 0);
  };
  const mergeWeekEntries = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const merged = { ...a, ...b };
    const mergeList = (key) => {
      const listA = (a[key]?.playerPassingStatInfoList) || (a[key]?.playerRushingStatInfoList) || (a[key]?.playerReceivingStatInfoList) || (a[key]?.playerDefensiveStatInfoList) || (a[key]?.playerKickingStatInfoList) || (a[key]?.playerPuntingStatInfoList) || [];
      const listB = (b[key]?.playerPassingStatInfoList) || (b[key]?.playerRushingStatInfoList) || (b[key]?.playerReceivingStatInfoList) || (b[key]?.playerDefensiveStatInfoList) || (b[key]?.playerKickingStatInfoList) || (b[key]?.playerPuntingStatInfoList) || [];
      const combined = [...listA, ...listB];
      if (!combined.length) return b[key] ?? a[key];
      if (b[key]?.playerPassingStatInfoList || a[key]?.playerPassingStatInfoList) return { ...(b[key] || a[key]), playerPassingStatInfoList: combined };
      if (b[key]?.playerRushingStatInfoList || a[key]?.playerRushingStatInfoList) return { ...(b[key] || a[key]), playerRushingStatInfoList: combined };
      if (b[key]?.playerReceivingStatInfoList || a[key]?.playerReceivingStatInfoList) return { ...(b[key] || a[key]), playerReceivingStatInfoList: combined };
      if (b[key]?.playerDefensiveStatInfoList || a[key]?.playerDefensiveStatInfoList) return { ...(b[key] || a[key]), playerDefensiveStatInfoList: combined };
      if (b[key]?.playerKickingStatInfoList || a[key]?.playerKickingStatInfoList) return { ...(b[key] || a[key]), playerKickingStatInfoList: combined };
      if (b[key]?.playerPuntingStatInfoList || a[key]?.playerPuntingStatInfoList) return { ...(b[key] || a[key]), playerPuntingStatInfoList: combined };
      return b[key] ?? a[key];
    };
    merged.passing = mergeList('passing');
    merged.rushing = mergeList('rushing');
    merged.receiving = mergeList('receiving');
    merged.defense = mergeList('defense');
    merged.kicking = mergeList('kicking');
    merged.punting = mergeList('punting');
    merged.teamstats = b.teamstats || a.teamstats;
    merged.stage = b.stage ?? b.stageIndex ?? a.stage ?? a.stageIndex;
    return merged;
  };
  const countPlayers = (wk) => {
    const buckets = [
      wk?.passing?.playerPassingStatInfoList,
      wk?.rushing?.playerRushingStatInfoList,
      wk?.receiving?.playerReceivingStatInfoList,
      wk?.defense?.playerDefensiveStatInfoList,
      wk?.kicking?.playerKickingStatInfoList,
      wk?.punting?.playerPuntingStatInfoList,
    ];
    return buckets.reduce((acc, b) => acc + (Array.isArray(b) ? b.length : 0), 0);
  };

  // Strict: pick Stage 1 for this week; if missing, return null (no cross-stage/other-week merge)
  if (matches.length) {
    const bestStage1 = stageOneCurrent
      .map(w => ({ w, c: countPlayers(w) }))
      .filter(({ w }) => hasPlayerData(w))
      .sort((a, b) => b.c - a.c)[0]?.w;
    if (bestStage1) return bestStage1;
    console.warn('[gatherWeeklyStats] no stage 1 found for week', weekIndex);
  }

  return null;
}

function mergePlayerStats(weekly) {
  const agg = new Map();
  const add = (list, fields) => {
    (list || []).forEach(p => {
      const id = p.rosterId || `${p.fullName}-${p.teamId || ''}`;
      if (!id) return;
      const cur = agg.get(id) || { ...p, totals: {} };
      fields.forEach(f => {
        const val = Number(p[f] ?? 0);
        cur.totals[f] = (cur.totals[f] || 0) + (Number.isFinite(val) ? val : 0);
      });
      agg.set(id, cur);
    });
  };
  add(weekly?.passing?.playerPassingStatInfoList, ['passYds', 'passTDs', 'passInts']);
  add(weekly?.rushing?.playerRushingStatInfoList, ['rushYds', 'rushTDs', 'rushAtt', 'fumbles']);
  add(weekly?.receiving?.playerReceivingStatInfoList, ['recYds', 'recTDs', 'recCatches']);
  add(weekly?.defense?.playerDefensiveStatInfoList, [
    'defTotalTackles', 'defSoloTackles', 'defSacks',
    'defTacklesForLoss', 'defInts', 'defForcedFumbles',
    'defRecoveredFumbles', 'defPassDeflections', 'defTDs'
  ]);
  return agg;
}

function winBonus(player) {
  // If score present, use score to infer win; otherwise no bonus.
  if (player?.teamScore != null && player?.oppScore != null) {
    return player.teamScore > player.oppScore ? 5 : 0;
  }
  return 0;
}

function scoreOffense(p) {
  const pos = (p.position || '').toUpperCase();
  const t = p.totals || {};
  const passScore = (t.passYds || 0) * 0.04 + (t.passTDs || 0) * 6 - (t.passInts || 0) * 4;
  const rushScore = (t.rushYds || 0) * 0.1 + (t.rushTDs || 0) * 6;
  const recScore = (t.recYds || 0) * 0.1 + (t.recTDs || 0) * 6;
  let base = 0;
  if (pos === 'QB') {
    base = passScore + rushScore;
  } else if (['HB', 'FB'].includes(pos)) {
    base = rushScore + recScore;
  } else {
    base = recScore + rushScore;
  }
  if (t.passYds > 350 || t.rushYds > 125 || t.recYds > 125) base += 3;
  return base + winBonus(p);
}

function scoreDefense(p) {
  const t = p.totals || {};
  let score = 0;
  score += (t.defTotalTackles || 0) * 1;
  score += (t.defSacks || 0) * 4;
  score += (t.defTacklesForLoss || 0) * 2;
  score += (t.defInts || 0) * 6;
  score += (t.defForcedFumbles || 0) * 4;
  score += (t.defRecoveredFumbles || 0) * 2;
  score += (t.defPassDeflections || 0) * 1;
  score += (t.defTDs || 0) * 6;
  score += winBonus(p);
  return score;
}

function formatLine(p) {
  const t = p.totals || {};
  const parts = [];
  if (t.passYds || t.passTDs || t.passInts !== undefined) {
    parts.push(`Pass: ${Math.round(t.passYds || 0)}y / TD ${t.passTDs || 0} / INT ${t.passInts || 0}`);
  }
  if (t.rushYds || t.rushTDs) parts.push(`Rush: ${Math.round(t.rushYds || 0)}y / TD ${t.rushTDs || 0}`);
  if (t.recYds || t.recTDs || t.recCatches) parts.push(`Rec: ${Math.round(t.recYds || 0)}y / TD ${t.recTDs || 0} / REC ${t.recCatches || 0}`);
  if (t.defTotalTackles || t.defSacks || t.defInts || t.defPassDeflections) {
    parts.push(`Def: TAK ${t.defTotalTackles || 0} / SACK ${t.defSacks || 0} / INT ${t.defInts || 0} / PD ${t.defPassDeflections || 0}`);
  }
  return parts.join('\n') || 'No stats';
}

function hasEligibleOffenseStats(p) {
  const t = p?.totals || {};
  return (
    Number(t.passYds || 0) > 0 ||
    Number(t.passTDs || 0) > 0 ||
    Number(t.rushYds || 0) > 0 ||
    Number(t.rushTDs || 0) > 0 ||
    Number(t.recYds || 0) > 0 ||
    Number(t.recTDs || 0) > 0 ||
    Number(t.recCatches || 0) > 0
  );
}

function hasEligibleDefenseStats(p) {
  const t = p?.totals || {};
  return (
    Number(t.defTotalTackles || 0) > 1 ||
    Number(t.defSacks || 0) > 0 ||
    Number(t.defTacklesForLoss || 0) > 0 ||
    Number(t.defInts || 0) > 0 ||
    Number(t.defForcedFumbles || 0) > 0 ||
    Number(t.defRecoveredFumbles || 0) > 0 ||
    Number(t.defPassDeflections || 0) > 0 ||
    Number(t.defTDs || 0) > 0
  );
}

function hasEligibleStatsForPlayer(p, posSet = null) {
  const pos = (p?.position || p?.displayPos || '').toUpperCase();
  if (posSet) {
    if (posSet.has(pos)) {
      const offensePositions = new Set(['QB', 'HB', 'RB', 'FB', 'TB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P']);
      return offensePositions.has(pos) ? hasEligibleOffenseStats(p) : hasEligibleDefenseStats(p);
    }
    return false;
  }
  return hasEligibleDefenseStats(p) || hasEligibleOffenseStats(p);
}

function hasAwardCaliberStats(p, posSet = null) {
  const pos = (p?.position || p?.displayPos || '').toUpperCase();
  const t = p?.totals || {};
  const passYds = Number(t.passYds || 0);
  const passTDs = Number(t.passTDs || 0);
  const passInts = Number(t.passInts || 0);
  const rushYds = Number(t.rushYds || 0);
  const rushTDs = Number(t.rushTDs || 0);
  const recYds = Number(t.recYds || 0);
  const recTDs = Number(t.recTDs || 0);
  const catches = Number(t.recCatches || 0);
  const tackles = Number(t.defTotalTackles || 0);
  const sacks = Number(t.defSacks || 0);
  const ints = Number(t.defInts || 0);
  const pds = Number(t.defPassDeflections || 0);
  const ff = Number(t.defForcedFumbles || 0);
  const fr = Number(t.defRecoveredFumbles || 0);
  const defTDs = Number(t.defTDs || 0);
  const totalSkillYds = rushYds + recYds;
  const totalSkillTDs = rushTDs + recTDs;
  const impactPlays = sacks + ints + ff + fr + defTDs;

  if (posSet) {
    const offensePositions = new Set(['QB', 'HB', 'RB', 'FB', 'TB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P']);
    if (offensePositions.has(pos)) {
      if (pos === 'QB') {
        return (
          passTDs >= 3 ||
          passYds >= 275 ||
          (passYds >= 225 && passTDs >= 2) ||
          ((passYds + rushYds) >= 275 && (passTDs + rushTDs) >= 2) ||
          (rushYds >= 75 && (passTDs + rushTDs) >= 2)
        ) && !(passTDs <= 1 && passInts >= 3);
      }
      if (['HB', 'RB', 'FB', 'TB'].includes(pos)) {
        return (
          totalSkillTDs >= 2 ||
          totalSkillYds >= 120 ||
          rushYds >= 95 ||
          (rushYds >= 75 && catches >= 4) ||
          (recYds >= 75 && recTDs >= 1)
        );
      }
      return (
        recTDs >= 2 ||
        recYds >= 100 ||
        (recYds >= 80 && catches >= 6) ||
        (totalSkillYds >= 120 && totalSkillTDs >= 1)
      );
    }
    return (
      ints >= 2 ||
      sacks >= 2 ||
      defTDs >= 1 ||
      (impactPlays >= 2 && tackles >= 4) ||
      (tackles >= 8 && (ints >= 1 || sacks >= 1 || pds >= 2)) ||
      (ints >= 1 && pds >= 2) ||
      (sacks >= 1 && tackles >= 6 && ff >= 1)
    );
  }

  return hasEligibleStatsForPlayer(p, posSet);
}

function pickWinner(players, conf) {
  let list = Array.from(players.values()).filter(p => p.conference === conf && hasEligibleOffenseStats(p));
  if (!list.length) {
    // fallback if conference mapping missing
    list = Array.from(players.values()).filter(hasEligibleOffenseStats);
  }
  if (!list.length) return null;
  list.forEach(p => { p.score = scoreOffense(p); });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.passTDs || b.totals?.rushTDs || b.totals?.recTDs || 0) - (a.totals?.passTDs || a.totals?.rushTDs || a.totals?.recTDs || 0))
    || ((b.totals?.passYds || b.totals?.rushYds || b.totals?.recYds || 0) - (a.totals?.passYds || a.totals?.rushYds || a.totals?.recYds || 0))
    || ((a.totals?.passInts || 0) - (b.totals?.passInts || 0)));
  return list[0];
}

function pickDefWinner(players, conf) {
  let list = Array.from(players.values()).filter(p => p.conference === conf && hasEligibleDefenseStats(p));
  if (!list.length) {
    list = Array.from(players.values()).filter(hasEligibleDefenseStats);
  }
  if (!list.length) return null;
  list.forEach(p => { p.score = scoreDefense(p); });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.defTDs || 0) - (a.totals?.defTDs || 0))
    || ((b.totals?.defInts || 0) - (a.totals?.defInts || 0))
    || ((b.totals?.defSacks || 0) - (a.totals?.defSacks || 0))
    || ((b.totals?.defTotalTackles || 0) - (a.totals?.defTotalTackles || 0)));
  return list[0];
}

function pickRookie(allPlayers, seasonYear) {
  const list = Array.from(allPlayers.values()).filter(p =>
    isRookie(p, seasonYear) && hasEligibleStatsForPlayer(p)
  );
  if (!list.length) return null;
  list.forEach(p => {
    const pos = (p.position || '').toUpperCase();
    if (['CB', 'FS', 'SS', 'LB', 'ROLB', 'LOLB', 'MLB', 'RE', 'LE', 'DT'].includes(pos)) {
      p.score = scoreDefense(p);
    } else {
      p.score = scoreOffense(p);
    }
  });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.defTDs || b.totals?.passTDs || b.totals?.rushTDs || b.totals?.recTDs || 0) - (a.totals?.defTDs || a.totals?.passTDs || a.totals?.rushTDs || a.totals?.recTDs || 0))
    || ((b.totals?.passYds || b.totals?.rushYds || b.totals?.recYds || 0) - (a.totals?.passYds || a.totals?.rushYds || a.totals?.recYds || 0)));
  return list[0];
}

function pickFromTopList(topList, conf, predicate) {
  if (!Array.isArray(topList)) return null;
  const filtered = topList.filter(p => (!conf || p.conference === conf) && (!predicate || predicate(p)));
  if (!filtered.length) return null;
  return filtered.sort((a, b) => (Number(b.grade || 0) - Number(a.grade || 0)) || 0)[0];
}

function normalizeGameScores(weekly) {
  // If weekly passing stats have teamScore/oppScore per player, great; otherwise ignore.
  // No-op placeholder: many datasets won't have this per-player; scoring still works.
}

export async function updateAwards(client, leagueId, weekOverride = null, options = {}) {
  const interaction = options.interaction || null;
  const isPublic = options.isPublic || false;
  const snapshot = loadSnapshot(leagueId);
  if (!snapshot && weekOverride == null) {
    console.warn('[awards] Snapshot missing; run weekly update first or supply weekOverride.');
    return;
  }
  const snapshotMtime = snapshotMtimeMs(leagueId);
  buildRosterYearsPro(snapshot);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const emojiMap = loadJson(TEAM_EMOJIS_FILE);
  const awardsChannelId = channelMap['Awards'];
  const targetChannel = interaction?.channel ?? (awardsChannelId ? await client.channels.fetch(awardsChannelId).catch(() => null) : null);
  if (!interaction && !targetChannel?.isTextBased()) {
    console.warn('[awards] Awards channel not text-based or missing.');
    return;
  }

  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const currentWeek = Number(weekOverride ?? snapshot?.currentWeek ?? 0);
  const seasonWeekType = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeekType;
  const offSeasonStage = snapshot?.info?.careerHubInfo?.seasonInfo?.offSeasonStage || 0;
  const replySkip = async (msg) => {
    if (options?.interaction) {
      const payload = { content: msg, flags: 64 };
      if (options.interaction.deferred || options.interaction.replied) {
        await options.interaction.editReply(payload).catch(() => null);
      } else {
        await options.interaction.reply(payload).catch(() => null);
      }
    }
    console.warn(msg);
  };

  // Do not post awards when export still says preseason (seasonWeekType != 1) unless explicitly backfilled.
  // offSeasonStage can linger; don't block on that alone.
  if (!weekOverride && seasonWeekType !== 1) {
    await replySkip('[awards] skipping: snapshot indicates preseason/offseason for this export');
    return;
  }
  // Pick the latest Stage 1 week with player data (regular season) to avoid stale/offseason pulls
  const latestStage1Week = (() => {
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
  })();

  const targetWeekIdx = weekOverride ? Number(weekOverride) - 1 : latestStage1Week;
  const awardsWeek = targetWeekIdx != null ? targetWeekIdx + 1 : null;
  if (awardsWeek === null || awardsWeek < 1) {
    await replySkip('[awards] skipping: no completed Stage 1 week with stats found');
    return;
  }
  // New season start: clear last season's cached awards and graded history to avoid bleed
  if (!weekOverride && awardsWeek === 1) {
    try {
      const histDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
      fs.rmSync(histDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('[awards] Week 1 history clear skipped:', e?.message || e);
    }
  }
  const isPlayoffs = awardsWeek >= 19; // assume weeks 19+ are playoffs

  // Load existing winners if present (allow re-post)
  const awardsStore = loadJson(AWARDS_FILE, {});
  const leagueStore = awardsStore[leagueId] || {};
  // Season rollover guard: clear stale history/awards when the calendar year bumps
  try {
    const seasonState = loadJson(SEASON_STATE_FILE, {});
    const prevYear = seasonState[leagueId]?.calendarYear;
    const forceStartOfSeason = currentWeek === 1 && awardsWeek === 1 && (snapshot?.info?.careerHubInfo?.seasonInfo?.offSeasonStage || 0) > 0;
    if (seasonYear && prevYear && seasonYear !== prevYear) {
      const histDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
      fs.rmSync(histDir, { recursive: true, force: true });
      delete awardsStore[leagueId];
    } else if (!prevYear && forceStartOfSeason) {
      const histDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId));
      fs.rmSync(histDir, { recursive: true, force: true });
      delete awardsStore[leagueId];
    }
    seasonState[leagueId] = { calendarYear: seasonYear };
    saveJson(SEASON_STATE_FILE, seasonState);
  } catch (e) {
    console.warn('[awards] season rollover guard skipped:', e?.message || e);
  }
  // Always recompute winners to reflect latest grading/formula
  let winners = null;
  {
    let weekly = gatherWeeklyStats(snapshot, targetWeekIdx);
    if (!weekly) {
      console.warn('[awards] No weekly stats found for week', currentWeek, '; continuing with graded list only if available.');
      weekly = null;
    }

    const byPlayer = weekly ? (normalizeGameScores(weekly), mergePlayerStats(weekly)) : new Map();
    let confMap = snapshot ? conferenceMap(snapshot) : {};
    let teamNames = snapshot ? teamNameMap(snapshot) : {};

    // Build roster lookup to enrich player metadata (yearsPro, name) for rookie detection
    const rosterLookup = new Map();
    const addRosterList = (list) => {
      (list || []).forEach(p => {
        if (p?.rosterId === undefined || p?.rosterId === null) return;
        rosterLookup.set(p.rosterId, p);
      });
    };
    Object.values(snapshot?.rosters?.teams || {}).forEach(r => addRosterList(r?.rosterInfoList || r?.rosterPlayerInfoList || []));
    addRosterList(snapshot?.rosters?.freeAgents?.rosterInfoList || snapshot?.rosters?.freeAgents || []);

    // attach team/conference/name metadata
    byPlayer.forEach(p => {
      p.teamName = teamNames[p.teamId] || 'Unknown';
      p.conference = confMap[p.teamId] || null;
      const rosterMatch = p.rosterId != null ? rosterLookup.get(p.rosterId) : null;
      p.fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || (rosterMatch ? `${rosterMatch.firstName || ''} ${rosterMatch.lastName || ''}`.trim() : '');
      if (!p.position && rosterMatch?.position) {
        p.position = rosterMatch.position;
      }
      if (p.yearsPro === undefined || p.yearsPro === null) {
        p.yearsPro = rosterMatch?.yearsPro;
      }
      if (p.draftYear === undefined || p.draftYear === null) {
        p.draftYear = rosterMatch?.draftYear;
      }
      if (p.isRookie === undefined || p.isRookie === null) {
        p.isRookie = rosterMatch?.isRookie;
      }
    });

    const gradedList = loadGradedWeek(leagueId, targetWeekIdx, snapshotMtime);
    const offensePositions = new Set(['QB', 'HB', 'RB', 'FB', 'TB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P']);
    const defPositions = new Set(['CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB', 'RE', 'LE', 'DT', 'EDGE', 'EDG', 'LEDGE', 'REDGE', 'LEDG', 'REDG', 'OLB', 'LDE', 'RDE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'DE']);
    const normalizedGraded = (gradedList || []).map(p => {
      const pos = (p.position || p.displayPos || '').toUpperCase();
      const rosterMatch = p.rosterId != null ? rosterLookup.get(p.rosterId) : rosterLookup.get(p.id);
      let conference = (p.conference || '').toUpperCase();
      if ((!conference || conference === 'UNKNOWN') && p.teamId) {
        conference = (confMap[p.teamId] || '').toUpperCase() || null;
      }
      const teamName = p.team || p.teamName || teamNames[p.teamId] || p.team || 'Unknown';
      const rookieFlag =
        p.isRookie
        ?? rosterMatch?.isRookie
        ?? isRookie({ rosterId: p.rosterId, yearsPro: p.yearsPro });
      const fullName = p.fullName || p.name || (rosterMatch ? `${rosterMatch.firstName || ''} ${rosterMatch.lastName || ''}`.trim() : 'Unknown');
      return { ...p, position: pos, conference, teamName, isRookie: rookieFlag, fullName };
    });
    const pickTop = (arr) => arr.sort((a, b) => (b.grade || 0) - (a.grade || 0))[0];
    if (!weekly && (!normalizedGraded.length)) {
      await replySkip('[awards] skipping: no current-week player data or graded list');
      return;
    }
    const gradedAwardsAvailable = normalizedGraded.length > 0;
    if (normalizedGraded.length) {
      const byConf = (conf, filterFn) => normalizedGraded.filter(p => p.conference === conf && filterFn(p));
      const isOff = (p) => offensePositions.has((p.position || '').toUpperCase());
      const isDef = (p) => defPositions.has((p.position || '').toUpperCase());
      winners = {
        afc_offense: pickTop(byConf('AFC', isOff)),
        nfc_offense: pickTop(byConf('NFC', isOff)),
        afc_defense: pickTop(byConf('AFC', isDef)),
        nfc_defense: pickTop(byConf('NFC', isDef)),
        // rookies: top offense and top defense across all conferences
        rookie_offense: isPlayoffs ? null : pickTop(normalizedGraded.filter(p => p.isRookie && isOff(p))),
        rookie_defense: isPlayoffs ? null : pickTop(normalizedGraded.filter(p => p.isRookie && isDef(p))),
      };
    }
    if (!gradedAwardsAvailable && (!winners || (!winners.afc_offense && !winners.nfc_offense && !winners.afc_defense && !winners.nfc_defense))) {
      winners = {
        afc_offense: pickWinner(byPlayer, 'AFC'),
        nfc_offense: pickWinner(byPlayer, 'NFC'),
        afc_defense: pickDefWinner(byPlayer, 'AFC'),
        nfc_defense: pickDefWinner(byPlayer, 'NFC'),
        rookie_offense: isPlayoffs ? null : pickWinner(new Map(Array.from(byPlayer).filter(([, p]) => isRookie(p))), null),
        rookie_defense: isPlayoffs ? null : pickDefWinner(new Map(Array.from(byPlayer).filter(([, p]) => isRookie(p))), null),
      };
      // Fallbacks if any category didn't resolve
      const all = Array.from(byPlayer.values());
      const fallbackOff = (arr) => arr.sort((a, b) => (b.totals?.passYds || b.totals?.rushYds || b.totals?.recYds || 0) - (a.totals?.passYds || a.totals?.rushYds || a.totals?.recYds || 0))[0];
      const fallbackDef = (arr) => arr.sort((a, b) => (b.totals?.defTotalTackles || 0) - (a.totals?.defTotalTackles || 0))[0];
      if (!winners.afc_offense) winners.afc_offense = fallbackOff(all);
      if (!winners.nfc_offense) winners.nfc_offense = fallbackOff(all);
      if (!winners.afc_defense) winners.afc_defense = fallbackDef(all);
      if (!winners.nfc_defense) winners.nfc_defense = fallbackDef(all);
      if (!winners.rookie_offense && !isPlayoffs) winners.rookie_offense = fallbackOff(all.filter(p => isRookie(p)));
      if (!winners.rookie_defense && !isPlayoffs) winners.rookie_defense = fallbackDef(all.filter(p => isRookie(p)));

      // If rookie still missing, broaden to all weeks in the snapshot and pick best rookie by totals
      if ((!winners.rookie_offense || !winners.rookie_defense) && !isPlayoffs) {
        const agg = new Map();
        const addPlayerTotals = (wk) => {
          const mp = mergePlayerStats(wk);
          mp.forEach((val, key) => {
            const existing = agg.get(key) || { ...val, totals: {} };
            Object.entries(val.totals || {}).forEach(([k, v]) => {
              existing.totals[k] = (existing.totals[k] || 0) + (Number(v) || 0);
            });
            agg.set(key, existing);
          });
        };
        (snapshot?.weeklyStats || []).forEach(addPlayerTotals);
        agg.forEach(p => {
          p.teamName = teamNames[p.teamId] || 'Unknown';
          p.conference = confMap[p.teamId] || null;
          p.fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
        });
        const rookiesAllWeeks = new Map(Array.from(agg.entries()).filter(([, p]) => isRookie(p)));
        if (!winners.rookie_offense) winners.rookie_offense = pickWinner(rookiesAllWeeks, null);
        if (!winners.rookie_defense) winners.rookie_defense = pickDefWinner(rookiesAllWeeks, null);
      }
    }
  }

  // Build grade map from all scored players (offense/defense)
  // Also pull weekly top list grades for tighter alignment with top100 output
  const weeklyTopList = (() => {
    try {
      const list = computeWeeklyList(snapshot, targetWeekIdx);
      return Array.isArray(list) ? list : (list?.top100 || []);
    } catch {
      return [];
    }
  })();
  const weeklyGradeMap = new Map(
    weeklyTopList.map(p => [
      p.rosterId ?? `${p.name || p.fullName || ''}-${p.teamId || ''}`,
      p.grade != null ? Number(p.grade) : undefined
    ])
  );
  const teamNamesReverse = reverseTeamLookup(teamNameMap(snapshot));
  const conferenceById = conferenceMap(snapshot);
  const conferenceByName = new Map(
    Object.entries(teamNameMap(snapshot)).map(([id, name]) => [name.toLowerCase(), conferenceById[id]])
  );
  const offensePositionsSet = new Set(['QB', 'HB', 'RB', 'FB', 'TB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P']);
  // Include edge aliases so REDGE/LEDGE players (e.g., Myles Garrett) are eligible for defensive awards
  const defensePositionsSet = new Set([
    'CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB',
    'RE', 'LE', 'RDE', 'LDE', 'EDGE', 'DE', 'DT', 'OLB',
    'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'EDG', 'REDG', 'LEDG',
    'WILL', 'MIKE', 'SAM'
  ]);

  const pickTopFromGrades = (conf, posSet, rookieOnly) => {
    const filtered = weeklyTopList.filter(p => {
      const pos = (p.position || p.displayPos || '').toUpperCase();
      if (posSet && !posSet.has(pos)) return false;
      const teamNameLower = (p.team || p.teamName || '').toLowerCase();
      const teamId = p.teamId ?? teamNamesReverse.get(teamNameLower);
      const confVal = teamId ? conferenceById[teamId] : (conferenceByName.get(teamNameLower) || conferenceById[p.teamId] || null);
      if (conf && confVal !== conf) return false;
      const isRk = p.isRookie === true;
      if (rookieOnly && !isRk) return false;
      if (!hasEligibleStatsForPlayer(p, posSet)) return false;
      if (!hasAwardCaliberStats(p, posSet)) return false;
      return true;
    });
    if (!filtered.length) return null;
    // Special-case: prefer true front-seven edge players over inside LBs when grades tie/close
    const sorted = filtered.slice().sort((a, b) => {
      const g = Number(b.grade || 0) - Number(a.grade || 0);
      if (Math.abs(g) > 0.01) return g;
      // tie-breaker: prioritize EDGE/DE over MIKE/SAM/WILL
      const priority = (pos) => ['EDGE', 'LEDGE', 'REDGE', 'DE', 'RE', 'LE'].includes(pos) ? 2 : (['DT'].includes(pos) ? 1 : 0);
      const pa = priority((a.position || a.displayPos || '').toUpperCase());
      const pb = priority((b.position || b.displayPos || '').toUpperCase());
      return pb - pa;
    });
    const best = sorted[0];
    // normalize fields to match winner shape
    const teamId = best.teamId ?? teamNamesReverse.get((best.team || best.teamName || '').toLowerCase());
    return {
      ...best,
      teamId,
      teamName: best.team || best.teamName || teamNamesReverse.get((best.team || best.teamName || '').toLowerCase()) || best.team || best.teamName || 'Unknown',
      fullName: best.name || best.fullName,
      position: (best.position || best.displayPos || '').toUpperCase(),
    };
  };
  const gradeMap = (() => {
    const list = [];
    const idFor = (p) => p?.rosterId ?? `${p?.fullName || ''}-${p?.teamId || p?.teamName || ''}`;
    const weeklyStats = gatherWeeklyStats(snapshot, targetWeekIdx);
    const merged = mergePlayerStats(weeklyStats || {});
    merged.forEach(p => {
      const pos = (p.position || '').toUpperCase();
      const isDefense = ['CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB', 'RE', 'LE', 'DT', 'EDGE', 'DE', 'OLB'].includes(pos);
      const score = isDefense ? scoreDefense(p) : scoreOffense(p);
      list.push({ id: idFor(p), score });
    });
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const total = list.length || 1;
    const map = new Map();
    list.forEach((p, idx) => {
      map.set(p.id, computeGradeFromRank(idx + 1, total));
    });
    return { map, idFor };
  })();

  // `gradedAwardsAvailable` is referenced below as the signal that week-grade derived winners are present.
  // It must be defined in this broader scope (not only inside the earlier normalization block).
  const gradedAwardsAvailable = !!(winners && (winners.afc_offense || winners.nfc_offense || winners.afc_defense || winners.nfc_defense));

  // Use the graded weekly list only as a fallback when raw weekly stats failed to produce a winner.
  if (!gradedAwardsAvailable && weeklyTopList.length) {
    if (!winners.afc_offense) winners.afc_offense = pickTopFromGrades('AFC', offensePositionsSet, false) || winners.afc_offense;
    if (!winners.nfc_offense) winners.nfc_offense = pickTopFromGrades('NFC', offensePositionsSet, false) || winners.nfc_offense;
    if (!winners.afc_defense) winners.afc_defense = pickTopFromGrades('AFC', defensePositionsSet, false) || winners.afc_defense;
    if (!winners.nfc_defense) winners.nfc_defense = pickTopFromGrades('NFC', defensePositionsSet, false) || winners.nfc_defense;
    if (!isPlayoffs) {
      if (!winners.rookie_offense) winners.rookie_offense = pickTopFromGrades(null, offensePositionsSet, true) || winners.rookie_offense;
      if (!winners.rookie_defense) winners.rookie_defense = pickTopFromGrades(null, defensePositionsSet, true) || winners.rookie_defense;
    }
  }

  const allMissing =
    !winners.afc_offense &&
    !winners.nfc_offense &&
    !winners.afc_defense &&
    !winners.nfc_defense &&
    ((isPlayoffs) || (!winners.rookie_offense && !winners.rookie_defense));
  if (allMissing) {
    console.warn('[awards] Computed awards are empty for week', currentWeek, '; will retry on next update.');
    return;
  }

  const makeField = (label, p) => {
    if (!p) return { name: label, value: 'N/A', inline: false };
    const mention = coachMention(p.teamName, roleMap);
    const emoji = teamEmoji(p.teamName, emojiMap);
    const id = gradeMap.idFor(p);
    const gradeFromList = weeklyGradeMap.get(p.rosterId ?? `${p.fullName || ''}-${p.teamId || ''}`) ?? p.grade;
    const grade = gradeFromList != null ? Number(gradeFromList) : gradeMap.map.get(id);
    const gradeText = grade ? ` (Grade ${grade.toFixed(1)})` : '';
    const header = `${emoji ? emoji + ' ' : ''}${p.position || ''} ${p.fullName || p.name || 'Unknown'} — ${p.teamName}${gradeText}`;
    const line = (p.statLine && p.statLine.trim().length) ? p.statLine : formatLine(p);
    return {
      name: label,
      value: `${header}${mention ? ` (${mention})` : ''}\n${line}`,
      inline: false,
    };
  };

  const coachTag = roleMap['Ghost Legacy'] ? `<@&${roleMap['Ghost Legacy']}>` : null;
  const embed = new EmbedBuilder()
    .setTitle(`Weekly Awards — Week ${awardsWeek}${isPlayoffs ? ' (Playoffs)' : ''}`)
    .setDescription(null)
    .setColor(0xf1c40f)
    .addFields(
      makeField('AFC Offensive Player of the Week', winners.afc_offense),
      makeField('NFC Offensive Player of the Week', winners.nfc_offense),
      makeField('AFC Defensive Player of the Week', winners.afc_defense),
      makeField('NFC Defensive Player of the Week', winners.nfc_defense),
      ...(isPlayoffs ? [] : [
        makeField('Offensive Rookie of the Week', winners.rookie_offense),
        makeField('Defensive Rookie of the Week', winners.rookie_defense),
      ]),
    )
    .setTimestamp(new Date());

  if (interaction) {
    const content = isPublic ? coachTag : null;
    const payload = { content, embeds: [embed], allowedMentions: isPublic && coachTag ? { parse: [], roles: [roleMap['Ghost Legacy']] } : { parse: [] } };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, flags: isPublic ? undefined : 64 });
    }
  } else if (targetChannel?.isTextBased()) {
    await targetChannel.send({
      content: coachTag || null,
      embeds: [embed],
      allowedMentions: coachTag ? { parse: [], roles: [roleMap['Ghost Legacy']] } : { parse: [] },
    }).catch(() => null);
  }
  awardsStore[leagueId] = { ...leagueStore, [awardsWeek]: winners };
  saveJson(AWARDS_FILE, awardsStore);
}

export default { updateAwards };
