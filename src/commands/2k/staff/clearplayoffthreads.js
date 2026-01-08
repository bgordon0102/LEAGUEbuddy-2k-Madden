import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const PLAYOFF_CHANNEL_ID = '1455100196315861126';

export const data = new SlashCommandBuilder()
  .setName('clearplayoffthreads')
  .setDescription('Delete all playoff threads in the playoff channel')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const safeReply = async (payload) => {
    try {
      await interaction.editReply(payload);
    } catch (err) {
      if (err?.code !== 10008) { // ignore Unknown Message
        console.error('[clearplayoffthreads] Reply failed:', err);
      }
      try { await interaction.followUp({ ...payload, flags: 64 }); } catch {}
    }
  };
  try {
    const channel = await interaction.guild.channels.fetch(PLAYOFF_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      await safeReply({ content: 'Playoff channel not found or not text-based.' });
      return;
    }
    const threads = await channel.threads.fetchActive();
    let deleted = 0;
    for (const thread of threads.threads.values()) {
      try {
        await thread.delete('Clearing playoff threads');
        deleted++;
      } catch (err) {
        console.error('[clearplayoffthreads] Failed to delete thread:', err);
      }
    }
    const archived = await channel.threads.fetchArchived();
    for (const thread of archived.threads.values()) {
      try {
        await thread.delete('Clearing playoff threads');
        deleted++;
      } catch (err) {
        console.error('[clearplayoffthreads] Failed to delete archived thread:', err);
      }
    }
    await safeReply({ content: `Deleted ${deleted} playoff thread(s).` });
  } catch (err) {
    console.error('[clearplayoffthreads] Failed:', err);
    await safeReply({ content: 'Failed to clear playoff threads. Check logs.' });
  }
}

export default { data, execute };
