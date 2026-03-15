import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { loadLeagueSnapshot } from './madden_data.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

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

function computeGrades(snapshot, emojiMap) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const rosters = snapshot?.rosters?.teams || {};
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
    const roster = rosters[t.teamId]?.rosterInfoList || [];
    const rookies = roster.filter(p => Number(p.yearsPro ?? 1) === 0);
    if (!rookies.length) return;
    const avgOvr = rookies.reduce((s, p) => s + (p.playerBestOvr || 0), 0) / rookies.length;
    const topOvr = Math.max(...rookies.map(p => p.playerBestOvr || 0));
    const devAvg = rookies.reduce((s, p) => s + devScore(p.devTrait), 0) / rookies.length;
    const positions = new Set(rookies.map(p => p.position));
    const variety = Math.min(positions.size * 1.5, 8);
    const countBonus = Math.min(rookies.length * 1.2, 8);
    let score = 60
      + (avgOvr - 70) * 1.4
      + (topOvr - 75) * 0.6
      + devAvg
      + (variety * 1.25)
      + (countBonus * 1.1);
    score = Math.max(1, Math.min(100, Math.round(score * 10) / 10));
    grades.push({
      teamName: getFullTeamName(t, `Team ${t.teamId}`),
      emoji: teamEmoji(getFullTeamName(t, `Team ${t.teamId}`), emojiMap),
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
    const seasonYear = seasonInfo.seasonYear || snapshot?.info?.careerHubInfo?.seasonTitle || 'unknown';
    const lastPosted = state[leagueId];
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
      state[leagueId] = { fetchedAt: snapshot.fetchedAt, seasonYear };
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
  } catch (e) {
    console.warn('[draft-grades-auto] skipped:', e?.message || e);
  }
}
