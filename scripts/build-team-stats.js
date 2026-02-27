#!/usr/bin/env node
// Build per-team season stats from the latest Madden league snapshot.
// Filters: latest seasonIndex, regular season only (stage=1), weeks <= 18.
// Output: data/madden/team_stats.json

import fs from 'fs';
import path from 'path';

const LEAGUES_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const OUTPUT = path.join(process.cwd(), 'data', 'madden', 'team_stats.json');

function latestLeagueFile() {
  if (!fs.existsSync(LEAGUES_DIR)) return null;
  const files = fs.readdirSync(LEAGUES_DIR).filter(f => f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(LEAGUES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(LEAGUES_DIR, files[0].f) : null;
}

function normalizeName(first, last, display) {
  return display || `${first || ''} ${last || ''}`.trim() || 'Player';
}

function aggregate(league) {
  const latestSeason = Math.max(...(league.weeklyStats || [{ seasonIndex: 0 }]).map(w => w.seasonIndex || 0));
  const teamStats = {};
  const rosterNameById = {};
  const playerTotals = {}; // pid -> {teamId, name, passYds, rushYds, recYds, sacks, ints}
  for (const [tidStr, rosterTeam] of Object.entries(league.rosters?.teams || {})) {
    for (const p of rosterTeam?.rosterInfoList || []) {
      rosterNameById[p.rosterId] = p.displayName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Player';
    }
  }
  const ensure = (tid) => {
    if (!teamStats[tid]) {
      const t = (league.teams?.leagueTeamInfoList || []).find(x => Number(x.teamId) === Number(tid)) || {};
      teamStats[tid] = {
        teamName: `${t.cityName || ''} ${t.nickName || ''}`.trim() || String(tid),
        seasonIndex: latestSeason,
        pass: { yds: 0, td: 0, int: 0, sacksTaken: 0, comp: 0, att: 0 },
        rush: { yds: 0, td: 0, att: 0 },
        rec: { yds: 0, td: 0 },
        def: { sacks: 0, ints: 0 },
        leaders: {}
      };
    }
    return teamStats[tid];
  };
  const leaderMax = (tid, key, val, name) => {
    const tgt = ensure(tid).leaders;
    if (val === undefined || val === null) return;
    if (!tgt[key] || val > tgt[key].val) tgt[key] = { name, val };
  };

  for (const week of (league.weeklyStats || [])) {
    const season = week.seasonIndex || 0;
    const stage = week.stage ?? week.stageIndex;
    const widx = week.weekIndex ?? 0;
    if (season !== latestSeason) continue;
    if (stage !== 1) continue; // regular season only
    if (widx > 18) continue;

    for (const p of week.passing?.playerPassingStatInfoList || []) {
      const tid = p.teamId; const t = ensure(tid);
      t.pass.yds += p.passYds;
      t.pass.td  += p.passTDs;
      t.pass.int += p.passInts;
      t.pass.sacksTaken += p.passSacks;
      t.pass.comp += p.passComp;
      t.pass.att  += p.passAtt;
      const pid = p.rosterId;
      const name = rosterNameById[pid] || p.fullName || 'Player';
      if (pid != null) {
        playerTotals[pid] = playerTotals[pid] || { teamId: tid, name };
        playerTotals[pid].passYds = (playerTotals[pid].passYds || 0) + p.passYds;
      }
    }
    for (const r of week.rushing?.playerRushingStatInfoList || []) {
      const tid = r.teamId; const t = ensure(tid);
      t.rush.yds += r.rushYds;
      t.rush.td  += r.rushTDs;
      t.rush.att += r.rushAtt;
      const pid = r.rosterId;
      const name = rosterNameById[pid] || r.fullName || 'Player';
      if (pid != null) {
        playerTotals[pid] = playerTotals[pid] || { teamId: tid, name };
        playerTotals[pid].rushYds = (playerTotals[pid].rushYds || 0) + r.rushYds;
      }
    }
    for (const r of week.receiving?.playerReceivingStatInfoList || []) {
      const tid = r.teamId; const t = ensure(tid);
      t.rec.yds += r.recYds;
      t.rec.td  += r.recTDs;
      const pid = r.rosterId;
      const name = rosterNameById[pid] || r.fullName || 'Player';
      if (pid != null) {
        playerTotals[pid] = playerTotals[pid] || { teamId: tid, name };
        playerTotals[pid].recYds = (playerTotals[pid].recYds || 0) + r.recYds;
      }
    }
    for (const d of week.defense?.playerDefensiveStatInfoList || []) {
      const tid = d.teamId; const t = ensure(tid);
      t.def.sacks += d.defSacks;
      t.def.ints  += d.defInts;
      const pid = d.rosterId;
      const name = rosterNameById[pid] || d.fullName || 'Player';
      if (pid != null) {
        playerTotals[pid] = playerTotals[pid] || { teamId: tid, name };
        playerTotals[pid].sacks = (playerTotals[pid].sacks || 0) + d.defSacks;
        playerTotals[pid].ints  = (playerTotals[pid].ints  || 0) + d.defInts;
      }
    }
  }

  // Compute leaders from playerTotals (season sums)
  for (const stats of Object.values(playerTotals)) {
    const tid = stats.teamId;
    const t = ensure(tid);
    if (stats.passYds !== undefined) leaderMax(tid, 'passYds', stats.passYds, stats.name);
    if (stats.rushYds !== undefined) leaderMax(tid, 'rushYds', stats.rushYds, stats.name);
    if (stats.recYds !== undefined) leaderMax(tid, 'recYds', stats.recYds, stats.name);
    if (stats.sacks   !== undefined) leaderMax(tid, 'defSacks', stats.sacks, stats.name);
    if (stats.ints    !== undefined) leaderMax(tid, 'defInts',  stats.ints,  stats.name);
  }

  return teamStats;
}

function main() {
  const lf = latestLeagueFile();
  if (!lf) {
    console.error('No league file found in', LEAGUES_DIR);
    process.exit(1);
  }
  const league = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const agg = aggregate(league);
  fs.writeFileSync(OUTPUT, JSON.stringify(agg, null, 2));
  console.log('Wrote', OUTPUT, 'with', Object.keys(agg).length, 'teams from', path.basename(lf));
}

main();
