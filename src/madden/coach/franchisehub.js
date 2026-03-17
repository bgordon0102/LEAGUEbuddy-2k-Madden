import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadRoleMap } from '../staff/staffUtils.js';
import { buildFranchiseProfileContext, buildFranchiseProfile } from '../franchise_profile.js';
import { getLegacyOpportunityForTeam, getRecognitionPerkState, getRecognitionGameOfWeek, getRecognitionLeaderboard, getRecognitionPurchaseReceipts, getRecognitionUserSummary, getRecognitionWeeklyOpportunity, inferRecognitionContext, recordRecognitionThreadReply } from '../../shared/league_recognition.js';
import { formatImpactValue, getSportsbookOpenBetOpportunity, getSportsbookUserCard } from '../../shared/madden_sportsbook.js';
import { collectParticipation, listThreadStates } from '../../shared/madden_thread_notifier.js';
import { coachCommandDescription, coachPanelIntro, coachVoiceFooter, coachVoiceTitle, coachErrorBlurb } from '../../shared/madden_coach_voice.js';
import { formatTeamLabelWithEmoji, RECOGNITION_EMOJIS } from '../../shared/madden_visuals.js';

const data = new SlashCommandBuilder()
  .setName('madden-franchisehub')
  .setDescription(coachCommandDescription('franchisehub'));

function normalizeName(name = '') {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameTeamLabel(left = '', right = '') {
  const leftNorm = normalizeName(left);
  const rightNorm = normalizeName(right);
  if (!leftNorm || !rightNorm) return false;
  return leftNorm === rightNorm || leftNorm.endsWith(rightNorm) || rightNorm.endsWith(leftNorm);
}

function findCoachTeam(member, snapshot) {
  const roleMap = loadRoleMap();
  const teamInfos = snapshot?.teams?.leagueTeamInfoList || [];
  const teamCandidates = teamInfos.map((team) => ({
    teamId: Number(team.teamId),
    fullName: getFullTeamName(team, `Team ${team.teamId}`),
    mascot: String(team.displayName || team.nickName || '').trim(),
    city: String(team.cityName || '').trim(),
    abbr: String(team.abbrName || '').trim(),
  }));
  for (const role of member?.roles?.cache?.values?.() || []) {
    for (const [name] of Object.entries(roleMap || {})) {
      if (!/ coach$/i.test(name)) continue;
      if (name !== role.name) continue;
      const base = name.replace(/ coach$/i, '').trim();
      const norm = normalizeName(base);
      const match = teamCandidates.find((team) =>
        [team.fullName, team.mascot, team.city, team.abbr].some((value) => normalizeName(value) === norm));
      if (match) return match.fullName;
    }
  }
  return null;
}

function scoutingLine(accountability) {
  const scouting = accountability?.scouting || {};
  const parts = [
    `${scouting.fullCount || 0} fully scouted`,
    `${scouting.partialCount || 0} in progress`,
  ];
  if (scouting.currentPoints != null) parts.push(`${scouting.currentPoints} pts left`);
  if (Number(scouting.bonus || 0) > 0) parts.push(`+${scouting.bonus} weekly bonus`);
  return parts.join(' • ');
}

function accountabilityLine(accountability) {
  const parts = [
    `${Number(accountability?.strikeTotal || 0).toFixed(1)}/5 strikes`,
    accountability?.strikeBreakdown || 'Clean',
  ];
  if (accountability?.playRate != null) parts.push(`${accountability.playRate}% played`);
  if (Number(accountability?.consecutiveSilentWeeks || 0) > 0) {
    parts.push(`${accountability.consecutiveSilentWeeks} straight silent`);
  } else if (Number(accountability?.silentWeeks || 0) > 0) {
    parts.push(`${accountability.silentWeeks} silent week${accountability.silentWeeks === 1 ? '' : 's'}`);
  } else {
    parts.push('communication clear');
  }
  return parts.join(' • ');
}

function checkbox(value) {
  return value ? '✅' : '⬜';
}

function isOffseasonSnapshot(snapshot) {
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const weekType = Number(
    seasonInfo?.seasonWeekType ??
    seasonInfo?.seasonWeekTypeId ??
    snapshot?.stage ??
    snapshot?.currentStage ??
    0
  );
  const seasonTitle = String(seasonInfo?.seasonTitle || '').toLowerCase();
  return weekType === 3 || weekType === 8 || seasonTitle.includes('offseason');
}

function perkListText(items = [], formatter) {
  if (!items.length) return 'none';
  return items.map(formatter).join(', ');
}

function tierSpendStatusLine(tier, perkState) {
  const emoji = RECOGNITION_EMOJIS[tier] || '•';
  const tierState = perkState?.tierStatus?.[tier] || { active: [], used: [], available: [] };
  const balance = Number(perkState?.balances?.[tier] || 0);
  const title = tier.charAt(0).toUpperCase() + tier.slice(1);
  const phaseLocked = Object.values(perkState?.perkStatus || {}).filter((perk) => perk?.tier === tier && perk?.phaseOpen === false).length;
  const parts = [
    `${emoji} ${title}: ${balance} to spend`,
    `${tierState.available.length} can buy now`,
  ];
  if (phaseLocked) parts.push(`${phaseLocked} phase-locked`);
  if (tierState.active.length) parts.push(`${tierState.active.length} active`);
  if (tierState.used.length) parts.push(`${tierState.used.length} used this week`);
  return parts.join(' • ');
}

function recognitionTimingSummary(recognition = {}) {
  const weekLabel = recognition?.weekNumber ? `during weekly update after Week ${recognition.weekNumber}` : 'during weekly update';
  return [
    'Instant:',
    '- strategy, stream, front office, thread reply, finish on time',
    'Weekly update:',
    `- streaks, featured bonuses, Legacy, sportsbook wins, Double or Nothing ${weekLabel}`,
  ].join('\n');
}

function weeklyChecklistSummary(weekState = {}) {
  const checklist = weekState?.checklist || {};
  const done = [];
  const open = [];
  const push = (flag, label) => {
    if (flag) done.push(label);
    else open.push(label);
  };
  push(checklist.strategy, 'strategy');
  push(checklist.stream, 'stream');
  push(checklist.frontOffice, 'front office');
  push(checklist.threadResponse, 'thread');
  push(checklist.gameCompletedOnTime, 'finish');
  const total = done.length + open.length || 5;
  return [
    `Weekly Activity checklist: ${done.length} of ${total} done`,
    done.length ? `Checked off:\n${done.map((item) => `- ${item}`).join('\n')}` : 'Checked off:\n- none yet',
    open.length ? `Still open this week:\n${open.map((item) => `- ${item}`).join('\n')}` : 'Still open this week:\n- complete',
    'Use: /madden-gamestrategy, /madden-streamlink, draft/scout tools, and your game thread.',
  ].join('\n');
}

async function syncThreadChecklistFromLiveThread({ interaction, teamName, recognitionContext, recognitionWeekState }) {
  if (!teamName || !recognitionContext?.seasonKey || !recognitionContext?.weekKey || recognitionWeekState?.checklist?.threadResponse) {
    return;
  }
  const targetWeekIndex = Number(recognitionContext.weekNumber || 0) - 1;
  if (!Number.isFinite(targetWeekIndex) || targetWeekIndex < 0) return;
  const threadInfo = listThreadStates().find((info) =>
    Number(info?.weekIndex) === targetWeekIndex &&
    [info?.awayTeam || '', info?.homeTeam || ''].some((label) => sameTeamLabel(label, teamName))
  );
  if (!threadInfo?.threadId) return;
  const thread = await interaction.client.channels.fetch(threadInfo.threadId).catch(() => null);
  if (!thread?.isTextBased?.()) return;
  const participation = await collectParticipation(thread, threadInfo).catch(() => null);
  if (!participation) return;
  const isAway = sameTeamLabel(threadInfo.awayTeam || '', teamName);
  const hasReply = isAway ? Number(participation.awayCount || 0) > 0 : Number(participation.homeCount || 0) > 0;
  if (!hasReply) return;
  recordRecognitionThreadReply({
    guildId: interaction.guildId,
    league: 'madden',
    seasonKey: recognitionContext.seasonKey,
    weekKey: recognitionContext.weekKey,
    userId: interaction.user.id,
  });
}

function purchaseReceiptLines(receipts = []) {
  if (!receipts.length) return 'No purchases this week.';
  return receipts.map((receipt) => {
    const emoji = RECOGNITION_EMOJIS[receipt.tier] || '•';
    return `${emoji} ${receipt.label} • cost ${receipt.amount}`;
  }).join('\n');
}

function formatOpportunityAmount(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return '0';
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}

async function buildLegacyLeaderboardText({ guild, guildId, seasonKey }) {
  if (!guildId || !seasonKey) return 'Legacy board not ready yet.';
  const leaders = getRecognitionLeaderboard({
    guildId,
    league: 'madden',
    seasonKey,
    tier: 'legacy',
    limit: 5,
  });
  if (!leaders.length) return 'Legacy board not ready yet.';

  const placeEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const lines = [];
  for (let index = 0; index < leaders.length; index += 1) {
    const leader = leaders[index];
    const member = guild?.members?.cache?.get?.(String(leader.userId))
      || await guild?.members?.fetch?.(String(leader.userId)).catch(() => null);
    const user = member?.user || await guild?.client?.users?.fetch?.(String(leader.userId)).catch(() => null);
    const label = member?.displayName
      || user?.globalName
      || user?.username
      || `Coach ${String(leader.userId).slice(-4)}`;
    lines.push(`${placeEmojis[index] || '•'} ${RECOGNITION_EMOJIS.legacy} ${label} • ${leader.legacy}`);
  }
  return lines.join('\n');
}

function resolveTeamIdForRecognition(snapshot, teamName) {
  if (!snapshot || !teamName) return null;
  const teamInfo = (snapshot?.teams?.leagueTeamInfoList || []).find((team) => {
    const full = getFullTeamName(team, `Team ${team.teamId}`);
    return sameTeamLabel(full, teamName) || sameTeamLabel(team.displayName || '', teamName) || sameTeamLabel(team.cityName || '', teamName);
  });
  if (teamInfo?.teamId != null) return Number(teamInfo.teamId);
  const standing = (snapshot?.standings?.teamStandingInfoList || []).find((team) =>
    sameTeamLabel(team?.teamName || '', teamName) ||
    sameTeamLabel(team?.displayName || '', teamName) ||
    sameTeamLabel(team?.cityName || '', teamName)
  );
  return standing?.teamId != null ? Number(standing.teamId) : null;
}

function recognitionSummaryLines(guildId, userId, snapshot = null, teamName = null) {
  const context = inferRecognitionContext('madden', guildId);
  if (!context?.seasonKey) {
    return {
      header: 'Recognition data not ready yet.',
      checklist: 'Checklist not available.',
      gotw: null,
      weeklyEarn: 'Weekly earn recap is not ready yet.',
    };
  }
  const summary = getRecognitionUserSummary({
    guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    userId,
    weekKey: context.weekKey,
  });
  const userState = summary?.userState || { activity: 0, impact: 0, legacy: 0, currentStreak: 0, interactionCount: 0 };
  const weekState = summary?.weekState || {
    checklist: {
      strategy: false,
      stream: false,
      frontOffice: false,
      threadResponse: false,
      gameCompletedOnTime: false,
    },
  };
  const gotw = getRecognitionGameOfWeek({
    guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    weekKey: context.weekKey,
  });
  const sportsbook = context?.weekNumber
    ? getSportsbookUserCard({
        seasonKey: context.seasonKey,
        weekNumber: context.weekNumber,
        userId,
        guildId,
      })
    : null;
  const perkState = getRecognitionPerkState({
    guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    userId,
    weekKey: context.weekKey,
  });
  const hasLegacyPerks = Object.values(perkState?.costs || {}).some((perk) => perk?.tier === 'legacy');
  const activePerks = perkState?.active || [];
  const receipts = getRecognitionPurchaseReceipts({
    guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    userId,
    weekKey: context.weekKey,
    limit: 4,
  });
  const weeklyOpportunity = getRecognitionWeeklyOpportunity({
    guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    weekKey: context.weekKey,
    userId,
  });
  const teamId = resolveTeamIdForRecognition(snapshot, teamName);
  const legacyOpportunity = teamId != null
    ? getLegacyOpportunityForTeam({ snapshot, teamId })
    : { total: 0, reasons: [] };
  const checklistDone = Object.values(weekState.checklist || {}).filter(Boolean).length;
  const checklistTotal = Object.keys(weekState.checklist || {}).length || 5;
  const openBetOpportunity = getSportsbookOpenBetOpportunity({
    seasonKey: context.seasonKey,
    weekNumber: context?.weekNumber || null,
    userId,
    guildId,
  });
  const totalImpactInPlay = Number(weeklyOpportunity?.impact?.total || 0) + Number(openBetOpportunity?.total || 0);
  const exactBetPayout = Number(openBetOpportunity?.total || 0);
  const weeklyEarn = [
    `${RECOGNITION_EMOJIS.activity} Activity upside this week: +${formatOpportunityAmount(weeklyOpportunity?.activity?.total || 0)}`,
    ...(weeklyOpportunity?.activity?.reasons || []).slice(0, 3).map((line) => `- ${line}`),
    `${RECOGNITION_EMOJIS.impact} Impact upside this week: +${formatOpportunityAmount(totalImpactInPlay)} impact${exactBetPayout > 0 ? ` (${formatOpportunityAmount(exactBetPayout)} from ${openBetOpportunity.count === 1 ? 'your open bet' : `${openBetOpportunity.count} open bets`})` : ''}`,
    ...((weeklyOpportunity?.impact?.reasons || []).length
      ? (weeklyOpportunity.impact.reasons || []).slice(0, 2).map((line) => `- ${line}`)
      : (openBetOpportunity.total > 0 ? [] : ['- no featured bonus live right now'])),
    `${RECOGNITION_EMOJIS.legacy} Legacy upside this week: +${formatOpportunityAmount(legacyOpportunity?.total || 0)}`,
    ...((legacyOpportunity?.reasons || []).length
      ? (legacyOpportunity.reasons || []).slice(0, 2).map((line) => `- ${line}`)
      : ['- no major legacy swing is live yet']),
  ].join('\n');
  return {
    header: [
      `${RECOGNITION_EMOJIS.activity} Activity ${perkState?.balances?.activity ?? (userState.activity || 0)}`,
      `${RECOGNITION_EMOJIS.impact} Impact ${perkState?.balances?.impact ?? (userState.impact || 0)}`,
      `${RECOGNITION_EMOJIS.legacy} Legacy ${perkState?.balances?.legacy ?? (userState.legacy || 0)}`,
    ].join(' • '),
    phaseLine: perkState?.phaseLabel ? `Season phase: ${perkState.phaseLabel}` : null,
    checklist: weeklyChecklistSummary(weekState),
    earn: [
      `${RECOGNITION_EMOJIS.activity} Activity = show up`,
      `${RECOGNITION_EMOJIS.impact} Impact = make plays`,
      `${RECOGNITION_EMOJIS.legacy} Legacy = build history`,
    ].join('\n'),
    weeklyEarn,
    perks: activePerks.length
      ? activePerks.map((perk) => {
          const emoji = RECOGNITION_EMOJIS[perk.tier] || '•';
          const suffix = perk.key === 'doubleOrNothing' && perk.selectedTier
            ? ` (${perk.selectedTier})`
            : '';
          return `${emoji} ${perk.label}${suffix}`;
        }).join('\n')
      : 'No perks active this week.',
    spend: [
      tierSpendStatusLine('activity', perkState),
      tierSpendStatusLine('impact', perkState),
      hasLegacyPerks && (Number(perkState?.balances?.legacy || 0) > 0 || (perkState?.tierStatus?.legacy?.available?.length || 0) > 0)
        ? tierSpendStatusLine('legacy', perkState)
        : null,
    ].filter(Boolean).join('\n'),
    hasLegacyPerks,
    bankroll: sportsbook ? `${formatImpactValue(sportsbook.bankroll?.balance || 40)} available to bet` : null,
    gotw: gotw
      ? ['Featured game:', `- ${gotw.label}${gotw.winnerTeam ? ` • Winner: ${gotw.winnerTeam}` : ' • winner gets bonus Impact'}`].join('\n')
      : null,
    streak: `${userState.currentStreak || 0} week streak`,
    receipts: purchaseReceiptLines(receipts),
    weekNumber: context?.weekNumber || null,
  };
}

function buildSpectatorHubEmbed({ recognition, leagueId, snapshot }) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const topTeam = standings
    .slice()
    .sort((a, b) => Number(b.winPct || 0) - Number(a.winPct || 0))[0];
  const topTeamLabel = topTeam ? `${formatTeamLabelWithEmoji(topTeam.teamName)} (${topTeam.totalWins}-${topTeam.totalLosses})` : 'No league leader yet.';
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(coachVoiceTitle('lightHub', 'LEAGUEbuddy — League Hub'))
    .setDescription(coachPanelIntro('lightHub'))
    .addFields(
      {
        name: 'Your Recognition',
        value: [
          recognition.header,
          recognition.bankroll ? `Impact available to bet: ${recognition.bankroll}` : null,
          recognition.gotw || 'Featured game: not set yet.',
        ].filter(Boolean).join('\n'),
      },
      {
        name: 'This Week',
        value: [
          recognition.streak,
          'Coach checklist rewards unlock when you have a team.',
          'You can still use the sportsbook right now.',
        ].join('\n'),
      },
      {
        name: 'League Snapshot',
        value: [
          `League: ${leagueId}`,
          `Current leader: ${topTeamLabel}`,
          'Use this hub to track recognition and open the sportsbook while you wait for a team.',
        ].join('\n'),
      },
    )
    .setFooter({ text: coachVoiceFooter('privateLeagueHub', 'Private league follower hub') });
}

const POS_ALIAS = { EDGE: 'REDG', REDGE: 'REDG', LEDGE: 'LEDG' };
const POSITION_NEEDS = {
  QB: 1, HB: 1, FB: 1,
  LT: 1, LG: 1, C: 1, RG: 1, RT: 1,
  WR: 3, TE: 1,
  LEDG: 1, REDG: 1,
  DT: 2,
  SAM: 1, MIKE: 1, WILL: 1,
  CB: 3, FS: 1, SS: 1,
};

function buildAllProTeams(list = []) {
  const grouped = {};
  for (const p of list) {
    let pos = String(p.position || p.displayPos || '').toUpperCase();
    if (POS_ALIAS[pos]) pos = POS_ALIAS[pos];
    if (!POSITION_NEEDS[pos]) continue;
    const grade = Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0);
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...p, displayPos: pos, grade });
  }
  for (const key of Object.keys(grouped)) grouped[key].sort((a, b) => b.grade - a.grade);
  const used = new Set();
  const first = [];
  const second = [];
  const fill = (target, countMap) => {
    for (const [pos, count] of Object.entries(countMap)) {
      let taken = 0;
      for (const p of grouped[pos] || []) {
        const id = p.id || `${p.name}-${p.teamId || ''}`;
        if (used.has(id)) continue;
        target.push(p);
        used.add(id);
        taken += 1;
        if (taken >= count) break;
      }
    }
  };
  fill(first, POSITION_NEEDS);
  fill(second, POSITION_NEEDS);
  return { first, second };
}

function chunkFieldText(text, maxLen = 1024) {
  const clean = String(text || '').trim();
  if (!clean) return ['No additional context.'];
  if (clean.length <= maxLen) return [clean];

  const chunks = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.55)) cut = remaining.lastIndexOf('. ', maxLen);
    if (cut < Math.floor(maxLen * 0.55)) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.slice(0, 3);
}

function compactFieldText(text, maxLen = 320) {
  const clean = String(text || '').trim();
  if (!clean) return 'No additional context.';
  if (clean.length <= maxLen) return clean;
  let cut = clean.lastIndexOf('. ', maxLen);
  if (cut < Math.floor(maxLen * 0.6)) cut = clean.lastIndexOf(' ', maxLen);
  if (cut <= 0) cut = maxLen - 1;
  return `${clean.slice(0, cut + 1).trim()}…`;
}

function compactFranchiseRead(text, maxSentences = 2, maxLen = 220) {
  const clean = String(text || '').trim();
  if (!clean) return 'No additional context.';
  const sentences = clean
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const picked = sentences.slice(0, maxSentences).join(' ').trim();
  return compactFieldText(picked || clean, maxLen);
}

function currentBetsSummary(card = null) {
  const bets = Array.isArray(card?.bets) ? card.bets.filter((bet) => String(bet?.status || 'open') === 'open') : [];
  if (!bets.length) return 'Current bets: none';
  const linesByGameId = new Map(
    (Array.isArray(card?.lines) ? card.lines : [])
      .filter((line) => line?.gameId)
      .map((line) => [String(line.gameId), line])
  );
  const lines = bets.slice(0, 2).map((bet) => {
    const wager = formatImpactValue(Number(bet?.wager || 0)).replace(/\s*<:impact:[^>]+>/, ' impact');
    const line = linesByGameId.get(String(bet?.gameId || ''));
    const matchupLabel = bet.matchupLabel || (line ? `${line.awayTeam} at ${line.homeTeam}` : 'Unknown game');
    return `- ${matchupLabel} • ${bet.betLabel || `${bet.market} ${bet.selection}`} • ${wager}`;
  });
  if (bets.length > 2) lines.push(`- plus ${bets.length - 2} more open bet${bets.length - 2 === 1 ? '' : 's'}`);
  return ['Current bets:', ...lines].join('\n');
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: coachErrorBlurb('noLeague', 'No Madden league is set yet.') });
    return;
  }

  const snapshot = loadLeagueSnapshot(leagueId);
  if (!snapshot) {
    await interaction.editReply({ content: coachErrorBlurb('noSnapshot', 'League snapshot not found.') });
    return;
  }

  const teamName = findCoachTeam(interaction.member, snapshot);
  const recognitionContext = inferRecognitionContext('madden', interaction.guildId);
  if (teamName && recognitionContext?.seasonKey && recognitionContext?.weekKey) {
    const currentSummary = getRecognitionUserSummary({
      guildId: interaction.guildId,
      league: 'madden',
      seasonKey: recognitionContext.seasonKey,
      userId: interaction.user.id,
      weekKey: recognitionContext.weekKey,
    });
    await syncThreadChecklistFromLiveThread({
      interaction,
      teamName,
      recognitionContext,
      recognitionWeekState: currentSummary?.weekState,
    });
  }
  const recognition = recognitionSummaryLines(interaction.guildId, interaction.user.id, snapshot, teamName);
  const legacyLeaderboard = await buildLegacyLeaderboardText({
    guild: interaction.guild,
    guildId: interaction.guildId,
    seasonKey: recognitionContext?.seasonKey,
  });
  if (!teamName) {
    const embed = buildSpectatorHubEmbed({ recognition, leagueId, snapshot });
    embed.addFields({ name: 'Legacy Leaders', value: legacyLeaderboard });
    const controls = new ActionRowBuilder();
    if (recognition.weekNumber) {
      controls.addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_sportsbook_open|${recognition.weekNumber}|board|0`)
          .setLabel('Open Sportsbook')
          .setStyle(ButtonStyle.Primary),
      );
    }
    await interaction.editReply({ embeds: [embed], components: controls.components.length ? [controls] : [] });
    return;
  }

  const ctx = buildFranchiseProfileContext(snapshot, interaction.guild);
  const profile = buildFranchiseProfile(ctx, teamName, { coachUserId: interaction.user.id });
  if (!profile) {
    await interaction.editReply({ content: 'Could not build your franchise hub from the current league snapshot.' });
    return;
  }

  const teamTop100Count = (ctx.top100 || []).filter((player) => normalizeName(player.team) === normalizeName(profile.teamName)).length;
  const { first: allProFirst, second: allProSecond } = buildAllProTeams(ctx.top100 || []);
  const teamAllProFirst = allProFirst.filter((player) => normalizeName(player.team || '') === normalizeName(profile.teamName)).length;
  const teamAllProSecond = allProSecond.filter((player) => normalizeName(player.team || '') === normalizeName(profile.teamName)).length;
  const showSeasonHonors = isOffseasonSnapshot(snapshot);
  const franchiseRead = profile.franchiseRead || profile.frontOfficeParagraph || profile.actionPlan || 'No additional franchise read was available.';
  const franchiseReadShort = compactFranchiseRead(franchiseRead, 2, 220);
  const sportsbook = recognition.weekNumber
    ? getSportsbookUserCard({
        seasonKey: recognitionContext?.seasonKey,
        weekNumber: recognition.weekNumber,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      })
    : null;
  const recognitionOverview = [
    recognition.header,
    recognition.streak,
    recognition.bankroll ? `Impact available to bet: ${recognition.bankroll}` : null,
    recognition.phaseLine,
  ].filter(Boolean).join('\n');
  const weeklyFocus = [
    recognition.gotw || 'Featured game: not set yet.',
    `Earn this week:\n${recognition.weeklyEarn}`,
    currentBetsSummary(sportsbook),
  ].filter(Boolean).join('\n\n');
  const hubIntro = coachPanelIntro('franchiseHub', { teamName: profile.teamName });

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`${formatTeamLabelWithEmoji(profile.teamName)} — Franchise Hub`);
  if (hubIntro) embed.setDescription(hubIntro);
  embed
    .addFields(
      {
        name: 'Team Snapshot',
        value: [
          `${profile.record} • ${profile.tradePosture.short}`,
          ...(showSeasonHonors ? [`${teamTop100Count} Top 100 • ${teamAllProFirst} All-Pro 1st • ${teamAllProSecond} All-Pro 2nd`] : []),
        ].join('\n'),
      },
      {
        name: 'Franchise Read',
        value: franchiseReadShort,
      },
      {
        name: 'Recognition',
        value: recognitionOverview,
      },
      {
        name: 'Weekly Focus',
        value: compactFieldText(weeklyFocus, 700),
      },
      {
        name: 'Legacy Leaders',
        value: legacyLeaderboard,
      },
    )
    .setFooter({ text: coachVoiceFooter('privateFranchiseHub', 'Private league status hub') });

  const controls = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('madden_franchisehub_spend|activity').setLabel('Spend Activity').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('madden_franchisehub_spend|impact').setLabel('Spend Impact').setStyle(ButtonStyle.Secondary),
    );
  if (recognition.weekNumber) {
    controls.addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_open|${recognition.weekNumber}|board|0`)
        .setLabel('Open Sportsbook')
        .setStyle(ButtonStyle.Primary),
    );
  }

  await interaction.editReply({ embeds: [embed], components: [controls] });
}

function formatNeedLabel(need) {
  const labels = {
    QB: 'QB',
    OT: 'OT',
    IOL: 'IOL',
    WR: 'WR',
    TE: 'TE',
    RB: 'RB',
    EDGE: 'EDGE',
    DT: 'DT',
    LB: 'LB',
    CB: 'CB',
    S: 'S',
    BPA: 'BPA',
  };
  return labels[need] || need || 'BPA';
}

export default { data, execute };
