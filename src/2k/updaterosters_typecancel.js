import { ButtonInteraction } from 'discord.js';
import { readSelectPending, writeSelectPending } from '../2k/staff/updaterosters.js';

export const customId = /^updaterosters_typecancel_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const id = interaction.customId.replace('updaterosters_typecancel_', '');
  const pending = readSelectPending();
  if (pending[id]) {
    delete pending[id];
    writeSelectPending(pending);
  }
  try {
    await interaction.update({ content: 'Update canceled.', components: [] });
  } catch (err) {
    if (err?.code !== 10062) throw err;
  }
}

export default { customId, execute };
