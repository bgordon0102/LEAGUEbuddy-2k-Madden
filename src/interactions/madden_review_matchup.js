import { ButtonInteraction } from 'discord.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';
import { getThreadState } from '../shared/madden_thread_notifier.js';

export const customId = /^madden_review_matchup\|([^|]+)$/;

export async function execute(interaction) {
    if (!(interaction instanceof ButtonInteraction)) return;
    const [, threadId] = interaction.customId.match(customId) || [];
    if (!threadId) return;

    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
        await interaction.reply({ content: 'Only staff can use this.', ephemeral: true });
        return;
    }

    const info = getThreadState(threadId);
    const away = info?.awayTeam || 'Away';
    const home = info?.homeTeam || 'Home';

    await interaction.reply({
        content: [
            `Manual review for **${away} vs ${home}**.`,
            `Thread: <#${threadId}>`,
            'Use the outcome buttons inside the thread to close it (Completed / FW / Fair Sim / CPU).'
        ].join('\n'),
        ephemeral: true,
    });
}

export default { customId, execute };
