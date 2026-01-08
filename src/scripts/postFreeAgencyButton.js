import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelId = process.env.FREE_AGENCY_CHANNEL_ID || '1428099138431746250';

if (!token) {
  console.error('[postFreeAgencyButton] Missing DISCORD_TOKEN/TOKEN in environment.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error('Target channel not found or not text-based.');
    }

    const embed = new EmbedBuilder()
      .setTitle('Free Agency System (Tier-Based)')
      .setDescription(
        [
          'Staff: use the button to add free agents as offer cards. Coaches: click the Submit Offer button on each player card (no manual posts).',
          'Include: Player – OVR – Years – Salary per year. Example: Julius Randle – 86 OVR – 3 Years – $18M per year.',
          'During the first 48 hours: no signing players from other league teams, and no signings until all 80+ OVR free agents are signed.',
          'Re-sign your own players during the priority window before unrestricted signings.',
          'Tier limits per offseason:',
          '• Tier 1: 1 × 80–84 OVR FA',
          '• Tier 2: 1 × 85+ & 1 × 80–84 OVR FA',
          '• Tier 3: 1 × 85+ & 2 × 80–84 OVR FAs',
          '• Tier 4: 2 × 85+ & 2 × 80–84 OVR FAs',
          '• Tier 5: 2 × 85+ & 3 × 80–84 OVR FAs',
          '',
          'Tap the button to submit your offer; staff will review and finalize.',
        ].join('\n'),
      )
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setCustomId('freeagency_staff_add_button')
      .setLabel('Staff: Add Free Agent')
      .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    try {
      await message.pin();
      console.log('[postFreeAgencyButton] Message sent and pinned.');
    } catch (pinErr) {
      console.error('[postFreeAgencyButton] Sent message but failed to pin:', pinErr);
    }
  } catch (err) {
    console.error('[postFreeAgencyButton] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
