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
          'This is where you can post official re-signings of your players.',
          '',
          'Re-Signing Window',
          'Opens after NBA Finals, lasts 48 hours',
          '',
          'Re-sign your own players during priority window before unrestricted signings',
          '',
          'Submit your offers here with this format:',
          'Player Name – OVR – Years – Salary Per Year',
          '',
          'Example:',
          'Julius Randle – 86 OVR – 3 Years – $18M per year',
          '',
          'Commissioners will review and confirm offers',
          '',
          'Unsigned players after 48 hours enter free agency',
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
