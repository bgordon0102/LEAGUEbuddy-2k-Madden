import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder } from 'discord.js';
import { inferRecognitionContext } from '../shared/league_recognition.js';
import { buyoutSportsbookBet, formatImpactValue, getLineForBet, getSportsbookLimits, getSportsbookUserCard, linePrice, payoutBreakdown, placeSportsbookBet, sportsbookModal } from '../shared/madden_sportsbook.js';
import { appendMaddenStaffLog, postMaddenStaffDecision } from '../shared/madden_staff_ops.js';

export const customId = /^madden_sportsbook_(bet(?:\||_)|confirm\||cancel\||buyout\|)/;

function selectionLabel(market, selection) {
  if (market === 'total') return selection === 'over' ? 'Over' : 'Under';
  if (market === 'moneyline') return selection === 'away' ? 'Away ML' : 'Home ML';
  return selection === 'away' ? 'Away spread' : 'Home spread';
}

function betDisplayLabel(line, market, selection) {
  if (market === 'moneyline') {
    return `${selection === 'away' ? line.awayTeam : line.homeTeam} moneyline`;
  }
  if (market === 'total') {
    return `${selection === 'over' ? 'Over' : 'Under'} ${line.total}`;
  }
  return selection === 'away' ? line.awaySpreadDisplay : line.homeSpreadDisplay;
}

function buildReceiptEmbed({ result, line, market, selection, wager }) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Bet Slip Accepted')
    .setDescription([
      `${line.awayTeam} at ${line.homeTeam}`,
      `Pick: ${selectionLabel(market, selection)}`,
      `Bet: ${formatImpactValue(Number(wager))}`,
      `Odds: ${result.price > 0 ? '+' : ''}${result.price}`,
      `If it wins: +${formatImpactValue(result.payout?.profit || 0)}`,
      `You get back: ${formatImpactValue(result.payout?.totalReturn || 0)} total`,
      `Impact left to bet: ${formatImpactValue(result.balance)}`,
    ].join('\n'))
    .setTimestamp();
}

function buildConfirmEmbed({ line, market, selection, wager, odds, payout }) {
  return new EmbedBuilder()
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
}

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const raw = String(interaction.customId || '');
  if (raw.startsWith('madden_sportsbook_buyout|')) {
    const [, weekNumber, gameId, placedAt] = raw.split('|');
    const context = inferRecognitionContext('madden', interaction.guildId);
    const seasonKey = context?.seasonKey;
    if (!seasonKey) {
      await interaction.reply({ content: 'Sportsbook season context is not ready yet.', flags: 64 });
      return;
    }
    const result = buyoutSportsbookBet({
      guildId: interaction.guildId,
      seasonKey,
      weekNumber: Number(weekNumber),
      userId: interaction.user.id,
      gameId: decodeURIComponent(String(gameId || '')),
      placedAt: Number(placedAt),
    });
    if (!result.ok) {
      await interaction.reply({ content: result.message, flags: 64 });
      return;
    }
    appendMaddenStaffLog({
      type: 'sportsbook_bet_buyout',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      username: interaction.user.tag,
      weekNumber: Number(weekNumber),
      seasonKey,
      gameId: result.bet?.gameId,
      matchup: result.bet?.matchupLabel,
      betLabel: result.bet?.betLabel,
      wager: Number(result.bet?.wager || 0),
      refund: Number(result.refund || 0),
      balanceAfter: Number(result.balance || 0),
    });
    await postMaddenStaffDecision(
      interaction.client,
      interaction.guildId,
      'Sportsbook Bet Buyout',
      `<@${interaction.user.id}> used **Bet Buyout** on **${result.bet?.matchupLabel || 'an open bet'}**.`,
      [
        { name: 'Week', value: String(weekNumber), inline: true },
        { name: 'Bet', value: String(result.bet?.betLabel || 'Unknown bet'), inline: true },
        { name: 'Stake', value: formatImpactValue(Number(result.bet?.wager || 0)), inline: true },
        { name: 'Refund', value: formatImpactValue(Number(result.refund || 0)), inline: true },
        { name: 'Balance After', value: formatImpactValue(Number(result.balance || 0)), inline: true },
      ],
    ).catch(() => null);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('Bet Bought Out')
          .setDescription([
            `${result.bet?.matchupLabel || 'Open bet'}`,
            `Bet: ${result.bet?.betLabel || 'Unknown bet'}`,
            `Refund returned: ${formatImpactValue(Number(result.refund || 0))}`,
            `Impact left to bet: ${formatImpactValue(Number(result.balance || 0))}`,
          ].join('\n'))
          .setTimestamp(),
      ],
      flags: 64,
    });
    return;
  }

  if (raw.startsWith('madden_sportsbook_confirm|')) {
    const [, weekNumber, gameId, market, selection, wager] = raw.split('|');
    const context = inferRecognitionContext('madden', interaction.guildId);
    const seasonKey = context?.seasonKey;
    const line = seasonKey ? getLineForBet(seasonKey, Number(weekNumber), gameId) : null;
    if (!seasonKey || !line) {
      await interaction.update({ content: 'This line is not available anymore.', embeds: [], components: [] });
      return;
    }
    const result = placeSportsbookBet({
      guildId: interaction.guildId,
      member: interaction.member,
      userId: interaction.user.id,
      seasonKey,
      weekNumber: Number(weekNumber),
      gameId,
      market,
      selection,
      wager: Number(wager),
    });
    if (!result.ok) {
      await interaction.update({ content: result.message, embeds: [], components: [] });
      return;
    }
    await interaction.update({
      content: null,
      embeds: [buildReceiptEmbed({ result, line, market, selection, wager: Number(wager) })],
      components: [],
    });
    appendMaddenStaffLog({
      type: 'sportsbook_bet_placed',
      guildId: interaction.guildId,
      userId: interaction.user.id,
      username: interaction.user.tag,
      weekNumber: Number(weekNumber),
      seasonKey,
      gameId,
      awayTeam: line.awayTeam,
      homeTeam: line.homeTeam,
      matchup: `${line.awayTeam} at ${line.homeTeam}`,
      market,
      selection,
      selectionLabel: selectionLabel(market, selection),
      betLabel: betDisplayLabel(line, market, selection),
      wager: Number(wager),
      odds: result.price,
      payoutProfit: Number(result.payout?.profit || 0),
      payoutTotalReturn: Number(result.payout?.totalReturn || 0),
      balanceAfter: Number(result.balance || 0),
      awayMoneyline: Number(line.awayMoneyline || 0),
      homeMoneyline: Number(line.homeMoneyline || 0),
      spread: Number(line.spread || 0),
      total: Number(line.total || 0),
    });
    await postMaddenStaffDecision(
      interaction.client,
      interaction.guildId,
      'Sportsbook Bet Placed',
      `<@${interaction.user.id}> placed a sportsbook bet on **${line.awayTeam} at ${line.homeTeam}**.`,
      [
        { name: 'Week', value: String(weekNumber), inline: true },
        { name: 'Market', value: market, inline: true },
        { name: 'Pick', value: betDisplayLabel(line, market, selection), inline: true },
        { name: 'Wager', value: formatImpactValue(Number(wager)), inline: true },
        { name: 'Odds', value: `${result.price > 0 ? '+' : ''}${result.price}`, inline: true },
        { name: 'Win Profit', value: formatImpactValue(Number(result.payout?.profit || 0)), inline: true },
        { name: 'Total Return', value: formatImpactValue(Number(result.payout?.totalReturn || 0)), inline: true },
        { name: 'Balance After', value: formatImpactValue(Number(result.balance || 0)), inline: true },
      ],
    ).catch(() => null);
    return;
  }

  if (raw.startsWith('madden_sportsbook_cancel|')) {
    await interaction.update({
      content: 'Bet canceled.',
      embeds: [],
      components: [],
    });
    return;
  }

  if (raw.startsWith('madden_sportsbook_bet_pick|')) {
    const [, weekNumber, gameId, market, selection, wager] = raw.split('|');
    const context = inferRecognitionContext('madden', interaction.guildId);
    const seasonKey = context?.seasonKey;
    const line = seasonKey ? getLineForBet(seasonKey, Number(weekNumber), gameId) : null;
    if (!seasonKey || !line) {
      await interaction.update({ content: 'This line is not available anymore.', embeds: [], components: [] });
      return;
    }
    const odds = linePrice(line, market, selection);
    const payout = payoutBreakdown(Number(wager), odds);
    const controls = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_confirm|${weekNumber}|${gameId}|${market}|${selection}|${wager}`)
        .setLabel('Confirm Bet')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_cancel|${weekNumber}|${gameId}|${market}|${selection}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: null,
      embeds: [buildConfirmEmbed({ line, market, selection, wager: Number(wager), odds, payout })],
      components: [controls],
    });
    return;
  }

  if (raw.startsWith('madden_sportsbook_bet_other|')) {
    const [, weekNumber, gameId, market, selection] = raw.split('|');
    const context = inferRecognitionContext('madden', interaction.guildId);
    const seasonKey = context?.seasonKey;
    const line = seasonKey ? getLineForBet(seasonKey, Number(weekNumber), gameId) : null;
    if (!line) {
      await interaction.reply({ content: 'This line is not available anymore.', flags: 64 });
      return;
    }
    const modal = sportsbookModal(
      `madden_sportsbook_wager|${weekNumber}|${gameId}|${market}|${selection}`,
      line,
    );
    await interaction.showModal(modal);
    return;
  }

  const [, weekNumber, gameId, market, selection] = raw.split('|');
  const context = inferRecognitionContext('madden', interaction.guildId);
  const seasonKey = context?.seasonKey;
  const line = seasonKey ? getLineForBet(seasonKey, Number(weekNumber), gameId) : null;
  if (!line) {
    await interaction.reply({ content: 'This line is not available anymore.', flags: 64 });
    return;
  }
  const card = getSportsbookUserCard({
    seasonKey,
    weekNumber: Number(weekNumber),
    userId: interaction.user.id,
    guildId: interaction.guildId,
  });
  const limits = getSportsbookLimits(card.bankroll?.balance || 0);
  const odds = linePrice(line, market, selection);
  const choices = [1, 3, 5, 10].filter((amount) => amount <= Number(limits.maxWager || 0) && amount <= Number(card.bankroll?.balance || 0));
  const row = new ActionRowBuilder();
  for (const amount of choices.slice(0, 4)) {
    const payout = payoutBreakdown(amount, odds);
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_bet_pick|${weekNumber}|${gameId}|${market}|${selection}|${amount}`)
        .setLabel(`Bet ${amount} • Win ${Number.isInteger(payout.profit) ? payout.profit : payout.profit.toFixed(1)} Impact`)
        .setStyle(ButtonStyle.Primary),
    );
  }
  if (row.components.length < 5) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_sportsbook_bet_other|${weekNumber}|${gameId}|${market}|${selection}`)
        .setLabel('Other')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Choose Your Bet Size')
    .setDescription([
      `${line.awayTeam} at ${line.homeTeam}`,
      `Pick: ${selectionLabel(market, selection)}`,
      '',
      `Type later only if you need a custom amount.`,
      `Impact available to bet: ${formatImpactValue(card.bankroll?.balance || 0)}`,
      `Max on this bet: ${formatImpactValue(limits.maxWager || 0)}`,
      `Odds on this pick: ${odds > 0 ? '+' : ''}${odds}`,
      `Tap a quick amount below to see exactly how much Impact that bet can win, or choose Other.`,
    ].join('\n'));

  await interaction.reply({ embeds: [embed], components: [row], flags: 64 });
}

export default { customId, execute };
