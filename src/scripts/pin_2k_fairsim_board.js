import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { updateFairSimBoard } from '../shared/2k_fairsim_board.js';

async function main() {
  const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN not set; cannot pin 2K sim board.');
    process.exit(1);
  }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(token);
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.error('Bot is not in any guild.');
    process.exit(1);
  }
  await updateFairSimBoard(client, guild.id);
  console.log('2K Sim Strike board pinned/updated.');
  await client.destroy();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
