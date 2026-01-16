import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const YEAR_OPTIONS = ['2026', '2027', '2028'];
const ROUND_OPTIONS = ['1', '2', '3', '4', '5', '6', '7'];
const PICK_OPTIONS = Array.from({ length: 32 }, (_, i) => String(i + 1));

function computePickValue(year, round, pick, seasonYear) {
  const r = Number(round);
  if (!r || r < 1 || r > 7) return null;
  // Scaled down to align with adjusted trade values
  const baseChart = { 1: 110, 2: 75, 3: 50, 4: 35, 5: 25, 6: 18, 7: 12 };
  const base = (baseChart[r] || 8) * 0.9; // mid-round baseline (no exact pick required)
  let decay = 1;
  if (year && seasonYear) {
    const diff = year - seasonYear;
    decay = diff <= 0 ? 1 : diff === 1 ? 0.9 : 0.8; // 2026 > 2027 > 2028
  } else if (year) {
    decay = year === 2026 ? 1 : year === 2027 ? 0.9 : 0.8;
  }
  return Math.max(5, Math.round(base * decay));
}

export const data = new SlashCommandBuilder()
  .setName('madden-pickvalue')
  .setDescription('Get the trade value for a draft pick')
  .addStringOption(o =>
    o.setName('year')
      .setDescription('Draft year (2026-2028)')
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

  if (!YEAR_OPTIONS.includes(String(year)) || !ROUND_OPTIONS.includes(String(round))) {
    await interaction.reply({ content: 'Please select a valid year (2026-2028) and round (1-7).', ephemeral: true });
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

  const label = pick ? `${year} Round ${round} Pick ${pick}` : `${year} Round ${round}`;

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

  const respondList = (list) => {
    const filtered = list
      .filter(item => item.toLowerCase().includes(value.toLowerCase()))
      .slice(0, 25)
      .map(v => ({ name: v, value: v }));
    interaction.respond(filtered).catch(() => {});
  };

  if (name === 'year') {
    respondList(YEAR_OPTIONS);
  } else if (name === 'round') {
    respondList(ROUND_OPTIONS);
  } else if (name === 'pick') {
    respondList(PICK_OPTIONS);
  } else {
    interaction.respond([]).catch(() => {});
  }
}

export default { data, execute, autocomplete };
