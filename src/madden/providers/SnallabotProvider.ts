import crypto from 'crypto';
import fetch from 'node-fetch';
import { MaddenProvider, WeekInfo, Schedule, Game } from './MaddenProvider.js';
import { loadTokens as loadTokensDb } from '../madden_db.js';

const SIDE_URL = process.env.SNALLA_SIDECAR_URL || 'http://localhost:8080';
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

async function headers() {
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'x-correlation-id': crypto.randomUUID(),
  };
}

async function http<T>(path: string): Promise<T> {
  const res = await fetch(`${SIDE_URL}${path}`, { headers: await tokensHeaders() });
  const txt = await res.text();
  let json: any = {};
  try { json = JSON.parse(txt); } catch { }
  if (!res.ok || json.ok === false) {
    const err = new Error(json?.error || res.statusText);
    (err as any).status = res.status;
    throw err;
  }
  return json as T;
}

export class SnallabotProvider implements MaddenProvider {
  async getCurrentWeek(leagueId: string): Promise<WeekInfo> {
    const r = await http<{ leagueId: string; week: number; stage: string; seasonInfo: any; fetchedAt: string }>(`/league/${leagueId}/week`);
    return { week: r.week, stage: r.stage as any, seasonInfo: r.seasonInfo, fetchedAt: r.fetchedAt };
  }

  async getFullSchedule(leagueId: string): Promise<Schedule> {
    const r = await http<{ leagueId: string; schedules: any[]; fetchedAt: string }>(`/league/${leagueId}/schedule`);
    return { schedules: r.schedules, fetchedAt: r.fetchedAt };
  }

  async getWeekGames(leagueId: string, week: number): Promise<Game[]> {
    const r = await http<{ schedules: any[] }>(`/league/${leagueId}/schedule/${week}`);
    return r.schedules || [];
  }
}
