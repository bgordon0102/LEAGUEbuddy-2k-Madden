import crypto from 'crypto';
import fetch from 'node-fetch';
import { MaddenProvider } from './MaddenProvider.js';
import { loadTokens as loadTokensDb } from '../madden_db.js';

const SIDE_URL = process.env.SNALLA_SIDECAR_URL || 'http://localhost:8090';
const API_KEY = process.env.SNALLA_SIDECAR_API_KEY || '';

async function tokensHeaders() {
  const tokens = loadTokensDb();
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'x-correlation-id': crypto.randomUUID(),
    'x-access-token': tokens?.accessToken || '',
    'x-refresh-token': tokens?.refreshToken || '',
    'x-console': tokens?.console || 'ps5',
    'x-blazeid': tokens?.blazeId || '',
    'x-expiry': tokens?.expiry ? String(tokens.expiry) : '',
  };
}

async function http(path) {
  const res = await fetch(`${SIDE_URL}${path}`, { headers: await tokensHeaders() });
  const txt = await res.text();
  let json = {};
  try { json = JSON.parse(txt); } catch { /* ignore parse errors */ }
  if (!res.ok || json.ok === false) {
    const err = new Error(json?.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return json;
}

export class SnallabotProvider extends MaddenProvider {
  async getCurrentWeek(leagueId) {
    const r = await http(`/league/${leagueId}/week`);
    return { week: r.week, stage: r.stage, seasonInfo: r.seasonInfo, fetchedAt: r.fetchedAt };
  }

  async getFullSchedule(leagueId) {
    const r = await http(`/league/${leagueId}/schedule`);
    return { schedules: r.schedules, fetchedAt: r.fetchedAt };
  }

  async getWeekGames(leagueId, week) {
    const r = await http(`/league/${leagueId}/schedule/${week}`);
    return r.schedules || [];
  }
}

export default SnallabotProvider;
