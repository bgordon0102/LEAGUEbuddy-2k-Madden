import { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { coachCommandDescription } from '../../shared/madden_coach_voice.js';

const ROUND_OPTIONS = ['1', '2', '3', '4', '5', '6', '7'];
const PICK_OPTIONS = Array.from({ length: 32 }, (_, i) => String(i + 1));

function currentPickValue(round, pickNum) {
  const r = Number(round);
  const p = Math.min(32, Math.max(1, Number(pickNum) || 1));
  const overall = Math.max(1, (r - 1) * 32 + p);
  if (overall === 1) return 800;
  if (overall === 2) return 525;
  if (overall === 3) return 475;
  if (overall === 4) return 425;
  if (overall === 5) return 400;
  const k = 0.0145;
  const val = 400 * Math.exp(-k * (overall - 5));
  return Math.max(10, val);
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
    // future picks: use current mid-round value, then decay by year offset
    const midPick = 16; // midpoint of 32-pick round
    const midVal = currentPickValue(r, midPick);
    const baseFuture = Math.max(floor, midVal);
    const decay = diff === 1 ? 0.8 : 0.65; // year+1 ~80%, year+2 ~65%
    let val = Math.round(baseFuture * decay);
    // Safeguards for top rounds so they stay meaningful
    if (r === 1 && diff === 1 && val < 240) val = 240;
    if (r === 1 && diff >= 2 && val < 200) val = 200;
    return Math.max(10, val);
  }

  // current year: per-pick curve
  const pickValueCurve = currentPickValue(r, pickNum);
  const value = Math.max(floor, pickValueCurve);
  return Math.max(5, Math.round(value));
}

function buildPickPages(startYear, seasonYear, leagueId) {
  const pages = [];
  if (startYear === seasonYear) {
    // Current draft: 7 pages, one per round, 32 picks each (overall 1–224)
    for (let round = 1; round <= 7; round += 1) {
      const lines = [];
      for (let pick = 1; pick <= 32; pick += 1) {
        const overall = (round - 1) * 32 + pick; // 1-224 numbering
        const val = computePickValue(startYear, round, pick, seasonYear);
        lines.push(`${startYear} Round ${round} Pick ${overall} — ${val}`);
      }
      pages.push(
        new EmbedBuilder()
          .setTitle(`Draft Pick Values — ${startYear} Round ${round}`)
          .setDescription(lines.join('\n'))
          .setFooter({ text: `Page ${pages.length + 1}/7 • Values match trade system` })
          .setColor(0x00a3ff)
      );
    }
  } else {
    // Future draft: one page with 7 round values
    const lines = [];
    for (let round = 1; round <= 7; round += 1) {
      const val = computePickValue(startYear, round, null, seasonYear);
      lines.push(`${startYear} Round ${round} — ${val}`);
    }
    pages.push(
      new EmbedBuilder()
        .setTitle(`Draft Pick Values — ${startYear}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Page 1/1 • Values match trade system` })
        .setColor(0x00a3ff)
    );
  }

  const baseId = `madden_pickvalue_page_${leagueId}_${startYear}`;
  return { embeds: pages, baseId };
}

export const data = new SlashCommandBuilder()
  .setName('madden-pickvalue')
  .setDescription(coachCommandDescription('pickvalue'))
  .addIntegerOption(o =>
    o.setName('start_year')
      .setDescription('First draft year to show')
      .setRequired(false)
      .addChoices(
        { name: '2027', value: 2027 },
        { name: '2028', value: 2028 },
        { name: '2029', value: 2029 },
      )
  );

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ flags: 64 }); } catch (_) {}
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    const payload = { content: 'No Madden league set. Run /madden-set-league first.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const calendarYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  const baseYear = Math.max(2027, calendarYear); // force 2027+ as current draft baseline
  const maxYear = baseYear + 2; // Madden trades only 2 years out
  const startYearInput = interaction.options.getInteger('start_year');
  let startYear = Number.isInteger(startYearInput) ? startYearInput : baseYear;
  if (startYear >= 1 && startYear <= 10 && startYear < 1900) {
    startYear = baseYear + (startYear - 1);
  }
  if (startYear < baseYear || startYear > maxYear) {
    const payload = { content: `Start year must be ${baseYear}, ${baseYear + 1}, or ${maxYear}.` };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }

  const { embeds, baseId } = buildPickPages(startYear, baseYear, leagueId);
  const components = [];
  if (embeds.length > 1) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${baseId}_0`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`${baseId}_1`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(embeds.length <= 1),
    );
    components.push(row);
  }

  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embeds[0]], components });
  else await interaction.reply({ embeds: [embeds[0]], components, flags: 64 });
}

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  interaction.respond([]).catch(() => {});
}

export { buildPickPages };

export default { data, execute, autocomplete };
