import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

// Utility: pick latest league snapshot
function getLatestLeagueFile() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files.length ? path.join(dir, files[0].f) : null;
}

// Build strength of schedule from schedule + standings
function buildSoS(league) {
  const teamInfo = league.teams?.leagueTeamInfoList || [];
  const standings = league.standings?.teamStandingInfoList || [];
  const schedule = league.schedule?.schedules || [];
  const teamById = Object.fromEntries(teamInfo.map(t => [t.teamId, t]));
  const record = Object.fromEntries(
    standings.map(t => [t.teamId, {
      w: t.totalWins,
      l: t.totalLosses,
      t: t.totalTies
    }])
  );

  const regGames = schedule.filter(g => g.status === 1 && g.stageIndex === 1); // regular season
  const gamesByTeam = {};
  for (const g of regGames) {
    const { homeTeamId: h, awayTeamId: a, homeScore: hs, awayScore: as } = g;
    gamesByTeam[h] = gamesByTeam[h] || [];
    gamesByTeam[a] = gamesByTeam[a] || [];
    gamesByTeam[h].push({ opp: a, result: hs > as ? 'W' : hs < as ? 'L' : 'T' });
    gamesByTeam[a].push({ opp: h, result: as > hs ? 'W' : as < hs ? 'L' : 'T' });
  }

  const sos = {};
  for (const tid of Object.keys(teamById).map(Number)) {
    const games = gamesByTeam[tid] || [];
    let oppW = 0, oppL = 0, oppT = 0;
    for (const g of games) {
      const rec = record[g.opp] || { w: 0, l: 0, t: 0 };
      let w = rec.w, l = rec.l, t = rec.t;
      // remove the head-to-head game
      if (g.result === 'W') l -= 1;
      else if (g.result === 'L') w -= 1;
      else t -= 1;
      oppW += w; oppL += l; oppT += t;
    }
    const denom = oppW + oppL + oppT;
    sos[tid] = denom ? oppW / denom : 0;
  }
  return sos;
}

function draftOrder(league) {
  const standings = league.standings?.teamStandingInfoList || [];
  const teams = standings.map(t => ({
    id: t.teamId,
    name: t.teamName,
    nick: t.teamNickName,
    w: t.totalWins,
    l: t.totalLosses,
    ties: t.totalTies,
    playoff: t.playoffStatus || 0,
    net: t.netPts || 0,
    pf: t.ptsFor || 0,
    sos: 0 // unused
  }));

  const nonPlayoff = teams.filter(t => t.playoff === 0);
  const playoff = teams.filter(t => t.playoff !== 0);

  const cmp = (a, b) => {
    if (a.w !== b.w) return a.w - b.w;            // fewer wins first
    if (a.l !== b.l) return b.l - a.l;            // more losses first
    if (a.net !== b.net) return a.net - b.net;    // lower net points first
    if (a.pf !== b.pf) return a.pf - b.pf;        // lower points for next
    return 0;
  };

  const order = [
    ...nonPlayoff.sort(cmp),
    ...playoff.sort(cmp),
  ];
  return order.slice(0, 32);
}

// Pick trades/forfeitures (manual overrides)
function applyPickTrades(order) {
  // map: original pick owner nickname -> new owner (full name) plus via tag
  const overrides = {
    Falcons: { owner: 'Los Angeles Rams', via: 'ATL' },
    Jaguars: { owner: 'Cleveland Browns', via: 'JAX' },
    Jags: { owner: 'Cleveland Browns', via: 'JAX' },
    Colts: { owner: 'New York Jets', via: 'IND' },
    Pack: { owner: 'Dallas Cowboys', via: 'GB' },
    Packers: { owner: 'Dallas Cowboys', via: 'GB' },
  };
  return order.map(pick => {
    const key = pick.name || pick.nick || '';
    const o = overrides[key] || overrides[key?.trim?.()];
    return o ? { ...pick, name: o.owner, via: o.via } : pick;
  });
}

function loadDraftClass() {
  const dir = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().includes('cus') && f.toLowerCase().includes('big board') && f.endsWith('.json'))
    .sort();
  if (!files.length) return [];
  const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const players = Object.values(data).filter(p => p && p.name);
  players.sort((a, b) => (a.RNK || a.rank || a.order || 9999) - (b.RNK || b.rank || b.order || 9999));
  return players;
}

function loadTeamEmojis() {
  const file = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  } catch {
    return {};
  }
}

function formatTeamEmoji(teamName, emojiMap) {
  const parts = (teamName || '').toLowerCase().split(' ');
  const mascot = parts[parts.length - 1];
  const nick = parts.slice(1).join(' '); // handles things like "Green Bay Pack"
  const aliasMap = {
    'bolts': 'chargers',
    'phins': 'dolphins',
    'pack': 'packers',
    'jags': 'jaguars'
  };
  const keyList = [
    mascot,
    teamName?.toLowerCase(),
    nick,
    nick.replace(/\s+/g, ''),
    aliasMap[mascot],
    aliasMap[nick]
  ];
  const id = keyList.map(k => k && emojiMap[k]).find(Boolean);
  if (!id) return '';
  const name = mascot.replace(/[^a-z0-9]/g, '');
  return `<:${name}:${id}>`;
}

// --- Team needs heuristics ---
function deriveTeamNeeds(league) {
  const rosters = league.rosters?.teams || {};
  const teamInfo = league.teams?.leagueTeamInfoList || [];
  const nameById = Object.fromEntries(teamInfo.map(t => [Number(t.teamId), `${t.cityName} ${t.nickName}`]));
  const standings = league.standings?.teamStandingInfoList || [];
  const pfMap = Object.fromEntries(standings.map(s => [Number(s.teamId), s.ptsFor || 0]));
  const netMap = Object.fromEntries(standings.map(s => [Number(s.teamId), s.netPts || 0]));
  const paMap = Object.fromEntries(standings.map(s => [Number(s.teamId), (s.ptsFor || 0) - (s.netPts || 0)]));
  const pfRank = Object.fromEntries([...standings]
    .sort((a, b) => (a.ptsFor || 0) - (b.ptsFor || 0))
    .map((t, i) => [Number(t.teamId), i + 1]));
  const paRank = Object.fromEntries([...standings]
    .sort((a, b) => ((b.ptsFor || 0) - (b.netPts || 0)) - ((a.ptsFor || 0) - (a.netPts || 0))) // highest PA worst
    .map((t, i) => [Number(t.teamId), i + 1]));
  // No more QB_FORCE_LIST or QB_LOCKED_LIST; all teams use dynamic QB need logic
  // Teams with a highlighted need at RB (manual nudge for low rushing)
  const RB_MANUAL = new Set(['Kansas City Chiefs'].map(s => s.toLowerCase()));

  const needsByTeam = {};
  const positionGroup = (pos = '') => {
    const p = pos.toUpperCase();
    if (p === 'QB') return 'QB';
    if (['LT', 'RT'].includes(p)) return 'OT';
    if (['LG', 'C', 'RG'].includes(p)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(p)) return 'EDGE';
    if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(p)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(p)) return 'LB';
    if (['CB'].includes(p)) return 'CB';
    if (['FS', 'SS'].includes(p)) return 'S';
    if (['WR'].includes(p)) return 'WR';
    if (['HB', 'RB', 'FB'].includes(p)) return 'RB';
    return 'OTHER';
  };
  const getMetricOvr = (p) => p.playerBestOvr ?? p.teamSchemeOvr ?? p.overallRating ?? p.playerSchemeOvr ?? 0;
  const getYearsLeft = (p) => p.contractYearsLeft ?? p.contractLength ?? 0;

  for (const [tidStr, roster] of Object.entries(rosters)) {
    const tid = Number(tidStr);
    const players = roster?.rosterInfoList || [];
    const byGroup = {};
    for (const p of players) {
      const g = positionGroup(p.position);
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(p);
    }
    const teamNameKey = nameById[tid] || tidStr;
    // Calculate average OVR or depth for each group
    const groupStats = {};
    const allGroups = ['QB', 'OT', 'IOL', 'EDGE', 'DT', 'LB', 'CB', 'S', 'WR', 'RB'];
    for (const group of allGroups) {
      const groupPlayers = byGroup[group] || [];
      if (group === 'OL') {
        // For OL, combine all OL positions
        const olPositions = ['LT', 'LG', 'C', 'RG', 'RT'];
        const olPlayers = players.filter(p => olPositions.includes((p.position || '').toUpperCase()));
        groupStats['OL'] = {
          count: olPlayers.length,
          avgOvr: olPlayers.length ? olPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / olPlayers.length : 0
        };
        continue;
      }
      if (group === 'RB') {
        // For RB, include HB, RB, FB
        const rbPlayers = players.filter(p => ['HB', 'RB', 'FB'].includes((p.position || '').toUpperCase()));
        groupStats['RB'] = {
          count: rbPlayers.length,
          avgOvr: rbPlayers.length ? rbPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / rbPlayers.length : 0
        };
        continue;
      }
      groupStats[group] = {
        count: groupPlayers.length,
        avgOvr: groupPlayers.length ? groupPlayers.reduce((sum, p) => sum + getMetricOvr(p), 0) / groupPlayers.length : 0
      };
    }

    // Dynamic QB need logic (consider starter quality, depth, age, contract)
    let qbNeed = false;
    let qbSeverity = 0; // 0 = no need, 30-59 = depth/mid, 60+ = glaring
    const qbPlayers = (byGroup['QB'] || []).sort((a, b) => getMetricOvr(b) - getMetricOvr(a));
    const bestQB = qbPlayers[0];
    const secondQB = qbPlayers[1];
    const bestOvr = bestQB ? getMetricOvr(bestQB) : 0;
    const secondOvr = secondQB ? getMetricOvr(secondQB) : 0;
    const qbCount = qbPlayers.length;

    if (qbCount === 0) {
      qbNeed = true; qbSeverity = 100;
    } else {
      const yearsLeft = bestQB ? getYearsLeft(bestQB) : 0;
      const age = bestQB?.age ?? 0;

      // Franchise lockouts (young/prime starters with term)
      if (bestOvr >= 88 && yearsLeft >= 2 && age <= 31) {
        qbNeed = false; qbSeverity = 0;
      } else if (bestOvr >= 85 && yearsLeft >= 2 && age <= 30 && secondOvr >= 68) {
        qbNeed = false; qbSeverity = 20; // depth only
      } else if (bestOvr >= 83 && yearsLeft >= 2 && age <= 31 && secondOvr >= 70) {
        qbNeed = false; qbSeverity = 30; // depth only
      } else if (bestOvr >= 82 && yearsLeft >= 2 && age <= 33 && secondOvr >= 72) {
        qbNeed = false; qbSeverity = 35; // depth only
      } else if (bestOvr >= 80 && yearsLeft >= 2 && age <= 33 && secondOvr >= 70) {
        qbNeed = false; qbSeverity = 40; // depth only
      } else if (bestOvr >= 78 && yearsLeft >= 3 && age <= 25 && secondOvr >= 68) {
        qbNeed = false; qbSeverity = 25; // young starter with runway; depth only
      } else {
        // Solid starter but thin depth (keep QB as depth need, not top)
        if (bestOvr >= 82 && yearsLeft >= 2 && age <= 30) {
          qbNeed = false; qbSeverity = 45; // depth flag
        } else {
        // Needs or aging/weak depth scenarios
        qbNeed = true;
        qbSeverity = 70;
        if (bestOvr < 75) qbSeverity += 20;
        if (secondOvr < 70) qbSeverity += 15;
        if (yearsLeft <= 1) qbSeverity += 10;
        if (age >= 32) qbSeverity += 10;
        qbSeverity = Math.min(100, qbSeverity);
        }
      }
    }

    // For each group, create a "need score" (higher score = higher need)
    const needScores = allGroups.map(group => {
      const stat = groupStats[group];
      // Penalize for low count and low OVR
      let score = 100 - (stat.avgOvr || 0) + (stat.count < 2 ? 10 : 0);
      // QB special handling
      if (group === 'QB') {
        if (qbNeed) {
          score += qbSeverity + 40; // raise if real need
        } else if (qbSeverity >= 30) {
          // depth-only: allow mid-board placement (slots 2-5)
          score += qbSeverity;
        } else {
          score -= 250; // strong lockout, bury QB
        }
      }
      return { group, score };
    });
    // Sort by highest need (lowest avgOvr, lowest count, QB lockout)
    needScores.sort((a, b) => b.score - a.score);
    // Take top 5 needs
    const needs = needScores.slice(0, 5).map(n => n.group);
    // Normalize team name for consistent lookup
    const teamNameNorm = (nameById[tid] || tidStr).toLowerCase().replace(/[^a-z0-9]/g, '');
    needsByTeam[teamNameNorm] = needs;
  }
  return needsByTeam;
}

function prospectGroup(player) {
  const pos = (player.position || player.position_1 || '').toUpperCase();
  if (pos === 'QB') return 'QB';
  if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) return 'OL';
  if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(pos)) return 'EDGE';
  if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
  if (pos === 'CB') return 'CB';
  if (['FS', 'SS'].includes(pos)) return 'S';
  if (pos === 'WR') return 'WR';
  if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
  return 'BPA';
}

export const data = new SlashCommandBuilder()
  .setName('madden-mockdraft')
  .setDescription('Show a mock draft for the top 32 picks using current standings and the latest draft class');

export async function execute(interaction) {
  const leagueFile = getLatestLeagueFile();
  if (!leagueFile) {
    await interaction.reply({ content: 'No league snapshot found in data/madden/leagues.', ephemeral: true });
    return;
  }
  const league = JSON.parse(fs.readFileSync(leagueFile, 'utf8'));
  const rawOrder = draftOrder(league);
  // Debug: Show draft order and nicknames
  console.log('--- MOCK DRAFT ORDER ---');
  rawOrder.forEach((team, idx) => {
    console.log(`${idx + 1}: name='${team.name}' nick='${team.nick}'`);
  });
  const order = applyPickTrades(rawOrder);
  const needs = deriveTeamNeeds(league);
  // Debug: Log all normalized team names from draft order and needs map
  const draftOrderNormNames = order.map(team => ({ raw: team.name, norm: (team.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') }));
  const needsMapNormNames = Object.keys(needs);
  console.log('--- NORMALIZED TEAM NAMES IN DRAFT ORDER ---');
  draftOrderNormNames.forEach(t => console.log(`DraftOrder: raw='${t.raw}' norm='${t.norm}'`));
  console.log('--- NORMALIZED TEAM NAMES IN NEEDS MAP ---');
  needsMapNormNames.forEach(n => console.log(`NeedsMap: norm='${n}'`));
  // Debug: Show which teams are allowed to take a QB
  console.log('--- QB NEED DEBUG ---');
  for (const team of order) {
    const teamNameNorm = (team.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const teamNeeds = needs[teamNameNorm] || [];
    const hasQBNeed = teamNeeds.includes('QB');
    console.log(`${team.name}: QB need = ${hasQBNeed ? 'YES' : 'NO'} | Needs: [${teamNeeds.join(', ')}]`);
  }
  const prospects = loadDraftClass();
  if (!prospects.length) {
    await interaction.reply({ content: 'No Madden draft class found.', ephemeral: true });
    return;
  }
  const emojis = loadTeamEmojis();

  // Assign players based on team needs with light reach logic
  const available = [...prospects];
  const picks = [];
  const priority = ['QB', 'OL_T', 'OL_I', 'OL', 'EDGE', 'LB', 'CB', 'WR', 'RB', 'BPA'];
  const needWeight = Object.fromEntries(priority.map((n, i) => [n, 14 - i * 2])); // stronger need => larger weight

  for (const team of order) {
    const teamNameNorm = (team.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const teamNeeds = needs[teamNameNorm] || ['BPA'];
    let bestIdx = -1;
    let bestScore = Infinity;

    for (let i = 0; i < available.length; i++) {
      const p = available[i];
      const g = prospectGroup(p);
      const pos = (p.position || p.position_1 || '').toUpperCase();
      const isT = ['LT', 'RT'].includes(pos);
      const isI = ['LG', 'RG', 'C'].includes(pos);

      // Prevent teams without a QB need from taking a QB
      if (g === 'QB' && !teamNeeds.includes('QB')) continue;

      // base value: board position
      let score = i;

      // need bonus
      for (const need of priority) {
        if (!teamNeeds.includes(need)) continue;
        if (need === 'QB' && g === 'QB') score -= needWeight[need];
        else if (need === 'OL_T' && isT) score -= needWeight[need];
        else if (need === 'OL_I' && isI) score -= needWeight[need];
        else if (need === 'OL' && (isT || isI)) score -= needWeight[need] * 0.7;
        else if (need === 'EDGE' && g === 'EDGE') score -= needWeight[need];
        else if (need === 'LB' && g === 'LB') score -= needWeight[need] * 0.85;
        else if (need === 'CB' && g === 'CB') score -= needWeight[need] * 0.8;
        else if (need === 'WR' && g === 'WR') score -= needWeight[need] * 0.8;
        else if (need === 'RB' && ['HB', 'RB', 'FB'].includes(pos)) score -= needWeight[need];
        else if (need === 'BPA') score -= needWeight[need] * 0.2;
      }

      // de-prioritize RB unless nothing else fits
      if (['HB', 'RB', 'FB'].includes(pos) && !teamNeeds.includes('RB')) score += 10;

      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
      if (i > 70 && bestIdx !== -1) break; // allow some reaches but stop deep scan
    }

    // If no valid pick found (e.g., all QBs but team doesn't need QB), pick first non-QB
    let chosen;
    if (bestIdx !== -1) {
      chosen = available.splice(bestIdx, 1)[0];
    } else {
      // fallback: pick first available non-QB
      const fallbackIdx = available.findIndex(p => prospectGroup(p) !== 'QB');
      chosen = fallbackIdx !== -1 ? available.splice(fallbackIdx, 1)[0] : available.shift();
    }
    const emoji = formatTeamEmoji(team.name, emojis);
    const pos = chosen?.position || chosen?.position_1 || '';
    const via = team.via ? ` (via ${team.via})` : '';
    const line = `${picks.length + 1}. ${emoji ? emoji + ' ' : ''}${team.name}${via} — ${chosen?.name || 'TBD'} (${pos || 'POS'})`;
    picks.push(line);

    // Debug: Log top 5 needs and who was picked
    const topNeeds = teamNeeds.slice(0, 5).join(', ');
    const pickedName = chosen?.name || 'TBD';
    const pickedPos = pos || 'POS';
    console.log(`[MOCKDRAFT] ${team.name}: Top 5 Needs: [${topNeeds}] | Picked: ${pickedName} (${pickedPos})`);
  }

  const embed = new EmbedBuilder()
    .setTitle('Madden Mock Draft (Picks 1–32)')
    .setDescription(picks.join('\n'))
    .setColor(0x1e90ff)
    .setFooter({ text: `Snapshot: ${path.basename(leagueFile)}` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export { deriveTeamNeeds, loadTeamEmojis, formatTeamEmoji };
export default { data, execute };
