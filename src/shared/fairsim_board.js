import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';

const FAIR_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const BOARD_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsim_board.json');
const CHANNEL_ID = '1481327206457413712';
const SIM_LIMIT = 5;
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
  const seasonData = fairData[season] || {};
  const counts = seasonData.counts || {};
  let roleMap = {};
  let emojiMap = {};
  try { emojiMap = JSON.parse(fs.readFileSync(TEAM_EMOJI_FILE, 'utf8')); } catch {}
  try { roleMap = JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch {}

  const lines = [];
  for (const t of teams) {
    const baseName = t.displayName || t.nickName || t.cityName || 'Team';
    const roleId = roleMap[`${baseName} Coach`] || roleMap[`${t.nickName} Coach`] || roleMap[`${t.cityName} Coach`];
    let members = [];
    if (roleId && guild) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (role) members = [...role.members.values()];
    }
    const emoji = emojiMap[baseName] ? `<:${baseName.toLowerCase().replace(/\s+/g, '_')}:${emojiMap[baseName]}> ` : '';
    const teamKey = `team:${normalize(baseName)}`;
    const teamCount = counts[teamKey] || 0;
    // If multiple members share a role, show the highest strike count so the line stays concise.
    const memberMax = members.reduce((max, m) => Math.max(max, counts[m.id] || 0), 0);
    const maxCount = Math.max(teamCount, memberMax);
    lines.push(`${emoji}${baseName}: ${maxCount}/${SIM_LIMIT}`);
  }
  return lines.join('\n');
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
  const fairData = loadJson(FAIR_FILE, {});
  const season = seasonKey(snapshot);
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const usageText = await buildLines(snapshot, fairData, season, guild);
  const seasonLabel = season.replace('year_', '');

  const embed = {
    title: 'Sim Strike Count',
    description: [
      `Season ${seasonLabel}`,
      `Each coach may have up to ${SIM_LIMIT} non-play outcomes (fair sims or force-wins) per season.`,
      'Fair Sim: both coaches must confirm; each gets 1 strike.',
      'Home/Away Win: only the opposing coach may press; the side that could not play gets 1 strike.',
      'Game Completed: both coaches confirm to clear reminders.',
      '',
      usageText || 'No data yet',
    ].join('\n'),
    color: 0xfee75c,
    timestamp: new Date().toISOString(),
  };

  console.log('[fairsim_board] update', { guildId, season, messageId: loadJson(BOARD_FILE, {}).messageId });
  await upsertBoardMessage(client, { embeds: [embed] });
}

export default { updateFairSimBoard };
