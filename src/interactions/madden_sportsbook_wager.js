import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { inferRecognitionContext } from '../shared/league_recognition.js';
import { formatImpactValue, getLineForBet, linePrice, payoutBreakdown } from '../shared/madden_sportsbook.js';

export const customId_wager = /^madden_sportsbook_wager\|/;

function selectionLabel(market, selection) {
  if (market === 'total') return selection === 'over' ? 'Over' : 'Under';
  if (market === 'moneyline') return selection === 'away' ? 'Away ML' : 'Home ML';
  return selection === 'away' ? 'Away spread' : 'Home spread';
}

export async function execute_wager(interaction) {
  const [, weekNumber, gameId, market, selection] = interaction.customId.split('|');
  const wager = interaction.fields.getTextInputValue('wager');
  const context = inferRecognitionContext('madden', interaction.guildId);
  const seasonKey = context?.seasonKey;
  if (!seasonKey) {
    await interaction.reply({ content: 'Recognition season context is not ready yet.', flags: 64 });
    return;
  }

  const line = getLineForBet(seasonKey, Number(weekNumber), gameId);
  if (!line) {
    await interaction.reply({ content: 'This line is not available anymore.', flags: 64 });
    return;
  }
  const odds = linePrice(line, market, selection);
  const payout = payoutBreakdown(Number(wager), odds);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('Confirm This Bet')
    .setDescription([
      `${line.awayTeam} at ${line.homeTeam}`,
      `Pick: ${selectionLabel(market, selection)}`,
      `Bet: ${formatImpactValue(Number(wager))}`,
      `Odds: ${odds > 0 ? '+' : ''}${odds}`,
      `If it wins: +${formatImpactValue(payout?.profit || 0)}`,
      `You get back: ${formatImpactValue(payout?.totalReturn || 0)} total`,
      '',
      'Are you sure you want to place this bet?',
    ].join('\n'))
    .setTimestamp();
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_sportsbook_confirm|${weekNumber}|${gameId}|${market}|${selection}|${Number(wager)}`)
      .setLabel('Confirm Bet')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`madden_sportsbook_cancel|${weekNumber}|${gameId}|${market}|${selection}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [controls], flags: 64 });
}

export default { customId_wager, execute_wager };
