import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];
// Specific fallback pin/message id provided by user
const FALLBACK_PIN_ID = '1469153107207393465';

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
  } catch (err) {
    if ([50027, 10015, 10062].includes(err?.code) && interaction.channel?.isTextBased()) {
      await interaction.channel.send(typeof payload === 'string' ? payload : { ...payload, ephemeral: false });
      return;
    }
    throw err;
  }
}

function loadRoleMap() {
  try {
    const raw = fs.readFileSync(ROLE_MAP_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadChannelMap() {
  try {
    const raw = fs.readFileSync(CHANNEL_MAP_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizeName(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs') return 'Buccaneers';
  if (lower === 'pats') return 'Patriots';
  if (lower === 'bolts') return 'Chargers';
  if (lower === 'pack') return 'Packers';
  return name;
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function formatTeamName(team) {
  const nick = normalizeName(team?.displayName) || normalizeName(team?.nickName);
  const city = team?.cityName;
  if (city && nick) return `${city} ${nick}`;
  return nick || city || `Team ${team?.teamId}`;
}

function resolveRoleId(team, roleMap) {
  const nick = normalizeName(team?.displayName) || normalizeName(team?.nickName) || '';
  const city = team?.cityName || '';
  const abbr = team?.abbrName || team?.teamAbbr || '';
  const mascot = (nick || '').split(/\s+/).pop();

  const normalizeKey = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const roleEntries = Object.entries(roleMap || {})
    .filter(([k]) => /coach$/i.test(k)) // use only coach roles from the Madden map
    .map(([k, v]) => ({
      raw: k,
      norm: normalizeKey(k),
      id: v,
    }));

  const candidates = [
    `${nick} Coach`,
    `${city} ${nick} Coach`,
    `${normalizeName(city)} ${nick} Coach`,
    `${abbr} Coach`,
    `${mascot} Coach`,
  ].filter(Boolean);

  for (const c of candidates) {
    const norm = normalizeKey(c);
    const found = roleEntries.find(r => r.norm === norm || r.norm.includes(norm) || norm.includes(r.norm));
    if (found) return found.id;
  }
  return null;
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const roleMap = loadRoleMap();
  const channelMap = loadChannelMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await safeEditReply(interaction, { content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await safeEditReply(interaction, { content: 'No league set. Run /madden-set-league first.' });
    return;
  }

  try {
    // Best effort: get a member list; if intents are off, fallback to role.members size.
    let roleCounts = null;
    try {
      const members = await interaction.guild.members.fetch();
      roleCounts = {};
      members.forEach(m => {
        m.roles.cache.forEach(r => {
          roleCounts[r.id] = (roleCounts[r.id] || 0) + 1;
        });
      });
    } catch (e) {
      console.warn('[madden-availableteams] member fetch skipped:', e?.message || e);
      roleCounts = null;
    }

    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    const standings = snapshot?.standings?.teamStandingInfoList || [];
    const standingsByTeam = new Map();
    standings.forEach(s => standingsByTeam.set(s.teamId, s));

    const lines = [];
    for (const t of teams) {
      const roleId = resolveRoleId(t, roleMap);
      let assigned = false;
      if (roleId) {
        let count = (roleCounts && typeof roleCounts[roleId] === 'number') ? roleCounts[roleId] : undefined;
        if (count === undefined) {
          const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
          count = role?.members ? role.members.size : 0;
        }
        assigned = count > 0;
      }
      if (assigned) continue;
      const rec = standingsByTeam.get(t.teamId);
      const wins = rec?.totalWins ?? rec?.wins ?? 0;
      const losses = rec?.totalLosses ?? rec?.losses ?? 0;
      const ties = rec?.totalTies ?? rec?.ties ?? 0;
      const record = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
      lines.push(`${formatTeamName(t)}: ${record}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('Madden Available Teams')
      .setDescription(lines.length ? lines.join('\n') : 'No open teams.')
      .setColor(0x00b0f4);
    await safeEditReply(interaction, { embeds: [embed] });
  } catch (err) {
    await safeEditReply(interaction, { content: `Failed to load teams: ${err.message || err}` });
  }
}

const data = new SlashCommandBuilder()
  .setName('madden-availableteams')
  .setDescription('List unassigned teams (staff-only).')
  .setDefaultMemberPermissions(null);

export default { data, execute };
