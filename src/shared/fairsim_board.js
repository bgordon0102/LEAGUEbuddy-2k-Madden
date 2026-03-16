import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import {
  loadStrikeStore,
  ensureStrikeSeason,
  STRIKE_LIMIT,
  weightedCount,
  formatBreakdown,
  completionRate,
  communicationSummary,
} from './madden_strikes.js';

const BOARD_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsim_board.json');
const CHANNEL_ID = '1481327206457413712';
const TEAM_EMOJI_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

const normalize = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function seasonKey(snapshot) {
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

async function buildLines(snapshot, fairData, season, guild) {
  const teams = (snapshot?.teams?.leagueTeamInfoList || []).slice().sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  const seasonData = ensureStrikeSeason(fairData, season);
  let roleMap = {};
  let emojiMap = {};
  try { emojiMap = JSON.parse(fs.readFileSync(TEAM_EMOJI_FILE, 'utf8')); } catch {}
  try { roleMap = JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch {}

  const active = [];
  const watch = [];
  const flaggedComms = [];
  let cleanCount = 0;
  for (const t of teams) {
    const baseName = t.displayName || t.nickName || t.cityName || 'Team';
    const roleId = roleMap[`${baseName} Coach`] || roleMap[`${t.nickName} Coach`] || roleMap[`${t.cityName} Coach`];
    let members = [];
    if (roleId && guild) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (role) members = [...role.members.values()];
    }
    const emoji = emojiMap[baseName] ? `<:${baseName.toLowerCase().replace(/\s+/g, '_')}:${emojiMap[baseName]}> ` : '';
    const memberIds = members.map((m) => m.id);
    const primaryKey = memberIds
      .sort((a, b) => weightedCount(seasonData, b) - weightedCount(seasonData, a))[0];
    if (!primaryKey) {
      cleanCount += 1;
      continue;
    }
    const total = weightedCount(seasonData, primaryKey);
    const breakdown = formatBreakdown(seasonData, primaryKey);
    const rate = completionRate(seasonData, primaryKey);
    const comm = communicationSummary(seasonData, primaryKey);
    const rateText = rate == null ? 'NR' : `${rate}%`;
    const riskText = comm.consecutiveSilent >= 2
      ? `${comm.consecutiveSilent} straight silent`
      : comm.silent
        ? `${comm.silent} silent`
        : 'clear';
    const line = { total, text: `${emoji}${baseName} — ${total}/${STRIKE_LIMIT} • ${breakdown} • played ${rateText} • ${riskText}` };
    if (total >= 3) {
      watch.push(line);
    } else if (total > 0) {
      active.push(line);
    } else if (comm.silent > 0) {
      flaggedComms.push(`${emoji}${baseName} — communication flag only • ${riskText}`);
    } else {
      cleanCount += 1;
    }
  }
  watch.sort((a, b) => b.total - a.total);
  active.sort((a, b) => b.total - a.total);
  return {
    active: active.map((entry) => entry.text),
    watch: watch.map((entry) => entry.text),
    flaggedComms,
    cleanCount,
  };
}

async function upsertBoardMessage(client, content) {
  const state = loadJson(BOARD_FILE, {});
  const channel = await client.channels.fetch(CHANNEL_ID).catch((e) => {
    console.warn('[fairsim_board] fetch channel failed', e?.message || e);
    return null;
  });
  if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');

  if (state.messageId) {
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      try {
        await msg.edit(content);
        if (!msg.pinned) { try { await msg.pin(); } catch (e) { console.warn('[fairsim_board] pin failed (edit)', e?.message || e); } }
        return;
      } catch (e) {
        console.warn('[fairsim_board] edit failed, will resend', e?.message || e);
        state.messageId = null;
      }
    }
  }
  const sent = await channel.send(content);
  try { await sent.pin(); } catch (e) { console.warn('[fairsim_board] pin failed (new)', e?.message || e); }
  state.messageId = sent.id;
  saveJson(BOARD_FILE, state);
}

export async function updateFairSimBoard(client, guildId) {
  let snapshot = null;
  try {
    const leagueId = resolveLeagueIdWithConfig(guildId);
    snapshot = loadLeagueSnapshot(leagueId);
  } catch {
    snapshot = null;
  }
  const fairData = loadStrikeStore();
  const season = seasonKey(snapshot);
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const usage = await buildLines(snapshot, fairData, season, guild);
  const seasonLabel = season.replace('year_', '');

  const embed = {
    title: 'Strike Board',
    description: [
      `Season ${seasonLabel}`,
      'FS 0.5 • FW 1.0 • DS 1.5',
      'Hard limit: 5.0. Once a coach reaches 5.0, they have no non-play room left.',
      'Next strike after 5.0 triggers removal review.',
      'Staff uses thread communication, button usage, reminders, and deadline evidence when applying outcomes.',
    ].join('\n'),
    fields: [
      {
        name: 'At Risk / Removal Range',
        value: usage.watch.length ? usage.watch.join('\n') : 'No teams currently at 3.0 or higher.',
      },
      {
        name: 'Active Strike Cases',
        value: usage.active.length ? usage.active.join('\n') : 'No teams currently carrying strike points below the watch range.',
      },
      {
        name: 'Communication Flags',
        value: usage.flaggedComms.length ? usage.flaggedComms.join('\n') : 'No clean teams are currently carrying separate communication flags.',
      },
      {
        name: 'Clean Teams',
        value: `${usage.cleanCount} teams currently have no active strike points or communication flags.`,
      },
      {
        name: 'Board Key',
        value: '`Breakdown` = strike mix • `played` = completion rate • `silent` = silent-week count',
      },
    ],
    color: 0xfee75c,
    timestamp: new Date().toISOString(),
  };

  console.log('[fairsim_board] update', { guildId, season, messageId: loadJson(BOARD_FILE, {}).messageId });
  await upsertBoardMessage(client, { embeds: [embed] });
}

export default { updateFairSimBoard };
