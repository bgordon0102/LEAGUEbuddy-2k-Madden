import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { loadActiveTrades2k, computeApprovedTradeCounts2k, saveTradeCounts2k, updateTradeCountsEmbed2k } from '../shared/nba_trade_utils.js';

async function main() {
  const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN (or BOT_TOKEN) is required');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

  client.once('ready', async () => {
    try {
      const trades = loadActiveTrades2k();
      const counts = computeApprovedTradeCounts2k(trades);
      saveTradeCounts2k(counts);
      await updateTradeCountsEmbed2k(client, counts);
      console.log('2K trade counts pin updated.');
    } catch (err) {
      console.error('Failed to update 2K trade counts pin:', err);
    } finally {
      client.destroy();
      process.exit(0);
    }
  });

  client.login(token).catch(err => {
    console.error('Discord login failed:', err);
    process.exit(1);
  });
}

main();
