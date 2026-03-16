import { ButtonInteraction, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { getThreadState, collectParticipation, buildProjectedOutcome, markThreadDone } from '../shared/madden_thread_notifier.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';
import { loadStrikeStore, saveStrikeStore, addStrikeOutcome, ensureStrikeSeason, remainingWeighted } from '../shared/madden_strikes.js';
import { updateFairSimBoard } from '../shared/fairsim_board.js';
import { appendMaddenStaffLog, postLeagueStaffOpsSnapshot, postMaddenStaffLog } from '../shared/madden_staff_ops.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { queueRemovalReview, queueImmediateRemedyReview } from '../shared/madden_removal_review.js';
import { sendCoachReceipt } from '../shared/madden_coach_receipts.js';

export const customId = /^madden_apply_determined_strikes\|([^|]+)$/;

function seasonKeyFromSnapshot(snapshot) {
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

async function coachUserIds(guild, roleIds = []) {
  const users = new Set();
  for (const roleId of roleIds) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (!role) continue;
    if (role.members?.size) {
      role.members.forEach((m) => users.add(m.id));
      continue;
    }
    try {
      const all = await guild.members.fetch();
      all.filter((m) => m.roles.cache.has(roleId)).forEach((m) => users.add(m.id));
    } catch {
      // ignore
    }
  }
  return [...users];
}

function disableButtons(interaction) {
  const updatedRows = interaction.message.components.map((row) => {
    const newRow = ActionRowBuilder.from(row);
    newRow.components = newRow.components.map((btn) => ButtonBuilder.from(btn).setDisabled(true));
    return newRow;
  });
  return interaction.message.edit({ components: updatedRows });
}

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [, threadId] = interaction.customId.match(customId) || [];
  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.reply({ content: 'Only staff can apply determined strikes.', ephemeral: true });
    return;
  }

  const thread = await interaction.client.channels.fetch(threadId).catch(() => null);
  const info = getThreadState(threadId);
  if (!thread || !thread.isTextBased() || !info) {
    await interaction.reply({ content: 'Thread state was not found for this determination.', ephemeral: true });
    return;
  }
  if (info.status !== 'pending') {
    await interaction.reply({ content: 'This matchup has already been resolved.', ephemeral: true });
    return;
  }

  const participation = await collectParticipation(thread, info);
  const determined = buildProjectedOutcome(info, participation);
  if (!determined.strikeAway && !determined.strikeHome) {
    await interaction.reply({ content: 'No determined strikes are active for this thread anymore.', ephemeral: true });
    return;
  }

  const awayUsers = await coachUserIds(thread.guild, info.awayRoleIds || []);
  const homeUsers = await coachUserIds(thread.guild, info.homeRoleIds || []);
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = loadLeagueSnapshot(leagueId);
  const seasonKey = seasonKeyFromSnapshot(snapshot);
  const store = loadStrikeStore();

  if (determined.strikeAway) {
    if (!awayUsers.length) {
      await interaction.reply({ content: 'No coach user is resolved for the away team. Fix the coach role before applying determined strikes.', ephemeral: true });
      return;
    }
    addStrikeOutcome(
      store,
      seasonKey,
      awayUsers,
      'determined_strike',
      'DS',
    );
  }
  if (determined.strikeHome) {
    if (!homeUsers.length) {
      await interaction.reply({ content: 'No coach user is resolved for the home team. Fix the coach role before applying determined strikes.', ephemeral: true });
      return;
    }
    addStrikeOutcome(
      store,
      seasonKey,
      homeUsers,
      'determined_strike',
      'DS',
    );
  }
  saveStrikeStore(store);
  const seasonData = ensureStrikeSeason(store, seasonKey);

  const appliedLines = [];
  if (determined.strikeAway) {
    const rem = remainingWeighted(seasonData, awayUsers);
    appliedLines.push(
      awayUsers.length
        ? `${info.awayTeam || 'Away'} strike applied • ${Object.entries(rem).map(([u, value]) => `<@${u}> ${Math.max(value, 0)}/5 left`).join(', ')}`
        : `${info.awayTeam || 'Away'} strike applied at team level.`,
    );
  }
  if (determined.strikeHome) {
    const rem = remainingWeighted(seasonData, homeUsers);
    appliedLines.push(
      homeUsers.length
        ? `${info.homeTeam || 'Home'} strike applied • ${Object.entries(rem).map(([u, value]) => `<@${u}> ${Math.max(value, 0)}/5 left`).join(', ')}`
        : `${info.homeTeam || 'Home'} strike applied at team level.`,
    );
  }

  markThreadDone(threadId, 'determined_strikes');
  try { await disableButtons(interaction); } catch {}
  try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch {}

  appendMaddenStaffLog({
    type: 'determined_strikes_applied',
    guildId: interaction.guildId,
    threadId,
    awayTeam: info.awayTeam,
    homeTeam: info.homeTeam,
    appliedBy: interaction.user.id,
    determined,
  });
  await postMaddenStaffLog(
    interaction.client,
    interaction.guildId,
    'Determined Strikes Applied',
    `${info.awayTeam || 'Away'} vs ${info.homeTeam || 'Home'} had determined strikes applied by ${interaction.user}.`,
    [{ name: 'Applied', value: appliedLines.join('\n') || 'No strike lines recorded.' }],
  ).catch(() => null);
  await postLeagueStaffOpsSnapshot(interaction.client, interaction.guildId, 'determined strikes applied').catch(() => null);
  if (determined.strikeAway) {
    await sendCoachReceipt(thread.guild, info.awayRoleIds || [], {
      title: 'Determined Strike Applied',
      description: `${info.awayTeam || 'Your team'} received a determined strike from deadline thread review.`,
      fields: [
        { name: 'Thread', value: `<#${threadId}>` },
        { name: 'Reason', value: determined.reason },
      ],
      color: 0xED4245,
    }).catch(() => null);
  }
  if (determined.strikeHome) {
    await sendCoachReceipt(thread.guild, info.homeRoleIds || [], {
      title: 'Determined Strike Applied',
      description: `${info.homeTeam || 'Your team'} received a determined strike from deadline thread review.`,
      fields: [
        { name: 'Thread', value: `<#${threadId}>` },
        { name: 'Reason', value: determined.reason },
      ],
      color: 0xED4245,
    }).catch(() => null);
  }

  for (const roleId of info.awayRoleIds || []) {
    for (const userId of awayUsers) {
      await queueRemovalReview(interaction.client, interaction.guildId, { seasonKey, userId, roleId, teamName: info.awayTeam }).catch(() => null);
      await queueImmediateRemedyReview(interaction.client, interaction.guildId, { seasonKey, userId, roleId, teamName: info.awayTeam }).catch(() => null);
    }
  }
  for (const roleId of info.homeRoleIds || []) {
    for (const userId of homeUsers) {
      await queueRemovalReview(interaction.client, interaction.guildId, { seasonKey, userId, roleId, teamName: info.homeTeam }).catch(() => null);
      await queueImmediateRemedyReview(interaction.client, interaction.guildId, { seasonKey, userId, roleId, teamName: info.homeTeam }).catch(() => null);
    }
  }

  await thread.send({ content: appliedLines.join('\n') || 'Determined strikes applied.' }).catch(() => null);
  await interaction.reply({ content: 'Determined strikes applied.', ephemeral: true });
}

export default { customId, execute };
