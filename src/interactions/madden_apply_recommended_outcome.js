import { ButtonInteraction } from 'discord.js';
import { getThreadState, collectParticipation, buildProjectedOutcome } from '../shared/madden_thread_notifier.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';

export const customId = /^madden_apply_recommended_outcome\|([^|]+)$/;

function determineActionFromRecommendation(recommended) {
    const type = String(recommended?.type || 'unknown');
    if (type === 'cpu') return { action: 'cpu', needsConfirm: false };
    if (type === 'fair_sim') return { action: 'fairsim', needsConfirm: true };
    if (type === 'force_win_home') return { action: 'homewin', needsConfirm: false };
    if (type === 'force_win_away') return { action: 'awaywin', needsConfirm: false };
    return { action: null, needsConfirm: false };
}

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    const [, threadId] = interaction.customId.match(customId) || [];
    if (!threadId) return;

    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
        await interaction.reply({ content: 'Only staff can apply recommended outcomes.', flags: 64 });
        return;
    }

    const thread = await interaction.client.channels.fetch(threadId).catch(() => null);
    const info = getThreadState(threadId);
    if (!thread || !thread.isTextBased?.() || !info) {
        await interaction.reply({ content: 'Thread state was not found for this matchup.', flags: 64 });
        return;
    }
    if (String(info.status || 'pending') !== 'pending') {
        await interaction.reply({ content: 'This matchup has already been resolved.', flags: 64 });
        return;
    }

    const participation = await collectParticipation(thread, info);
    const projected = buildProjectedOutcome(info, participation);
    const recommended = projected?.recommended;
    const { action, needsConfirm } = determineActionFromRecommendation(recommended);

    if (!action) {
        await interaction.reply({
            content: 'No safe recommended outcome is available for this thread (it may have communication, or requires manual staff judgment).',
            flags: 64,
        });
        return;
    }

    // Safety: only apply auto-outcomes when the model is actually calling for a non-response style closure.
    // If communication exists, we should not auto-FW/FS.
    if (projected?.strikeAway === false && projected?.strikeHome === false) {
        await interaction.reply({
            content: 'This thread shows communication/scheduling evidence. Recommended action is to use the appropriate outcome button manually, not auto-apply a non-response outcome.',
            flags: 64,
        });
        return;
    }

    const awayEnc = encodeURIComponent(info.awayTeam || 'Away');
    const homeEnc = encodeURIComponent(info.homeTeam || 'Home');
    const proxyCustomId = `madden_game_status_${action}|${threadId}|${awayEnc}|${homeEnc}`;

    // We proxy into the existing button handler to ensure all logs, strike-limits, receipts, and disables are reused.
    const { execute: executeGameStatus } = await import('./madden_game_status_buttons.js');

    const proxyInteraction = {
        ...interaction,
        customId: proxyCustomId,
        isButton: () => true,
        // The underlying handler expects ButtonInteraction. We keep the real interaction object and only override customId.
    };

    if (needsConfirm) {
        // Fair Sim is a 2-step confirm; staff is allowed but still requires another press.
        await interaction.reply({
            content: `Queued recommended outcome: **${recommended?.label || 'Fair Sim'}**. This action requires the Fair Sim confirmation flow — press the Fair Sim button again (or have the other side confirm) to finalize.`,
            flags: 64,
        });
        // Fire the first press into the fair-sim pending flow.
        await executeGameStatus(proxyInteraction);
        return;
    }

    // For FW/CPU we can execute immediately.
    await interaction.reply({
        content: `Applying recommended outcome: **${recommended?.label || action}**`,
        flags: 64,
    });
    await executeGameStatus(proxyInteraction);
}

export default { customId, execute };
