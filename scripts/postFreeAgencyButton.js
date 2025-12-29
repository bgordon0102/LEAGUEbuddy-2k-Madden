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
          'This is where you submit your free agency offers.',
          '',
          'Free Agency System (Tier-Based)',
          '',
          'All signings must be posted here with player name, overall rating (OVR), contract length, and salary.',
          '',
          'No signing players from other league teams during the first 48 hours',
          'No signing players until all 80+ overall free agents have been signed',
          '',
          'Re-sign your own players during priority window before unrestricted signings',
          '',
          'Signing limits by Tier:',
          '• Tier 1: 1 × 80–84 overall free agent per offseason',
          '• Tier 2: 1 × 85+ & 1 × 80–84 overall free agent',
          '• Tier 3: 1 × 85+ & 2 × 80–84 overall free agents',
          '• Tier 4: 2 × 85+ & 2 × 80–84 overall free agents',
          '• Tier 5: 2 × 85+ & 3 × 80–84 overall free agents',
          '',
          'Submit your offers here with this format:',
          'Player Name – OVR – Years – Salary Per Year',
          '',
          'Example:',
          'Julius Randle – 86 OVR – 3 Years – $18M per year',
          '',
          'Commissioners will enforce rules and investigate tanking or collusion',
        ].join('\n'),
      )
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setCustomId('freeagency_submit_button')
      .setLabel('Submit Free Agency Offer')
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
