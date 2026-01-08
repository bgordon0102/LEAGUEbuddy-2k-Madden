import https from 'https';
import { constants, randomBytes, createHash } from 'crypto';
import { Buffer } from 'buffer';
import { CLIENT_ID, CLIENT_SECRET, AUTH_SOURCE, LeagueData, Stage, BLAZE_SERVICE, BLAZE_PRODUCT_NAME, MACHINE_KEY } from './ea_constants.js';

// Create an agent that allows EA's legacy SSL
const agent = new https.Agent({
  rejectUnauthorized: false,
  secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

// TokenInformation / SessionInformation shapes (JS version)
// token: { accessToken, refreshToken, expiry: Date, console: 'ps5'|'xbsx'|..., blazeId }
// session: { blazeId: number, sessionKey: string, requestId: number }

const headers = (t) => ({
  "Accept-Charset": "UTF-8",
  "Accept": "application/json",
  "X-BLAZE-ID": BLAZE_SERVICE[t.console],
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
  return {
    accessToken: newToken.access_token,
    refreshToken: newToken.refresh_token,
    expiry: newExpiry,
    console: token.console,
    blazeId: `${token.blazeId}`,
  };
}

async function retrieveBlazeSession(token) {
  const consolesToTry = [token.console, 'ps5', 'ps4', 'xbsx', 'xone', 'pc'].filter(Boolean);
  const errors = [];
  for (const c of consolesToTry) {
    const res = await fetch(
      `https://wal2.tools.gos.bio-iad.ea.com/wal/authentication/login`,
      {
        method: "POST",
        headers: headers({ ...token, console: c }),
        body: JSON.stringify({
          accessToken: token.accessToken,
          productName: BLAZE_PRODUCT_NAME[c],
        }),
        agent,
      }
    );
    const textResponse = await res.text();
    if (!res.ok) {
      errors.push(`console=${c} status=${res.status} body=${textResponse}`);
      continue;
    }
    let blazeSession;
    try {
      blazeSession = JSON.parse(textResponse);
    } catch (e) {
      errors.push(`console=${c} non-JSON: ${textResponse}`);
      continue;
    }
    const sessionKey = blazeSession?.userLoginInfo?.sessionKey;
    const blazeId = blazeSession?.userLoginInfo?.personaDetails?.personaId;
    if (sessionKey) {
      return { blazeId: blazeId, sessionKey: sessionKey, requestId: 1, console: c };
    }
    errors.push(`console=${c} no sessionKey: ${textResponse}`);
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
  const parsed = JSON.parse(txtResponse);
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
  return JSON.parse(cleaned);
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
  };
  if (!token.accessToken || !token.refreshToken) {
    throw new Error('Missing EA_ACCESS_TOKEN or EA_REFRESH_TOKEN in environment');
  }

  const freshToken = await refreshToken(token);
  const session = await retrieveBlazeSession(freshToken);
  return await ephemeralClientFromToken(freshToken, session);
}

export async function ephemeralClientFromToken(token, session) {
  const validSession = session ? session : await retrieveBlazeSession(token);
  return {
    async getLeagueInfo(leagueId) {
      const res = await sendBlazeRequest(token, validSession, {
        commandName: "Mobile_Career_GetLeagueHub",
        componentId: 2060,
        commandId: 811,
        requestPayload: { leagueId },
        componentName: "careermode",
      });
      return res.responseInfo.value;
    },
    async getTeams(leagueId) {
      return await getExportData(token, validSession, LeagueData.TEAMS, { leagueId });
    },
    async getStandings(leagueId) {
      return await getExportData(token, validSession, LeagueData.STANDINGS, { leagueId });
    },
    async getSchedules(leagueId, stage, weekIndex) {
      return await getExportData(token, validSession, LeagueData.WEEKLY_SCHEDULE, { leagueId, stageIndex: stage, weekIndex });
    },
  };
}

export { Stage };
