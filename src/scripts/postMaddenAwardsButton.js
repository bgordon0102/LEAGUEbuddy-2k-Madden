import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelMapPath = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const channelMap = (() => {
  try { return JSON.parse(fs.readFileSync(channelMapPath, 'utf8')); } catch { return {}; }
})();
const channelId = channelMap['Yearly Awards'] || '1459456657229873419';

if (!token) {
  console.error('[postMaddenAwardsButton] Missing DISCORD_TOKEN/TOKEN in environment.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) throw new Error('Target channel not found or not text-based.');

    const embed = new EmbedBuilder()
      .setTitle('Madden Yearly Awards (Staff)')
      .setDescription(
        [
          'Staff: after the season ends and before the next season begins, click below to enter the yearly awards.',
          'MVP, Coach of the Year, OPOY, DPOY, OROY, DROY, Super Bowl Champion, Super Bowl MVP.',
          'Bot will post embeds with player name, team emoji, coach tag, and season number.',
        ].join('\n'),
      )
      .setColor(0xFFD700);

    const button = new ButtonBuilder()
      .setCustomId('madden_awards_button')
      .setLabel('Enter Madden Yearly Awards')
      .setStyle(ButtonStyle.Primary);

    const message = await channel.send({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(button)],
    });

    try {
      await message.pin();
      console.log('[postMaddenAwardsButton] Message sent and pinned.');
    } catch (pinErr) {
      console.error('[postMaddenAwardsButton] Sent message but failed to pin:', pinErr);
    }
  } catch (err) {
    console.error('[postMaddenAwardsButton] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
