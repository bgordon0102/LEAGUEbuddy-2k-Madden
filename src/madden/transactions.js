import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { getMessageForWeek } from './madden_utils.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const PREV_DIR = path.join(LEAGUE_DIR, 'previous');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadChannelMap() {
  return loadJson(CHANNEL_MAP_FILE) || {};
}

function teamNameMap(snapshot) {
  const map = {};
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  teams.forEach(t => {
    map[t.teamId] = {
      name: getFullTeamName(t, `Team ${t.teamId}`),
      abbr: t.abbrName || getFullTeamName(t, `T${t.teamId}`),
    };
  });
  return map;
}

function formatOvr(p) {
  return p.playerBestOvr || p.teamSchemeOvr || p.playerSchemeOvr || 'N/A';
}

function playerKey(p) {
  return p.rosterId ?? `${p.firstName}-${p.lastName}-${p.position}`;
}

function playerLabel(p) {
  const name = `${p.firstName || ''} ${p.lastName || ''}`.trim() || (p.fullName || '').trim() || 'Unknown';
  return `${p.position || ''} ${name}`.trim();
}

function buildRosters(snapshot) {
  const map = {};
  const teams = snapshot?.rosters?.teams || {};
  for (const [teamId, roster] of Object.entries(teams)) {
    const list = roster?.rosterInfoList || [];
    map[teamId] = {};
    list.forEach(p => {
      map[teamId][playerKey(p)] = p;
    });
  }
  return map;
}

function findPrevTeamForPlayer(prevRostersFlat, key) {
  return prevRostersFlat[key] || null;
}

function diffTransactions(prevSnap, currSnap) {
  if (!prevSnap || !currSnap) return [];
  const currWeek = currSnap.currentWeek ?? null;
  const prevRosters = buildRosters(prevSnap);
  const currRosters = buildRosters(currSnap);

  // Map rosterId -> teamName for prev to detect trades
  const prevTeamByPlayer = {};
  Object.entries(prevRosters).forEach(([tid, players]) => {
    Object.keys(players).forEach(k => { prevTeamByPlayer[k] = tid; });
  });

  const results = [];
  for (const [teamId, currPlayers] of Object.entries(currRosters)) {
    const prevPlayers = prevRosters[teamId] || {};
    const added = [];
    const removed = [];

    Object.entries(currPlayers).forEach(([key, p]) => {
      if (!prevPlayers[key]) {
        const fromTeam = findPrevTeamForPlayer(prevTeamByPlayer, key);
        const traded = fromTeam && fromTeam !== teamId;
        added.push({ player: p, traded });
      }
    });
    Object.entries(prevPlayers).forEach(([key, p]) => {
      if (!currPlayers[key]) {
        removed.push({ player: p });
      }
    });

    if (added.length || removed.length) {
      results.push({
        teamId,
        currentWeek: currWeek,
        added,
        removed,
      });
    }
  }
  return results;
}

function buildLines(teamId, change, teamMeta) {
  const abbr = teamMeta?.abbr || '';
  const lines = [];
  change.added.forEach(({ player, traded }) => {
    const ovr = formatOvr(player);
    const label = playerLabel(player);
    lines.push(`${abbr} SIGNED ${label} (${ovr} OVR)${traded ? ' (TRADED?)' : ''}`);
  });
  change.removed.forEach(({ player }) => {
    const ovr = formatOvr(player);
    const label = playerLabel(player);
    lines.push(`${abbr} RELEASED ${label} (${ovr} OVR)`);
  });
  return lines;
}

function chunkLines(lines, maxLen = 3500) {
  const chunks = [];
  let current = [];
  let len = 0;
  for (const line of lines) {
    const addLen = line.length + 2;
    if (len + addLen > maxLen && current.length) {
      chunks.push(current);
      current = [];
      len = 0;
    }
    current.push(line);
    len += addLen;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function lastCompletedWeek(snapshot) {
  const currentWeek = snapshot.currentWeek ?? 0;
  const currentStage = snapshot.stage ?? snapshot.info?.careerHubInfo?.seasonInfo?.seasonWeekType ?? 1;
  const targetIdx = Math.max(0, currentWeek - 1); // 0-based
  const weeks = Array.isArray(snapshot.weeklyStats) ? snapshot.weeklyStats : [];
  let best = null;
  for (const w of weeks) {
    const st = w.stage ?? w.stageIndex ?? currentStage;
    const wk = w.weekIndex ?? -1;
    const beforeCurrent = (st < currentStage) || (st === currentStage && wk < targetIdx);
    if (!beforeCurrent) continue;
    if (!best) { best = { st, wk }; continue; }
    if (st > best.st || (st === best.st && wk > best.wk)) {
      best = { st, wk };
    }
  }
  if (best) return best;
  return { st: currentStage, wk: targetIdx };
}

export async function updateTransactions(client, leagueId) {
  const currPath = path.join(LEAGUE_DIR, `${leagueId}.json`);
  const prevPath = path.join(PREV_DIR, `${leagueId}.json`);
  const curr = loadJson(currPath);
  const prev = loadJson(prevPath);
  if (!curr || !prev) {
    console.warn('[transactions] Missing snapshot(s); skipping transactions.');
    return;
  }
  const channelMap = loadChannelMap();
  const channelId = channelMap['Transaction Log'];
  if (!channelId) {
    console.warn('[transactions] Transaction Log channel missing.');
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[transactions] Transaction Log channel not text-based or missing.');
    return;
  }

  const teamNames = teamNameMap(curr);
  const changes = diffTransactions(prev, curr);
  if (!changes.length) {
    console.log('[transactions] No roster changes detected.');
    return;
  }
  // Use the previous week when labeling, since updates run after advancing
  const prevWeekIdx = Math.max(0, (curr.currentWeek ?? 1) - 1);
  const weekEntry = curr.weeklyStats?.find(w => w.weekIndex === prevWeekIdx);
  const seasonWeekType = curr.info?.careerHubInfo?.seasonInfo?.seasonWeekType ?? weekEntry?.stage ?? curr.stage ?? 1;
  const stageForWeek = seasonWeekType === 1 ? 1 : (weekEntry?.stage ?? curr.stage ?? 1);
  const offSeasonStage = curr.info?.careerHubInfo?.seasonInfo?.offSeasonStage ?? 0;
  const last = lastCompletedWeek(curr);
  const weekLabel = getMessageForWeek((last.wk ?? prevWeekIdx) + 1, last.st ?? stageForWeek, offSeasonStage);

  for (const change of changes) {
    const teamMeta = teamNames[change.teamId] || {};
    const lines = buildLines(change.teamId, change, teamMeta);
    if (!lines.length) continue;
    const chunks = chunkLines(lines);
    const teamName = teamMeta.name || 'Team';
    for (const part of chunks) {
      const embed = new EmbedBuilder()
        .setTitle(`${teamName} Transactions`)
        .setDescription(weekLabel)
        .addFields({ name: '\u200b', value: part.join('\n\n') })
        .setColor(0x007bff)
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }
}

export default { updateTransactions };
