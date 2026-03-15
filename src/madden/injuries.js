import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { getMessageForWeek } from './madden_utils.js';
import { appendMaddenStaffLog, postMaddenStaffLog } from '../shared/madden_staff_ops.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const PREV_DIR = path.join(LEAGUE_DIR, 'previous');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function loadChannelMap() { return loadJson(CHANNEL_MAP_FILE) || {}; }

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

function buildPlayerMap(snapshot) {
  const byTeam = {};
  const players = {};
  const teams = snapshot?.rosters?.teams || {};
  for (const [teamId, roster] of Object.entries(teams)) {
    const list = roster?.rosterInfoList || [];
    byTeam[teamId] = {};
    list.forEach(p => {
      const key = p.rosterId ?? `${p.firstName}-${p.lastName}-${p.position}`;
      byTeam[teamId][key] = p;
      players[key] = { ...p, teamId };
    });
  }
  return { byTeam, players };
}

function playerLabel(p) {
  const name = `${p.firstName || ''} ${p.lastName || ''}`.trim() || (p.fullName || '').trim() || 'Unknown';
  const pos = p.position || '';
  const ovr = p.playerBestOvr || p.teamSchemeOvr || p.playerSchemeOvr || 'N/A';
  return `${pos} ${name} - ${ovr} OVR`;
}

function chunkLines(lines, maxLen = 3400) {
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

function formatInjury(p) {
  const weeks = Number(p.injuryLength) || 0;
  const status = weeks > 0 ? `Out ${weeks} wk${weeks === 1 ? '' : 's'}` : 'Out (length unknown)';
  return `${playerLabel(p)} — ${status}`;
}

function isPremiumPosition(position = '') {
  const pos = String(position || '').toUpperCase();
  return ['QB', 'LT', 'RT', 'CB', 'WR', 'EDGE', 'LE', 'RE', 'DE'].includes(pos);
}

function isStaffNotableInjury(player, type, offSeasonStage = 0) {
  const ovr = Number(player?.playerBestOvr || player?.teamSchemeOvr || player?.playerSchemeOvr || 0);
  const weeks = Number(player?.injuryLength || 0);
  const pos = String(player?.position || '').toUpperCase();
  const inOffseason = Number(offSeasonStage || 0) > 0;

  if (type === 'recovered') {
    return ovr >= 88 || (pos === 'QB' && ovr >= 82);
  }

  if (inOffseason) {
    return weeks >= 12 || (pos === 'QB' && weeks >= 4) || (ovr >= 90 && weeks >= 4);
  }

  return (
    weeks >= 10 ||
    (pos === 'QB' && weeks >= 3) ||
    (ovr >= 88 && weeks >= 4) ||
    (isPremiumPosition(pos) && ovr >= 84 && weeks >= 6)
  );
}

function lastCompletedWeek(snapshot) {
  const currentWeek = snapshot.currentWeek ?? 0;
  const currentStage = snapshot.stage ?? snapshot.info?.careerHubInfo?.seasonInfo?.seasonWeekType ?? 1;
  const targetIdx = Math.max(0, currentWeek - 1);
  const weeks = Array.isArray(snapshot.weeklyStats) ? snapshot.weeklyStats : [];
  let best = null;
  for (const w of weeks) {
    const st = w.stage ?? w.stageIndex ?? currentStage;
    const wk = w.weekIndex ?? -1;
    const beforeCurrent = (st < currentStage) || (st === currentStage && wk < targetIdx);
    if (!beforeCurrent) continue;
    if (!best || st > best.st || (st === best.st && wk > best.wk)) {
      best = { st, wk };
    }
  }
  if (best) return best;
  return { st: currentStage, wk: targetIdx };
}

export async function updateInjuries(client, leagueId) {
  const currPath = path.join(LEAGUE_DIR, `${leagueId}.json`);
  const prevPath = path.join(PREV_DIR, `${leagueId}.json`);
  const curr = loadJson(currPath);
  const prev = loadJson(prevPath);
  if (!curr || !prev) {
    console.warn('[injuries] Missing snapshot(s); skipping injuries.');
    return;
  }

  const channelMap = loadChannelMap();
  const channelId = channelMap['Injuries Log'];
  if (!channelId) {
    console.warn('[injuries] Injuries Log channel missing.');
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[injuries] Injuries Log channel not text-based or missing.');
    return;
  }

  const teams = teamNameMap(curr);
  const prevPlayers = buildPlayerMap(prev).players;
  const currTeams = buildPlayerMap(curr).byTeam;
  const notableInjuries = [];
  // Use prior week label for logs
  const prevWeekIdx = Math.max(0, (curr.currentWeek ?? 1) - 1);
  const weekEntry = curr.weeklyStats?.find(w => w.weekIndex === prevWeekIdx);
  const seasonWeekType = curr.info?.careerHubInfo?.seasonInfo?.seasonWeekType ?? weekEntry?.stage ?? curr.stage ?? 1;
  const stageForWeek = seasonWeekType === 1 ? 1 : (weekEntry?.stage ?? curr.stage ?? 1);
  const offSeasonStage = curr.info?.careerHubInfo?.seasonInfo?.offSeasonStage ?? 0;
  const last = lastCompletedWeek(curr);
  const weekLabel = getMessageForWeek((last.wk ?? prevWeekIdx) + 1, last.st ?? stageForWeek, offSeasonStage);

  for (const [teamId, roster] of Object.entries(currTeams)) {
    const lines = [];
    for (const [key, player] of Object.entries(roster)) {
      const prevP = prevPlayers[key];
      const wasInjured = prevP ? Number(prevP.injuryLength) > 0 : false;
      const isInjured = Number(player.injuryLength) > 0;
      if (isInjured && !wasInjured) {
        lines.push(`**New Injury** ${formatInjury(player)}`);
        const ovr = Number(player.playerBestOvr || player.teamSchemeOvr || player.playerSchemeOvr || 0);
        const weeks = Number(player.injuryLength || 0);
        if (isStaffNotableInjury(player, 'new', offSeasonStage)) {
          notableInjuries.push({ teamName: teams[teamId]?.name || 'Team', player, weeks, ovr, type: 'new' });
        }
      } else if (!isInjured && wasInjured) {
        lines.push(`**Recovered** ${playerLabel(player)}`);
        const ovr = Number(player.playerBestOvr || player.teamSchemeOvr || player.playerSchemeOvr || 0);
        if (isStaffNotableInjury(player, 'recovered', offSeasonStage)) {
          notableInjuries.push({ teamName: teams[teamId]?.name || 'Team', player, weeks: 0, ovr, type: 'recovered' });
        }
      }
    }
    if (!lines.length) continue;
    const chunks = chunkLines(lines);
    const teamMeta = teams[teamId] || {};
    const teamName = teamMeta.name || 'Team';
    const teamAbbr = teamMeta.abbr || '';
    for (const part of chunks) {
      const embed = new EmbedBuilder()
        .setTitle(`${teamName} Injuries${teamAbbr ? ` - ${teamAbbr}` : ''}`)
        .setDescription(weekLabel)
        .addFields({ name: '\u200b', value: part.join('\n\n') })
        .setColor(0xdc3545)
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }

  if (notableInjuries.length) {
    const lines = notableInjuries.slice(0, 6).map(({ teamName, player, weeks, ovr, type }) =>
      type === 'new'
        ? `${teamName}: ${playerLabel(player)} — out ${weeks} week${weeks === 1 ? '' : 's'}`
        : `${teamName}: ${playerLabel(player)} — recovered`
    );
    appendMaddenStaffLog({
      type: 'notable_injuries',
      guildId: client.guilds.cache.first()?.id || null,
      leagueId,
      count: notableInjuries.length,
      weekLabel,
      lines,
    });
    for (const guild of client.guilds.cache.values()) {
      await postMaddenStaffLog(
        client,
        guild.id,
        'Notable Injury Watch',
        `${weekLabel}: major injury movement worth staff attention.`,
        [{ name: 'Highlights', value: lines.join('\n') }],
      ).catch(() => null);
    }
  }
}

export default { updateInjuries };
