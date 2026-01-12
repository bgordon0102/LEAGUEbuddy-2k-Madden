import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { getMessageForWeek } from './madden_utils.js';

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const PREV_DIR = path.join(LEAGUE_DIR, 'previous');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

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
      name: t.displayName || t.nickName || t.cityName || `Team ${t.teamId}`,
      abbr: t.abbrName || t.displayName || t.nickName || `T${t.teamId}`,
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

const devEmojis = loadJson(path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json')) || {};
const devMap = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };

// Allowlist of attributes to report
const allowedAttrs = new Set([
  'playerBestOvr',
  'awareRating', 'accelRating', 'agilityRating', 'strengthRating',
  'throwAccuracyRating', 'throwPowerRating', 'breakSackRating', 'playActionRating',
  'throwOnRunRating', 'throwUnderPressureRating',
  'shortRouteRunRating', 'medRouteRunRating', 'deepRouteRunRating',
  'catchRating', 'specCatchRating', 'cITRating', 'jumpRating',
  'changeOfDirectionRating', 'carryingRating', 'bCVRating', 'truckRating', 'stiffArmRating',
  'spinMoveRating', 'jukeMoveRating', 'runBlockRating', 'runBlockPowerRating', 'runBlockFinesseRating',
  'passBlockRating', 'passBlockPowerRating', 'passBlockFinesseRating', 'impactBlockRating',
  'leadBlockRating', 'breakTackleRating', 'ballCarrierVisionRating', 'tackleRating', 'hitPowerRating',
  'pursuitRating', 'playRecognitionRating', 'blockShedRating', 'finesseMovesRating', 'powerMovesRating',
  'pressRating', 'manCoverageRating', 'zoneCoverageRating', 'kickPowerRating', 'kickAccuracyRating',
  'kickReturnRating', 'staminaRating', 'injuryRating', 'toughnessRating'
]);

const labelMap = {
  playerBestOvr: 'OVR',
  awareRating: 'AWR',
  accelRating: 'ACC',
  agilityRating: 'AGI',
  strengthRating: 'STR',
  throwAccuracyRating: 'THA',
  throwPowerRating: 'THP',
  breakSackRating: 'BKS',
  playActionRating: 'PAC',
  throwOnRunRating: 'TOR',
  throwUnderPressureRating: 'TUP',
  shortRouteRunRating: 'SRR',
  medRouteRunRating: 'MRR',
  deepRouteRunRating: 'DRR',
  catchRating: 'CTH',
  specCatchRating: 'SPC',
  cITRating: 'CIT',
  jumpRating: 'JMP',
  changeOfDirectionRating: 'COD',
  carryingRating: 'CAR',
  bCVRating: 'BCV',
  truckRating: 'TRK',
  stiffArmRating: 'SFA',
  spinMoveRating: 'SPM',
  jukeMoveRating: 'JKM',
  runBlockRating: 'RBK',
  runBlockPowerRating: 'RBP',
  runBlockFinesseRating: 'RBF',
  passBlockRating: 'PBK',
  passBlockPowerRating: 'PBP',
  passBlockFinesseRating: 'PBF',
  impactBlockRating: 'IMP',
  leadBlockRating: 'LBK',
  breakTackleRating: 'BTK',
  ballCarrierVisionRating: 'BCV',
  tackleRating: 'TAK',
  hitPowerRating: 'HPW',
  pursuitRating: 'PUR',
  playRecognitionRating: 'PRC',
  blockShedRating: 'BSH',
  finesseMovesRating: 'FMV',
  powerMovesRating: 'PMV',
  pressRating: 'PRS',
  manCoverageRating: 'MCV',
  zoneCoverageRating: 'ZCV',
  kickPowerRating: 'KPW',
  kickAccuracyRating: 'KAC',
  kickReturnRating: 'RET',
  staminaRating: 'STA',
  injuryRating: 'INJ',
  toughnessRating: 'TGH',
};

function playerLabel(p) {
  const name = `${p.firstName || ''} ${p.lastName || ''}`.trim() || (p.fullName || '').trim() || 'Unknown';
  const pos = p.position || '';
  const ovr = p.playerBestOvr || p.teamSchemeOvr || p.playerSchemeOvr || 'N/A';
  const devEmojiId = devEmojis?.[p.devTrait] ?? devEmojis?.[String(p.devTrait)];
  const devText = devMap[p.devTrait] || 'Normal';
  const dev = devEmojiId ? `<:dev_${p.devTrait}:${devEmojiId}>` : `(${devText})`;
  return `${pos} ${name} - ${ovr} OVR ${dev}`;
}

function diffPlayer(prev, curr) {
  const changes = [];
  if (!prev || !curr) return changes;
  if (prev.position !== curr.position) {
    changes.push({ label: 'Position', from: prev.position || 'N/A', to: curr.position || 'N/A' });
  }
  if (prev.devTrait !== curr.devTrait) {
    const fromEmojiId = devEmojis?.[prev.devTrait] ?? devEmojis?.[String(prev.devTrait)];
    const toEmojiId = devEmojis?.[curr.devTrait] ?? devEmojis?.[String(curr.devTrait)];
    const fromLabel = fromEmojiId ? `<:dev_${prev.devTrait}:${fromEmojiId}>` : (devMap[prev.devTrait] || 'Normal');
    const toLabel = toEmojiId ? `<:dev_${curr.devTrait}:${toEmojiId}>` : (devMap[curr.devTrait] || 'Normal');
    changes.push({ label: 'Dev Trait', from: fromLabel, to: toLabel });
  }
  for (const key of Object.keys(curr)) {
    if (!allowedAttrs.has(key)) continue;
    const a = Number(prev[key]);
    const b = Number(curr[key]);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      const label = labelMap[key] || key.replace(/Rating$/i, '').replace(/_/g, ' ');
      changes.push({ label, from: a, to: b });
    }
  }
  return changes;
}

function chunkLines(lines, maxLen = 900) {
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

export async function updatePlayerChanges(client, leagueId) {
  const currPath = path.join(LEAGUE_DIR, `${leagueId}.json`);
  const prevPath = path.join(PREV_DIR, `${leagueId}.json`);
  const curr = loadJson(currPath);
  const prev = loadJson(prevPath);
  if (!curr || !prev) {
    console.warn('[player_changes] Missing snapshot(s); skipping changes.');
    return;
  }
  const channelMap = loadChannelMap();
  const channelId = channelMap['Player Change Log'];
  if (!channelId) {
    console.warn('[player_changes] Player Change Log channel missing.');
    return;
  }
  const roleMap = loadJson(ROLE_MAP_FILE) || {};
  const commishMentions = ['Madden Commish', 'Madden Co-Commish']
    .map(r => roleMap[r] ? `<@&${roleMap[r]}>` : null)
    .filter(Boolean)
    .join(' ');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn('[player_changes] Player Change Log channel not text-based or missing.');
    return;
  }

  const teams = teamNameMap(curr);
  const prevPlayers = buildPlayerMap(prev).players;
  const currTeamMap = buildPlayerMap(curr).byTeam;

  const weekLabel = curr.currentWeek ? `${curr.currentWeek} (${getMessageForWeek(curr.currentWeek)})` : 'Week';

  for (const [teamId, players] of Object.entries(currTeamMap)) {
    const lines = [];
    let positionChangedForTeam = false;
    for (const [key, currPlayer] of Object.entries(players)) {
      const prevPlayer = prevPlayers[key];
      if (!prevPlayer) continue;
      const diffs = diffPlayer(prevPlayer, currPlayer);
      if (!diffs.length) continue;
      if (diffs.some(d => d.label === 'Position')) positionChangedForTeam = true;
      const header = `**${playerLabel(currPlayer)}**`;
      const body = diffs.map(d => `${d.label}: ${d.from}->${d.to}`).join('\n');
      lines.push(`${header}\n${body}`);
    }
    if (!lines.length) continue;
    const chunks = chunkLines(lines);
    const teamMeta = teams[teamId] || {};
    const teamName = teamMeta.name || 'Team';
    const teamAbbr = teamMeta.abbr || '';
    for (const part of chunks) {
      const embed = new EmbedBuilder()
        .setTitle(`${teamName} Attribute/Position Changes${teamAbbr ? ` - ${teamAbbr}` : ''}`)
        .setDescription(`Regular Season Week ${weekLabel}`)
        .addFields({ name: '\u200b', value: part.join('\n\n') })
        .setColor(0x1e90ff)
        .setTimestamp(new Date());
      const content = positionChangedForTeam ? commishMentions : null;
      await channel.send({ content: content || undefined, embeds: [embed] }).catch(() => null);
    }
  }
}

export default { updatePlayerChanges };
