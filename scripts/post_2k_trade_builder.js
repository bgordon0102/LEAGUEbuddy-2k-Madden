import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN || process.env.TOKEN;
const channelId = process.argv[2] || process.env.TRADE_BUILDER_CHANNEL_ID;
if (!token) {
  console.error('DISCORD_TOKEN not set.');
  process.exit(1);
}
if (!channelId) {
  console.error('Usage: node scripts/post_2k_trade_builder.js <channelId>  (or set TRADE_BUILDER_CHANNEL_ID env)');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

const embed = {
  title: 'Submit a Trade',
  description: [
    'Use Trade Builder to propose your deal:',
    '• Your team is auto-detected. Pick the other team or type it.',
    '• Add assets (players / picks) using the modal fields.',
    '• Review totals, then Submit to send for approval.',
    'Trades lock based on the league schedule.'
  ].join('\n'),
  color: 0x4e9cff
};

const components = [
  {
    type: 1, // ActionRow
    components: [
      {
        type: 2, // Button
        style: 1, // Primary
        custom_id: 'trade_builder_start_2k',
        label: 'Propose Trade'
      }
    ]
  }
];

(async () => {
  try {
    const res = await rest.post(Routes.channelMessages(channelId), {
      body: {
        embeds: [embed],
        components
      }
    });
    console.log('Trade Builder button posted to channel', channelId, 'message id', res.id);
  } catch (err) {
    console.error('Failed to post Trade Builder message:', err?.message || err);
    process.exit(1);
  }
})();
