import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, EmbedBuilder } from 'discord.js';
import {
  activateRecognitionPerk,
  getRecognitionPerkCatalog,
  getRecognitionPerksByTier,
  getRecognitionPerkState,
  inferRecognitionContext,
  setRecognitionDoubleOrNothingTier,
} from '../shared/league_recognition.js';
import { appendMaddenStaffLog, postMaddenStaffDecision } from '../shared/madden_staff_ops.js';
import { RECOGNITION_EMOJIS } from '../shared/madden_visuals.js';

export const customId = /^madden_franchisehub_(spend|buy|confirm|cancel|pick)\|/;

const TIER_EMOJIS = RECOGNITION_EMOJIS;

const PERKS_BY_TIER = getRecognitionPerksByTier();
const PERK_CATALOG = getRecognitionPerkCatalog();

function tierForPerk(perkKey) {
  return PERK_CATALOG?.[perkKey]?.tier || null;
}

function perkUsageHint(perkKey) {
  if (perkKey === 'offensiveGamePlan' || perkKey === 'defensiveGamePlan' || perkKey === 'allGamePlanBundle' || perkKey === 'tendencyBreakdown') {
    return 'Next: run /madden-gamestrategy this week to see the premium game-plan section you just unlocked.';
  }
  if (perkKey === 'draftWarRoomIntel' || perkKey === 'classTrendIntel') {
    return 'Next: run /madden-draftprimer this week to use the draft intel you just unlocked.';
  }
  if (perkKey === 'scoutRecommendation') {
    return 'Next: open /madden-myscouts this week to see the suggested premium scout target for your current class.';
  }
  if (perkKey === 'scoutingFocusPack') {
    return 'Next: run /madden-scout this week. Every reveal is discounted, and your top need lanes get the cheapest scout price.';
  }
  if (perkKey === 'streakShield' || perkKey === 'strikeCushion' || perkKey === 'fairSimCredit') {
    return 'Next: nothing to click right now. This protection sits live on your account for this week if that situation comes up.';
  }
  if (perkKey === 'doubleOrNothing') {
    return 'Next: pick Activity, Impact, or Legacy for this week. If that lane earns points, the week payout is matched once.';
  }
  if (perkKey === 'betBuyout') {
    return 'Next: open the private sportsbook card this week. If you have an open bet you want out of, the buyout button will appear there.';
  }
  return 'Next: open Franchise Hub again later this week to see where the perk applied.';
}

function perkUsageLocation(perkKey) {
  if (perkKey === 'offensiveGamePlan' || perkKey === 'defensiveGamePlan' || perkKey === 'allGamePlanBundle' || perkKey === 'tendencyBreakdown') {
    return '/madden-gamestrategy';
  }
  if (perkKey === 'draftWarRoomIntel' || perkKey === 'classTrendIntel' || perkKey === 'scoutRecommendation') {
    return '/madden-draftprimer';
  }
  if (perkKey === 'scoutingFocusPack') {
    return '/madden-scout';
  }
  if (perkKey === 'betBuyout') {
    return 'Sportsbook My Card';
  }
  if (perkKey === 'doubleOrNothing') {
    return 'Double Or Nothing picker';
  }
  return 'Franchise Hub';
}

function perkGroupForTier(tier, perkKey) {
  if (tier === 'impact') {
    if (['offensiveGamePlan', 'defensiveGamePlan', 'tendencyBreakdown', 'allGamePlanBundle'].includes(perkKey)) return 'Game Prep';
    if (['scoutingFocusPack', 'scoutRecommendation', 'draftWarRoomIntel', 'classTrendIntel'].includes(perkKey)) return 'Scouting';
    if (['doubleOrNothing', 'betBuyout'].includes(perkKey)) return 'Risk Tools';
  }
  if (tier === 'activity') {
    if (['streakShield', 'strikeCushion', 'fairSimCredit'].includes(perkKey)) return 'Protection';
  }
  return 'Other';
}

function perkSortWeight(tier, perkKey) {
  const group = perkGroupForTier(tier, perkKey);
  const order = {
    'Game Prep': 0,
    'Scouting': 1,
    'Risk Tools': 2,
    'Protection': 0,
    'Other': 9,
  };
  const perkOrder = {
    allGamePlanBundle: 0,
    offensiveGamePlan: 1,
    defensiveGamePlan: 2,
    tendencyBreakdown: 3,
    scoutingFocusPack: 10,
    scoutRecommendation: 11,
    draftWarRoomIntel: 12,
    classTrendIntel: 13,
    doubleOrNothing: 20,
    betBuyout: 21,
    streakShield: 30,
    strikeCushion: 31,
    fairSimCredit: 32,
  };
  return (order[group] ?? 9) * 100 + (perkOrder[perkKey] ?? 99);
}

function buildSpendPanel({ tier, perkState, weekKey }) {
  const titleTier = tier.charAt(0).toUpperCase() + tier.slice(1);
  const balance = Number(perkState?.balances?.[tier] || 0);
  const tierState = perkState?.tierStatus?.[tier] || { active: [], used: [], available: [] };
  const costMap = perkState?.costs || PERK_CATALOG;
  const availablePerks = PERKS_BY_TIER[tier] || [];

  const orderedPerks = [...availablePerks].sort((a, b) => perkSortWeight(tier, a) - perkSortWeight(tier, b));

  const rows = [];
  let currentGroup = null;
  let currentButtons = [];
  for (const perkKey of orderedPerks) {
    const perk = perkState?.perkStatus?.[perkKey] || costMap[perkKey];
    const group = perkGroupForTier(tier, perkKey);
    const style = group === 'Game Prep'
      ? ButtonStyle.Primary
      : group === 'Scouting'
        ? ButtonStyle.Secondary
        : ButtonStyle.Success;
    const button = new ButtonBuilder()
      .setCustomId(`madden_franchisehub_buy|${tier}|${perkKey}`)
      .setLabel(perk.label)
      .setStyle(style)
      .setDisabled(Boolean(perk.activeNow || perk.usedThisWeek || perk.phaseOpen === false || balance < perk.cost));

    if (currentGroup !== null && (group !== currentGroup || currentButtons.length === 5)) {
      rows.push(new ActionRowBuilder().addComponents(...currentButtons));
      currentButtons = [];
    }
    currentGroup = group;
    currentButtons.push(button);
  }
  if (currentButtons.length) {
    rows.push(new ActionRowBuilder().addComponents(...currentButtons));
  }

  const groupedLines = [];
  let lastGroup = null;
  for (const perkKey of orderedPerks) {
    const group = perkGroupForTier(tier, perkKey);
    const perk = perkState?.perkStatus?.[perkKey] || costMap[perkKey];
    const status = perk.activeNow
      ? (perkKey === 'doubleOrNothing'
          ? `active now${perk.selectedTier ? ` • armed on ${perk.selectedTier}` : ' • lane not picked yet'}`
          : 'active now')
      : perk.usedThisWeek
        ? 'used this week'
        : perk.availableThisWeek
          ? `available this week • cost ${perk.cost}`
          : perk.phaseOpen === false
            ? `locked for ${perkState?.phaseLabel || 'this phase'} • cost ${perk.cost}`
            : `locked • cost ${perk.cost}`;
    if (group !== lastGroup) {
      groupedLines.push(`__${group}__`);
      lastGroup = group;
    }
    groupedLines.push(`${TIER_EMOJIS[tier]} ${perk.label} • ${status} • ${perk.effect}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`Recognition Spend — ${titleTier}`)
    .setDescription([
      `You have ${balance} ${TIER_EMOJIS[tier]} to spend this week.`,
      perkState?.phaseLabel ? `Season phase: ${perkState.phaseLabel}` : null,
      `Week: ${weekKey.replace('_', ' ')}`,
      '',
      `Active now: ${tierState.active.length ? tierState.active.map((perk) => perk.label).join(', ') : 'none'}`,
      `Used this week: ${tierState.used.length ? tierState.used.map((perk) => perk.label).join(', ') : 'none'}`,
      '',
      ...groupedLines,
    ].filter(Boolean).join('\n'))
    .setFooter({ text: 'Spend recognition to activate perks for the current week.' });

  return { embeds: [embed], components: rows };
}

function buildConfirmPanel({ tier, perk, perkState, weekKey }) {
  const balance = Number(perkState?.balances?.[tier] || 0);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_franchisehub_confirm|${tier}|${perk.key}`)
      .setLabel(`Confirm ${perk.label}`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(Boolean(perk.activeNow || perk.usedThisWeek || balance < perk.cost)),
    new ButtonBuilder()
      .setCustomId(`madden_franchisehub_cancel|${tier}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`Confirm Purchase — ${perk.label}`)
    .setDescription([
      `Week: ${weekKey.replace('_', ' ')}`,
      `Cost: ${perk.cost} ${TIER_EMOJIS[tier]}`,
      `Balance now: ${balance} ${TIER_EMOJIS[tier]}`,
      `Balance after purchase: ${Math.max(0, balance - Number(perk.cost || 0))} ${TIER_EMOJIS[tier]}`,
      '',
      perk.effect,
      '',
      'Are you sure you want to activate this perk for the current week?',
    ].join('\n'))
    .setFooter({ text: 'This purchase cannot be undone this week.' });

  return { embeds: [embed], components: [row] };
}

function buildDoubleOrNothingPicker({ weekKey }) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('madden_franchisehub_pick|doubleOrNothing|activity').setLabel('Double Activity').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('madden_franchisehub_pick|doubleOrNothing|impact').setLabel('Double Impact').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('madden_franchisehub_pick|doubleOrNothing|legacy').setLabel('Double Legacy').setStyle(ButtonStyle.Secondary),
  );
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('Double Or Nothing')
    .setDescription([
      `Week: ${weekKey.replace('_', ' ')}`,
      'Pick one recognition lane for this week.',
      'If that lane earns points this week, the weekly gain is matched once.',
      'If that lane earns nothing, the perk burns.',
    ].join('\n'))
    .setFooter({ text: 'Choose one lane now.' });
  return { embeds: [embed], components: [row] };
}

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const raw = String(interaction.customId || '');
  const [prefix, value, extra] = raw.split('|');
  const action = prefix.replace('madden_franchisehub_', '');
  if (action === 'spend' && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: 64 });
  }
  const context = inferRecognitionContext('madden', interaction.guildId);
  if (!context?.seasonKey || !context?.weekKey) {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Recognition context is not ready yet.' });
    else await interaction.reply({ content: 'Recognition context is not ready yet.', flags: 64 });
    return;
  }

  const perkState = getRecognitionPerkState({
    guildId: interaction.guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    userId: interaction.user.id,
    weekKey: context.weekKey,
  });

  if (action === 'spend') {
    const tier = value;
    if (tier === 'legacy') {
      await interaction.editReply({ content: 'Legacy is not a spend currency in Franchise Hub.' });
      return;
    }
    const payload = buildSpendPanel({ tier, perkState, weekKey: context.weekKey });
    await interaction.editReply(payload);
    return;
  }

  if (action === 'cancel') {
    const tier = value;
    const payload = buildSpendPanel({ tier, perkState, weekKey: context.weekKey });
    await interaction.update(payload);
    return;
  }

  if (action === 'buy') {
    const perkKey = extra || value;
    const tier = extra ? value : tierForPerk(perkKey);
    const perk = perkState?.perkStatus?.[perkKey] || PERK_CATALOG[perkKey];
    if (!perk || !tier) {
      await interaction.reply({ content: 'That perk is not available.', flags: 64 });
      return;
    }
    const payload = buildConfirmPanel({ tier, perk, perkState, weekKey: context.weekKey });
    await interaction.update(payload);
    return;
  }

  if (action === 'pick') {
    const perkKey = value;
    const targetTier = extra;
    if (perkKey !== 'doubleOrNothing') {
      await interaction.reply({ content: 'That pick action is not available.', flags: 64 });
      return;
    }
    const pickResult = setRecognitionDoubleOrNothingTier({
      guildId: interaction.guildId,
      league: 'madden',
      seasonKey: context.seasonKey,
      weekKey: context.weekKey,
      userId: interaction.user.id,
      targetTier,
    });
    if (!pickResult.ok) {
      await interaction.reply({ content: pickResult.message, flags: 64 });
      return;
    }
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('Double Or Nothing Armed')
          .setDescription(`Your ${targetTier} lane is now live for ${context.weekKey}. If it earns points this week, that gain will be matched once.`),
      ],
      components: [],
    });
    return;
  }

  const tier = value;
  const perkKey = extra;

  const result = activateRecognitionPerk({
    guildId: interaction.guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    weekKey: context.weekKey,
    userId: interaction.user.id,
    perkKey,
  });

  if (!result.ok) {
    await interaction.reply({ content: result.message, flags: 64 });
    return;
  }

  const refreshedState = getRecognitionPerkState({
    guildId: interaction.guildId,
    league: 'madden',
    seasonKey: context.seasonKey,
    userId: interaction.user.id,
    weekKey: context.weekKey,
  });
  appendMaddenStaffLog({
    type: 'recognition_perk_activated',
    guildId: interaction.guildId,
    userId: interaction.user.id,
    username: interaction.user.tag,
    perkKey,
    perkLabel: result.perk.label,
    tier,
    weekKey: context.weekKey,
    cost: result.perk.cost,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
  });
  await postMaddenStaffDecision(
    interaction.client,
    interaction.guildId,
    'Recognition Purchase',
    `<@${interaction.user.id}> bought **${result.perk.label}** from Franchise Hub.`,
    [
      { name: 'Tier', value: tier, inline: true },
      { name: 'Week', value: context.weekKey, inline: true },
      { name: 'Cost', value: String(result.perk.cost), inline: true },
      { name: 'Before', value: String(result.balanceBefore), inline: true },
      { name: 'After', value: String(result.balanceAfter), inline: true },
      { name: 'Use It Here', value: perkUsageLocation(perkKey), inline: false },
      { name: 'How To Use It', value: perkUsageHint(perkKey), inline: false },
    ],
  ).catch(() => null);
  const payload = buildSpendPanel({ tier, perkState: refreshedState, weekKey: context.weekKey });
  if (perkKey === 'doubleOrNothing') {
    await interaction.update(buildDoubleOrNothingPicker({ weekKey: context.weekKey }));
    return;
  }
  payload.embeds[0].setDescription([
    `${result.perk.label} is now active for ${context.weekKey}.`,
    `Remaining this week: ${refreshedState.balances[tier]} ${TIER_EMOJIS[tier]}`,
    '',
    `Use it here: ${perkUsageLocation(perkKey)}`,
    perkUsageHint(perkKey),
    '',
    ...payload.embeds[0].data.description.split('\n').slice(2),
  ].join('\n'));
  await interaction.update(payload);
}

export default { customId, execute };
