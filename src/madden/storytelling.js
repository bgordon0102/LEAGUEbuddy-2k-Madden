import fs from 'fs';
import path from 'path';
import { deriveTeamNeeds, draftOrder, applyPickTrades } from './coach/mockdraft.js';
import { buildLiveDraftContext, loadLatestLeagueSnapshot, getUpcomingDraftYear } from './coach/draft_live_data.js';
import { loadRoleMap } from './staff/staffUtils.js';
import { getFullTeamName, getFullTeamNameFromParts } from '../shared/madden_team_names.js';
import { ensureStrikeSeason, weightedCount, formatBreakdown } from '../shared/madden_strikes.js';
import { buildFranchiseProfileContext, buildFranchiseProfile } from './franchise_profile.js';

const ACTIVE_TRADES_PATH = path.join(process.cwd(), 'data', 'madden', 'active_trades.json');
const PENDING_PROOFS_PATH = path.join(process.cwd(), 'data', 'madden', 'pending_proofs.json');
const THREAD_STATE_PATH = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const FAIRSIMS_PATH = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');
const SCOUT_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'scout_log.json');
const PLAYER_CHANGES_PATH = path.join(process.cwd(), 'data', 'madden', 'player_changes.json');
const TOP_PLAYERS_PATH = path.join(process.cwd(), 'data', 'madden', 'top_players.json');
const WEEKLY_RECAP_HISTORY_PATH = path.join(process.cwd(), 'data', 'madden', 'weekly_recap_history.json');
const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
const WEEKLY_GAME_LOG_PATH = path.join(process.cwd(), 'data', 'madden', 'weekly_game_log.json');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function titleCase(text = '') {
  return String(text).replace(/\b\w/g, (c) => c.toUpperCase());
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function toDisplayTeam(team = '') {
  return String(team || '').replace(/\bcoach\b/ig, '').trim();
}

function buildTeamCoachMentionMap(roleMap = {}) {
  const map = new Map();
  for (const [name, roleId] of Object.entries(roleMap || {})) {
    if (!/ coach$/i.test(name) || !roleId) continue;
    const team = name.replace(/ coach$/i, '').trim();
    map.set(normalizeName(team), `<@&${roleId}>`);
    const mascot = normalizeName(team.split(/\s+/).pop());
    if (mascot) map.set(mascot, `<@&${roleId}>`);
  }
  return map;
}

function addLeagueTeamCoachAliases(map, league) {
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    const fullName = getFullTeamName(team, '').trim();
    const mascot = String(team?.displayName || team?.nickName || '').trim();
    const abbr = String(team?.abbrName || '').trim();
    const mention =
      map.get(normalizeName(fullName)) ||
      map.get(normalizeName(mascot)) ||
      map.get(normalizeName(abbr));
    if (!mention) continue;
    if (fullName) map.set(normalizeName(fullName), mention);
    if (mascot) map.set(normalizeName(mascot), mention);
    if (abbr) map.set(normalizeName(abbr), mention);
  }
  return map;
}

function coachMentionFor(teamName, mentionMap) {
  const team = toDisplayTeam(teamName);
  const norm = normalizeName(team);
  return mentionMap.get(norm) || mentionMap.get(normalizeName(team.split(/\s+/).pop())) || '';
}

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagParagraphFirstMentions(paragraph, mentionMap, candidateTeams = []) {
  let text = String(paragraph || '');
  if (!text) return text;
  const teams = [...new Set(Array.from(candidateTeams || []).filter(Boolean).map((team) => toDisplayTeam(team)))]
    .sort((a, b) => b.length - a.length);

  for (const team of teams) {
    const mention = coachMentionFor(team, mentionMap);
    if (!mention) continue;
    if (text.includes(`${mention} and ${team}`)) continue;
    const pattern = new RegExp(`(^|[^\\w>])(${escapeRegex(team)})(?=([^\\w<]|$))`);
    text = text.replace(pattern, (match, prefix, matched) => `${prefix}${mention} and ${matched}`);
  }
  return text;
}

function formatRecord(standing) {
  if (!standing) return '0-0';
  const wins = Number(standing.totalWins || 0);
  const losses = Number(standing.totalLosses || 0);
  const ties = Number(standing.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function formatNeedLabel(need) {
  const labels = {
    QB: 'Quarterback',
    OT: 'Offensive Tackle',
    IOL: 'Interior OL',
    WR: 'Wide Receiver',
    TE: 'Tight End',
    RB: 'Running Back',
    EDGE: 'Edge Rusher',
    DT: 'Defensive Tackle',
    LB: 'Linebacker',
    CB: 'Cornerback',
    S: 'Safety',
    BPA: 'Best Player Available',
  };
  return labels[need] || need || 'Need';
}

function formatStatLine(player) {
  const totals = player?.totals || {};
  const pos = String(player?.position || '').toUpperCase();
  if (pos === 'QB') {
    return `${Number(totals.passYds || 0)} pass yds, ${Number(totals.passTDs || 0)} pass TD, ${Number(totals.passInts || 0)} INT${Number(totals.rushYds || 0) ? `, ${Number(totals.rushYds || 0)} rush yds` : ''}`;
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return `${Number(totals.rushYds || 0)} rush yds, ${Number(totals.rushTDs || 0)} rush TD${Number(totals.recYds || 0) ? `, ${Number(totals.recYds || 0)} rec yds` : ''}`;
  }
  if (['WR', 'TE'].includes(pos)) {
    return `${Number(totals.recYds || 0)} rec yds, ${Number(totals.recTDs || 0)} rec TD, ${Number(totals.recCatches || 0)} catches`;
  }
  if (['CB', 'FS', 'SS', 'MLB', 'LB', 'WILL', 'MIKE', 'SAM', 'REDGE', 'LEDGE', 'DE', 'DT', 'LE', 'RE', 'EDGE'].includes(pos)) {
    const sacks = Number(totals.defSacks || 0);
    const ints = Number(totals.defInts || 0);
    const tackles = Number(totals.defTotalTackles || 0);
    const pd = Number(totals.defPassDeflections || 0);
    return `${tackles} tackles${sacks ? `, ${sacks} sacks` : ''}${ints ? `, ${ints} INT` : ''}${pd ? `, ${pd} PD` : ''}`;
  }
  return player?.statLine || 'impact game';
}

function formatGrade(value) {
  return Number(value || 0).toFixed(1);
}

function isBadStatLine(player) {
  const pos = String(player?.position || '').toUpperCase();
  const totals = player?.totals || {};
  if (pos === 'QB') {
    return Number(totals.passInts || 0) >= 2 || ((Number(totals.passYds || 0) <= 180) && Number(totals.passTDs || 0) === 0 && Number(totals.passInts || 0) >= 1);
  }
  if (['HB', 'RB', 'FB'].includes(pos)) {
    return Number(totals.rushFumblesLost || 0) >= 1 || (Number(totals.rushAtt || 0) >= 12 && Number(totals.rushYds || 0) <= 35);
  }
  if (['WR', 'TE'].includes(pos)) {
    return Number(totals.recDrops || 0) >= 2 || (Number(totals.recCatches || 0) >= 5 && Number(totals.recYds || 0) <= 35);
  }
  return false;
}

function describePerformanceRumor(player, mode = 'heat') {
  const totals = player?.totals || {};
  const pos = String(player?.position || '').toUpperCase();
  const grade = formatGrade(player?.grade);
  const team = player?.team || 'That team';
  const name = player?.name || 'That player';
  const line = formatStatLine(player);

  if (pos === 'QB') {
    const passYds = Number(totals.passYds || 0);
    const passTDs = Number(totals.passTDs || 0);
    const passInts = Number(totals.passInts || 0);
    const rushYds = Number(totals.rushYds || 0);
    const rushTDs = Number(totals.rushTDs || 0);
    const totalTds = passTDs + rushTDs;
    const totalYards = passYds + rushYds;
    const monsterGame = totalTds >= 6 || (passTDs >= 5 && totalYards >= 380) || (totalTds >= 5 && totalYards >= 420);
    const eliteDualThreat = rushYds >= 60 || rushTDs >= 1;
    if (mode === 'heat') {
      if (monsterGame) {
        if (passInts >= 3) {
          return `${team} are still buzzing about the kind of high-wire day ${name} just put on tape. ${line} was explosive enough to tilt a game by itself, even if the interceptions kept it from looking completely clean.`;
        }
        return `${team} are getting a different level of quarterback buzz behind ${name}. ${line} was the kind of takeover line that changes the whole week around a team.`;
      }
      if (passInts >= 2 && (passTDs >= 3 || passYds >= 300 || eliteDualThreat)) {
        return `${team} are still talking through an up-and-down day from ${name}. ${line} showed how much stress he can put on a defense, but the interceptions kept the full review mixed.`;
      }
      if (eliteDualThreat) {
        return `${team} keep getting stronger buzz behind ${name}. A ${grade} grade and a line like ${line} showed both the arm talent and the rushing pressure he can add to an offense.`;
      }
      return `${team} keep getting stronger buzz behind ${name}. A ${grade} grade and a line like ${line} changes the ceiling fast.`;
    }
    if (monsterGame) {
      if (passInts >= 3) {
        return `${team} are still sorting through the volatility around ${name} after ${line}. The mistakes were real, but so was the kind of production that can blow a game open.`;
      }
      return `${team} are carrying real quarterback heat behind ${name} after ${line}. That is the kind of line the rest of the league takes seriously.`;
    }
    if (passInts >= 2 && (passTDs >= 3 || passYds >= 300 || eliteDualThreat)) {
      return `${team} are catching mixed reviews around ${name} after ${line}. The creation was obvious, but so was the volatility.`;
    }
    return `${team} are catching some bad noise around ${name} after ${line}. That is the kind of quarterback week that usually follows a team for a few days.`;
  }

  if (['HB', 'RB', 'FB'].includes(pos)) {
    const rushYds = Number(totals.rushYds || 0);
    const rushTDs = Number(totals.rushTDs || 0);
    const fumbles = Number(totals.rushFumblesLost || 0);
    if (mode === 'heat') {
      if (fumbles >= 1 && (rushYds >= 100 || rushTDs >= 2)) {
        return `${team} got an explosive but uneven day from ${name}. ${line} was big enough to matter, but the ball-security issues kept it from reading cleanly.`;
      }
      return `${team} are getting real juice from ${name}. A ${grade} grade and ${line} is the kind of backfield production that gets noticed fast.`;
    }
    return `${team} are hearing some frustration around ${name} after ${line}. The yardage only goes so far if the mistakes stay in the frame.`;
  }

  if (['WR', 'TE'].includes(pos)) {
    const recYds = Number(totals.recYds || 0);
    const recTDs = Number(totals.recTDs || 0);
    const drops = Number(totals.recDrops || 0);
    if (mode === 'heat') {
      if (drops >= 2 && (recYds >= 100 || recTDs >= 1)) {
        return `${team} got a loud but uneven receiver day from ${name}. ${line} moved the offense, but the drops kept the reviews mixed.`;
      }
      return `${team} have a real offensive spark with ${name}. A ${grade} grade and ${line} is the kind of passing-game heat that changes coverage math.`;
    }
    return `${team} are hearing mixed reaction to ${name} after ${line}. The production showed up, but so did the inconsistency.`;
  }

  if (['CB', 'FS', 'SS', 'MLB', 'LB', 'WILL', 'MIKE', 'SAM', 'REDGE', 'LEDGE', 'DE', 'DT', 'LE', 'RE', 'EDGE'].includes(pos)) {
    const sacks = Number(totals.defSacks || 0);
    const ints = Number(totals.defInts || 0);
    const tackles = Number(totals.defTotalTackles || 0);
    const pd = Number(totals.defPassDeflections || 0);
    if (mode === 'heat') {
      return `${team} are getting real defensive noise from ${name}. A ${grade} grade backed up ${line}, and that is the kind of line evaluators buy into.`;
    }
    if (sacks || ints || pd || tackles >= 8) {
      return `${team} are still sorting out what to make of ${name}'s line: ${line}. The activity was real, even if the full review was more complicated than the raw numbers suggest.`;
    }
    return `${team} are not thrilled with how ${name}'s week landed. ${line} was not enough to quiet the questions.`;
  }

  return mode === 'heat'
    ? `${team} are getting stronger buzz around ${name} after a ${grade} grade week.`
    : `${team} are hearing more criticism around ${name} after a rougher week.`;
}

function teamNamesFromGameEntry(entry) {
  return [entry?.away, entry?.home].filter(Boolean);
}

function pickDistinctItems(items, getTeams, blockedTeams = new Set(), limit = 1) {
  const selected = [];
  const used = new Set([...blockedTeams].map((team) => normalizeName(team)));
  for (const item of items || []) {
    const teams = (getTeams(item) || []).filter(Boolean);
    const hasConflict = teams.some((team) => used.has(normalizeName(team)));
    if (hasConflict && selected.length < limit) continue;
    selected.push(item);
    teams.forEach((team) => used.add(normalizeName(team)));
    if (selected.length >= limit) break;
  }
  if (selected.length >= limit) return selected;
  for (const item of items || []) {
    if (selected.includes(item)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function pickDistinctCategoryItems(items = [], getTeams, blockedTeams = new Set(), limit = 1) {
  const selected = [];
  const usedTeams = new Set([...blockedTeams].map((team) => normalizeName(team)));
  const usedCategories = new Set();

  for (const item of items) {
    const teams = (getTeams(item) || []).filter(Boolean);
    const hasTeamConflict = teams.some((team) => usedTeams.has(normalizeName(team)));
    const category = item?.category || '';
    if (hasTeamConflict || usedCategories.has(category)) continue;
    selected.push(item);
    teams.forEach((team) => usedTeams.add(normalizeName(team)));
    if (category) usedCategories.add(category);
    if (selected.length >= limit) return selected;
  }

  return pickDistinctItems(items, getTeams, blockedTeams, limit);
}

function pickTemplate(templates = [], seed = 0) {
  if (!templates.length) return '';
  return templates[Math.abs(Number(seed) || 0) % templates.length];
}

function seededText(seedKey, templates = [], replacements = {}) {
  const seed = [...String(seedKey || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  let template = pickTemplate(templates, seed);
  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return template;
}

function seededOrder(seedKey, values = []) {
  const out = values.slice();
  let seed = [...String(seedKey || '')].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function describeNeedPressureRumor(team, coachTag, need, variantSeed = 0) {
  const side = coachTag ? `${coachTag} may have to` : `${team} may have to`;
  const key = String(need || '').toUpperCase();
  switch (key) {
    case 'QB':
      return pickTemplate([
        `${team} are being tied to a bigger-picture reset. The read around the league is that ${side} settle the quarterback future before anything else really comes into focus.`,
        `${team} keep circling back to the same question. Around the league, the feeling is that ${side} get the quarterback picture settled before the rest of the roster can make sense.`,
        `The quarterback angle still hangs over ${team}. The outside read is that ${side} answer that first before the rest of the build really clears up.`,
      ], variantSeed + team.length);
    case 'OT':
    case 'LT':
    case 'RT':
      return pickTemplate([
        `${team} are drawing real offensive-line scrutiny. The sense around the league is that ${side} stabilize tackle before the offense can feel settled.`,
        `${team} still have people around the league staring at the edges of the line. The read is that ${side} settle tackle before the offense can really breathe.`,
        `The tackle conversation is not leaving ${team} alone. Around the league, the expectation is that ${side} get steadier there before the offense feels fully built.`,
      ], variantSeed + team.length);
    case 'WR':
      return pickTemplate([
        `${team} are getting tied to help on the perimeter. Around the league, the feeling is that ${side} add another receiver who can actually change coverages.`,
        `${team} keep getting linked to another real target outside. The league read is that ${side} find a receiver who changes the way defenses line up.`,
        `There is still receiver smoke around ${team}. The outside view is that ${side} need one more pass-game piece who can tilt coverage.`,
      ], variantSeed + team.length);
    case 'RB':
    case 'HB':
      return pickTemplate([
        `${team} are drawing quiet backfield questions. The read around the league is that ${side} find more explosive runner help before the offense feels complete.`,
        `${team} still have a little backfield doubt hanging around them. The sense is that ${side} add more juice at running back before the offense feels whole.`,
        `The runner room around ${team} is still getting a second look. Around the league, people think ${side} need more explosiveness there.`,
      ], variantSeed + team.length);
    case 'TE':
      return pickTemplate([
        `${team} are being linked to another option in the middle of the field. The sense around the league is that ${side} find a tighter answer at tight end.`,
        `${team} keep drawing tight-end chatter. The outside read is that ${side} could use a more reliable middle-of-the-field answer.`,
        `There is still some quiet tight-end smoke around ${team}. Around the league, the feeling is that ${side} sharpen that spot.`,
      ], variantSeed + team.length);
    case 'CB':
      return pickTemplate([
        `${team} are hearing more noise about the secondary. The feeling around the league is that ${side} find another corner who can hold up on an island.`,
        `${team} keep pulling cornerback talk. The read around the league is that ${side} need another cover man they can trust outside.`,
        `The secondary still feels unresolved around ${team}. From the outside, it looks like ${side} need one more corner with real one-on-one value.`,
      ], variantSeed + team.length);
    case 'S':
    case 'FS':
    case 'SS':
      return pickTemplate([
        `${team} are getting tied to help on the back end. Around the league, there is a sense that ${side} get safer at safety before the defense settles.`,
        `${team} still have some back-end questions hanging there. The read is that ${side} stabilize safety before the defense feels clean.`,
        `There is still safety chatter around ${team}. Around the league, the feeling is that ${side} need a steadier answer on the back end.`,
      ], variantSeed + team.length);
    case 'EDGE':
    case 'REDGE':
    case 'LEDGE':
    case 'DE':
    case 'LE':
    case 'RE':
      return pickTemplate([
        `${team} are being tied to pass-rush help. The feeling around the league is that ${side} find more edge pressure before the defense can really climb.`,
        `${team} keep getting linked to more heat off the edge. The outside read is that ${side} need another rusher before the front can really take off.`,
        `Pass-rush help still follows ${team} in league talk. Around the league, people think ${side} need more edge juice.`,
      ], variantSeed + team.length);
    case 'DT':
      return pickTemplate([
        `${team} are being linked to interior help up front. Around the league, people think ${side} get sturdier inside before the front feels complete.`,
        `${team} keep pulling interior-line questions. The read is that ${side} need more weight and control inside.`,
        `The inside of the front still looks unfinished around ${team}. Around the league, the feeling is that ${side} need a sturdier answer there.`,
      ], variantSeed + team.length);
    case 'LB':
    case 'MLB':
    case 'WILL':
    case 'MIKE':
    case 'SAM':
      return pickTemplate([
        `${team} are getting tied to second-level help. The league read is that ${side} clean up linebacker before the defense really settles down.`,
        `${team} still have some linebacker noise around them. The outside view is that ${side} settle the second level before the defense fully calms down.`,
        `The linebacker picture around ${team} still feels a little loose. Around the league, people think ${side} need to tighten that up.`,
      ], variantSeed + team.length);
    case 'IOL':
    case 'G':
    case 'LG':
    case 'RG':
    case 'C':
      return pickTemplate([
        `${team} are drawing pressure around the middle of the line. The sense around the league is that ${side} get stronger inside before the offense feels stable.`,
        `${team} keep getting linked to help on the interior. The read is that ${side} need more stability inside before the offense really settles.`,
        `The middle of the line still looks like live work around ${team}. Around the league, the expectation is that ${side} get firmer there.`,
      ], variantSeed + team.length);
    default:
      return pickTemplate([
        `${team} are being tied to a bigger-picture reset. The read around the league is that ${side} solve ${titleCase(need || 'the roster')} before anything else settles down.`,
        `${team} keep getting linked to a larger roster fix. Around the league, the feeling is that ${side} answer ${titleCase(need || 'the roster')} before the rest clears up.`,
        `There is still one obvious roster question hanging over ${team}. The outside read is that ${side} settle ${titleCase(need || 'that')} first.`,
      ], variantSeed + team.length);
  }
}

function latestPlayerChangeBatch(ctx) {
  const history = Array.isArray(ctx?.playerChanges?.history) ? ctx.playerChanges.history : [];
  return history[history.length - 1] || null;
}

function attributeChangeWeight(change) {
  if (!change) return 0;
  if (change.label === 'Dev Trait') return 14;
  if (change.label === 'Position') return 12;
  const from = Number(change.from);
  const to = Number(change.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const delta = to - from;
  if (change.label === 'OVR') return Math.abs(delta) * 5;
  return Math.abs(delta) * 3;
}

function playerChangeImportance(entry, ctx) {
  if (!entry) return 0;
  const overall = Number(entry.overall || 0);
  const dev = Number(entry.devTrait || 0);
  const pos = String(entry.position || '').toUpperCase();
  const top100Match = (ctx?.top100 || []).find((player) =>
    normalizeName(player?.team || '') === normalizeName(entry.teamName || '')
    && normalizeName(player?.name || '') === normalizeName(entry.playerName || '')
  );

  let score = 0;
  if (overall >= 90) score += 24;
  else if (overall >= 85) score += 18;
  else if (overall >= 80) score += 12;
  else if (overall >= 76) score += 7;
  else if (overall >= 73) score += 3;

  score += dev >= 3 ? 12 : dev === 2 ? 9 : dev === 1 ? 5 : 0;
  if (['QB', 'LT', 'RT', 'CB', 'WR', 'REDGE', 'LEDGE', 'EDGE', 'RE', 'LE', 'DT'].includes(pos)) score += 6;
  else if (['HB', 'TE', 'FS', 'SS', 'MLB', 'MIKE', 'WILL'].includes(pos)) score += 3;

  if (top100Match) score += 16;
  return score;
}

function shouldSurfacePlayerChange(entry, ctx) {
  const impact = playerChangeImportance(entry, ctx);
  const topChange = Math.max(...(entry?.changes || []).map(attributeChangeWeight), 0);
  if (topChange >= 14 && impact >= 8) return true;
  if (topChange >= 10 && impact >= 14) return true;
  if (topChange >= 6 && impact >= 22) return true;
  return false;
}

function attributeStoryText(position, label, delta, toValue) {
  const pos = String(position || '').toUpperCase();
  const up = delta > 0;
  if (label === 'Dev Trait') {
    if (up) {
      if (pos === 'QB') return 'around the league, the ceiling talk just got louder.';
      if (['WR', 'TE'].includes(pos)) return 'the buzz now sounds more like a real breakout candidate.';
      if (['HB', 'RB', 'FB'].includes(pos)) return 'people around the league are starting to talk about him like a bigger piece.';
      if (['CB', 'FS', 'SS'].includes(pos)) return 'evaluators are talking about him like a more serious cover piece now.';
      if (['LE', 'RE', 'DE', 'EDGE', 'DT', 'LOLB', 'ROLB', 'MLB'].includes(pos)) return 'the league is starting to read him like a more dangerous front-seven piece.';
      if (['LT', 'RT', 'LG', 'RG', 'C'].includes(pos)) return 'the developmental buzz around him is getting much stronger.';
      return 'around the league, the upside talk just got louder.';
    }
    return 'the long-term buzz around him cooled off a bit.';
  }
  if (label === 'OVR') {
    return up ? `the overall climb is starting to get noticed.` : `the overall dip is getting noticed.`;
  }
  if (label === 'MCV') return up ? 'he has clearly been working on man coverage.' : 'his man coverage is under more scrutiny now.';
  if (label === 'ZCV') return up ? 'the zone instincts look like they are coming along.' : 'the zone awareness has taken a hit.';
  if (label === 'PRS') return up ? 'the press work is getting better.' : 'the press consistency is slipping.';
  if (label === 'FMV') return up ? 'the finesse rush is getting sharper.' : 'the finesse rush has backed up a bit.';
  if (label === 'PMV') return up ? 'the power rush is coming on.' : 'the power rush has cooled.';
  if (label === 'PBK' || label === 'PBP' || label === 'PBF') return up ? 'the pass protection has tightened up.' : 'the pass protection is still a concern.';
  if (label === 'RBK' || label === 'RBP' || label === 'RBF') return up ? 'the run blocking is trending the right way.' : 'the run blocking still needs work.';
  if (label === 'THP') return up ? 'the throw power jump is getting noticed.' : 'the arm talent is being questioned more.';
  if (label === 'TUP') return up ? 'he looks more comfortable under pressure.' : 'pressure is still affecting him.';
  if (label === 'SRR' || label === 'MRR' || label === 'DRR') return up ? 'the route detail is sharpening up.' : 'the route-running polish still is not there.';
  if (label === 'CTH' || label === 'SPC' || label === 'CIT') return up ? 'the hands have gotten more reliable.' : 'the hands are still drawing questions.';
  if (label === 'BTK' || label === 'TRK' || label === 'JKM' || label === 'SPM') return up ? 'there is more tackle-breaking juice there now.' : 'the after-contact juice backed off.';
  if (label === 'TAK' || label === 'PUR' || label === 'PRC') return up ? 'the defensive finish is trending up.' : 'the defensive consistency still looks shaky.';
  if (label === 'ACC' || label === 'AGI' || label === 'COD') return up ? 'the movement profile looks livelier.' : 'the movement profile has flattened a bit.';
  if (label === 'STR') return up ? 'the added strength shows up on tape.' : 'the strength profile dipped.';
  if (label === 'AWR') return up ? 'the awareness jump is giving him a cleaner floor.' : 'the awareness is still behind where it needs to be.';
  return up ? `${label} is trending up.` : `${label} slipped a bit.`;
}

function describePlayerChangeRumor(entry, coachTag) {
  if (!entry) return null;
  const teamLead = coachTag ? `${coachTag} and ${entry.teamName}` : entry.teamName;
  const changes = [...(entry.changes || [])].sort((a, b) => attributeChangeWeight(b) - attributeChangeWeight(a));
  const top = changes[0];
  if (!top) return null;
  if (top.label === 'Position') {
    const from = String(top.from || '').toUpperCase();
    const to = String(top.to || '').toUpperCase();
    const moveKey = `${from}->${to}`;
    const moveText = {
      'CB->FS': 'working him deeper in the secondary, where the range and eyes fit better',
      'CB->SS': 'using him closer to the box and asking for more physical snaps',
      'FS->CB': 'testing whether the movement skills can hold up outside',
      'SS->LB': 'leaning into a bigger box role and more downhill work',
      'LB->EDGE': 'trying to turn that frame into more direct pass-rush juice',
      'EDGE->DT': 'sliding him inside more often to chase interior pressure',
      'DT->EDGE': 'seeing if he can give them more speed on the edge',
      'WR->HB': 'looking for a more creative touch player role',
      'HB->WR': 'seeing more value in his receiving profile than a pure backfield role',
      'WR->TE': 'trying to create a bigger middle-of-the-field matchup piece',
      'TE->WR': 'testing whether he can stress space more as a detached target',
      'LT->LG': 'looking for a steadier fit inside',
      'RT->RG': 'trying to settle the right side by kicking him inside',
      'LG->C': 'testing whether the communication and anchor fit the middle better',
      'RG->C': 'trying him in a more central role up front',
      'QB->HB': 'using the athleticism in a more flexible offensive role',
      'HB->QB': 'experimenting with the athlete package behind center',
      'DE->LB': 'trying to find a more flexible front-seven role',
      'LB->DE': 'asking him to play more directly into the rush',
    }[moveKey];
    if (moveText) {
      return `${teamLead} have ${entry.playerName} working at ${to} now, ${moveText}.`;
    }
    if (['CB', 'FS', 'SS'].includes(to)) {
      return `${teamLead} have ${entry.playerName} working in the secondary at ${to} now. Around the league, that usually reads like a coverage reshuffle.`;
    }
    if (['LT', 'RT', 'LG', 'RG', 'C'].includes(to)) {
      return `${teamLead} have ${entry.playerName} working at ${to} now. That kind of line shuffle usually means they are still searching for the right fit up front.`;
    }
    if (['WR', 'TE', 'HB', 'RB', 'FB'].includes(to)) {
      return `${teamLead} have ${entry.playerName} working at ${to} now. It looks like they are trying to find a cleaner offensive role for him.`;
    }
    if (['LE', 'RE', 'DE', 'EDGE', 'DT', 'LOLB', 'ROLB', 'MLB'].includes(to)) {
      return `${teamLead} have ${entry.playerName} working at ${to} now. Around the league, that reads like a front-seven role adjustment.`;
    }
    return `${teamLead} have ${entry.playerName} working at ${to} now. Around the league, that kind of position move usually gets noticed quickly.`;
  }
  if (top.label === 'Dev Trait') {
    const pos = String(entry.position || '').toUpperCase();
    if (pos === 'QB') {
      return `${teamLead} are hearing a different level of buzz around ${entry.playerName}. ${attributeStoryText(entry.position, top.label, 1, top.to)}`;
    }
    if (['WR', 'TE', 'HB', 'RB', 'FB'].includes(pos)) {
      return `${teamLead} have more league buzz building around ${entry.playerName}. ${attributeStoryText(entry.position, top.label, 1, top.to)}`;
    }
    if (['CB', 'FS', 'SS', 'LE', 'RE', 'DE', 'EDGE', 'DT', 'LOLB', 'ROLB', 'MLB'].includes(pos)) {
      return `${teamLead} are hearing stronger evaluator buzz around ${entry.playerName}. ${attributeStoryText(entry.position, top.label, 1, top.to)}`;
    }
    return `${teamLead} have a little more league buzz around ${entry.playerName} right now. ${attributeStoryText(entry.position, top.label, 1, top.to)}`;
  }
  const from = Number(top.from);
  const to = Number(top.to);
  const delta = Number.isFinite(from) && Number.isFinite(to) ? to - from : 0;
  if (!delta) return null;
  const direction = delta > 0 ? '+' : '';
  return `${teamLead} have ${entry.playerName} at ${top.label} ${direction}${delta} (${top.from}->${top.to}); ${attributeStoryText(entry.position, top.label, delta, top.to)}`;
}

function leagueKeyFromContext(ctx) {
  return String(ctx?.league?.info?.leagueId || ctx?.league?.leagueId || 'default');
}

function getRecentFeaturedTeams(ctx, currentWeek) {
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  return new Set(
    leagueHistory
      .filter((entry) => Number(entry?.week) !== Number(currentWeek))
      .slice(-2)
      .flatMap((entry) => entry?.teams || [])
      .map((team) => normalizeName(team)),
  );
}

function getRecentRecapStoryKeys(ctx, currentWeek) {
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  return new Set(
    leagueHistory
      .filter((entry) => Number(entry?.week) !== Number(currentWeek))
      .slice(-3)
      .flatMap((entry) => entry?.storyKeys || [])
      .map((key) => String(key || '')),
  );
}

function saveFeaturedTeamsForWeek(ctx, currentWeek, teams) {
  if (currentWeek == null) return;
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  const filtered = leagueHistory.filter((entry) => Number(entry?.week) !== Number(currentWeek));
  filtered.push({
    week: Number(currentWeek),
    teams: [...new Set((teams || []).filter(Boolean))],
    storyKeys: [],
    updatedAt: Date.now(),
  });
  history[leagueKey] = filtered.slice(-6);
  saveJSON(WEEKLY_RECAP_HISTORY_PATH, history);
}

function saveRecapStoryKeysForWeek(ctx, currentWeek, storyKeys = []) {
  if (currentWeek == null) return;
  const history = safeReadJSON(WEEKLY_RECAP_HISTORY_PATH, {});
  const leagueKey = leagueKeyFromContext(ctx);
  const leagueHistory = Array.isArray(history?.[leagueKey]) ? history[leagueKey] : [];
  const existing = leagueHistory.find((entry) => Number(entry?.week) === Number(currentWeek));
  if (existing) {
    existing.storyKeys = [...new Set((storyKeys || []).filter(Boolean).map((key) => String(key)))];
    existing.updatedAt = Date.now();
  } else {
    leagueHistory.push({
      week: Number(currentWeek),
      teams: [],
      storyKeys: [...new Set((storyKeys || []).filter(Boolean).map((key) => String(key)))],
      updatedAt: Date.now(),
    });
  }
  history[leagueKey] = leagueHistory.slice(-6);
  saveJSON(WEEKLY_RECAP_HISTORY_PATH, history);
}

function getYoungHeadlinePlayer(ctx, teamName) {
  return (ctx.top100 || []).find((player) => {
    if (normalizeName(player?.team || '') !== normalizeName(teamName)) return false;
    const yearsPro = Number(player?.yearsPro ?? 99);
    const age = Number(player?.age ?? 99);
    return yearsPro <= 1 || age <= 24;
  }) || null;
}

function scoreRecapGame(ctx, game, recentTeamSet) {
  const away = ctx.teams.get(Number(game.awayTeamId));
  const home = ctx.teams.get(Number(game.homeTeamId));
  const awayScore = Number(game.awayScore || 0);
  const homeScore = Number(game.homeScore || 0);
  const winner = awayScore > homeScore ? away : home;
  const margin = Math.abs(awayScore - homeScore);
  const closeGameBonus = margin <= 3 ? 22 : margin <= 7 ? 14 : 0;
  const blowoutBonus = Math.min(18, margin * 1.2);
  const totalPointsBonus = Math.min(14, (awayScore + homeScore) * 0.22);
  const winnerStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
  const wins = Number(winnerStanding?.totalWins || 0);
  const losses = Number(winnerStanding?.totalLosses || 0);
  const recordWeight = (wins + losses) >= 4 ? 10 : 4;
  const awayYoung = getYoungHeadlinePlayer(ctx, away);
  const homeYoung = getYoungHeadlinePlayer(ctx, home);
  const youngBonus = (awayYoung ? 9 : 0) + (homeYoung ? 9 : 0);
  const recentPenalty =
    (recentTeamSet.has(normalizeName(away)) ? 18 : 0) +
    (recentTeamSet.has(normalizeName(home)) ? 18 : 0);
  return {
    game,
    away,
    home,
    awayYoung,
    homeYoung,
    score: blowoutBonus + closeGameBonus + totalPointsBonus + recordWeight + youngBonus - recentPenalty,
    margin,
  };
}

function describeGameTexture(entry) {
  const awayScore = Number(entry?.game?.awayScore || 0);
  const homeScore = Number(entry?.game?.homeScore || 0);
  const total = awayScore + homeScore;
  const margin = Math.abs(awayScore - homeScore);
  if (total >= 65 && margin <= 7) return 'It played more like a track meet than a grind.';
  if (total >= 65) return 'Points came quickly enough that it never really settled down.';
  if (total <= 27 && margin <= 7) return 'That one stayed tight because neither side gave much away.';
  if (total <= 27) return 'It was a lower-scoring kind of game, with every clean drive carrying extra weight.';
  if (margin >= 17) return 'By the second half, it had more control than drama.';
  if (margin <= 3) return 'That game sat on one or two swings all the way through.';
  return 'It had enough momentum swings to keep the result live deep into the game.';
}

function selectRecapGames(ctx, recentGames, currentWeek) {
  const recentTeamSet = getRecentFeaturedTeams(ctx, currentWeek);
  const scored = recentGames.map((game) => scoreRecapGame(ctx, game, recentTeamSet)).sort((a, b) => b.score - a.score);
  const targetCount = Math.min(4, Math.max(3, recentGames.length));
  const selected = [];
  const usedThisWeek = new Set();

  for (const candidate of scored) {
    const awayKey = normalizeName(candidate.away);
    const homeKey = normalizeName(candidate.home);
    const conflictsCurrent = usedThisWeek.has(awayKey) || usedThisWeek.has(homeKey);
    const conflictsRecent = recentTeamSet.has(awayKey) || recentTeamSet.has(homeKey);
    if (conflictsCurrent) continue;
    if (selected.length < targetCount - 1 && conflictsRecent) continue;
    selected.push(candidate);
    usedThisWeek.add(awayKey);
    usedThisWeek.add(homeKey);
    if (selected.length >= targetCount) break;
  }

  for (const candidate of scored) {
    if (selected.length >= targetCount) break;
    if (selected.some((entry) => entry.game === candidate.game)) continue;
    selected.push(candidate);
  }

  saveFeaturedTeamsForWeek(ctx, currentWeek, selected.flatMap((entry) => [entry.away, entry.home]));
  return selected;
}

function recordScore(standing) {
  if (!standing) return 0;
  return Number(standing.totalWins || 0) - Number(standing.totalLosses || 0);
}

function classIdForLeague(league) {
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const seasonOrdinal = Number(seasonInfo?.seasonYear ?? league?.info?.seasonYear ?? league?.seasonYear);
  if (Number.isFinite(seasonOrdinal) && seasonOrdinal >= 0 && seasonOrdinal < 50) {
    return `cus_${String(seasonOrdinal + 1).padStart(2, '0')}`;
  }
  const calendarYear = Number(seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 2025);
  const idx = Math.max(1, calendarYear - 2024);
  return `cus_${String(idx).padStart(2, '0')}`;
}

function findDraftClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const files = fs.readdirSync(DRAFT_DIR).filter((file) => {
    const lower = file.toLowerCase();
    return lower.endsWith('.json') && lower.includes(classId.toLowerCase()) && lower.includes('big board');
  });
  if (!files.length) return null;
  return path.join(DRAFT_DIR, files.sort()[0]);
}

function loadDraftClassForLeague(league) {
  const classId = classIdForLeague(league);
  const file = findDraftClassFile(classId);
  return {
    classId,
    players: file ? Object.values(safeReadJSON(file, {})).filter((p) => p?.name) : [],
  };
}

function teamNameMap(league) {
  const map = new Map();
  for (const team of league?.teams?.leagueTeamInfoList || []) {
    const display = getFullTeamName(team, String(team.teamId));
    map.set(Number(team.teamId), display);
  }
  return map;
}

function standingsMap(league) {
  const map = new Map();
  for (const standing of league?.standings?.teamStandingInfoList || []) {
    map.set(Number(standing.teamId), standing);
  }
  return map;
}

function previousSnapshotFor(latestFile) {
  if (!latestFile) return null;
  const prevFile = path.join(path.dirname(latestFile), 'previous', path.basename(latestFile));
  if (!fs.existsSync(prevFile)) return null;
  return safeReadJSON(prevFile, null);
}

function listCompletedGames(league, weekIndex = null) {
  const scheduledGames = (league?.schedule?.schedules || []).filter((game) => {
    const stage = Number(game?.stageIndex ?? game?.stage ?? -1);
    const status = Number(game?.status ?? 0);
    const gameWeek = Number(game?.weekIndex ?? -1);
    const weekMatch = weekIndex == null ? true : gameWeek === weekIndex;
    return [1, 2].includes(stage) && weekMatch && status >= 2;
  });
  if (scheduledGames.length) return scheduledGames;

  const leagueId = String(league?.info?.leagueId || league?.leagueId || '');
  const gameLog = safeReadJSON(WEEKLY_GAME_LOG_PATH, {});
  const fallbackGames = (gameLog?.[leagueId]?.games || []).filter((game) => {
    const stage = Number(game?.stageIndex ?? game?.stage ?? -1);
    const played = game?.played === true || Number(game?.awayScore ?? 0) > 0 || Number(game?.homeScore ?? 0) > 0;
    const gameWeek = Number(game?.weekIndex ?? -1);
    const weekMatch = weekIndex == null ? true : gameWeek === weekIndex;
    return [1, 2].includes(stage) && weekMatch && played;
  }).map((game) => ({
    ...game,
    status: 2,
  }));
  return fallbackGames;
}

function latestCompletedWeek(league) {
  const weeks = listCompletedGames(league).map((game) => Number(game.weekIndex));
  if (!weeks.length) return null;
  return Math.max(...weeks);
}

function buildRecentForm(league) {
  const completedWeek = latestCompletedWeek(league);
  if (completedWeek == null) return new Map();
  const relevantWeeks = [completedWeek, completedWeek - 1].filter((week) => week >= 0);
  const form = new Map();
  for (const week of relevantWeeks) {
    for (const game of listCompletedGames(league, week)) {
      const awayTeamId = Number(game.awayTeamId);
      const homeTeamId = Number(game.homeTeamId);
      const awayScore = Number(game.awayScore || 0);
      const homeScore = Number(game.homeScore || 0);
      const ensure = (teamId) => {
        if (!form.has(teamId)) form.set(teamId, { wins: 0, losses: 0, pf: 0, pa: 0 });
        return form.get(teamId);
      };
      const away = ensure(awayTeamId);
      const home = ensure(homeTeamId);
      away.pf += awayScore;
      away.pa += homeScore;
      home.pf += homeScore;
      home.pa += awayScore;
      if (awayScore > homeScore) {
        away.wins += 1;
        home.losses += 1;
      } else if (homeScore > awayScore) {
        home.wins += 1;
        away.losses += 1;
      }
    }
  }
  return form;
}

function buildRosterPlayerIndex(league, teams) {
  const index = new Map();
  for (const [teamIdRaw, roster] of Object.entries(league?.rosters?.teams || {})) {
    const teamName = teams.get(Number(teamIdRaw));
    if (!teamName) continue;
    for (const player of roster?.rosterInfoList || []) {
      const name = `${player.firstName || ''} ${player.lastName || ''}`.trim() || player.displayName || '';
      if (!name) continue;
      const key = normalizeName(name);
      const current = index.get(key);
      const ovr = Number(player.playerBestOvr || player.ovrRating || player.overallRating || 0);
      if (!current || ovr > current.ovr) {
        index.set(key, { team: teamName, player, ovr, name });
      }
    }
  }
  return index;
}

function buildTop100PlayerIndex(top100 = []) {
  const index = new Map();
  for (const player of top100 || []) {
    const key = normalizeName(player?.name || '');
    if (!key || index.has(key)) continue;
    index.set(key, player);
  }
  return index;
}

function tradeAssetLabel(asset) {
  return String(asset?.label || asset?.name || asset?.raw || '').trim();
}

function normalizeTradeAssets(assets = [], fallbackText = '') {
  if (Array.isArray(assets) && assets.length) {
    return assets
      .map((asset) => {
        const label = tradeAssetLabel(asset);
        if (!label) return null;
        const isPick = asset?.type === 'pick' || /\b(round|pick|1st|2nd|3rd|4th)\b/i.test(label);
        return {
          ...asset,
          type: isPick ? 'pick' : 'player',
          label,
        };
      })
      .filter(Boolean);
  }

  return String(fallbackText || '')
    .split(/\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((label) => ({
      type: /\b(round|pick|1st|2nd|3rd|4th)\b/i.test(label) ? 'pick' : 'player',
      label,
      raw: label,
    }));
}

function resolveTradePerspective(trade, team) {
  const teamName = toDisplayTeam(team);
  const yourTeam = toDisplayTeam(trade?.yourTeam || '');
  const otherTeam = toDisplayTeam(trade?.otherTeam || '');
  if (!teamName || (!yourTeam && !otherTeam)) return null;
  const isYourSide = normalizeName(teamName) === normalizeName(yourTeam);
  const isOtherSide = normalizeName(teamName) === normalizeName(otherTeam);
  if (!isYourSide && !isOtherSide) return null;

  const sent = isYourSide
    ? normalizeTradeAssets(trade?.yourStructAssets, trade?.assetsSent)
    : normalizeTradeAssets(trade?.theirStructAssets, trade?.assetsReceived);
  const received = isYourSide
    ? normalizeTradeAssets(trade?.theirStructAssets, trade?.assetsReceived)
    : normalizeTradeAssets(trade?.yourStructAssets, trade?.assetsSent);
  const sentValue = Number(isYourSide ? trade?.sendTotal : trade?.recvTotal) || 0;
  const receivedValue = Number(isYourSide ? trade?.recvTotal : trade?.sendTotal) || 0;

  return {
    team: teamName,
    counterpart: isYourSide ? otherTeam : yourTeam,
    sent,
    received,
    sentValue,
    receivedValue,
    valueDelta: receivedValue - sentValue,
  };
}

function pickOwnerFromAsset(asset, fallbackTeam = '') {
  const explicit = asset?.originalOwner || asset?.viaTeam || asset?.owner || '';
  if (explicit) return toDisplayTeam(explicit);
  const label = tradeAssetLabel(asset);
  const viaMatch = label.match(/\bvia\s+([A-Za-z .'-]+)$/i);
  if (viaMatch?.[1]) return toDisplayTeam(viaMatch[1]);
  return toDisplayTeam(fallbackTeam);
}

function buildProjectedPickMap(ctx) {
  const order = draftOrder(ctx.league);
  const projected = new Map();
  order.forEach((slot, idx) => {
    const team = ctx.teams.get(Number(slot?.id));
    if (!team) return;
    projected.set(normalizeName(team), idx + 1);
  });
  return projected;
}

function buildApprovedTradeReturnItems(ctx) {
  const trades = Object.values(ctx.activeTrades || {}).filter((trade) => trade?.status === 'approved');
  if (!trades.length) return [];

  const projectedPickMap = buildProjectedPickMap(ctx);
  const rosterIndex = buildRosterPlayerIndex(ctx.league, ctx.teams);
  const top100Index = buildTop100PlayerIndex(ctx.top100);
  const items = [];

  for (const trade of trades) {
    const teamA = toDisplayTeam(trade?.yourTeam || '');
    const teamB = toDisplayTeam(trade?.otherTeam || '');
    if (!teamA || !teamB) continue;

    const sides = [resolveTradePerspective(trade, teamA), resolveTradePerspective(trade, teamB)].filter(Boolean);
    for (const side of sides) {
      const valueFeel =
        side.valueDelta >= 30 ? 'bargain' :
          side.valueDelta <= -30 ? 'overpay' :
            'even';

      const receivedPlayers = side.received.filter((asset) => asset.type === 'player');
      const sentPlayers = side.sent.filter((asset) => asset.type === 'player');
      const receivedPicks = side.received.filter((asset) => asset.type === 'pick');

      const productiveAddition = receivedPlayers
        .map((asset) => {
          const top = top100Index.get(normalizeName(tradeAssetLabel(asset)));
          if (!top || normalizeName(top.team || '') !== normalizeName(side.team)) return null;
          return top;
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.grade || 0) - Number(a.grade || 0))[0] || null;

      const thrivingDeparture = sentPlayers
        .map((asset) => {
          const top = top100Index.get(normalizeName(tradeAssetLabel(asset)));
          if (!top || normalizeName(top.team || '') !== normalizeName(side.counterpart)) return null;
          return top;
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.grade || 0) - Number(a.grade || 0))[0] || null;

      const unstableAddition = receivedPlayers
        .map((asset) => {
          const lookup = rosterIndex.get(normalizeName(tradeAssetLabel(asset)));
          if (!lookup || normalizeName(lookup.team || '') !== normalizeName(side.team)) return null;
          const top = top100Index.get(normalizeName(lookup.name));
          if (top) return null;
          return lookup;
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.ovr || 0) - Number(a.ovr || 0))[0] || null;

      const mostInterestingPick = receivedPicks
        .map((asset) => {
          const owner = pickOwnerFromAsset(asset, side.counterpart);
          const slot = projectedPickMap.get(normalizeName(owner));
          if (!slot) return null;
          const standing = [...ctx.standings.entries()].find(([teamId]) => normalizeName(ctx.teams.get(teamId) || '') === normalizeName(owner))?.[1] || null;
          const prev = [...ctx.prevStandings.entries()].find(([teamId]) => normalizeName(ctx.teams.get(teamId) || '') === normalizeName(owner))?.[1] || null;
          const delta = recordScore(standing) - recordScore(prev);
          return {
            asset,
            owner,
            slot,
            standing,
            delta,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.slot - b.slot)[0] || null;

      let text = null;
      let score = 0;

      if (productiveAddition && mostInterestingPick) {
        text = seededText(`trade_return:combo:${side.team}:${productiveAddition.name}`, [
          `The early return on {team}'s deal with {counterpart} keeps getting stronger. {player} is already giving them real weekly production, and the {owner} pick they control is still tracking near No. {slot}.`,
          `{team} keep getting more out of that deal with {counterpart}. {player} is already showing up on the weekly board, and the {owner} pick attached to the move is still carrying real top-of-board value at No. {slot}.`,
        ], {
          team: side.team,
          counterpart: side.counterpart,
          player: productiveAddition.name,
          owner: mostInterestingPick.owner,
          slot: mostInterestingPick.slot,
        });
        score = 96 - Math.min(25, mostInterestingPick.slot);
      } else if (productiveAddition) {
        text = seededText(`trade_return:add:${side.team}:${productiveAddition.name}`, [
          `The early return on {team}'s move with {counterpart} is getting louder. {player} is already giving them weekly top-100 production, so the price is starting to look more like a {valueFeel} than a reach.`,
          `{team} are already getting a real return on that deal with {counterpart}. {player} is showing up on the weekly board, and around the league the cost is starting to read more like a {valueFeel}.`,
        ], {
          team: side.team,
          counterpart: side.counterpart,
          player: productiveAddition.name,
          valueFeel: valueFeel === 'overpay' ? 'heavy swing' : valueFeel,
        });
        score = 91 + Math.min(6, Math.round(Number(productiveAddition.grade || 0) / 15));
      } else if (mostInterestingPick && mostInterestingPick.slot <= 12) {
        const ownerRecord = formatRecord(mostInterestingPick.standing);
        if (mostInterestingPick.delta <= -1 || recordScore(mostInterestingPick.standing) <= -2) {
          text = seededText(`trade_return:pick_rise:${side.team}:${mostInterestingPick.owner}`, [
            `The early return on {team}'s trade with {counterpart} keeps improving. The {owner} first they control is now projecting closer to No. {slot}, which makes that pick look richer than it did when the deal first landed.`,
            `{team} have more juice in that trade return now. With {owner} sitting at {record} and tracking near No. {slot}, the first-rounder they hold looks more valuable by the week.`,
          ], {
            team: side.team,
            counterpart: side.counterpart,
            owner: mostInterestingPick.owner,
            slot: mostInterestingPick.slot,
            record: ownerRecord,
          });
        } else {
          text = seededText(`trade_return:pick_hold:${side.team}:${mostInterestingPick.owner}`, [
            `{team} still have meaningful pick value tied up in that deal with {counterpart}. Even with {owner} moving around a bit, the first they control is still tracking near No. {slot}.`,
            `That trade still carries real draft value for {team}. The {owner} first involved is holding in the top part of the board around No. {slot}.`,
          ], {
            team: side.team,
            counterpart: side.counterpart,
            owner: mostInterestingPick.owner,
            slot: mostInterestingPick.slot,
          });
        }
        score = 88 - Math.min(18, mostInterestingPick.slot);
      } else if (mostInterestingPick && mostInterestingPick.slot >= 20) {
        text = seededText(`trade_return:pick_fall:${side.team}:${mostInterestingPick.owner}`, [
          `The pick side of {team}'s deal with {counterpart} is not carrying the same weight right now. With {owner} up to {record}, that first is looking less premium than it did when the trade was made.`,
          `{team} are getting a different read on that trade return now. As {owner} climb to {record}, the first-rounder involved no longer looks as promising as it first did.`,
        ], {
          team: side.team,
          counterpart: side.counterpart,
          owner: mostInterestingPick.owner,
          record: formatRecord(mostInterestingPick.standing),
        });
        score = 82;
      } else if (thrivingDeparture) {
        text = seededText(`trade_return:sting:${side.team}:${thrivingDeparture.name}`, [
          `That trade is still getting reviewed from {team}'s side because {player} is producing well for {counterpart}. Around the league, that is the part making the price feel heavier.`,
          `{team} are still wearing some of the trade math here. {player} is already giving {counterpart} real production, which is the piece keeping the cost under discussion.`,
        ], {
          team: side.team,
          counterpart: side.counterpart,
          player: thrivingDeparture.name,
        });
        score = 86 + Math.min(5, Math.round(Number(thrivingDeparture.grade || 0) / 20));
      } else if (unstableAddition && valueFeel === 'overpay') {
        text = seededText(`trade_return:slow:${side.team}:${unstableAddition.name}`, [
          `The early return on {team}'s move with {counterpart} still feels unsettled. {player} has not turned into a loud weekly return yet, so the deal is still carrying some overpay talk.`,
          `{team} are still waiting for that trade to read cleaner. {player} has not really broken into the weekly story yet, and the market still reads the cost as a little heavy.`,
        ], {
          team: side.team,
          counterpart: side.counterpart,
          player: unstableAddition.name,
        });
        score = 80;
      }

      if (!text) continue;
      items.push({
        score,
        text,
        key: `trade_return:${side.team}:${side.counterpart}:${trade?.tradeId || trade?.createdAt || ''}`,
        category: 'trade',
      });
    }
  }

  return items;
}

function summarizeFranchiseProfiles(profiles = []) {
  const uniqueLines = [];
  const seen = new Set();
  for (const profile of profiles) {
    const options = [
      profile?.tradePosture?.line,
      profile?.pressureLine,
      profile?.identity?.line,
    ].filter(Boolean);
    const firstUnique = options.find((line) => {
      const key = normalizeName(line);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (firstUnique) uniqueLines.push(`${profile.teamName}: ${firstUnique}`);
  }
  return uniqueLines;
}

async function buildCoachUserTeamMap(guild) {
  const roleMap = loadRoleMap();
  const out = new Map();
  for (const [name, roleId] of Object.entries(roleMap)) {
    if (!/ coach$/i.test(name)) continue;
    const teamName = name.replace(/ coach$/i, '').trim();
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    if (role.members?.size) {
      role.members.forEach((member) => out.set(member.id, teamName));
      continue;
    }
    try {
      const members = await guild.members.fetch();
      members.filter((member) => member.roles.cache.has(roleId)).forEach((member) => out.set(member.id, teamName));
    } catch {
      // ignore
    }
  }
  return out;
}

function loadTop100(leagueId) {
  const all = safeReadJSON(TOP_PLAYERS_PATH, {});
  return all?.[leagueId]?.top100 || [];
}

function loadWeeklyTop100(leagueId, weekNumber = null) {
  if (!leagueId || !weekNumber || weekNumber < 1) return [];
  const file = path.join(process.cwd(), 'data', 'madden', 'top_players_history', String(leagueId), `week_${weekNumber}.json`);
  const data = safeReadJSON(file, null);
  if (!data) return [];
  return Array.isArray(data) ? data : (data?.top100 || data?.players || []);
}

function chooseProspectForNeed(need, draftClass) {
  const mapNeed = (player) => {
    const pos = String(player?.position || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['LT', 'RT'].includes(pos)) return 'OT';
    if (['LG', 'RG', 'C'].includes(pos)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE'].includes(pos)) return 'EDGE';
    if (['DT', 'NT'].includes(pos)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    if (pos === 'CB') return 'CB';
    if (['FS', 'SS'].includes(pos)) return 'S';
    if (pos === 'TE') return 'TE';
    if (pos === 'WR') return 'WR';
    if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
    return 'BPA';
  };
  return draftClass
    .slice()
    .sort((a, b) => Number(a.RNK ?? 9999) - Number(b.RNK ?? 9999))
    .find((player) => mapNeed(player) === need) || null;
}

function buildPhaseLanguage(seasonContext = {}) {
  const phase = seasonContext?.phase || 'offseason';
  if (phase === 'early_regular') {
    return {
      recapIntro: `With the league still settling in through ${seasonContext.completedRegularWeeks || 0} games, the week felt more like an identity check than a final verdict.`,
      rumorFrame: 'It is still early enough that one result can shift the conversation fast.',
    };
  }
  if (phase === 'mid_regular') {
    return {
      recapIntro: 'By the middle of the season, the league starts looking a lot less theoretical and a lot more honest.',
      rumorFrame: 'At this point in the season, trends stop feeling accidental.',
    };
  }
  if (phase === 'late_regular') {
    return {
      recapIntro: 'With the stretch run underway, every result is starting to carry playoff weight or draft-position fallout.',
      rumorFrame: 'This late in the year, the league is reading everything through pressure, urgency, and leverage.',
    };
  }
  if (phase === 'postseason') {
    return {
      recapIntro: 'With the postseason lens on everything now, even league chatter starts sounding sharper.',
      rumorFrame: 'In the postseason window, the conversation naturally shifts toward pressure, roster direction, and what comes next.',
    };
  }
  return {
    recapIntro: 'With the calendar flipped to offseason mode, the league conversation moves from results to roster building.',
    rumorFrame: 'This part of the cycle is more about roster direction, draft posture, and who is positioning to move next.',
  };
}

function buildMockDraftSignals(ctx, limit = 3) {
  const draftPlayers = ctx?.draftClassInfo?.players || [];
  if (!draftPlayers.length) return [];
  const seasonYear = getUpcomingDraftYear(ctx.league);
  const order = applyPickTrades(draftOrder(ctx.league), seasonYear).slice(0, Math.max(limit * 2, 8));
  const signals = [];
  for (const pick of order) {
    const team = String(pick.team || '').replace(/\(via.*$/i, '').trim();
    if (!team) continue;
    const needKey = normalizeName(team);
    const primaryNeed = (ctx.needs[needKey] || ['BPA'])[0];
    const prospect = chooseProspectForNeed(primaryNeed, draftPlayers);
    if (!prospect) continue;
    const pickLabel = pick.pickNum ? `No. ${pick.pickNum}` : `Round ${pick.round}`;
    signals.push({
      team,
      prospect,
      text: `The latest mock draft has ${team} taking ${prospect.name} (${prospect.position}) at ${pickLabel}.`,
      key: `mock:${team}:${pickLabel}`,
    });
    if (signals.length >= limit) break;
  }
  return signals;
}

async function collectThreadParticipation(client, guild, threadInfo) {
  const thread = await client.channels.fetch(threadInfo.threadId).catch(() => null);
  if (!thread || !thread.isTextBased()) return { awayCount: 0, homeCount: 0 };
  const messages = await thread.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return { awayCount: 0, homeCount: 0 };
  const awayUserIds = new Set();
  const homeUserIds = new Set();
  for (const roleId of threadInfo.awayRoleIds || []) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    role?.members?.forEach((member) => awayUserIds.add(member.id));
  }
  for (const roleId of threadInfo.homeRoleIds || []) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    role?.members?.forEach((member) => homeUserIds.add(member.id));
  }
  let awayCount = 0;
  let homeCount = 0;
  for (const message of messages.values()) {
    if (message.author?.bot) continue;
    if (awayUserIds.has(message.author.id)) awayCount += 1;
    if (homeUserIds.has(message.author.id)) homeCount += 1;
  }
  return { awayCount, homeCount };
}

export async function buildStoryContext(guild, client, options = {}) {
  const latest = loadLatestLeagueSnapshot();
  const league = latest?.league || null;
  if (!league) return null;
  const live = buildLiveDraftContext(league);
  const franchiseProfileContext = buildFranchiseProfileContext(league, guild);
  const prevLeague = previousSnapshotFor(latest.file);
  const needs = deriveTeamNeeds(league);
  const teams = teamNameMap(league);
  const standings = standingsMap(league);
  const prevStandings = standingsMap(prevLeague);
  const draftClassInfo = loadDraftClassForLeague(league);
  const roleMap = loadRoleMap();
  const teamCoachMentions = addLeagueTeamCoachAliases(buildTeamCoachMentionMap(roleMap), league);
  const coachUserTeamMap = (guild && !options.skipCoachUserTeamMap) ? await buildCoachUserTeamMap(guild) : new Map();
  const leagueId = String(league?.info?.leagueId || league?.leagueId || '');
  const targetWeek = Number(options.targetWeek || 0) || null;
  return {
    latest,
    league,
    live,
    seasonContext: live?.seasonContext || null,
    needs,
    teams,
    standings,
    prevStandings,
    draftClassInfo,
    activeTrades: safeReadJSON(ACTIVE_TRADES_PATH, {}),
    pendingProofs: safeReadJSON(PENDING_PROOFS_PATH, {}),
    threadState: safeReadJSON(THREAD_STATE_PATH, { threads: {} }),
    fairsims: safeReadJSON(FAIRSIMS_PATH, {}),
    scoutLog: safeReadJSON(SCOUT_LOG_PATH, []),
    playerChanges: safeReadJSON(PLAYER_CHANGES_PATH, { history: [] }),
    top100: targetWeek ? loadWeeklyTop100(leagueId, targetWeek) : loadTop100(leagueId),
    targetWeek,
    coachUserTeamMap,
    teamCoachMentions,
    roleMap,
    franchiseProfileContext,
    client,
    guild,
  };
}

export function buildRumorMillItems(ctx, limit = 10, options = {}) {
  const items = [];
  const variantSeed = Number(options.variantSeed ?? 0);
  const recentStoryKeys = new Set((options.recentStoryKeys || []).map((key) => String(key || '')));
  const recentCategories = new Set((options.recentCategories || []).map((category) => String(category || '')));
  const completedWeek = latestCompletedWeek(ctx.league);
  const recentForm = buildRecentForm(ctx.league);
  const draftYear = getUpcomingDraftYear(ctx.league);
  const seasonContext = ctx.seasonContext || {};
  const phaseLanguage = buildPhaseLanguage(seasonContext);
  const mockSignals = buildMockDraftSignals(ctx, 3);
  const profileFor = (team) => buildFranchiseProfile(ctx.franchiseProfileContext, team);
  const add = (score, text, key, category = 'misc') => items.push({ score, text, key, category });

  for (const item of buildApprovedTradeReturnItems(ctx)) {
    add(item.score, item.text, item.key, item.category);
  }

  if (seasonContext.isInSeason) {
    for (const [teamId, standing] of ctx.standings.entries()) {
      const prev = ctx.prevStandings.get(teamId);
      if (!prev) continue;
      const delta = recordScore(standing) - recordScore(prev);
      const team = ctx.teams.get(teamId);
      const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
      const wins = Number(standing.totalWins || 0);
      const losses = Number(standing.totalLosses || 0);
      if (delta >= 1) {
        const strongRise = delta >= 2 || wins >= 5 || (wins - losses) >= 2;
        add(
          (strongRise ? 78 : 72) + delta,
          strongRise
            ? seededText(`rise:${team}:strong:${variantSeed}`, [
                `{coachLead}{team} are climbing. The move from {prevRecord} to {record} has people around the league treating them more seriously.`,
                `{team} are building more real momentum now. Going from {prevRecord} to {record} is enough to sharpen the league conversation.`,
                `{coachLead}{team} pushed themselves into a more serious light this week. The jump from {prevRecord} to {record} landed around the league.`,
              ], {
                coachLead: coachTag ? `${coachTag} and ` : '',
                team,
                prevRecord: formatRecord(prev),
                record: formatRecord(standing),
              })
            : seededText(`rise:${team}:mild:${variantSeed}`, [
                `{coachLead}{team} picked up a useful step this week, moving from {prevRecord} to {record}.`,
                `{team} nudged themselves in a better direction, moving from {prevRecord} to {record}.`,
                `The week treated {team} a little better, with the record shifting from {prevRecord} to {record}.`,
                `{team} came out of the week looking slightly healthier, shifting from {prevRecord} to {record}.`,
              ], {
                coachLead: coachTag ? `${coachTag} and ` : '',
                team,
                prevRecord: formatRecord(prev),
                record: formatRecord(standing),
              }),
          `rise:${team}`,
          'trend_up',
        );
      }
      if (delta <= -1) {
        const hardSlide = delta <= -2 || losses >= 5 || (losses - wins) >= 3;
        add(
          (hardSlide ? 84 : 74) + Math.abs(delta),
          hardSlide
            ? seededText(`slide:${team}:hard:${variantSeed}`, [
                `{coachLead}{team} are slipping. The drop from {prevRecord} to {record} is creating more pressure than anyone there would want.`,
                `{team} took another hit, moving from {prevRecord} to {record}, and the pressure is building now.`,
                `{coachLead}{team} are taking on more heat now. The move from {prevRecord} to {record} made the week feel heavier around them.`,
              ], {
                coachLead: coachTag ? `${coachTag} and ` : '',
                team,
                prevRecord: formatRecord(prev),
                record: formatRecord(standing),
              })
            : seededText(`slide:${team}:mild:${variantSeed}`, [
                `{coachLead}{team} took a step back this week, sliding from {prevRecord} to {record}.`,
                `{team} gave back a little ground, moving from {prevRecord} to {record}.`,
                `The week pushed {team} the wrong way, with the record moving from {prevRecord} to {record}.`,
                `{team} left the week a little worse off, slipping from {prevRecord} to {record}.`,
              ], {
                coachLead: coachTag ? `${coachTag} and ` : '',
                team,
                prevRecord: formatRecord(prev),
                record: formatRecord(standing),
              }),
          `slide:${team}`,
          'trend_down',
        );
      }
    }
  }

  for (const [teamId, standing] of ctx.standings.entries()) {
    const team = ctx.teams.get(teamId);
    if (!team) continue;
    const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
    const wins = Number(standing.totalWins || 0);
    const losses = Number(standing.totalLosses || 0);
    const teamKey = normalizeName(team);
    const needs = ctx.needs[teamKey] || ['BPA'];
    const openTradeCount = Object.values(ctx.activeTrades || {}).filter((trade) =>
      ['awaiting_coach_b', 'committee', 'approved_pending_proof'].includes(trade?.status) &&
      [trade.yourTeam, trade.otherTeam].includes(team)
    ).length;
    if (wins >= 3 && openTradeCount > 0) {
      add(
        86 + openTradeCount,
        seededText(`buyer:${team}:${variantSeed}`, [
          `{coachLead}{team} are getting buyer buzz. The record says push, and the rest of the league expects them to stay aggressive.`,
          `{coachLead}{team} keep drawing buy-now chatter. Around the league, this is being read like a team that should add, not wait.`,
          `{coachLead}{team} are being talked about like buyers. The combination of record and timing makes them look more aggressive than patient.`,
          `{team} keep getting read through a buy-now lens. Around the league, the expectation is that this is a team more likely to add than sit still.`,
        ], {
          coachLead: coachTag ? `${coachTag} and ` : '',
          team,
        }),
        `buyer:${team}`,
        'trade',
      );
    }
    if (losses >= 3 && openTradeCount > 0) {
      add(
        85 + openTradeCount,
        seededText(`seller:${team}:${variantSeed}`, [
          `{coachLead}{team} are drawing seller chatter. The record is forcing the question, and rival teams are waiting to see if a veteran hits the market.`,
          `{coachLead}{team} keep getting pulled into seller talk. At this point, the rest of the league is watching for a veteran to shake loose.`,
          `Around the league, {team} are starting to sound like a team that may have to sell. The record is putting real pressure on that call.`,
          `{team} have started to sound more like a sell-side team in league conversation. The record is making that discussion harder to avoid.`,
        ], {
          coachLead: coachTag ? `${coachTag} and ` : '',
          team,
        }),
        `seller:${team}`,
        'trade',
      );
    }
    if (losses >= 3 && ['QB', 'OT', 'CB', 'EDGE'].includes(needs[0])) {
      add(80, describeNeedPressureRumor(team, coachTag, needs[0], variantSeed), `pressure:${team}`, 'pressure');
    }
  }

  for (const team of [...ctx.teams.values()]) {
    const profile = profileFor(team);
    if (!profile) continue;
    const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
    const coachLead = coachTag ? `${coachTag} and ` : '';
    const topNeed = formatNeedLabel(profile.needs?.[0] || 'BPA').toLowerCase();
    const secondNeed = formatNeedLabel(profile.needs?.[1] || profile.needs?.[0] || 'BPA').toLowerCase();

    if (profile.identity?.short === 'Win-now build') {
      add(
        79,
        seededText(`identity:win_now:${team}:${variantSeed}`, [
          `{coachLead}{team} still look like a win-now roster. Around the league, the expectation is that they patch live holes instead of sitting on their hands.`,
          `{team} continue to read like a win-now build. People around the league expect them to treat weak spots like urgent ones, not future problems.`,
        ], { coachLead, team }),
        `identity:${team}:win_now`,
        'identity',
      );
    }

    if (profile.identity?.short === 'Capital-heavy build') {
      add(
        76,
        seededText(`identity:capital:${team}:${variantSeed}`, [
          `{coachLead}{team} have enough draft leverage to stay patient. The read around the league is that they do not need to force a move unless it clearly improves the roster.`,
          `{team} keep getting framed as a capital-rich roster. That gives them more patience than most teams around them.`,
        ], { coachLead, team }),
        `identity:${team}:capital`,
        'identity',
      );
    }

    if (profile.identity?.short === 'Young-core build') {
      add(
        75,
        seededText(`identity:young:${team}:${variantSeed}`, [
          `{coachLead}{team} still look like a young-core operation. The expectation is more about protecting the foundation than chasing short-term noise.`,
          `{team} keep getting talked about as a roster that should grow into itself. The young-core read is still stronger than any quick-fix angle.`,
        ], { coachLead, team }),
        `identity:${team}:young`,
        'identity',
      );
    }

    if (profile.tradePosture?.short === 'Selective hold') {
      add(
        74,
        seededText(`trade_posture:hold:${team}:${variantSeed}`, [
          `{coachLead}{team} are getting read more as a selective hold than an all-in push. If they move, it will probably have to clearly improve {need}.`,
          `Around the league, {team} are not being treated like a desperate market team. If they act, it likely has to be for a real {need} answer.`,
        ], { coachLead, team, need: topNeed }),
        `trade_posture:${team}:hold`,
        'trade_posture',
      );
    }

    if (profile.tradePosture?.short === 'Seller lean') {
      add(
        82,
        seededText(`trade_posture:sell:${team}:${variantSeed}`, [
          `{coachLead}{team} are getting stronger sell-side noise. The cleanest read is that expiring veterans matter less than getting younger at {need} or {need2}.`,
          `{team} continue to draw seller chatter. Around the league, the expectation is that they listen on expiring vets and look for younger answers at {need}.`,
          `{coachLead}{team} are starting to feel more like a seller than a holder. The cleaner league read is that younger answers at {need} matter more than hanging onto expiring veterans.`,
          `The market tone around {team} keeps bending sell-side. Around the league, the expectation is that they at least listen if a move helps them get younger at {need} or {need2}.`,
        ], { coachLead, team, need: topNeed, need2: secondNeed }),
        `trade_posture:${team}:sell`,
        'trade_posture',
      );
    }

    if (profile.tradePosture?.short === 'Buyer lean') {
      add(
        81,
        seededText(`trade_posture:buy:${team}:${variantSeed}`, [
          `{coachLead}{team} are still getting buyer noise, but the cleaner expectation is one real move at {need}, not a scattershot push.`,
          `The market read on {team} is still buyer-leaning. The better fit sounds like one meaningful {need} move, not volume for the sake of volume.`,
        ], { coachLead, team, need: topNeed }),
        `trade_posture:${team}:buy`,
        'trade_posture',
      );
    }

    if (Number(profile.accountability?.strikeTotal || 0) >= 3) {
      add(
        83 + Math.floor(Number(profile.accountability.strikeTotal || 0)),
        seededText(`accountability:${team}:${variantSeed}`, [
          `{coachLead}{team} are carrying accountability pressure now. A {total}/5 strike line changes how the rest of the league reads any more missed time.`,
          `There is more accountability pressure hanging over {team} now. At {total}/5 on the strike board, the margin for another miss is thin.`,
        ], { coachLead, team, total: Number(profile.accountability.strikeTotal || 0).toFixed(1) }),
        `accountability:${team}`,
        'accountability',
      );
    }

    if (Number(profile.accountability?.consecutiveSilentWeeks || 0) >= 1) {
      add(
        86 + Number(profile.accountability.consecutiveSilentWeeks || 0),
        seededText(`silent:${team}:${variantSeed}`, [
          `{coachLead}{team} are drawing more communication heat now. The thread silence is starting to matter as much as the standings.`,
          `Communication around {team} is getting watched more closely now. Silence in game threads travels quickly around the league.`,
        ], { coachLead, team }),
        `silent:${team}`,
        'accountability',
      );
    }

    if (profile.awardLine) {
      add(
        77,
        seededText(`award:${team}:${variantSeed}`, [
          `{awardLine}`,
          `One quieter league note: {awardLine}`,
          `One player note that did carry over from the week: {awardLine}`,
          `The individual-awards picture also kept a few names alive. {awardLine}`,
        ], { awardLine: profile.awardLine }),
        `award:${team}`,
        'awards',
      );
    }
  }

  if (seasonContext.isInSeason) {
    for (const [teamId, form] of recentForm.entries()) {
      const team = ctx.teams.get(teamId);
      if (!team) continue;
      const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
      const margin = Number(form.pf || 0) - Number(form.pa || 0);
      if (form.wins >= 2) add(
        82 + form.wins,
        seededText(`run:${team}:${variantSeed}`, [
          `{coachLead}{team} rolling. {wins} straight wins and a {margin} scoring margin over that stretch is the kind of form people notice.`,
          `{team} have put together a real run. {wins} straight and a {margin} point differential over that stretch will get the league talking.`,
          `The noise around {team} is getting louder for a reason. {wins} straight wins with that kind of scoring margin reads like a team finding itself.`,
        ], {
          coachLead: coachTag ? `${coachTag} have ` : '',
          team,
          wins: form.wins,
          margin,
        }),
        `run:${team}`,
        'trend_up',
      );
      if (form.losses >= 2) add(
        88 + form.losses,
        seededText(`cold:${team}:${variantSeed}`, [
          `{coachLead}{team} drop {losses} straight while getting outscored by {margin}. The urgency is real.`,
          `{team} are sliding. {losses} straight losses and a {margin} point swing over that stretch is the kind of skid people feel quickly.`,
          `The tone around {team} has changed. {losses} straight losses while getting outscored by {margin} will do that.`,
        ], {
          coachLead: coachTag ? `${coachTag} just watched ` : '',
          team,
          losses: form.losses,
          margin: Math.abs(margin),
        }),
        `cold:${team}`,
        'trend_down',
      );
    }
  }

  const leagueTop = ctx.top100.slice(0, 25);
  const qbBuzz = leagueTop.find((player) => player.position === 'QB');
  const wrBuzz = leagueTop.find((player) => player.position === 'WR');
  const edgeBuzz = leagueTop.find((player) => ['LE', 'RE', 'EDGE', 'REDGE', 'LEDGE', 'DE'].includes(String(player.position || '').toUpperCase()));
  const rookieBuzz = leagueTop.find((player) => Number(player?.yearsPro ?? 99) <= 1);
  if (qbBuzz) add(90, `${coachMentionFor(qbBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(qbBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(qbBuzz, 'heat')}`, `player:${qbBuzz.name}`, 'player_heat');
  if (wrBuzz) add(83, `${coachMentionFor(wrBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(wrBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(wrBuzz, 'heat')}`, `player:${wrBuzz.name}`, 'player_heat');
  if (edgeBuzz) add(79, `${coachMentionFor(edgeBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(edgeBuzz.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(edgeBuzz, 'heat')}`, `player:${edgeBuzz.name}`, 'player_heat');
  if (rookieBuzz) add(84, `${coachMentionFor(rookieBuzz.team, ctx.teamCoachMentions) ? `${coachMentionFor(rookieBuzz.team, ctx.teamCoachMentions)} and ` : ''}${rookieBuzz.team} have a young name turning into real conversation with ${rookieBuzz.name}. When a rookie starts stacking ${formatGrade(rookieBuzz.grade)}-level weeks, people notice fast.`, `rookie:${rookieBuzz.name}`, 'player_heat');

  const roughLeaguePlayers = ctx.top100
    .slice()
    .reverse()
    .filter((player) => isBadStatLine(player))
    .slice(0, 6);
  for (const player of roughLeaguePlayers.slice(0, 3)) {
    add(
      82,
      `${coachMentionFor(player.team, ctx.teamCoachMentions) ? `${coachMentionFor(player.team, ctx.teamCoachMentions)} and ` : ''}${describePerformanceRumor(player, 'struggle')}`,
      `rough:${player.team}:${player.name}`,
      'player_struggle',
    );
  }

  const tradeStates = Object.values(ctx.activeTrades || {}).filter((trade) => ['awaiting_coach_b', 'committee', 'approved_pending_proof'].includes(trade?.status));
  const tradeCountsByTeam = new Map();
  for (const trade of tradeStates) {
    for (const team of [trade.yourTeam, trade.otherTeam]) {
      if (!team) continue;
      tradeCountsByTeam.set(team, (tradeCountsByTeam.get(team) || 0) + 1);
    }
  }
  for (const [team, count] of tradeCountsByTeam.entries()) {
    const acceptedCount = tradeStates.filter((trade) => ['committee', 'approved_pending_proof'].includes(trade?.status) && [trade.yourTeam, trade.otherTeam].includes(team)).length;
    if (acceptedCount > 0) {
      add(
        84 + acceptedCount,
        seededText(`trade:${team}`, [
          `{coachLead}{team} keep showing up around the trade desk. With {count} accepted process{suffix} alive, the expectation is movement.`,
          `{team} continue to sit in the middle of trade chatter. {count} accepted process{suffix} still being alive is enough to keep the heat there.`,
          `{coachLead}{team} are not out of the trade conversation yet. With {count} accepted process{suffix} still moving, the market still feels live around them.`,
        ], {
          coachLead: coachMentionFor(team, ctx.teamCoachMentions) ? `${coachMentionFor(team, ctx.teamCoachMentions)} and ` : '',
          team,
          count: acceptedCount,
          suffix: acceptedCount === 1 ? '' : 'es',
        }),
        `trade:${team}`,
        'trade',
      );
    }
  }
  for (const trade of tradeStates.slice(0, 4)) {
    const teamA = trade.yourTeam;
    const teamB = trade.otherTeam;
    if (!teamA || !teamB) continue;
    if (trade.status === 'awaiting_coach_b') {
      const offeredBy = trade.createdByTeam || trade.createdByTeamName || teamA;
      const targetTeam = normalizeName(offeredBy) === normalizeName(teamA) ? teamB : teamA;
      const offeredAssets = String(
        normalizeName(offeredBy) === normalizeName(teamA)
          ? (trade.assetsSent || trade.assetsReceived || '')
          : (trade.assetsReceived || trade.assetsSent || '')
      ).split(/\n|,/).map((s) => s.trim()).filter(Boolean);
      const headlineAsset = offeredAssets[0];
      add(
        81,
        `${coachMentionFor(offeredBy, ctx.teamCoachMentions) ? `${coachMentionFor(offeredBy, ctx.teamCoachMentions)} and ` : ''}${offeredBy} reportedly submitted an offer${headlineAsset ? ` centered on ${headlineAsset}` : ''} to ${coachMentionFor(targetTeam, ctx.teamCoachMentions) ? `${coachMentionFor(targetTeam, ctx.teamCoachMentions)} and ` : ''}${targetTeam}, according to league chatter.`,
        `trade_offer:${trade.tradeId || `${teamA}:${teamB}`}`,
        'trade',
      );
      continue;
    }
    const statusMap = {
      committee: 'is sitting with committee',
      approved_pending_proof: 'is waiting on proof to clear',
    };
    add(
      87,
      `${coachMentionFor(teamA, ctx.teamCoachMentions) || teamA} and ${coachMentionFor(teamB, ctx.teamCoachMentions) || teamB} still have live business on the board. The deal ${statusMap[trade.status] || 'is still moving through the process'}.`,
      `trade_pair:${trade.tradeId || `${teamA}:${teamB}`}`,
      'trade',
    );
  }

  const leagueTeamInfos = ctx.league?.teams?.leagueTeamInfoList || [];
  for (const teamInfo of leagueTeamInfos) {
    const team = getFullTeamNameFromParts(teamInfo.cityName, teamInfo.displayName, teamInfo.nickName, teamInfo.displayName);
    const teamKey = normalizeName(team);
    const teamNeeds = ctx.needs[teamKey] || ['BPA'];
    const primaryNeed = teamNeeds[0];
    const prospect = chooseProspectForNeed(primaryNeed, ctx.draftClassInfo.players);
    const standing = ctx.standings.get(Number(teamInfo.teamId));
    if (!prospect || !standing) continue;
    if (Number(standing.totalWins || 0) >= 3 || Number(standing.totalLosses || 0) >= 3) {
      add(76, `League evaluators keep tying ${coachMentionFor(team, ctx.teamCoachMentions) ? `${coachMentionFor(team, ctx.teamCoachMentions)} and ` : ''}${team} to ${titleCase(primaryNeed)} help in the ${draftYear} class. ${prospect.name} from ${prospect.school || 'that board'} is one name that keeps surfacing.`, `need:${team}`, 'draft');
    }
  }

  const currentClass = ctx.draftClassInfo.classId;
  const seasonYear = Number(ctx.league?.info?.careerHubInfo?.seasonInfo?.calendarYear || ctx.league?.info?.calendarYear || ctx.league?.calendarYear || 2025);
  const scoutCounts = new Map();
  for (const entry of ctx.scoutLog || []) {
    if (!entry || String(entry.classId || '').toLowerCase() !== String(currentClass).toLowerCase()) continue;
    if (Number(entry.seasonYear || seasonYear) !== seasonYear) continue;
    const team = ctx.coachUserTeamMap.get(entry.userId);
    if (!team) continue;
    const key = `${team}|${entry.player}`;
    const current = scoutCounts.get(key) || { team, player: entry.player, position: entry.position, school: entry.school, count: 0 };
    current.count += 1;
    scoutCounts.set(key, current);
  }
  const topLinks = [...scoutCounts.values()].filter((entry) => entry.count >= 2).sort((a, b) => b.count - a.count).slice(0, 4);
  for (const link of topLinks) {
    add(85 + link.count, `There is real smoke around ${coachMentionFor(link.team, ctx.teamCoachMentions) ? `${coachMentionFor(link.team, ctx.teamCoachMentions)} and ` : ''}${link.team} with ${link.player}${link.position ? ` (${link.position})` : ''}. At this point, it reads like more than random scouting noise.`, `scout:${link.team}:${link.player}`, 'scouting');
  }

  const playerChangeBatch = latestPlayerChangeBatch(ctx);
  const notablePlayerChanges = (playerChangeBatch?.items || [])
    .map((entry) => ({
      ...entry,
      score: Math.max(...(entry.changes || []).map(attributeChangeWeight), 0),
      importance: playerChangeImportance(entry, ctx),
    }))
    .filter((entry) => shouldSurfacePlayerChange(entry, ctx))
    .sort((a, b) => (b.score + b.importance) - (a.score + a.importance))
    .slice(0, 4);
  for (const entry of notablePlayerChanges) {
    const rumor = describePlayerChangeRumor(entry, coachMentionFor(entry.teamName, ctx.teamCoachMentions));
    if (!rumor) continue;
    add(76 + entry.score + Math.floor(entry.importance / 2), rumor, `player_change:${entry.teamName}:${entry.playerName}`, 'player_change');
  }

  for (const signal of mockSignals) {
    add(78, `${phaseLanguage.rumorFrame} ${signal.text}`, signal.key, 'draft');
  }

  for (const [teamIdRaw, roster] of Object.entries(ctx.league?.rosters?.teams || {})) {
    const teamId = Number(teamIdRaw);
    const team = ctx.teams.get(teamId);
    if (!team) continue;
    const injured = (roster?.rosterInfoList || [])
      .filter((player) => Number(player?.injuryLength || 0) >= 4)
      .sort((a, b) => Number(b.playerBestOvr || b.teamSchemeOvr || 0) - Number(a.playerBestOvr || a.teamSchemeOvr || 0))[0];
    if (!injured) continue;
    const coachTag = coachMentionFor(team, ctx.teamCoachMentions);
    const name = `${injured.firstName || ''} ${injured.lastName || ''}`.trim() || injured.displayName || 'A starter';
    add(
      81,
      pickTemplate([
        `${coachTag ? `${coachTag} and ` : ''}${team} have an availability variable to manage. ${name} is the kind of loss that can force a short-term pivot in touches, snaps, or roster planning.`,
        `${coachTag ? `${coachTag} and ` : ''}${team} now have an availability issue hanging over the week. Losing ${name} can change how snaps, touches, or short-term roster choices get handled.`,
        `${team} also left the week with a personnel problem to sort through. ${name} is the kind of absence that can bend usage and short-term planning pretty quickly.`,
      ], variantSeed + team.length),
      `injury:${team}:${name}`,
      'injury',
    );
  }

  const categoryCaps = seasonContext.phase === 'offseason'
      ? {
        trade: 3,
        scouting: 2,
        draft: 3,
        identity: 2,
        trade_posture: 2,
        accountability: 1,
        awards: 1,
        player_heat: 2,
        player_change: 1,
        player_struggle: 1,
        trend_up: 0,
        trend_down: 1,
        pressure: 2,
        injury: 2,
        misc: 2,
      }
      : {
        trade: 3,
        scouting: 2,
        draft: seasonContext.phase === 'late_regular' || seasonContext.phase === 'postseason' ? 2 : 1,
        identity: 2,
        trade_posture: 2,
        accountability: 1,
        awards: 1,
        player_heat: 3,
        player_change: 1,
        player_struggle: 2,
        trend_up: 2,
        trend_down: 2,
        pressure: 2,
        injury: 2,
        misc: 2,
      };
  const dedupedItems = items
    .sort((a, b) => {
      const aPenalty = (recentStoryKeys.has(String(a?.key || '')) ? 18 : 0) + (recentCategories.has(String(a?.category || '')) ? 6 : 0);
      const bPenalty = (recentStoryKeys.has(String(b?.key || '')) ? 18 : 0) + (recentCategories.has(String(b?.category || '')) ? 6 : 0);
      return (b.score - bPenalty) - (a.score - aPenalty);
    })
    .filter((item, index, arr) => arr.findIndex((other) => other.key === item.key) === index);
  const primaryPool = dedupedItems.slice(0, Math.max(limit * 3, 12));
  const orderedPool = [
    ...seededOrder(`rumor-pool:${completedWeek}:${variantSeed}`, primaryPool),
    ...dedupedItems.filter((item) => !primaryPool.includes(item)),
  ];

  const categoryCounts = new Map();
  const selected = [];
  for (const item of orderedPool) {
    const count = categoryCounts.get(item.category) || 0;
    const cap = categoryCaps[item.category] ?? 1;
    if (count >= cap) continue;
    selected.push(item);
    categoryCounts.set(item.category, count + 1);
    if (selected.length >= limit) break;
  }

  if (selected.length < limit) {
    for (const item of orderedPool) {
      if (selected.some((entry) => entry.key === item.key)) continue;
      selected.push(item);
      if (selected.length >= limit) break;
    }
  }

  return selected.map((item) => ({ ...item }));
}

export function buildWeeklyRecapData(ctx, options = {}) {
  const forcedWeek = Number(options.targetWeek ?? ctx?.targetWeek ?? 0);
  const currentWeek = Number.isFinite(forcedWeek) && forcedWeek > 0 ? forcedWeek - 1 : latestCompletedWeek(ctx.league);
  const variantSeed = Number(options.variantSeed ?? Date.now());
  const seasonContext = ctx.seasonContext || {};
  const phaseLanguage = buildPhaseLanguage(seasonContext);
  const mockSignals = buildMockDraftSignals(ctx, 2);
  const recentGames = currentWeek == null ? [] : listCompletedGames(ctx.league, currentWeek);
  const selectedGames = selectRecapGames(ctx, recentGames, currentWeek);
  const recentStoryKeys = getRecentRecapStoryKeys(ctx, currentWeek);
  const sortedGames = selectedGames.map((entry) => entry.game);
  const gameStoryEntries = selectedGames.map((entry, idx) => {
    const awayScore = Number(entry.game.awayScore || 0);
    const homeScore = Number(entry.game.homeScore || 0);
    const winner = awayScore > homeScore ? entry.away : entry.home;
    const loser = awayScore > homeScore ? entry.home : entry.away;
    const winnerCoach = coachMentionFor(winner, ctx.teamCoachMentions);
    const loserCoach = coachMentionFor(loser, ctx.teamCoachMentions);
    const featuredYoung = awayScore > homeScore ? entry.awayYoung : entry.homeYoung;
    const scoreLine = `${Math.max(awayScore, homeScore)}-${Math.min(awayScore, homeScore)}`;
    const winnerStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
    const loserStanding = [...ctx.standings.entries()].find(([teamId]) => ctx.teams.get(teamId) === loser)?.[1];
    const prevWinnerStanding = [...ctx.prevStandings.entries()].find(([teamId]) => ctx.teams.get(teamId) === winner)?.[1];
    const prevLoserStanding = [...ctx.prevStandings.entries()].find(([teamId]) => ctx.teams.get(teamId) === loser)?.[1];
    const winnerDelta = recordScore(winnerStanding) - recordScore(prevWinnerStanding);
    const loserDelta = recordScore(loserStanding) - recordScore(prevLoserStanding);
    const upsetScore = (recordScore(loserStanding) - recordScore(winnerStanding));
    const collapseSignal = loserDelta <= -1 || entry.margin >= 14 || upsetScore >= 2;
    const riseSignal = winnerDelta >= 1 || entry.margin >= 14;
    const texture = describeGameTexture(entry);
    const winTemplates = [
      `${winnerCoach ? `${winnerCoach} watched ` : ''}${winner} beat ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}, and the bigger takeaway was the continued rise of ${featuredYoung?.name || winner}. ${featuredYoung ? 'Young production like that changes the shape of a week.' : texture}`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} came out of the week with one of the cleaner statements on the board, putting away ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. A result like that usually changes how the rest of the league talks about you.`,
      `${winnerCoach ? `${winnerCoach} and ` : ''}${winner} got the kind of win that travels, beating ${loserCoach ? `${loserCoach} and ` : ''}${loser} ${scoreLine}. ${entry.margin <= 7 ? texture : `The ${entry.margin}-point margin gave it extra weight.`}`,
    ];
    const lossTemplates = [
      `${loser} took the week’s roughest hit, falling ${scoreLine} to ${winner}. For a team already dealing with pressure, that was the kind of result that sticks.`,
      `${winner} did more than win ${scoreLine} over ${loser}; they shoved ${loser} deeper into a bad week. ${texture}`,
      `${loser} walked out of the week with more heat after a ${scoreLine} loss to ${winner}. Whether it was expectation, momentum, or timing, that result landed hard.`,
    ];
    const neutralTemplates = [
      `${winner} survived one of the tighter games on the board, getting past ${loser} ${scoreLine}. ${texture}`,
      `${winner} edged out ${loser} ${scoreLine} in one of the week’s cleaner coin-flip games.`,
      `${winner} found a way through ${loser} ${scoreLine}. ${texture}`,
    ];
    const emphasis = collapseSignal ? 'negative' : (riseSignal ? 'positive' : 'neutral');
    const text = pickTemplate(
      emphasis === 'negative' ? lossTemplates : emphasis === 'positive' ? winTemplates : neutralTemplates,
      currentWeek + idx + variantSeed,
    );
    const leadScore =
      (collapseSignal ? 18 : 0) +
      (riseSignal ? 12 : 0) +
      Math.min(16, entry.margin) +
      (featuredYoung ? 8 : 0) +
      Math.max(0, upsetScore * 6);
    return {
      entry,
      winner,
      loser,
      teams: [winner, loser],
      featuredYoung,
      emphasis,
      text,
      leadScore,
    };
  });

  const movers = [];
  for (const [teamId, standing] of ctx.standings.entries()) {
    const prev = ctx.prevStandings.get(teamId);
    if (!prev) continue;
    const delta = recordScore(standing) - recordScore(prev);
    if (delta !== 0) {
      movers.push({
        delta,
        text: `${ctx.teams.get(teamId)} moved from ${formatRecord(prev)} to ${formatRecord(standing)}.`,
      });
    }
  }

  const topPerformerEntries = ctx.top100.slice(0, 8).map((player) => ({
    team: player.team,
    text: `${player.name} gave ${player.team} a true feature performance with a ${formatGrade(player.grade)} grade. The line: ${formatStatLine(player)}.`,
    player,
  }));
  const roughPerformerEntries = ctx.top100
    .slice()
    .reverse()
    .filter((player) => isBadStatLine(player))
    .slice(0, 6)
    .map((player) => ({
      team: player.team,
      text: `${player.team} also had to wear a rough outing from ${player.name}. The line was hard to ignore: ${formatStatLine(player)}.`,
      player,
    }));

  const rumors = buildRumorMillItems(ctx, 10, { variantSeed });
  const profileFor = (team) => buildFranchiseProfile(ctx.franchiseProfileContext, team);

  const leadGameEntry = gameStoryEntries.slice().sort((a, b) => b.leadScore - a.leadScore)[0] || null;
  const leadGame = leadGameEntry?.entry?.game || null;
  const leadStory = leadGameEntry ? leadGameEntry.text : null;

  const notebookEntries = movers
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map((entry) => ({ team: ctx.teams.get([...ctx.standings.entries()].find(([teamId, standing]) => entry.text.includes(ctx.teams.get(teamId)))?.[0]), text: entry.text.replace(' moved from ', ' changed its footing from ') }));
  const rumorEntries = seededOrder(`rumor-entries:${currentWeek}:${variantSeed}`, rumors)
    .sort((a, b) => {
      const aRecent = recentStoryKeys.has(String(a?.key || '')) ? 1 : 0;
      const bRecent = recentStoryKeys.has(String(b?.key || '')) ? 1 : 0;
      if (aRecent !== bRecent) return aRecent - bRecent;
      return 0;
    })
    .map((item) => {
    const text = item?.text || '';
    const matchedTeams = [...ctx.teams.values()].filter((team) => String(text).includes(team));
    return { ...item, teams: matchedTeams, text };
  });
  const leadTeams = leadGameEntry?.teams || (leadGame ? [ctx.teams.get(Number(leadGame.awayTeamId)), ctx.teams.get(Number(leadGame.homeTeamId))].filter(Boolean) : []);
  const secondaryGamePool = seededOrder(`games:${currentWeek}:${variantSeed}`, gameStoryEntries.filter((story) => story !== leadGameEntry));
  const secondaryGameNotes = pickDistinctItems(
    secondaryGamePool,
    (story) => story.teams,
    new Set(leadTeams),
    2,
  ).map((story) => story.text).filter(Boolean);
  const notebook = pickDistinctItems(notebookEntries, (entry) => [entry.team], new Set(leadTeams), 2).map((entry) => entry.text);
  const featureEntry = pickDistinctItems(topPerformerEntries, (entry) => [entry.team], new Set([...leadTeams, ...notebookEntries.map((entry) => entry.team).filter(Boolean)]), 1)[0] || topPerformerEntries[0];
  const featurePlayer = featureEntry?.player || null;
  const roughEntry = pickDistinctItems(roughPerformerEntries, (entry) => [entry.team], new Set([...leadTeams, featurePlayer?.team].filter(Boolean)), 1)[0] || null;
  const stateTeams = [...new Set([...leadTeams, featurePlayer?.team, roughEntry?.team].filter(Boolean))];
  const franchiseProfiles = stateTeams
    .map((team) => profileFor(team))
    .filter(Boolean);
  const feature = featurePlayer
    ? pickTemplate([
      `${featurePlayer.name} was the cleanest feature piece on the board this week for ${featurePlayer.team}. A ${formatGrade(featurePlayer.grade)} grade backed it up, and the production matched the mark: ${formatStatLine(featurePlayer)}.`,
      `${featurePlayer.team} got a true star turn from ${featurePlayer.name}, who posted a ${formatGrade(featurePlayer.grade)} grade with a line that deserved the attention: ${formatStatLine(featurePlayer)}.`,
      `One performance that kept showing up in every conversation belonged to ${featurePlayer.name}. For ${featurePlayer.team}, the ${formatGrade(featurePlayer.grade)} grade and ${formatStatLine(featurePlayer)} line made him impossible to leave out of the week.`,
      `If the week needed an individual centerpiece, it was ${featurePlayer.name}. ${featurePlayer.team} got a ${formatGrade(featurePlayer.grade)} grade and a stat line that read loudly enough on its own: ${formatStatLine(featurePlayer)}.`,
      `${featurePlayer.name} ended up carrying one of the week’s clearest individual stories. The grade hit ${formatGrade(featurePlayer.grade)}, and ${featurePlayer.team} got every bit of the production: ${formatStatLine(featurePlayer)}.`,
    ], currentWeek + 11 + variantSeed)
    : null;
  const storylineEntries = pickDistinctCategoryItems(
    rumorEntries.filter((entry) => ['player_change', 'scouting', 'injury', 'trade_posture', 'identity', 'pressure', 'misc', 'trade'].includes(entry.category)),
    (entry) => entry.teams,
    new Set([...leadTeams, featurePlayer?.team, roughEntry?.team].filter(Boolean)),
    3,
  );
  const franchiseSummaryLines = summarizeFranchiseProfiles(franchiseProfiles).slice(0, 2);
  const franchiseStateParagraph = franchiseSummaryLines.length
    ? pickTemplate([
      `A couple front offices came out of the week looking easier to read. ${franchiseSummaryLines.join(' ')}`,
      `The week also sharpened a few roster reads. ${franchiseSummaryLines.join(' ')}`,
      `Away from the scores, a couple team-building angles also came into focus. ${franchiseSummaryLines.join(' ')}`,
    ], currentWeek + 13 + variantSeed)
    : null;
  const usedStorylineCategories = new Set(storylineEntries.map((entry) => entry.category).filter(Boolean));
  const watchEntries = pickDistinctCategoryItems(
    rumorEntries.filter((entry) => !storylineEntries.includes(entry) && !usedStorylineCategories.has(entry.category)),
    (entry) => entry.teams,
    new Set([...leadTeams, featurePlayer?.team, roughEntry?.team].filter(Boolean)),
    2,
  );
  const watchList = watchEntries.map((entry) => entry.text);
  const gameParagraph = secondaryGameNotes.length
    ? secondaryGameNotes.join(' ')
    : (gameStoryEntries.length ? gameStoryEntries.slice(0, 2).map((story) => story.text).join(' ') : null);
  const notebookParagraph = notebook.length
    ? pickTemplate([
      `Around the league, ${notebook.join(' ')}`,
      `${notebook.join(' ')} Those shifts gave the standings a little more shape coming out of the week.`,
      `Not every story came from the headline game. ${notebook.join(' ')}`,
    ], currentWeek + 3 + variantSeed)
    : null;
  const storylineParagraph = storylineEntries.length
    ? pickTemplate([
      `The week also pushed a few league conversations forward. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `Away from the scores, the week picked up a few more layers. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `The scoreboard was only part of it. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `Not all of the week’s movement showed up in the final scores. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
      `Around the league, the week had a little more texture than the box scores alone would say. ${storylineEntries.map((entry) => entry.text).join(' ')}`,
    ], currentWeek + 5 + variantSeed)
    : null;
  const draftParagraph = mockSignals.length
    ? pickTemplate([
      `The draft conversation also kept creeping into the week. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `Even with the current week still fresh, the mock draft lens is already shaping some of the talk around the league. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `A few front-office conversations are already drifting toward April. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `The latest mock draft also gave the week a little extra shape. ${mockSignals.map((signal) => signal.text).join(' ')}`,
      `Some of the week’s quieter talk was already pointing toward the next draft. ${mockSignals.map((signal) => signal.text).join(' ')}`,
    ], currentWeek + 9 + variantSeed)
    : null;
  const buzzParagraph = watchList.length
    ? pickTemplate([
      `${watchList.join(' ')}`,
      `A couple side stories also stuck to the week. ${watchList.join(' ')}`,
      `The week left some extra noise behind it too. ${watchList.join(' ')}`,
      `A few smaller threads are still hanging in the air coming out of this one. ${watchList.join(' ')}`,
      `There was still a little extra league buzz around the edges of the week. ${watchList.join(' ')}`,
    ], currentWeek + 7 + variantSeed)
    : null;
  const setbackParagraph = roughEntry?.text || null;
  const sections = [];
  const taggedLead = tagParagraphFirstMentions(leadStory, ctx.teamCoachMentions, ctx.teams.values());
  const taggedGames = tagParagraphFirstMentions(gameParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedNotebook = tagParagraphFirstMentions(notebookParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedStorylines = tagParagraphFirstMentions(storylineParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedFranchise = tagParagraphFirstMentions(franchiseStateParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedFeature = tagParagraphFirstMentions(feature, ctx.teamCoachMentions, ctx.teams.values());
  const taggedSetback = tagParagraphFirstMentions(setbackParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedBuzz = tagParagraphFirstMentions(buzzParagraph, ctx.teamCoachMentions, ctx.teams.values());
  const taggedDraft = tagParagraphFirstMentions(draftParagraph, ctx.teamCoachMentions, ctx.teams.values());

  if (taggedLead) sections.push(taggedLead);

  const recapBlocks = {
    intro_results: [phaseLanguage.recapIntro, taggedGames, taggedNotebook].filter(Boolean).join(' '),
    games_only: [taggedGames, taggedNotebook].filter(Boolean).join(' '),
    context: [taggedStorylines, taggedFranchise].filter(Boolean).join(' '),
    storylines: taggedStorylines,
    franchise: taggedFranchise,
    feature: [taggedFeature, taggedSetback].filter(Boolean).join(' '),
    feature_only: taggedFeature,
    setback_only: taggedSetback,
    buzz: taggedBuzz,
    draft: taggedDraft,
    close_mix: [taggedBuzz, taggedDraft].filter(Boolean).join(' '),
  };

  const availableKeys = Object.entries(recapBlocks)
    .filter(([, text]) => text)
    .map(([key]) => key);

  const articleShapes = [
    ['intro_results', 'context', 'feature', 'close_mix'],
    ['intro_results', 'feature', 'storylines', 'buzz'],
    ['games_only', 'context', 'feature_only', 'draft'],
    ['intro_results', 'franchise', 'storylines', 'feature'],
    ['games_only', 'feature', 'context'],
    ['intro_results', 'storylines', 'close_mix'],
  ];
  const viableShapes = articleShapes.filter((shape) => shape.every((key) => availableKeys.includes(key)));
  const chosenShape = viableShapes.length
    ? pickTemplate(viableShapes, currentWeek + availableKeys.length + variantSeed)
    : seededOrder(`recap-shape:${currentWeek}:${variantSeed}`, availableKeys.filter((key) => !['feature_only', 'setback_only', 'storylines', 'franchise', 'buzz', 'draft'].includes(key)));

  const used = new Set();
  for (const key of chosenShape) {
    const text = recapBlocks[key];
    if (!text || used.has(text)) continue;
    sections.push(text);
    used.add(text);
  }

  const optionalPool = seededOrder(`recap-optional:${currentWeek}:${variantSeed}`, ['storylines', 'franchise', 'feature_only', 'setback_only', 'buzz', 'draft']);
  const maxParagraphs = taggedLead ? 4 : 3;
  for (const key of optionalPool) {
    if (sections.length >= maxParagraphs) break;
    const text = recapBlocks[key];
    if (!text || used.has(text)) continue;
    if (key === 'draft' && seasonContext.phase === 'early_regular' && sections.length >= 4) continue;
    sections.push(text);
    used.add(text);
  }

  const paragraphs = sections.filter(Boolean);
  const usedStoryKeys = [...storylineEntries, ...watchEntries].map((entry) => entry?.key).filter(Boolean);
  saveRecapStoryKeysForWeek(ctx, currentWeek, usedStoryKeys);

  return {
    currentWeek,
    leadStory: taggedLead || 'No clean lead story was available for this week.',
    biggestWins: gameStoryEntries.map((story) => tagParagraphFirstMentions(story.text, ctx.teamCoachMentions, ctx.teams.values())),
    movers: movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4).map((entry) => entry.text),
    notebook,
    tradeDesk: [],
    topPerformers: topPerformerEntries.map((entry) => tagParagraphFirstMentions(entry.text, ctx.teamCoachMentions, ctx.teams.values())),
    feature: tagParagraphFirstMentions(feature, ctx.teamCoachMentions, ctx.teams.values()),
    watchList,
    rumors,
    paragraphs,
  };
}

export async function buildCommitteeReviewData(ctx) {
  const queue = Object.entries(ctx.activeTrades || {}).map(([tradeId, trade]) => ({ tradeId, ...trade }));
  const pendingCoach = queue.filter((trade) => trade.status === 'awaiting_coach_b');
  const pendingCommittee = queue.filter((trade) => trade.status === 'committee');
  const pendingProof = queue.filter((trade) => trade.status === 'approved_pending_proof');
  const proofEntries = Object.entries(ctx.pendingProofs || {}).map(([tradeId, proof]) => ({ tradeId, ...proof }));

  const strikeSeason = ensureStrikeSeason(
    ctx.fairsims || {},
    `year_${ctx.live?.seasonContext?.calendarYear || new Date().getFullYear()}`,
  );
  const strikeLeaders = Object.keys(strikeSeason.weightedCounts || {})
    .filter((key) => !String(key).startsWith('team:'))
    .sort((a, b) => weightedCount(strikeSeason, b) - weightedCount(strikeSeason, a))
    .slice(0, 5)
    .map((userId) => `<@${userId}>: ${weightedCount(strikeSeason, userId)}/5 • ${formatBreakdown(strikeSeason, userId)}`);

  const pendingThreads = Object.entries(ctx.threadState?.threads || {})
    .filter(([, info]) => info?.status === 'pending' && info?.deadlineAt)
    .map(([threadId, info]) => ({ threadId, ...info }));
  const atRisk = [];
  for (const thread of pendingThreads.slice(0, 12)) {
    const counts = await collectThreadParticipation(ctx.client, ctx.guild, thread);
    const msLeft = Number(thread.deadlineAt || 0) - Date.now();
    const hoursLeft = Math.max(0, Math.round(msLeft / 3600000));
    if (counts.awayCount === 0 || counts.homeCount === 0 || hoursLeft <= 24) {
      const quiet = counts.awayCount === 0 && counts.homeCount === 0
        ? 'both sides silent'
        : counts.awayCount === 0
          ? `${thread.awayTeam} silent`
          : counts.homeCount === 0
            ? `${thread.homeTeam} silent`
            : 'both sides talking but unresolved';
      atRisk.push(`<#${thread.threadId}> • ${thread.awayTeam} vs ${thread.homeTeam} • ${quiet} • ${hoursLeft}h left`);
    }
  }

  return {
    pendingCoach,
    pendingCommittee,
    pendingProof,
    proofEntries,
    strikeLeaders,
    atRisk: atRisk.slice(0, 6),
  };
}
