import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';

// Week windows
const PRE_MAX_WEEK = 15;
const MID_MAX_WEEK = 30;

function loadSeason() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'season.json'), 'utf8'));
    return {
      seasonNo: Number(data.seasonNo) || 1,
      currentWeek: Number(data.currentWeek) || 1,
    };
  } catch {
    return { seasonNo: 1, currentWeek: 1 };
  }
}

function classPrefix(seasonNo) {
  // Season 1 => 2k26_CUS01, Season 2 => 2k26_CUS02, etc.
  const suffix = String(seasonNo).padStart(2, '0');
  return `2k26_CUS${suffix}`;
}

function pickPhaseFile(week, prefix) {
  // Week 0 (offseason) and 31+ use final; 1-15 pre; 16-30 mid
  if (week === 0 || week > MID_MAX_WEEK) return `${prefix} - Final Recruiting.json`;
  if (week <= PRE_MAX_WEEK) return `${prefix} - Pre Recruiting.json`;
  return `${prefix} - Mid Recruiting.json`;
}

function loadRecruiting(fileName) {
  const fullPath = path.join(process.cwd(), 'bot', 'draft classes', 'recruiting', fileName);
  try {
    const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const entries = Object.values(raw || {}).map(e => ({
      national_rank: Number(e.national_rank) || 0,
      positional_rank: Number(e.positional_rank) || 0,
      position: e.position || '-',
      name: e.name || 'Unknown',
      college: e.college || '-',
      school_logo: e.school_logo || null,
      hometown: e.hometown || '-',
      height: e.height || '-',
      weight: e.weight || '-',
      grade: e.grade != null ? e.grade : '-',
      stars: Number(e['star rating']) || 0,
      all_american: e.all_american === 1 || e.all_american === true,
    }));
    return entries.sort((a, b) => a.national_rank - b.national_rank).slice(0, 50);
  } catch {
    return null;
  }
}

function starsToEmoji(stars) {
  const count = Math.max(0, Math.min(5, Math.floor(stars)));
  return count ? '⭐'.repeat(count) : '-';
}

export const data = new SlashCommandBuilder()
  .setName('2k-recruiting')
  .setDescription('View ESPN-style Top 50 recruits for the current class')
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export async function execute(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if (err?.code === 10062 || err?.code === 40060) return;
    throw err;
  }

  const { seasonNo, currentWeek } = loadSeason();
  const prefix = classPrefix(seasonNo);
  const fileName = pickPhaseFile(currentWeek, prefix);
  const recruits = loadRecruiting(fileName);
  if (!recruits) {
    await interaction.editReply({ content: `Could not load recruiting file: ${fileName}.` });
    return;
  }

  const isFinal = currentWeek > MID_MAX_WEEK;
  const lines = recruits.map(r => {
    const aa = isFinal && r.all_american ? ' | 🍔' : '';
    return `#${r.national_rank} (${r.positional_rank} ${r.position}) ${r.name} — ${r.college} - ${r.hometown} - ${r.height} ${r.weight} | G:${r.grade} | ${starsToEmoji(r.stars)}${aa}`;
  });
  const chunkSize = 25;
  const embeds = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, i + chunkSize);
    const embed = new EmbedBuilder()
      .setTitle(i === 0 ? "ESPN's Top 50 High School Recruits" : "ESPN's Top 50 High School Recruits (cont.)")
      .setDescription(chunk.join('\n\n') || 'No recruits found.');
    embeds.push(embed);
  }

  await interaction.editReply({ embeds });
}

export default { data, execute };
