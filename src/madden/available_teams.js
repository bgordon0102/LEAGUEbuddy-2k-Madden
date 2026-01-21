import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const EMOJI_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const PIN_FILE = path.join(process.cwd(), 'data', 'madden', 'pins_available_teams.json');

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

function teamRoles(roleMap) {
  return Object.entries(roleMap)
    .filter(([name]) => name.endsWith(' Coach'))
    .map(([name, id]) => ({ team: name.replace(/ Coach$/, ''), roleId: id }));
}

function formatAssignments(guild, roles) {
  const emojiMap = loadJson(EMOJI_MAP_FILE);
  return roles.map(r => {
    const role = guild.roles.cache.get(r.roleId);
    if (!role) return { team: r.team, value: 'Open' };
    const members = [...role.members.values()];
    // Show coach names without raw mention IDs to avoid ugly formatting
    const names = members.length
      ? members.map(m => m.displayName || m.user?.username || m.user?.tag || m.id).join(', ')
      : 'Open';
    const emojiId = emojiMap[r.team];
    const emoji = emojiId ? `<:team_${r.team.toLowerCase()}:${emojiId}> ` : '';
    return { team: `${emoji}${r.team}`, value: names, rawTeam: r.team };
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
  const allowCreate = options.allowCreate === true;
  const delayMs = options.delayMs || 0;
  const retries = options.retries || 0;
  const retryDelayMs = options.retryDelayMs || 1000;
  const guildOverride = options.guild;
  const skipMemberFetch = options.skipMemberFetch === true;

  const attempt = async () => {
    if (delayMs > 0) {
      await new Promise(res => setTimeout(res, delayMs));
    }
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const channelId = channelMap['Available Teams'];
    if (!channelId) {
      console.warn('[available-teams] Channel ID missing in madden_channel_ids.json');
      return false;
    }
    const guild = guildOverride || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      console.warn('[available-teams] Guild not found');
      return false;
    }
    // Refresh member cache so role membership is accurate
    if (!skipMemberFetch) {
      try { await guild.members.fetch(); } catch { }
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.warn('[available-teams] Channel not text-based or missing');
      return false;
    }

    const roles = teamRoles(roleMap).sort((a, b) => a.team.localeCompare(b.team));
    const assignments = formatAssignments(guild, roles);

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

    const pinState = loadJson(PIN_FILE);
    let botPin = null;
    if (pinState.messageId) {
      botPin = await channel.messages.fetch(pinState.messageId).catch(() => null);
    }
    if (!botPin) {
      const pins = await channel.messages.fetchPins().catch(() => null);
      const list = pins && typeof pins.values === 'function' ? Array.from(pins.values()) : [];
      for (const m of list) {
        if (m?.author?.id === client.user.id) { botPin = m; break; }
      }
      if (botPin && !pinState.messageId) {
        saveJson(PIN_FILE, { messageId: botPin.id });
      }
    }

    if (!botPin) {
      if (!allowCreate) {
        console.warn('[available-teams] No existing bot pin found; skipping update (will not create a new pin).');
        return false;
      }
      // Create new pin
      const msg = await channel.send({ embeds, content: null }).catch(() => null);
      if (!msg) {
        console.warn('[available-teams] Failed to create new pin message.');
        return false;
      }
      try { await msg.pin(); } catch {}
      saveJson(PIN_FILE, { messageId: msg.id });
      return true;
    }

    const edited = await botPin.edit({ embeds, content: null }).catch(() => null);
    if (!edited) {
      console.warn('[available-teams] Failed to edit existing pin.');
      return false;
    }
    if (!pinState.messageId) {
      saveJson(PIN_FILE, { messageId: botPin.id });
    }
    return true;
  };

  let ok = await attempt();
  let tries = 0;
  while (!ok && tries < retries) {
    tries += 1;
    await new Promise(res => setTimeout(res, retryDelayMs));
    ok = await attempt();
  }
}

export default { updateAvailableTeamsPin };
