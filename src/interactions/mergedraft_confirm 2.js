import { ButtonInteraction } from 'discord.js';
import { confirmMerge } from '../commands/2k/staff/mergedraft.js';

export const customId = /^mergedraft_confirm_(\d+)/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const match = interaction.customId.match(/^mergedraft_confirm_(\d+)/);
  if (!match) return;
  const classNo = parseInt(match[1], 10);
  try {
    await interaction.deferUpdate();
  } catch {}
  await confirmMerge(interaction, classNo);
}

export default { customId, execute };
