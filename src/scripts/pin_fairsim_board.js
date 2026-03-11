// One-off script: posts (or edits) the sim/force-win usage board and pins it.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';

const FAIR_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const BOARD_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsim_board.json');
const CHANNEL_ID = '1481327206457413712';
const SIM_LIMIT = 5;
const TEAM_EMOJI_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const normalize = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const loadJson = (f, fb = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };
const saveJson = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); };

function seasonKey(snapshot) {
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

async function buildLines(snapshot, fairData, season, guild) {
  const teams = (snapshot?.teams?.leagueTeamInfoList || []).slice().sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  const seasonData = fairData[season] || {};
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
    const emoji = emojiMap[baseName] ? `<:${baseName.toLowerCase().replace(/\\s+/g, '_')}:${emojiMap[baseName]}> ` : '';
    if (!members.length) {
      lines.push(`${emoji}${baseName}: 0/${SIM_LIMIT}`);
      continue;
    }
    const maxCount = members.reduce((max, m) => Math.max(max, seasonData[m.id] || 0), 0);
    lines.push(`${emoji}${baseName}: ${maxCount}/${SIM_LIMIT}`);
  }
  return lines.join('\n');
}

async function upsertBoardMessage(client, content) {
  const state = loadJson(BOARD_FILE, {});
  const channel = await client.channels.fetch(CHANNEL_ID).catch((e) => {
    console.warn('[pin-board] fetch channel failed', e?.message || e);
    return null;
  });
  if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');

  if (state.messageId) {
    const msg = await channel.messages.fetch(state.messageId).catch(() => null);
    if (msg) {
      const out = await msg.edit(content);
      if (!out.pinned) { try { await out.pin(); } catch (e) { console.warn('[pin-board] pin failed (edit)', e?.message || e); } }
      return out.id;
    }
  }
  const sent = await channel.send(content);
  try { await sent.pin(); } catch (e) { console.warn('[pin-board] pin failed (new)', e?.message || e); }
  state.messageId = sent.id;
  saveJson(BOARD_FILE, state);
  return sent.id;
}

async function main() {
const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN not set; cannot run pin script.');
  process.exit(1);
}
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);

  const guildId = client.guilds.cache.first()?.id;
  if (!guildId) throw new Error('Bot not in any guild');
  const leagueId = resolveLeagueIdWithConfig(guildId);
  const snapshot = loadLeagueSnapshot(leagueId);
  const fairData = loadJson(FAIR_FILE, {});
  const season = seasonKey(snapshot);
  const guild = await client.guilds.fetch(guildId);
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

  const id = await upsertBoardMessage(client, { embeds: [embed] });
  console.log('Board message ID', id);
  await client.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
