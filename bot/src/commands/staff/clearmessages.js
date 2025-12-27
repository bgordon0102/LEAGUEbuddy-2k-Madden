
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
  await interaction.deferReply({ ephemeral: true });
  try {
    const amountArg = interaction.options.getString('amount').toLowerCase();
    const channel = interaction.channel;
    if (!channel || (!channel.isTextBased() && !channel.isThread())) {
      console.log('[DEBUG] Not a text or thread channel');
      await interaction.editReply({ content: 'This command can only be used in threads or text channels.' });
      return;
    }
    if (amountArg === 'all') {
      let totalDeleted = 0;
      let loopCount = 0;
      const maxLoops = 10; // Prevent infinite loops
      while (loopCount < maxLoops) {
        let fetched;
        try {
          fetched = await channel.messages.fetch({ limit: 100 });
        } catch (fetchErr) {
          console.error('[clearmessages] Error fetching messages:', fetchErr);
          break;
        }
        if (!fetched || fetched.size === 0) {
          console.log('[clearmessages] No more messages to delete.');
          break;
        }
        let deleted;
        try {
          deleted = await channel.bulkDelete(fetched, true);
        } catch (bulkErr) {
          console.error('[clearmessages] Error during bulkDelete:', bulkErr);
          break;
        }
        const deletedCount = deleted?.size || 0;
        totalDeleted += deletedCount;
        console.log(`[DEBUG] Deleted ${deletedCount} messages this batch, total: ${totalDeleted}`);
        await interaction.followUp({ content: `Deleted ${deletedCount} messages this batch, total: ${totalDeleted}`, ephemeral: true });
        // If nothing was deleted, stop to prevent infinite loop
        if (deletedCount === 0) {
          console.log('[clearmessages] No deletable messages found in this batch. Stopping.');
          break;
        }
        // If fewer than 2 messages left, stop
        if (fetched.size < 2) break;
        loopCount++;
      }
      if (loopCount === maxLoops) {
        console.warn('[clearmessages] Max delete loops reached. Stopping to prevent infinite loop.');
      }
      await interaction.editReply({ content: `All possible messages deleted in this channel. Total: ${totalDeleted}` });
    } else {
      const amount = parseInt(amountArg);
      if (isNaN(amount) || amount < 1) {
        console.log('[DEBUG] Invalid amount');
        await interaction.editReply({ content: 'Please provide a valid number of messages to delete.' });
        return;
      }
      const deleteAmount = Math.min(amount, 100); // Discord bulkDelete limit
      let deleted;
      try {
        deleted = await channel.bulkDelete(deleteAmount, true);
      } catch (bulkErr) {
        console.error('[clearmessages] Error during bulkDelete:', bulkErr);
        await interaction.editReply({ content: 'Error deleting messages.' });
        return;
      }
      console.log(`[DEBUG] Deleted ${deleted?.size || 0} messages.`);
      await interaction.editReply({ content: `Deleted ${deleted?.size || 0} messages.` });
    }
  } catch (err) {
    console.error('Error deleting messages:', err);
    await interaction.editReply({ content: 'Error deleting messages.' });
  }
}

export default { data, execute };
