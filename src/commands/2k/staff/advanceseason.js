import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resetSeasonData } from './startseason.js';

const dataDir = path.join(process.cwd(), 'data');
const rostersDir = path.join(dataDir, 'teams_rosters');
const rostersMasterDir = path.join(dataDir, 'teams_rosters_master');
const picksFile = path.join(dataDir, 'team_picks.json');
const picksMasterFile = path.join(dataDir, 'team_picks_master.json');

function promoteToMaster() {
  fs.mkdirSync(rostersMasterDir, { recursive: true });
  const files = fs.readdirSync(rostersDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    fs.copyFileSync(path.join(rostersDir, file), path.join(rostersMasterDir, file));
  }
  if (fs.existsSync(picksFile)) {
    fs.copyFileSync(picksFile, picksMasterFile);
  }
  return files.length;
}

function computeSeasonAge(birthdate, seasonNo) {
  if (!birthdate) return null;
  const baseYear = 2024 + Number(seasonNo || 1); // season 1 => Oct 20, 2025
  const ref = new Date(`${baseYear}-10-20`);
  const dob = new Date(birthdate);
  if (Number.isNaN(dob.getTime())) return null;
  let age = ref.getFullYear() - dob.getFullYear();
  if (ref.getMonth() < dob.getMonth() || (ref.getMonth() === dob.getMonth() && ref.getDate() < dob.getDate())) age--;
  return age;
}

function updateAges(seasonNo) {
  const dir = rostersDir;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const full = path.join(dir, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    const isArray = Array.isArray(data);
    const roster = isArray ? data : data.players || [];
    if (!Array.isArray(roster)) continue;
    const updated = roster.map(p => {
      const age = p.birthdate ? computeSeasonAge(p.birthdate, seasonNo) : (p.age != null ? Number(p.age) + 1 : undefined);
      const years = p?.yearsInNBA;
      const shouldIncrementYears = years != null && years > 0;
      const nextYears = shouldIncrementYears ? years + 1 : years;
      const base = age != null ? { ...p, age } : p;
      return nextYears != null ? { ...base, yearsInNBA: nextYears } : base;
    });
    if (isArray) {
      fs.writeFileSync(full, JSON.stringify(updated, null, 2));
    } else {
      const next = { ...data, players: updated };
      fs.writeFileSync(full, JSON.stringify(next, null, 2));
    }
  }
}

function shiftPicks() {
  if (!fs.existsSync(picksFile)) return;
  let picks = {};
  try { picks = JSON.parse(fs.readFileSync(picksFile, 'utf8')); } catch { return; }
  const updated = {};
  for (const [team, arr] of Object.entries(picks)) {
    if (team.toLowerCase().includes('free agency')) continue;
    if (!Array.isArray(arr)) { updated[team] = arr; continue; }
    const parsed = arr.map(p => {
      if (typeof p === 'string') return p;
      if (p && typeof p.pick === 'string') return p.pick;
      return null;
    }).filter(Boolean);
    const years = parsed.map(p => {
      const m = p.match(/^(\d{4})/);
      return m ? parseInt(m[1], 10) : null;
    }).filter(n => n != null && !Number.isNaN(n));
    if (!years.length) { updated[team] = arr; continue; }
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);
    // Drop all picks from the earliest year
    const kept = parsed.filter(p => {
      const m = p.match(/^(\d{4})/);
      const yr = m ? parseInt(m[1], 10) : null;
      return yr !== minYear;
    });
    const nextYear = maxYear + 1;
    kept.push(`${nextYear} 1st`, `${nextYear} 2nd`);
    updated[team] = kept;
  }
  fs.writeFileSync(picksFile, JSON.stringify(updated, null, 2));
}

export async function runAdvanceSeason(seasonno, guild) {
  // Update ages to new season and roll picks before resetting data
  updateAges(seasonno);
  shiftPicks();
  const teamsCount = await resetSeasonData(seasonno, guild, 'advanceseason', true);
  return { teamsCount };
}

export const data = new SlashCommandBuilder()
  .setName('advanceseason')
  .setDescription('Promote rosters/picks to master and start next season; season number maps draft class')
  .addIntegerOption(option =>
    option.setName('seasonno')
      .setDescription('Season number to set')
      .setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const seasonno = interaction.options.getInteger('seasonno');
  const row = [{
    type: 1,
    components: [
      { type: 2, style: 4, label: 'Confirm Advance', custom_id: `advanceseason_confirm_${seasonno}` },
      { type: 2, style: 2, label: 'Cancel', custom_id: `advanceseason_cancel_${seasonno}` },
    ],
  }];
  await interaction.editReply({
    content: `Advance to Season ${seasonno}? This will:\n• Age all non-rookies to the new season start\n• Roll draft picks (drop earliest year, add next year 1st/2nd)\n• Reset season data (schedule, trades, FA logs, etc.)\n\nMasters will NOT be touched. Are you sure?`,
    components: row,
  });
}

export default { data, execute, runAdvanceSeason, promoteToMaster };
