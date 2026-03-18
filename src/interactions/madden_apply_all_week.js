import { ButtonInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';
import { listThreadStates, collectParticipation, buildProjectedOutcome, getThreadState } from '../shared/madden_thread_notifier.js';

export const customId = /^madden_apply_all_week\|([^|]+)\|([^|]+)(?:\|confirm)?$/;

function safeActionFromProjected(info, projected) {
    const status = String(info?.status || 'pending').toLowerCase();
    if (status !== 'pending') return null;

    // If communication exists, do not auto-apply.
    if (projected?.strikeAway === false && projected?.strikeHome === false) return null;

    const type = String(projected?.recommended?.type || 'unknown');
    if (type === 'cpu') return { action: 'cpu', label: projected?.recommended?.label || 'CPU', needsConfirm: false };
    if (type === 'force_win_home') return { action: 'homewin', label: projected?.recommended?.label || 'FW Home', needsConfirm: false };
    if (type === 'force_win_away') return { action: 'awaywin', label: projected?.recommended?.label || 'FW Away', needsConfirm: false };
    if (type === 'fair_sim') return { action: 'fairsim', label: projected?.recommended?.label || 'Fair Sim', needsConfirm: true };

    // Determined strikes (non-response) is the remaining “safe” auto path.
    if (projected?.strikeAway || projected?.strikeHome) return { action: 'determined_strikes', label: 'Determined Strikes', needsConfirm: false };

    return null;
}

function parseArgs(customIdValue) {
    const parts = String(customIdValue || '').split('|');
    return {
        seasonKey: parts[1] || null,
        weekIndexRaw: parts[2] || 'unknown',
        confirm: parts.includes('confirm'),
    };
}

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    const { seasonKey, weekIndexRaw, confirm } = parseArgs(interaction.customId);
    if (!seasonKey) return;

    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
        await interaction.reply({ content: 'Only staff can apply week outcomes.', ephemeral: true });
        return;
    }

    const weekIndex = weekIndexRaw === 'unknown' ? null : Number(weekIndexRaw);

    if (!confirm) {
        const confirmButton = new ButtonBuilder()
            .setCustomId(`madden_apply_all_week|${seasonKey}|${weekIndexRaw}|confirm`)
            .setLabel('CONFIRM: Apply All Outcomes')
            .setStyle(ButtonStyle.Danger);

        await interaction.reply({
            content: [
                '**Apply All Outcomes (Week)**',
                'This will automatically close any *pending* thread that has a safe, non-response outcome:',
                '- CPU / FW / Fair Sim (queues fair-sim confirm)',
                '- Determined Strikes (only when the thread is silent / no comms evidence)',
                '',
                'Press the confirm button to proceed.'
            ].join('\n'),
            ephemeral: true,
            components: [new ActionRowBuilder().addComponents(confirmButton)],
        });
        return;
    }

    const states = listThreadStates();
    const candidates = Object.values(states?.threads || states || {}).filter(Boolean);

    let applied = 0;
    let skipped = 0;
    let fairSimQueued = 0;
    let strikesApplied = 0;

    const { execute: executeGameStatus } = await import('./madden_game_status_buttons.js');
    const { execute: executeDetermined } = await import('./madden_apply_determined_strikes.js');

    for (const rawInfo of candidates) {
        const info = rawInfo?.threadId ? rawInfo : getThreadState(rawInfo?.id);
        if (!info) continue;

        if (String(info?.status || 'pending').toLowerCase() !== 'pending') continue;
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
        const safe = safeActionFromProjected(info, projected);

        if (!safe) {
            skipped += 1;
            continue;
        }

        try {
            if (safe.action === 'determined_strikes') {
                const proxy = { ...interaction, customId: `madden_apply_determined_strikes|${threadId}`, isButton: () => true };
                await executeDetermined(proxy);
                applied += 1;
                strikesApplied += 1;
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
            await executeGameStatus(proxyInteraction);
            applied += 1;
            if (safe.needsConfirm) fairSimQueued += 1;
        } catch {
            skipped += 1;
        }
    }

    await interaction.reply({
        content: [
            '**Apply All Outcomes complete**',
            `Applied: ${applied}`,
            `Determined-strike outcomes applied: ${strikesApplied}`,
            `Fair Sim queued (needs its normal confirm): ${fairSimQueued}`,
            `Skipped: ${skipped}`,
        ].join('\n'),
        ephemeral: true,
    });
}

export default { customId, execute };
