import { SlashCommandBuilder } from 'discord.js';
import { loadRoleMap, hasStaffRole } from './staffUtils.js';
import { loadStrikeStore, saveStrikeStore } from '../../shared/madden_strikes.js';

export const data = new SlashCommandBuilder()
    .setName('madden-clearstrikes')
    .setDescription('STAFF: Clear all Madden strike/fairsim totals for a season (DANGEROUS).')
    .addStringOption((opt) =>
        opt
            .setName('season')
            .setDescription("Season key (e.g., 'year_2026'). Leave blank to clear all seasons.")
            .setRequired(false)
    )
    .addBooleanOption((opt) =>
        opt
            .setName('confirm')
            .setDescription('Must be true to actually clear strike data.')
            .setRequired(false)
    )
    .setDefaultMemberPermissions(null);

// Let the global command dispatcher handle the initial defer.
// This avoids DiscordAPIError[40060] if we ever double-acknowledge.
export const deferOnDispatch = { flags: 64 };

export async function execute(interaction) {
    // NOTE: `app.js` is expected to defer for us via `deferOnDispatch`.
    // Do NOT call `deferReply()` here; this command previously hit 40060 (double-ack).

    const roleMap = loadRoleMap();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.' });
        } else {
            await interaction.reply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.', flags: 64 });
        }
        return;
    }

    const season = interaction.options.getString('season');
    const confirm = interaction.options.getBoolean('confirm') === true;

    if (!confirm) {
        const payload = {
            content: [
                'This will **permanently clear** fair sim / strike totals stored in `data/madden/fairsims.json`.',
                '',
                `Target: ${season ? `season=${season}` : 'ALL SEASONS'}`,
                '',
                'Re-run with `confirm: true` to proceed.'
            ].join('\n'),
        };
        if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
        else await interaction.reply({ ...payload, flags: 64 });
        return;
    }

    const store = loadStrikeStore();
    const beforeSeasons = Object.keys(store || {});

    if (season) {
        delete store[season];
    } else {
        for (const key of beforeSeasons) delete store[key];
    }

    saveStrikeStore(store);

    const afterSeasons = Object.keys(store || {});
    const payload = {
        content: [
            '✅ Cleared strike store.',
            `Before seasons: ${beforeSeasons.length ? beforeSeasons.join(', ') : '(none)'}`,
            `After seasons: ${afterSeasons.length ? afterSeasons.join(', ') : '(none)'}`,
        ].join('\n'),
    };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
}

export default { data, execute };
