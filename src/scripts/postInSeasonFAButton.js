import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelId = '1455148525179502602';

if (!token) {
  console.error('[postInSeasonFAButton] Missing DISCORD_TOKEN/TOKEN in environment.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw new Error('Target channel not found or not text-based.');

    const embed = new EmbedBuilder()
      .setTitle('In-Season Free Agent Signings')
      .setDescription(
        [
          'Click the button to sign an available free agent. List is limited to the first 25 alphabetically; contact staff if someone is missing.',
          'Player is moved from Free Agency to your roster automatically.',
        ].join('\n'),
      )
      .setColor(0x5865f2);

    const button = new ButtonBuilder()
      .setCustomId('inseason_fa_button')
      .setLabel('Select Free Agent')
      .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    try {
      await message.pin();
      console.log('[postInSeasonFAButton] Message sent and pinned.');
    } catch (pinErr) {
      console.error('[postInSeasonFAButton] Sent message but failed to pin:', pinErr);
    }
  } catch (err) {
    console.error('[postInSeasonFAButton] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
