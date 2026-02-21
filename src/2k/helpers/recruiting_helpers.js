import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Single recruiting file for the whole 2K season
const RECRUITING_PATH = path.resolve('data/draft_classes/2k/2k26_CUS01 - Recruiting.json');
const PAGE_SIZE = 10;

export function loadRecruiting() {
  try {
    const raw = fs.readFileSync(RECRUITING_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const recruits = Object.values(data || {}).filter(Boolean);
    return recruits.sort((a, b) => {
      const aRank = Number(a.national_rank ?? a['#'] ?? 9999);
      const bRank = Number(b.national_rank ?? b['#'] ?? 9999);
      return aRank - bRank;
    });
  } catch {
    return null;
  }
}

export const starsToEmoji = stars => {
  const n = Number(stars);
  if (!Number.isFinite(n)) return '⭐';
  const val = Math.round(n);
  if (val >= 5) return '⭐⭐⭐⭐⭐';
  if (val >= 4) return '⭐⭐⭐⭐';
  if (val >= 3) return '⭐⭐⭐';
  if (val >= 2) return '⭐⭐';
  return '⭐';
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export function buildRecruitingEmbed(pageIndex, recruits) {
  const pages = chunk(recruits, PAGE_SIZE);
  const safeIndex = Math.min(Math.max(pageIndex, 0), pages.length - 1);
  const page = pages[safeIndex] || [];

  const lines = page.map(r => {
    const rank = r.national_rank ?? r['#'] ?? '?';
    const rawStars = r.stars ?? r.star_rating ?? r['star rating'] ?? r['star_rating'];
    const starStr = starsToEmoji(rawStars);
    const school = r.college || r.school || 'Uncommitted';
    const pos = r.position || 'Pos';
    const name = r.name || 'Unknown';
    const ht = r.height || 'N/A';
    const wt = r.weight ? `${r.weight} lbs` : 'N/A';
    const posRank = r.pos_rank ?? r.positional_rank;
    const grade = r.grade;
    const hometown = r.hometown;
    const burger = r.all_american ? ' 🍔' : '';
    const detailParts = [
      `NR: #${rank}`,
      `Ht/Wt: ${ht} / ${wt}`,
      hometown ? `Hometown: ${hometown}` : null,
      posRank ? `PR: ${posRank}` : null,
      grade ? `Grade: ${grade}` : null,
    ].filter(Boolean);
    return `${rank}. ${pos} ${name} - ${school} (${starStr})${burger}\n${detailParts.join(' | ')}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('2026 Top 50 ESPN High School Recruits')
    .setDescription(lines.join('\n\n') || 'No recruiting data found.')
    .setFooter({ text: `Page ${safeIndex + 1}/${pages.length}` })
    .setColor(0x1E90FF);

  const pageNumber = safeIndex + 1;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`2k_recruiting_page_${pageNumber - 1}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Prev')
      .setDisabled(safeIndex <= 0),
    new ButtonBuilder()
      .setCustomId(`2k_recruiting_page_${pageNumber + 1}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Next')
      .setDisabled(safeIndex >= pages.length - 1)
  );

  return { embed, row, totalPages: pages.length };
}

export const PAGE_SIZE_2K = PAGE_SIZE;
