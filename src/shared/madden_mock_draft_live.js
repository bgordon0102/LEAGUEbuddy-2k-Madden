import fs from 'fs';
import path from 'path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { loadRoleMap } from '../madden/staff/staffUtils.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import {
  applyPickTrades,
  draftOrder,
  formatTeamEmoji,
  loadDraftClass,
  loadOfficialDraftOrderOverride,
  loadTeamEmojis,
  deriveTeamNeeds,
  prospectGroup,
} from '../madden/coach/mockdraft.js';

const STORE_FILE = path.join(process.cwd(), 'data', 'madden', 'mock_draft_sessions.json');
const MAX_SELECT_OPTIONS = 25;
const SESSION_MAX_IDLE_MS = 1000 * 60 * 60 * 6;

function seededRand(seedStr, salt, max) {
  const str = `${seedStr}|${salt}`;
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return max > 0 ? h % max : 0;
}

function premiumPositionValue(group) {
  const values = {
    QB: 10,
    OT: 8,
    EDGE: 8,
    CB: 7,
    WR: 7,
    IOL: 5,
    DT: 5,
    S: 5,
    LB: 4,
    TE: 2,
    RB: 1,
    BPA: 0,
  };
  return values[group] || 0;
}

function chooseVariantCandidate(scoredCandidates, seedStr, salt) {
  if (!Array.isArray(scoredCandidates) || !scoredCandidates.length) return null;
  const sorted = [...scoredCandidates].sort((a, b) => a.score - b.score || a.index - b.index);
  const bestScore = sorted[0].score;
  const pool = sorted
    .filter((entry, idx) => idx < 5 && entry.score <= bestScore + 16)
    .slice(0, 5);
  if (pool.length <= 1) return pool[0];
  const weights = [8, 5, 3, 2, 1].slice(0, pool.length);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let roll = seededRand(seedStr, salt, total);
  for (let idx = 0; idx < pool.length; idx += 1) {
    roll -= weights[idx];
    if (roll < 0) return pool[idx];
  }
  return pool[0];
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
}

function baseStore() {
  return {
    sessions: {},
  };
}

function loadStore() {
  ensureStoreDir();
  if (!fs.existsSync(STORE_FILE)) return baseStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...baseStore(), ...parsed } : baseStore();
  } catch {
    return baseStore();
  }
}

function saveStore(store) {
  ensureStoreDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function normalizeTeamKey(name = '') {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function currentDraftYear(league) {
  const currentCalendarYear = Number(
    league?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || league?.info?.calendarYear
    || league?.calendarYear
    || new Date().getFullYear()
  );
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  return weekType === 1 || weekType === 2 ? currentCalendarYear + 1 : currentCalendarYear;
}

function trimProspect(player, index) {
  const rank = Number(player.RNK ?? player.rank ?? player.order ?? index + 1);
  const position = String(player.position || player.position_1 || '').toUpperCase().trim();
  const school = player.school || player.College || player.college || 'N/A';
  return {
    id: `${rank}_${normalizeTeamKey(player.name || `player_${index}`)}_${normalizeTeamKey(position)}`,
    name: player.name || `Prospect ${index + 1}`,
    rank,
    position,
    school,
    overall: Number(player.overall ?? player.ovr ?? player.rating ?? player.OVR ?? 0),
  };
}

function findNeedsForTeam(teamName, needsMap, altName) {
  const variants = new Set([
    normalizeTeamKey(teamName),
    normalizeTeamKey(altName),
  ].filter(Boolean));
  const parts = String(teamName || '').split(/\s+/);
  if (parts.length) variants.add(normalizeTeamKey(parts[parts.length - 1]));
  for (const key of variants) {
    if (needsMap[key]) return needsMap[key];
  }
  for (const key of variants) {
    const entry = Object.entries(needsMap).find(([candidate]) => candidate.includes(key) || key.includes(candidate));
    if (entry) return entry[1];
  }
  return ['BPA'];
}

function normalizeCoachTeamName(name = '') {
  return normalizeTeamKey(String(name || '').replace(/ Coach$/, ''));
}

function teamAliasKeys(name = '', altName = '') {
  const aliases = new Set();
  const add = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return;
    aliases.add(normalizeTeamKey(raw));
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length) {
      aliases.add(normalizeTeamKey(parts[parts.length - 1]));
    }
  };
  add(name);
  add(altName);
  return [...aliases].filter(Boolean);
}

function participantLabel(participant) {
  const teamText = participant?.teamNames?.length ? ` • ${participant.teamNames.join(', ')}` : '';
  return `<@${participant.userId}>${teamText}`;
}

export function coachTeamsForMember(member) {
  const roleMap = loadRoleMap();
  const teamRoleMap = new Map(
    Object.entries(roleMap)
      .filter(([name, id]) => name.endsWith(' Coach') && id)
      .map(([name, id]) => [id, name.replace(/ Coach$/, '')]),
  );
  if (!member?.roles?.cache) return [];
  return [...member.roles.cache.keys()]
    .map((roleId) => teamRoleMap.get(roleId))
    .filter(Boolean);
}

function assignPickOwners(session) {
  const participants = session.participants || [];
  const pickOwners = {};
  if (!participants.length) return pickOwners;
  const teamControllers = new Map();
  for (const participant of participants) {
    for (const teamName of participant.teamNames || []) {
      for (const key of teamAliasKeys(normalizeCoachTeamName(teamName), teamName)) {
        if (!key || teamControllers.has(key)) continue;
        teamControllers.set(key, participant.userId);
      }
    }
  }
  for (let idx = 0; idx < session.order.length; idx += 1) {
    const slot = session.order[idx];
    const controller = teamAliasKeys(slot?.name || '', slot?.nick || '')
      .map((key) => teamControllers.get(key))
      .find(Boolean);
    if (controller) pickOwners[String(idx)] = controller;
  }
  return pickOwners;
}

function sessionLink(session) {
  if (!session.guildId || !session.channelId || !session.messageId) return null;
  return `https://discord.com/channels/${session.guildId}/${session.channelId}/${session.messageId}`;
}

function buildLobbyEmbed(session) {
  const embed = new EmbedBuilder()
    .setTitle(`Live Mock Draft Lobby • ${session.draftYear}`)
    .setColor(0x1e90ff)
    .setDescription('Join the room, then start a fast first-round mock. Coaches only control their own team picks, and the rest of the board auto-sims forward.')
    .addFields(
      { name: 'Host', value: `<@${session.hostId}>`, inline: true },
      { name: 'Participants', value: session.participants.length ? session.participants.map((p) => participantLabel(p)).join('\n') : 'No coaches joined yet.', inline: true },
      { name: 'Format', value: 'Round 1 only • current draft order • current class • your team pick only • auto-sim between live coach selections', inline: false },
    );
  if (session.startedAt) {
    embed.addFields({ name: 'Status', value: 'Already started.', inline: false });
  }
  return embed;
}

function topAvailableLines(session, limit = 8) {
  const emojiMap = loadTeamEmojis();
  return (session.availableProspects || []).slice(0, limit).map((prospect) => {
    const recent = session.picks.find((pick) => pick.prospectId === prospect.id);
    if (recent) return null;
    return `#${prospect.rank} ${prospect.name} (${prospect.position}, ${prospect.school})`;
  }).filter(Boolean);
}

function recentPickLines(session, limit = 6) {
  const emojiMap = loadTeamEmojis();
  return (session.picks || []).slice(-limit).reverse().map((pick) => {
    const emoji = formatTeamEmoji(pick.teamName, emojiMap);
    const grade = pick.userId !== 'auto' && pick.grade ? ` • ${pick.grade}` : '';
    const actor = pick.actorLabel || (pick.userId ? `<@${pick.userId}>` : 'Auto');
    return `${pick.pickNumber}. ${emoji ? `${emoji} ` : ''}${pick.teamName} — ${pick.prospectName} (${pick.position})${grade} by ${actor}`;
  });
}

export function buildMockDraftPickEmbed(session, pick) {
  const emojiMap = loadTeamEmojis();
  const emoji = formatTeamEmoji(pick?.teamName, emojiMap);
  const embed = new EmbedBuilder()
    .setTitle(`Pick ${pick?.pickNumber || '?'} • ${pick?.teamName || 'Unknown Team'}`)
    .setColor(0x5865f2)
    .setDescription(
      `${emoji ? `${emoji} ` : ''}${pick?.teamName || 'Unknown Team'} select **${pick?.prospectName || 'Unknown Player'}**`
      + `${pick?.position ? ` (${pick.position}` : ''}${pick?.school ? `, ${pick.school}` : ''}${pick?.position ? ')' : ''}.`
    );
  if (pick?.userId !== 'auto' && pick?.grade) {
    embed.addFields(
      { name: 'Grade', value: pick.grade, inline: true },
      { name: 'Review', value: pick?.synopsis || 'No review available.', inline: false },
    );
  }
  return embed;
}

export function buildMockDraftOnClockEmbed(session) {
  const pickIndex = Number(session.currentPickIndex || 0);
  const slot = session.order?.[pickIndex];
  const onClockUserId = session.pickOwners?.[String(pickIndex)] || null;
  const emojiMap = loadTeamEmojis();
  const emoji = slot ? formatTeamEmoji(slot.name, emojiMap) : '';
  return new EmbedBuilder()
    .setTitle(`On The Clock • Pick ${pickIndex + 1}`)
    .setColor(0xf39c12)
    .setDescription(
      slot
        ? `${emoji ? `${emoji} ` : ''}${slot.name} are on the clock.${onClockUserId ? ` <@${onClockUserId}> is up.` : ''}`
        : 'No active pick.'
    );
}

function buildLiveEmbed(session) {
  const pickIndex = Number(session.currentPickIndex || 0);
  const slot = session.order[pickIndex];
  const onClockUserId = slot ? session.pickOwners?.[String(pickIndex)] : null;
  const emojiMap = loadTeamEmojis();
  const currentTeamEmoji = slot ? formatTeamEmoji(slot.name, emojiMap) : '';
  const embed = new EmbedBuilder()
    .setTitle(`Live Mock Draft • Pick ${Math.min(pickIndex + 1, session.order.length)}/${session.order.length}`)
    .setColor(session.status === 'done' ? 0x2ecc71 : session.status === 'cancelled' ? 0x7f8c8d : 0xf39c12);

  if (session.status === 'done' || session.status === 'cancelled' || !slot) {
    embed.setDescription(session.status === 'cancelled' ? 'The live mock draft was cancelled.' : 'The live mock draft is complete.');
  } else {
    embed.setDescription(`${currentTeamEmoji ? `${currentTeamEmoji} ` : ''}${slot.name} is on the clock.\n${onClockUserId ? `GM: <@${onClockUserId}>` : 'Auto-sim slot'}`);
  }

  const topAvailable = topAvailableLines(session).join('\n') || 'No available prospects left.';
  const recentPicks = recentPickLines(session).join('\n') || 'No picks made yet.';
  const participantSummary = session.participants.length
    ? session.participants.map((p) => participantLabel(p)).join(', ')
    : 'No participants.';
  const nextControlledSlotIndex = session.status === 'live'
    ? session.order.findIndex((pick, idx) => idx >= pickIndex && session.pickOwners?.[String(idx)])
    : -1;
  const nextControlledText = nextControlledSlotIndex >= 0
    ? `${nextControlledSlotIndex + 1}. ${session.order[nextControlledSlotIndex].name}`
    : 'No coach-controlled first-round picks remain. The rest will auto-sim.';

  embed.addFields(
    { name: 'Participants', value: participantSummary, inline: false },
    { name: 'Flow', value: nextControlledText, inline: false },
    { name: 'Top Available', value: topAvailable, inline: false },
    { name: 'Recent Picks', value: recentPicks, inline: false },
  );
  return embed;
}

function buildLobbyComponents(session) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|start|${session.id}`).setLabel('Start Draft').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|invite|${session.id}`).setLabel('Invite Coaches').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|cancel|${session.id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildLiveComponents(session) {
  const done = session.status === 'done' || session.status === 'cancelled';
  const hasControlledPick = !!session.pickOwners?.[String(session.currentPickIndex)];
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|pick|${session.id}`).setLabel('Make My Pick').setStyle(ButtonStyle.Primary).setDisabled(done || !hasControlledPick),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|auto|${session.id}`).setLabel('Skip To Next Pick').setStyle(ButtonStyle.Secondary).setDisabled(done),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|myteams|${session.id}`).setLabel('My Team Picks').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|end|${session.id}`).setLabel(done ? 'Closed' : 'End Draft').setStyle(ButtonStyle.Danger).setDisabled(done),
    ),
  ];
}

export function buildMockDraftSessionMessage(session) {
  const embeds = [session.status === 'lobby' ? buildLobbyEmbed(session) : buildLiveEmbed(session)];
  const components = session.status === 'lobby' ? buildLobbyComponents(session) : buildLiveComponents(session);
  return { embeds, components };
}

export function buildMockDraftTickerMessage(session) {
  return {
    embeds: [session.status === 'lobby' ? buildLobbyEmbed(session) : buildLiveEmbed(session)],
    components: [],
  };
}

export function buildMockDraftHostPanel(session, inviteOptions = [], page = 0) {
  const embed = new EmbedBuilder()
    .setTitle('Mock Draft Host Panel')
    .setColor(0x5865f2)
    .setDescription(
      `${session.roomType === 'private' ? 'Private scouting-hub room ready' : 'Private room ready'}${sessionLink(session) ? `: ${sessionLink(session)}` : '.'}\n`
      + `${session.roomType === 'private'
        ? 'Use this panel to invite league coaches into the private scouting-hub room. The room carries the full live draft, including on-clock prompts and pick controls.'
        : 'Use this panel to invite league coaches privately.'}`
    )
    .addFields(
      { name: 'Room', value: session.channelId ? `<#${session.channelId}>` : 'Unavailable', inline: true },
      { name: 'Host', value: `<@${session.hostId}>`, inline: true },
      { name: 'Participants', value: session.participants.length ? session.participants.map((p) => participantLabel(p)).join('\n') : 'No coaches added yet.', inline: false },
      {
        name: 'How To Use It',
        value: session.roomType === 'private'
          ? '1. Press `Invite Coaches`\n2. Add the league coaches you want in the room\n3. Press `Start Draft`\n4. Coaches make picks inside the room when their team is up\n5. The room self-cleans after the mock ends'
          : '1. Press `Invite Coaches`\n2. Add the league coaches you want in the mock\n3. Press `Start Draft`',
        inline: false,
      },
    );
  const totalPages = Math.max(1, Math.ceil(inviteOptions.length / MAX_SELECT_OPTIONS));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const visibleOptions = inviteOptions.slice(
    safePage * MAX_SELECT_OPTIONS,
    (safePage + 1) * MAX_SELECT_OPTIONS,
  );

  embed.addFields({
    name: 'Invite Pool',
    value: inviteOptions.length
      ? `${inviteOptions.length} league coaches available${totalPages > 1 ? ` • Page ${safePage + 1}/${totalPages}` : ''}`
      : 'No league coaches found to invite. Check coach assignments/roles, then refresh with `Invite Coaches`.',
    inline: false,
  });

  const components = [];
  if (visibleOptions.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`madden_mockdraft_invite|${session.id}|${safePage}`)
          .setPlaceholder('Invite league coaches to the draft room')
          .setMinValues(1)
          .setMaxValues(Math.min(10, visibleOptions.length))
          .addOptions(visibleOptions),
      ),
    );
  }
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|invite_prev|${session.id}|${safePage}`)
          .setLabel('Prev Coaches')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|invite_next|${session.id}|${safePage}`)
          .setLabel('Next Coaches')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(safePage >= totalPages - 1),
      ),
    );
  }
  components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|invite|${session.id}`)
          .setLabel('Invite Coaches')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|start|${session.id}`)
          .setLabel('Start Draft')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(session.status !== 'lobby'),
      new ButtonBuilder()
        .setCustomId(`madden_mockdraft_live|cancel|${session.id}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    ),
  );
  return { embeds: [embed], components };
}

function autoPickProspect(session) {
  const slot = session.order[session.currentPickIndex];
  if (!slot) return session.availableProspects[0] || null;
  const needs = findNeedsForTeam(slot.name, session.teamNeeds || {}, slot.nick);
  const needSet = new Set((needs || []).slice(0, 4));
  const scoredCandidates = [];
  for (let idx = 0; idx < session.availableProspects.length; idx += 1) {
    if (idx > 26) break;
    const prospect = session.availableProspects[idx];
    const group = prospectGroup(prospect);
    const overall = Number(prospect.overall || 0);
    const needRank = needs.indexOf(group);
    const boardPenalty = idx * 6;
    const needBonus = needRank === 0 ? 26 : needRank === 1 ? 18 : needRank === 2 ? 11 : needRank === 3 ? 6 : 0;
    const premiumBonus = premiumPositionValue(group) * 2;
    const eliteBonus = overall >= 84 ? 14 : overall >= 80 ? 8 : 0;
    let score = boardPenalty - needBonus - premiumBonus - eliteBonus;
    if (needSet.has(group)) score -= 12;
    if (['RB', 'TE'].includes(group) && idx < 12 && overall < 84 && !needSet.has(group)) score += 20;
    score += seededRand(session.variantSeed || session.id, `${slot.name}|${session.currentPickIndex}|${prospect.name}`, 8);
    scoredCandidates.push({ index: idx, score, prospect });
  }
  const chosen = chooseVariantCandidate(
    scoredCandidates,
    session.variantSeed || session.id,
    `${slot.name}|pick_${session.currentPickIndex + 1}`,
  );
  return chosen?.prospect || session.availableProspects[0] || null;
}

function gradeLabelFromScore(score) {
  if (score >= 98) return 'A+';
  if (score >= 94) return 'A';
  if (score >= 90) return 'A-';
  if (score >= 87) return 'B+';
  if (score >= 83) return 'B';
  if (score >= 80) return 'B-';
  if (score >= 76) return 'C+';
  if (score >= 72) return 'C';
  if (score >= 68) return 'C-';
  if (score >= 64) return 'D+';
  if (score >= 60) return 'D';
  return 'F';
}

function buildPickSynopsis({ teamName, prospect, needRank, boardDelta, overall, group }) {
  const fitText =
    needRank === 0 ? 'a direct hit on their top need' :
    needRank === 1 ? 'a strong answer near the top of their board' :
    needRank === 2 ? 'a sensible need-based swing' :
    needRank >= 3 ? 'more of a secondary-need bet' :
    'more of a value-over-fit swing';
  const boardText =
    boardDelta >= 8 ? 'They got clear value versus where the board expected him to go.' :
    boardDelta >= 3 ? 'It comes in as a mild value pick against the board.' :
    boardDelta <= -8 ? 'It is a real reach compared with the current board.' :
    boardDelta <= -3 ? 'It is a little early versus the current board.' :
    'It lands about where the board says it should.';
  const talentText =
    overall >= 84 ? 'The talent level is obvious.' :
    overall >= 80 ? 'The overall profile is still strong enough to buy.' :
    premiumPositionValue(group) >= 7 ? 'The premium position helps the pick hold up.' :
    'The room will need the development curve to justify it.';
  return `${teamName} took ${prospect.name} as ${fitText} ${boardText} ${talentText}`.trim();
}

function evaluatePickGrade(session, slot, prospect) {
  const needs = findNeedsForTeam(slot.name, session.teamNeeds || {}, slot.nick);
  const group = prospectGroup(prospect);
  const needRank = Math.max(-1, needs.indexOf(group));
  const boardExpectation = Number(session.currentPickIndex || 0) + 1;
  const boardRank = Number(prospect.rank || boardExpectation);
  const boardDelta = boardRank - boardExpectation;
  const overall = Number(prospect.overall || 0);

  let score = 78;
  if (needRank === 0) score += 14;
  else if (needRank === 1) score += 10;
  else if (needRank === 2) score += 6;
  else if (needRank >= 3) score += 2;
  else score -= 4;

  if (boardDelta >= 12) score += 12;
  else if (boardDelta >= 7) score += 9;
  else if (boardDelta >= 3) score += 5;
  else if (boardDelta >= 1) score += 2;
  else if (boardDelta <= -12) score -= 18;
  else if (boardDelta <= -7) score -= 12;
  else if (boardDelta <= -3) score -= 7;
  else if (boardDelta <= -1) score -= 3;

  score += Math.min(8, premiumPositionValue(group));
  if (overall >= 86) score += 6;
  else if (overall >= 82) score += 4;
  else if (overall >= 78) score += 2;
  else if (overall <= 72) score -= 5;

  if (['RB', 'TE'].includes(group) && boardExpectation <= 16 && needRank > 0) score -= 5;
  if (group === 'QB' && needRank === -1) score -= 10;
  if (group === 'QB' && needRank === 0) score += 6;

  score = Math.max(45, Math.min(99, score));
  return {
    score,
    grade: gradeLabelFromScore(score),
    synopsis: buildPickSynopsis({ teamName: slot.name, prospect, needRank, boardDelta, overall, group }),
  };
}

function applyPick(session, userId, prospect) {
  const currentPickIndex = Number(session.currentPickIndex || 0);
  const slot = session.order[currentPickIndex];
  if (!slot || !prospect) return session;
  const isCpuPick = userId === 'auto';
  const review = isCpuPick ? null : evaluatePickGrade(session, slot, prospect);
  session.availableProspects = session.availableProspects.filter((item) => item.id !== prospect.id);
  session.picks.push({
    pickNumber: currentPickIndex + 1,
    teamName: slot.name,
    teamNick: slot.nick,
    via: slot.via || null,
    userId,
    prospectId: prospect.id,
    prospectName: prospect.name,
    position: prospect.position,
    school: prospect.school,
    grade: review?.grade || null,
    gradeScore: review?.score || null,
    synopsis: review?.synopsis || null,
    actorLabel: userId === 'auto' ? 'Auto' : `<@${userId}>`,
    madeAt: Date.now(),
  });
  session.currentPickIndex = currentPickIndex + 1;
  if (session.currentPickIndex >= session.order.length) {
    session.status = 'done';
    session.completedAt = Date.now();
  }
  return session;
}

export function listUserAssignedSlots(session, userId) {
  const items = [];
  for (let idx = 0; idx < session.order.length; idx += 1) {
    if (session.pickOwners?.[String(idx)] !== userId) continue;
    const slot = session.order[idx];
    const made = session.picks.find((pick) => pick.pickNumber === idx + 1);
    items.push({
      pickNumber: idx + 1,
      teamName: slot.name,
      status: made ? `${made.prospectName} (${made.position})` : 'Still open',
    });
  }
  return items;
}

export function buildPickMenu(session) {
  const options = (session.availableProspects || []).slice(0, MAX_SELECT_OPTIONS).map((prospect) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(`#${prospect.rank} ${prospect.name}`.slice(0, 100))
      .setDescription(`${prospect.position} • ${prospect.school}`.slice(0, 100))
      .setValue(prospect.id),
  );
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`madden_mockdraft_pick|${session.id}`)
      .setPlaceholder('Choose a prospect from the top of the board')
      .addOptions(options),
  );
  return [row];
}

export function getMockDraftSession(sessionId) {
  return loadStore().sessions?.[sessionId] || null;
}

export async function syncMockDraftSessionMessage(client, session) {
  if (!session?.channelId || !session?.messageId) return;
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  if (!channel?.messages?.fetch) return;
  const message = await channel.messages.fetch(session.messageId).catch(() => null);
  if (!message) return;
  const payload = session.roomType === 'private_inline'
    ? buildMockDraftTickerMessage(session)
    : buildMockDraftSessionMessage(session);
  await message.edit(payload).catch(() => null);
}

export function createMockDraftSession({ guildId, channelId, hostId }) {
  return createMockDraftSessionWithRoom({ guildId, channelId, hostId, roomType: 'private_inline', originalChannelId: channelId });
}

export function createMockDraftSessionWithRoom({ guildId, channelId, hostId, roomType = 'private_inline', originalChannelId = channelId }) {
  const leagueId = resolveLeagueIdWithConfig(guildId);
  const league = leagueId ? loadLeagueSnapshot(leagueId) : null;
  if (!league) throw new Error('League snapshot is not ready.');
  const draftYear = currentDraftYear(league);
  const officialOrder = loadOfficialDraftOrderOverride(league, draftYear);
  const rawOrder = officialOrder || draftOrder(league);
  const order = (officialOrder || applyPickTrades(rawOrder, draftYear)).slice(0, 32);
  const prospects = loadDraftClass().map(trimProspect);
  if (!prospects.length) throw new Error('Draft class is not loaded.');

  const session = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    guildId,
    channelId,
    originalChannelId,
    hostId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    draftYear,
    roomType,
    status: 'lobby',
    participants: [{ userId: hostId, joinedAt: Date.now(), teamNames: [] }],
    variantSeed: `${hostId}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`,
    order,
    availableProspects: prospects,
    teamNeeds: deriveTeamNeeds(league),
    picks: [],
    currentPickIndex: 0,
    pickOwners: {},
    tickerActive: false,
    leagueId,
  };
  const store = loadStore();
  store.sessions[session.id] = session;
  saveStore(store);
  return session;
}

export function findActiveMockDraftSession(guildId, channelId) {
  const store = loadStore();
  return Object.values(store.sessions || {}).find((session) =>
    session.guildId === guildId
    && (session.channelId === channelId || session.originalChannelId === channelId)
    && session.status !== 'done'
    && session.status !== 'cancelled'
    && (Date.now() - Number(session.updatedAt || session.createdAt || 0)) < SESSION_MAX_IDLE_MS
  ) || null;
}

export function updateMockDraftSession(sessionId, mutator) {
  const store = loadStore();
  const session = store.sessions?.[sessionId];
  if (!session) return null;
  const nextSession = mutator(session) || session;
  nextSession.updatedAt = Date.now();
  store.sessions[sessionId] = nextSession;
  saveStore(store);
  return nextSession;
}

export function joinMockDraftSession(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.status !== 'lobby') throw new Error('This mock draft has already started.');
    if (!session.participants.find((entry) => entry.userId === userId)) {
      session.participants.push({ userId, joinedAt: Date.now(), teamNames: [] });
    }
    return session;
  });
}

export function setMockDraftParticipantTeams(sessionId, userId, teamNames = []) {
  return updateMockDraftSession(sessionId, (session) => {
    const participant = session.participants.find((entry) => entry.userId === userId);
    if (!participant) return session;
    participant.teamNames = [...new Set((teamNames || []).filter(Boolean))];
    return session;
  });
}

export function leaveMockDraftSession(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.status !== 'lobby') throw new Error('You can only leave while the mock is still in the lobby.');
    if (session.hostId === userId) throw new Error('The host should cancel the draft or start it.');
    session.participants = session.participants.filter((entry) => entry.userId !== userId);
    return session;
  });
}

export function startMockDraftSession(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.hostId !== userId) throw new Error('Only the host can start this mock draft.');
    if (session.status !== 'lobby') throw new Error('This mock draft has already started.');
    session.status = 'live';
    session.startedAt = Date.now();
    session.pickOwners = assignPickOwners(session);
    return session;
  });
}

export function cancelMockDraftSession(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.hostId !== userId) throw new Error('Only the host can cancel this mock draft.');
    session.status = 'cancelled';
    session.completedAt = Date.now();
    return session;
  });
}

export function endMockDraftSession(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.hostId !== userId) throw new Error('Only the host can end this mock draft.');
    session.status = 'done';
    session.completedAt = Date.now();
    return session;
  });
}

export function makeMockDraftPick(sessionId, userId, prospectId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.status !== 'live') throw new Error('This mock draft is not live yet.');
    const currentOwner = session.pickOwners?.[String(session.currentPickIndex)];
    if (currentOwner !== userId) throw new Error('It is not your pick right now.');
    const prospect = session.availableProspects.find((item) => item.id === prospectId);
    if (!prospect) throw new Error('That prospect is no longer available.');
    return applyPick(session, userId, prospect);
  });
}

export function autoPickMockDraft(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.status !== 'live') throw new Error('This mock draft is not live yet.');
    const currentOwner = session.pickOwners?.[String(session.currentPickIndex)];
    if (currentOwner !== userId && session.hostId !== userId) {
      throw new Error('Only the on-clock GM or the host can auto-pick this slot.');
    }
    const prospect = autoPickProspect(session);
    if (!prospect) throw new Error('No prospects are available.');
    const effectiveUserId = currentOwner || userId;
    return applyPick(session, effectiveUserId === session.hostId ? 'auto' : effectiveUserId, prospect);
  });
}

export function setMockDraftTickerActive(sessionId, active) {
  return updateMockDraftSession(sessionId, (session) => {
    session.tickerActive = !!active;
    return session;
  });
}

export function deleteMockDraftSession(sessionId) {
  const store = loadStore();
  if (!store.sessions?.[sessionId]) return false;
  delete store.sessions[sessionId];
  saveStore(store);
  return true;
}

export { sessionLink };
