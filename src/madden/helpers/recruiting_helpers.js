import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const RECRUITING_DIR = path.resolve('data/draft_classes/madden');
const CURRENT_CLASS_ID = 'CUS02';
const PAGE_SIZE = 10;

const safeLoadRecruiting = () => {
  try {
    const target = fs.readdirSync(RECRUITING_DIR)
      .filter(f => f.toLowerCase().includes(`${CURRENT_CLASS_ID.toLowerCase()} - recruiting`.toLowerCase()))
      .sort();
    const file = target[0];
    if (!file) return null;
    const raw = fs.readFileSync(path.join(RECRUITING_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    const recruits = Object.values(data || {}).filter(Boolean);
    return recruits.sort((a, b) => {
      const aRank = Number(a.national_rank ?? a['#'] ?? 9999);
      const bRank = Number(b.national_rank ?? b['#'] ?? 9999);
      return aRank - bRank;
    });
  } catch (err) {
    return null;
  }
};

const starsToEmoji = stars => {
  if (!Number.isFinite(stars)) return 'N/A';
  return '⭐'.repeat(Math.min(Math.max(stars, 1), 5));
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const buildRecruitingEmbed = (pageIndex, recruits) => {
  const pages = chunk(recruits, PAGE_SIZE);
  const safeIndex = Math.min(Math.max(pageIndex, 0), pages.length - 1);
  const page = pages[safeIndex] || [];
  const lines = page.map(r => {
    const rank = r.national_rank ?? r['#'] ?? '?';
    const starStr = starsToEmoji(r.stars);
    const school = r.school || 'Uncommitted';
    const pos = r.position || 'Pos';
    const name = r.name || 'Unknown';
    const ht = r.height || 'N/A';
    const wt = r.weight ? `${r.weight} lbs` : 'N/A';
    const posRank = r.pos_rank ? `PR: ${r.pos_rank}` : null;
    const grade = r.grade ? `Grade: ${r.grade}` : null;
    const hometown = r.hometown ? `Hometown: ${r.hometown}` : null;
    const detailParts = [`NR: #${rank}`, `Ht/Wt: ${ht} / ${wt}`].concat([hometown, posRank, grade].filter(Boolean));
    return `${rank}. ${pos} ${name} - ${school} (${starStr})\n${detailParts.join(' | ')}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('2026 Top 50 ESPN High School Recruits')
    .setDescription(lines.join('\n\n') || 'No recruiting data found.')
    .setFooter({ text: `Page ${safeIndex + 1}/${pages.length}` })
    .setColor(0x8a2be2);

  const pageNumber = safeIndex + 1;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_recruiting_page_${pageNumber - 1}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel('Prev')
      .setDisabled(safeIndex <= 0),
    new ButtonBuilder()
      .setCustomId(`madden_recruiting_page_${pageNumber + 1}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel('Next')
      .setDisabled(safeIndex >= pages.length - 1)
  );

  return { embed, row, totalPages: pages.length };
};

export { safeLoadRecruiting, buildRecruitingEmbed, PAGE_SIZE };
