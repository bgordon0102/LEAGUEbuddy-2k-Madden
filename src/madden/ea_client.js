import https from 'https';
import { constants, randomBytes, createHash } from 'crypto';
import { Buffer } from 'buffer';
import fs from 'fs';
import path from 'path';
import { saveTokens as saveTokensDb } from './madden_db.js';
import { CLIENT_ID, CLIENT_SECRET, AUTH_SOURCE, LeagueData, Stage, BLAZE_SERVICE, BLAZE_PRODUCT_NAME, MACHINE_KEY, YEAR, getServiceVariantsForConsole } from './ea_constants.js';

// Create an agent that allows EA's legacy SSL
const agent = new https.Agent({
  rejectUnauthorized: false,
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const TOKEN_FILE = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

function persistTokens(token) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    const serializable = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiry: token.expiry ? Number(token.expiry) : null,
      console: token.console,
      blazeId: token.blazeId,
      gameYear: token.gameYear || YEAR,
      serviceOverride: token.serviceOverride,
      productOverride: token.productOverride,
    };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(serializable, null, 2));
    saveTokensDb(serializable);
  } catch (e) {
    console.warn('[ea_client] persistTokens failed:', e?.message || e);
  }
}

// TokenInformation / SessionInformation shapes (JS version)
// token: { accessToken, refreshToken, expiry: Date, console: 'ps5'|'xbsx'|..., blazeId }
// session: { blazeId: number, sessionKey: string, requestId: number }

const headers = (t) => ({
  "Accept-Charset": "UTF-8",
  "Accept": "application/json",
  "X-BLAZE-ID": t.serviceOverride || BLAZE_SERVICE[t.console],
  "X-BLAZE-VOID-RESP": "XML",
  "X-Application-Key": "MADDEN-MCA",
  "Content-Type": "application/json",
  "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)",
});

async function refreshToken(token) {
  const now = new Date();
  if (now <= token.expiry) return token;

  const body = `grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&release_type=prod&refresh_token=${token.refreshToken}&authentication_source=${AUTH_SOURCE}&token_format=JWS`;
  const res = await fetch(`https://accounts.ea.com/connect/token`, {
    method: "POST",
    headers: {
      "Accept-Charset": "UTF-8",
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept-Encoding": "gzip",
    },
    body,
    agent,
  });
  const newToken = await res.json();
  if (!res.ok || !newToken.access_token) {
    throw new Error(`Error refreshing tokens, response from EA ${JSON.stringify(newToken)}`);
  }
  const newExpiry = new Date(Date.now() + newToken.expires_in * 1000);
  const refreshed = {
    accessToken: newToken.access_token,
    refreshToken: newToken.refresh_token,
    expiry: newExpiry,
    console: token.console,
    blazeId: `${token.blazeId}`,
    serviceOverride: token.serviceOverride,
    productOverride: token.productOverride,
    gameYear: token.gameYear || YEAR,
  };
  persistTokens(refreshed);
  return refreshed;
}

async function retrieveBlazeSession(token) {
  const primaryConsole = token.console || process.env.EA_CONSOLE || 'ps5';
  const consolesToTry = [primaryConsole];
  const errors = [];
  for (const c of consolesToTry) {
    const variants = token.serviceOverride && token.productOverride
      ? [{ service: token.serviceOverride, product: token.productOverride }]
      : token.serviceOverride
        ? [{ service: token.serviceOverride, product: token.productOverride || token.serviceOverride }]
        : getServiceVariantsForConsole(c); // try all known variants for this console/year
    if (!variants.length) {
      errors.push(`console=${c} missing service/product for YEAR=${YEAR}`);
      continue;
    }
    for (const variant of variants) {
      const res = await fetch(
        `https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login`,
        {
          method: "POST",
          headers: headers({ ...token, console: c, serviceOverride: variant.service }),
          body: JSON.stringify({
            accessToken: token.accessToken,
            productName: variant.product,
          }),
          agent,
        }
      );
      const textResponse = await res.text();
      if (!res.ok) {
        errors.push(`console=${c} service=${variant.service} status=${res.status} body=${textResponse}`);
        // On 404 server info not found, try next variant but break after trying all.
        continue;
      }
      let blazeSession;
      try {
        blazeSession = JSON.parse(textResponse);
      } catch (e) {
        errors.push(`console=${c} service=${variant.service} non-JSON: ${textResponse}`);
        continue;
      }
      const sessionKey = blazeSession?.userLoginInfo?.sessionKey;
      const blazeId = blazeSession?.userLoginInfo?.personaDetails?.personaId;
      if (sessionKey) {
        console.info(`[ea] Blaze session established console=${c} service=${variant.service} blazeId=${blazeId}`);
        return { blazeId: blazeId, sessionKey: sessionKey, requestId: 1, console: c, serviceOverride: variant.service, productOverride: variant.product };
      }
      errors.push(`console=${c} service=${variant.service} no sessionKey: ${textResponse}`);
    }
  }
  throw new Error(`EA login failed (no sessionKey). Tried consoles: ${errors.join(' | ')}`);
}

function calculateMessageAuthData(blazeId, requestId) {
  const rand4bytes = randomBytes(4);
  const requestData = JSON.stringify({
    staticData: "05e6a7ead5584ab4",
    requestId: requestId,
    blazeId: blazeId,
  });
  const staticBytes = Buffer.from("634203362017bf72f70ba900c0aa4e6b", "hex");

  const xorHash = createHash("md5").update(rand4bytes).update(staticBytes).digest();
  const requestBuffer = Buffer.from(requestData, "utf-8");
  const scrambledBytes = requestBuffer.map((b, i) => b ^ xorHash[i % 16]);
  const authDataBytes = Buffer.concat([rand4bytes, scrambledBytes]);
  const staticAuthCode = Buffer.from("3a53413521464c3b6531326530705b70203a2900", "hex");

  const authCode = createHash("md5").update(staticAuthCode).update(authDataBytes).digest("base64");
  const authData = authDataBytes.toString("base64");
  const authType = 17039361;
  return { authData, authCode, authType };
}

async function sendBlazeRequest(token, session, request) {
  if (!session?.sessionKey) {
    throw new Error("Missing Blaze sessionKey; ensure login succeeded before sending requests.");
  }
  const authData = calculateMessageAuthData(session.blazeId, session.requestId);
  const messageExpiration = Math.floor(Date.now() / 1000);
  const { requestPayload, ...rest } = request;
  const body = {
    apiVersion: 2,
    clientDevice: 3,
    requestInfo: JSON.stringify({
      ...rest,
      messageAuthData: authData,
      messageExpirationTime: messageExpiration,
      deviceId: MACHINE_KEY,
      ipAddress: "127.0.0.1",
      requestPayload: JSON.stringify(requestPayload),
    }),
  };
  const res = await fetch(
    `https://wal2.tools.gos.bio-iad.ea.com/wal/mca/Process/${session.sessionKey}`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
      agent,
    }
  );
  const txtResponse = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(txtResponse);
  } catch (e) {
    throw new Error(`Blaze parse error (${request.commandName || 'unknown'}): ${txtResponse}`);
  }
  if (parsed.error) {
    throw new Error(`Blaze error: ${txtResponse}`);
  }
  return parsed;
}

async function getExportData(token, session, exportType, body) {
  const res = await fetch(
    `https://wal2.tools.gos.bio-iad.ea.com/wal/mca/${exportType}/${session.sessionKey}`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify(body),
      agent,
    }
  );
  const text = await res.text();
  const cleaned = text.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, "");
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Blaze export parse error (${exportType}): ${cleaned}`);
  }
}

export async function createEAClientFromEnv(env) {
  const consoleValue = env.EA_CONSOLE || 'ps5';
  const expiry = env.EA_ACCESS_TOKEN_EXPIRES_AT
    ? new Date(Number(env.EA_ACCESS_TOKEN_EXPIRES_AT))
    : new Date(Date.now() + 60 * 60 * 1000);
  const token = {
    accessToken: env.EA_ACCESS_TOKEN,
    refreshToken: env.EA_REFRESH_TOKEN,
    expiry,
    console: consoleValue,
    blazeId: env.EA_BLAZE_ID || '0',
    serviceOverride: env.EA_SERVICE_OVERRIDE,
    productOverride: env.EA_PRODUCT_OVERRIDE,
    gameYear: env.EA_GAME_YEAR || YEAR,
  };
  if (!token.accessToken || !token.refreshToken) {
    throw new Error('Missing EA_ACCESS_TOKEN or EA_REFRESH_TOKEN in environment');
  }
  if (env.EA_GAME_YEAR && `${env.EA_GAME_YEAR}` !== `${YEAR}`) {
    throw new Error(`Cached tokens are for game year ${env.EA_GAME_YEAR}, current YEAR=${YEAR}. Please re-auth with /madden-auth.`);
  }

  const freshToken = await refreshToken(token);
  const session = await retrieveBlazeSession(freshToken);
  return await ephemeralClientFromToken({ ...freshToken, gameYear: env.EA_GAME_YEAR || YEAR }, session);
}

export async function ephemeralClientFromToken(token, session) {
  const validSession = session ? session : await retrieveBlazeSession(token);
  const tokenWithService = validSession?.serviceOverride ? { ...token, serviceOverride: validSession.serviceOverride } : token;
  return {
    async getLeagues() {
      const res = await sendBlazeRequest(tokenWithService, validSession, {
        commandName: "Mobile_GetMyLeagues",
        componentId: 2060,
        commandId: 801,
        requestPayload: {},
        componentName: "careermode",
      });
      return res.responseInfo?.value?.leagues || [];
    },
    async getLeagueInfo(leagueId) {
      const res = await sendBlazeRequest(tokenWithService, validSession, {
        commandName: "Mobile_Career_GetLeagueHub",
        componentId: 2060,
        commandId: 811,
        requestPayload: { leagueId },
        componentName: "careermode",
      });
      return res.responseInfo.value;
    },
    async getTeams(leagueId) {
      return await getExportData(tokenWithService, validSession, LeagueData.TEAMS, { leagueId });
    },
    async getStandings(leagueId) {
      return await getExportData(tokenWithService, validSession, LeagueData.STANDINGS, { leagueId });
    },
    async getSchedules(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.WEEKLY_SCHEDULE, { leagueId, stageIndex: stage, weekIndex });
    },
    async getTeamRoster(leagueId, teamId, teamIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.TEAM_ROSTER, {
        leagueId,
        listIndex: teamIndex,
        returnFreeAgents: false,
        teamId,
      });
    },
    async getFreeAgents(leagueId) {
      return await getExportData(tokenWithService, validSession, LeagueData.TEAM_ROSTER, {
        leagueId,
        listIndex: -1,
        returnFreeAgents: true,
        teamId: 0,
      });
    },
    async getRushingStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.RUSHING_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getTeamStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.TEAM_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getPuntingStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.PUNTING_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getReceivingStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.RECEIVING_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getDefensiveStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.DEFENSIVE_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getKickingStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.KICKING_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
    async getPassingStats(leagueId, stage, weekIndex) {
      return await getExportData(tokenWithService, validSession, LeagueData.PASSING_STATS, { leagueId, stageIndex: stage, weekIndex });
    },
  };
}

export { Stage };
