import path from 'path';
import fs from 'fs';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadJson, saveJson } from '../shared/json.js';
import { gatherWeeklyStats } from './awards.js';

const TOP_FILE = path.join(process.cwd(), 'data', 'madden', 'top_players.json');
const TOP_HISTORY_DIR = path.join(process.cwd(), 'data', 'madden', 'top_players_history');
const DEFAULT_POST_CHANNEL = '1462629502864851069';
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const TEAM_EMOJIS = loadJson(TEAM_EMOJIS_FILE, {});

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
    if (recTDs >= 3) base *= 1.28;
    else if (recTDs === 2) base *= 1.20;
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
    if (totalYds >= 180 && totalTDs >= 2) {
      base *= 1.18;
      base += 6;
    } else if (totalYds >= 140 && totalTDs >= 2) {
      base *= 1.12;
      base += 4;
    } else if (totalYds >= 110 && totalTDs >= 2) {
      base *= 1.08;
      base += 3;
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
  }
  // Offensive skill TD boost (QB/HB/RB/FB/WR/TE)
  const skillPositions = new Set(['QB', 'HB', 'RB', 'FB', 'WR', 'TE', 'TB']);
  const totalTDs = (t.passTDs || 0) + (t.rushTDs || 0) + (t.recTDs || 0);
  if (skillPositions.has(pos) && totalTDs >= 2) {
    base *= totalTDs >= 3 ? 1.12 : 1.08;
    if (totalTDs >= 3) base += 4;
  }
  // Extra multiplier for multi-TD games (all skill positions including QBs)
  if (skillPositions.has(pos)) {
    if (totalTDs >= 4) {
      base = base * 1.18 + 6;
    } else if (totalTDs === 3) {
      base = base * 1.12 + 4;
    }
  }
  // High TD explosion boost for non-QB skill players
  if (isSkill && pos !== 'QB') {
    if (totalTDs >= 4) {
      base = base * 1.30 + 14;
    } else if (totalTDs >= 3) {
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
  const tackleWeight = dlPositions.has(pos) ? 1.05 : 0.85;
  score += tackles * tackleWeight;
  const sackPositions = new Set(['LE', 'RE', 'LDE', 'RDE', 'DE', 'DT', 'EDGE', 'EDG', 'LEDGE', 'REDGE', 'WILL', 'MIKE', 'SAM', 'OLB', 'ILB']);
  const sackWeight = sackPositions.has(pos) ? 9.0 : 8;
  score += sacks * sackWeight; // heavier weight for sack leaders
  score += tfl * (dlPositions.has(pos) ? 4.5 : 4);
  const dbPositions = new Set(['CB', 'FS', 'SS']);
  const intWeight = dbPositions.has(pos) ? 0.25 : 4.5;
  score += ints * intWeight;
  score += ff * 5;
  score += fr * 3;
  const pdWeight = dbPositions.has(pos) ? 2.0 : 1.5;
  score += pd * pdWeight;
  score += td * 10;
  score += winBonus(p);
  const impact = sacks * 6 + tfl * 3 + ints * 8 + ff * 5 + fr * 3 + pd * 1.5 + td * 8;
  const impactCount = (t.defSacks || 0) + (t.defTacklesForLoss || 0) + (t.defInts || 0) + (t.defForcedFumbles || 0) +
    (t.defRecoveredFumbles || 0) + (t.defPassDeflections || 0) + (t.defTDs || 0);
  if (impact < 6 && tackles < 6) {
    // Light stat lines drop hard
    score *= 0.3;
  } else if (impactCount < 1) {
    // No impact plays at all: extra clamp
    score *= 0.25;
  } else {
    score *= 1 + Math.min(0.6, impact / 25);
  }
  // Sack leader boost for edges: if 2+ sacks, add a bonus
  const isEdgeRole = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes((p.position || '').toUpperCase());
  if (isEdgeRole && sacks >= 2) {
    score *= 1.15;
    score += 6; // extra bump
  }
  score *= 1.0; // modest defensive multiplier
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
  console.log('[top_players] computeWeeklyList start', { weekIndex });
  const awardsStore = (() => {
    try { return JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8')); } catch { return {}; }
  })();
  const awardWinners = (() => {
    const leagueAwards = awardsStore?.[snapshot?.leagueId] || {};
    const wk = leagueAwards?.[weekIndex]
      || leagueAwards?.[weekIndex + 1] // tolerate off-by-one between game week vs award week key
      || leagueAwards?.[weekIndex - 1];
    if (!wk) return [];
    return Object.entries(wk)
      .filter(([, v]) => Boolean(v))
      .map(([key, val]) => ({ ...val, __awardKey: key }));
  })();
  // Band definitions for grading (global OVR scale)
  const bandDefs = [
    { min: 97.0, max: 99.9, minCount: 1, maxCount: 1 },
    { min: 95.0, max: 96.9, minCount: 2, maxCount: 3 },
    { min: 90.0, max: 94.9, minCount: 5, maxCount: 7 },
    { min: 85.1, max: 89.9, minCount: 30, maxCount: 35 },
    { min: 80.0, max: 85.0, minCount: 30, maxCount: 35 },
    { min: 79.0, max: 79.9, minCount: 8, maxCount: 10 },
    { min: 78.0, max: 78.9, minCount: 8, maxCount: 10 },
    { min: 77.0, max: 77.9, minCount: 6, maxCount: 8 },
    { min: 76.0, max: 76.9, minCount: 0, maxCount: 5 },
    { min: 60.0, max: 75.9, minCount: 0, maxCount: 999 }
  ];
  const weekly = gatherWeeklyStats(snapshot, weekIndex);
  if (weekly) {
    const stageVal = weekly.stage !== undefined ? weekly.stage : (weekly.stageIndex !== undefined ? weekly.stageIndex : 0);
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
    console.log('[top_players] weekly stats', {
      requestedWeekIdx: weekIndex,
      returnedWeekIdx: weekly.weekIndex,
      stage: stageVal,
      playerCount: countPlayers(weekly)
    });
  } else {
    console.warn('[top_players] weekly stats missing for week', weekIndex);
  }
  if (!weekly) return [];
  const confMap = conferenceMap(snapshot);
  const teamMap = teamNameMap(snapshot);
  const winMap = winPctMap(snapshot);
  const defAllow = teamDefenseAllowMap(weekly);
  const rosterLookup = buildRosterLookup(snapshot);
  const richestEntries = buildRichestPlayerEntries(snapshot);
  enrichWeeklyWithRichest(weekly, richestEntries);
  // Enrich award winners with roster-derived position if missing
  awardWinners.forEach(w => {
    if (w && w.rosterId && (!w.position || !w.displayPos)) {
      const r = rosterLookup.get(w.rosterId);
      if (r?.position) {
        w.position = r.position;
        w.displayPos = r.position;
      }
    }
  });
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
    // If edge/defender has no impact stats, clamp hard
    const impactCount = (p.totals?.defSacks || 0) + (p.totals?.defTacklesForLoss || 0) + (p.totals?.defInts || 0) +
      (p.totals?.defForcedFumbles || 0) + (p.totals?.defRecoveredFumbles || 0) + (p.totals?.defPassDeflections || 0) + (p.totals?.defTDs || 0);
    const isEdgeRole = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes(pos);
    if (isEdgeRole && impactCount < 1) {
      baseScore *= 0.3;
    }
    // Position bump/nerf
    const edgePositions = new Set([
      'LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE',
      'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'
    ]);
    const posBump = (() => {
      // Tilt offense high, cap edges unless impact is real
      if (pos === 'QB') return 1.70;
      if (pos === 'WR' || pos === 'TE') return 1.38;
      if (pos === 'HB' || pos === 'FB' || pos === 'RB') return 1.35;
      if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 1.22;
      if (edgePositions.has(pos)) {
        if (impactCount < 1) return 0.75;
        if (impactCount < 3) return 1.0;
        return 1.08;
      }
      if (['CB'].includes(pos)) {
        if (impactCount < 1) return 0.80;
        return 0.95;
      }
      if (['FS', 'SS'].includes(pos)) {
        if (impactCount < 1) return 0.80;
        return 0.95;
      }
      if (['DT', 'MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos)) {
        if (impactCount < 1) return 1.1;
        if (impactCount < 2) return 1.28;
        return 1.4;
      }
      if (pos === 'K' || pos === 'P') return 1.05;
      return 1.0;
    })();
    baseScore *= posBump;
    // Slightly boost good QBs for Top 100 weighting
    if (pos === 'QB' && baseScore > 50) {
      baseScore *= 1.12;
    }
    // Boost non-DB defenders that produced impact plays
    const isDb = pos === 'CB' || pos === 'FS' || pos === 'SS';
    if (!isDb && isDefense) {
      const impactPlays = (p.totals?.defSacks || 0) + (p.totals?.defTacklesForLoss || 0) + (p.totals?.defInts || 0) +
        (p.totals?.defForcedFumbles || 0) + (p.totals?.defRecoveredFumbles || 0) + (p.totals?.defTDs || 0);
      if (impactPlays >= 1) baseScore *= 1.12;
      if (impactPlays >= 3) baseScore *= 1.06;
      const isInteriorLb = ['DT', 'MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos);
      if (isInteriorLb && impactPlays >= 2) {
        baseScore *= 1.12;
        baseScore += impactPlays * 2;
      }
      if (['DT', 'SAM', 'MIKE', 'WILL', 'MLB', 'ILB', 'LB'].includes(pos)) {
        const tfl = p.totals?.defTacklesForLoss || 0;
        const sacks = p.totals?.defSacks || 0;
        if (tfl >= 3 || sacks >= 2) baseScore = baseScore * 1.2 + 8;
        else if (tfl >= 2 || sacks >= 1) baseScore = baseScore * 1.12 + 4;
        else baseScore *= 1.05; // modest lift for DT/LB even with light impact
      }
    }
    // Global offense/defense tilt to satisfy band splits
    if (isOffPos(pos)) {
      baseScore *= 1.6; // stronger lift for offense so skill/QB/OL compete
    } else {
      baseScore *= 0.6; // heavier nerf on defense to flatten out edge/DL dominance
      // Edge min impact guard: if no sacks/TFL/INT/FF/FR/PD/TD, cap it
      if (edgePositions.has(pos)) {
        const impact = (p.totals?.defSacks || 0) + (p.totals?.defTacklesForLoss || 0) + (p.totals?.defInts || 0) + (p.totals?.defForcedFumbles || 0) + (p.totals?.defRecoveredFumbles || 0) + (p.totals?.defPassDeflections || 0) + (p.totals?.defTDs || 0);
        if (impact < 1) baseScore = Math.min(baseScore, 70);
      }
    }
    // Edge sack floor: multi-sack games must punch through the mix
    if (edgePositions.has(pos)) {
      const sacks = p.totals?.defSacks || 0;
      const tfl = p.totals?.defTacklesForLoss || 0;
      if (sacks >= 3) {
        // Softer floor for multi-sack games to keep offense competitive
        baseScore = Math.max(baseScore, 80 + sacks * 2.5 + tfl * 1.2);
      } else if (sacks >= 2) {
        baseScore = Math.max(baseScore, 70 + sacks * 1.8 + tfl * 1.0);
      }
    }
    const winPct = (winMap[p.teamId] !== undefined && winMap[p.teamId] !== null) ? winMap[p.teamId] : 0.5;
    const score = baseScore * (1 + 0.12 * winPct) + (winPct * 8); // explicit win% bonus
    const rosterInfo = rosterEntry || rosterLookup.get(p.rosterId);
    const ovr = p.playerBestOvr || p.playerSchemeOvr || p.ovr || null;
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
    p.score = p.score * 0.5 + (z * 10) * 0.5;
  });
  // Small positional spread to avoid identical grades for same-line stat edges/front-7
  const spreadKey = (p) => `${p.position}-${p.totals?.defSacks || 0}-${p.totals?.defTacklesForLoss || 0}-${p.totals?.defInts || 0}-${p.totals?.defTDs || 0}`;
  const spreadBuckets = new Map();
  rawList.forEach(p => {
    const k = spreadKey(p);
    if (!spreadBuckets.has(k)) spreadBuckets.set(k, []);
    spreadBuckets.get(k).push(p);
  });
  spreadBuckets.forEach(list => {
    list.sort((a, b) => (b.score || 0) - (a.score || 0));
    list.forEach((p, idx) => {
      p.score = (p.score || 0) - idx * 0.15; // nudge similar stat lines apart
    });
  });
  // Champion bonus per position group so any role can surface at the very top
  const groupOf = (posRaw) => {
    const pos = (posRaw || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['HB', 'RB', 'FB', 'TB'].includes(pos)) return 'RB';
    if (pos === 'WR') return 'WR';
    if (pos === 'TE') return 'TE';
    if (['LT', 'LG', 'C', 'RG', 'RT'].includes(pos)) return 'OL';
    if (['MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    const edge = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'];
    if (edge.includes(pos) || /EDGE/.test(pos)) return 'EDG';
    if (['CB', 'FS', 'SS'].includes(pos)) return 'DB';
    if (['K', 'P'].includes(pos)) return 'SPECIAL';
    return 'OTHER';
  };
  const grouped = new Map();
  rawList.forEach(p => {
    const g = groupOf(p.position);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(p);
  });
  grouped.forEach(list => list.sort((a, b) => (b.score || 0) - (a.score || 0)));
  grouped.forEach(list => {
    if (!list.length) return;
    const top = list[0];
    const group = groupOf(top.position);
    const championBoost = group === 'DB' ? 1.0 : 1.06; // no extra boost for DB champion
    top.score = (top.score || 0) * championBoost + 6;
    // Only DB champion gets a bump; no runner boost for DBs
    if (list[1] && group !== 'DB') {
      const runnerBoost = 1.03;
      list[1].score = (list[1].score || 0) * runnerBoost + 3;
    }
  });
  // Light QB boost to ensure 3-6 QBs surface
  const qbs = rawList.filter(p => (p.position || '').toUpperCase() === 'QB').sort((a, b) => (b.score || 0) - (a.score || 0));
  qbs.slice(0, 8).forEach((p, i) => { p.score = (p.score || 0) * 1.18; if (i < 4) p.score += 8; });

  rawList.sort((a, b) => {
    const as = a.score !== undefined && a.score !== null ? a.score : 0;
    const bs = b.score !== undefined && b.score !== null ? b.score : 0;
    return bs - as;
  });
  const gradedAllPlayers = rawList.map((p, idx) => ({
    ...p,
    grade: computeGradeFromRank(idx, rawList.length)
  }));
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
    // Let elite OL carry real weight: top OL can sit in low-mid 90s, next two taper down.
    const caps = [95, 92, 88];
    const capped = Math.min(caps[idx] || 85, Math.max(60, (p.score || 0)));
    return { ...p, score: capped - idx * 1.0 };
  });
  const olRest = olEntries.slice(3).map(p => {
    return { ...p, score: Math.max(55, Math.min(80, p.score || 0)) };
  }); // keep viable mid/upper-80 potential
  const combined = [...nonOl, ...olTop, ...olRest];
  combined.forEach(p => {
    if (olSet.has(p.position)) {
      // Keep OL scores in a competitive but bounded window
      p.score = Math.max(55, Math.min(95, p.score));
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
  // Give top OL a guaranteed ceiling so they can compete in 90+ band
  const olBoostMap = new Map();
  prelimAdjusted
    .filter(p => olSet.has((p.position || '').toUpperCase()))
    .sort((a, b) => (b.grade || 0) - (a.grade || 0))
    .forEach((p, idx) => {
      let target = null;
      if (idx === 0) target = 95;
      else if (idx === 1) target = 92;
      else if (idx < 5) target = 88;
      if (target !== null && (p.grade || 0) < target) {
        olBoostMap.set(p.id, target);
      }
    });
  const prelimAdjustedBoosted = prelimAdjusted.map(p => {
    if (olBoostMap.has(p.id)) {
      const tgt = olBoostMap.get(p.id);
      return { ...p, grade: Math.min(99.9, Math.max(p.grade || 0, tgt)) };
    }
    return p;
  });

  // Anti-flood: keep OL competitive but balanced across the top ranks
  (() => {
    const olSetLocal = new Set(['LT', 'LG', 'C', 'RG', 'RT']);
    // Gentle taper for OL grades above 93
    prelimAdjustedBoosted.forEach(p => {
      if (!olSetLocal.has((p.position || '').toUpperCase())) return;
      if ((p.grade || 0) > 94) p.grade = 94;
      else if ((p.grade || 0) > 92) p.grade = Number((92 + (p.grade - 92) * 0.6).toFixed(2)); // soften 92-94 band
    });
    // Enforce top-rank OL limits: max 2 in top 15, max 4 in top 30
    const sorted = [...prelimAdjustedBoosted].sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const olInTop15 = sorted.slice(0, 15).filter(p => olSetLocal.has((p.position || '').toUpperCase()));
    if (olInTop15.length > 2) {
      olInTop15.slice(2).forEach(p => { p.grade = Math.min(p.grade || 0, 88.5); });
    }
    const olInTop30 = sorted.slice(0, 30).filter(p => olSetLocal.has((p.position || '').toUpperCase()));
    if (olInTop30.length > 4) {
      olInTop30.slice(4).forEach(p => { p.grade = Math.min(p.grade || 0, 86.5); });
    }
  })();

  // OL-specific caps: allow up to 2 OL in 95+ and up to 4 OL in 90-94.9 so elite lines can surface
  const olSetFinal = olSet;
  const olSorted = prelimAdjustedBoosted.filter(p => olSetFinal.has(p.position)).sort((a, b) => (b.grade || 0) - (a.grade || 0));
  let ol95 = 0;
  let ol90 = 0;
  const adjust = new Map();
  olSorted.forEach(p => {
    if ((p.grade || 0) >= 95) {
      if (ol95 < 2) {
        ol95 += 1;
        adjust.set(p.id, p.grade);
      } else {
        adjust.set(p.id, Math.min(89.9, p.grade));
      }
    } else if ((p.grade || 0) >= 90) {
      if (ol90 < 4) {
        ol90 += 1;
        adjust.set(p.id, p.grade);
      } else {
        adjust.set(p.id, Math.min(89.9, p.grade));
      }
    }
  });
  // QB presence: ensure 1-3 QBs in 90+; cap extras
  const qbSorted = prelimAdjustedBoosted.filter(p => (p.position || '').toUpperCase() === 'QB').sort((a, b) => (b.grade || 0) - (a.grade || 0));
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
  const defSorted = prelimAdjustedBoosted.filter(p => defPositions.has((p.position || '').toUpperCase())).sort((a, b) => (b.grade || 0) - (a.grade || 0));
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
  const gradedAll = graded.map(p => ({ ...p }));
  // Append DNP QBs for this week (rostered QBs with no stats)
  (() => {
    const haveIds = new Set(gradedAll.map(p => p.id || p.rosterId));
    const rosterQBs = [];
    const teams = snapshot?.rosters?.teams || {};
    Object.entries(teams).forEach(([teamId, roster]) => {
      (roster?.rosterInfoList || []).forEach(pl => {
        if ((pl.position || '').toUpperCase() !== 'QB') return;
        rosterQBs.push({
          id: pl.rosterId || `${pl.firstName || ''}-${pl.lastName || ''}-${teamId}`,
          name: `${pl.firstName || ''} ${pl.lastName || ''}`.trim() || pl.displayName || pl.fullName || 'QB',
          teamId: Number(teamId) || pl.teamId,
          team: teamMap[teamId] || 'Unknown Team',
          conference: confMap[teamId] || 'Unknown',
        });
      });
    });
    rosterQBs.forEach(qb => {
      const key = qb.id || qb.name;
      if (haveIds.has(key)) return;
      gradedAll.push({
        id: qb.id,
        name: qb.name,
        position: 'QB',
        displayPos: 'QB',
        totals: {},
        teamId: qb.teamId,
        team: qb.team,
        conference: qb.conference,
        statLine: 'DNP',
        winPct: winMap[qb.teamId] ?? 0.5,
        ovr: null,
        score: 0,
        grade: 40,
        dnp: true
      });
      haveIds.add(key);
    });
  })();
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
  const baseList = prelimAdjustedBoosted;
  const defenders = baseList.filter(p => defPositionsSet100.has((p.position || '').toUpperCase()));
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
  const nonDefenders = baseList.filter(p => !defPositionsSet100.has((p.position || '').toUpperCase()));
  const fillCount = 100 - selectedDefenders.length;
  const rest = nonDefenders.sort((a, b) => (b.grade || 0) - (a.grade || 0)).slice(0, fillCount);
  // Combine and sort by grade for final output
  let forcedTop100 = [...selectedDefenders, ...rest]
    .sort((a, b) => (b.grade || 0) - (a.grade || 0))
    .slice(0, 100);

  // Ensure a baseline linebacker presence across the full Top 100
  const MIN_LB = 10;
  const isLB = (p) => posGroup(p.position) === 'LB';
  let lbCount = forcedTop100.filter(isLB).length;
  if (lbCount < MIN_LB) {
    // Candidates: best remaining LBs not already selected
    const selectedIds = new Set(forcedTop100.map(p => p.id));
    const lbCandidates = baseList
      .filter(p => isLB(p) && !selectedIds.has(p.id))
      .sort((a, b) => (b.grade || 0) - (a.grade || 0));

    while (lbCount < MIN_LB && lbCandidates.length) {
      const lb = lbCandidates.shift();
      // Replace the lowest-ranked non-LB
      const replaceIdx = forcedTop100.map((p, i) => ({ i, p }))
        .filter(({ p }) => !isLB(p))
        .sort((a, b) => (a.p.grade || 0) - (b.p.grade || 0))[0]?.i;
      if (replaceIdx === undefined) break;
      forcedTop100[replaceIdx] = lb;
      lbCount++;
    }
    forcedTop100 = forcedTop100
      .sort((a, b) => (b.grade || 0) - (a.grade || 0))
      .slice(0, 100);
  }

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
        LB: { min: 3, max: 5 },
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
        LB: { min: 4, max: 7 },
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
        LB: { min: 6, max: 9 },
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

  const candidatePool = baseList
    .slice()
    .map((p, idx) => ({ ...p, id: ensureId(p, idx, 'cand') }))
    .sort((a, b) => (b.grade || 0) - (a.grade || 0));
  // Hard-lift top OL so at least one cracks the high bands
  const olBoostTargetsTop = [97, 95, 92];
  candidatePool
    .filter(p => ['LT', 'LG', 'C', 'RG', 'RT'].includes((p.position || '').toUpperCase()))
    .slice(0, olBoostTargetsTop.length)
    .forEach((p, i) => { p.grade = Math.max(p.grade || 0, olBoostTargetsTop[i]); });
  candidatePool.sort((a, b) => (b.grade || 0) - (a.grade || 0));

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

  // Pre-seed with top OL so they don't get edged out by other groups
  const olSeed = (globalGroupPools.get('OL') || []).slice(0, 3);
  const olSeedTargets = [95, 92, 88];
  olSeed.forEach((p, idx) => {
    if (selected.length >= 100) return;
    if (used.has(p.id)) return;
    selected.push({ ...p, grade: Math.max(p.grade || 0, olSeedTargets[idx] || 88) });
    used.add(p.id);
  });

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

  const rankGrade = (p) => {
    let g = p.grade || 0;
    const pg = posGroup(p.position);
    if (pg === 'LB') g += 8;            // lift linebackers
    else if (pg === 'OL') g -= 2;       // slightly suppress OL dominance
    else if (pg === 'SPECIAL') g -= 5;  // specialists downweight
    return g;
  };

  let finalTop100 = selected
    .sort((a, b) => rankGrade(b) - rankGrade(a))
    .slice(0, 100);

  // Hard guarantee: ensure at least 3 OL make the final 100 with strong grades
  const ensureTopOlPresence = () => {
    const currentOl = finalTop100.filter(p => posGroup(p.position) === 'OL');
    if (currentOl.length >= 3) return;
    const bestOlPool = candidatePool.filter(p => posGroup(p.position) === 'OL');
    bestOlPool.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const targets = [97, 95, 92, 90];
    for (let i = 0; i < bestOlPool.length && currentOl.length < 3; i++) {
      const ol = { ...bestOlPool[i], grade: Math.max(bestOlPool[i].grade || 0, targets[currentOl.length] || 90) };
      // Replace the lowest non-OL
      const idxSwap = finalTop100
        .map((p, idx) => ({ p, idx }))
        .filter(entry => posGroup(entry.p.position) !== 'OL')
        .sort((a, b) => (a.p.grade || 0) - (b.p.grade || 0))
      [0]?.idx;
      if (idxSwap === undefined) break;
      finalTop100.splice(idxSwap, 1, ol);
      currentOl.push(ol);
    }
    // Resort after insertion
    finalTop100 = finalTop100.sort((a, b) => rankGrade(b) - rankGrade(a)).slice(0, 100);
  };
  ensureTopOlPresence();

  // Guarantee LB presence and distribution: at least 12 LBs overall, and 6 in the top 30
  const ensureLinebackers = () => {
    const MIN_LB_TOTAL = 12;
    const MIN_LB_TOP30 = 6;
    const selectedIds = new Set(finalTop100.map(p => p.id));

    // Add LBs overall if needed
    let lbCount = finalTop100.filter(isLB).length;
    if (lbCount < MIN_LB_TOTAL) {
      const lbPool = candidatePool
        .filter(p => isLB(p) && !selectedIds.has(p.id))
        .sort((a, b) => rankGrade(b) - rankGrade(a));
      while (lbCount < MIN_LB_TOTAL && lbPool.length) {
        const lb = lbPool.shift();
        const replaceIdx = finalTop100
          .map((p, idx) => ({ p, idx }))
          .filter(entry => !isLB(entry.p))
          .sort((a, b) => rankGrade(a.p) - rankGrade(b.p))[0]?.idx;
        if (replaceIdx === undefined) break;
        finalTop100.splice(replaceIdx, 1, lb);
        selectedIds.add(lb.id);
        lbCount++;
      }
      finalTop100 = finalTop100.sort((a, b) => rankGrade(b) - rankGrade(a)).slice(0, 100);
    }

    // Ensure LB presence in top 30
    let lbTop30 = finalTop100.slice(0, 30).filter(isLB).length;
    if (lbTop30 < MIN_LB_TOP30) {
      const lbPoolTop = [
        ...finalTop100.slice(30).filter(isLB),
        ...candidatePool.filter(p => isLB(p) && !selectedIds.has(p.id))
      ].sort((a, b) => rankGrade(b) - rankGrade(a));

      const nonLbTop30 = finalTop100
        .slice(0, 30)
        .map((p, idx) => ({ p, idx }))
        .filter(entry => !isLB(entry.p))
        .sort((a, b) => rankGrade(a.p) - rankGrade(b.p));

      let i = 0, j = 0;
      while (lbTop30 < MIN_LB_TOP30 && i < lbPoolTop.length && j < nonLbTop30.length) {
        const lb = lbPoolTop[i++];
        const replaceIdx = nonLbTop30[j++].idx;
        finalTop100[replaceIdx] = lb;
        selectedIds.add(lb.id);
        lbTop30++;
      }
      finalTop100 = finalTop100.sort((a, b) => rankGrade(b) - rankGrade(a)).slice(0, 100);
    }
  };
  ensureLinebackers();

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

  // OL band caps and per-team limits
  const olBandCaps = [
    { min: 95.0, max: 99.9, minCount: 0, maxCount: 2, teamCap: 1 },
    { min: 90.0, max: 94.9, minCount: 1, maxCount: 2, teamCap: 1 },
    { min: 85.1, max: 89.9, minCount: 1, maxCount: 3, teamCap: 1 },
    { min: 80.0, max: 85.0, minCount: 2, maxCount: 4, teamCap: 2 },
    { min: 79.0, max: 79.9, minCount: 2, maxCount: 5, teamCap: 2 },
    { min: 78.0, max: 78.9, minCount: 3, maxCount: 6, teamCap: 2 },
    { min: 77.0, max: 77.9, minCount: 3, maxCount: 7, teamCap: 2 },
    { min: 76.0, max: 76.9, minCount: 5, maxCount: 8, teamCap: 2 }
  ];

  const enforceOlBands = (list) => {
    let result = [...list];
    const used = new Set(result.map(p => p.id));
    const poolOL = candidatePool
      .filter(p => !used.has(p.id) && posGroup(p.position) === 'OL')
      .sort((a, b) => (b.grade || 0) - (a.grade || 0));

    const removals = new Set();

    olBandCaps.forEach(band => {
      let bandOL = result
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => posGroup(p.position) === 'OL' && (p.grade || 0) >= band.min && (p.grade || 0) <= band.max)
        .sort((a, b) => (b.p.grade || 0) - (a.p.grade || 0));

      // enforce team cap within the band
      const kept = [];
      const teamCounts = new Map();
      bandOL.forEach(item => {
        const team = item.p.teamId || item.p.team || 'unk';
        const cur = teamCounts.get(team) || 0;
        if (cur >= (band.teamCap ?? Infinity)) {
          removals.add(item.p.id);
          return;
        }
        teamCounts.set(team, cur + 1);
        kept.push(item);
      });
      bandOL = kept;

      // trim if above max
      if (band.maxCount != null && bandOL.length > band.maxCount) {
        bandOL.slice(band.maxCount).forEach(item => removals.add(item.p.id));
        bandOL = bandOL.slice(0, band.maxCount);
      }

      // add if below min
      let need = Math.max(0, (band.minCount || 0) - bandOL.length);
      while (need > 0 && poolOL.length) {
        const cand = poolOL.shift();
        const team = cand.teamId || cand.team || 'unk';
        const cur = bandOL.filter(it => (it.p.teamId || it.p.team || 'unk') === team).length;
        if (cur >= (band.teamCap ?? Infinity)) continue;
        const adjusted = { ...cand };
        if ((adjusted.grade || 0) < band.min) adjusted.grade = band.min + 0.05;
        if ((adjusted.grade || 0) > band.max) adjusted.grade = band.max - 0.05;
        result.push(adjusted);
        used.add(adjusted.id);
        bandOL.push({ p: adjusted });
        need--;
      }
    });

    if (removals.size) {
      result = result.filter(p => !removals.has(p.id));
    }

    // backfill to 100 with best remaining
    if (result.length < 100) {
      const refillPool = candidatePool
        .filter(p => !used.has(p.id))
        .sort((a, b) => (b.grade || 0) - (a.grade || 0));
      for (const p of refillPool) {
        if (result.length >= 100) break;
        result.push(p);
        used.add(p.id);
      }
    }

    result.sort((a, b) => (b.grade || 0) - (a.grade || 0));
    return result.slice(0, 100);
  };

  const afterOlBands = enforceOlBands(afterOverall);

  // Team caps per band (grade tiers)
  const teamBandCaps = [
    // Global team caps (non-OL)
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

  const withTeamCaps = applyTeamCaps(afterOlBands);
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
    { name: '90s', min: 90, max: 99.99, offMin: 5, offMax: 6, defMin: 3, defMax: 4, qbMin: 2, impactGate: true },
    { name: '80s', min: 80, max: 89.999, offRatio: 0.65, qbMin: 5, qbMax: 6, impactGate: false },
    { name: '70s', min: 70, max: 79.999, offRatio: 0.5, qbMin: 8, qbMax: 9, impactGate: false }
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
    let adjusted = list;
    if (cfg.impactGate) {
      // Drop any defenders/edges with zero impact stats from the band
      adjusted = list.filter(p => {
        const pos = (p.displayPos || p.position || '').toUpperCase();
        const isDef = !isOffenseGroup(getGroup(p));
        const impact = (p.totals?.defSacks || 0) + (p.totals?.defTacklesForLoss || 0) + (p.totals?.defInts || 0) +
          (p.totals?.defForcedFumbles || 0) + (p.totals?.defRecoveredFumbles || 0) + (p.totals?.defPassDeflections || 0) + (p.totals?.defTDs || 0);
        const sacks = p.totals?.defSacks || 0;
        const isEdgeRole = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes(pos);
        if (isEdgeRole && sacks >= 2) return true; // sack leaders qualify
        if (isDef && impact < 1) return false;
        return true;
      });
    }
    adjusted = rebalanceBand(adjusted, cfg);
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
  const desired90 = { qb: 2, off: 5, def: 3, max: desired90Count };
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
    const target = desired90.max;
    const candidates = [...band90, ...band80]
      .sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const selected = [];
    const used = new Set();
    const take = (predicate, maxCount) => {
      for (const p of candidates) {
        if (selected.length >= target) break;
        if (used.has(p.id)) continue;
        if (!predicate(p)) continue;
        selected.push({ ...p, grade: Math.max(90, Math.min(96, p.grade || 90)) });
        used.add(p.id);
        if (selected.filter(x => predicate(x)).length >= maxCount) break;
      }
    };
    // QBs
    take(p => getGroup(p) === 'QB', desired90.qb);
    // Offense to reach off min (including QBs already counted)
    while (selected.filter(p => isOffGroup(p)).length < desired90.off && selected.length < target) {
      const next = candidates.find(p => !used.has(p.id) && isOffGroup(p));
      if (!next) break;
      selected.push({ ...next, grade: Math.max(90, Math.min(95.5, next.grade || 90)) });
      used.add(next.id);
    }
    // Defense to reach def min
    while (selected.filter(p => isDefGroup(p)).length < desired90.def && selected.length < target) {
      const next = candidates.find(p => !used.has(p.id) && isDefGroup(p));
      if (!next) break;
      selected.push({ ...next, grade: Math.max(90, Math.min(95, next.grade || 90)) });
      used.add(next.id);
    }
    // Fill remaining slots by grade
    for (const p of candidates) {
      if (selected.length >= target) break;
      if (used.has(p.id)) continue;
      selected.push({ ...p, grade: Math.max(90, Math.min(95, p.grade || 90)) });
      used.add(p.id);
    }
    band90 = selected.slice(0, target);
    // Remaining candidates go to band80
    band80 = candidates.filter(p => !used.has(p.id) || !band90.find(b => b.id === p.id)).map(p => {
      if ((p.grade || 0) >= 90) {
        return { ...p, grade: Math.max(83, Math.min(89.9, p.grade || 83)) };
      }
      return p;
    });
  };

  ensure90();

  // Ensure 80s off/def and QB count
  const ensure80 = () => {
    const total80 = band80.length;
    const desiredOff = Math.round(total80 * 0.65);
    const desiredDef = total80 - desiredOff;
    const qbMin = 5;
    const qbMax = 6;
    const allOff = [...band80, ...others].filter(p => isOffGroup(p) || getGroup(p) === 'QB')
      .sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const allDef = [...band80, ...others].filter(p => isDefGroup(p))
      .sort((a, b) => (b.grade || 0) - (a.grade || 0));
    const nextOff = () => allOff.shift();
    const nextDef = () => allDef.shift();
    const newBand80 = [];
    // QBs first
    let qbCount = 0;
    while (qbCount < qbMin && newBand80.length < total80) {
      const qb = allOff.find(p => getGroup(p) === 'QB');
      if (!qb) break;
      allOff.splice(allOff.indexOf(qb), 1);
      qb.grade = Math.max(80, Math.min(89.9, qb.grade || 80));
      newBand80.push(qb);
      qbCount++;
    }
    while (qbCount > qbMax && newBand80.length) {
      const idx = newBand80.findIndex(p => getGroup(p) === 'QB');
      if (idx === -1) break;
      newBand80.splice(idx, 1);
      qbCount--;
    }
    // Offense until desiredOff
    while (newBand80.filter(p => isOffGroup(p)).length < desiredOff && newBand80.length < total80) {
      const p = nextOff();
      if (!p) break;
      p.grade = Math.max(80, Math.min(89.9, p.grade || 80));
      newBand80.push(p);
    }
    // Defense until desiredDef
    while (newBand80.filter(p => isDefGroup(p)).length < desiredDef && newBand80.length < total80) {
      const p = nextDef();
      if (!p) break;
      p.grade = Math.max(80, Math.min(89.9, p.grade || 80));
      newBand80.push(p);
    }
    // Fill remaining by best available
    const remaining = [...allOff, ...allDef].sort((a, b) => (b.grade || 0) - (a.grade || 0));
    while (newBand80.length < total80 && remaining.length) {
      const p = remaining.shift();
      p.grade = Math.max(80, Math.min(89.9, p.grade || 80));
      newBand80.push(p);
    }
    band80 = newBand80.slice(0, total80);
  };

  ensure80();

  // Recombine and resort
  let recombined = [...band90, ...band80, ...others].sort((a, b) => (b.grade || 0) - (a.grade || 0));
  // Ensure DT representation: promote top DTs from the full candidate pool if missing
  {
    const usedIds = new Set(recombined.map(p => p.id));
    const dtPool = candidatePool
      .filter(p => (p.position || '').toUpperCase() === 'DT')
      .sort((a, b) => (b.grade || b.score || 0) - (a.grade || a.score || 0));
    const maxDt = Math.min(2, dtPool.length);
    for (let i = 0; i < maxDt; i++) {
      const dt = dtPool[i];
      if (!dt || usedIds.has(dt.id)) continue;
      // Allow DTs to break into mid/high 90s when promoted
      const floor = i === 0 ? 95 : 92;
      const graded = Math.max(floor, Number((dt.grade || floor).toFixed(2)));
      recombined.push({ ...dt, grade: graded });
      usedIds.add(dt.id);
    }
  }
  // Ensure list length is 100 by backfilling with best remaining candidates (even if low impact)
  if (recombined.length < 100) {
    const usedIds = new Set(recombined.map(p => p.id));
    const fillerPool = candidatePool
      .filter(p => !usedIds.has(p.id))
      .sort((a, b) => (b.score || b.grade || 0) - (a.score || a.grade || 0));
    for (const p of fillerPool) {
      if (recombined.length >= 100) break;
      const grade = Math.max(70, Math.min(79.9, Number((p.grade || 75).toFixed(2))));
      recombined.push({ ...p, grade });
      usedIds.add(p.id);
    }
  }
  // Clamp/penalize low-output QBs so weak stat lines don't sit high
  recombined = recombined.map(p => {
    if ((p.position || '').toUpperCase() !== 'QB') return p;
    const t = p.totals || {};
    const yds = t.passYds || 0;
    const tds = t.passTDs || 0;
    const ints = t.passInts || 0;
    let g = p.grade || 0;
    if (yds < 180 && tds === 0) g = Math.min(g, 82);
    else if (yds < 200 && tds <= 1) g = Math.min(g, 86);
    else if (yds < 250 && tds <= 1) g = Math.min(g, 90);
    if (ints >= 3) g = Math.min(g, 83);
    else if (ints === 2 && tds <= 1) g = Math.min(g, 88);
    return { ...p, grade: Number(g.toFixed(2)) };
  });

  const jittered = (() => {
    const fracFromId = (id) => {
      const s = `${id}-${weekIndex}`;
      let h = 0;
      for (let i = 0; i < s.length; i++) {
        h = (h * 131 + s.charCodeAt(i)) >>> 0;
      }
      return ((h % 99) + 1) / 100; // 0.01 - 0.99
    };
    return recombined.map(p => {
      const frac = fracFromId(p.id || p.name || '');
      const base = Math.floor(p.grade || 0);
      const graded = Math.max(40, Math.min(99.8, base + frac));
      return { ...p, grade: Number(graded.toFixed(2)) };
    });
  })();

  // Apply a small rank-based spread to avoid tight clustering (especially mid/high 80s)
  const spread = jittered
    .sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    })
    .map((p, idx) => {
      const adjusted = Math.max(40, Math.min(99.9, (p.grade || 0) - idx * 0.001));
      return { ...p, grade: Number(adjusted.toFixed(2)) };
    })
    .map(p => {
      const pos = (p.position || '').toUpperCase();
      // Elite lifts so every position can reach mid/high 90s on big lines
      let g = p.grade || 0;
      const t = p.totals || {};
      if (['C', 'RG', 'LG', 'RT', 'LT'].includes(pos)) {
        // OL proxy: if score already high, lift into 95 band
        if ((p.score || 0) > 40) g = Math.max(g, 95);
      } else if (pos === 'K' || pos === 'P') {
        if ((p.score || 0) > 25) g = Math.max(g, 95);
      } else if (['FB'].includes(pos) && (t.rushTDs || 0) + (t.recTDs || 0) >= 2) {
        g = Math.max(g, 95);
      }
      const recYds = p.totals?.recYds || 0;
      const isSkillRec = ['WR', 'TE', 'HB', 'RB', 'FB', 'TB'].includes(pos);
      if (isSkillRec && recYds >= 150) g = Math.max(g, 90);
      const tfl = p.totals?.defTacklesForLoss || 0;
      const sacks = p.totals?.defSacks || 0;
      const isEdgeRole = ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'LEDG', 'REDG', 'REDGE', 'LEDGE', 'EDGE_R', 'EDGE_L', 'EDGE-R', 'EDGE-L', 'LDE', 'RDE', 'DE', 'OLB'].includes(pos);
      if (isEdgeRole && sacks >= 3) {
        // Variable lift for big sack games to avoid identical grades
        g = Math.max(g, 90 + sacks * 0.75 + (tfl || 0) * 0.35);
      } else if (isEdgeRole && sacks >= 2) {
        g = Math.max(g, 86 + sacks * 0.6 + (tfl || 0) * 0.25);
      }
      const frontSet = new Set(['DT', 'MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL']);
      if (frontSet.has(pos)) {
        const impactLine = (p.totals?.defTacklesForLoss || 0) + (p.totals?.defSacks || 0);
        if (impactLine >= 4) g = Math.max(g, 96);
        else if (impactLine >= 3) g = Math.max(g, 93);
        else if (impactLine >= 2) g = Math.max(g, 89);
      }
      // RB high-TD high-yard floors
      if (pos === 'HB' || pos === 'RB' || pos === 'FB' || pos === 'TB') {
        const rbTotalYds = (p.totals?.rushYds || 0) + (p.totals?.recYds || 0);
        const rbTotalTDs = (p.totals?.rushTDs || 0) + (p.totals?.recTDs || 0);
        if (rbTotalTDs >= 4 && rbTotalYds >= 150) g = Math.max(g, 97);
        else if (rbTotalTDs >= 3 && rbTotalYds >= 150) g = Math.max(g, 95);
      }
      const skillTotalYds = (p.totals?.recYds || 0) + (p.totals?.rushYds || 0);
      const skillTotalTDs = (p.totals?.recTDs || 0) + (p.totals?.rushTDs || 0) + (pos === 'QB' ? (p.totals?.passTDs || 0) : 0);
      if (isSkillRec) {
        if (skillTotalTDs >= 3 && skillTotalYds >= 175) g = Math.max(g, 90);
        else if (skillTotalTDs >= 2 && skillTotalYds >= 150) g = Math.max(g, 88);
      }
      if (pos === 'QB') {
        const yds = p.totals?.passYds || 0;
        const tds = p.totals?.passTDs || 0;
        const ints = p.totals?.passInts || 0;
        if (yds >= 300 && tds >= 3 && ints <= 1) g = Math.max(g, 92);
        else if (yds >= 250 && tds >= 2 && ints <= 1) g = Math.max(g, 90);
      }
      return { ...p, grade: Number(Math.min(99.9, g).toFixed(2)) };
    })
    .sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    });

  // Ensure front-seven interior roles (DT/MIKE/SAM/WILL/ILB/MLB/LB) can surface high when impactful
  (() => {
    const frontSet = new Set(['DT', 'MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL']);
    const fronts = spread
      .filter(p => frontSet.has((p.position || '').toUpperCase()))
      .map(p => {
        const impactLine = (p.totals?.defTacklesForLoss || 0) + (p.totals?.defSacks || 0);
        return { p, impactLine };
      })
      .sort((a, b) => {
        if (b.impactLine !== a.impactLine) return b.impactLine - a.impactLine;
        return (b.p.grade || 0) - (a.p.grade || 0);
      });
    const bumpOne = (entry, target) => {
      if (!entry) return;
      entry.p.grade = Math.max(entry.p.grade || 0, target);
    };
    bumpOne(fronts[0], 94); // best front-seven interior gets into mid-90s
    bumpOne(fronts[1], 91); // second best clears 90 band
  })();

  // Dedicated DT promotion: ensure 1-2 DTs can enter top 20 when impactful
  (() => {
    const dts = spread
      .filter(p => (p.position || '').toUpperCase() === 'DT')
      .sort((a, b) => {
        // Prefer higher grade, then sacks/TFL, then score
        const gradDiff = (b.grade || 0) - (a.grade || 0);
        if (gradDiff !== 0) return gradDiff;
        const impB = (b.totals?.defSacks || 0) + (b.totals?.defTacklesForLoss || 0);
        const impA = (a.totals?.defSacks || 0) + (a.totals?.defTacklesForLoss || 0);
        if (impB !== impA) return impB - impA;
        return (b.score || 0) - (a.score || 0);
      });
    const bump = (player, target) => {
      if (!player) return;
      player.grade = Math.max(player.grade || 0, target);
    };
    bump(dts[0], 92); // top DT into low 90s
    bump(dts[1], 89); // second DT into high 80s/low 90
  })();

  // Resort after late-stage promotions to preserve grade order
  spread.sort((a, b) => {
    if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
    return (b.score || 0) - (a.score || 0);
  });
  // Limit true elite grades: only the top 3 overall can sit at 95+ (any position qualifies)
  (() => {
    const sorted = [...spread].sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    });
    const eliteIds = new Set(sorted.slice(0, 3).map(p => p.id));
    for (let i = 0; i < spread.length; i++) {
      const p = spread[i];
      if (eliteIds.has(p.id)) {
        // Keep elite grades, but ensure they clear 95+
        const eliteGrade = Math.max(95, Math.min(99.8, p.grade || 0));
        spread[i] = { ...p, grade: Number(eliteGrade.toFixed(2)) };
        continue;
      }
      const g = p.grade || 0;
      // All non-elites must stay below 95
      const capped = g >= 95 ? 94.5 : g;
      spread[i] = { ...p, grade: Number(capped.toFixed(2)) };
    }
    // Clamp weekly peaks: most weeks should top out around 97
    const ranked = [...spread].sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    });
    if (ranked.length) {
      ranked[0].grade = Number(Math.min(ranked[0].grade || 0, 97.5).toFixed(2));
    }
    for (let i = 1; i < ranked.length; i++) {
      if ((ranked[i].grade || 0) > 97) {
        ranked[i].grade = Number(Math.min(ranked[i].grade, 96.9).toFixed(2));
      }
    }
    spread.length = 0;
    ranked.forEach(p => spread.push(p));
  })();

  // Deduplicate by rosterId/id, keeping the highest-graded instance
  (() => {
    const seen = new Map();
    spread.forEach(p => {
      const key = p.rosterId || p.id || `${p.name}-${p.teamId || ''}`;
      if (!key) return;
      const existing = seen.get(key);
      if (!existing || (p.grade || 0) > (existing.grade || 0)) {
        seen.set(key, p);
      }
    });
    const deduped = Array.from(seen.values()).sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    });
    spread.length = 0;
    deduped.forEach(p => spread.push(p));
  })();

  // Backfill if dedupe/caps dropped us below 100 entries
  if (spread.length < 100 && players) {
    const used = new Set(spread.map(p => p.rosterId || p.id || `${p.name}-${p.teamId || ''}`));
    const pool = Array.from(players.values())
      .filter(p => {
        const key = p.rosterId || p.id || `${p.name}-${p.teamId || ''}`;
        return key && !used.has(key);
      })
      .slice(0, 120);
    // Assign modest filler grades to reach 100 slots
    pool.forEach((p, idx) => {
      const key = p.rosterId || p.id || `${p.name}-${p.teamId || ''}`;
      if (spread.length >= 100) return;
      if (!key) return;
      const rosterInfo = rosterLookup.get(p.rosterId);
      const pos = (rosterInfo?.position || p.position || p.displayPos || 'UNK').toUpperCase();
      const fullName = rosterInfo?.fullName || p.name || p.fullName || 'Unknown';
      const teamId = p.teamId;
      const teamName = teamMap[teamId] || 'Unknown Team';
      const conf = confMap[teamId] || 'Unknown';
      const fillerGrade = Math.max(60, Math.min(78, 80 - idx * 0.15));
      spread.push({
        ...p,
        grade: Number(fillerGrade.toFixed(2)),
        score: p.score || fillerGrade,
        position: pos,
        displayPos: pos,
        name: fullName,
        team: teamName,
        conference: conf,
      });
      used.add(key);
    });
    spread.sort((a, b) => {
      if ((b.grade || 0) !== (a.grade || 0)) return (b.grade || 0) - (a.grade || 0);
      return (b.score || 0) - (a.score || 0);
    });
  }

  // Capture full graded list (all players, fully adjusted) before trimming to Top 100.
  // Also append any rostered players who had zero stats this week so every player is present.
  const seenIds = new Set(prelimAdjustedBoosted.map(p => p.rosterId || p.id));
  const allPlayersGraded = [...prelimAdjustedBoosted];
  rosterLookup.forEach((pl, rid) => {
    if (seenIds.has(rid)) return;
    const teamName = teamNameMap(snapshot)[pl.teamId] || 'Unknown Team';
    const conf = conferenceMap(snapshot)[pl.teamId] || 'Unknown';
    allPlayersGraded.push({
      id: rid,
      rosterId: rid,
      name: pl.fullName || 'Unknown Player',
      position: pl.position || 'UNK',
      displayPos: pl.position || 'UNK',
      teamId: pl.teamId,
      team: teamName,
      conference: conf,
      totals: {},
      statLine: 'No stats',
      grade: 60,
      score: 0,
      yearsPro: pl.yearsPro,
      isRookie: pl.isRookie,
      winPct: 0.5
    });
  });

  // Persist full graded list for the week (all players) using final adjusted grades
  if (snapshot?.leagueId) {
    try { saveWeeklyAll(snapshot.leagueId, weekIndex, allPlayersGraded); } catch { }
  }

  // Return trimmed Top 100 for callers
  return spread.slice(0, 100);
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

function loadWeeklyHistory(leagueId) {
  const dir = path.join(TOP_HISTORY_DIR, leagueId);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const history = [];
  files.forEach(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (data?.players) history.push({ ...data, top100: (data.players || []).slice(0, 100) });
    } catch { }
  });
  history.sort((a, b) => (Number(a.weekIndex) || 0) - (Number(b.weekIndex) || 0));
  return history;
}

function computeSeasonTop100FromHistory(leagueId) {
  const history = loadWeeklyHistory(leagueId);
  if (!history.length) return [];
  const agg = new Map(); // id -> data
  history.forEach(entry => {
    const week = Number(entry.weekIndex);
    (entry.top100 || []).forEach((p, idx) => {
      const id = p.id || `${p.name}-${p.teamId || ''}`;
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
        injuryHits: 0
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

  // scoring for season
  const seasonList = [];
  agg.forEach(v => {
    const avgGrade = v.grades.reduce((a, b) => a + b, 0) / Math.max(1, v.grades.length);
    const winPctAvg = v.winPctCount ? (v.winPctSum / v.winPctCount) : 0.5;
    const variance = (() => {
      const mean = avgGrade;
      const varSum = v.grades.reduce((acc, g) => acc + Math.pow(g - mean, 2), 0);
      return varSum / Math.max(1, v.grades.length);
    })();
    const std = Math.sqrt(variance);
    // Consistency > spikes: reward 90+ and 80+ streaks/occurrences, penalize variance
    const streak90Bonus = v.streak90 * 1.0;
    const streak80Bonus = v.streak80 * 0.4;
    const weeks90Bonus = v.weeks90 * 0.6;
    const weeks80Bonus = v.weeks80 * 0.25;
    const streakBonus = v.streak * 0.25; // general presence streak
    const appearanceBonus = v.appearances * 0.2;
    const rankBonus = (101 - v.bestRank) * 0.04;
    const injuryPenalty = v.injuryHits * 0.4;
    const variancePenalty = std * 0.7; // higher std = more volatile, penalize
    const score = avgGrade * 0.8
      + winPctAvg * 8
      + streak90Bonus + streak80Bonus + weeks90Bonus + weeks80Bonus
      + streakBonus + appearanceBonus + rankBonus
      - injuryPenalty - variancePenalty;
    // Derive a season grade (not just score) with caps
    const rawGrade = avgGrade
      + v.streak90 * 0.6
      + v.weeks90 * 0.2
      + v.streak80 * 0.2
      - std * 0.5;
    const seasonGrade = Math.max(70, Math.min(99, rawGrade));
    seasonList.push({
      id: v.id,
      name: v.name,
      position: v.position,
      team: v.team,
      teamId: v.teamId,
      avgGrade: Number(avgGrade.toFixed(2)),
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
      seasonGrade: Number(seasonGrade.toFixed(2))
    });
  });

  seasonList.sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0));
  const top = seasonList.slice(0, 100);
  // Cap elite grades so only 1–2 exceed 97
  if (top.length) {
    top[0].seasonGrade = Number(Math.min(top[0].seasonGrade || 0, 97.5).toFixed(2));
  }
  if (top.length > 1) {
    top[1].seasonGrade = Number(Math.min(top[1].seasonGrade || 0, 97.0).toFixed(2));
  }
  for (let i = 2; i < top.length; i++) {
    const g = top[i].seasonGrade || 0;
    top[i].seasonGrade = Number(Math.min(g, 96.5).toFixed(2));
  }
  return top;
}

function buildPageEmbed(list, page, leagueId) {
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);

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
    const grade = Number(gradeRaw).toFixed(1);
    const em = teamEmoji(p.team);
    return `${rank}. ${p.name} (${p.position}, ${p.team}) ${em ? em + ' ' : ''}— ${grade}`;
  });
  const embed = new EmbedBuilder()
    .setTitle('NFL Top 100')
    .setDescription(lines.join('\n') || 'No players available.')
    .setFooter({ text: `Page ${safePage}/${totalPages} • League ${leagueId}` });
  return { embed, totalPages, page: safePage };
}


async function updateTopPlayers(client, leagueId, snapshot, currentWeek, options = {}) {
  if (!snapshot || currentWeek === undefined || currentWeek === null) return;
  const { isWildcard = false, postChannelId = DEFAULT_POST_CHANNEL } = options;
  // Use previous week's stats (as requested)
  const targetWeekIdx = Math.max(0, Number(currentWeek) - 1);
  const list = computeWeeklyList(snapshot, targetWeekIdx);
  // Persist latest list for getTop100Page
  const state = loadJson(TOP_FILE, {});
  state[leagueId] = state[leagueId] || {};
  state[leagueId].top100 = list;
  saveJson(TOP_FILE, state);
  // Post to channel during Wildcard week
  if (isWildcard && client && postChannelId) {
    try {
      await postTop100(client, leagueId, list, postChannelId);
    } catch (err) {
      console.error('[updateTopPlayers] failed to post Top 100:', err);
    }
  }
  // Keep a running season Top 100 from history for end-of-year/season scope
  try {
    const seasonTop = computeSeasonTop100FromHistory(leagueId);
    state[leagueId].seasonTop100 = seasonTop.slice(0, 100);
    // Keep the latest weekly list trimmed as well (defensive)
    state[leagueId].top100 = (state[leagueId].top100 || []).slice(0, 100);
    saveJson(TOP_FILE, state);
  } catch (err) {
    console.warn('[updateTopPlayers] failed to compute season Top 100:', err?.message || err);
  }
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

export {
  computeWeeklyList,
  updateTopPlayers,
  getTop100Page,
  computeGradeFromRank,
  computeSeasonTop100FromHistory
};
