import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelId = '1425556300405670021';

if (!token) {
  console.error('[postAwardsButton] Missing DISCORD_TOKEN/TOKEN in environment.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw new Error('Target channel not found or not text-based.');

    const embed = new EmbedBuilder()
      .setTitle('Season Awards (Staff)')
      .setDescription(
        [
          'Staff: after the season ends and before playoffs, click below to enter the five major award winners.',
          'MVP, Rookie of the Year, Sixth Man, Most Improved, Defensive Player of the Year.',
          'Bot will post an embed per winner with their thumbnail and season number (Ghost Paradise tagged).',
        ].join('\n'),
      )
      .setColor(0xFFD700);

    const button = new ButtonBuilder()
      .setCustomId('awards_button')
      .setLabel('Enter Award Winners')
      .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    try {
      await message.pin();
      console.log('[postAwardsButton] Message sent and pinned.');
    } catch (pinErr) {
      console.error('[postAwardsButton] Sent message but failed to pin:', pinErr);
    }
  } catch (err) {
    console.error('[postAwardsButton] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
