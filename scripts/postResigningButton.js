import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelId = process.env.RESIGNING_CHANNEL_ID || '1425556463522414704';

if (!token) {
  console.error('[postResigningButton] Missing DISCORD_TOKEN/TOKEN in environment.');
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
      .setTitle('Re-Signing Window')
      .setDescription(
        [
          'Official re-signings for your own players only. Use the button to submit; do not post offers manually.',
          'Opens after NBA Finals and lasts 48 hours.',
          'Include Player – OVR – Terms (years/salary). Example: Julius Randle – 86 OVR – 3 years, $18M per year.',
          'Staff will approve/deny; unsigned after 48 hours become free agents.',
          '',
          'Click the button below to submit your re-signing offer.',
        ].join('\n'),
      )
      .setColor(0x1e90ff);

    const button = new ButtonBuilder()
      .setCustomId('resigning_submit_button')
      .setLabel('Submit Re-Signing Offer')
      .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    try {
      await message.pin();
      console.log('[postResigningButton] Message sent and pinned.');
    } catch (pinErr) {
      console.error('[postResigningButton] Sent message but failed to pin:', pinErr);
    }
  } catch (err) {
    console.error('[postResigningButton] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
