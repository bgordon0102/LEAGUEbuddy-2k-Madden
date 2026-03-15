import http from 'http';
import fs from 'fs';
import path from 'path';

const EXPORT_PORT = Number(process.env.MADDEN_EXPORT_PORT || 4010);
const EXPORT_ENABLED = process.env.MADDEN_EXPORT_WEBHOOK_ENABLED !== 'false' && process.env.MADDEN_EXPORT_WEBHOOK_ENABLED !== '0';
const EXPORT_SECRET = process.env.MADDEN_EXPORT_SECRET || '';
const MAX_BODY_BYTES = Number(process.env.MADDEN_EXPORT_MAX_BYTES || 2 * 1024 * 1024); // default 2MB
const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const PREVIOUS_DIR = path.join(LEAGUE_DIR, 'previous');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countPlayers(entry) {
  const buckets = [
    entry?.passing?.playerPassingStatInfoList,
    entry?.rushing?.playerRushingStatInfoList,
    entry?.receiving?.playerReceivingStatInfoList,
    entry?.defense?.playerDefensiveStatInfoList,
    entry?.kicking?.playerKickingStatInfoList,
    entry?.punting?.playerPuntingStatInfoList,
  ];
  return buckets.reduce((sum, bucket) => sum + (Array.isArray(bucket) ? bucket.length : 0), 0);
}

function mergeWeekEntries(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = { ...existing, ...incoming };
  const mergeBucket = (key, listKey) => {
    const left = existing?.[key]?.[listKey] || [];
    const right = incoming?.[key]?.[listKey] || [];
    if (!left.length && !right.length) {
      return incoming[key] ?? existing[key];
    }
    return {
      ...(existing[key] || incoming[key] || {}),
      [listKey]: [...left, ...right],
    };
  };
  merged.passing = mergeBucket('passing', 'playerPassingStatInfoList');
  merged.rushing = mergeBucket('rushing', 'playerRushingStatInfoList');
  merged.receiving = mergeBucket('receiving', 'playerReceivingStatInfoList');
  merged.defense = mergeBucket('defense', 'playerDefensiveStatInfoList');
  merged.kicking = mergeBucket('kicking', 'playerKickingStatInfoList');
  merged.punting = mergeBucket('punting', 'playerPuntingStatInfoList');
  merged.teamstats = incoming.teamstats || existing.teamstats;
  merged.playerCount = countPlayers(merged);
  return merged;
}

function mergeWeeklyStats(existingList, incomingList) {
  const byKey = new Map();
  const add = (entry) => {
    if (!entry) return;
    const stage = Number(entry.stage ?? entry.stageIndex ?? 0);
    const weekIndex = Number(entry.weekIndex ?? -1);
    const key = `${stage}-${weekIndex}`;
    const normalized = {
      ...entry,
      stage,
      weekIndex,
      playerCount: Number(entry.playerCount ?? countPlayers(entry)),
    };
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, normalized);
      return;
    }
    const merged = mergeWeekEntries(prev, normalized);
    const prevCount = Number(prev.playerCount ?? 0);
    const mergedCount = Number(merged.playerCount ?? 0);
    byKey.set(key, mergedCount >= prevCount ? merged : prev);
  };
  (existingList || []).forEach(add);
  (incomingList || []).forEach(add);
  return Array.from(byKey.values()).sort((a, b) => (a.stage - b.stage) || (a.weekIndex - b.weekIndex));
}

function mergeSchedules(existingSchedule, incomingSchedule) {
  const existingGames = existingSchedule?.schedules || [];
  const incomingGames = incomingSchedule?.schedules || [];
  if (!existingGames.length) return incomingSchedule;
  if (!incomingGames.length) return existingSchedule;
  const byKey = new Map();
  const keyFor = (game) => {
    const stage = Number(game?.stageIndex ?? game?.stage ?? -1);
    const weekIndex = Number(game?.weekIndex ?? -1);
    const home = Number(game?.homeTeamId ?? -1);
    const away = Number(game?.awayTeamId ?? -1);
    return `${stage}-${weekIndex}-${home}-${away}`;
  };
  for (const game of existingGames) byKey.set(keyFor(game), game);
  for (const game of incomingGames) {
    const key = keyFor(game);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, game);
      continue;
    }
    const prevStatus = Number(prev?.status ?? 0);
    const nextStatus = Number(game?.status ?? 0);
    byKey.set(key, nextStatus >= prevStatus ? { ...prev, ...game } : { ...game, ...prev });
  }
  return { schedules: Array.from(byKey.values()) };
}

function mergePayload(existing, incoming, leagueId) {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    leagueId,
    fetchedAt: incoming?.fetchedAt || new Date().toISOString(),
    info: incoming?.info || existing?.info,
    teams: incoming?.teams || existing?.teams,
    standings: incoming?.standings || existing?.standings,
    rosters: incoming?.rosters || existing?.rosters,
    schedule: mergeSchedules(existing?.schedule, incoming?.schedule),
    weeklyStats: mergeWeeklyStats(existing?.weeklyStats, incoming?.weeklyStats),
  };
}

function savePayload(payload) {
  fs.mkdirSync(LEAGUE_DIR, { recursive: true });
  fs.mkdirSync(PREVIOUS_DIR, { recursive: true });
  const leagueId =
    payload?.leagueId ||
    payload?.LeagueId ||
    payload?.info?.leagueId ||
    payload?.League?.leagueId ||
    `unknown_${Date.now()}`;
  const outPath = path.join(LEAGUE_DIR, `${leagueId}.json`);
  const prevPath = path.join(PREVIOUS_DIR, `${leagueId}.json`);
  const existing = loadJson(outPath);
  const merged = mergePayload(existing, payload, leagueId);
  if (existing) {
    fs.writeFileSync(prevPath, JSON.stringify(existing, null, 2), 'utf8');
  }
  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2), 'utf8');
  return {
    leagueId,
    outPath,
    weeklyStatsCount: Array.isArray(merged?.weeklyStats) ? merged.weeklyStats.length : 0,
    scheduleCount: Array.isArray(merged?.schedule?.schedules) ? merged.schedule.schedules.length : 0,
  };
}

export function startExportWebhook() {
  if (!EXPORT_ENABLED) {
    console.log('[madden-export] Webhook disabled (MADDEN_EXPORT_WEBHOOK_ENABLED=false)');
    return;
  }
  const server = http.createServer((req, res) => {
    const { method, url } = req;
    if (method === 'POST' && (url === '/madden/export' || url === '/madden/export/')) {
      if (EXPORT_SECRET) {
        const provided = req.headers['x-export-secret'];
        if (!provided || provided !== EXPORT_SECRET) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
          return;
        }
      }
      let body = '';
      let aborted = false;
      req.on('data', chunk => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          console.warn('[madden-export] Payload too large, aborting');
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
          req.destroy();
          aborted = true;
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const json = JSON.parse(body);
          const { leagueId, outPath, weeklyStatsCount, scheduleCount } = savePayload(json);
          console.log(`[madden-export] Received export for league ${leagueId} -> ${outPath} (weeklyStats=${weeklyStatsCount}, schedule=${scheduleCount})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, leagueId, saved: outPath, weeklyStatsCount, scheduleCount }));
        } catch (e) {
          console.error('[madden-export] Failed to parse/export payload:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  // Avoid crashing the bot if binding fails in sandboxed environments
  server.on('error', (err) => {
    console.error(`[madden-export] Failed to listen on http://127.0.0.1:${EXPORT_PORT}: ${err?.message || err}`);
  });

  // Bind to localhost only; 0.0.0.0 can be blocked by sandbox policies
  server.listen(EXPORT_PORT, '127.0.0.1', () => {
    console.log(`[madden-export] Listening on http://127.0.0.1:${EXPORT_PORT}/madden/export`);
  });

  return server;
}
