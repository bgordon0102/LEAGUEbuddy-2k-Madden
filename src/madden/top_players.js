import path from 'path';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadJson, saveJson } from '../utils/json.js';
import { gatherWeeklyStats } from './awards.js';

const TOP_FILE = path.join(process.cwd(), 'data', 'madden', 'top_players.json');
const DEFAULT_POST_CHANNEL = '1462629502864851069';

function buildRosterLookup(snapshot) {
  const map = new Map();
  const teams = snapshot?.rosters?.teams || {};
  Object.values(teams).forEach(team => {
    (team?.rosterInfoList || []).forEach(pl => {
      const key = pl.rosterId || pl.playerId || pl.esnId;
      if (!key) return;
      const full = `${pl.firstName || ''} ${pl.lastName || ''}`.trim();
      map.set(key, {
        fullName: full || pl.displayName || pl.name || undefined,
        position: (pl.position || '').toUpperCase(),
      });
    });
  });
  return map;
}



function mergePlayerStats(weekly) {
  const agg = new Map();
  const add = (list, fields) => {
    (list || []).forEach(p => {
      const id = p.rosterId || `${p.fullName}-${p.teamId || ''}`;
      if (!id) return;
      const cur = agg.get(id) || { ...p, totals: {} };
      fields.forEach(f => {
        const valRaw = p[f];
        const val = Number(valRaw !== undefined && valRaw !== null ? valRaw : 0);
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

function aggregateTeamOffense(weekly) {
  const teams = new Map();
  const ensure = (teamId) => {
    if (!teams.has(teamId)) {
      teams.set(teamId, {
        passAtt: 0, passYds: 0, passTD: 0, passINT: 0, passSacksAllowed: 0, passLong: 0,
        rushAtt: 0, rushYds: 0, rushTD: 0, rushLong: 0, rushBrokenTackles: 0,
      });
    }
    return teams.get(teamId);
  };
  (weekly?.passing?.playerPassingStatInfoList || []).forEach(p => {
    const t = ensure(p.teamId);
    t.passAtt += Number(p.passAtt || 0);
    t.passYds += Number(p.passYds || 0);
    t.passTD += Number(p.passTDs || 0);
    t.passINT += Number(p.passInts || 0);
    t.passSacksAllowed += Number(p.passSacks || 0); // sacks taken by QB
    t.passLong = Math.max(t.passLong, Number(p.passLongest || 0));
  });
  (weekly?.rushing?.playerRushingStatInfoList || []).forEach(p => {
    const t = ensure(p.teamId);
    t.rushAtt += Number(p.rushAtt || 0);
    t.rushYds += Number(p.rushYds || 0);
    t.rushTD += Number(p.rushTDs || 0);
    t.rushLong = Math.max(t.rushLong, Number(p.rushLongest || 0));
    t.rushBrokenTackles += Number(p.rushBrokenTackles || 0);
  });
  return teams;
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
    const name = [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
    map[t.teamId] = name || `Team ${t.teamId}`;
  });
  return map;
}

function teamDefenseAllowMap(weekly) {
  const map = new Map();
  const list = weekly?.teamstats?.teamStatInfoList || [];
  list.forEach(t => {
    const teamId = Number(t.teamId);
    if (!teamId) return;
    map.set(teamId, {
      defYds: Number(t.defTotalYds || t.defTotalYdsAllowed || t.defTotYds || 0),
      defPts: Number(t.defPtsPerGame || t.defPts || 0),
    });
  });
  return map;
}

function winPctMap(snapshot) {
  const map = {};
  const standings = snapshot?.standings?.teamStandingInfoList || snapshot?.standings?.teamStandingInfo || [];
  const arr = Array.isArray(standings) ? standings : Object.values(standings);
  arr.forEach(t => {
    const wins = Number(t.wins !== undefined ? t.wins : (t.w !== undefined ? t.w : 0));
    const losses = Number(t.losses !== undefined ? t.losses : (t.l !== undefined ? t.l : 0));
    const ties = Number(t.ties !== undefined ? t.ties : (t.t !== undefined ? t.t : 0));
    const games = wins + losses + ties;
    const pct = games > 0 ? (wins + 0.5 * ties) / games : 0.5;
    map[t.teamId] = pct;
  });
  return map;
}

function winBonus(player) {
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
  score *= 1.6; // Stronger defensive multiplier for top 100 banding
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

function computeOlTeamScore(teamStats, winPct = 0.5) {
  const passAtt = Math.max(1, teamStats.passAtt || 0);
  const rushAtt = Math.max(1, teamStats.rushAtt || 0);
  const plays = Math.max(1, (teamStats.passAtt || 0) + (teamStats.rushAtt || 0));
  const ypa = Math.min(12, (teamStats.passYds || 0) / passAtt);
  const ypc = Math.min(7, (teamStats.rushYds || 0) / rushAtt);
  const passTDr = (teamStats.passTD || 0) / passAtt;
  const intRate = (teamStats.passINT || 0) / passAtt;
  const sackRate = (teamStats.passSacksAllowed || 0) / passAtt;
  const rushTDr = (teamStats.rushTD || 0) / rushAtt;
  const brokenRate = (teamStats.rushBrokenTackles || 0) / rushAtt;
  const expPass = Math.min(1, (teamStats.passLong || 0) / 50);
  const expRun = Math.min(1, (teamStats.rushLong || 0) / 40);
  const volume = Math.min(1, Math.log(plays) / Math.log(70));
  let score = 50;
  score += ypa * 2.5;
  score += passTDr * 400;
  score -= intRate * 200;
  score -= sackRate * 800;
  score += expPass * 6;
  score += ypc * 2.0;
  score += rushTDr * 300;
  score -= brokenRate * 500; // broken tackles against run blocking
  score += expRun * 6;
  score += volume * 5;
  score *= (1 + 0.05 * winPct);
  score *= 0.6; // heavily downweight to align with skill-position award scale
  return Math.max(40, Math.min(82, score));
}

function applyBanding(list, bandDefs) {
  const total = list.length;
  if (!total) return [];
  let counts = bandDefs.map(b => b.minCount);
  let minSum = counts.reduce((a, b) => a + b, 0);
  if (minSum > total) {
    // Trim from the bottom bands until we fit
    for (let i = bandDefs.length - 1; i >= 0 && minSum > total; i--) {
      const reduceBy = Math.min(counts[i], minSum - total);
      counts[i] -= reduceBy;
      minSum -= reduceBy;
    }
  }
  let remaining = Math.max(0, total - counts.reduce((a, b) => a + b, 0));
  for (let i = 0; i < bandDefs.length && remaining > 0; i++) {
    const band = bandDefs[i];
    const canAdd = Math.min(remaining, (band.maxCount || total) - counts[i]);
    if (canAdd > 0) {
      counts[i] += canAdd;
      remaining -= canAdd;
    }
  }
  const graded = [];
  const ordered = [...list].sort((a, b) => {
    const ga = a.grade ?? 0;
    const gb = b.grade ?? 0;
    if (gb !== ga) return gb - ga;
    return (b.score || 0) - (a.score || 0);
  });
  let cursor = 0;
  bandDefs.forEach((band, idx) => {
    const take = Math.max(0, Math.min(counts[idx], ordered.length - cursor));
    for (let i = 0; i < take && cursor < ordered.length; i++, cursor++) {
      const p = ordered[cursor];
      const span = Math.max(0, band.max - band.min);
      const frac = take > 1 ? i / (take - 1) : 0.5; // distribute across band
      const val = band.max - frac * span; // high -> low inside band
      const clamped = Math.min(99.9, Math.max(40, val));
      graded.push({ ...p, grade: Number(clamped.toFixed(2)) });
    }
  });
  for (; cursor < ordered.length; cursor++) {
    const p = ordered[cursor];
    graded.push({ ...p, grade: 40.0 });
  }
  graded.sort((a, b) => (b.score || 0) - (a.score || 0));
  return graded;
}

function computeWeeklyList(snapshot, weekIndex) {
  // Band definitions for grading (global OVR scale)
  const bandDefs = [
    { min: 97.0, max: 99.9, minCount: 1, maxCount: 1 },
    { min: 95.0, max: 96.9, minCount: 2, maxCount: 2 },
    { min: 90.0, max: 94.9, minCount: 5, maxCount: 5 },
    { min: 85.1, max: 89.9, minCount: 15, maxCount: 15 },
    { min: 83.0, max: 85.0, minCount: 20, maxCount: 20 },
    { min: 82.0, max: 82.9, minCount: 18, maxCount: 18 },
    { min: 81.0, max: 81.9, minCount: 18, maxCount: 18 },
    { min: 80.0, max: 80.9, minCount: 21, maxCount: 21 },
    { min: 60.0, max: 79.9, minCount: 0, maxCount: 999 }
  ];
  const weekly = gatherWeeklyStats(snapshot, weekIndex);
  if (!weekly) return [];
  const confMap = conferenceMap(snapshot);
  const teamMap = teamNameMap(snapshot);
  const winMap = winPctMap(snapshot);
  const defAllow = teamDefenseAllowMap(weekly);
  const rosterLookup = buildRosterLookup(snapshot);
  const teamStats = aggregateTeamOffense(weekly);
  const players = mergePlayerStats(weekly);
  // Build raw scored list (all players) for grading
  const rawList = [];
  const list = [];
  const posScores = new Map();
  const isOffPos = (pos) => ['QB', 'HB', 'RB', 'TB', 'WR', 'TE', 'FB', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P'].includes(pos);
  const isDefPos = (pos) => !isOffPos(pos);

  for (const p of players.values()) {
    const rosterEntry = rosterLookup.get(p.rosterId);
    const posRaw = (p.position || rosterEntry?.position || 'UNK').toString().trim();
    const pos = posRaw.toUpperCase();
    const isDefense = ['CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB', 'RE', 'LE', 'DT'].includes(pos);
    let baseScore = isDefense ? scoreDefense(p) : scoreOffense(p);
    if (isDefense) {
      baseScore = baseScore * 1.4 + 6; // heavier weight for defense to surface 35-40 defenders in Top 100
      const allow = defAllow.get(p.teamId) || {};
      const yds = allow.defYds || 350;
      const pts = allow.defPts || 24;
      const ydsPenalty = Math.min(0.25, Math.max(-0.15, (yds - 320) / 400));
      const ptsPenalty = Math.min(0.25, Math.max(-0.10, (pts - 23) / 30));
      const penaltyFactor = 1 - (ydsPenalty * 0.6 + ptsPenalty * 0.4);
      baseScore *= Math.max(0.6, penaltyFactor);
    }
    // Position bump/nerf
    const edgePositions = new Set([
      'LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE',
      'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'
    ]);
    const posBump = (() => {
      // Heavier tilt to push offense into upper bands, soften defense
      if (pos === 'QB') return 1.45;
      if (pos === 'WR' || pos === 'TE') return 1.35;
      if (pos === 'HB' || pos === 'FB' || pos === 'RB') return 1.30;
      if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 1.18;
      if (edgePositions.has(pos)) return 0.80;
      if (['CB'].includes(pos)) return 0.78;
      if (['FS', 'SS'].includes(pos)) return 0.78;
      if (['DT', 'MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 0.75;
      if (pos === 'K' || pos === 'P') return 0.80;
      return 1.0;
    })();
    baseScore *= posBump;
    // Slightly boost good QBs for Top 100 weighting
    if (pos === 'QB' && baseScore > 50) {
      baseScore *= 1.08;
    }
    // Global offense/defense tilt to satisfy band splits
    if (isOffPos(pos)) {
      baseScore *= 1.50;
    } else {
      baseScore *= 0.70;
    }
    const winPct = (winMap[p.teamId] !== undefined && winMap[p.teamId] !== null) ? winMap[p.teamId] : 0.5;
    const score = baseScore * (1 + 0.12 * winPct) + (winPct * 8); // explicit win% bonus
    const rosterInfo = rosterEntry || rosterLookup.get(p.rosterId);
    const ovr = p.playerBestOvr || p.playerSchemeOvr || p.ovr || null;
    const common = {
      id: p.rosterId || `${p.fullName}-${p.teamId || ''}`,
      name: (rosterInfo?.fullName) || p.fullName || p.displayName || 'Unknown',
      position: (rosterInfo?.position || pos || 'UNK').toUpperCase(),
      displayPos: (rosterInfo?.position || pos || 'UNK').toUpperCase(),
      teamId: p.teamId,
      team: teamMap[p.teamId] || 'Unknown Team',
      conference: confMap[p.teamId] || 'Unknown',
      statLine: formatLine(p),
      winPct,
      ovr
    };
    rawList.push({ ...common, score });
    if (!posScores.has(pos)) posScores.set(pos, []);
    posScores.get(pos).push(score);
  }
  // Blend with position z-score to mix positions
  const posStats = {};
  posScores.forEach((arr, pos) => {
    const mean = arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const variance = arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, arr.length);
    const std = Math.sqrt(variance) || 1;
    posStats[pos] = { mean, std };
  });
  rawList.forEach(p => {
    const st = posStats[p.position] || { mean: 0, std: 1 };
    const z = (p.score - st.mean) / st.std;
    p.score = p.score * 0.6 + (z * 10) * 0.4;
  });
  // Light QB boost to ensure 3-6 QBs surface
  const qbs = rawList.filter(p => (p.position || '').toUpperCase() === 'QB').sort((a, b) => (b.score || 0) - (a.score || 0));
  qbs.slice(0, 8).forEach((p, i) => { p.score = (p.score || 0) * 1.18; if (i < 4) p.score += 8; });

  rawList.sort((a, b) => {
    const as = a.score !== undefined && a.score !== null ? a.score : 0;
    const bs = b.score !== undefined && b.score !== null ? b.score : 0;
    return bs - as;
  });
  // Add OL starters per team (5 slots) with differentiated scores
  const rosterTeams = snapshot?.rosters?.teams || {};
  Object.entries(rosterTeams).forEach(([teamId, roster]) => {
    const olPositions = ['LT', 'LG', 'C', 'RG', 'RT'];
    const pool = (roster?.rosterInfoList || []).filter(pl => olPositions.includes(pl.position));
    if (!pool.length) return;
    const teamStat = teamStats.get(Number(teamId)) || {};
    const winPct = (winMap[teamId] !== undefined && winMap[teamId] !== null) ? winMap[teamId] : 0.5;
    const baseOlScore = computeOlTeamScore(teamStat, winPct) + (winPct * 4);
    const passShare = Math.min(1, Math.max(0, (teamStat.passAtt || 0) / Math.max(1, (teamStat.passAtt || 0) + (teamStat.rushAtt || 0))));
    const runShare = 1 - passShare;
    const scoredPool = pool.map(pl => {
      const ovr = Number(pl.playerBestOvr || pl.playerSchemeOvr || 70);
      const ovrAdj = Math.max(-0.08, Math.min(0.08, (ovr - 75) * 0.005));
      const pos = pl.position;
      const passWeight = pos === 'LT' || pos === 'RT' ? 0.65 : (pos === 'C' ? 0.45 : 0.40);
      const runWeight = 1 - passWeight;
      const blendFactor = (passShare * passWeight) + (runShare * runWeight);
      const posMult = 0.9 + blendFactor * 0.12;
      const sackRate = (teamStat.passSacksAllowed || 0) / Math.max(1, teamStat.passAtt || 0);
      const brokenRate = (teamStat.rushBrokenTackles || 0) / Math.max(1, teamStat.rushAtt || 0);
      let posPenalty = 1;
      if (pos === 'LT' || pos === 'RT') {
        posPenalty -= Math.min(0.35, sackRate * 3.5);
        posPenalty -= Math.min(0.12, brokenRate * 1.2);
      } else {
        posPenalty -= Math.min(0.15, sackRate * 1.5);
        posPenalty -= Math.min(0.35, brokenRate * 3.5);
      }
      if (pos === 'LT') posPenalty += 0.03;
      if (pos === 'RT') posPenalty += 0.015;
      if (pos === 'C') posPenalty += 0.01;
      const raw = baseOlScore * posMult * posPenalty * (1 + ovrAdj);
      const maxCap = (pos === 'LT' || pos === 'RT') ? 75 : 72;
      const playerScore = Math.max(40, Math.min(maxCap, raw));
      return { pl, playerScore };
    }).sort((a, b) => b.playerScore - a.playerScore);
    // Take best 5 by score (tie-break by OVR) and enforce 2.5 point gaps by rank
    const starters = scoredPool
      .sort((a, b) => {
        if (b.playerScore !== a.playerScore) return b.playerScore - a.playerScore;
        const ovrA = Number(a.pl.playerBestOvr || a.pl.playerSchemeOvr || 0);
        const ovrB = Number(b.pl.playerBestOvr || b.pl.playerSchemeOvr || 0);
        return ovrB - ovrA;
      })
      .slice(0, 1);
    starters.forEach((entry, idx) => {
      const { pl, playerScore } = entry;
      const pos = pl.position;
      const finalScore = Math.max(30, playerScore - idx * 5);
      rawList.push({
        id: pl.rosterId || `${pl.firstName || ''}-${pl.lastName || ''}-${teamId}-${pos}`,
        name: `${pl.firstName || ''} ${pl.lastName || ''}`.trim() || pos,
        position: pos,
        teamId: Number(teamId),
        team: teamMap[teamId] || 'Unknown Team',
        conference: confMap[teamId] || 'Unknown',
        score: finalScore,
        statLine: `OL proxy — YPA ${((teamStat.passYds || 0) / Math.max(1, teamStat.passAtt || 0)).toFixed(1)}, SackRate ${(((teamStat.passSacksAllowed || 0) / Math.max(1, teamStat.passAtt || 0)) * 100).toFixed(1)}%, YPC ${((teamStat.rushYds || 0) / Math.max(1, teamStat.rushAtt || 0)).toFixed(1)}`,
        winPct,
        ovr: pl.playerBestOvr || pl.playerSchemeOvr || null
      });
    });
  });
  // Final sort and grade; downweight OL further to avoid crowding the top
  const olSet = new Set(['LT', 'LG', 'C', 'RG', 'RT']);
  const olEntries = rawList.filter(p => olSet.has(p.position));
  const nonOl = rawList.filter(p => !olSet.has(p.position));
  olEntries.sort((a, b) => (b.score || 0) - (a.score || 0));
  const olTop = olEntries.slice(0, 3).map((p, idx) => {
    const capped = Math.max(30, Math.min(75, (p.score || 0)));
    return { ...p, score: capped - idx * 1.5 }; // slight spread within top3
  });
  const olRest = olEntries.slice(3).map(p => ({ ...p, score: 20 })); // force low so grades stay sub-90
  const combined = [...nonOl, ...olTop, ...olRest];
  combined.forEach(p => {
    if (olSet.has(p.position)) {
      p.score = Math.max(20, Math.min(75, p.score));
    }
  });
  rawList.length = 0;
  rawList.push(...combined);
  rawList.sort((a, b) => {
    const as = a.score !== undefined && a.score !== null ? a.score : 0;
    const bs = b.score !== undefined && b.score !== null ? b.score : 0;
    return bs - as;
  });
  const totalWithOl = rawList.length || 1;
  const slot95 = (() => {
    const desired = Math.max(3, Math.min(5, totalWithOl - 1));
    return Math.max(0, Math.min(totalWithOl - 1, desired));
  })();
  const slot90 = (() => {
    const remaining = Math.max(0, totalWithOl - 1 - slot95);
    const desired = Math.max(7, Math.min(12, Math.floor(totalWithOl / 80) || 7));
    return Math.min(remaining, desired);
  })();
  const topNonOlIdx = rawList.findIndex(p => !olSet.has((p.position || '').toUpperCase()));
  const prelim = rawList.map((p, idx) => {
    let grade;
    if (idx === 0 && (topNonOlIdx === 0 || topNonOlIdx === -1)) {
      grade = 98.5; // single 97.0-99.9 slot (fallback to overall if no non-OL)
    } else if (idx <= slot95) {
      const span = slot95 > 1 ? (idx - 1) / (slot95 - 1) : 0;
      grade = 97.0 - span * (97.0 - 95.0); // 95.0 - 97.0 band
    } else if (idx <= slot95 + slot90) {
      const j = idx - (slot95 + 1);
      const span = slot90 > 1 ? j / (slot90 - 1) : 0;
      grade = 94.9 - span * (94.9 - 90.0); // 90.0 - 94.9 band
    } else {
      // remaining: scale 55 - 89.5 with more spread
      const span = totalWithOl > slot95 + slot90 + 1
        ? (idx - (slot95 + slot90 + 1)) / Math.max(1, totalWithOl - (slot95 + slot90 + 1) - 1)
        : 1;
      const curved = Math.pow(span, 0.6);
      grade = 89.5 - curved * (89.5 - 55);
    }
    return { ...p, grade: Number(grade.toFixed(1)) };
  });
  // Force top non-OL into the 97 slot if available
  if (topNonOlIdx > 0) {
    const targetId = rawList[topNonOlIdx].id;
    const prelimIdx = prelim.findIndex(p => p.id === targetId);
    if (prelimIdx >= 0) {
      prelim[prelimIdx] = { ...prelim[prelimIdx], grade: 98.5 };
      // Demote previous 98 slot if it was OL
      const firstId = rawList[0].id;
      const firstIdx = prelim.findIndex(p => p.id === firstId);
      if (firstIdx >= 0 && prelim[firstIdx].grade > 97.5) {
        prelim[firstIdx] = { ...prelim[firstIdx], grade: 94.9 };
      }
    }
  }
  // Boost defenders into target grading bands (90s/80s/70s) so they aren't buried
  const DEF_POSITIONS = new Set(['CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB', 'RE', 'LE', 'DT']);
  const DEF_GRADE_MULTIPLIER = 1.12;
  const DEF_GRADE_OFFSET = 2.0;
  const prelimAdjusted = prelim.map(p => {
    const pos = (p.position || '').toUpperCase();
    if (!DEF_POSITIONS.has(pos)) return p;
    const boosted = (p.grade || 0) * DEF_GRADE_MULTIPLIER + DEF_GRADE_OFFSET;
    const clamped = Math.min(99.9, boosted);
    return { ...p, grade: Number(clamped.toFixed(1)) };
  });
  // OL-specific caps: only 1 OL can be 95+, up to 3 OL can be 90-94.9
  const olSetFinal = olSet;
  const olSorted = prelimAdjusted.filter(p => olSetFinal.has(p.position)).sort((a, b) => (b.grade || 0) - (a.grade || 0));
  let ol95 = 0;
  let ol90 = 0;
  const adjust = new Map();
  olSorted.forEach(p => {
    if ((p.grade || 0) >= 95) {
      if (ol95 < 1) {
        ol95 += 1;
        adjust.set(p.id, p.grade);
      } else {
        adjust.set(p.id, Math.min(89.9, p.grade));
      }
    } else if ((p.grade || 0) >= 90) {
      if (ol90 < 3) {
        ol90 += 1;
        adjust.set(p.id, p.grade);
      } else {
        adjust.set(p.id, Math.min(89.9, p.grade));
      }
    }
  });
  // QB presence: ensure 1-3 QBs in 90+; cap extras
  const qbSorted = prelimAdjusted.filter(p => (p.position || '').toUpperCase() === 'QB').sort((a, b) => (b.grade || 0) - (a.grade || 0));
  const qbBands = [
    { min: 95.0, max: 96.9, needMin: 1, needMax: 2 },
    { min: 90.0, max: 94.9, needMin: 2, needMax: 3 },
    { min: 85.1, max: 89.9, needMin: 2, needMax: 4 },
    { min: 80.0, max: 85.0, needMin: 3, needMax: 5 },
    { min: 79.0, max: 79.9, needMin: 2, needMax: 3 },
    { min: 78.0, max: 78.9, needMin: 2, needMax: 4 },
    { min: 77.0, max: 77.9, needMin: 3, needMax: 7 },
    { min: 76.0, max: 76.9, needMin: 5, needMax: 8 },
    { min: 60.0, max: 75.9, needMin: 0, needMax: 999 }
  ];
  const qbAdjust = new Map();
  let idxQB = 0;
  const remainingMin = (start) => qbBands.slice(start).reduce((s, b) => s + b.needMin, 0);
  qbBands.forEach((band, bi) => {
    if (idxQB >= qbSorted.length) return;
    const remaining = qbSorted.length - idxQB;
    const minFuture = remainingMin(bi + 1);
    const maxForBand = Math.min(band.needMax, Math.max(0, remaining - minFuture));
    const assignCount = Math.min(Math.max(band.needMin, 0), Math.max(remaining, band.needMin));
    const count = Math.min(Math.max(assignCount, Math.min(maxForBand || remaining, remaining)), Math.max(assignCount, band.needMax || remaining));
    const take = Math.max(band.needMin, Math.min(count, remaining));
    for (let i = 0; i < take && idxQB < qbSorted.length; i++, idxQB++) {
      const qb = qbSorted[idxQB];
      const spanMid = (band.min + band.max) / 2;
      qbAdjust.set(qb.id, Number(spanMid.toFixed(1)));
    }
  });
  // Any remaining QBs not placed go to the lowest band midpoint
  while (idxQB < qbSorted.length) {
    const qb = qbSorted[idxQB++];
    qbAdjust.set(qb.id, 75.0);
  }

  // Defender caps by band
  const defPositions = DEF_POSITIONS;
  const defSorted = prelimAdjusted.filter(p => defPositions.has((p.position || '').toUpperCase())).sort((a, b) => (b.grade || 0) - (a.grade || 0));
  const defBands = [
    { min: 95.0, max: 99.9, needMin: 1, needMax: 2 },
    { min: 90.0, max: 94.9, needMin: 2, needMax: 5 },
    { min: 85.1, max: 89.9, needMin: 4, needMax: 6 },
    { min: 80.0, max: 85.0, needMin: 5, needMax: 7 },
    { min: 79.0, max: 79.9, needMin: 2, needMax: 5 },
    { min: 78.0, max: 78.9, needMin: 3, needMax: 6 },
    { min: 77.0, max: 77.9, needMin: 3, needMax: 7 },
    { min: 76.0, max: 76.9, needMin: 5, needMax: 8 },
    { min: 60.0, max: 75.9, needMin: 0, needMax: 999 }
  ];
  const defAdjust = new Map();
  let idxDef = 0;
  const remainingDefMin = (start) => defBands.slice(start).reduce((s, b) => s + b.needMin, 0);
  defBands.forEach((band, bi) => {
    if (idxDef >= defSorted.length) return;
    const remaining = defSorted.length - idxDef;
    const minFuture = remainingDefMin(bi + 1);
    const maxForBand = Math.min(band.needMax, Math.max(0, remaining - minFuture));
    const assignCount = Math.max(band.needMin, Math.min(maxForBand || remaining, remaining));
    const take = Math.max(band.needMin, Math.min(assignCount, remaining));
    for (let i = 0; i < take && idxDef < defSorted.length; i++, idxDef++) {
      const d = defSorted[idxDef];
      const spanMid = (band.min + band.max) / 2;
      defAdjust.set(d.id, Number(spanMid.toFixed(1)));
    }
  });
  while (idxDef < defSorted.length) {
    const d = defSorted[idxDef++];
    defAdjust.set(d.id, 75.0);
  }

  // Team caps per band
  const bandCaps = [
    { min: 95.0, max: 99.9, cap: 1, mid: 97.5 },
    { min: 90.0, max: 94.9, cap: 3, mid: 92.5 },
    { min: 85.1, max: 89.9, cap: 3, mid: 87.5 },
    { min: 80.0, max: 85.0, cap: 3, mid: 82.5 },
    { min: 79.0, max: 79.9, cap: 4, mid: 79.5 },
    { min: 78.0, max: 78.9, cap: 4, mid: 78.5 },
    { min: 77.0, max: 77.9, cap: 5, mid: 77.5 },
    { min: 76.0, max: 76.9, cap: 5, mid: 76.5 },
  ];
  const findBandIdx = (g) => bandCaps.findIndex(b => g >= b.min && g <= b.max);
  const nextBandMid = (idx) => {
    if (idx < bandCaps.length - 1) return bandCaps[idx + 1].mid;
    return 75.0;
  };
  const teamBandCounts = new Map();
  const defTeamCaps = [
    { min: 95.0, max: 99.9, cap: 1, mid: 97.5 },
    { min: 90.0, max: 94.9, cap: 2, mid: 92.5 },
    { min: 85.1, max: 89.9, cap: 2, mid: 87.5 },
    { min: 80.0, max: 85.0, cap: 2, mid: 82.5 },
    { min: 79.0, max: 79.9, cap: 2, mid: 79.5 },
    { min: 78.0, max: 78.9, cap: 3, mid: 78.5 },
    { min: 77.0, max: 77.9, cap: 3, mid: 77.5 },
    { min: 76.0, max: 76.9, cap: 3, mid: 76.5 },
  ];
  const defFindBandIdx = (g) => defTeamCaps.findIndex(b => g >= b.min && g <= b.max);
  const defNextBandMid = (idx) => {
    if (idx < defTeamCaps.length - 1) return defTeamCaps[idx + 1].mid;
    return 75.0;
  };
  const defTeamCounts = new Map();

  const graded = applyBanding(rawList, bandDefs);
  // --- STRICT DEFENDER BAND + TEAM CAPS LOGIC ---
  // Defender band and per-team caps
  const defBandSpecs = [
    { min: 95.0, max: 99.9, minCount: 1, maxCount: 2, teamCap: 1 },
    { min: 90.0, max: 94.9, minCount: 2, maxCount: 5, teamCap: 2 },
    { min: 85.1, max: 89.9, minCount: 4, maxCount: 6, teamCap: 2 },
    { min: 80.0, max: 85.0, minCount: 5, maxCount: 7, teamCap: 2 },
    { min: 79.0, max: 79.9, minCount: 2, maxCount: 5, teamCap: 2 },
    { min: 78.0, max: 78.9, minCount: 3, maxCount: 6, teamCap: 3 },
    { min: 77.0, max: 77.9, minCount: 3, maxCount: 7, teamCap: 3 },
    { min: 76.0, max: 76.9, minCount: 5, maxCount: 8, teamCap: 3 }
  ];
  const defPositionsSet100 = DEF_POSITIONS;
  const defenders = prelimAdjusted.filter(p => defPositionsSet100.has((p.position || '').toUpperCase()));
  const defPool = defenders.slice().sort((a, b) => (b.grade || 0) - (a.grade || 0));
  const usedDef = new Set();
  const teamBandCountsDef = Array(defBandSpecs.length).fill(0).map(() => new Map());
  let selectedDefenders = [];
  defBandSpecs.forEach((band, i) => {
    const bandMid = ((band.min + band.max) / 2).toFixed(1);
    let count = 0;
    // Primary pass: respect team caps
    for (const p of defPool) {
      if (usedDef.has(p.id)) continue;
      const team = p.teamId || p.team || 'unk';
      const tCount = teamBandCountsDef[i].get(team) || 0;
      if (tCount >= band.teamCap) continue;
      if (count >= band.maxCount) break;
      selectedDefenders.push({ ...p, grade: Number(bandMid) });
      usedDef.add(p.id);
      teamBandCountsDef[i].set(team, tCount + 1);
      count++;
    }
    // If below minCount, relax team cap to fill from remaining best defenders
    if (count < band.minCount) {
      for (const p of defPool) {
        if (count >= band.minCount) break;
        if (usedDef.has(p.id)) continue;
        selectedDefenders.push({ ...p, grade: Number(bandMid) });
        usedDef.add(p.id);
        count++;
      }
    }
  });
  // If less than 40 defenders, fill with next best defenders (any band, respecting global per-team cap of 8)
  if (selectedDefenders.length < 40) {
    const already = new Set(selectedDefenders.map(p => p.id));
    const teamGlobal = new Map(selectedDefenders.map(p => [p.teamId || p.team || 'unk', 1]));
    for (const p of defPool) {
      if (selectedDefenders.length >= 40) break;
      if (already.has(p.id)) continue;
      const team = p.teamId || p.team || 'unk';
      const tCount = teamGlobal.get(team) || 0;
      if (tCount >= 8) continue;
      selectedDefenders.push({ ...p, grade: Number(Math.max(70, Math.min(76, p.grade || 70)).toFixed(1)) });
      already.add(p.id);
      teamGlobal.set(team, tCount + 1);
    }
  }
  // Fill rest of top 100 with best non-defenders
  const nonDefenders = prelimAdjusted.filter(p => !defPositionsSet100.has((p.position || '').toUpperCase()));
  const fillCount = 100 - selectedDefenders.length;
  const rest = nonDefenders.sort((a, b) => (b.grade || 0) - (a.grade || 0)).slice(0, fillCount);
  // Combine and sort by grade for final output
  const forcedTop100 = [...selectedDefenders, ...rest].sort((a, b) => (b.grade || 0) - (a.grade || 0)).slice(0, 100);

  // --- Top 100 positional quotas by band ---
  const posGroup = (posRaw) => {
    const pos = (posRaw || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['HB', 'RB', 'TB'].includes(pos)) return 'RB';
    if (pos === 'WR') return 'WR';
    if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 'OL';
    if (['MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    if (pos === 'CB') return 'CB';
    if (pos === 'FS' || pos === 'SS') return 'S';
    if (pos === 'K' || pos === 'P' || pos === 'FB') return 'SPECIAL';
    // Edge catch-all (exclude pure DT/IDL/NT from EDG so edge quota can't be filled by DTs)
    if (['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'OLB', 'DE', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE'].includes(pos)) return 'EDG';
    if (/EDGE/.test(pos)) return 'EDG';
    if (/DE/.test(pos)) return 'EDG';
    if (/OLB/.test(pos) && !/MLB/.test(pos)) return 'EDG';
    return 'OTHER';
  };

  const bandConfigs = [
    {
      name: '90',
      min: 90,
      max: 99.99,
      groups: {
        QB: { min: 3, max: 5 },
        RB: { min: 3, max: 5 },
        WR: { min: 3, max: 5 },
        OL: { min: 3, max: 5 },
        EDG: { min: 2, max: 4 },
        LB: { min: 2, max: 4 },
        CB: { min: 2, max: 4 },
        S: { min: 2, max: 4 },
        SPECIAL: { min: 0, max: 0 }
      }
    },
    {
      name: '80',
      min: 80,
      max: 89.99,
      groups: {
        QB: { min: 3, max: 5 },
        RB: { min: 3, max: 5 },
        WR: { min: 3, max: 5 },
        OL: { min: 3, max: 5 },
        EDG: { min: 3, max: 5 },
        LB: { min: 3, max: 5 },
        CB: { min: 3, max: 5 },
        S: { min: 3, max: 5 },
        SPECIAL: { min: 1, max: 2 }
      }
    },
    {
      name: '70',
      min: 70,
      max: 79.99,
      groups: {
        QB: { min: 5, max: 8 },
        RB: { min: 5, max: 8 },
        WR: { min: 5, max: 8 },
        OL: { min: 5, max: 8 },
        EDG: { min: 5, max: 8 },
        LB: { min: 5, max: 8 },
        CB: { min: 5, max: 8 },
        S: { min: 5, max: 8 },
        SPECIAL: { min: 1, max: 3 }
      }
    }
  ];

  const ensureId = (p, idx, prefix = 'player') => {
    if (p.id) return p.id;
    const name = (p.name || 'unk').replace(/\s+/g, '_');
    const pos = p.position || 'UNK';
    return `${prefix}-${name}-${pos}-${idx}`;
  };

  const candidatePool = prelimAdjusted
    .slice()
    .map((p, idx) => ({ ...p, id: ensureId(p, idx, 'cand') }))
    .sort((a, b) => (b.grade || 0) - (a.grade || 0));

  // Edge preference helpers
  const isEdgePrimary = (pos) => {
    const p = (pos || '').toUpperCase();
    return ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'OLB', 'DE', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE'].includes(p);
  };
  const isEdgeSecondary = (_pos) => false; // no DT fallback in EDG now
  const edgeSort = (a, b) => {
    const pa = isEdgePrimary(a.position) ? 1 : (isEdgeSecondary(a.position) ? 0 : -1);
    const pb = isEdgePrimary(b.position) ? 1 : (isEdgeSecondary(b.position) ? 0 : -1);
    if (pa !== pb) return pb - pa; // primary > secondary > other
    return (b.grade || 0) - (a.grade || 0);
  };

  // Precompute global unused pools per group (any grade) to backfill mins
  const globalGroupPools = new Map();
  candidatePool.forEach(p => {
    const g = posGroup(p.position);
    if (!globalGroupPools.has(g)) globalGroupPools.set(g, []);
    globalGroupPools.get(g).push(p);
  });
  globalGroupPools.forEach((list, g) => {
    if (g === 'EDG') list.sort(edgeSort);
    else list.sort((a, b) => (b.grade || 0) - (a.grade || 0));
  });

  const bandMatch = (grade, band) => grade >= band.min && grade <= band.max;

  const availableByBandGroup = new Map();
  bandConfigs.forEach((band) => {
    band.availableMinSum = 0;
    Object.keys(band.groups).forEach((g) => {
      const bucket = candidatePool.filter(p => bandMatch(p.grade || 0, band) && posGroup(p.position) === g);
      const minPossible = Math.min(band.groups[g].min || 0, bucket.length);
      band.availableMinSum += minPossible;
      const sortedBucket = g === 'EDG' ? bucket.sort(edgeSort) : bucket.sort((a, b) => (b.grade || 0) - (a.grade || 0));
      availableByBandGroup.set(`${band.name}-${g}`, sortedBucket);
    });
  });

  let remainingMinTotal = bandConfigs.reduce((sum, band) => sum + band.availableMinSum, 0);
  const selected = [];
  const used = new Set();
  let specialTaken = 0;

  bandConfigs.forEach((band) => {
    const groupEntries = Object.entries(band.groups);
    groupEntries.forEach(([group, spec]) => {
      const bucketKey = `${band.name}-${group}`;
      const bucketRaw = (availableByBandGroup.get(bucketKey) || []).filter(p => !used.has(p.id));
      const bucket = bucketRaw.sort(group === 'EDG' ? edgeSort : ((a, b) => (b.grade || 0) - (a.grade || 0)));
      const globalPool = (globalGroupPools.get(group) || []).filter(p => !used.has(p.id));
      if (!bucket.length) {
        // try to backfill from global pool (promote into this band)
        const backfill = [];
        for (const [i, p] of globalPool.entries()) {
          if (used.has(p.id)) continue;
          const boosted = Math.min(band.max, band.max - i * 0.2); // top of band for first fills
          backfill.push({ ...p, grade: Math.max(boosted, band.min + 0.1) });
          if (backfill.length >= (spec.min || 0)) break;
        }
        bucket.push(...backfill);
      }
      const remainingSlots = Math.max(0, 100 - selected.length);
      const minPossible = Math.min(spec.min || 0, bucket.length);
      const takeMin = Math.min(minPossible, remainingSlots);
      for (let i = 0; i < takeMin; i++) {
        if (group === 'SPECIAL' && specialTaken >= 3) break;
        const p = bucket[i];
        selected.push(p);
        used.add(p.id);
        if (group === 'SPECIAL') specialTaken += 1;
      }
      remainingMinTotal = Math.max(0, remainingMinTotal - takeMin);
      const remainingAfterMin = Math.max(0, 100 - selected.length);
      const remainingMinOthers = Math.max(0, remainingMinTotal);
      const extraRoom = Math.max(0, remainingAfterMin - remainingMinOthers);
      const extraAvailable = Math.max(0, (spec.max || 0) - takeMin);
      let extraPicked = 0;
      for (let i = takeMin; i < bucket.length && extraPicked < extraRoom && extraPicked < extraAvailable; i++) {
        if (group === 'SPECIAL' && specialTaken >= 3) break;
        const p = bucket[i];
        if (used.has(p.id)) continue;
        selected.push(p);
        used.add(p.id);
        if (group === 'SPECIAL') specialTaken += 1;
        extraPicked += 1;
      }
    });
  });

  // Fill any remaining slots with best available regardless of band/group (respect special cap)
  if (selected.length < 100) {
    for (const p of candidatePool) {
      if (selected.length >= 100) break;
      if (used.has(p.id)) continue;
      const g = posGroup(p.position);
      if (g === 'SPECIAL' && specialTaken >= 3) continue;
      selected.push(p);
      used.add(p.id);
      if (g === 'SPECIAL') specialTaken += 1;
    }
  }

  let finalTop100 = selected
    .sort((a, b) => (b.grade || 0) - (a.grade || 0))
    .slice(0, 100);

  // Post-pass: ensure each band/group meets minimums by swapping lowest eligible out
  const bandForGrade = (g) => bandConfigs.find(b => (g || 0) >= b.min && (g || 0) <= b.max);
  const bandGroupKey = (b, g) => `${b.name}-${g}`;
  const counts = new Map();
  const usedFinal = new Set(finalTop100.map(p => p.id));
  const incCount = (b, g) => counts.set(bandGroupKey(b, g), (counts.get(bandGroupKey(b, g)) || 0) + 1);
  const decCount = (b, g) => counts.set(bandGroupKey(b, g), Math.max(0, (counts.get(bandGroupKey(b, g)) || 0) - 1));
  finalTop100.forEach(p => {
    const b = bandForGrade(p.grade || 0);
    const g = posGroup(p.position);
    if (b) incCount(b, g);
  });
  const canRemove = (p) => {
    const b = bandForGrade(p.grade || 0);
    const g = posGroup(p.position);
    if (!b) return false;
    const cur = counts.get(bandGroupKey(b, g)) || 0;
    const min = (b.groups[g] && b.groups[g].min) || 0;
    return cur > min;
  };
  const bestCandidateFor = (group) => {
    return candidatePool.find(p => !usedFinal.has(p.id) && posGroup(p.position) === group);
  };
  bandConfigs.forEach((band) => {
    Object.entries(band.groups).forEach(([group, spec]) => {
      const needed = spec.min || 0;
      const key = bandGroupKey(band, group);
      let have = counts.get(key) || 0;
      while (have < needed) {
        const candidate = bestCandidateFor(group);
        if (!candidate) break;
        // find a removable lowest-grade player not in this group's band min
        const removableIdx = (() => {
          let idx = -1;
          let lowest = Infinity;
          finalTop100.forEach((p, i) => {
            if (usedFinal.has(p.id)) return;
            const b = bandForGrade(p.grade || 0);
            if (!b) return;
            const g = posGroup(p.position);
            const curKey = bandGroupKey(b, g);
            const curCount = counts.get(curKey) || 0;
            const curMin = (b.groups[g] && b.groups[g].min) || 0;
            if (curCount <= curMin) return;
            if ((p.grade || 0) < lowest) {
              lowest = p.grade || 0;
              idx = i;
            }
          });
          return idx;
        })();
        if (removableIdx === -1) break;
        const [removed] = finalTop100.splice(removableIdx, 1);
        usedFinal.delete(removed.id);
        const rb = bandForGrade(removed.grade || 0);
        const rg = posGroup(removed.position);
        if (rb) decCount(rb, rg);
        const promoted = { ...candidate, grade: Math.min(band.max, Math.max(band.min + 0.1, band.max - 0.15 * have)) };
        finalTop100.push(promoted);
        usedFinal.add(promoted.id);
        incCount(band, group);
        have += 1;
      }
    });
  });

  // Resort after swaps
  finalTop100.sort((a, b) => (b.grade || 0) - (a.grade || 0));
  finalTop100 = finalTop100.map(p => ({
    ...p,
    grade: p.grade != null ? Number(p.grade.toFixed(2)) : p.grade
  }));

  // Overall positional quotas for final Top 100
  const overallQuotas = {
    QB: { min: 7, max: 10 },
    RB: { min: 10, max: 13 },
    WR: { min: 11, max: 15 },
    OL: { min: 13, max: 17 },
    EDG: { min: 11, max: 15 },
    LB: { min: 8, max: 11 },
    CB: { min: 10, max: 13 },
    S: { min: 5, max: 8 },
    SPECIAL: { min: 1, max: 3 },
    OTHER: { min: 0, max: 100 }
  };

  const enforceOverallQuotas = (list) => {
    const counts = new Map();
    const used = new Set(list.map(p => p.id));
    const getGroup = (p) => posGroup(p.displayPos || p.position);
    list.forEach(p => {
      const g = getGroup(p);
      counts.set(g, (counts.get(g) || 0) + 1);
    });
    const pool = candidatePool.filter(p => !used.has(p.id)).sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const poolByGroup = new Map();
    pool.forEach(p => {
      const g = getGroup(p);
      if (!poolByGroup.has(g)) poolByGroup.set(g, []);
      poolByGroup.get(g).push(p);
    });
    poolByGroup.forEach((list, g) => {
      if (g === 'EDG') list.sort(edgeSort);
      else list.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    });
    // Trim over max
    Object.entries(overallQuotas).forEach(([group, spec]) => {
      const max = spec.max ?? 1000;
      const cur = counts.get(group) || 0;
      if (cur <= max) return;
      let needDrop = cur - max;
      for (let i = list.length - 1; i >= 0 && needDrop > 0; i--) {
        const p = list[i];
        if (getGroup(p) !== group) continue;
        list.splice(i, 1);
        counts.set(group, counts.get(group) - 1);
        used.delete(p.id);
        needDrop--;
      }
    });
    // Add to reach mins
    Object.entries(overallQuotas).forEach(([group, spec]) => {
      const min = spec.min || 0;
      let cur = counts.get(group) || 0;
      const bucket = poolByGroup.get(group) || [];
      while (cur < min && bucket.length) {
        const p = bucket.shift();
        if (used.has(p.id)) continue;
        list.push(p);
        used.add(p.id);
        counts.set(group, cur + 1);
        cur += 1;
      }
    });
    // Fill to 100 with best remaining, respecting max
    for (const p of pool) {
      if (list.length >= 100) break;
      if (used.has(p.id)) continue;
      const g = getGroup(p);
      const max = (overallQuotas[g] || overallQuotas.OTHER).max ?? 1000;
      const cur = counts.get(g) || 0;
      if (cur >= max) continue;
      list.push(p);
      used.add(p.id);
      counts.set(g, cur + 1);
    }
    // Resort by grade desc
    list.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    return list.slice(0, 100);
  };

  const afterOverall = enforceOverallQuotas(finalTop100);

  // Team caps per band (grade tiers)
  const teamBandCaps = [
    { min: 95.0, max: 99.9, cap: 1 },
    { min: 90.0, max: 94.9, cap: 3 },
    { min: 85.1, max: 89.9, cap: 3 },
    { min: 80.0, max: 85.0, cap: 3 },
    { min: 79.0, max: 79.9, cap: 4 },
    { min: 78.0, max: 78.9, cap: 4 },
    { min: 77.0, max: 77.9, cap: 5 },
    { min: 76.0, max: 76.9, cap: 5 }
  ];
  const findTeamBand = (g) => teamBandCaps.find(b => (g || 0) >= b.min && (g || 0) <= b.max);

  const applyTeamCaps = (list) => {
    const kept = [];
    const teamCounts = new Map(); // key: teamId|bandIdx
    const groupCounts = new Map();
    const getGroup = (p) => posGroup(p.displayPos || p.position);
    const used = new Set();
    const overallMax = (g) => (overallQuotas[g] || overallQuotas.OTHER).max ?? 1000;
    list.forEach(p => {
      const b = findTeamBand(p.grade || 0);
      const team = p.teamId || p.team || 'unk';
      const g = getGroup(p);
      const overMaxGroup = (groupCounts.get(g) || 0) >= overallMax(g);
      if (overMaxGroup) return;
      if (!b) {
        kept.push(p);
        groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
        used.add(p.id);
        return;
      }
      const key = `${team}-${b.min}-${b.max}`;
      const cur = teamCounts.get(key) || 0;
      if (cur >= b.cap) return;
      teamCounts.set(key, cur + 1);
      kept.push(p);
      groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
      used.add(p.id);
    });
    // Backfill if we dropped too many
    if (kept.length < 100) {
      const pool = candidatePool
        .filter(p => !used.has(p.id))
        .sort((a, b) => (b.grade || 0) - (a.grade || 0));
      for (const p of pool) {
        if (kept.length >= 100) break;
        const b = findTeamBand(p.grade || 0);
        const team = p.teamId || p.team || 'unk';
        const g = getGroup(p);
        const curG = groupCounts.get(g) || 0;
        if (curG >= overallMax(g)) continue;
        if (b) {
          const key = `${team}-${b.min}-${b.max}`;
          const cur = teamCounts.get(key) || 0;
          if (cur >= b.cap) continue;
          teamCounts.set(key, cur + 1);
        }
        kept.push(p);
        groupCounts.set(g, curG + 1);
        used.add(p.id);
      }
    }
    kept.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    return kept.slice(0, 100);
  };

  const withTeamCaps = applyTeamCaps(afterOverall);
  // Final band enforcement to match global OVR scale
  const banded = applyBanding(withTeamCaps, bandDefs);
  // Within each band, spread by small offsets to avoid identical grades (0.01 steps)
  const bandBuckets = new Map();
  banded.forEach(p => {
    const b = bandDefs.find(bd => (p.grade || 0) >= bd.min && (p.grade || 0) <= bd.max);
    const key = b ? `${b.min}-${b.max}` : 'other';
    if (!bandBuckets.has(key)) bandBuckets.set(key, []);
    bandBuckets.get(key).push(p);
  });
  bandBuckets.forEach(list => {
    list.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    // preserve band-distributed grades; no artificial countdown
  });

  // Offense/defense rebalance per band and QB minimums
  const isOffenseGroup = (g) => ['QB', 'RB', 'WR', 'OL', 'SPECIAL'].includes(g);
  const isDefenseGroup = (g) => ['EDG', 'LB', 'CB', 'S', 'DT'].includes(g);
  const getGroup = (p) => posGroup(p.displayPos || p.position);
  const rebalanceBand = (players, config) => {
    if (!players.length) return players;
    const total = players.length;
    const qbList = players.filter(p => getGroup(p) === 'QB').sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const offList = players.filter(p => getGroup(p) !== 'QB' && isOffenseGroup(getGroup(p))).sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const defList = players.filter(p => isDefenseGroup(getGroup(p))).sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const flexList = players.filter(p => !isOffenseGroup(getGroup(p)) && !isDefenseGroup(getGroup(p)) && getGroup(p) !== 'QB').sort((a, b) => (b.grade || 0) - (a.grade || 0));

    const pick = [];
    const takeFrom = (list, count) => {
      for (let i = 0; i < count && list.length; i++) pick.push(list.shift());
    };

    if (config.qbMin) {
      takeFrom(qbList, config.qbMin);
    }

    let desiredOff;
    let desiredDef;
    if (config.offRatio != null) {
      desiredOff = Math.round(total * config.offRatio);
      desiredDef = total - desiredOff;
    } else {
      desiredOff = config.offMin || 0;
      desiredDef = config.defMin || 0;
    }
    if (config.offMax != null) desiredOff = Math.min(config.offMax, desiredOff);
    if (config.defMax != null) desiredDef = Math.min(config.defMax, desiredDef);

    // Adjust for already picked QBs (count as offense)
    desiredOff = Math.max(desiredOff, config.offMin || 0);
    desiredDef = Math.max(desiredDef, config.defMin || 0);

    const offNeeded = Math.max(0, desiredOff - pick.filter(p => isOffenseGroup(getGroup(p)) || getGroup(p) === 'QB').length);
    takeFrom(offList, offNeeded);

    const defNeeded = Math.max(0, desiredDef - pick.filter(p => isDefenseGroup(getGroup(p))).length);
    takeFrom(defList, defNeeded);

    // Fill remaining slots in band with highest grade remaining
    const remainingSlots = total - pick.length;
    const leftovers = [...qbList, ...offList, ...defList, ...flexList].sort((a, b) => (b.grade || 0) - (a.grade || 0));
    takeFrom(leftovers, remainingSlots);

    return pick.sort((a, b) => (b.grade || 0) - (a.grade || 0));
  };

  const bandConfigsRebalance = [
    { name: '90s', min: 90, max: 99.99, offMin: 4, offMax: 5, defMin: 3, defMax: 4, qbMin: 2 },
    { name: '80s', min: 80, max: 89.999, offRatio: 0.62, qbMin: 5, qbMax: 6 },
    { name: '70s', min: 70, max: 79.999, offRatio: 0.5, qbMin: 8, qbMax: 9 }
  ];

  const rebalanced = [];
  banded.forEach(p => {
    const b = bandConfigsRebalance.find(cfg => (p.grade || 0) >= cfg.min && (p.grade || 0) <= cfg.max);
    if (!b) return rebalanced.push(p);
    const key = `${b.min}-${b.max}`;
    if (!bandBuckets.has(key)) bandBuckets.set(key, []);
    bandBuckets.get(key).push(p);
  });

  const processed = [];
  bandConfigsRebalance.forEach(cfg => {
    const key = `${cfg.min}-${cfg.max}`;
    const list = banded.filter(p => (p.grade || 0) >= cfg.min && (p.grade || 0) <= cfg.max);
    const adjusted = rebalanceBand(list, cfg);
    processed.push(...adjusted);
  });
  // Add any players outside these bands
  const outside = banded.filter(p => (p.grade || 0) < 70 || (p.grade || 0) > 99.999);
  processed.push(...outside);

  // Cross-band adjustments to force offense/def/QB mix in 90s/80s
  const isOffGroup = (p) => isOffenseGroup(getGroup(p)) || getGroup(p) === 'QB';
  const isDefGroup = (p) => isDefenseGroup(getGroup(p));
  let band90 = processed.filter(p => (p.grade || 0) >= 90 && (p.grade || 0) <= 99.999);
  let band80 = processed.filter(p => (p.grade || 0) >= 80 && (p.grade || 0) <= 89.999);
  const others = processed.filter(p => (p.grade || 0) < 80 || (p.grade || 0) > 99.999);

  const desired90Count = bandDefs
    .filter(b => b.min >= 90)
    .reduce((sum, b) => sum + (b.minCount || 0), 0) || band90.length;
  const desired90 = { qb: 2, off: 4, def: 3, max: desired90Count };
  const promoteFromBand = (source, predicate) => {
    const idx = source.findIndex(predicate);
    if (idx === -1) return null;
    return source.splice(idx, 1)[0];
  };
  const demoteFromBand90 = (avoidPredicate) => {
    // drop lowest grade that is not needed for required counts
    const sorted = [...band90].sort((a, b) => (a.grade || 0) - (b.grade || 0));
    for (const p of sorted) {
      if (avoidPredicate && avoidPredicate(p)) continue;
      const idx = band90.findIndex(x => x.id === p.id);
      if (idx !== -1) return band90.splice(idx, 1)[0];
    }
    return null;
  };

  const countBand = (arr) => {
    let qb = 0, off = 0, def = 0;
    arr.forEach(p => {
      const g = getGroup(p);
      if (g === 'QB') qb++;
      if (isOffGroup(p)) off++;
      if (isDefGroup(p)) def++;
    });
    return { qb, off, def };
  };

  const ensure90 = () => {
    let counts = countBand(band90);
    // promote QBs to reach min 2
    while (counts.qb < desired90.qb) {
      const qb = promoteFromBand(band80, p => getGroup(p) === 'QB');
      if (!qb) break;
      const demote = demoteFromBand90(p => getGroup(p) === 'QB');
      if (demote) { band80.push(demote); }
      qb.grade = Math.max(90, Math.min(96, qb.grade || 90));
      band90.push(qb);
      counts = countBand(band90);
    }
    // promote offense to reach off min
    while (counts.off < desired90.off) {
      const off = promoteFromBand(band80, p => isOffGroup(p));
      if (!off) break;
      const demote = demoteFromBand90(p => isOffGroup(p) && countBand(band90).off <= desired90.off);
      if (demote) { demote.grade = Math.max(83, Math.min(89.9, demote.grade || 83)); band80.push(demote); }
      off.grade = Math.max(90, Math.min(95.5, off.grade || 90));
      band90.push(off);
      counts = countBand(band90);
    }
    // ensure defense at least def min
    while (counts.def < desired90.def) {
      const defc = promoteFromBand(band80, p => isDefGroup(p));
      if (!defc) break;
      const demote = demoteFromBand90(p => isDefGroup(p) && countBand(band90).def <= desired90.def);
      if (demote) { demote.grade = Math.max(83, Math.min(89.9, demote.grade || 83)); band80.push(demote); }
      defc.grade = Math.max(90, Math.min(95, defc.grade || 90));
      band90.push(defc);
      counts = countBand(band90);
    }
    // Trim to desired size if we overfilled
    if (band90.length > desired90.max) {
      const sorted = [...band90].sort((a, b) => (b.grade || 0) - (a.grade || 0));
      const keep = sorted.slice(0, desired90.max);
      const extra = sorted.slice(desired90.max);
      extra.forEach(p => {
        p.grade = Math.max(83, Math.min(89.9, p.grade || 83));
        band80.push(p);
      });
      band90 = keep;
    }
  };

  ensure90();

  // Ensure 80s off/def and QB count
  const ensure80 = () => {
    const total80 = band80.length;
    const desiredOff = Math.round(total80 * 0.6);
    const desiredDef = total80 - desiredOff;
    const qbMin = 4;
    const qbMax = 5;
    let counts = countBand(band80);
    // Promote QBs into 80s if needed (from others)
    while (counts.qb < qbMin) {
      const qb = promoteFromBand(others, p => getGroup(p) === 'QB');
      if (!qb) break;
      qb.grade = Math.max(80, Math.min(89.9, qb.grade || 80));
      band80.push(qb);
      counts = countBand(band80);
    }
    // Trim QBs if above max
    if (counts.qb > qbMax) {
      const sorted = band80.filter(p => getGroup(p) === 'QB').sort((a, b) => (a.grade || 0) - (b.grade || 0));
      while (counts.qb > qbMax && sorted.length) {
        const drop = sorted.shift();
        const idx = band80.findIndex(p => p.id === drop.id);
        if (idx !== -1) {
          band80.splice(idx, 1);
          others.push(drop);
          counts = countBand(band80);
        }
      }
    }
    // Adjust offense/defense ratio
    while (counts.off < desiredOff) {
      const cand = promoteFromBand(others, p => isOffGroup(p) || getGroup(p) === 'QB');
      if (!cand) break;
      cand.grade = Math.max(80, Math.min(89.9, cand.grade || 80));
      band80.push(cand);
      counts = countBand(band80);
    }
    while (counts.def < desiredDef) {
      const cand = promoteFromBand(others, p => isDefGroup(p));
      if (!cand) break;
      cand.grade = Math.max(80, Math.min(89.9, cand.grade || 80));
      band80.push(cand);
      counts = countBand(band80);
    }
    // If overfilled, demote lowest to others
    while (band80.length > total80 && band80.length > 0) {
      const lowIdx = band80.reduce((minIdx, p, i) => {
        const g = p.grade || 0;
        const minG = band80[minIdx]?.grade || Infinity;
        return g < minG ? i : minIdx;
      }, 0);
      const [drop] = band80.splice(lowIdx, 1);
      drop.grade = Math.max(70, Math.min(79.9, drop.grade || 70));
      others.push(drop);
      counts = countBand(band80);
    }
  };

  ensure80();

  // Recombine and resort
  const recombined = [...band90, ...band80, ...others].sort((a, b) => (b.grade || 0) - (a.grade || 0));
  return recombined.slice(0, 100);
}

function buildTop100(totals) {
  const sorted = Object.values(totals || {}).sort((a, b) => {
    const as = a.score !== undefined && a.score !== null ? a.score : 0;
    const bs = b.score !== undefined && b.score !== null ? b.score : 0;
    return bs - as;
  });
  const special = ['FB', 'K', 'P'];
  const includedSpecial = { FB: false, K: false, P: false };
  const final = [];
  const bestSpecial = {};
  sorted.forEach(p => {
    const pos = (p.position || '').toUpperCase();
    if (special.includes(pos) && !bestSpecial[pos]) bestSpecial[pos] = p;
    if (final.length >= 100) return;
    if (special.includes(pos)) {
      if (includedSpecial[pos]) return;
      includedSpecial[pos] = true;
      final.push(p);
      return;
    }
    final.push(p);
  });
  special.forEach(pos => {
    if (!includedSpecial[pos] && bestSpecial[pos] && final.length < 100) {
      final.push(bestSpecial[pos]);
    }
  });
  return final.slice(0, 100);
}

function buildPageEmbed(list, page, leagueId) {
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  const lines = slice.map((p, idx) => {
    const rank = start + idx + 1;
    return `${rank}. ${p.name} (${p.position}, ${p.team}) — ${p.score.toFixed(1)}`;
  });
  const embed = new EmbedBuilder()
    .setTitle('NFL Top 100')
    .setDescription(lines.join('\n') || 'No players available.')
    .setFooter({ text: `Page ${safePage}/${totalPages} • League ${leagueId}` });
  return { embed, totalPages, page: safePage };
}


async function updateTopPlayers(client, leagueId, snapshot, currentWeek, options = {}) {
  if (!snapshot || !currentWeek) return;
  // ...existing code for updateTopPlayers, as above, but without nested exports...
}

async function postTop100(client, leagueId, list, channelId) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    const { embed, totalPages, page } = buildPageEmbed(list, 1, leagueId);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_top100|prev|${page}|${totalPages}|${leagueId}`)
        .setLabel('Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`madden_top100|next|${page}|${totalPages}|${leagueId}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(totalPages <= 1)
    );
    await channel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('[top_players] Failed to post Top 100:', err);
  }
}

function getTop100Page(leagueId, page) {
  const state = loadJson(TOP_FILE, {});
  const list = state?.[leagueId]?.top100 || [];
  return buildPageEmbed(list, page, leagueId);
}

function computeGradeFromRank(rank, total) {
  const safeTotal = Math.max(1, total);
  const pct = 1 - (rank - 1) / safeTotal;
  if (rank === 1 && safeTotal >= 500000) return 99.9;
  let grade;
  if (pct >= 0.9999) {
    const span = (pct - 0.9999) / 0.0001;
    grade = 97.5 + 2.3 * Math.min(1, Math.max(0, span));
  } else if (pct >= 0.999) {
    const span = (pct - 0.999) / 0.0009;
    grade = 95 + 2.4 * Math.min(1, Math.max(0, span));
  } else if (pct >= 0.995) {
    const span = (pct - 0.995) / 0.004;
    grade = 92 + 2.9 * Math.min(1, Math.max(0, span));
  } else if (pct >= 0.97) {
    const span = (pct - 0.97) / 0.025;
    grade = 88 + 3.9 * Math.min(1, Math.max(0, span));
  } else {
    const span = pct / 0.97;
    grade = 60 + 27.9 * Math.min(1, Math.max(0, span));
  }
  return Number(Math.min(99.8, Math.max(60, grade)).toFixed(1));
}

export { computeWeeklyList, updateTopPlayers, getTop100Page, computeGradeFromRank };
