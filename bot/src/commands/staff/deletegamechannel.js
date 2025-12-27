import { SlashCommandBuilder, ChannelType } from 'discord.js';

export const data = new SlashCommandBuilder()
    .setName('deletegamechannel')
    .setDescription('Delete all game channels for a given week')
    .addIntegerOption(option =>
        option.setName('week')
            .setDescription('Week number to delete channels for')
            .setRequired(true)
    );

export async function execute(interaction) {
    let replyFailed = false;
    let replyMethod = async (msg, forceSuccess = false) => {
        let finalMsg = msg;
        if (forceSuccess) finalMsg = '✅ Success! ' + (msg || 'Channels deleted.');
        if (!replyFailed) {
            try {
                await interaction.editReply({ content: finalMsg });
            } catch (e) {
                replyFailed = true;
            }
        }
        if (replyFailed) {
            try {
                await interaction.followUp({ content: finalMsg, ephemeral: true });
            } catch (e) {
                console.log(`[deletegamechannel] Could not send follow-up for interaction ${interaction.id}`);
            }
        }
    };
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (err) {
        // Fallback: some interaction tokens can be unknown (timed out or already responded).
        console.error('[deletegamechannel] Error deferring reply:', err);
        // Try to send an initial reply instead of deferring
        try {
            await interaction.reply({ content: 'Processing deletegamechannel...', ephemeral: true });
            // Mark that we have replied so editReply can be used later
            replyFailed = false;
        } catch (replyErr) {
            // If even reply fails, mark replyFailed so we don't attempt edits
            console.error('[deletegamechannel] Could not send initial reply fallback:', replyErr);
            replyFailed = true;
        }
    }
    try {
        const guild = interaction.guild;
        const week = interaction.options.getInteger('week');
        // Use the dedicated channel ID used by advanceweek (ensure it's the correct channel in your guild)
        const dedicatedChannelId = '1428417230000885830';
        let dedicatedChannel = null;
        try {
            dedicatedChannel = await guild.channels.fetch(dedicatedChannelId);
        } catch (fetchErr) {
            console.error('[deletegamechannel] Failed to fetch dedicated channel:', fetchErr);
        }
        if (!dedicatedChannel) {
            await replyMethod(`❌ Error: Dedicated channel (id=${dedicatedChannelId}) not found or inaccessible.`);
            return;
        }
        // Ensure the channel supports threads
        if (typeof dedicatedChannel.isTextBased === 'function' && !dedicatedChannel.isTextBased()) {
            await replyMethod('❌ Dedicated channel must be a text channel that supports threads.');
            return;
        }

        // Fetch active and archived threads to find week threads (some may already be archived)
        let deleted = 0;
        try {
            const active = await dedicatedChannel.threads.fetchActive();
            // fetchArchived may require intents/permissions; fetch a reasonable number
            const archived = await dedicatedChannel.threads.fetchArchived({ limit: 100 });

            // Combine thread collections into a map to avoid duplicates
            const allThreads = new Map();
            for (const t of active.threads.values()) allThreads.set(t.id, t);
            if (archived && archived.threads) for (const t of archived.threads.values()) allThreads.set(t.id, t);

            const weekMarker = `-w${week}`;
            for (const thread of allThreads.values()) {
                const name = (thread.name || '').toLowerCase();
                if (name.includes(weekMarker.toLowerCase()) || name.includes(`week ${week}`)) {
                    try {
                        await thread.delete();
                        deleted++;
                    } catch (e) {
                        console.error(`[deletegamechannel] Failed to delete thread ${thread.name}:`, e);
                    }
                }
            }
        } catch (e) {
            console.error('[deletegamechannel] Error fetching threads:', e);
            await replyMethod('❌ Error fetching threads from the dedicated channel. Check bot permissions.');
            return;
        }
        let replyMsg = `Deleted ${deleted} threads for Week ${week}.`;
        await replyMethod(replyMsg, true);
    } catch (err) {
        console.error('[deletegamechannel] Fatal error:', err);
        await replyMethod('Error clearing week threads.');
    }
}

export default { data, execute };