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
  // --- Simplified positional balancing & rescale ---
  rawList.sort((a, b) => (b.score || 0) - (a.score || 0));

  const groupOfSimple = (posRaw = '') => {
    const pos = (posRaw || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['HB','RB','FB','TB'].includes(pos)) return 'RB';
    if (pos === 'WR') return 'WR';
    if (pos === 'TE') return 'TE';
    if (['LT','LG','C','RG','RT'].includes(pos)) return 'OL';
    const edge = ['LE','RE','ROLB','LOLB','EDGE','EDG','LEDG','REDG','REDGE','LEDGE','EDGE_R','EDGE_L','EDGE-R','EDGE-L','LDE','RDE','DE','OLB'];
    if (edge.includes(pos) || /EDGE/.test(pos)) return 'EDG';
    if (['MLB','ILB','LB','SAM','MIKE','WILL'].includes(pos)) return 'LB';
    if (['CB','FS','SS'].includes(pos)) return 'DB';
    if (['K','P'].includes(pos)) return 'SPECIAL';
    return 'OTHER';
  };

  const groupCap = { QB:10, RB:12, WR:20, TE:10, OL:8, EDG:14, LB:12, DB:20, SPECIAL:3, OTHER:6 };
  const capCount = {};
  const capped = [];
  for (const p of rawList) {
    const g = groupOfSimple(p.position);
    const cap = groupCap[g];
    if (cap !== undefined) {
      capCount[g] = (capCount[g] || 0);
      if (capCount[g] >= cap) continue;
      capCount[g] += 1;
    }
    capped.push(p);
    if (capped.length >= 200) break;
  }

  const queues = new Map();
  capped.forEach(p => {
    const g = groupOfSimple(p.position);
    if (!queues.has(g)) queues.set(g, []);
    queues.get(g).push(p);
  });
  const pattern = ['QB','RB','WR','WR','TE','OL','EDG','LB','DB','DB','SPECIAL','OTHER'];
  const balanced = [];
  while (balanced.length < 100) {
    let added = false;
    for (const g of pattern) {
      const q = queues.get(g);
      if (q && q.length) {
        balanced.push(q.shift());
        added = true;
        if (balanced.length >= 100) break;
      }
    }
    if (!added) break;
  }
  if (balanced.length < 100) {
    const rem = [];
    queues.forEach(q => rem.push(...q));
    rem.sort((a,b) => (b.score||0)-(a.score||0));
    balanced.push(...rem.slice(0, 100 - balanced.length));
  }

  const graded = balanced.map((p, idx) => ({ ...p, grade: computeGradeFromRank(idx + 1, balanced.length) }));
  const top100Raw = graded.slice(0, 100);
  const leader = top100Raw[0];
  const leaderGrade = Math.min(95, leader ? (leader.grade ?? leader.score ?? 95) : 95);
  const floor = 78;
  const ninetyCutCount = 12;
  const ninetyFloor = 90;
  const rescaled = top100Raw.map((p, idx, arr) => {
    if (arr.length <= ninetyCutCount) {
      const norm = idx / Math.max(1, arr.length - 1);
      const spanAll = Math.max(1, leaderGrade - floor);
      const gradeAll = leaderGrade - norm * spanAll;
      return { ...p, grade: Number(gradeAll.toFixed(1)) };
    }
    if (idx < ninetyCutCount) {
      const normTop = idx / Math.max(1, ninetyCutCount - 1);
      const spanTop = Math.max(0.1, leaderGrade - ninetyFloor);
      const gradeTop = leaderGrade - normTop * spanTop;
      return { ...p, grade: Number(gradeTop.toFixed(1)) };
    }
    const normTail = (idx - ninetyCutCount) / Math.max(1, (arr.length - ninetyCutCount - 1));
    const spanTail = Math.max(0.1, ninetyFloor - floor);
    const gradeTail = ninetyFloor - normTail * spanTail;
    return { ...p, grade: Number(gradeTail.toFixed(1)) };
  });
  if (process.env.MOCK_DEBUG) {
    const posTop = {}; rescaled.forEach(p => { posTop[p.position] = (posTop[p.position] || 0) + 1; });
    console.log('[top_players] post-balance counts', posTop);
    console.log('[top_players] top/bottom grades', rescaled[0]?.grade, rescaled[rescaled.length - 1]?.grade);
  }
  return rescaled;
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
  let dir = path.join(TOP_HISTORY_DIR, leagueId);
  if (!fs.existsSync(dir)) {
    const alt = path.join(TOP_HISTORY_DIR, `${leagueId}.json`);
    if (fs.existsSync(alt)) dir = alt;
  }
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const history = [];
  files.forEach(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const players = data?.players || data?.top100;
      if (Array.isArray(players)) {
        history.push({ ...data, players, top100: players.slice(0, 100) });
      }
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
    const streak90Bonus = v.streak90 * 1.1;
    const streak80Bonus = v.streak80 * 0.3;
    const weeks90Bonus = v.weeks90 * 0.9;
    const weeks80Bonus = v.weeks80 * 0.2;
    const streakBonus = v.streak * 0.2; // general presence streak
    const appearanceBonus = v.appearances * 0.4; // reward sustained play, less OL bias
    const rankBonus = (101 - v.bestRank) * 0.01; // mild single-week weight
    const injuryPenalty = v.injuryHits * 0.3;
    const variancePenalty = std * 1.0; // penalize volatility harder
    const score = avgGrade * 0.8
      + winPctAvg * 8
      + streak90Bonus + streak80Bonus + weeks90Bonus + weeks80Bonus
      + streakBonus + appearanceBonus + rankBonus
      - injuryPenalty - variancePenalty;
    // Derive a season grade (not just score) with caps
    let rawGrade = avgGrade
      + v.streak90 * 0.6
      + v.weeks90 * 0.3
      + v.streak80 * 0.15
      - std * 0.7;
    // Penalize very low appearances; clamp spike merchants
    // Appearance caps to avoid spike merchants, but keep a small spread
    if (v.appearances < 7) {
      rawGrade = Math.min(rawGrade, 84);
    } else if (v.appearances < 9) {
      rawGrade = Math.min(rawGrade, 88);
    }
    // Positional weighting
    const pos = (v.position || '').toUpperCase();
    const posAdj = (() => {
      if (pos === 'QB') return 1.7;
      if (pos === 'WR') return 1.2;
      if (['TE'].includes(pos)) return -0.5;
      if (['LT', 'LG', 'C', 'RG', 'RT', 'OL', 'HB', 'FB'].includes(pos)) return 0; // no nerf
      if (['CB', 'FS', 'SS', 'S', 'REDGE', 'LEDGE', 'EDGE', 'DT', 'DL'].includes(pos)) return 1.5; // stronger defensive lift to get into top 20
      if (['MIKE', 'WILL', 'SAM', 'LB'].includes(pos)) {
        const base = v.appearances >= 10 ? 4.5 : v.appearances >= 8 ? 3.0 : v.appearances >= 6 ? 1.0 : 0;
        const mult = 1 + 0.02 * v.weeks90 + 0.01 * v.streak90;
        const rankPen = 0.1 * Math.max(0, (v.bestRank || 0));
        let bonus = Math.max(0, Math.min(6, base * mult - rankPen));
        const spread = Math.max(
          -2,
          Math.min(3, 0.12 * v.weeks90 + 0.04 * v.weeks80 - 0.05 * Math.max(0, v.bestRank || 0))
        );
        // Extra LB jitter to break clusters at the bottom
        const lbJitter = Math.max(-1.5, Math.min(1.5, 0.2 * (v.weeks80 || 0) + 0.25 * (v.weeks90 || 0) - 0.05 * (v.bestRank || 0)));
        // MIKE-specific bump to help top-range representation
        if (pos === 'MIKE') bonus += 0.8;
        return bonus + spread + lbJitter;
      }
      return 0;
    })();
    rawGrade += posAdj;
    // Additional LB caps by elite weeks to avoid clustering
    if (['MIKE', 'WILL', 'SAM', 'LB'].includes(pos)) {
      const baseCap = v.appearances >= 10 ? 87 : 84;
      if (v.weeks90 <= 1) rawGrade = Math.min(rawGrade, baseCap);
      else if (v.weeks90 <= 2) rawGrade = Math.min(rawGrade, baseCap + 1);
      if (v.appearances >= 10) {
        const lift = 0.5 * (v.weeks80 || 0) + 0.6 * (v.weeks90 || 0);
        rawGrade = Math.max(rawGrade, 85 + Math.min(3.0, lift));
      }
    }
    // Volume star bonus for any player with strong availability and elite weeks
    if (v.appearances >= 12 && v.weeks90 >= 4) {
      rawGrade += 2.0;
    }
    // (Removed low weeks90 penalty to avoid flat grouping)
    // Extra clamp for spike + very low appearances handled above
    // Clamp short-season DL/EDGE/TE
    if (['REDGE', 'LEDGE', 'EDGE', 'DT', 'DL', 'TE'].includes(pos) && v.appearances < 8) {
      rawGrade = Math.min(rawGrade, 84);
    }
    // MVP-type bump for elite QB seasons
    if (pos === 'QB' && v.bestRank === 1 && v.weeks90 >= 3) rawGrade += 5;
    let seasonGrade = Math.max(70, Math.min(99, rawGrade));
    // Tiny deterministic spread to avoid big tie blocks (mid tiers only)
    if (seasonGrade < 90 && seasonGrade > 78) {
      const spread = (v.weeks80 || 0) * 0.04 +
        (v.weeks90 || 0) * 0.02 +
        (v.appearances || 0) * 0.01 -
        (v.bestRank || 0) * 0.01;
      const jitter = Math.max(-1.2, Math.min(1.2, spread));
      // Position micro-bias to break caps without huge swings
      let micro = 0;
      if (['LT', 'LG', 'C', 'RG', 'RT', 'OL'].includes(pos)) {
        micro += (v.weeks80 || 0) * 0.12;
      } else if (['CB', 'FS', 'SS', 'S'].includes(pos)) {
        micro += (v.weeks80 || 0) * 0.10 + (v.weeks90 || 0) * 0.04;
      } else if (['REDGE', 'LEDGE', 'EDGE', 'DT', 'DL'].includes(pos)) {
        micro += (v.weeks90 || 0) * 0.08;
      } else if (['MIKE', 'WILL', 'SAM', 'LB'].includes(pos)) {
        micro += (v.weeks90 || 0) * 0.06;
      } else if (['HB', 'FB'].includes(pos)) {
        micro += (v.weeks90 || 0) * 0.05;
      }
      micro = Math.max(-1.2, Math.min(1.2, micro));
      seasonGrade = Math.max(70, Math.min(99, seasonGrade + jitter + micro));
    }
    // Clamp score for low appearances to avoid high score ordering
    let adjScore = score + (v.appearances * 0.02 - 0.1);
    if (v.appearances < 7) {
      adjScore = Math.min(adjScore, 84);
      seasonGrade = Math.min(seasonGrade, 84);
    } else if (v.appearances < 9) {
      adjScore = Math.min(adjScore, 88);
      seasonGrade = Math.min(seasonGrade, 88);
    }
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
      seasonScore: Number(adjScore.toFixed(3)),
      seasonGrade: Number(seasonGrade.toFixed(2))
    });
  });

  seasonList.sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0));
  let top = seasonList.slice(0, 100);
  // Cap elite grades so only 1–2 exceed ~97
  if (top.length) {
    top[0].seasonGrade = Number(Math.min(top[0].seasonGrade || 0, 97.0).toFixed(2));
  }
  if (top.length > 1) {
    top[1].seasonGrade = Number(Math.min(top[1].seasonGrade || 0, 96.5).toFixed(2));
  }
  for (let i = 2; i < top.length; i++) {
    const g = top[i].seasonGrade || 0;
    top[i].seasonGrade = Number(Math.min(g, 95.8).toFixed(2));
  }
  // Sort by seasonGrade, then seasonScore
  top.sort((a, b) => {
    const g = Number(b.seasonGrade || 0) - Number(a.seasonGrade || 0);
    if (Math.abs(g) > 0.0001) return g;
    return Number(b.seasonScore || 0) - Number(a.seasonScore || 0);
  });
  // Ensure a healthy defensive representation (~40 in top 100)
  const DEF_POS = new Set(['CB', 'FS', 'SS', 'S', 'REDGE', 'LEDGE', 'EDGE', 'DT', 'DL', 'MIKE', 'WILL', 'SAM', 'LB']);
  const defCount = top.filter(p => DEF_POS.has((p.position || '').toUpperCase())).length;
  if (defCount < 40) {
    const bump = Math.min(1.2, 0.3 + 0.05 * (40 - defCount)); // scaled bump toward target
    top = top.map(p => {
      if (DEF_POS.has((p.position || '').toUpperCase())) {
        p.seasonGrade = Number(Math.min(99, (p.seasonGrade || 0) + bump).toFixed(2));
      }
      return p;
    });
    top.sort((a, b) => {
      const g = Number(b.seasonGrade || 0) - Number(a.seasonGrade || 0);
      if (Math.abs(g) > 0.0001) return g;
      return Number(b.seasonScore || 0) - Number(a.seasonScore || 0);
    });
  }
  // Target top-30 defense: if defenders in top 30 < 8, bump best defenders in ranks 31–60
  const top30Def = top.slice(0, 30).filter(p => DEF_POS.has((p.position || '').toUpperCase())).length;
  if (top30Def < 8) {
    const needs = 8 - top30Def;
    const candidates = top
      .map((p, idx) => ({ p, idx }))
      .filter(({ p, idx }) => idx >= 30 && idx < 70 && DEF_POS.has((p.position || '').toUpperCase()))
      .slice(0, needs * 3); // take up to 3x needed for smoothing
    candidates.forEach(({ p }) => {
      p.seasonGrade = Number(Math.min(96, (p.seasonGrade || 0) + 0.8).toFixed(2));
    });
    top.sort((a, b) => {
      const g = Number(b.seasonGrade || 0) - Number(a.seasonGrade || 0);
      if (Math.abs(g) > 0.0001) return g;
      return Number(b.seasonScore || 0) - Number(a.seasonScore || 0);
    });
  }
  // Elite defense boost: top 10 defenders by seasonScore get a slight bump to help top-20 presence
  const topDefByScore = [...top]
    .filter(p => DEF_POS.has((p.position || '').toUpperCase()))
    .sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0))
    .slice(0, 10);
  topDefByScore.forEach((p, idx) => {
    const baseBump = 0.5;
    const extra = idx < 5 ? 0.3 : 0; // extra bump for top 5 defenders
    p.seasonGrade = Number(Math.min(97, (p.seasonGrade || 0) + baseBump + extra).toFixed(2));
  });
  // Push a few elite defenders into the very top if still under-represented
  const top20Def = top.slice(0, 20).filter(p => DEF_POS.has((p.position || '').toUpperCase())).length;
  if (top20Def < 5) {
    const target = 5 - top20Def;
    const eliteDefs = [...top]
      .filter(p => DEF_POS.has((p.position || '').toUpperCase()))
      .sort((a, b) => (b.seasonScore || 0) - (a.seasonScore || 0))
      .slice(0, Math.max(3, target + 2));
    eliteDefs.forEach((p, idx) => {
      const bump = 0.8 - idx * 0.1; // decreasing bump
      p.seasonGrade = Number(Math.min(97, (p.seasonGrade || 0) + bump).toFixed(2));
    });
  }
  // If still short on defenders in top 20, pull up a couple more from 21–40 when close in grade
  const defTop20After = top.slice(0, 20).filter(p => DEF_POS.has((p.position || '').toUpperCase())).length;
  if (defTop20After < 4) {
    const need = 4 - defTop20After;
    const candidates = top
      .map((p, idx) => ({ p, idx }))
      .filter(({ p, idx }) => idx >= 20 && idx < 40 && DEF_POS.has((p.position || '').toUpperCase()))
      .sort((a, b) => (b.p.seasonScore || 0) - (a.p.seasonScore || 0))
      .slice(0, need);
    candidates.forEach(({ p }, i) => {
      const bump = 0.4 - i * 0.05;
      p.seasonGrade = Number(Math.min(97, (p.seasonGrade || 0) + bump).toFixed(2));
    });
  }
  // Deterministic jitter to break the 84 wall
  const jitter = (s, scale = 1.2) => {
    const str = s || '';
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 100000;
    return ((h / 100000) - 0.5) * 2 * scale;
  };
  top = top.map((p, idx) => {
    const g = p.seasonGrade || 0;
    if (g >= 82.5 && g <= 85.5) {
      p.seasonGrade = Number((g + jitter(p.id || p.name || '', 0.8)).toFixed(2));
    }
    // Tiny rank-based offset to avoid equal grades
    p.seasonGrade = Number((p.seasonGrade - idx * 0.0007).toFixed(3));
    // Additional spread for lower ranks to avoid plateaus
    if (idx >= 40) {
      p.seasonGrade = Number((p.seasonGrade - (idx - 39) * 0.015).toFixed(3));
    }
    return p;
  });
  top.sort((a, b) => {
    const g = Number(b.seasonGrade || 0) - Number(a.seasonGrade || 0);
    if (Math.abs(g) > 0.0001) return g;
    return Number(b.seasonScore || 0) - Number(a.seasonScore || 0);
  });
  // Debug dump if enabled
  if (process.env.TOP100_DEBUG) {
    console.log('[seasonTop100][debug] weekly history files used:', history.length);
    console.log('[seasonTop100][debug] top 20 preview:');
    top.slice(0, 20).forEach((p, idx) => {
      console.log(
        `${idx + 1}. ${p.name} (${p.position}, ${p.team || p.teamId || 'UNK'}) ` +
        `grade=${p.seasonGrade} score=${p.seasonScore} avg=${p.avgGrade} ` +
        `bestRank=${p.bestRank} weeks90=${p.weeks90} streak90=${p.streak90} appearances=${p.appearances}`
      );
    });
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
    const grade = Number(gradeRaw).toFixed(2);
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
