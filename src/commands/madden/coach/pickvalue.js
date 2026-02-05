import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROUND_OPTIONS = ['1', '2', '3', '4', '5', '6', '7'];
const PICK_OPTIONS = Array.from({ length: 32 }, (_, i) => String(i + 1));

function currentPickValue(round, pickNum) {
  const r = Number(round);
  const p = Math.min(32, Math.max(1, Number(pickNum) || 1));
  // Round-specific linear curves; R1 is bespoke for top 3 picks
  if (r === 1) {
    if (p === 1) return 400;
    if (p === 2) return 350;
    if (p === 3) return 300;
    const start = 280;
    const end = 150;
    const t = (p - 4) / (32 - 4);
    return start + (end - start) * t;
  }
  const curves = {
    2: { start: 170, end: 120 },
    3: { start: 125, end: 85 },
    4: { start: 95, end: 65 },
    5: { start: 70, end: 45 },
    6: { start: 50, end: 30 },
    7: { start: 32, end: 18 },
  };
  const curve = curves[r] || { start: 20, end: 10 };
  const t = (p - 1) / 31;
  return curve.start + (curve.end - curve.start) * t;
}

function computePickValue(year, round, pick, seasonYear) {
  const r = Number(round);
  if (!r || r < 1 || r > 7) return null;
  const currentYear = seasonYear || new Date().getFullYear();
  const diff = year - currentYear;

  // derive pickNum midpoint if missing
  let pickNum = pick ? Number(pick) : null;
  if (!pickNum || pickNum < 1) {
    const start = (r - 1) * 32 + 1;
    const end = r * 32;
    pickNum = Math.floor((start + end) / 2);
  }
  const floorMap = { 1: 150, 2: 110, 3: 85, 4: 65, 5: 50, 6: 35, 7: 25 };
  const floor = floorMap[r] || 10;

  if (diff > 0) {
    // future picks: flat mid-round, discounted by year (no pick-number edge)
    const futureBaseChart = { 1: 300, 2: 200, 3: 150, 4: 110, 5: 80, 6: 60, 7: 40 };
    const baseFuture = futureBaseChart[r] || floor;
    const decay = diff === 1 ? 0.85 : 0.7; // year+1 ~85%, year+2 ~70%
    let val = Math.max(5, Math.round(baseFuture * decay));
    if (r === 1 && diff === 1 && val < 250) val = 250;
    if (r === 1 && diff >= 2 && val < 200) val = 200;
    return val;
  }

  // current year: per-pick curve
  const pickValueCurve = currentPickValue(r, pickNum);
  const value = Math.max(floor, pickValueCurve);
  return Math.max(5, Math.round(value));
}

export const data = new SlashCommandBuilder()
  .setName('madden-pickvalue')
  .setDescription('Get the trade value for a draft pick')
  .addStringOption(o =>
    o.setName('year')
      .setDescription('Draft year (current season only)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(o =>
    o.setName('round')
      .setDescription('Round (1-7)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(o =>
    o.setName('pick')
      .setDescription('Pick (1-32) — optional')
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function execute(interaction) {
  const yearStr = interaction.options.getString('year');
  const roundStr = interaction.options.getString('round');
  const pickStr = interaction.options.getString('pick');
  const year = Number(yearStr);
  const round = Number(roundStr);
  const pick = pickStr ? Number(pickStr) : null;

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No Madden league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;

  const currentYear = seasonYear || new Date().getFullYear();
  if (year < currentYear || year > currentYear + 2 || !ROUND_OPTIONS.includes(String(round))) {
    await interaction.reply({ content: `Year must be current (${currentYear}) or next two drafts (${currentYear + 1}, ${currentYear + 2}), and round 1-7.`, ephemeral: true });
    return;
  }
  if (pick !== null && (pick < 1 || pick > 32)) {
    await interaction.reply({ content: 'Pick must be between 1 and 32.', ephemeral: true });
    return;
  }

  const value = computePickValue(year, round, pick, seasonYear);
  if (!value) {
    await interaction.reply({ content: 'Could not compute pick value. Check inputs.', ephemeral: true });
    return;
  }

  const labelPick = (year > currentYear) ? null : pick;
  const label = labelPick ? `${year} Round ${round} Pick ${labelPick}` : `${year} Round ${round}`;

  const embed = new EmbedBuilder()
    .setTitle('Draft Pick Value')
    .setDescription(`Pick: **${label}**`)
    .addFields({ name: 'Value', value: value.toString(), inline: true })
    .setFooter({ text: seasonYear ? `Current season: ${seasonYear}` : 'Current season unknown' })
    .setColor(0x00a3ff);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const focused = interaction.options.getFocused(true);
  const name = focused?.name;
  const value = (focused?.value || '').toString();

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  let seasonYear = new Date().getFullYear();
  if (leagueId) {
    const snapshot = loadLeagueSnapshot(leagueId);
    seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear || seasonYear;
  }

  const respondList = (list) => {
    const filtered = list
      .filter(item => item.toLowerCase().includes(value.toLowerCase()))
      .slice(0, 25)
      .map(v => ({ name: v, value: v }));
    interaction.respond(filtered).catch(() => {});
  };

  if (name === 'year') {
    respondList([String(seasonYear), String(seasonYear + 1), String(seasonYear + 2)]);
  } else if (name === 'round') {
    respondList(ROUND_OPTIONS);
  } else if (name === 'pick') {
    const selectedYear = Number(interaction.options.getString('year')) || seasonYear;
    if (selectedYear === seasonYear) {
      respondList(PICK_OPTIONS);
    } else {
      interaction.respond([]).catch(() => {});
    }
  } else {
    interaction.respond([]).catch(() => {});
  }
}

export default { data, execute, autocomplete };
