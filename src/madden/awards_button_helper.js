import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { getPinId, setPinId } from './pins_store.js';

const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export async function ensureMaddenAwardsButton(client) {
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const channelId = channelMap['Yearly Awards'] || channelMap['Awards'] || '1459456657229873419';
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

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

  const components = [new ActionRowBuilder().addComponents(button)];

  const pinId = getPinId('madden_awards_button');
  if (pinId) {
    const msg = await channel.messages.fetch(pinId).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components }).catch(() => null);
      return;
    }
  }

  const message = await channel.send({ embeds: [embed], components });
  try { await message.pin(); } catch { /* ignore */ }
  setPinId('madden_awards_button', message.id);
}
