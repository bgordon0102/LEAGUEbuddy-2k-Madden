import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { draftOrder, applyPickTrades } from './coach/mockdraft.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const EMOJI_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const PIN_FILE = path.join(process.cwd(), 'data', 'madden', 'pins_available_teams.json');
const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');

const CONFERENCES = {
  AFC: new Set([
    'Bills', 'Dolphins', 'Patriots', 'Jets',
    'Ravens', 'Bengals', 'Browns', 'Steelers',
    'Texans', 'Colts', 'Jaguars', 'Titans',
    'Broncos', 'Chiefs', 'Raiders', 'Chargers'
  ]),
  NFC: new Set([
    'Cowboys', 'Giants', 'Eagles', 'Commanders',
    'Bears', 'Lions', 'Packers', 'Vikings',
    'Falcons', 'Panthers', 'Saints', 'Buccaneers',
    'Cardinals', 'Rams', '49ers', 'Seahawks'
  ]),
};

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2));
}

function loadLatestLeagueSnapshot() {
  try {
    const files = fs.readdirSync(LEAGUE_DIR).filter(f => f.endsWith('.json')).sort((a, b) =>
      fs.statSync(path.join(LEAGUE_DIR, b)).mtimeMs - fs.statSync(path.join(LEAGUE_DIR, a)).mtimeMs
    );
    if (!files.length) return null;
    return JSON.parse(fs.readFileSync(path.join(LEAGUE_DIR, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

function normalizeKey(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildPickMap(league) {
  if (!league) return new Map();
  let order = [];
  try {
    const seasonYear =
      league?.info?.careerHubInfo?.seasonInfo?.calendarYear ||
      league?.info?.calendarYear ||
      league?.calendarYear;
    order = applyPickTrades(draftOrder(league), seasonYear);
  } catch {
    return new Map();
  }
  const map = new Map();
  order.forEach((pick, idx) => {
    const ownerName = pick.name || pick.nick || '';
    const keys = [
      normalizeKey(ownerName),
      normalizeKey(ownerName.split(/\s+/).pop() || ownerName),
    ].filter(Boolean);
    if (!keys.length) return;
    const entry = { num: idx + 1, via: pick.via };
    keys.forEach(k => {
      const list = map.get(k) || [];
      list.push(entry);
      map.set(k, list);
    });
  });
  return map;
}

function teamRoles(roleMap) {
  return Object.entries(roleMap)
    .filter(([name]) => name.endsWith(' Coach'))
    .map(([name, id]) => ({ team: name.replace(/ Coach$/, ''), roleId: id }));
}

function formatAssignments(guild, roles, opts = {}) {
  const { pickMap = new Map(), isOffseason = false, debug = false } = opts;
  const emojiMap = loadJson(EMOJI_MAP_FILE);
  return roles.map(r => {
    const role = guild.roles.cache.get(r.roleId);
    if (!role) return { team: r.team, value: 'Open' };
    const members = [...role.members.values()];
    // Show coach names without raw mention IDs to avoid ugly formatting
    const names = members.length
      ? members.map(m => m.displayName || m.user?.username || m.user?.tag || m.id).join(', ')
      : 'Open';
    let value = names;
    // For the pin, do NOT show picks when open
    const emojiId = emojiMap[r.team];
    const emoji = emojiId ? `<:team_${r.team.toLowerCase()}:${emojiId}> ` : '';
    return { team: `${emoji}${r.team}`, value, rawTeam: r.team };
  });
}

function chunkFields(fields) {
  const chunks = [];
  let current = [];
  let len = 0;
  let count = 0;
  for (const f of fields) {
    const addLen = (f.name?.length || 0) + (f.value?.length || 0);
    const nextCount = count + 1;
    if ((len + addLen > 5500 || nextCount > 25) && current.length) {
      chunks.push(current);
      current = [];
      len = 0;
      count = 0;
    }
    current.push(f);
    len += addLen;
    count += 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function updateAvailableTeamsPin(client, guildId, options = {}) {
  const attempt = async () => {
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const channelId = channelMap['Available Teams'];
    if (!channelId) {
      console.warn('[available-teams] Channel ID missing in madden_channel_ids.json');
      return false;
    }
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      console.warn('[available-teams] Guild not found');
      return false;
    }
    try { await guild.members.fetch(); } catch { }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn('[available-teams] Channel not text-based or missing');
      return false;
    }

    const roles = teamRoles(roleMap).sort((a, b) => a.team.localeCompare(b.team));
    const league = loadLatestLeagueSnapshot();
    const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
    const isOffseason = (seasonInfo.seasonWeekType === 8) ||
      (seasonInfo.seasonTitle || '').toLowerCase().includes('offseason') ||
      (seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && seasonInfo.seasonWeekType !== 1);
    const pickMap = buildPickMap(league);
    const debug = process.env.MOCK_DEBUG === 'true';
    if (debug) {
      console.log('[available-teams] seasonInfo', seasonInfo);
      console.log('[available-teams] isOffseason', isOffseason);
    }
    const assignments = formatAssignments(guild, roles, { pickMap, isOffseason, debug });

    const byConf = { AFC: [], NFC: [] };
    assignments.forEach(a => {
      if (CONFERENCES.AFC.has(a.rawTeam)) byConf.AFC.push(a);
      else if (CONFERENCES.NFC.has(a.rawTeam)) byConf.NFC.push(a);
    });

    const makeEmbeds = (title, list) => {
      const fields = list
        .sort((a, b) => a.rawTeam.localeCompare(b.rawTeam))
        .map(a => ({ name: a.team, value: a.value || 'Open', inline: true }));
      const chunks = chunkFields(fields);
      return chunks.map((chunk, idx) => new EmbedBuilder()
        .setTitle(idx === 0 ? title : '\u200b')
        .setDescription('Auto-updated when coaches are assigned.')
        .addFields(chunk)
        .setColor(0x00a3ff)
        .setTimestamp(new Date())
      );
    };

    const embeds = [
      ...makeEmbeds('Available Teams — AFC', byConf.AFC),
      ...makeEmbeds('Available Teams — NFC', byConf.NFC),
    ].filter(e => e && e.data?.fields?.length);

    if (!embeds.length) {
      console.warn('[available-teams] No embeds built (no assignments/teams). Skipping.');
      return false;
    }

    const pinId = '1479545575903858791';
    const botPin = await channel.messages.fetch(pinId).catch(() => null);
    if (!botPin) {
      console.warn('[available-teams] No existing pin found; skipping update.');
      return false;
    }
    await botPin.edit({ embeds, content: null }).catch(() => null);
    return true;
  };

  await attempt();
}

export default { updateAvailableTeamsPin };
