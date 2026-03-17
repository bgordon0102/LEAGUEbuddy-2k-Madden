import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot } from './madden_data.js';
import { getFullTeamName } from '../shared/madden_team_names.js';
import { deriveTeamNeeds } from './coach/mockdraft.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');
const STATE_FILE = path.join(process.cwd(), 'data', 'madden', 'draft_exports', 'posted_draft_grades.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function teamEmoji(name, emojiMap) {
  if (!name) return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(emojiMap || {})) {
    const kl = k.toLowerCase();
    if (kl === lower || lower.includes(kl) || kl.includes(lower)) {
      return `<:${k.replace(/\s+/g, '')}:${v}>`;
    }
  }
  return '';
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapPositionToNeed(posRaw = '') {
  const pos = String(posRaw || '').toUpperCase();
  if (pos === 'QB') return 'QB';
  if (['HB', 'RB', 'FB', 'TB'].includes(pos)) return 'RB';
  if (['LT', 'RT'].includes(pos)) return 'OT';
  if (['LG', 'C', 'RG'].includes(pos)) return 'IOL';
  if (pos === 'WR') return 'WR';
  if (pos === 'TE') return 'TE';
  if (['LE', 'RE', 'DE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'LDE', 'RDE'].includes(pos)) return 'EDGE';
  if (['DT', 'NT'].includes(pos)) return 'DT';
  if (['MLB', 'ILB', 'LB', 'SAM', 'MIKE', 'WILL', 'ROLB', 'LOLB', 'OLB'].includes(pos)) return 'LB';
  if (pos === 'CB') return 'CB';
  if (['FS', 'SS'].includes(pos)) return 'S';
  return 'BPA';
}

function resolveTeamNeedsForDraftGrades(teamName, needsByTeam = {}) {
  const normalized = normalizeName(teamName);
  if (needsByTeam[normalized]) return needsByTeam[normalized];
  const hit = Object.entries(needsByTeam).find(([key]) => key === normalized || key.includes(normalized) || normalized.includes(key));
  return hit?.[1] || ['BPA'];
}

function computeGrades(snapshot, emojiMap) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const rosters = snapshot?.rosters?.teams || {};
  const needsByTeam = deriveTeamNeeds(snapshot);
  const grades = [];
  const devScore = (dev) => {
    switch (Number(dev)) {
      case 3: return 12;
      case 2: return 9;
      case 1: return 6;
      default: return 0;
    }
  };
  teams.forEach(t => {
    const teamName = getFullTeamName(t, `Team ${t.teamId}`);
    const roster = rosters[t.teamId]?.rosterInfoList || [];
    const rookies = roster.filter(p => Number(p.yearsPro ?? 1) === 0);
    if (!rookies.length) return;
    const teamNeeds = resolveTeamNeedsForDraftGrades(teamName, needsByTeam);
    const avgOvr = rookies.reduce((s, p) => s + (p.playerBestOvr || 0), 0) / rookies.length;
    const topOvr = Math.max(...rookies.map(p => p.playerBestOvr || 0));
    const topThreeAvg = rookies
      .map((p) => Number(p.playerBestOvr || 0))
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((sum, value, _, list) => sum + value / Math.max(1, list.length), 0);
    const devAvg = rookies.reduce((s, p) => s + devScore(p.devTrait), 0) / rookies.length;
    const starCount = rookies.filter((p) => Number(p.devTrait || 0) >= 1).length;
    const superstarCount = rookies.filter((p) => Number(p.devTrait || 0) >= 2).length;
    const xFactorCount = rookies.filter((p) => Number(p.devTrait || 0) >= 3).length;
    const premiumCount = rookies.filter((p) => ['QB', 'LT', 'RT', 'WR', 'TE', 'CB', 'LEDG', 'REDG', 'LE', 'RE', 'EDGE', 'DT'].includes(String(p.position || '').toUpperCase())).length;
    const needFitScore = rookies.reduce((sum, player) => {
      const need = mapPositionToNeed(player.position);
      const needIndex = teamNeeds.indexOf(need);
      if (needIndex < 0) return sum;
      const priorityWeight = needIndex === 0 ? 7 : needIndex === 1 ? 5 : needIndex === 2 ? 3.5 : needIndex === 3 ? 2 : 1;
      const talentWeight =
        Math.max(0, Number(player.playerBestOvr || 0) - 68) * 0.18 +
        (Number(player.devTrait || 0) >= 1 ? 1.4 : 0) +
        (Number(player.devTrait || 0) >= 2 ? 1.2 : 0) +
        (Number(player.devTrait || 0) >= 3 ? 1.4 : 0);
      return sum + priorityWeight + talentWeight;
    }, 0);
    const topNeedHits = rookies.filter((player) => mapPositionToNeed(player.position) === teamNeeds[0]).length;
    const positions = new Set(rookies.map(p => p.position));
    const variety = Math.min(positions.size * 1.5, 8);
    const countBonus = Math.min(rookies.length * 1.2, 8);
    let score = 56
      + (avgOvr - 68) * 1.35
      + (topOvr - 74) * 0.45
      + (topThreeAvg - 72) * 1.05
      + devAvg * 1.2
      + starCount * 2.8
      + superstarCount * 2.2
      + xFactorCount * 2.5
      + premiumCount * 1.1
      + needFitScore * 1.15
      + topNeedHits * 1.8
      + (variety * 1.1)
      + (countBonus * 0.8);
    score = Math.max(1, Math.min(100, Math.round(score * 10) / 10));
    grades.push({
      teamName,
      emoji: teamEmoji(teamName, emojiMap),
      grade: score,
    });
  });
  grades.sort((a, b) => b.grade - a.grade);
  return grades;
}

export async function maybePostDraftGrades(client, leagueId) {
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    if (!snapshot) return;
    const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
    const isOffseason = (seasonInfo.offSeasonStage || 0) > 0;
    const isPreseason = seasonInfo.seasonWeekType === 0 || (seasonInfo.seasonWeekType === undefined && (seasonInfo.seasonWeek || 0) >= 1 && (seasonInfo.preseasonWeekCount || 0) > 0);
    // Gate: only in offseason (draft/draft recap), never in preseason or regular season
    if (!isOffseason || isPreseason) return;

    const emojiMap = loadJson(TEAM_EMOJIS_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const roleMap = loadJson(path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json'));
    const draftChannelId = channelMap['Draft Grades'] || channelMap['Draft grades'] || '1459445684703989800';
    if (!draftChannelId) return;

    const state = loadJson(STATE_FILE, {});
    const seasonYear = Number(seasonInfo.calendarYear || snapshot?.info?.calendarYear || new Date().getFullYear());
    const seasonKey = `year_${seasonYear}`;
    state[leagueId] = state[leagueId] || {};
    const lastPosted = state[leagueId]?.[seasonKey] || state[leagueId];
    if (lastPosted && lastPosted.fetchedAt === snapshot.fetchedAt) {
      return; // already posted for this snapshot
    }

    const grades = computeGrades(snapshot, emojiMap);
    if (!grades.length) return;

    const lines = grades.map((g, idx) => `${idx + 1}) ${g.emoji || ''} ${g.teamName} — **${g.grade}**`);
    const embed = new EmbedBuilder()
      .setTitle('Madden Draft Grades')
      .setDescription(lines.join('\n'))
      .setColor(0x8e44ad)
      .addFields({ name: 'League', value: String(leagueId), inline: true });

    const channel = await client.channels.fetch(draftChannelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      const coachRoleId = roleMap['Ghost Legacy'];
      const coachTag = coachRoleId ? `<@&${coachRoleId}>` : null;
      await channel.send({ content: coachTag ?? undefined, embeds: [embed] });
      state[leagueId][seasonKey] = { fetchedAt: snapshot.fetchedAt, seasonYear };
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
  } catch (e) {
    console.warn('[draft-grades-auto] skipped:', e?.message || e);
  }
}
