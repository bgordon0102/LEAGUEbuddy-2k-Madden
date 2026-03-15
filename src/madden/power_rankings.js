import fs from 'fs';
import path from 'path';
import { getPinId, setPinId } from './pins_store.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const RANKS_FILE = path.join(process.cwd(), 'data', 'madden', 'power_ranks.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

function loadSnapshot(leagueId) {
  const file = path.join(process.cwd(), 'data', 'madden', 'leagues', `${leagueId}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function teamEmoji(name, emojiMap) {
  if (!name) return '';
  const target = name.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(emojiMap || {})) {
    const base = key.toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<:${key.replace(/\s+/g, '')}:${val}>`;
    }
  }
  return '';
}

function teamNameMap(snapshot) {
  const map = {};
  const list = snapshot?.teams?.leagueTeamInfoList || [];
  list.forEach(t => {
    if (!t.teamId) return;
    const name = getFullTeamName(t, `Team ${t.teamId}`);
    map[t.teamId] = name || `Team ${t.teamId}`;
  });
  return map;
}

function formatRecord(s) {
  const w = s?.totalWins ?? 0;
  const l = s?.totalLosses ?? 0;
  const t = s?.totalTies ?? 0;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}

function completedRegularGames(snapshot) {
  return (snapshot?.schedule?.schedules || []).filter((game) => {
    const stage = Number(game?.stageIndex ?? game?.stage ?? -1);
    const status = Number(game?.status ?? 0);
    return stage === 1 && status >= 2;
  });
}

function recentFormMap(snapshot) {
  const games = completedRegularGames(snapshot);
  const weeks = [...new Set(games.map((game) => Number(game.weekIndex)).filter((n) => Number.isFinite(n)))].sort((a, b) => b - a).slice(0, 2);
  const form = new Map();
  for (const game of games.filter((g) => weeks.includes(Number(g.weekIndex)))) {
    const homeTeamId = Number(game.homeTeamId);
    const awayTeamId = Number(game.awayTeamId);
    const homeScore = Number(game.homeScore || 0);
    const awayScore = Number(game.awayScore || 0);
    const ensure = (teamId) => {
      if (!form.has(teamId)) form.set(teamId, { wins: 0, losses: 0, margin: 0, pointsFor: 0, pointsAgainst: 0 });
      return form.get(teamId);
    };
    const home = ensure(homeTeamId);
    const away = ensure(awayTeamId);
    home.pointsFor += homeScore;
    home.pointsAgainst += awayScore;
    away.pointsFor += awayScore;
    away.pointsAgainst += homeScore;
    home.margin += homeScore - awayScore;
    away.margin += awayScore - homeScore;
    if (homeScore > awayScore) {
      home.wins += 1;
      away.losses += 1;
    } else if (awayScore > homeScore) {
      away.wins += 1;
      home.losses += 1;
    }
  }
  return form;
}

function rankTeams(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const allZero = standings.every(s => (s.totalWins ?? 0) === 0 && (s.totalLosses ?? 0) === 0 && (s.totalTies ?? 0) === 0);
  if (!standings.length || allZero) return [];
  const recentForm = recentFormMap(snapshot);
  const scored = [...standings].map((team) => {
    const wins = Number(team.totalWins || 0);
    const losses = Number(team.totalLosses || 0);
    const gamesPlayed = Math.max(1, wins + losses + Number(team.totalTies || 0));
    const winPct = Number(team.winPct ?? (wins / gamesPlayed) ?? 0);
    const netPts = Number(team.netPts || 0);
    const offTotalYds = Number(team.offTotalYds || 0);
    const ptsFor = Number(team.ptsFor || 0);
    const ptsAgainst = Number(team.ptsAgainst || 0);
    const recent = recentForm.get(Number(team.teamId)) || { wins: 0, losses: 0, margin: 0, pointsFor: 0, pointsAgainst: 0 };
    const score =
      (winPct * 100) +
      (netPts * 0.9) +
      ((ptsFor - ptsAgainst) * 0.6) +
      ((offTotalYds / gamesPlayed) * 0.015) +
      (recent.wins * 6) -
      (recent.losses * 4) +
      (recent.margin * 0.35);
    return { ...team, _powerScore: score };
  });
  const sorted = scored.sort((a, b) =>
    (b._powerScore ?? 0) - (a._powerScore ?? 0) ||
    (b.winPct ?? 0) - (a.winPct ?? 0) ||
    (b.netPts ?? 0) - (a.netPts ?? 0) ||
    (b.totalWins ?? 0) - (a.totalWins ?? 0)
  );
  return sorted.slice(0, 10);
}

function loadPrevRanks() {
  try {
    return JSON.parse(fs.readFileSync(RANKS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveRanks(map) {
  fs.mkdirSync(path.dirname(RANKS_FILE), { recursive: true });
  fs.writeFileSync(RANKS_FILE, JSON.stringify(map, null, 2));
}

function teamRoleMention(teamName, roleMap) {
  if (!teamName) return null;
  const normalize = (s) => (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/ers$/, 'ers'); // keep 49ers style intact
  const target = normalize(teamName);
  const mascot = normalize(teamName.split(/\s+/).pop());
  for (const [key, val] of Object.entries(roleMap)) {
    if (!key.endsWith(' Coach')) continue;
    const base = normalize(key.replace(/ Coach$/, ''));
    if (base === target || (mascot && base === mascot) || target.includes(base) || base.includes(target)) {
      return `<@&${val}>`;
    }
  }
  return null;
}

export async function updatePowerRankings(client, leagueId) {
  const snapshot = loadSnapshot(leagueId);
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const displayWeek = seasonInfo.displayWeek ?? seasonInfo.seasonWeek ?? 0;
  const hasSeasonData = (snapshot?.weeklyStats || []).some(w => Number(w.weekIndex ?? -1) >= 0) ||
    (snapshot?.standings?.teamStandingInfoList || []).length > 0;
  const inPreseason = displayWeek <= 0 && !hasSeasonData;
  if (inPreseason) {
    // Preseason: keep the placeholder message instead of updating rankings
    await resetPowerRankings(client);
    return;
  }
  const teams = teamNameMap(snapshot);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const emojiMap = loadJson(TEAM_EMOJIS_FILE);

  const ranked = rankTeams(snapshot);
  const prevMap = loadPrevRanks();
  const prev = prevMap[leagueId] || {};
  const hadPreviousRanks = Object.keys(prev).length > 0;
  const fields = [];
  let lines = [];
  const newEntrants = [];
  if (ranked.length === 0) {
    lines = Array.from({ length: 10 }, (_, i) => `${i + 1}) N/A`);
    // reset previous ranks for a fresh season
    prevMap[leagueId] = {};
    saveRanks(prevMap);
  } else {
    lines = ranked.map((s, idx) => {
      const name = teams[s.teamId] || 'Team';
       const emoji = teamEmoji(name, emojiMap);
      const rec = formatRecord(s);
      const currentRank = idx + 1;
      const prevRank = prev[s.teamId];
      let move = '(=)';
      if (prevRank === undefined || prevRank > 10) {
        move = '(new)';
        if (hadPreviousRanks) {
          const mention = teamRoleMention(name, roleMap);
          newEntrants.push({ mention, name, emoji });
        }
      } else {
        const diff = prevRank - currentRank;
        if (diff > 0) move = `(+${diff})`;
        else if (diff < 0) move = `(${diff})`;
      }
      const prefix = emoji ? `${emoji} ` : '';
      return `${currentRank}) ${prefix}${name} — ${rec} ${move}`;
    });
    while (lines.length < 10) lines.push(`${lines.length + 1}) N/A`);
    // Save current ranks for next comparison
    const nextMap = { ...prevMap, [leagueId]: Object.fromEntries(ranked.map((s, idx) => [s.teamId, idx + 1])) };
    saveRanks(nextMap);
  }
  fields.push({ name: 'Top 10', value: lines.join('\n'), inline: false });

  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const channelId = channelMap['Power Rankings'];
  if (!channelId) throw new Error('Power Rankings channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Power Rankings channel not accessible');

  const embed = {
    title: 'Madden Power Rankings',
    color: 0xffcc00,
    fields,
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('power_rankings');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) {
    console.warn('[power_rankings] pin not found; skipping create');
    return;
  }
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);

  // Tag new entrants separately
  if (newEntrants.length && channel?.isTextBased()) {
    console.log('[power_rankings] new entries detected:', newEntrants.map(e => e.name));
    const lines = newEntrants.map(e => {
      const logo = e.emoji ? `${e.emoji} ` : '';
      return `${logo}${e.name || 'Team'} has entered the Top 10!`;
    });
    const roleMentions = newEntrants
      .map(e => (e.mention || '').match(/<@&(\d+)>/))
      .filter(Boolean)
      .map(m => m[1]);
    const announce = {
      title: 'New Teams in the Power Rankings',
      description: lines.join('\n'),
      color: 0xffcc00,
      timestamp: new Date().toISOString(),
    };
    await channel.send({
      content: roleMentions.length ? roleMentions.map(id => `<@&${id}>`).join(' ') : null,
      embeds: [announce],
      allowedMentions: roleMentions.length ? { roles: roleMentions, parse: [] } : { parse: [] },
    }).catch(() => null);
  }
}

export async function resetPowerRankings(client) {
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const channelId = channelMap['Power Rankings'];
  if (!channelId) throw new Error('Power Rankings channel not configured');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) throw new Error('Power Rankings channel not accessible');

  const embed = {
    title: 'Madden Power Rankings',
    description: 'Preseason — rankings will appear once the regular season starts.',
    color: 0xffcc00,
    timestamp: new Date().toISOString(),
  };

  const pinId = getPinId('power_rankings');
  if (!pinId) return;
  const msg = await channel.messages.fetch(pinId).catch(() => null);
  if (!msg) return;
  await msg.edit({ embeds: [embed], content: null }).catch(() => null);
}

export default { updatePowerRankings };
