import http from 'http';
import fs from 'fs';
import path from 'path';

const ENABLED = (process.env.SNALLA_SIDECAR_AUTOSTART ?? 'true').toLowerCase() !== 'false';
const PORT = Number(process.env.SNALLA_SIDECAR_PORT || 8090);
const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');

function loadLeague(leagueId) {
  try {
    const raw = fs.readFileSync(path.join(LEAGUE_DIR, `${leagueId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeWeek(league) {
  if (!league) return null;
  const week = league.currentWeek ?? league.info?.careerHubInfo?.seasonInfo?.seasonWeek ?? null;
  const stageVal = league.stage ?? league.info?.careerHubInfo?.seasonInfo?.seasonStage ?? 1;
  const stage = stageVal === 0 ? 'preseason' : 'season';
  return {
    week,
    stage,
    seasonInfo: league.info?.careerHubInfo?.seasonInfo ?? null,
    fetchedAt: league.fetchedAt || new Date().toISOString(),
  };
}

function scheduleList(league) {
  if (!league) return { schedules: [], fetchedAt: new Date().toISOString() };
  return {
    schedules: league.schedule?.schedules || [],
    fetchedAt: league.fetchedAt || new Date().toISOString(),
  };
}

function filterScheduleByWeek(schedule, week) {
  if (!Array.isArray(schedule?.schedules)) return [];
  return schedule.schedules.filter(game => {
    const wk = game.weekIndex ?? game.week ?? game.seasonWeek ?? null;
    return wk === Number(week);
  });
}

export function startLocalSidecar() {
  if (!ENABLED) {
    console.log('[madden-sidecar] Disabled (SNALLA_SIDECAR_AUTOSTART=false)');
    return null;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'league' && parts[1]) {
      const leagueId = parts[1];
      const league = loadLeague(leagueId);
      if (!league) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'league not found' }));
        return;
      }
      // /league/:id/week
      if (parts.length === 3 && parts[2] === 'week' && req.method === 'GET') {
        const wk = normalizeWeek(league);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...wk }));
        return;
      }
      // /league/:id/schedule
      if (parts.length === 3 && parts[2] === 'schedule' && req.method === 'GET') {
        const sched = scheduleList(league);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...sched }));
        return;
      }
      // /league/:id/schedule/:week
      if (parts.length === 4 && parts[2] === 'schedule' && req.method === 'GET') {
        const sched = scheduleList(league);
        const week = parts[3];
        const list = filterScheduleByWeek(sched, week);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, schedules: list, fetchedAt: sched.fetchedAt }));
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[madden-sidecar] Listening on http://localhost:${PORT}`);
  });
  return server;
}
