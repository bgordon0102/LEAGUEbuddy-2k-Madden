import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../../../madden/madden_data.js';
import { getTop100Page } from '../../../madden/top_players.js';

// Slash command builder
export const data = new SlashCommandBuilder()
  .setName('madden-top100test')
  .setDescription('View the Madden Top 100 players (latest data)')
  .setDefaultMemberPermissions(null);

async function safeRespond(interaction, payload, { button = false } = {}) {
  try {
    // Replace deprecated ephemeral with flags where possible
    if (payload?.ephemeral && !payload?.flags) {
      payload.flags = 64; // EPHEMERAL
      delete payload.ephemeral;
    }
    if (button) {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.update(payload);
      }
    } else {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    }
    return true;
  } catch (err) {
    if ([10062, 40060, 50027].includes(err?.code)) {
      // Interaction is gone; best effort ephemeral follow-up, otherwise silently drop.
      try {
        await interaction.followUp({ content: 'Interaction expired. Please run /madden-top100test again.', flags: 64 });
      } catch { /* ignore */ }
      return false;
    }
    throw err;
  }
}

// Shared renderer for both slash and button interactions
async function render(interaction, page = 1, opts = {}) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await safeRespond(interaction, { content: 'No league set. Run /madden-set-league first.', ephemeral: true }, opts);
    return;
  }

  const { embed, totalPages } = getTop100Page(leagueId, page);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_top100test_prev|${page}|${totalPages}`)
      .setLabel('Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`madden_top100test_next|${page}|${totalPages}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages)
  );

  const replyPayload = { embeds: [embed], components: [row], ephemeral: true };

  await safeRespond(interaction, replyPayload, opts);
}

export async function execute(interaction) {
  const isButton = interaction.isButton?.() && interaction.customId?.startsWith('madden_top100test_');
  if (isButton) {
    const parts = interaction.customId.split('|'); // e.g., madden_top100test_next|2|5
    const currentPage = Number(parts[1]) || 1;
    const totalPages = Number(parts[2]) || 1;
    const dir = interaction.customId.includes('_next') ? 1 : -1;
    const nextPage = Math.min(totalPages, Math.max(1, currentPage + dir));
    return render(interaction, nextPage, { button: true });
  }

  // Slash command
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if ([10062, 40060, 50027].includes(err?.code)) return;
  }
  return render(interaction, 1, { button: false });
}

export default { data, execute };
