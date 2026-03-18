import { SlashCommandBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { draftOrder, applyPickTrades } from '../coach/mockdraft.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { getCoachAssignmentMap } from '../../shared/madden_coach_assignments.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const STAFF_ROLES = ['Ghost Legacy Commish', 'Ghost Legacy Co-Commish'];

function safeEditReply(interaction, payload) {
  return interaction.editReply(payload).catch(async (err) => {
    if ([50027, 10015, 10062].includes(err?.code) && interaction.channel?.isTextBased()) {
      return interaction.channel.send(typeof payload === 'string' ? payload : { ...payload, ephemeral: false });
    }
    throw err;
  });
}

function loadRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8'));
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

function resolveRoleId(team, roleMap) {
  const nick = normalizeName(team?.displayName) || normalizeName(team?.nickName) || '';
  const city = team?.cityName || '';
  const abbr = team?.abbrName || team?.teamAbbr || '';
  const mascot = (nick || '').split(/\s+/).pop();
  const normalizeKey = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const roleEntries = Object.entries(roleMap || {})
    .filter(([k]) => /coach$/i.test(k))
    .map(([k, v]) => ({ norm: normalizeKey(k), id: v }));

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

function formatTeamName(team) {
  return getFullTeamName(team, `Team ${team?.teamId}`);
}

function normalizeKey(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildPickMap(snapshot) {
  if (!snapshot) return new Map();
  let order = [];
  try {
    const seasonYear =
      snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear ||
      snapshot?.info?.calendarYear ||
      snapshot?.calendarYear;
    order = applyPickTrades(draftOrder(snapshot), seasonYear);
  } catch { return new Map(); }
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

function uniqPicks(picks = []) {
  const seen = new Set();
  const out = [];
  for (const p of picks) {
    const key = `${p.num}|${p.via || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export const data = new SlashCommandBuilder()
  .setName('madden-promo')
  .setDescription('Staff: Post promo + currently available Madden teams.')
  .addBooleanOption(o =>
    o.setName('link')
      .setDescription('Include the public join link at the bottom')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  try {
    await interaction.deferReply({ ephemeral: false });
  } catch {
    // if already acknowledged, continue
  }
  try {
    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!STAFF_ROLES.some(r => roleMap[r] && member.roles.cache.has(roleMap[r]))) {
      await safeEditReply(interaction, { content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
      return;
    }

    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await safeEditReply(interaction, { content: 'No league set. Run /madden-set-league first.' });
      return;
    }

    const includeLink = interaction.options.getBoolean('link') ?? false;

    const assignmentMap = getCoachAssignmentMap({ guildId: interaction.guildId });
    const assignedTeams = assignmentMap?.teamToUserIds || new Map();

    const snapshot = loadLeagueSnapshot(leagueId);
    const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
    const isOffseason = (seasonInfo.seasonWeekType === 8) ||
      (seasonInfo.seasonTitle || '').toLowerCase().includes('offseason') ||
      (seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && seasonInfo.seasonWeekType !== 1);
    const pickMap = buildPickMap(snapshot);
    const debug = process.env.MOCK_DEBUG === 'true';
    if (debug) {
      console.log('[promo] seasonInfo', seasonInfo);
      console.log('[promo] isOffseason', isOffseason);
    }
    const seasonNumber = seasonInfo.seasonNumber ?? seasonInfo.seasonIndex ?? (seasonInfo.calendarYear ? seasonInfo.calendarYear + 1 : '–');
    const weekNumber = (isOffseason && seasonInfo.offSeasonStage)
      ? `Offseason (Stage ${seasonInfo.offSeasonStage})`
      : (seasonInfo.displayWeek ?? seasonInfo.seasonWeek ?? seasonInfo.weekIndex ?? '–');
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    const standings = snapshot?.standings?.teamStandingInfoList || [];
    const standingsByTeam = new Map();
    standings.forEach(s => standingsByTeam.set(s.teamId, s));

    const openLines = [];
    for (const t of teams) {
      const roleId = resolveRoleId(t, roleMap);
      let assigned = false;
      const teamName = formatTeamName(t);
      if ((assignedTeams.get(normalizeKey(teamName)) || new Set()).size > 0) {
        assigned = true;
      }
      if (roleId) {
        // Don't rely purely on cached role.members which can lag if roles were just assigned.
        // Fetch the role fresh so last-second assignments don't cause the whole league to appear open.
        const role = await interaction.guild.roles.fetch(String(roleId)).catch(() => null);
        const count = role?.members?.size ?? 0;
        assigned = assigned || count > 0;
      }
      if (assigned) continue;
      if (isOffseason) {
        const nameFormatted = teamName;
        const keys = [
          normalizeKey(nameFormatted),
          normalizeKey((nameFormatted.split(/\s+/).pop()) || ''),
          normalizeKey(t.nickName || ''),
          normalizeKey((t.nickName || '').split(/\s+/).pop() || ''),
        ].filter(Boolean);
        const seen = new Set();
        let merged = [];
        for (const k of keys) {
          if (seen.has(k)) continue;
          seen.add(k);
          const arr = pickMap.get(k);
          if (arr && arr.length) merged = merged.concat(arr);
        }
        if (debug) console.log('[promo] open team', nameFormatted, 'keys', keys, 'picks', merged);
        const deduped = uniqPicks(merged).sort((a, b) => a.num - b.num);
        const pickText = deduped && deduped.length
          ? deduped.map(p => p.via ? `${p.num} (via ${p.via})` : `${p.num}`).join(', ')
          : 'none';
        openLines.push(`${nameFormatted} — Picks: ${pickText}`);
      } else {
        const rec = standingsByTeam.get(t.teamId);
        const wins = rec?.totalWins ?? rec?.wins ?? 0;
        const losses = rec?.totalLosses ?? rec?.losses ?? 0;
        const ties = rec?.totalTies ?? rec?.ties ?? 0;
        const record = ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
        openLines.push(`${teamName} (${record})`);
      }
    }

    const promoLines = [
      '**Ghost Legacy Madden**',
      `Season ${seasonNumber} • ${weekNumber}`,
      '',
      'A modern franchise league powered by LEAGUEbuddy.',
      '48 HR advances • All-Madden • Streaming Required',
      'Discord economy for player upgrades',
      '',
      '**What the league offers:**',
      '📡 Live league updates, standings, stat leaders, Top 100s, awards, and story-driven weekly content',
      '🎮 Automated game threads, featured Game of the Week, reminders, staff logs, and clean trade flow',
      '🕵️ Private Franchise Hub, scouting, draft primer, mock draft, and matchup strategy tools built around your team',
      '🎟️ LB Sportsbook, recognition progression, perks, and seasonal league systems tied into real league activity',
      '',
      '**Open Teams**',
      openLines.length ? openLines.join('\n') : 'No open teams right now.',
      '',
      includeLink ? '**Join:** https://discord.gg/ghostsgaming' : null,
    ].filter(Boolean).join('\n');

    await safeEditReply(interaction, { content: promoLines });
  } catch (err) {
    console.error('[madden-promo] failed', err);
    const msg = 'There was an error building the promo. Please try again after a sync.';
    if (interaction.deferred || interaction.replied) {
      await safeEditReply(interaction, { content: msg });
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => { });
    }
  }
}

export default { data, execute };
