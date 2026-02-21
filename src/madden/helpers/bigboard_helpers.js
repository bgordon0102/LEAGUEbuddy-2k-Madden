import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig } from '../madden_data.js';

const DRAFT_DIR = path.join(process.cwd(), 'data', 'draft_classes', 'madden');

function safeReadJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function classIdForSeason(calendarYear) {
  const idx = Math.max(1, (calendarYear || 2025) - 2025 + 1);
  return `cus_${String(idx).padStart(2, '0')}`;
}

function findClassFile(classId) {
  if (!fs.existsSync(DRAFT_DIR)) return null;
  const patterns = [
    classId.toLowerCase(),
    classId.replace('_', '').toLowerCase(),       // cus01
    classId.replace('_', '').toUpperCase(),       // CUS01
  ];
  const files = fs.readdirSync(DRAFT_DIR).filter(f => {
    const low = f.toLowerCase();
    return patterns.some(p => low.includes(p)) && low.endsWith('.json');
  });
  if (files.length) return path.join(DRAFT_DIR, files[0]);
  const allJson = fs.readdirSync(DRAFT_DIR).filter(f => f.toLowerCase().endsWith('.json'));
  return allJson.length ? path.join(DRAFT_DIR, allJson[0]) : null;
}

function loadDraftClass(classId) {
  const file = findClassFile(classId);
  if (!file) return null;
  return safeReadJSON(file, null);
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export function buildPages(snapshot, classIdOverride = null, leagueId = null) {
  const calendarYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const classId = classIdOverride || classIdForSeason(calendarYear);
  const draftData = loadDraftClass(classId);
  if (!draftData) throw new Error(`Draft class ${classId} not found`);

  const prospects = Object.values(draftData || {}).sort((a, b) => (a.RNK ?? a.rank ?? a.order ?? 9999) - (b.RNK ?? b.rank ?? b.order ?? 9999));
  const lines = prospects.map((p, idx) => `${idx + 1}. ${p.position || ''} ${p.name || 'Unknown'} - ${p.school || 'N/A'}`);
  const pages = chunk(lines, 32);
  const embeds = pages.map((page, idx) => new EmbedBuilder()
    .setTitle(`Madden Big Board — ${classId.toUpperCase()} (Page ${idx + 1}/${pages.length})`)
    .setDescription(page.join('\n'))
    .setColor(0x00b0f4)
  );
  const baseId = leagueId ? `madden_bigboard_page_${leagueId}_${classId}` : `madden_bigboard_page_${classId}`;
  return { embeds, baseId };
}

export { classIdForSeason, loadDraftClass };
