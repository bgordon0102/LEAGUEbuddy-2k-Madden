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
const AVP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_avp.json');
const MAX_SELECT_OPTIONS = 25;
const SESSION_MAX_IDLE_MS = 1000 * 60 * 60 * 6;

function loadAvpStore() {
  try {
    if (!fs.existsSync(AVP_FILE)) return null;
    const raw = fs.readFileSync(AVP_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

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

function buildNeedsContext(session, slot, prospectGroupName) {
  const needs = findNeedsForTeam(slot?.name, session?.teamNeeds || {}, slot?.nick);
  const needRank = Math.max(-1, needs.indexOf(prospectGroupName));
  const topNeeds = (needs || []).slice(0, 3);
  const isTopNeed = needRank === 0;
  const isInTopNeeds = needRank >= 0 && needRank <= 2;
  const isOffNeed = needRank === -1;
  return {
    needs,
    needRank,
    topNeeds,
    isTopNeed,
    isInTopNeeds,
    isOffNeed,
  };
}

function extractTeamStrengths(league) {
  // Snapshot roster-driven strength signals per team.
  // Keep it compact and safe for JSON persistence.
  const teamInfo = league?.teams?.leagueTeamInfoList || [];
  const rosters = league?.rosters?.teams || {};

  const getTeamName = (t) => (
    t?.displayName
    || `${t?.cityName || ''} ${t?.nickName || ''}`.trim()
    || t?.nickName
    || `Team ${t?.teamId}`
  );

  const getMetricOvr = (p) => Number(
    p?.playerBestOvr
    ?? p?.teamSchemeOvr
    ?? p?.overallRating
    ?? p?.playerSchemeOvr
    ?? p?.ovr
    ?? p?.overall
    ?? 0
  ) || 0;

  const strengths = {};
  for (const t of teamInfo) {
    const teamId = Number(t?.teamId);
    if (!Number.isFinite(teamId)) continue;
    const roster = rosters?.[teamId] || rosters?.[String(teamId)] || {};
    const players = roster?.rosterInfoList || [];

    const positionGroup = (pos = '') => {
      const p = String(pos || '').toUpperCase();
      if (p === 'QB') return 'QB';
      if (['LT', 'RT'].includes(p)) return 'OT';
      if (['LG', 'C', 'RG'].includes(p)) return 'IOL';
      if (p.includes('EDGE') || ['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'LEDGE', 'REDGE', 'DE', 'RDE', 'LDE'].includes(p)) return 'EDGE';
      if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(p)) return 'DT';
      if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(p)) return 'LB';
      if (p === 'CB') return 'CB';
      if (['FS', 'SS'].includes(p)) return 'S';
      if (p === 'WR') return 'WR';
      if (p === 'TE') return 'TE';
      if (['HB', 'RB', 'FB'].includes(p)) return 'RB';
      return 'OTHER';
    };

    const groupTop = (group, n = 2) => players
      .filter((p) => positionGroup(p?.position) === group)
      .map((p) => ({
        ovr: getMetricOvr(p),
        age: Number(p?.age ?? p?.playerAge ?? 0) || 0,
        yearsLeft: Number(p?.contractYearsLeft ?? p?.contractLength ?? 0) || 0,
      }))
      .sort((a, b) => b.ovr - a.ovr)
      .slice(0, n);

    const qbs = players
      .filter((p) => String(p?.position || '').toUpperCase() === 'QB')
      .map((p) => ({
        ovr: getMetricOvr(p),
        age: Number(p?.age ?? p?.playerAge ?? 0) || 0,
        yearsPro: Number(p?.yearsPro ?? p?.experience ?? p?.playerExperience ?? p?.playerYearsPro ?? 0) || 0,
        yearsLeft: Number(p?.contractYearsLeft ?? p?.contractLength ?? 0) || 0,
      }))
      .sort((a, b) => b.ovr - a.ovr);

    const key = normalizeTeamKey(getTeamName(t));
    strengths[key] = {
      qb: {
        starterOvr: qbs[0]?.ovr ?? 0,
        backupOvr: qbs[1]?.ovr ?? 0,
        count: qbs.length,
        starterAge: qbs[0]?.age ?? 0,
        starterYearsLeft: qbs[0]?.yearsLeft ?? 0,
      },
      groups: {
        OT: groupTop('OT'),
        IOL: groupTop('IOL'),
        EDGE: groupTop('EDGE'),
        DT: groupTop('DT'),
        LB: groupTop('LB'),
        CB: groupTop('CB'),
        S: groupTop('S'),
        WR: groupTop('WR'),
        TE: groupTop('TE'),
        RB: groupTop('RB'),
      },
    };
  }
  return strengths;
}

function getTeamStrength(session, teamName, altName = '') {
  const map = session?.teamStrengths || {};
  const keys = teamAliasKeys(teamName, altName);
  for (const k of keys) {
    if (map[k]) return map[k];
  }
  return null;
}

function strengthVerdict(session, teamName, group) {
  // Conservative thresholds: only call "strength" when the room is clearly stable.
  const st = getTeamStrength(session, teamName);
  if (!st) return { strong: false, detail: null };

  if (group === 'QB') {
    const qb = st?.qb;
    if (!qb) return { strong: false, detail: null };
    const strongStarter = qb.starterOvr >= 84 && qb.starterYearsLeft >= 2 && qb.starterAge <= 33;
    const stableStarter = qb.starterOvr >= 82 && qb.starterYearsLeft >= 1 && qb.starterAge <= 34;
    const hasBackup = qb.count >= 2 && qb.backupOvr >= 70;
    const strong = strongStarter || (stableStarter && hasBackup);
    const detail = strong
      ? `They’re already set at QB (starter ${qb.starterOvr} OVR, ${qb.starterYearsLeft} yrs left${hasBackup ? `, backup ${qb.backupOvr}` : ''}).`
      : null;
    return { strong, detail };
  }

  const top = st?.groups?.[group];
  if (!Array.isArray(top) || !top.length) return { strong: false, detail: null };
  const top1 = top[0] || { ovr: 0, yearsLeft: 0 };
  const top2 = top[1] || { ovr: 0, yearsLeft: 0 };
  const starter = top1.ovr >= 84 && top1.yearsLeft >= 1;
  const strong2 = top2.ovr >= 80 && top2.yearsLeft >= 1;
  const solid2 = top2.ovr >= 77 && top2.yearsLeft >= 1;

  // Depth expectations by group.
  let strong = false;
  if (group === 'WR' || group === 'CB') {
    // Need two legit starters to call it a strength.
    strong = starter && solid2;
  } else if (group === 'OT' || group === 'IOL' || group === 'EDGE' || group === 'DT') {
    // Trenches: one strong starter is enough to not be "screaming", but call it strength only with a strong #2.
    strong = starter && strong2;
  } else if (group === 'S' || group === 'LB') {
    strong = starter && solid2;
  } else if (group === 'TE' || group === 'RB') {
    // Skill non-premium: only call it strength if the starter is clearly above average.
    strong = top1.ovr >= 86 && top1.yearsLeft >= 1;
  }

  const detail = strong
    ? `${group} wasn’t a fire-drill (top ${group}: ${top1.ovr}${top2?.ovr ? ` / ${top2.ovr}` : ''} OVR).`
    : null;
  return { strong, detail };
}

function isStrongAtPosition(session, teamName, group) {
  // Prefer roster-driven strength if present; fall back to needs heuristics.
  const verdict = strengthVerdict(session, teamName, group);
  if (verdict.strong) return true;

  const needs = findNeedsForTeam(teamName, session?.teamNeeds || {}, null);
  const idx = (needs || []).indexOf(group);
  if (group === 'QB') return idx === -1;
  return idx === -1 || idx >= 4;
}

function seededPickOne(seedStr, salt, arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[seededRand(seedStr, salt, arr.length)];
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
    .setDescription('This is a fast first-round mock. Coaches only control their own team picks, and the rest of the board auto-sims forward.')
    .addFields(
      { name: 'Host', value: `<@${session.hostId}>`, inline: true },
      { name: 'Participants', value: session.participants.length ? session.participants.map((p) => participantLabel(p)).join('\n') : 'No coaches joined yet.', inline: true },
      { name: 'Format', value: 'Round 1 only • current draft order • current class • your team pick only • auto-sim between live coach selections', inline: false },
      { name: 'Controls', value: 'Only the host can start or cancel the draft. Invited coaches just need to be in the room before the draft starts.', inline: false },
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
  if (!session || !pick) {
    return new EmbedBuilder()
      .setTitle('Pick Failed')
      .setColor(0xe74c3c)
      .setDescription('Pick failed: session or pick is not defined.');
  }
  const emojiMap = loadTeamEmojis();
  const emoji = formatTeamEmoji(pick?.teamName, emojiMap);

  const headline = `${emoji ? `${emoji} ` : ''}${pick.teamName} select **${pick.prospectName}**`;
  const details = [
    pick.position ? `**Pos:** ${pick.position}` : null,
    pick.school ? `**School:** ${pick.school}` : null,
    typeof pick.via === 'string' && pick.via ? `**Via:** ${pick.via}` : null,
    pick.actorLabel ? `**GM:** ${pick.actorLabel}` : (pick.userId ? `**GM:** <@${pick.userId}>` : null),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(`Pick ${pick.pickNumber} • ${pick.teamName}`)
    .setColor(0x5865f2)
    .setDescription([headline, details.length ? details.join(' • ') : null].filter(Boolean).join('\n'));

  if (pick.userId !== 'auto' && pick.grade) {
    embed.addFields({ name: 'Grade', value: pick.grade, inline: true });
    if (pick.gradeScore != null) {
      embed.addFields({ name: 'Score', value: String(pick.gradeScore), inline: true });
    }
    embed.addFields({ name: 'Review', value: pick.synopsis || 'No review available.', inline: false });
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
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|start|${session.id}`).setLabel('Host Start Draft').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|invite|${session.id}`).setLabel('Invite Coaches').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`madden_mockdraft_live|cancel|${session.id}`).setLabel('Host Cancel Draft').setStyle(ButtonStyle.Danger),
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
  if (score >= 55) return 'D';
  return 'F';
}

function normalizeProspectIdForAvp(id) {
  if (!id) return null;
  const raw = String(id);
  // Session ids often look like: "2_jamesrodriquez_sam" (rank_prefix + name + pos)
  // AVP keys are generated like:  "jamesrodriquez_SAM" (name + POS)
  const m = raw.match(/^(?:\d+_)?(.+?)_([A-Za-z0-9]+)$/);
  if (!m) return raw;
  const namePart = m[1].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const posPart = String(m[2]).toUpperCase();
  return `${namePart}_${posPart}`;
}

function avpForProspect(session, prospect) {
  // AVP is loaded once per call-site (menu + grade). Don't crash grading if file is missing.
  const avpStore = session?.__avpStore || loadAvpStore();
  if (session && !session.__avpStore) session.__avpStore = avpStore;
  if (!avpStore?.prospects || !prospect) return null;

  const direct = avpStore.prospects?.[prospect.id]?.avp;
  if (direct != null) return direct;

  const normalizedId = normalizeProspectIdForAvp(prospect.id);
  const normalized = normalizedId ? avpStore.prospects?.[normalizedId]?.avp : null;
  if (normalized != null) return normalized;

  const legacyKey = prospect?.name && prospect?.position
    ? `${String(prospect.name).replace(/[^a-z0-9]/gi, '').toLowerCase()}_${String(prospect.position).toUpperCase()}`
    : null;
  return legacyKey ? avpStore.prospects?.[legacyKey]?.avp ?? null : null;
}

function buildPickSynopsis({ teamName, prospect, needRank, boardDelta, overall, group, session = null, avpDelta = null, avp = null }) {
  const fitText =
    needRank === 0 ? 'a direct hit on their top need' :
      needRank === 1 ? 'a strong answer near the top of their board' :
        needRank === 2 ? 'a sensible need-based swing' :
          needRank >= 3 ? 'more of a secondary-need bet' :
            'more of a value-over-fit swing';
  const delta = avpDelta != null ? Number(avpDelta) : Number(boardDelta || 0);
  // delta = expectedPick - actualPick
  // positive => picked earlier than expected (reach)
  // negative => picked later than expected (value/steal)
  const tier =
    delta <= -14 ? 'steal' :
      delta <= -8 ? 'value' :
        delta <= -3 ? 'mild_value' :
          delta >= 14 ? 'major_reach' :
            delta >= 8 ? 'reach' :
              delta >= 3 ? 'mild_reach' :
                'as_expected';

  const absDelta = Math.abs(Number(delta || 0));
  // delta = expectedPick - actualPick
  // positive: player was expected later, so taking him now is EARLY
  // negative: player was expected earlier, so getting him now is LATE
  const spotsText =
    absDelta >= 2
      ? delta > 0
        ? `(about ${Number(absDelta.toFixed(1))} spots earlier than expected)`
        : `(about ${Number(absDelta.toFixed(1))} spots later than expected)`
      : '';

  const consensusLabel = avp != null ? `market (AVP ${Number(avp).toFixed(1)})` : 'board expectation';

  const valueText =
    tier === 'steal' ? `Steal vs ${consensusLabel}` :
      tier === 'value' ? `Value vs ${consensusLabel}` :
        tier === 'mild_value' ? `Slight value vs ${consensusLabel}` :
          tier === 'major_reach' ? `Massive reach vs ${consensusLabel}` :
            tier === 'reach' ? `Reach vs ${consensusLabel}` :
              tier === 'mild_reach' ? `Slight reach vs ${consensusLabel}` :
                (avp != null ? `In range (AVP ${Number(avp).toFixed(1)})` : 'In range');

  const eliteTier =
    overall >= 90 ? 'generational' :
      overall >= 86 ? 'elite' :
        overall >= 82 ? 'high' :
          overall >= 78 ? 'solid' :
            overall >= 74 ? 'ok' :
              'low';

  const isTopBoardPlayer = Number(prospect?.rank || 999) === 1;
  const isPremium = premiumPositionValue(group) >= 7;

  const needsCtx = session ? buildNeedsContext(session, { name: teamName }, group) : null;
  const strongVerdict = session ? strengthVerdict(session, teamName, group) : { strong: false, detail: null };
  const strongAtPos = session ? (strongVerdict?.strong || isStrongAtPosition(session, teamName, group)) : false;
  const offNeedStrength = strongAtPos && (needsCtx?.isOffNeed ?? (needRank === -1));

  function findBestPremiumStillOnBoard() {
    if (!session || !Array.isArray(session.availableProspects)) return [];
    const pool = session.availableProspects
      .filter((p) => p && p.id !== prospect?.id)
      .map((p) => {
        const g = prospectGroup(p);
        return {
          id: p.id,
          name: p.name,
          rank: Number(p.rank || 999),
          group: g,
          position: p.position,
          premium: premiumPositionValue(g),
        };
      })
      .filter((p) => p.premium >= 7)
      .sort((a, b) => (a.rank - b.rank) || (b.premium - a.premium));

    // Return up to 2 best premium names (keeps blurbs tight)
    return pool.slice(0, 2);
  }

  const talentText =
    eliteTier === 'generational' ? 'Franchise-caliber talent at the top of the class.' :
      eliteTier === 'elite' ? 'Legit elite talent—difference-maker profile.' :
        eliteTier === 'high' ? 'High-end profile with starter traits.' :
          eliteTier === 'solid' ? 'Solid overall profile if the development hits.' :
            premiumPositionValue(group) >= 7 ? 'The position value keeps it from being a total disaster.' :
              'Development curve will need to justify it.';

  // RB/TE in the top half of round 1 is usually bad process unless it's a true blue-chip AND a clear need.
  const earlyRBSmellTest = ['RB', 'TE'].includes(group);
  const earlySkillPenaltyText =
    earlyRBSmellTest
      ? 'RB/TE this early is usually bad process unless it’s a true blue-chip and a top need.'
      : null;

  const topBoardProcessText =
    isTopBoardPlayer
      ? `Process: taking the top player on the board is a clean, high-floor decision.`
      : null;

  const valueRegardlessOfNeedText =
    !isTopBoardPlayer && delta <= -10
      ? `Process: a fall like this can justify value over perfect need.`
      : null;

  const passOnPremiumValueText =
    (() => {
      if (isPremium) return null;
      if (!(tier === 'as_expected' || tier === 'mild_reach' || tier === 'reach' || tier === 'major_reach')) return null;
      const best = findBestPremiumStillOnBoard();
      if (!best.length) return 'Passing on premium-position talent for a lower-value slot raises the bar for the outcome.';
      const names = best.map((p) => `${p.name} (#${p.rank} ${p.group})`).join(' or ');
      return `Passing on premium-position talent (${names}) for a lower-value slot raises the bar for the outcome.`;
    })();
  // Find positional rank
  let posRank = 1;
  if (prospect && session && Array.isArray(session.availableProspects)) {
    const samePos = session.availableProspects.filter((p) => p.position === prospect.position);
    posRank = samePos.findIndex((p) => p.id === prospect.id) + 1;
    if (posRank < 1) posRank = 1;
  }
  // Board rank
  const boardRank = prospect.rank || 1;

  const severity =
    tier === 'major_reach' ? 'ugly' :
      tier === 'reach' ? 'bad' :
        tier === 'mild_reach' ? 'shaky' :
          tier === 'steal' ? 'great' :
            tier === 'value' ? 'good' :
              tier === 'mild_value' ? 'fine' :
                'neutral';

  const headline =
    severity === 'ugly' ? 'This is a rough one.' :
      severity === 'bad' ? 'This one’s hard to love.' :
        severity === 'shaky' ? 'There’s some risk baked in.' :
          severity === 'great' ? 'That’s a steal.' :
            severity === 'good' ? 'Good value.' :
              severity === 'fine' ? 'Solid value.' :
                'Solid process.';

  const boardLine = `#${boardRank} overall (No. ${posRank} ${group})`;
  const consensusLine = avp != null ? `AVP ${Number(avp).toFixed(1)}` : null;
  const valueLine = `${valueText}${spotsText ? ` ${spotsText}` : ''}`;

  const processClose =
    tier === 'major_reach'
      ? 'That’s a lot of draft capital to spend for a player the room expects much later.'
      : tier === 'reach'
        ? 'They’re paying a premium here, and the margin for error shrinks fast.'
        : tier === 'mild_reach'
          ? 'It’s a touch aggressive, so the pick needs to hit early.'
          : tier === 'steal'
            ? 'When someone falls like this, you take the value and figure out the fit later.'
            : tier === 'value'
              ? 'When the board gives you value like this, you take it.'
              : tier === 'mild_value'
                ? 'Solid value without overthinking it.'
                : 'It’s a straightforward selection if the evaluation is right.';

  const needReachCallout =
    (needRank >= 0 && (tier === 'reach' || tier === 'major_reach'))
      ? 'Even if it fills a real need, overdrafting here is how you lose value at the top of the round.'
      : null;

  const strengthWarning =
    offNeedStrength
      ? seededPickOne(session?.variantSeed || session?.id || 'seed', `strength:${teamName}:${group}:${prospect?.name}`, [
        strongVerdict?.detail || null,
        `This is a luxury pick at a spot that wasn’t screaming for help.`,
        `The roster was already stable at ${group}, so the value has to be undeniable to justify it.`,
        `They’re drafting into a room that already looks "fine," which makes the opportunity cost sting.`,
        `It’s hard to sell taking ${group} when the bigger holes are still sitting on the board.`,
      ].filter(Boolean))
      : null;

  const qbStrengthWarning =
    group === 'QB' && offNeedStrength
      ? seededPickOne(session?.variantSeed || session?.id || 'seed', `qb_strength:${teamName}:${prospect?.name}`, [
        strongVerdict?.detail || null,
        `With the starter situation not looking desperate, this feels like a misuse of premium capital.`,
        `If you already trust your QB, spending a first-rounder here is how you fall behind building the rest of the roster.`,
        `Unless the plan is a long-term reset, doubling down at quarterback right now is a questionable use of resources.`,
      ].filter(Boolean))
      : null;

  // Keep to 2 max for readability.
  const notes = [
    topBoardProcessText,
    valueRegardlessOfNeedText,
    passOnPremiumValueText,
    earlySkillPenaltyText,
    qbStrengthWarning,
    strengthWarning,
  ].filter(Boolean).slice(0, 2);

  const noteText = notes.length
    ? ` ${notes
      .map((n) => String(n).trim().replace(/\s+/g, ' '))
      .map((n) => (/[.!?]$/.test(n) ? n : `${n}.`))
      .join(' ')}`
    : '';

  const fitClause =
    tier === 'major_reach'
      ? `It lines up as ${fitText}, but it’s a major overdraft.`
      : tier === 'reach'
        ? `It lines up as ${fitText}, but it’s an overdraft.`
        : tier === 'mild_reach'
          ? `It makes sense as ${fitText}, but it’s a little early.`
          : `It feels like ${fitText}.`;

  const talentClause = `${talentText.charAt(0).toLowerCase()}${talentText.slice(1)}`;

  // Keep the ending non-repetitive: we don't want 3 different sentences that all say "this is a reach".
  const closingLine =
    [
      tier === 'major_reach' || tier === 'reach' ? needReachCallout : null,
      processClose,
    ]
      .filter(Boolean)
      .join(' ');

  const paragraph =
    `${teamName} are taking ${prospect.name} (${group}). ${headline} ` +
    `He’s ${boardLine}${consensusLine ? ` (AVP ${Number(avp).toFixed(1)})` : ''}. ` +
    `${valueLine}. ` +
    `${fitClause} ${talentClause} ${closingLine}${noteText}`;

  return String(paragraph)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\s+,/g, ',')
    .replace(/\.\s+([a-z])/g, (m, c) => `. ${String(c).toUpperCase()}`);
}

function evaluatePickGrade(session, slot, prospect) {
  const group = prospectGroup(prospect);
  const needsCtx = buildNeedsContext(session, slot, group);
  const { needs, needRank, isOffNeed } = needsCtx;
  const boardExpectation = Number(session.currentPickIndex || 0) + 1;
  const boardRank = Number(prospect.rank || boardExpectation);
  const boardDelta = boardRank - boardExpectation;
  const avp = avpForProspect(session, prospect);
  // expectedPick - actualPick: positive => reach (picked early), negative => value (fell)
  const avpDelta = avp != null ? Number(avp) - boardExpectation : null;
  // Consensus is a blend of AVP (community expectation) + board rank (our class board).
  // This prevents AVP alone from over-penalizing picks that are basically "on the board".
  const boardBasedDelta = boardDelta * 1.0;
  const avpBasedDelta = avpDelta != null ? avpDelta * 1.0 : null;
  // Weight AVP more early (markets are tighter), then fade it slightly deeper into the round.
  const avpWeight = avpBasedDelta == null
    ? 0
    : boardExpectation <= 10
      ? 0.65
      : boardExpectation <= 20
        ? 0.55
        : 0.45;
  const gradeDelta = avpBasedDelta == null
    ? boardBasedDelta
    : (avpBasedDelta * avpWeight) + (boardBasedDelta * (1 - avpWeight));

  // Guardrail: if you're basically drafting "on the board" (within 2 spots of board rank),
  // don't let AVP/market noise classify it as a true reach/major reach.
  // This still allows mild reach/value labels but prevents D/F grades for a normal board-aligned pick.
  const onBoard = Math.abs(Number(boardDelta || 0)) <= 2;
  // For narrative, only lean on AVP when it meaningfully disagrees with the board.
  // If you're within 2 spots of board rank, we describe it as "in range" (or mild) instead of a market reach.
  const narrativeDelta = avpDelta != null && !onBoard ? avpDelta : boardDelta;
  const overall = Number(prospect.overall || 0);
  const premium = premiumPositionValue(group);

  const strongAtPos = isStrongAtPosition(session, slot?.name, group);

  // Put a name on the situation (drives both score + blurb via boardDelta)
  // consensusDelta = expectedPick - actualPick
  // positive => reach (picked earlier than expected)
  // negative => value/steal (fell)
  // Use the blended consensusDelta for scoring and tier naming.
  // If you're on-board, cap the penalty tier at mild_reach.
  const reachTier =
    (onBoard && gradeDelta >= 8) ? 'mild_reach' :
      gradeDelta >= 14 ? 'major_reach' :
        gradeDelta >= 8 ? 'reach' :
          gradeDelta >= 3 ? 'mild_reach' :
            gradeDelta <= -14 ? 'steal' :
              gradeDelta <= -8 ? 'value' :
                gradeDelta <= -3 ? 'mild_value' :
                  'as_expected';

  const talentTier =
    overall >= 90 ? 'generational' :
      overall >= 86 ? 'elite' :
        overall >= 82 ? 'high' :
          overall >= 78 ? 'solid' :
            overall >= 74 ? 'ok' :
              'low';

  // Board tier (used for "blue chip" context) — early picks should care about who was still available.
  const boardTier =
    boardRank <= 3 ? 'blue_chip' :
      boardRank <= 8 ? 'elite_board' :
        boardRank <= 16 ? 'top_16' :
          boardRank <= 32 ? 'round_1' :
            'day_2';

  let score = 78;
  if (needRank === 0) score += 14;
  else if (needRank === 1) score += 10;
  else if (needRank === 2) score += 6;
  else if (needRank >= 3) score += 2;
  else score -= 4;

  // AVP/board value / reach: heavier penalties for big reaches, stronger reward for true steals.
  // AVP is treated as "consensus" when present; boardRank is our fallback.
  // Keep value rewards meaningful, but not enough to turn a non-premium pick at 1.01 into an A by itself.
  if (reachTier === 'steal') score += 14;
  else if (reachTier === 'value') score += 10;
  else if (reachTier === 'mild_value') score += 6;
  else if (reachTier === 'mild_reach') score -= 7;
  else if (reachTier === 'reach') score -= 14;
  else if (reachTier === 'major_reach') score -= 22;
  else score += 2; // as expected gets a small stability bump

  // Extra calibration: if AVP exists and you're taking someone expected in the 20s in the top-5,
  // it's a reach in process terms even if our internal board likes the player.
  // This penalty is intentionally heavy to keep these outcomes in the B/B- range.
  if (avp != null && boardExpectation <= 5) {
    if (avpDelta >= 18) score -= 14;
    else if (avpDelta >= 12) score -= 10;
    else if (avpDelta >= 8) score -= 6;
  }

  // Positional value: premium positions should matter, but cap it so it doesn't dominate
  score += Math.min(10, premium);

  // Top-of-draft process: at the very top, passing on premium positions for low-premium spots is usually a miss.
  // This is intentionally harsh so picks like S at 1.01 don't get A grades.
  const pickNumber = boardExpectation;
  const isLowPremium = premium <= 5; // S/LB/IOL/DT bucket
  const isTopOfDraft = pickNumber <= 5;
  const isTrueBlueChipBoard = boardTier === 'blue_chip';
  if (isTopOfDraft && isLowPremium) {
    // Even if they're #1-3 on the board, low-premium still carries opportunity cost.
    // But if it's a true blue-chip AND it fills a top need, don't bury the grade.
    const topNeedHit = needRank === 0 || needRank === 1;
    if (isTrueBlueChipBoard && topNeedHit) {
      score -= 2;
    } else if (isTrueBlueChipBoard) {
      score -= 8;
    } else {
      score -= 18;
    }
  }

  // Talent tier: landing elite talent should lift the grade even if it's a "non-need"
  // Only give the biggest talent bumps when the player is also an elite board asset.
  // (Prevents a mid-board RB from getting "elite" treatment because of OVR alone.)
  if (talentTier === 'generational') score += boardTier === 'blue_chip' ? 14 : boardTier === 'elite_board' ? 10 : 6;
  else if (talentTier === 'elite') score += boardTier === 'blue_chip' ? 11 : boardTier === 'elite_board' ? 8 : 4;
  else if (talentTier === 'high') score += boardTier === 'blue_chip' ? 8 : boardTier === 'elite_board' ? 6 : 3;
  else if (talentTier === 'solid') score += 2;
  else if (talentTier === 'low') score -= 6;

  // Early RB/TE: it can still be a need, but process should be driven by board value + positional value.
  // If you're passing on elite tackles/EDGE/CB/WR/QB assets to take RB/TE, the grade should reflect that.
  if (['RB', 'TE'].includes(group) && boardExpectation <= 16) {
    const isTrueBlueChip = boardTier === 'blue_chip' || boardTier === 'elite_board';
    if (isTrueBlueChip && needRank === 0 && ['elite', 'generational'].includes(talentTier)) {
      // Best-case: rare prospect + top need. Still a positional value ding.
      score -= 8;
    } else if (needRank === 0) {
      // Need, but not a blue-chip board asset.
      score -= 18;
    } else {
      // Not a top need.
      score -= 24;
    }
  }
  if (group === 'QB' && needRank === -1) score -= 10;
  if (group === 'QB' && needRank === 0) score += 6;

  // Needs vs strength: if the team is already strong at the drafted position, treat it as a "luxury" move.
  // This is intentionally harsher for QB because it blocks value at other premium positions.
  if (isOffNeed && strongAtPos) {
    if (group === 'QB') {
      score -= boardExpectation <= 10 ? 18 : 10;
    } else if (['RB', 'TE'].includes(group)) {
      score -= boardExpectation <= 16 ? 10 : 6;
    } else {
      score -= boardExpectation <= 16 ? 8 : 4;
    }
  }

  // If it's an elite/generational prospect, soften "non-need" penalties (teams can justify it)
  if (needRank === -1 && ['elite', 'generational'].includes(talentTier)) score += 5;

  // Reaches hurt a bit less if you're drafting a true premium position with elite talent
  if (['reach', 'major_reach'].includes(reachTier) && premium >= 7 && ['elite', 'generational'].includes(talentTier)) score += 4;

  score = Math.max(55, Math.min(99, score));
  return {
    score,
    grade: gradeLabelFromScore(score),
    synopsis: buildPickSynopsis({ teamName: slot.name, prospect, needRank, boardDelta: narrativeDelta, overall, group, session, avpDelta, avp }),
  };
}

export function applyPick(session, userId, prospect, options = {}) {
  const currentPickIndex = Number(session.currentPickIndex || 0);
  const slot = session.order[currentPickIndex];
  if (!slot || !prospect) {
    return session;
  }
  const isCpuPick = userId === 'auto';
  const review = isCpuPick ? null : evaluatePickGrade(session, slot, prospect);
  session.availableProspects = session.availableProspects.filter((item) => item.id !== prospect.id);
  const pick = {
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
    actorLabel: options.actorLabel || (userId === 'auto' ? 'Auto' : `<@${userId}>`),
    madeAt: Date.now(),
  };
  session.picks.push(pick);
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
  const avpStore = loadAvpStore();

  const avpFor = (prospect) => {
    if (!avpStore?.prospects) return null;
    const direct = avpStore.prospects?.[prospect?.id]?.avp;
    if (direct != null) return direct;

    const normalizedId = normalizeProspectIdForAvp(prospect?.id);
    const normalized = normalizedId ? avpStore.prospects?.[normalizedId]?.avp : null;
    if (normalized != null) return normalized;

    // Last resort: sometimes callers may have legacy ids that match AVP keys by name+pos.
    const legacyKey = prospect?.name && prospect?.position
      ? `${String(prospect.name).replace(/[^a-z0-9]/gi, '').toLowerCase()}_${String(prospect.position).toUpperCase()}`
      : null;
    return legacyKey ? avpStore.prospects?.[legacyKey]?.avp ?? null : null;
  };
  const options = (session.availableProspects || []).slice(0, MAX_SELECT_OPTIONS).map((prospect) =>
    (() => {
      const avp = avpFor(prospect);
      const avpText = avp != null ? ` • AVP ${Number(avp).toFixed(1)}` : '';
      return new StringSelectMenuOptionBuilder()
        .setLabel(`#${prospect.rank} ${prospect.name}`.slice(0, 100))
        .setDescription(`${prospect.position} • ${prospect.school}${avpText}`.slice(0, 100))
        .setValue(prospect.id);
    })(),
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

  // Match `/madden-mockdraft` behavior:
  // - In regular season, compute the live order from standings/tiebreaks (do NOT freeze to overrides).
  // - In offseason, allow official overrides (calibration / real draft order file).
  const seasonInfo = league?.info?.careerHubInfo?.seasonInfo || {};
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  const inRegularSeason = weekType === 1;

  const officialOrder = inRegularSeason ? null : loadOfficialDraftOrderOverride(league, draftYear);
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
    teamStrengths: extractTeamStrengths(league),
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

export function simulateMockDraftPick(sessionId, userId) {
  return updateMockDraftSession(sessionId, (session) => {
    if (session.status !== 'live') throw new Error('This mock draft is not live yet.');
    const currentOwner = session.pickOwners?.[String(session.currentPickIndex)];
    if (currentOwner !== userId) throw new Error('It is not your pick right now.');
    const prospect = autoPickProspect(session);
    if (!prospect) throw new Error('No prospects are available.');
    return applyPick(session, userId, prospect, { actorLabel: `Sim by <@${userId}>` });
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
    if (currentOwner) {
      return applyPick(session, currentOwner, prospect, { actorLabel: `CPU for <@${currentOwner}>` });
    }
    return applyPick(session, 'auto', prospect);
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
