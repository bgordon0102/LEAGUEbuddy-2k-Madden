import fs from 'fs';
import path from 'path';

const FAIR_FILE = path.join(process.cwd(), 'data', '2k', 'fairsims.json');
const BOARD_FILE = path.join(process.cwd(), 'data', '2k', 'fairsim_board.json');
const CHANNEL_ID = '1425556585220149382';
const TEAM_EMOJI_FILE = path.join(process.cwd(), 'data', '2k', 'team_emojis.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
const SIM_LIMIT = 5;

const normalize = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function loadJson(file, fb = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } }
function saveJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

async function buildLines(fairData, season, guild) {
  let emojiMap = {};
  let roleMap = {};
  try { emojiMap = JSON.parse(fs.readFileSync(TEAM_EMOJI_FILE, 'utf8')); } catch {}
  try { roleMap = JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch {}
  const seasonData = fairData[season] || {};
  const counts = seasonData.counts || {};

  const teams = Object.keys(roleMap)
    .filter(k => k.endsWith(' Coach'))
    .map(k => k.replace(/\s+Coach$/i, ''))
    .sort((a, b) => a.localeCompare(b));

  const lines = [];
  for (const team of teams) {
    const roleId = roleMap[`${team} Coach`];
    let members = [];
    if (roleId && guild) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (role) members = [...role.members.values()];
    }
    const teamKey = `team:${normalize(team)}`;
    const teamCount = counts[teamKey] || 0;
    const memberMax = members.reduce((max, m) => Math.max(max, counts[m.id] || 0), 0);
    const maxCount = Math.max(teamCount, memberMax);
    const emoji = emojiMap[team] ? `<:${team.toLowerCase().replace(/\s+/g, '_')}:${emojiMap[team]}> ` : '';
    lines.push(`${emoji}${team}: ${maxCount}/${SIM_LIMIT}`);
  }
  return lines.join('\n');
}

async function upsertBoardMessage(client, content) {
  const state = loadJson(BOARD_FILE, {});
  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Board channel not found or not text-based');

  if (state.messageId) {
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      try {
        await msg.edit(content);
        if (!msg.pinned) { try { await msg.pin(); } catch (e) { console.warn('[2k_fairsim_board] pin failed (edit)', e?.message || e); } }
        return;
      } catch (e) {
        console.warn('[2k_fairsim_board] edit failed, will recreate', e?.message || e);
        state.messageId = null;
      }
    }
  }
  const sent = await channel.send(content);
  try { await sent.pin(); } catch (e) { console.warn('[2k_fairsim_board] pin failed (new)', e?.message || e); }
  state.messageId = sent.id;
  saveJson(BOARD_FILE, state);
}

export async function updateFairSimBoard(client, guildId) {
  const fairData = loadJson(FAIR_FILE, {});
  const season = `year_${new Date().getFullYear()}`;
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const usage = await buildLines(fairData, season, guild);

  const embed = {
    title: 'Sim Strike Count (2K)',
    description: [
      `Season ${season.replace('year_', '')}`,
      `Each coach may have up to ${SIM_LIMIT} non-play outcomes (fair sims or force-wins) per season.`,
      'Fair Sim: both coaches confirm; each gets 1 strike.',
      'Force-Win: only the opposing coach presses; side that could not play gets 1 strike.',
      'Game Completed: both coaches confirm to clear reminders.',
      '',
      usage || 'No data yet',
    ].join('\n'),
    color: 0x1E90FF,
    timestamp: new Date().toISOString(),
  };

  await upsertBoardMessage(client, { embeds: [embed] });
}

export default { updateFairSimBoard };
