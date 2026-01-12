import { AUTH_SOURCE, CLIENT_ID, CLIENT_SECRET, REDIRECT_URL, VALID_ENTITLEMENTS, ENTITLEMENT_TO_VALID_NAMESPACE, ENTITLEMENT_TO_SYSTEM, CONSOLE_OVERRIDE_TO_ENTITLEMENT, CONSOLE_OVERRIDE_TO_VALID_NAMESPACE, MACHINE_KEY } from './ea_constants.js';

const MOBILE_UA = "Dalvik/2.1.0 (Linux; U; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031)";

function assertOk(res, context) {
  if (!res.ok) {
    throw new Error(`${context} failed: status=${res.status}`);
  }
}

export async function fetchTokenInfo(accessToken) {
  const res = await fetch(`https://accounts.ea.com/connect/tokeninfo?access_token=${accessToken}`, {
    headers: {
      "Accept-Charset": "UTF-8",
      "X-Include-Deviceid": "true",
      "User-Agent": MOBILE_UA,
      "Accept-Encoding": "gzip",
    },
  });
  assertOk(res, 'tokeninfo');
  return res.json();
}

export async function fetchEntitlements(pid, accessToken) {
  const res = await fetch(`https://gateway.ea.com/proxy/identity/pids/${pid}/entitlements/?status=ACTIVE`, {
    headers: {
      "User-Agent": MOBILE_UA,
      "Accept-Charset": "UTF-8",
      "X-Expand-Results": "true",
      "Accept-Encoding": "gzip",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  assertOk(res, 'entitlements');
  return res.json();
}

export async function fetchPersonas(pidUri, accessToken) {
  const res = await fetch(`https://gateway.ea.com/proxy/identity${pidUri}/personas?status=ACTIVE&access_token=${accessToken}`, {
    headers: {
      "Acccept-Charset": "UTF-8",
      "X-Expand-Results": "true",
      "User-Agent": MOBILE_UA,
      "Accept-Encoding": "gzip",
    },
  });
  assertOk(res, 'personas');
  return res.json();
}

export function extractValidPersonas(entitlementsResponse, personaResponses, consoleOverride) {
  const validEnts = (entitlementsResponse?.entitlements?.entitlement || []).filter(e =>
    e.entitlementTag === "ONLINE_ACCESS" && Object.values(VALID_ENTITLEMENTS).includes(e.groupName)
  );
  let entries = [];
  for (const ent of validEnts) {
    const personas = personaResponses
      .filter(p => p?.ent?.groupName === ent.groupName)
      .flatMap(p => (p?.personas?.personas?.persona || p?.personas?.persona || []).map(persona => ({ persona, entitlement: ent })));
    entries.push(...personas);
  }
  // Apply console override if provided
  if (consoleOverride && consoleOverride !== 'Default') {
    const entTag = CONSOLE_OVERRIDE_TO_ENTITLEMENT[consoleOverride];
    const namespaces = CONSOLE_OVERRIDE_TO_VALID_NAMESPACE[consoleOverride] || [];
    entries = entries
      .map(e => ({ ...e, entitlement: { ...e.entitlement, groupName: entTag }, persona: { ...e.persona, namespaceName: e.persona.namespaceName } }))
      .filter(e => e.entitlement.groupName === entTag && namespaces.includes(e.persona.namespaceName));
  } else {
    entries = entries.filter(e => {
      const validNamespaces = ENTITLEMENT_TO_VALID_NAMESPACE[e.entitlement.groupName] || [];
      return validNamespaces.includes(e.persona.namespaceName);
    });
  }
  return entries.map(e => ({
    personaId: e.persona.personaId,
    displayName: e.persona.displayName,
    namespaceName: e.persona.namespaceName,
    entitlement: e.entitlement.groupName,
    systemConsole: ENTITLEMENT_TO_SYSTEM[e.entitlement.groupName],
  }));
}

export async function exchangeLoginCode(rawUrl) {
  const searchParams = rawUrl.substring(rawUrl.indexOf("?"));
  const eaCodeParams = new URLSearchParams(searchParams);
  const code = eaCodeParams.get("code");
  if (!code) {
    throw new Error("Could not find ?code= in the URL you provided.");
  }
  const res = await fetch("https://accounts.ea.com/connect/token", {
    method: "POST",
    headers: {
      "Accept-Charset": "UTF-8",
      "User-Agent": MOBILE_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept-Encoding": "gzip",
    },
    body: `authentication_source=${AUTH_SOURCE}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=${code}&redirect_uri=${REDIRECT_URL}&release_type=prod&client_id=${CLIENT_ID}`
  });
  assertOk(res, 'exchange login code');
  return res.json();
}

export async function exchangePersonaToken(accessToken, personaId, personaNamespace) {
  const locationUrlRes = await fetch(`https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}&access_token=${accessToken}&persona_id=${personaId}&persona_namespace=${personaNamespace}`, {
    redirect: "manual",
    headers: {
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": "Mozilla/5.0 (Linux; Android 13; sdk_gphone_x86_64 Build/TE1A.220922.031; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/103.0.5060.71 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
      "X-Requested-With": "com.ea.gp.madden19companionapp",
      "Sec-Fetc-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-US,en;q=0,9",
    }
  });
  const locationUrl = locationUrlRes.headers.get("Location");
  if (!locationUrl) {
    throw new Error("Failed to get redirect for persona token");
  }
  const eaCode = new URLSearchParams(locationUrl.replace(REDIRECT_URL, "")).get("code");
  if (!eaCode) {
    throw new Error("Failed to extract code for persona token");
  }
  const newAccessTokenRes = await fetch(`https://accounts.ea.com/connect/token`, {
    method: "POST",
    headers: {
      "Accept-Charset": "UTF-8",
      "User-Agent": MOBILE_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "Accept-Encoding": "gzip",
    },
    body: `authentication_source=${AUTH_SOURCE}&code=${eaCode}&grant_type=authorization_code&token_format=JWS&release_type=prod&client_secret=${CLIENT_SECRET}&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}`,
  });
  assertOk(newAccessTokenRes, 'persona token exchange');
  return newAccessTokenRes.json();
}
