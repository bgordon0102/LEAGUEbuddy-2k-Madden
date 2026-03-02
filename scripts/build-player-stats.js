#!/usr/bin/env node
// Build per-player season stats from the latest Madden league snapshot.
// Filters: latest seasonIndex, regular season only (stage=1), weeks <= 18.
// Output: data/madden/player_stats.json

import fs from 'fs';
import path from 'path';

const LEAGUES_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const OUTPUT = path.join(process.cwd(), 'data', 'madden', 'player_stats.json');

function latestLeagueFile() {
  if (!fs.existsSync(LEAGUES_DIR)) return null;
  const files = fs.readdirSync(LEAGUES_DIR).filter(f => f.endsWith('.json'))
    .map(f => ({ f, t: fs.statSync(path.join(LEAGUES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(LEAGUES_DIR, files[0].f) : null;
}

function buildPlayerStats(league) {
  const latestSeason = Math.max(...(league.weeklyStats || [{ seasonIndex: 0 }]).map(w => w.seasonIndex || 0));
  const players = {}; // rosterId -> stat object

  const teamById = Object.fromEntries((league.teams?.leagueTeamInfoList || []).map(t => [
    Number(t.teamId),
    {
      name: `${t.cityName || ''} ${t.nickName || ''}`.trim() || t.displayName || t.abbrName || String(t.teamId),
      nick: t.nickName || t.displayName || t.abbrName || String(t.teamId)
    }
  ]));

  // seed position and display names from roster snapshot
  for (const [tidStr, rosterTeam] of Object.entries(league.rosters?.teams || {})) {
    for (const p of rosterTeam?.rosterInfoList || []) {
      const pid = p.rosterId;
      if (pid == null) continue;
      const teamId = Number(tidStr);
      players[pid] = players[pid] || {
        rosterId: pid,
        name: p.displayName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Player',
        position: (p.position || p.position_1 || '').toUpperCase(),
        teamId,
        teamName: teamById[teamId]?.name || String(teamId),
        pass: { yds: 0, td: 0, int: 0, comp: 0, att: 0, sacksTaken: 0 },
        rush: { yds: 0, td: 0, att: 0 },
        rec: { yds: 0, td: 0, rec: 0 },
        def: { sacks: 0, ints: 0 },
        games: 0
      };
    }
  }

  const ensure = (pid, teamId) => {
    if (!players[pid]) {
      const t = teamById[teamId] || {};
      players[pid] = {
        rosterId: pid,
        name: 'Player',
        position: '',
        teamId,
        teamName: t.name || String(teamId),
        pass: { yds: 0, td: 0, int: 0, comp: 0, att: 0, sacksTaken: 0 },
        rush: { yds: 0, td: 0, att: 0 },
        rec: { yds: 0, td: 0, rec: 0 },
        def: { sacks: 0, ints: 0 },
        games: 0
      };
    }
    return players[pid];
  };

  for (const week of (league.weeklyStats || [])) {
    const season = week.seasonIndex || 0;
    const stage = week.stage ?? week.stageIndex;
    const widx = week.weekIndex ?? 0;
    if (season !== latestSeason) continue;
    if (stage !== 1) continue; // regular season only
    if (widx > 18) continue;

    const seenThisWeek = new Set();

    for (const p of week.passing?.playerPassingStatInfoList || []) {
      const pid = p.rosterId; if (pid == null) continue;
      const teamId = p.teamId;
      const tgt = ensure(pid, teamId);
      tgt.pass.yds += p.passYds;
      tgt.pass.td  += p.passTDs;
      tgt.pass.int += p.passInts;
      tgt.pass.comp += p.passComp;
      tgt.pass.att  += p.passAtt;
      tgt.pass.sacksTaken += p.passSacks;
      seenThisWeek.add(pid);
    }
    for (const r of week.rushing?.playerRushingStatInfoList || []) {
      const pid = r.rosterId; if (pid == null) continue;
      const teamId = r.teamId;
      const tgt = ensure(pid, teamId);
      tgt.rush.yds += r.rushYds;
      tgt.rush.td  += r.rushTDs;
      tgt.rush.att += r.rushAtt;
      seenThisWeek.add(pid);
    }
    for (const r of week.receiving?.playerReceivingStatInfoList || []) {
      const pid = r.rosterId; if (pid == null) continue;
      const teamId = r.teamId;
      const tgt = ensure(pid, teamId);
      tgt.rec.yds += r.recYds;
      tgt.rec.td  += r.recTDs;
      tgt.rec.rec += r.recRec;
      seenThisWeek.add(pid);
    }
    for (const d of week.defense?.playerDefensiveStatInfoList || []) {
      const pid = d.rosterId; if (pid == null) continue;
      const teamId = d.teamId;
      const tgt = ensure(pid, teamId);
      tgt.def.sacks += d.defSacks;
      tgt.def.ints  += d.defInts;
      seenThisWeek.add(pid);
    }

    // increment games for players who recorded any stat that week
    for (const pid of seenThisWeek) {
      if (players[pid]) players[pid].games += 1;
    }
  }

  // derive rate stats
  for (const p of Object.values(players)) {
    if (p.pass.att > 0) {
      p.pass.ypa = Number((p.pass.yds / p.pass.att).toFixed(2));
      p.pass.compPct = Number((p.pass.comp / p.pass.att * 100).toFixed(1));
    }
    if (p.rush.att > 0) p.rush.ypc = Number((p.rush.yds / p.rush.att).toFixed(2));
    if (p.rec.rec > 0) p.rec.ypr = Number((p.rec.yds / p.rec.rec).toFixed(2));
  }

  return players;
}

function main() {
  const lf = latestLeagueFile();
  if (!lf) {
    console.error('No league file found in', LEAGUES_DIR);
    process.exit(1);
  }
  const league = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const players = buildPlayerStats(league);
  fs.writeFileSync(OUTPUT, JSON.stringify(players, null, 2));
  console.log('Wrote', OUTPUT, 'with', Object.keys(players).length, 'players from', path.basename(lf));
}

main();
