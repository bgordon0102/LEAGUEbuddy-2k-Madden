import http from 'http';
import fs from 'fs';
import path from 'path';

const EXPORT_PORT = Number(process.env.MADDEN_EXPORT_PORT || 4010);
const EXPORT_ENABLED = process.env.MADDEN_EXPORT_WEBHOOK_ENABLED !== 'false' && process.env.MADDEN_EXPORT_WEBHOOK_ENABLED !== '0';
const EXPORT_SECRET = process.env.MADDEN_EXPORT_SECRET || '';
const MAX_BODY_BYTES = Number(process.env.MADDEN_EXPORT_MAX_BYTES || 2 * 1024 * 1024); // default 2MB
const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');

function savePayload(payload) {
  fs.mkdirSync(LEAGUE_DIR, { recursive: true });
  const leagueId =
    payload?.leagueId ||
    payload?.LeagueId ||
    payload?.info?.leagueId ||
    payload?.League?.leagueId ||
    `unknown_${Date.now()}`;
  const outPath = path.join(LEAGUE_DIR, `${leagueId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  return { leagueId, outPath };
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
          const { leagueId, outPath } = savePayload(json);
          console.log(`[madden-export] Received export for league ${leagueId} -> ${outPath}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, leagueId, saved: outPath }));
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
