import { ButtonInteraction, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { loadContentQueue, saveContentQueue, countPendingRumorReviews, getRumorPendingPolicy } from '../shared/madden_content_review_queue.js';
import { hasStaffRole, loadRoleMap } from '../madden/staff/staffUtils.js';
import { appendMaddenStaffLog, postMaddenStaffDecision } from '../shared/madden_staff_ops.js';
import { queueScheduledRumorMill } from '../shared/madden_staff_ops.js';
import { recordRumorReviewFeedback } from '../shared/madden_rumor_feedback.js';

export const customId = /^madden_content_review\|(approve|deny)\|(.+)$/;

function disableRows(rows = []) {
  return rows.map((row) => {
    const nextRow = ActionRowBuilder.from(row);
    nextRow.components = nextRow.components.map((component) => ButtonBuilder.from(component).setDisabled(true));
    return nextRow;
  });
}

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = interaction.customId.match(customId);
  if (!match) return;
  const [, action, reviewId] = match;
  try { await interaction.deferReply({ flags: 64 }); } catch { return; }

  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can review content.' });
    return;
  }

  const queue = loadContentQueue();
  const item = queue[reviewId];
  if (!item) {
    await interaction.editReply({ content: 'Review item not found.' });
    return;
  }
  if (item.status !== 'pending') {
    await interaction.editReply({ content: `This item has already been ${item.status}.` });
    return;
  }

  if (action === 'approve') {
    const target = await interaction.client.channels.fetch(item.targetChannelId).catch(() => null);
    if (!target?.isTextBased()) {
      await interaction.editReply({ content: 'Target channel could not be reached.' });
      return;
    }
    await target.send({
      content: item.content || null,
      embeds: item.embeds || [],
      allowedMentions: item.postAllowedMentions || item.allowedMentions || { parse: [] },
    });
  }

  item.status = action === 'approve' ? 'approved' : 'denied';
  item.reviewedBy = interaction.user.id;
  item.reviewedAt = Date.now();
  queue[reviewId] = item;
  saveContentQueue(queue);
  if (item.kind === 'rumor_mill') {
    recordRumorReviewFeedback({
      guildId: interaction.guildId,
      action,
      item,
      reviewedBy: interaction.user.id,
    });
  }
  appendMaddenStaffLog({
    type: 'content_review',
    guildId: interaction.guildId,
    reviewId,
    kind: item.kind,
    action,
    reviewedBy: interaction.user.id,
    targetChannelId: item.targetChannelId,
  });
  if (item.kind !== 'rumor_mill') {
    await postMaddenStaffDecision(
      interaction.client,
      interaction.guildId,
      'Content Review',
      `<@${interaction.user.id}> ${action}d ${item.kind || 'content'} review ${reviewId}.`,
    ).catch(() => null);
  }

  if (item.kind === 'rumor_mill') {
    await interaction.message.delete().catch(() => null);
  } else {
    await interaction.message.edit({
      components: disableRows(interaction.message.components),
    }).catch(() => null);
  }

  if (item.kind === 'rumor_mill') {
    const pendingPolicy = getRumorPendingPolicy();
    const nextPendingCount = countPendingRumorReviews(queue, interaction.guildId);
    if (nextPendingCount < Math.max(2, pendingPolicy.target - 2)) {
      await queueScheduledRumorMill(interaction.client, interaction.guildId).catch(() => null);
    }
  }

  await interaction.editReply({ content: action === 'approve' ? 'Content approved and posted.' : 'Content denied.' });
}

export default { customId, execute };
