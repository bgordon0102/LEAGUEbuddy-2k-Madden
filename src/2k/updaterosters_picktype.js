import { StringSelectMenuInteraction } from 'discord.js';
import { readSelectPending, writeSelectPending, processAndSummarize } from '../2k/staff/updaterosters.js';

export const customId = /^updaterosters_picktype_/;

export async function execute(interaction) {
  if (!(interaction instanceof StringSelectMenuInteraction)) return;
  const id = interaction.customId.replace('updaterosters_picktype_', '');
  const pending = readSelectPending();
  const entry = pending[id];
  if (!entry) {
    await interaction.reply({ content: 'Request not found or expired. Please run /updaterosters again.', ephemeral: true });
    return;
  }
  if (interaction.user.id !== entry.requester) {
    await interaction.reply({ content: 'Only the original requester can select the type.', ephemeral: true });
    return;
  }

  const type = interaction.values?.[0];
  if (!type) {
    await interaction.reply({ content: 'Select a type to continue.', ephemeral: true });
    return;
  }

  delete pending[id];
  writeSelectPending(pending);

  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (err?.code === 10062) return; // expired
    throw err;
  }
  await processAndSummarize(interaction, type, entry.attachmentUrl);
}

export default { customId, execute };
