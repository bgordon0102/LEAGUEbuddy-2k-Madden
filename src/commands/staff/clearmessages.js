
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

const data = new SlashCommandBuilder()
  .setName('clearmessages')
  .setDescription('Clear messages in the current thread or text channel.')
  .addStringOption(option =>
    option.setName('amount')
      .setDescription('Number of messages to delete or "all"')
      .setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function execute(interaction) {
  console.log('[DEBUG] clearmessages.js execute called');
  let deferred = false;
  try {
    await interaction.deferReply({ ephemeral: true });
    deferred = true;
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    console.error('[clearmessages] Error deferring reply:', err);
    return;
  }
  try {
    const amountArg = interaction.options.getString('amount').toLowerCase();
    const channel = interaction.channel;
    if (!channel || (!channel.isTextBased() && !channel.isThread())) {
      console.log('[DEBUG] Not a text or thread channel');
      if (deferred) {
        await interaction.editReply({ content: 'This command can only be used in threads or text channels.' });
      }
      return;
    }
    if (amountArg === 'all') {
      // Fetch all messages and delete in batches of 100
      let totalDeleted = 0;
      while (true) {
        const fetched = await channel.messages.fetch({ limit: 100 });
        const toDelete = fetched.filter(m => !m.pinned);
        if (!toDelete.size) break;
        const deleted = await channel.bulkDelete(toDelete, true).catch(err => console.error(err));
        const deletedCount = deleted?.size || 0;
        totalDeleted += deletedCount;
        console.log(`[DEBUG] Deleted ${totalDeleted} messages so far...`);
        if (deletedCount === 0) {
          // No more deletable messages (likely too old), avoid looping forever
          break;
        }
      }
      console.log('[DEBUG] All messages deleted');
      if (deferred) await interaction.editReply({ content: `All messages deleted in this channel. Total: ${totalDeleted}` });
    } else {
      const amount = parseInt(amountArg);
      if (isNaN(amount) || amount < 1) {
        console.log('[DEBUG] Invalid amount');
        if (deferred) await interaction.editReply({ content: 'Please provide a valid number of messages to delete.' });
        return;
      }
      const fetchAmount = Math.min(amount + 10, 100); // fetch a few extra to account for pinned skips
      const fetched = await channel.messages.fetch({ limit: fetchAmount });
      const unpinned = fetched.filter(m => !m.pinned);
      const toDelete = unpinned.first(amount);
      if (!toDelete || toDelete.length === 0) {
        if (deferred) await interaction.editReply({ content: 'No messages available to delete (pins are preserved).' });
        return;
      }
      const deleted = await channel.bulkDelete(toDelete, true);
      console.log(`[DEBUG] Deleted ${deleted?.size || toDelete.length} messages (unpinned only).`);
      if (deferred) await interaction.editReply({ content: `Deleted ${deleted?.size || toDelete.length} unpinned messages. Pinned messages are preserved.` });
    }
  } catch (err) {
    console.error('Error deleting messages:', err);
    try {
      if (deferred) await interaction.editReply({ content: 'Error deleting messages.' });
    } catch {}
  }
}

export default { data, execute };
