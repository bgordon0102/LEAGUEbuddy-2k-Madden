import { ButtonInteraction, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const SERIES_STATE_PATH = path.join(process.cwd(), 'data', 'playoff_series.json');

function loadSeriesState() {
  try { return JSON.parse(fs.readFileSync(SERIES_STATE_PATH, 'utf8')); } catch { return {}; }
}
function saveSeriesState(state) {
  try { fs.writeFileSync(SERIES_STATE_PATH, JSON.stringify(state ?? {}, null, 2)); } catch (e) { console.error('[playoff_series] Failed to save:', e); }
}

export const customId = /^playoff_game_/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const parts = interaction.customId.split('_'); // playoff_game_<threadId>_<gameIndex>_<a|b>
  if (parts.length < 5) return;
  const threadId = parts[2];
  const gameIndex = Number(parts[3]);
  const teamKey = parts[4];
  const state = loadSeriesState();
  const series = state[threadId];
  if (!series) {
    await interaction.reply({ content: 'Series data not found.', ephemeral: true });
    return;
  }
  if (series.decided?.includes(gameIndex)) {
    await interaction.reply({ content: `Game ${gameIndex} already recorded.`, ephemeral: true });
    return;
  }

  // Record win
  series.decided = series.decided || [];
  series.decided.push(gameIndex);
  if (teamKey === 'a') series.scoreA = (series.scoreA || 0) + 1;
  else series.scoreB = (series.scoreB || 0) + 1;

  const seriesComplete = series.scoreA >= series.winsNeeded || series.scoreB >= series.winsNeeded;
  // Build a single row for the next game (or disabled if complete)
  const nextGameIndex = seriesComplete ? Math.max(...series.decided, 0) : Math.max(...series.decided, 0) + 1;
  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: `Game ${nextGameIndex}: ${series.team1}`, custom_id: `playoff_game_${threadId}_${nextGameIndex}_a`, disabled: seriesComplete },
        { type: 2, style: 1, label: `Game ${nextGameIndex}: ${series.team2}`, custom_id: `playoff_game_${threadId}_${nextGameIndex}_b`, disabled: seriesComplete },
      ]
    }
  ];
  if (seriesComplete && series.round === 'NBA Finals') {
    const encodedWinner = encodeURIComponent(series.scoreA > series.scoreB ? series.team1 : series.team2);
    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: 'Set Champion (Staff)',
          custom_id: `set_champion_${threadId}_${encodedWinner}`,
        }
      ]
    });
  }

  const scoreLine = `${series.team1} ${series.scoreA} - ${series.team2} ${series.scoreB}`;
  // Update pinned welcome message with score if possible
  try {
    const msgs = await interaction.channel.messages.fetchPinned();
    const pinned = msgs.first();
    if (pinned) {
      await pinned.edit({ content: `${pinned.content.split('\n\n')[0]}\n\nScore: ${scoreLine}`, components });
    } else {
      await interaction.channel.send({ content: `Score update: ${scoreLine}`, components });
    }
  } catch (err) {
    console.error('[playoff_series] Failed to update pinned message:', err);
  }

  saveSeriesState(state);
  await interaction.reply({ content: `Recorded Game ${gameIndex}: ${teamKey === 'a' ? series.team1 : series.team2} wins. Series score ${scoreLine}${seriesComplete ? ' (Series complete)' : ''}.`, ephemeral: false });
}

export default { customId, execute };
