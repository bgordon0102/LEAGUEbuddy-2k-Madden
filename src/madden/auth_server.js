import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { EA_LOGIN_URL, CLIENT_SECRET, CLIENT_ID, AUTH_SOURCE, APP_REDIRECT_URL, YEAR } from './ea_constants.js';
import {
  fetchTokenInfo,
  fetchEntitlements,
  fetchPersonas,
  extractValidPersonas,
  exchangePersonaToken,
} from './ea_personas.js';
import { saveTokens as saveTokensDb } from './madden_db.js';

const TOKEN_FILE = path.join(process.cwd(), 'data', 'madden', 'tokens.json');
const PORT = Number(process.env.MADDEN_AUTH_PORT || 4001);

function html(body) {
  return `<!doctype html><html><head><title>Madden Auth</title></head><body style="font-family: sans-serif; max-width: 640px; margin: 40px auto;">
${body}
</body></html>`;
}

async function exchangeCode(code) {
  const body = `authentication_source=${AUTH_SOURCE}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${APP_REDIRECT_URL}&release_type=prod&client_id=${CLIENT_ID}`;
  const res = await fetch('https://accounts.ea.com/connect/token', {
    method: 'POST',
    headers: {
      'Accept-Charset': 'UTF-8',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept-Encoding': 'gzip',
    },
    body
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`EA token exchange failed: ${JSON.stringify(json)}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiry: Date.now() + (json.expires_in || 0) * 1000
  };
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  saveTokensDb(tokens);
}

function chooseBestPersona(personas) {
  const score = (p) => {
    let s = 0;
    const ent = `${p.entitlement || ''}`.toUpperCase();
    const ns = `${p.namespaceName || ''}`.toUpperCase();
    if (p.systemConsole && p.systemConsole.toLowerCase() === 'ps5') s += 5;
    if (p.systemConsole && p.systemConsole.toLowerCase() === 'xbsx') s += 4;
    if (ent.includes('MADDEN_26')) s += 3;
    if (ns.includes('MADDEN')) s += 1;
    return s;
  };
  return [...personas].sort((a, b) => score(b) - score(a))[0] || null;
}

async function buildPersonaScopedTokens(code) {
  const loginTokens = await exchangeCode(code);
  const tokenInfo = await fetchTokenInfo(loginTokens.accessToken);
  const pid = tokenInfo?.pid_id;
  if (!pid) {
    throw new Error('No pid_id returned from tokeninfo.');
  }

  const entRes = await fetchEntitlements(pid, loginTokens.accessToken);
  const entitlements = entRes?.entitlements?.entitlement || [];
  const personaResponses = await Promise.all(
    entitlements.map(async (ent) => ({
      ent,
      personas: await fetchPersonas(ent.pidUri, loginTokens.accessToken),
    })),
  );
  const personas = extractValidPersonas(entRes, personaResponses, 'Default');
  if (!personas.length) {
    throw new Error('No valid Madden personas found for this EA account.');
  }

  const chosen = chooseBestPersona(personas);
  if (!chosen) {
    throw new Error('Could not resolve a Madden persona to save.');
  }

  const personaToken = await exchangePersonaToken(
    loginTokens.accessToken,
    chosen.personaId,
    chosen.namespaceName,
  );

  return {
    accessToken: personaToken.access_token,
    refreshToken: personaToken.refresh_token,
    expiry: Date.now() + (personaToken.expires_in || 0) * 1000,
    console: chosen.systemConsole || 'ps5',
    blazeId: `${chosen.personaId}`,
    gameYear: YEAR,
    personaName: chosen.displayName,
    entitlement: chosen.entitlement,
    namespace: chosen.namespaceName,
  };
}

export function startAuthServer() {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname || '';

    if (pathname === '/madden/auth') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html(`
        <h2>Madden EA Login</h2>
        <p>1) Click the link below and sign in to EA (same as Madden Companion).</p>
        <p>2) You will be redirected back here automatically.</p>
        <p><a href="${EA_LOGIN_URL}">Login to EA</a></p>
        <p>If you prefer manual: the redirect URL is ${APP_REDIRECT_URL}</p>
      `));
      return;
    }

    if (pathname === '/madden/callback') {
      const code = parsed.query.code;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (!code) {
        res.end(html(`<h3>Missing code</h3><p>No ?code= found in URL.</p>`));
        return;
      }
      try {
        const tokens = await buildPersonaScopedTokens(code);
        saveTokens(tokens);
        res.end(html(`
          <h3>Tokens saved</h3>
          <p>Your persona-scoped Madden tokens were stored successfully.</p>
          <p><strong>Console:</strong> ${tokens.console}</p>
          <p><strong>Persona:</strong> ${tokens.personaName} (${tokens.blazeId})</p>
          <p>You can close this tab and use the bot normally without reauthing again unless EA invalidates the refresh token.</p>
        `));
      } catch (e) {
        res.end(html(`<h3>Exchange failed</h3><pre>${e.message}</pre>`));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  // Log and swallow listen errors so the bot doesn't crash if the port is blocked
  server.on('error', (err) => {
    console.error(`[madden-auth] Failed to listen on http://127.0.0.1:${PORT}: ${err?.message || err}`);
  });

  // Bind to localhost to avoid sandbox/permission issues on 0.0.0.0
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[madden-auth] Listening on http://127.0.0.1:${PORT}/madden/auth`);
  });

  return server;
}
