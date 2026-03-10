import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder } from 'discord.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const PICK_FILE = path.join(process.cwd(), 'data', 'madden', 'pick_overrides.json');

function loadOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(PICK_FILE, 'utf8'));
    return Array.isArray(raw?.overrides) ? raw.overrides : [];
  } catch {
    return [];
  }
}

function saveOverrides(list) {
  fs.mkdirSync(path.dirname(PICK_FILE), { recursive: true });
  fs.writeFileSync(PICK_FILE, JSON.stringify({ overrides: list }, null, 2));
}

function latestSeasonYear() {
  const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (!files.length) return null;
    const latest = files
      .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;
    const data = JSON.parse(fs.readFileSync(path.join(dir, latest), 'utf8'));
    return data?.info?.careerHubInfo?.seasonInfo?.calendarYear
      || data?.info?.calendarYear
      || data?.calendarYear
      || null;
  } catch {
    return null;
  }
}

export const data = new SlashCommandBuilder()
  .setName('madden-picktrade')
  .setDescription('[Staff] Set or clear a traded 1st-round pick for mock draft')
  .addStringOption(opt =>
    opt.setName('from')
      .setDescription('Original owning team (e.g., Falcons)')
      .setRequired(true))
  .addStringOption(opt =>
    opt.setName('to')
      .setDescription('New owning team (e.g., Rams). Leave blank when clearing.')
      .setRequired(false))
  .addIntegerOption(opt =>
    opt.setName('year')
      .setDescription('Draft year (default: current league year)')
      .setMinValue(2024)
      .setMaxValue(2040)
      .setRequired(false))
  .addStringOption(opt =>
    opt.setName('via')
      .setDescription('Short via tag to display (e.g., ATL)')
      .setRequired(false))
  .addBooleanOption(opt =>
    opt.setName('clear')
      .setDescription('Remove existing override for this team/year')
      .setRequired(false));

export async function execute(interaction) {
  const roleMap = loadRoleMap();
  if (!hasStaffRole(interaction.member, roleMap)) {
    await interaction.reply({ content: 'Only Ghost Legacy Commish/Co-Commish can use this command.', ephemeral: true });
    return;
  }

  const from = interaction.options.getString('from')?.trim();
  const to = interaction.options.getString('to')?.trim();
  const via = interaction.options.getString('via')?.trim() || null;
  const clear = interaction.options.getBoolean('clear') || false;
  const year = interaction.options.getInteger('year') || latestSeasonYear() || new Date().getFullYear();

  if (!from) {
    await interaction.reply({ content: 'Provide the original team name.', ephemeral: true });
    return;
  }
  if (!clear && !to) {
    await interaction.reply({ content: 'Provide the new owning team or use clear=true to remove.', ephemeral: true });
    return;
  }

  const list = loadOverrides();
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const filtered = list.filter(o => !(norm(o.from || o.owner) === norm(from) && Number(o.year || year) === Number(year)));

  if (!clear) {
    filtered.push({
      from,
      to,
      via: via || from.slice(0, 3).toUpperCase(),
      year,
      round: 1,
      updatedAt: new Date().toISOString(),
    });
  }

  saveOverrides(filtered);
  await interaction.reply({
    content: clear
      ? `Cleared 1st-round override for ${from} (${year}).`
      : `Saved 1st-round override: ${from} -> ${to} (${year}) via ${via || from.slice(0,3).toUpperCase()}.`,
    ephemeral: true,
  });
}

export default { data, execute };
