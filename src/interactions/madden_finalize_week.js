import { ButtonInteraction } from 'discord.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';
import { listThreadStates, getThreadState, collectParticipation, buildProjectedOutcome } from '../shared/madden_thread_notifier.js';

export const customId = /^madden_finalize_week\|([^|]+)\|([^|]+)$/;

function computeSafeAction(projected) {
    const type = String(projected?.recommended?.type || 'unknown');
    if (type === 'cpu') return { action: 'cpu', label: projected?.recommended?.label || 'CPU', needsConfirm: false };
    if (type === 'fair_sim') return { action: 'fairsim', label: projected?.recommended?.label || 'Fair Sim', needsConfirm: true };
    if (type === 'force_win_home') return { action: 'homewin', label: projected?.recommended?.label || 'FW Home', needsConfirm: false };
    if (type === 'force_win_away') return { action: 'awaywin', label: projected?.recommended?.label || 'FW Away', needsConfirm: false };
    return null;
}

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    const [, seasonKey, weekIndexRaw] = interaction.customId.match(customId) || [];
    if (!seasonKey) return;

    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
        await interaction.reply({ content: 'Only staff can finalize a week.', ephemeral: true });
        return;
    }

    const confirm = interaction.customId.includes('|confirm');
    if (!confirm) {
        await interaction.reply({
            content: [
                '**Finalize Week (safe automation)**',
                'This applies only *safe* recommended outcomes for pending games:',
                '- CPU / FW / (Fair Sim first-step only)',
                '- Skips anything where communication exists / recommendation is not actionable.',
                '',
                'Press again to confirm.'
            ].join('\n'),
            ephemeral: true,
        });

        // swap button to confirm in-place
        try {
            const msg = interaction.message;
            const rows = msg?.components || [];
            const updated = rows.map((row) => {
                const r = { ...row };
                r.components = row.components.map((c) => {
                    if (c.customId === interaction.customId) {
                        return { ...c, customId: `${interaction.customId}|confirm`, label: 'Finalize Week (CONFIRM)' };
                    }
                    return c;
                });
                return r;
            });
            await interaction.message.edit({ components: updated });
        } catch {
            // ignore
        }
        return;
    }

    const weekIndex = weekIndexRaw === 'unknown' ? null : Number(weekIndexRaw);
    const states = listThreadStates();
    const candidates = Object.values(states?.threads || states || {}).filter(Boolean);

    let applied = 0;
    let skipped = 0;
    let fairSimQueued = 0;

    // Reuse existing outcome logic by proxying into the madden_game_status_buttons handler.
    const { execute: executeGameStatus } = await import('./madden_game_status_buttons.js');

    for (const info of candidates) {
        if (String(info?.status || 'pending') !== 'pending') continue;
        if (info?.seasonKey && String(info.seasonKey) !== String(seasonKey)) continue;
        if (weekIndex != null && Number.isFinite(Number(info?.weekIndex)) && Number(info.weekIndex) !== weekIndex) continue;

        const threadId = String(info.threadId || info.id || '');
        if (!threadId) continue;

        const thread = await interaction.client.channels.fetch(threadId).catch(() => null);
        if (!thread || !thread.isTextBased?.()) {
            skipped += 1;
            continue;
        }

        const participation = await collectParticipation(thread, info);
        const projected = buildProjectedOutcome(info, participation);

        // Safety: if communication exists (both strikes false), don't auto-apply.
        if (projected?.strikeAway === false && projected?.strikeHome === false) {
            skipped += 1;
            continue;
        }

        const safe = computeSafeAction(projected);
        if (!safe) {
            skipped += 1;
            continue;
        }

        const awayEnc = encodeURIComponent(info.awayTeam || 'Away');
        const homeEnc = encodeURIComponent(info.homeTeam || 'Home');
        const proxyCustomId = `madden_game_status_${safe.action}|${threadId}|${awayEnc}|${homeEnc}`;

        const proxyInteraction = {
            ...interaction,
            customId: proxyCustomId,
            isButton: () => true,
            reply: async () => { },
            deferUpdate: async () => { },
            editReply: async () => { },
        };

        try {
            await executeGameStatus(proxyInteraction);
            applied += 1;
            if (safe.needsConfirm) fairSimQueued += 1;
        } catch {
            skipped += 1;
        }
    }

    await interaction.followUp({
        content: [
            '**Finalize Week complete**',
            `Applied: ${applied}`,
            `Fair Sim queued (needs its normal confirm step): ${fairSimQueued}`,
            `Skipped: ${skipped}`,
        ].join('\n'),
        ephemeral: true,
    });
}

export default { customId, execute };
