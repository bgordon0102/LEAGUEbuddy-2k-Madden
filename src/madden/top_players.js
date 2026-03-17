import path from 'path';
import fs from 'fs';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadJson, saveJson } from '../shared/json.js';
import { gatherWeeklyStats } from './awards.js';
import { getFullTeamName } from '../shared/madden_team_names.js';
import { loadLeagueSnapshot } from './madden_data.js';
import { getPinId, setPinId } from './pins_store.js';

const TOP_FILE = path.join(process.cwd(), 'data', 'madden', 'top_players.json');
const TOP_HISTORY_DIR = path.join(process.cwd(), 'data', 'madden', 'top_players_history');
const DEFAULT_POST_CHANNEL = '1462629502864851069';
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const TEAM_EMOJIS = loadJson(TEAM_EMOJIS_FILE, {});

function median(values = []) {
  const nums = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function countWeeklyPlayers(wk) {
  const buckets = [
    wk?.passing?.playerPassingStatInfoList,
    wk?.rushing?.playerRushingStatInfoList,
    wk?.receiving?.playerReceivingStatInfoList,
    wk?.defense?.playerDefensiveStatInfoList,
  ];
  return buckets.reduce((acc, bucket) => acc + (Array.isArray(bucket) ? bucket.length : 0), 0);
}

export function getLatestReliableRegularSeasonWeekIndex(snapshot, requestedWeekIndex = null) {
  const stageOneWeeks = (snapshot?.weeklyStats || [])
    .filter((entry) => Number(entry?.stage ?? entry?.stageIndex ?? 0) === 1)
    .map((entry) => ({
      weekIndex: Number(entry?.weekIndex),
      playerCount: countWeeklyPlayers(entry),
    }))
    .filter((entry) => Number.isFinite(entry.weekIndex) && entry.playerCount > 0)
    .sort((a, b) => a.weekIndex - b.weekIndex);

  if (!stageOneWeeks.length) return null;

  const cappedWeeks = requestedWeekIndex == null
    ? stageOneWeeks
    : stageOneWeeks.filter((entry) => entry.weekIndex <= Number(requestedWeekIndex));
  if (!cappedWeeks.length) return null;

  for (let idx = cappedWeeks.length - 1; idx >= 0; idx -= 1) {
    const entry = cappedWeeks[idx];
    const priorCounts = cappedWeeks
      .slice(0, idx)
      .map((value) => Number(value.playerCount || 0))
      .filter((value) => value > 0)
      .slice(-4);
    const recentMedianCount = median(priorCounts);
    const looksPartial =
      recentMedianCount > 0 &&
      Number(entry.playerCount || 0) < (recentMedianCount * 0.7) &&
      idx > 0;
    if (!looksPartial) return entry.weekIndex;
  }

  return cappedWeeks[cappedWeeks.length - 1]?.weekIndex ?? null;
}

function buildRichestPlayerEntries(snapshot) {
  const best = new Map();
  // Only lift non-stat metadata to avoid contaminating weekly numbers with other weeks.
  const liftMetadata = (entry) => {
    if (!entry) return null;
    const keep = ['fullName', 'displayName', 'position', 'playerBestOvr', 'playerSchemeOvr', 'yearsPro', 'isRookie', 'teamId'];
    const flat = {};
    keep.forEach(k => {
      if (entry[k] !== undefined && entry[k] !== null) flat[k] = entry[k];
    });
    return flat;
  };
  const consider = (list) => {
    (list || []).forEach(p => {
      const id = p.rosterId != null ? String(p.rosterId) : (p.fullName || `${p.teamId || ''}-${p.statId || ''}`);
      if (!id) return;
      const candidate = liftMetadata(p);
      if (!candidate) return;
      const richness = Object.keys(candidate).length;
      const stage = Number(p.stage ?? p.stageIndex ?? 0);
      const wk = Number(p.weekIndex ?? 0);
      const score = richness * 1000 + stage * 10 + wk; // prefer more fields, then higher stage, then later week
      const existing = best.get(id);
      const existingRichness = existing ? Object.keys(existing).length : 0;
      const existingScore = existing
        ? existingRichness * 1000
        + Number(existing.stage ?? existing.stageIndex ?? 0) * 10
        + Number(existing.weekIndex ?? 0)
        : -1;
      if (!existing || score > existingScore) {
        best.set(id, candidate);
      }
    });
  };
  (snapshot?.weeklyStats || []).forEach(wk => {
    consider(wk?.passing?.playerPassingStatInfoList);
    consider(wk?.rushing?.playerRushingStatInfoList);
    consider(wk?.receiving?.playerReceivingStatInfoList);
    consider(wk?.defense?.playerDefensiveStatInfoList);
    consider(wk?.kicking?.playerKickingStatInfoList);
    consider(wk?.punting?.playerPuntingStatInfoList);
    consider(wk?.playerTotals);
  });
  return best;
}

function enrichWeeklyWithRichest(weekly, richest) {
  const enrichList = (list) => {
    return (list || []).map(p => {
      const id = p.rosterId != null ? String(p.rosterId) : (p.fullName || `${p.teamId || ''}-${p.statId || ''}`);
      const rich = richest.get(id);
      return rich ? { ...p, ...rich } : p;
    });
  };
  if (weekly?.passing) weekly.passing.playerPassingStatInfoList = enrichList(weekly.passing.playerPassingStatInfoList);
  if (weekly?.rushing) weekly.rushing.playerRushingStatInfoList = enrichList(weekly.rushing.playerRushingStatInfoList);
  if (weekly?.receiving) weekly.receiving.playerReceivingStatInfoList = enrichList(weekly.receiving.playerReceivingStatInfoList);
  if (weekly?.defense) weekly.defense.playerDefensiveStatInfoList = enrichList(weekly.defense.playerDefensiveStatInfoList);
  if (weekly?.kicking) weekly.kicking.playerKickingStatInfoList = enrichList(weekly.kicking.playerKickingStatInfoList);
  if (weekly?.punting) weekly.punting.playerPuntingStatInfoList = enrichList(weekly.punting.playerPuntingStatInfoList);
  return weekly;
}

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
        yearsPro: pl.yearsPro,
        isRookie: pl.isRookie,
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
    const name = getFullTeamName(t, `Team ${t.teamId}`);
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
  let passScore = (t.passYds || 0) * 0.04 + (t.passTDs || 0) * 6 - (t.passInts || 0) * 4;
  // QB efficiency/volume kicker
  if (pos === 'QB') {
    const yds = t.passYds || 0;
    const tds = t.passTDs || 0;
    const ints = t.passInts || 0;
    const longPass = Number(t.passLongest || t.passLong || 0);
    const pass2pt = Number(t.passTwoPtMade || t.passTwoPt || 0);
    if (yds >= 350) passScore += 14;
    else if (yds >= 320) passScore += 10;
    else if (yds >= 300) passScore += 8;
    else if (yds >= 250) passScore += 4;
    else if (yds >= 200) passScore += 2;
    if (tds >= 4) passScore *= 1.25;
    else if (tds === 3) passScore *= 1.15;
    else if (tds === 2) passScore *= 1.05;
    if (ints === 0 && tds >= 2) passScore += 6; // clean sheet bonus
    if (ints >= 3) passScore -= 10;
    else if (ints === 2) passScore -= 6;
    if (longPass >= 60) passScore += 6;
    else if (longPass >= 45) passScore += 3;
    if (pass2pt > 0) passScore += pass2pt * 3;
  }
  const rushScore = (t.rushYds || 0) * 0.1 + (t.rushTDs || 0) * 6;
  const recScore = (t.recYds || 0) * 0.1 + (t.recTDs || 0) * 6;
  let base = 0;
  if (pos === 'QB') {
    const yds = t.passYds || 0;
    const tds = t.passTDs || 0;
    const ints = t.passInts || 0;
    const rYds = t.rushYds || 0;
    const rTds = t.rushTDs || 0;
    const rLong = Number(t.rushLongest || t.rushLong || 0);
    const rAtt = t.rushAtt || 0;
    base = passScore + rushScore;
    // Heavier QB scaling: reward volume/TDs, punish turnover-heavy or low-output games
    const yardBand =
      yds >= 350 ? 1.35 :
        yds >= 320 ? 1.25 :
          yds >= 280 ? 1.15 :
            yds >= 240 ? 1.05 :
              yds >= 200 ? 0.9 :
                yds >= 150 ? 0.7 : 0.55;
    const tdBand =
      tds >= 4 ? 1.35 :
        tds === 3 ? 1.2 :
          tds === 2 ? 1.05 :
            tds === 1 ? 0.9 : 0.7;
    const intBand =
      ints >= 4 ? 0.35 :
        ints === 3 ? 0.5 :
          ints === 2 ? 0.7 :
            ints === 1 ? 0.9 : 1.05; // slight bonus for clean game
    base = base * yardBand * tdBand * intBand - ints * 4;
    // QB rushing bonuses
    if (rYds >= 80) base += 12;
    else if (rYds >= 60) base += 8;
    else if (rYds >= 40) base += 5;
    else if (rYds >= 25) base += 3;
    if (rTds >= 2) base += 8;
    else if (rTds === 1) base += 4;
    if (rLong >= 40) base += 4;
    else if (rLong >= 25) base += 2;
    // Light penalty for no rushing threat on very high volume pass lines to keep balance
    if (rAtt === 0 && yds >= 325 && tds >= 3) base -= 2;
    // Extra floor drop for very low stat lines
    if (yds < 180 && tds <= 1) base *= 0.6;
    // QB efficiency bonuses
    const att = t.passAtt || 0;
    const ypa = att > 0 ? (t.passYds || 0) / att : 0;
    if (ypa >= 9.5) base += 10;
    else if (ypa >= 8.5) base += 6;
    const longPass = Number(t.passLongest || t.passLong || 0);
    if (longPass >= 45) base += 4;
    if (ints === 0 && tds >= 2) base += 8; // clean sheet bonus
    const totalYds = yds + rYds;
    const totalTDs = tds + rTds;
    if (totalTDs >= 7 && totalYds >= 400) {
      base = base * 1.22 + 20;
    } else if (totalTDs >= 6 && totalYds >= 380) {
      base = base * 1.16 + 16;
    } else if (totalTDs >= 5 && totalYds >= 330) {
      base = base * 1.10 + 10;
    } else if (totalTDs >= 4 && totalYds >= 325) {
      base = base * 1.05 + 6;
    }
  } else if (['HB', 'FB'].includes(pos)) {
    base = rushScore + recScore;
    // RB-specific rushing tiers
    const rushYds = t.rushYds || 0;
    const rushLong = Number(t.rushLongest || t.rushLong || 0);
    const broken = Number(t.rushBrokenTackles || 0);
    if (rushYds >= 200) {
      base = base * 1.22 + 22;
    } else if (rushYds >= 125) {
      base = base * 1.15 + 15;
    } else if (rushYds >= 100) {
      base = base * 1.10 + 10;
    } else if (rushYds >= 75) {
      base += 6;
    }
    // Long runs
    if (rushLong >= 60) base += 8;
    else if (rushLong >= 45) base += 5;
    else if (rushLong >= 30) base += 3;
    // Broken tackles
    if (broken >= 4) base += broken * 2 + 4;
    else if (broken > 0) base += broken * 1.5;
    // Receiving contribution for RBs
    const recYds = t.recYds || 0;
    const recTDs = t.recTDs || 0;
    const catches = t.recCatches || 0;
    if (recYds >= 75) base += 5;
    else if (recYds >= 50) base += 3;
    if (catches >= 6) base += 3;
    else if (catches >= 4) base += 2;
    if (recTDs >= 2) base += 4;
    else if (recTDs === 1) base += 2;
    // Monster RB lines: total yards + total TDs (rush + rec)
    const rbTotalYds = (t.rushYds || 0) + (t.recYds || 0);
    const rbTotalTDs = (t.rushTDs || 0) + (t.recTDs || 0);
    if (rbTotalTDs >= 5 && rbTotalYds >= 150) {
      base = base * 1.55 + 26;
    } else if (rbTotalTDs >= 4 && rbTotalYds >= 150) {
      base = base * 1.42 + 20;
    } else if (rbTotalTDs >= 3 && rbTotalYds >= 150) {
      base = base * 1.30 + 16;
    } else if (rbTotalTDs >= 3 && rbTotalYds >= 120) {
      base = base * 1.22 + 10;
    }
    if (rbTotalTDs >= 2 && rbTotalYds < 60) {
      base *= 0.48;
    } else if (rbTotalTDs >= 2 && rbTotalYds < 85) {
      base *= 0.66;
    } else if (rbTotalTDs >= 3 && rbTotalYds < 110) {
      base *= 0.74;
    }
  } else {
    base = recScore + rushScore;
  }
  // Skill position reception/yardage multipliers (WR/TE/RB/FB)
  const isSkill = ['WR', 'TE', 'HB', 'RB', 'FB', 'TB'].includes(pos);
  if (isSkill) {
    const catches = t.recCatches || 0;
    const recYds = t.recYds || 0;
    if (catches >= 10) base *= 1.42;
    else if (catches >= 8) base *= 1.26;
    else if (catches >= 5) base *= 1.16;
    if (recYds >= 200) base += 34;
    else if (recYds >= 175) base += 26;
    else if (recYds >= 150) base += 21;
    else if (recYds >= 125) base += 16;
    else if (recYds >= 100) base += 12;
    else if (recYds >= 75) base += 8;
    // Receiving TD multipliers for skill players
    const recTDs = t.recTDs || 0;
    if (recTDs >= 3 && recYds >= 100) base *= 1.28;
    else if (recTDs === 2 && recYds >= 70) base *= 1.20;
    if (recYds >= 175 || catches >= 10) base *= 1.16;
    else if (recYds >= 150 || catches >= 9) base *= 1.12;
    // Light boost for RBs hitting receiving marks
    if ((pos === 'HB' || pos === 'RB' || pos === 'FB' || pos === 'TB') && recYds >= 75) {
      base += 5;
      if (recTDs >= 1) base += 3;
    }
    // High-output skill line kicker to lift into 90s
    const totalYds = (t.recYds || 0) + (t.rushYds || 0) + (pos === 'QB' ? (t.passYds || 0) * 0.25 : 0);
    const totalTDs = (t.recTDs || 0) + (t.rushTDs || 0) + (pos === 'QB' ? (t.passTDs || 0) : 0);
    if (pos !== 'QB' && totalYds >= 200 && totalTDs >= 3) {
      base = base * 1.25 + 18;
    } else if (pos !== 'QB' && totalYds >= 175 && totalTDs >= 3) {
      base = base * 1.18 + 12;
    } else if (pos !== 'QB' && totalYds >= 150 && totalTDs >= 2) {
      base = base * 1.12 + 10;
    } else {
      // Retain lighter boost for solid lines
      if (totalYds >= 180 && totalTDs >= 2) {
        base *= 1.14;
        base += 5;
      } else if (totalYds >= 140 && totalTDs >= 2) {
        base *= 1.10;
        base += 3;
      } else if (totalYds >= 110 && totalTDs >= 2) {
        base *= 1.06;
        base += 2;
      }
    }
    // Skill TD/yard floors into 90s
    if (totalTDs >= 3 && totalYds >= 175) base = Math.max(base, base * 1.1 + 10);
    else if (totalTDs >= 2 && totalYds >= 150) base = Math.max(base, base * 1.05 + 6);
    // Extra lift for true high-impact skill lines (yards + TDs)
    if (totalYds >= 200 && totalTDs >= 3) {
      base *= 1.16;
      base += 6;
    } else if (totalYds >= 160 && totalTDs >= 3) {
      base *= 1.12;
      base += 4;
    }
    // WR/TE specific TD + yard explosions
    if (pos === 'WR' || pos === 'TE') {
      if (totalTDs >= 4 && totalYds >= 150) {
        base = base * 1.32 + 16;
      } else if (totalTDs >= 3 && totalYds >= 150) {
        base = base * 1.24 + 12;
      } else if (totalTDs >= 3 && totalYds >= 120) {
        base = base * 1.18 + 8;
      } else if (totalTDs >= 2 && totalYds >= 100) {
        base = base * 1.12 + 6;
      }
    }
    // TE-specific lift for lower-yardage multi-TD games
    if (pos === 'TE') {
      const totalYds = (t.recYds || 0) + (t.rushYds || 0);
      const totalTDs = (t.recTDs || 0) + (t.rushTDs || 0);
      if (totalTDs >= 3 && totalYds >= 100) {
        base = Math.max(base, base * 1.20 + 8);
      } else if (totalTDs >= 2 && totalYds >= 100) {
        base = Math.max(base, base * 1.14 + 6);
      } else if (totalTDs >= 2 && totalYds >= 75) {
        base = Math.max(base, base * 1.10 + 4);
      } else if (totalTDs >= 1 && totalYds >= 75) {
        base = Math.max(base, base + 3);
      }
    }
    if (pos !== 'QB' && totalTDs >= 2 && totalYds < 70) {
      base *= 0.62;
    } else if (pos !== 'QB' && totalTDs >= 2 && totalYds < 95) {
      base *= 0.78;
    }
  }
  // Offensive skill TD boost (QB/HB/RB/FB/WR/TE)
  const skillPositions = new Set(['QB', 'HB', 'RB', 'FB', 'WR', 'TE', 'TB']);
  const totalTDs = (t.passTDs || 0) + (t.rushTDs || 0) + (t.recTDs || 0);
  const totalSkillYds = (t.passYds || 0) + (t.rushYds || 0) + (t.recYds || 0);
  if (skillPositions.has(pos) && totalTDs >= 2) {
    if (pos === 'QB' || totalSkillYds >= 100) {
      base *= totalTDs >= 3 ? 1.12 : 1.08;
      if (totalTDs >= 3) base += 4;
    }
  }
  // Extra multiplier for multi-TD games (all skill positions including QBs)
  if (skillPositions.has(pos)) {
    if (totalTDs >= 4 && (pos === 'QB' || totalSkillYds >= 120)) {
      base = base * 1.18 + 6;
    } else if (totalTDs === 3 && (pos === 'QB' || totalSkillYds >= 100)) {
      base = base * 1.12 + 4;
    }
  }
  // High TD explosion boost for non-QB skill players
  if (isSkill && pos !== 'QB') {
    const skillYds = (t.rushYds || 0) + (t.recYds || 0);
    if (totalTDs >= 4 && skillYds >= 130) {
      base = base * 1.30 + 14;
    } else if (totalTDs >= 3 && skillYds >= 110) {
      base = base * 1.22 + 10;
    }
  }
  if (t.passYds > 350 || t.rushYds > 125 || t.recYds > 125) base += 3;
  return base + winBonus(p);
}

function scoreDefense(p) {
  const t = p.totals || {};
  let score = 0;
  const pos = (p.position || '').toUpperCase();
  const tackles = t.defTotalTackles || 0;
  const sacks = t.defSacks || 0;
  const tfl = t.defTacklesForLoss || 0;
  const ints = t.defInts || 0;
  const ff = t.defForcedFumbles || 0;
  const fr = t.defRecoveredFumbles || 0;
  const pd = t.defPassDeflections || 0;
  const td = t.defTDs || 0;

  // Tackle weight (slightly higher for interior/edge DL)
  const dlPositions = new Set(['LE', 'RE', 'LDE', 'RDE', 'DE', 'DT', 'EDGE', 'EDG', 'LEDGE', 'REDGE']);
  const tackleWeight = dlPositions.has(pos) ? 1.05 : 0.9;
  score += tackles * tackleWeight;
  const sackPositions = new Set(['LE', 'RE', 'LDE', 'RDE', 'DE', 'DT', 'EDGE', 'EDG', 'LEDGE', 'REDGE', 'WILL', 'MIKE', 'SAM', 'OLB', 'ILB']);
  const sackWeight = sackPositions.has(pos) ? 15.0 : 13.0;
  score += sacks * sackWeight; // heavier weight for sack leaders
  score += tfl * (dlPositions.has(pos) ? 9.0 : 7.0);
  const dbPositions = new Set(['CB', 'FS', 'SS']);
  const intWeight = dbPositions.has(pos) ? 22.0 : 16.0;
  score += ints * intWeight;
  score += ff * 12;
  score += fr * 8;
  const pdWeight = dbPositions.has(pos) ? 6.0 : 4.0;
  score += pd * pdWeight;
  score += td * 14;
  score += winBonus(p);
  const impact = sacks * 8 + tfl * 4 + ints * 10 + ff * 7 + fr * 5 + pd * 2 + td * 10;
  const impactCount = (t.defSacks || 0) + (t.defTacklesForLoss || 0) + (t.defInts || 0) + (t.defForcedFumbles || 0) +
    (t.defRecoveredFumbles || 0) + (t.defPassDeflections || 0) + (t.defTDs || 0);
  if (impact < 6 && tackles < 6) {
    // Light stat lines drop hard
    score *= 0.3;
  } else if (impactCount < 1) {
    // No impact plays at all: extra clamp
    score *= 0.25;
  } else {
    score *= 1 + Math.min(0.9, impact / 18);
  }
  // Sack leader boost for edges: if 2+ sacks, add a bonus
  const isEdgeRole = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes((p.position || '').toUpperCase());
  if (isEdgeRole && sacks >= 2) {
    score *= 1.22;
    score += 8; // extra bump
  }
  // Impact-count kicker: multi-impact games should vault the list
  if (impactCount >= 5) score *= 1.55;
  else if (impactCount >= 3) score *= 1.35;
  score *= 1.05; // modest defensive multiplier
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
  let score = 38;
  score += ypa * 1.35;
  score += passTDr * 180;
  score -= intRate * 120;
  score -= sackRate * 520;
  score += expPass * 2.5;
  score += ypc * 1.2;
  score += rushTDr * 135;
  score -= brokenRate * 260;
  score += expRun * 2.5;
  score += volume * 2.5;
  score *= (1 + 0.03 * winPct);
  return Math.max(40, Math.min(68, score));
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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(num, den) {
  return den ? num / den : 0;
}

function getPositionGroup(posRaw = '') {
  const pos = (posRaw || '').toUpperCase();
  if (pos === 'QB') return 'QB';
  if (['HB', 'RB', 'FB', 'TB'].includes(pos)) return 'RB';
  if (pos === 'WR') return 'WR';
  if (pos === 'TE') return 'TE';
  if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 'OL';
  if (['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes(pos) || /EDGE/.test(pos)) return 'EDG';
  if (['MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
  if (['CB', 'FS', 'SS'].includes(pos)) return 'DB';
  if (['K', 'P'].includes(pos)) return 'SPECIAL';
  return 'OTHER';
}

function getWeeklyParticipationBounds(player) {
  const pos = (player?.position || '').toUpperCase();
  const t = player?.totals || {};
  const passAtt = Number(t.passAtt || 0);
  const rushAtt = Number(t.rushAtt || 0);
  const recCatches = Number(t.recCatches || 0);
  const passYds = Number(t.passYds || 0);
  const rushYds = Number(t.rushYds || 0);
  const recYds = Number(t.recYds || 0);
  const passTDs = Number(t.passTDs || 0);
  const rushTDs = Number(t.rushTDs || 0);
  const recTDs = Number(t.recTDs || 0);
  const tackles = Number(t.defTotalTackles || 0);
  const sacks = Number(t.defSacks || 0);
  const ints = Number(t.defInts || 0);
  const pd = Number(t.defPassDeflections || 0);
  const ff = Number(t.defForcedFumbles || 0);
  const fr = Number(t.defRecoveredFumbles || 0);
  const tfl = Number(t.defTacklesForLoss || 0);
  const defTDs = Number(t.defTDs || 0);
  const offensiveTDs = passTDs + rushTDs + recTDs;
  const defensiveImpact = sacks + ints + pd + ff + fr + tfl + defTDs;

  const clampBand = (floor, ceiling) => ({
    floor,
    ceiling: Math.max(floor, ceiling),
  });

  if (pos === 'QB') {
    const actions = passAtt + rushAtt;
    const totalYds = passYds + rushYds;
    if (actions <= 2 && totalYds < 25 && offensiveTDs === 0) return clampBand(45, 50);
    if (actions < 10 && totalYds < 140 && offensiveTDs <= 1) return clampBand(40, 66);
    if (actions < 18 && totalYds < 220 && offensiveTDs <= 1) return clampBand(40, 76);
    return clampBand(40, 99.8);
  }

  if (['HB', 'RB', 'FB', 'TB'].includes(pos)) {
    const touches = rushAtt + recCatches;
    const totalYds = rushYds + recYds;
    if (touches === 0 && totalYds === 0 && offensiveTDs === 0) return clampBand(45, 50);
    if (touches < 5 && totalYds < 45 && offensiveTDs === 0) return clampBand(40, 60);
    if (touches < 8 && totalYds < 75 && offensiveTDs <= 1) return clampBand(40, 72);
    return clampBand(40, 99.8);
  }

  if (['WR', 'TE'].includes(pos)) {
    const touches = recCatches + rushAtt;
    const totalYds = rushYds + recYds;
    if (touches === 0 && totalYds === 0 && offensiveTDs === 0) return clampBand(45, 50);
    if (touches < 3 && totalYds < 40 && offensiveTDs === 0) return clampBand(40, 58);
    if (touches < 5 && totalYds < 70 && offensiveTDs <= 1) return clampBand(40, 70);
    return clampBand(40, 99.8);
  }

  if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) {
    return clampBand(45, 92);
  }

  const isDefense = !['QB', 'HB', 'RB', 'FB', 'TB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P'].includes(pos);
  if (isDefense) {
    if (tackles <= 1 && defensiveImpact === 0) return clampBand(45, 50);
    if (tackles < 4 && defensiveImpact === 0) return clampBand(40, 60);
    if (tackles < 6 && defensiveImpact < 2) return clampBand(40, 72);
    return clampBand(40, 99.8);
  }

  return clampBand(40, 99.8);
}

function gradeWeeklyPool(list = []) {
  if (!Array.isArray(list) || !list.length) return [];
  const ordered = [...list].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  const scoreValues = ordered
    .map((p) => Number(p.score || 0))
    .filter((score) => Number.isFinite(score));
  const topScore = scoreValues.length ? Math.max(...scoreValues) : 0;
  const bottomScore = scoreValues.length ? Math.min(...scoreValues) : 0;
  const scoreSpan = Math.max(1, topScore - bottomScore);

  return ordered.map((p, idx, arr) => {
    const score = Number(p.score || 0);
    const scoreNorm = Math.min(1, Math.max(0, (score - bottomScore) / scoreSpan));
    const rankNorm = arr.length <= 1 ? 1 : 1 - (idx / (arr.length - 1));
    const { floor, ceiling } = getWeeklyParticipationBounds(p);
    return {
      ...p,
      weeklyGrade: computePffStyleGrade(scoreNorm, rankNorm, {
        min: floor,
        max: Math.min(97.8, ceiling),
        scoreWeight: 0.62,
        rankWeight: 0.38,
        rankPower: 0.76,
        eliteFloor: 0.93,
        eliteBump: 1.5,
      }),
    };
  });
}

function computePffStyleGrade(scoreNorm, rankNorm, opts = {}) {
  const min = opts.min ?? 69;
  const max = opts.max ?? 97.5;
  const scoreWeight = opts.scoreWeight ?? 0.7;
  const rankWeight = opts.rankWeight ?? 0.3;
  const rankPower = opts.rankPower ?? 0.68;
  const eliteFloor = opts.eliteFloor ?? 0.95;
  const eliteBump = opts.eliteBump ?? 1.2;
  const shapedRank = Math.pow(clamp(rankNorm, 0, 1), rankPower);
  const blended = clamp(scoreNorm, 0, 1) * scoreWeight + shapedRank * rankWeight;
  let grade = min + blended * (max - min);
  if (scoreNorm >= eliteFloor) {
    grade += ((scoreNorm - eliteFloor) / Math.max(0.0001, 1 - eliteFloor)) * eliteBump;
  }
  return Number(clamp(grade, min, max).toFixed(1));
}

function gradePublishedTop100(list = []) {
  if (!Array.isArray(list) || !list.length) return [];
  const ordered = [...list].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  const scores = ordered.map((p) => Number(p?.score || 0)).filter((v) => Number.isFinite(v));
  const topScore = scores.length ? Math.max(...scores) : 0;
  const bottomScore = scores.length ? Math.min(...scores) : 0;
  const span = Math.max(1, topScore - bottomScore);

  return ordered.map((p, idx, arr) => {
    const score = Number(p?.score || 0);
    const scoreNorm = clamp((score - bottomScore) / span, 0, 1);
    const rankNorm = arr.length <= 1 ? 1 : 1 - (idx / (arr.length - 1));
    const min = idx < 10 ? 84 : idx < 25 ? 80 : idx < 50 ? 76 : 72;
    return {
      ...p,
      grade: computePffStyleGrade(scoreNorm, rankNorm, {
        min,
        max: 97.8,
        scoreWeight: 0.68,
        rankWeight: 0.32,
        rankPower: 0.60,
        eliteFloor: 0.88,
        eliteBump: 2.2,
      }),
    };
  });
}

function computeWeeklyList(snapshot, weekIndex) {
  const weekly = gatherWeeklyStats(snapshot, weekIndex);
  if (!weekly) return [];
  const confMap = conferenceMap(snapshot);
  const teamMap = teamNameMap(snapshot);
  const winMap = winPctMap(snapshot);
  const defAllow = teamDefenseAllowMap(weekly);
  const rosterLookup = buildRosterLookup(snapshot);
  const richestEntries = buildRichestPlayerEntries(snapshot);
  enrichWeeklyWithRichest(weekly, richestEntries);
  const teamStats = aggregateTeamOffense(weekly);
  const players = mergePlayerStats(weekly);
  const rawList = [];
  const isOffPos = (pos) => ['QB', 'HB', 'RB', 'TB', 'WR', 'TE', 'FB', 'LT', 'LG', 'C', 'RG', 'RT', 'K', 'P'].includes(pos);
  const teamDefenseTotals = new Map();

  players.forEach((p) => {
    const rosterEntry = rosterLookup.get(p.rosterId);
    const pos = (p.position || rosterEntry?.position || 'UNK').toString().trim().toUpperCase();
    if (isOffPos(pos)) return;
    const t = p.totals || {};
    const teamId = Number(p.teamId);
    const cur = teamDefenseTotals.get(teamId) || {
      tackles: 0,
      sacks: 0,
      tfl: 0,
      ints: 0,
      ff: 0,
      fr: 0,
      pd: 0,
      td: 0,
      impact: 0,
    };
    cur.tackles += Number(t.defTotalTackles || 0);
    cur.sacks += Number(t.defSacks || 0);
    cur.tfl += Number(t.defTacklesForLoss || 0);
    cur.ints += Number(t.defInts || 0);
    cur.ff += Number(t.defForcedFumbles || 0);
    cur.fr += Number(t.defRecoveredFumbles || 0);
    cur.pd += Number(t.defPassDeflections || 0);
    cur.td += Number(t.defTDs || 0);
    cur.impact += Number(t.defSacks || 0) * 7
      + Number(t.defTacklesForLoss || 0) * 3
      + Number(t.defInts || 0) * 9
      + Number(t.defForcedFumbles || 0) * 6
      + Number(t.defRecoveredFumbles || 0) * 4
      + Number(t.defPassDeflections || 0) * 2
      + Number(t.defTDs || 0) * 10;
    teamDefenseTotals.set(teamId, cur);
  });

  for (const p of players.values()) {
    const rosterEntry = rosterLookup.get(p.rosterId);
    const pos = (p.position || rosterEntry?.position || 'UNK').toString().trim().toUpperCase();
    const isDefense = ['CB', 'FS', 'SS', 'ROLB', 'LOLB', 'MLB', 'LB', 'RE', 'LE', 'DT'].includes(pos);
    if (isDefense ? !hasEligibleDefenseStats(p) : !hasEligibleOffenseStats(p)) {
      continue;
    }
    const t = p.totals || {};
    const teamId = Number(p.teamId);
    const teamOff = teamStats.get(teamId) || {};
    const teamDef = teamDefenseTotals.get(teamId) || {};
    const allow = defAllow.get(teamId) || {};
    let baseScore = isDefense ? scoreDefense(p) : scoreOffense(p);
    let contextScore = 0;
    let efficiencyScore = 0;
    let usageScore = 0;

    if (isDefense) {
      const impact = Number(t.defSacks || 0) * 7
        + Number(t.defTacklesForLoss || 0) * 3
        + Number(t.defInts || 0) * 9
        + Number(t.defForcedFumbles || 0) * 6
        + Number(t.defRecoveredFumbles || 0) * 4
        + Number(t.defPassDeflections || 0) * 2
        + Number(t.defTDs || 0) * 10;
      const impactShare = safeDiv(impact, teamDef.impact || 0);
      const tackleShare = safeDiv(Number(t.defTotalTackles || 0), teamDef.tackles || 0);
      usageScore += impactShare * 22 + tackleShare * 8;
      efficiencyScore += Number(t.defSacks || 0) * 3.5 + Number(t.defInts || 0) * 4.5 + Number(t.defPassDeflections || 0) * 1.4;
      if ((allow.defPts || 99) <= 17) contextScore += 5;
      else if ((allow.defPts || 99) <= 21) contextScore += 3;
      if ((allow.defYds || 999) <= 300) contextScore += 3;
      else if ((allow.defYds || 999) <= 340) contextScore += 1.5;
      const impactCount = Number(t.defSacks || 0) + Number(t.defTacklesForLoss || 0) + Number(t.defInts || 0)
        + Number(t.defForcedFumbles || 0) + Number(t.defRecoveredFumbles || 0) + Number(t.defPassDeflections || 0) + Number(t.defTDs || 0);
      if (impactCount < 1 && Number(t.defTotalTackles || 0) < 5) {
        baseScore *= 0.45;
      }
    } else if (pos === 'QB') {
      const passYds = Number(t.passYds || 0);
      const passTDs = Number(t.passTDs || 0);
      const passInts = Number(t.passInts || 0);
      const passAtt = Number(t.passAtt || 0);
      const rushYds = Number(t.rushYds || 0);
      const ypa = safeDiv(passYds, passAtt);
      usageScore += safeDiv(passYds, teamOff.passYds || 0) * 18;
      usageScore += clamp((passYds - 235) * 0.04, -2, 12);
      efficiencyScore += clamp((ypa - 7.0) * 5.2, -8, 14);
      efficiencyScore += clamp((passTDs - passInts) * 2.0, -8, 15);
      efficiencyScore += clamp((rushYds - 20) * 0.08, -2, 5);
      if (passYds >= 275) contextScore += 3;
      if (passYds >= 325) contextScore += 4;
      if (passTDs >= 3) contextScore += 4;
      if (passTDs >= 4) contextScore += 3;
      if (passInts === 0 && passTDs >= 2 && passYds >= 250) contextScore += 4;
      else if (passInts <= 1 && passTDs >= 3) contextScore += 2;
    } else if (['HB', 'RB', 'FB', 'TB'].includes(pos)) {
      const rushYds = Number(t.rushYds || 0);
      const rushAtt = Number(t.rushAtt || 0);
      const recYds = Number(t.recYds || 0);
      usageScore += safeDiv(rushYds, teamOff.rushYds || 0) * 16;
      usageScore += safeDiv(recYds, teamOff.passYds || 0) * 6;
      efficiencyScore += clamp((safeDiv(rushYds, rushAtt) - 4.1) * 5, -6, 10);
      efficiencyScore += clamp((rushYds + recYds - 90) * 0.06, -3, 8);
    } else if (['WR', 'TE'].includes(pos)) {
      const recYds = Number(t.recYds || 0);
      const recCatches = Number(t.recCatches || 0);
      const recTDs = Number(t.recTDs || 0);
      usageScore += safeDiv(recYds, teamOff.passYds || 0) * 22;
      usageScore += safeDiv(recCatches, Math.max(1, teamOff.passAtt || 0)) * 18;
      efficiencyScore += clamp((safeDiv(recYds, recCatches) - 10.5) * 2.5, -4, 10);
      efficiencyScore += recTDs * 1.8;
    }

    const winPct = (winMap[p.teamId] !== undefined && winMap[p.teamId] !== null) ? winMap[p.teamId] : 0.5;
    const ovr = Number(p.playerBestOvr || p.playerSchemeOvr || p.ovr || rosterEntry?.playerBestOvr || 0);
    const qualityScore = clamp((ovr - 78) * 0.35, -4, 7);
    let score = baseScore + usageScore + efficiencyScore + contextScore + qualityScore + (winPct * 5.5);
    if (!isDefense) {
      const totalSkillYds = Number(t.passYds || 0) + Number(t.rushYds || 0) + Number(t.recYds || 0);
      const totalSkillTDs = Number(t.passTDs || 0) + Number(t.rushTDs || 0) + Number(t.recTDs || 0);
      if (pos === 'QB') {
        if (totalSkillTDs >= 7 && totalSkillYds >= 400) score += 26;
        else if (totalSkillTDs >= 6 && totalSkillYds >= 360) score += 20;
        else if (totalSkillTDs >= 5 && totalSkillYds >= 325) score += 13;
      } else {
        const scrimYds = Number(t.rushYds || 0) + Number(t.recYds || 0);
        if (totalSkillTDs >= 2 && scrimYds < 60) score *= 0.32;
        else if (totalSkillTDs >= 2 && scrimYds < 85) score *= 0.50;
        else if (totalSkillTDs >= 3 && scrimYds < 110) score *= 0.62;
      }
    }
    const rosterInfo = rosterEntry || rosterLookup.get(p.rosterId);
    const yearsPro = rosterInfo?.yearsPro ?? p.yearsPro;
    const isRookie = yearsPro !== undefined && yearsPro !== null ? Number(yearsPro) === 0 : (p.isRookie ?? undefined);
    const common = {
      id: p.rosterId || `${p.fullName}-${p.teamId || ''}`,
      rosterId: p.rosterId,
      name: (rosterInfo?.fullName) || p.fullName || p.displayName || 'Unknown',
      position: (rosterInfo?.position || pos || 'UNK').toUpperCase(),
      displayPos: (rosterInfo?.position || pos || 'UNK').toUpperCase(),
      totals: p.totals || {},
      teamId: p.teamId,
      team: teamMap[p.teamId] || 'Unknown Team',
      conference: confMap[p.teamId] || 'Unknown',
      statLine: formatLine(p),
      winPct,
      ovr,
      yearsPro: yearsPro,
      isRookie: isRookie
    };
    rawList.push({ ...common, score });
  }

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
    const baseOlScore = computeOlTeamScore(teamStat, winPct) + (winPct * 2);
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
      const maxCap = (pos === 'LT' || pos === 'RT') ? 62 : 59;
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
      .slice(0, 2);
    starters.forEach((entry, idx) => {
      const { pl, playerScore } = entry;
      const pos = pl.position;
      const finalScore = Math.max(28, playerScore - idx * 3);
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
  rawList.sort((a, b) => (b.score || 0) - (a.score || 0));
  const gradedPool = gradeWeeklyPool(rawList);
  const groupMin = { QB: 4, RB: 6, WR: 12, TE: 4, OL: 6, EDG: 8, LB: 8, DB: 12 };
  const groupCap = { QB: 12, RB: 14, WR: 24, TE: 8, OL: 10, EDG: 16, LB: 16, DB: 24, SPECIAL: 4, OTHER: 8 };
  const grouped = new Map();
  gradedPool.forEach((p) => {
    const group = getPositionGroup(p.position);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(p);
  });
  grouped.forEach((list) => list.sort((a, b) => (b.score || 0) - (a.score || 0)));

  const selected = [];
  const used = new Set();
  const capCount = {};
  const addPlayer = (p, capMap = groupCap) => {
    const id = p.id || `${p.name}-${p.teamId || ''}`;
    if (used.has(id)) return false;
    const group = getPositionGroup(p.position);
    if ((capCount[group] || 0) >= (capMap[group] ?? 100)) return false;
    used.add(id);
    capCount[group] = (capCount[group] || 0) + 1;
    selected.push(p);
    return true;
  };

  Object.entries(groupMin).forEach(([group, minCount]) => {
    const list = grouped.get(group) || [];
    for (let i = 0; i < list.length && (capCount[group] || 0) < minCount; i += 1) {
      addPlayer(list[i]);
    }
  });
  for (const p of gradedPool) {
    if (selected.length >= 100) break;
    addPlayer(p);
  }
  if (selected.length < 100) {
    for (const p of gradedPool) {
      const id = p.id || `${p.name}-${p.teamId || ''}`;
      if (used.has(id)) continue;
      used.add(id);
      selected.push(p);
      if (selected.length >= 100) break;
    }
  }

  // Position balancing can add players in group-order; resort before grading so
  // weekly grades follow actual performance, not insertion order.
  selected.sort((a, b) => {
    const as = Number(a?.score || 0);
    const bs = Number(b?.score || 0);
    return bs - as;
  });

  const rescaled = gradePublishedTop100(selected.slice(0, 100));
  if (process.env.MOCK_DEBUG) {
    const posTop = {}; rescaled.forEach(p => { posTop[p.position] = (posTop[p.position] || 0) + 1; });
    console.log('[top_players] post-balance counts', posTop);
    console.log('[top_players] top/bottom grades', rescaled[0]?.grade, rescaled[rescaled.length - 1]?.grade);
  }
  return { top100: rescaled, allGraded: gradedPool };
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

function saveWeeklyAll(leagueId, weekIndex, list) {
  const dir = path.join(TOP_HISTORY_DIR, leagueId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `week-${weekIndex}-all.json`);
  const payload = {
    leagueId,
    weekIndex,
    generatedAt: new Date().toISOString(),
    players: list
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function saveWeeklyTop(leagueId, weekIndex, list) {
  const dir = path.join(TOP_HISTORY_DIR, leagueId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `week-${weekIndex}-top.json`);
  const payload = {
    leagueId,
    weekIndex,
    generatedAt: new Date().toISOString(),
    top100: list
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function loadWeeklyHistory(leagueId) {
  let dir = path.join(TOP_HISTORY_DIR, leagueId);
  if (!fs.existsSync(dir)) {
    const alt = path.join(TOP_HISTORY_DIR, `${leagueId}.json`);
    if (fs.existsSync(alt)) dir = alt;
  }
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const byWeek = new Map();
  files.forEach(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const players = data?.players || data?.top100;
      if (Array.isArray(players)) {
        const weekIndex = Number(data.weekIndex);
        const sourceType = /-all\.json$/i.test(f) || Array.isArray(data?.players) ? 'all' : 'top';
        const priority = sourceType === 'all' ? 2 : 1;
        const sortedPlayers = players
          .slice()
          .sort((a, b) => {
            const as = Number(a?.score ?? a?.grade ?? a?.seasonScore ?? 0);
            const bs = Number(b?.score ?? b?.grade ?? b?.seasonScore ?? 0);
            return bs - as;
          });
        const existing = byWeek.get(weekIndex);
        if (!existing || priority > existing._priority) {
          byWeek.set(weekIndex, {
            ...data,
            weekIndex,
            players: sortedPlayers,
            top100: sortedPlayers.slice(0, 100),
            sourceType,
            _priority: priority,
          });
        }
      }
    } catch { }
  });
  const history = Array.from(byWeek.values()).map(({ _priority, ...entry }) => entry);
  history.sort((a, b) => (Number(a.weekIndex) || 0) - (Number(b.weekIndex) || 0));
  return history;
}

function buildSeasonHistoryFromSnapshot(leagueId) {
  let snapshot;
  try {
    snapshot = loadLeagueSnapshot(leagueId);
  } catch {
    return [];
  }
  const stageOneWeeks = (snapshot?.weeklyStats || [])
    .filter((entry) => Number(entry?.stage ?? entry?.stageIndex ?? 0) === 1)
    .map((entry) => Number(entry?.weekIndex))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const uniqueWeeks = [...new Set(stageOneWeeks)];
  const history = [];
  for (const weekIndex of uniqueWeeks) {
    try {
      const weekly = computeWeeklyList(snapshot, weekIndex);
      const players = Array.isArray(weekly?.allGraded) && weekly.allGraded.length
        ? weekly.allGraded
        : Array.isArray(weekly?.top100)
          ? weekly.top100
          : Array.isArray(weekly)
            ? weekly
            : [];
      if (!players.length) continue;
      history.push({
        weekIndex,
        players: players
          .slice()
          .sort((a, b) => Number(b?.score ?? b?.grade ?? 0) - Number(a?.score ?? a?.grade ?? 0)),
        sourceType: 'snapshot',
      });
    } catch {
      // ignore week-level compute failures and keep building from the remaining weeks
    }
  }
  return history;
}

function topOffSeasonListFromRoster(snapshot, currentTop = [], targetCount = 100) {
  if (!snapshot || currentTop.length >= targetCount) return currentTop;
  const existingIds = new Set(currentTop.map((p) => String(p.id || `${p.name}-${p.teamId || ''}`)));
  const teamNames = teamNameMap(snapshot);
  const groupCounts = {};
  currentTop.forEach((p) => {
    const group = getPositionGroup(p.position);
    groupCounts[group] = (groupCounts[group] || 0) + 1;
  });
  const capMap = { QB: 10, RB: 14, WR: 22, TE: 8, OL: 14, EDG: 18, LB: 16, DB: 22, SPECIAL: 4, OTHER: 12 };
  const rosterPool = [];
  const teams = snapshot?.rosters?.teams || {};
  Object.entries(teams).forEach(([teamId, team]) => {
    (team?.rosterInfoList || []).forEach((player) => {
      const id = String(player?.rosterId || player?.playerId || player?.esnId || `${player?.firstName || ''}-${player?.lastName || ''}-${teamId}`);
      if (!id || existingIds.has(id)) return;
      const name = `${player?.firstName || ''} ${player?.lastName || ''}`.trim() || player?.displayName || player?.name || 'Unknown Player';
      const position = String(player?.position || '').toUpperCase() || 'UNK';
      const ovr = Number(player?.playerBestOvr || player?.playerSchemeOvr || player?.overall || 0);
      rosterPool.push({
        id,
        name,
        position,
        teamId: Number(teamId),
        team: teamNames[teamId] || `Team ${teamId}`,
        seasonScore: Number((40 + ovr * 0.6).toFixed(3)),
        seasonGrade: Number(Math.max(72, Math.min(84.5, ovr * 0.92)).toFixed(2)),
        avgGrade: Number(Math.max(72, Math.min(84.5, ovr * 0.92)).toFixed(2)),
        appearances: 0,
        weeks90: 0,
        weeks80: 0,
        streak90: 0,
        streak80: 0,
        streak: 0,
        bestRank: 999,
        injuryHits: 0,
        winPct: 0.5,
      });
    });
  });
  rosterPool.sort((a, b) => Number(b.seasonScore || 0) - Number(a.seasonScore || 0));

  for (const player of rosterPool) {
    if (currentTop.length >= targetCount) break;
    const group = getPositionGroup(player.position);
    if ((groupCounts[group] || 0) >= (capMap[group] ?? 100)) continue;
    existingIds.add(player.id);
    groupCounts[group] = (groupCounts[group] || 0) + 1;
    currentTop.push(player);
  }
  for (const player of rosterPool) {
    if (currentTop.length >= targetCount) break;
    if (existingIds.has(player.id)) continue;
    existingIds.add(player.id);
    currentTop.push(player);
  }
  return currentTop.slice(0, targetCount);
}

function computeSeasonTop100FromEntries(history = []) {
  if (!history.length) return [];
  const agg = new Map(); // id -> data
  history.forEach(entry => {
    const week = Number(entry.weekIndex);
    (entry.players || entry.top100 || []).forEach((p, idx) => {
      const id = p.id || `${p.name}-${p.teamId || ''}`;
      const getVal = (obj, keys) => {
        for (const k of keys) {
          if (obj && obj[k] !== undefined && obj[k] !== null) return Number(obj[k]);
        }
        return 0;
      };
      const rushYds = getVal(p, ['rushYds', 'rushingYds']) || getVal(p.totals || {}, ['rushYds', 'rushingYds']);
      const rushAtt = getVal(p, ['rushAtt', 'rushingAtt', 'rushAttempts']) || getVal(p.totals || {}, ['rushAtt', 'rushingAtt', 'rushAttempts']);
      const rushTDs = getVal(p, ['rushTDs', 'rushingTDs']) || getVal(p.totals || {}, ['rushTDs', 'rushingTDs']);
      const recYds = getVal(p, ['recYds', 'receivingYds']) || getVal(p.totals || {}, ['recYds', 'receivingYds']);
      const recTDs = getVal(p, ['recTDs', 'receivingTDs']) || getVal(p.totals || {}, ['recTDs', 'receivingTDs']);
      const targets = getVal(p, ['recTgt', 'targets', 'recTargets']) || getVal(p.totals || {}, ['recTgt', 'targets', 'recTargets']);
      const passYds = getVal(p, ['passYds', 'passingYds']) || getVal(p.totals || {}, ['passYds', 'passingYds']);
      const passTDs = getVal(p, ['passTDs', 'passingTDs']) || getVal(p.totals || {}, ['passTDs', 'passingTDs']);
      const passInts = getVal(p, ['passInts', 'passingInts']) || getVal(p.totals || {}, ['passInts', 'passingInts']);
      const sacks = getVal(p, ['defSacks', 'sacks']) || getVal(p.totals || {}, ['defSacks', 'sacks']);
      const tfl = getVal(p, ['defTacklesForLoss', 'tfl']) || getVal(p.totals || {}, ['defTacklesForLoss', 'tfl']);
      const tackles = getVal(p, ['defTotalTackles', 'defTackles']) || getVal(p.totals || {}, ['defTotalTackles', 'defTackles']);
      const ints = getVal(p, ['defInts', 'ints']) || getVal(p.totals || {}, ['defInts', 'ints']);
      const pd = getVal(p, ['defPassDeflections', 'defPD', 'pd']) || getVal(p.totals || {}, ['defPassDeflections', 'defPD', 'pd']);
      const cur = agg.get(id) || {
        id,
        name: p.name,
        position: p.position || p.displayPos || 'UNK',
        team: p.team,
        teamId: p.teamId,
        grades: [],
        appearances: 0,
        weeks: [],
        bestRank: 999,
        winPctSum: 0,
        winPctCount: 0,
        injuryHits: 0,
        passYds: 0,
        passTDs: 0,
        passInts: 0,
        rushYds: 0,
        rushAtt: 0,
        rushTDs: 0,
        recYds: 0,
        recTDs: 0,
        targets: 0,
        sacks: 0,
        tfl: 0,
        tackles: 0,
        ints: 0,
        pd: 0,
      };
      cur.grades.push(Number(p.grade || 0));
      cur.appearances += 1;
      cur.weeks.push(week);
      cur.bestRank = Math.min(cur.bestRank, idx + 1);
      if (p.winPct !== undefined && p.winPct !== null) {
        cur.winPctSum += Number(p.winPct);
        cur.winPctCount += 1;
      }
      if (p.injuryStatus) cur.injuryHits += 1;
      cur.passYds += passYds;
      cur.passTDs += passTDs;
      cur.passInts += passInts;
      cur.rushYds += rushYds;
      cur.rushAtt += rushAtt;
      cur.rushTDs += rushTDs;
      cur.recYds += recYds;
      cur.recTDs += recTDs;
      cur.targets += targets;
      cur.sacks += sacks;
      cur.tfl += tfl;
      cur.tackles += tackles;
      cur.ints += ints;
      cur.pd += pd;
      agg.set(id, cur);
    });
  });

  // compute streaks
  agg.forEach(v => {
    const sortedWeeks = [...new Set(v.weeks)].sort((a, b) => a - b);
    let longest = 0;
    let current = 0;
    let prev = null;
    sortedWeeks.forEach(w => {
      if (prev !== null && w === prev + 1) current += 1;
      else current = 1;
      longest = Math.max(longest, current);
      prev = w;
    });
    v.streak = longest;
    // streaks/occurrences for 90+ and 80+
    const weekGradeMap = new Map();
    v.weeks.forEach((w, i) => {
      if (!weekGradeMap.has(w)) weekGradeMap.set(w, []);
      weekGradeMap.get(w).push(v.grades[i] || 0);
    });
    const weeklyMax = Array.from(weekGradeMap.entries()).map(([w, arr]) => ({
      week: w,
      grade: Math.max(...arr)
    })).sort((a, b) => a.week - b.week);
    v.weeks90 = weeklyMax.filter(x => x.grade >= 90).length;
    v.weeks80 = weeklyMax.filter(x => x.grade >= 80).length;
    let curr90 = 0, best90 = 0;
    let curr80 = 0, best80 = 0;
    let prevWeek = null;
    weeklyMax.forEach(x => {
      const consecutive = prevWeek !== null && x.week === prevWeek + 1;
      if (x.grade >= 90) {
        curr90 = consecutive ? curr90 + 1 : 1;
        best90 = Math.max(best90, curr90);
      } else {
        curr90 = 0;
      }
      if (x.grade >= 80) {
        curr80 = consecutive ? curr80 + 1 : 1;
        best80 = Math.max(best80, curr80);
      } else {
        curr80 = 0;
      }
      prevWeek = x.week;
    });
    v.streak90 = best90;
    v.streak80 = best80;
  });

  const getUsageGate = (v) => {
    const pos = (v.position || '').toUpperCase();
    if (['HB', 'RB', 'FB'].includes(pos)) {
      return (v.rushAtt || 0) >= 60 || (v.rushYds || 0) >= 400;
    }
    if (['WR', 'TE'].includes(pos)) {
      return (v.targets || 0) >= 30 || (v.recYds || 0) >= 400;
    }
    if (['REDGE', 'LEDGE', 'EDGE', 'DE', 'DL', 'DT'].includes(pos)) {
      return v.appearances >= 5 && ((v.sacks || 0) + (v.tfl || 0)) >= 5;
    }
    if (['MIKE', 'WILL', 'SAM', 'LB'].includes(pos)) {
      return v.appearances >= 5 && (v.tackles || 0) >= 40;
    }
    if (['CB', 'FS', 'SS', 'S'].includes(pos)) {
      return v.appearances >= 5 && (((v.pd || 0) + (v.ints || 0)) >= 4 || (v.tackles || 0) >= 30);
    }
    return true;
  };

  const seasonList = [];
  const fallbackList = [];
  agg.forEach(v => {
    const avgGrade = v.grades.reduce((a, b) => a + b, 0) / Math.max(1, v.grades.length);
    const peakGrade = Math.max(...v.grades, avgGrade);
    const winPctAvg = v.winPctCount ? (v.winPctSum / v.winPctCount) : 0.5;
    const variance = (() => {
      const mean = avgGrade;
      const varSum = v.grades.reduce((acc, g) => acc + Math.pow(g - mean, 2), 0);
      return varSum / Math.max(1, v.grades.length);
    })();
    const std = Math.sqrt(variance);
    const rankBonus = ((101 - Math.min(100, v.bestRank || 100)) / 100) * 6;
    const appearanceBonus = Math.min(10, v.appearances * 0.9);
    const posGroup = getPositionGroup(v.position);
    const productionBonus = (() => {
      if (posGroup === 'QB') {
        const passEfficiency = v.passTDs >= 1 ? (v.passTDs / Math.max(1, v.passInts + 1)) : 0;
        return clamp(
          v.passYds / 260
          + v.passTDs * 2.2
          - v.passInts * 0.7
          + passEfficiency * 1.2,
          0,
          24
        );
      }
      if (posGroup === 'RB') {
        return clamp(v.rushYds / 110 + v.rushTDs * 1.7 + v.recYds / 220, 0, 14);
      }
      if (posGroup === 'WR' || posGroup === 'TE') {
        return clamp(v.recYds / 120 + v.recTDs * 1.9 + v.targets / 18, 0, 14);
      }
      if (posGroup === 'EDG' || posGroup === 'OTHER') {
        return clamp(v.sacks * 2.8 + v.tfl * 0.5, 0, 14);
      }
      if (posGroup === 'LB') {
        return clamp(v.tackles / 18 + v.sacks * 1.9 + v.ints * 3.5 + v.tfl * 0.45, 0, 13);
      }
      if (posGroup === 'DB') {
        return clamp(v.ints * 4.2 + v.pd * 0.9 + v.tackles / 22, 0, 13);
      }
      if (posGroup === 'OL') {
        return clamp(v.appearances * 1.2 + v.bestRank * -0.03 + 5, 0, 10);
      }
      return clamp(v.appearances * 0.8, 0, 8);
    })();
    const qbSeasonBonus = posGroup === 'QB'
      ? clamp(v.passYds / 520 + v.passTDs * 0.55 - v.passInts * 0.18 + v.weeks90 * 0.5, 0, 12)
      : 0;
    const score = avgGrade * 0.64
      + peakGrade * 0.14
      + appearanceBonus
      + productionBonus
      + qbSeasonBonus
      + v.weeks90 * 1.0
      + v.weeks80 * 0.35
      + v.streak90 * 0.55
      + v.streak * 0.35
      + winPctAvg * 4.5
      + rankBonus
      - std * 0.35
      - v.injuryHits * 0.4;

    let seasonGrade = avgGrade * 0.72
      + peakGrade * 0.16
      + productionBonus * 0.55
      + qbSeasonBonus * 0.6
      + v.weeks90 * 0.28
      + v.weeks80 * 0.1
      + v.streak90 * 0.16
      + v.appearances * 0.2
      - std * 0.25;

    if (v.appearances < 4) seasonGrade = Math.min(seasonGrade, 84);
    else if (v.appearances < 6) seasonGrade = Math.min(seasonGrade, 88);

    const entry = {
      id: v.id,
      name: v.name,
      position: v.position,
      team: v.team,
      teamId: v.teamId,
      avgGrade: Number(avgGrade.toFixed(2)),
      peakGrade: Number(peakGrade.toFixed(2)),
      winPct: Number(winPctAvg.toFixed(3)),
      appearances: v.appearances,
      weeks90: v.weeks90,
      weeks80: v.weeks80,
      streak90: v.streak90,
      streak80: v.streak80,
      streak: v.streak,
      bestRank: v.bestRank,
      injuryHits: v.injuryHits,
      seasonScore: Number(score.toFixed(3)),
      seasonGrade: Number(Math.max(72, Math.min(98, seasonGrade)).toFixed(2)),
      meetsUsage: getUsageGate(v),
    };

    if (v.appearances >= 5 && entry.meetsUsage) seasonList.push(entry);
    else if (v.appearances >= 1) fallbackList.push(entry);
  });

  const combined = [
    ...seasonList.sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0)),
    ...fallbackList.sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0)),
  ];

  if (!combined.length) return [];

  const groupMin = { QB: 4, RB: 8, WR: 14, TE: 4, OL: 8, EDG: 10, LB: 8, DB: 14 };
  const groupCap = { QB: 8, RB: 12, WR: 20, TE: 6, OL: 12, EDG: 16, LB: 14, DB: 18, SPECIAL: 4, OTHER: 8 };
  const grouped = new Map();
  combined.forEach((p) => {
    const group = getPositionGroup(p.position);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(p);
  });
  grouped.forEach((list) => list.sort((a, b) => Number(b.seasonScore || 0) - Number(a.seasonScore || 0)));

  const selected = [];
  const used = new Set();
  const capCount = {};
  const addPlayer = (p) => {
    const id = p.id || `${p.name}-${p.teamId || ''}`;
    if (used.has(id)) return false;
    const group = getPositionGroup(p.position);
    if ((capCount[group] || 0) >= (groupCap[group] ?? 100)) return false;
    used.add(id);
    capCount[group] = (capCount[group] || 0) + 1;
    selected.push(p);
    return true;
  };

  Object.entries(groupMin).forEach(([group, minCount]) => {
    const list = grouped.get(group) || [];
    for (let i = 0; i < list.length && (capCount[group] || 0) < minCount; i += 1) {
      addPlayer(list[i]);
    }
  });
  for (const p of combined) {
    if (selected.length >= 100) break;
    addPlayer(p);
  }
  if (selected.length < 100) {
    const overflowCap = { QB: 10, RB: 14, WR: 22, TE: 8, OL: 14, EDG: 20, LB: 18, DB: 22, SPECIAL: 4, OTHER: 10 };
    for (const p of combined) {
      if (selected.length >= 100) break;
      addPlayer(p, overflowCap);
    }
  }
  if (selected.length < 100) {
    const finalCap = { QB: 12, RB: 16, WR: 24, TE: 10, OL: 16, EDG: 24, LB: 22, DB: 24, SPECIAL: 4, OTHER: 12 };
    for (const p of combined) {
      if (selected.length >= 100) break;
      addPlayer(p, finalCap);
      if (selected.length >= 100) break;
    }
  }

  const ranked = selected
    .sort((a, b) => Number(b.seasonScore || 0) - Number(a.seasonScore || 0))
    .slice(0, 100);

  const topScore = Math.max(...ranked.map((p) => Number(p.seasonScore || 0)));
  const bottomScore = Math.min(...ranked.map((p) => Number(p.seasonScore || 0)));
  const scoreSpan = Math.max(1, topScore - bottomScore);

  const top = ranked
    .map((p, idx, arr) => {
      const scoreNorm = Math.min(1, Math.max(0, ((p.seasonScore || 0) - bottomScore) / scoreSpan));
      const rankNorm = arr.length <= 1 ? 1 : 1 - (idx / (arr.length - 1));
      return {
        ...p,
        seasonGrade: computePffStyleGrade(scoreNorm, rankNorm, {
          min: 73.5,
          max: 97.5,
          scoreWeight: 0.72,
          rankWeight: 0.28,
          rankPower: 0.72,
          eliteFloor: 0.95,
          eliteBump: 0.8,
        }),
      };
    })
    .sort((a, b) => {
      const g = Number(b.seasonGrade || 0) - Number(a.seasonGrade || 0);
      if (Math.abs(g) > 0.0001) return g;
      return Number(b.seasonScore || 0) - Number(a.seasonScore || 0);
    });

  return top;
}

function computeSeasonTop100FromHistory(leagueId) {
  const savedHistory = loadWeeklyHistory(leagueId);
  const snapshotHistory = buildSeasonHistoryFromSnapshot(leagueId);
  let history = savedHistory;
  if (snapshotHistory.length > history.length) history = snapshotHistory;

  let top = computeSeasonTop100FromEntries(history);
  if (top.length < 100 && snapshotHistory.length && history !== snapshotHistory) {
    top = computeSeasonTop100FromEntries(snapshotHistory);
  }
  if (top.length < 100) {
    try {
      const snapshot = loadLeagueSnapshot(leagueId);
      const stageOneWeeks = (snapshot?.weeklyStats || [])
        .filter((entry) => Number(entry?.stage ?? entry?.stageIndex ?? 0) === 1)
        .map((entry) => Number(entry?.weekIndex))
        .filter((value) => Number.isFinite(value));
      const latestWeek = stageOneWeeks.length ? Math.max(...stageOneWeeks) : null;
      if (latestWeek != null) {
        const weekly = computeWeeklyList(snapshot, latestWeek);
        const weeklyTop = Array.isArray(weekly?.allGraded) && weekly.allGraded.length
          ? weekly.allGraded
          : Array.isArray(weekly?.top100)
            ? weekly.top100
          : Array.isArray(weekly)
            ? weekly
            : [];
        const used = new Set(top.map((p) => String(p.id || `${p.name}-${p.teamId || ''}`)));
        for (const player of weeklyTop) {
          const id = String(player.id || `${player.name}-${player.teamId || ''}`);
          if (used.has(id)) continue;
          used.add(id);
          top.push({
            ...player,
            seasonScore: Number(player.seasonScore ?? player.score ?? player.grade ?? 0),
            seasonGrade: Number(player.seasonGrade ?? player.grade ?? player.weeklyGrade ?? 0),
          });
          if (top.length >= 100) break;
        }
      }
    } catch {
      // ignore fallback fill failures
    }
  }
  if (top.length < 100) {
    try {
      const snapshot = loadLeagueSnapshot(leagueId);
      top = topOffSeasonListFromRoster(snapshot, top, 100);
    } catch {
      // ignore roster top-off failures
    }
  }
  return top;
}

function buildPageEmbed(list, page, leagueId, meta = {}) {
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  const titleLabel = meta.label || 'Top 100';

  const teamEmoji = (team) => {
    if (!team) return '';
    const mascot = team.trim().split(/\s+/).pop();
    const id = TEAM_EMOJIS[mascot];
    if (!id) return '';
    const emojiName = mascot.replace(/[^A-Za-z0-9]/g, '');
    return `<:${emojiName}:${id}>`;
  };

  const lines = slice.map((p, idx) => {
    const rank = start + idx + 1;
    const gradeRaw = p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0;
    const grade = Number(gradeRaw).toFixed(2);
    const em = teamEmoji(p.team);
    return `${rank}. ${p.name} (${p.position}, ${p.team}) ${em ? em + ' ' : ''}— ${grade}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`Madden Player Grades — ${titleLabel}`)
    .setDescription(lines.join('\n') || 'No players available.')
    .setFooter({ text: `Page ${safePage}/${totalPages} • League ${leagueId}` });
  return { embed, totalPages, page: safePage };
}

function shouldDisplaySeasonTop100(snapshot, currentWeek) {
  const seasonWeekType = Number(snapshot?.info?.careerHubInfo?.seasonInfo?.seasonWeekType ?? snapshot?.seasonWeekType ?? 1);
  return seasonWeekType !== 1 || Number(currentWeek || 0) > 18;
}


async function updateTopPlayers(client, leagueId, snapshot, currentWeek, options = {}) {
  if (!snapshot || currentWeek === undefined || currentWeek === null) return;
  const { isWildcard = false, postChannelId = DEFAULT_POST_CHANNEL } = options;
  const requestedWeekIdx = Math.max(0, Number(currentWeek) - 1);
  const targetWeekIdx = getLatestReliableRegularSeasonWeekIndex(snapshot, requestedWeekIdx);
  if (targetWeekIdx == null) return;
  const weekly = computeWeeklyList(snapshot, targetWeekIdx);
  const list = Array.isArray(weekly) ? weekly : (weekly?.top100 || []);
  const allGraded = Array.isArray(weekly?.allGraded) ? weekly.allGraded : list;
  try {
    saveWeeklyAll(leagueId, targetWeekIdx, allGraded);
    saveWeeklyTop(leagueId, targetWeekIdx, list);
  } catch (err) {
    console.warn('[updateTopPlayers] failed to save weekly history:', err?.message || err);
  }
  // Persist latest list for getTop100Page
  const state = loadJson(TOP_FILE, {});
  state[leagueId] = state[leagueId] || {};
  state[leagueId].top100 = list;
  // Keep a running season Top 100 from history for end-of-year/season scope
  try {
    const seasonTop = computeSeasonTop100FromHistory(leagueId);
    state[leagueId].seasonTop100 = seasonTop.slice(0, 100);
    // Keep the latest weekly list trimmed as well (defensive)
    state[leagueId].top100 = (state[leagueId].top100 || []).slice(0, 100);
    const useSeason = shouldDisplaySeasonTop100(snapshot, currentWeek);
    state[leagueId].top100Display = (useSeason ? state[leagueId].seasonTop100 : state[leagueId].top100).slice(0, 100);
    state[leagueId].top100DisplayLabel = useSeason ? 'Season' : `Week ${targetWeekIdx + 1}`;
    saveJson(TOP_FILE, state);
  } catch (err) {
    console.warn('[updateTopPlayers] failed to compute season Top 100:', err?.message || err);
  }
  if (client && postChannelId) {
    try {
      const currentState = loadJson(TOP_FILE, {});
      const displayList = currentState?.[leagueId]?.top100Display || currentState?.[leagueId]?.top100 || list;
      const displayLabel = currentState?.[leagueId]?.top100DisplayLabel || `Week ${targetWeekIdx + 1}`;
      await postTop100(client, leagueId, displayList, postChannelId, { label: displayLabel });
    } catch (err) {
      console.error('[updateTopPlayers] failed to post Top 100:', err);
    }
  }
}

async function findExistingTop100Message(client, preferredChannelId, pinId) {
  if (!pinId) return { channel: null, message: null };
  const preferredChannel = preferredChannelId
    ? await client.channels.fetch(preferredChannelId).catch(() => null)
    : null;
  if (preferredChannel?.isTextBased()) {
    const existing = await preferredChannel.messages.fetch(pinId).catch(() => null);
    if (existing) return { channel: preferredChannel, message: existing };
  }

  const guild = preferredChannel?.guild || client.guilds.cache.first();
  const channels = guild?.channels?.cache
    ? [...guild.channels.cache.values()].filter((channel) => channel?.isTextBased?.())
    : [];
  for (const channel of channels) {
    if (preferredChannel && channel.id === preferredChannel.id) continue;
    const existing = await channel.messages.fetch(pinId).catch(() => null);
    if (existing) return { channel, message: existing };
  }
  return { channel: preferredChannel, message: null };
}

async function postTop100(client, leagueId, list, channelId, meta = {}) {
  try {
    const { embed, totalPages, page } = buildPageEmbed(list, 1, leagueId, meta);
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
    const pinId = getPinId('top100');
    const { channel, message } = await findExistingTop100Message(client, channelId, pinId);
    if (!channel || !channel.isTextBased()) return;
    if (message) {
      await message.edit({ embeds: [embed], components: [row] });
      return;
    }
    const sent = await channel.send({ embeds: [embed], components: [row] });
    if (sent?.id) setPinId('top100', sent.id);
  } catch (err) {
    console.error('[top_players] Failed to post Top 100:', err);
  }
}

function getTop100Page(leagueId, page) {
  const state = loadJson(TOP_FILE, {});
  const list = state?.[leagueId]?.top100Display || state?.[leagueId]?.top100 || [];
  const label = state?.[leagueId]?.top100DisplayLabel || 'Top 100';
  return buildPageEmbed(list, page, leagueId, { label });
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

export {
  computeWeeklyList,
  updateTopPlayers,
  getTop100Page,
  computeGradeFromRank,
  computeSeasonTop100FromHistory
};
