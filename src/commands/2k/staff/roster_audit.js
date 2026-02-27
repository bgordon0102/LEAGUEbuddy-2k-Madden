import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';

const ROSTER_DIR = path.join(process.cwd(), 'data', '2k', 'teams_rosters');

function loadTeamFiles() {
  return fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
}

function normalizeName(name = '') {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function readRoster(file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROSTER_DIR, file), 'utf8'));
    const players = Array.isArray(data.players) ? data.players : Array.isArray(data) ? data : [];
    const picks = Array.isArray(data.picks) ? data.picks : [];
    return { players, picks };
  } catch {
    return { players: [], picks: [] };
  }
}

function pickLabel(p) {
  return typeof p === 'string' ? p : p?.pick || '';
}

export const data = new SlashCommandBuilder()
  .setName('2k-roster-audit')
  .setDescription('Audit rosters for duplicate players and conflicts with free agency.')
  .addStringOption(opt =>
    opt.setName('team')
      .setDescription('Team name (leave empty for all teams)')
      .setRequired(false))
  .addStringOption(opt =>
    opt.setName('scope')
      .setDescription('What to check')
      .addChoices(
        { name: 'all', value: 'all' },
        { name: 'players', value: 'players' },
        { name: 'picks', value: 'picks' },
      )
      .setRequired(false));

export async function execute(interaction) {
  const scope = interaction.options.getString('scope') || 'all';
  const teamFilter = interaction.options.getString('team');

  // Load all teams + free agency for conflicts
  const files = loadTeamFiles().filter(f => f.toLowerCase() !== 'free_agency.json');
  const freeAgency = readRoster('free_agency.json').players.map(p => p.name);
  const freeAgencyNorm = freeAgency.map(normalizeName);

  const targets = teamFilter
    ? files.filter(f => normalizeName(f.replace('.json', '')) === normalizeName(teamFilter.replace(' ', '_')))
    : files;

  if (!targets.length) {
    await interaction.reply({ content: 'No matching teams found.', ephemeral: true });
    return;
  }

  // Build cross-team map for players
  const globalMap = new Map(); // normName -> [team]
  for (const file of files) {
    const { players } = readRoster(file);
    for (const p of players) {
      const norm = normalizeName(p.name);
      if (!norm) continue;
      if (!globalMap.has(norm)) globalMap.set(norm, []);
      globalMap.get(norm).push(file.replace('.json', ''));
    }
  }

  const issues = [];

  for (const file of targets) {
    const teamName = file.replace('.json', '').replace(/_/g, ' ');
    const { players, picks } = readRoster(file);

    // Same-team duplicate names
    if (scope === 'all' || scope === 'players') {
      const seen = new Set();
      const dups = [];
      for (const p of players) {
        const norm = normalizeName(p.name);
        if (seen.has(norm)) dups.push(p.name);
        else seen.add(norm);
      }
      if (dups.length) issues.push(`**${teamName}**: duplicate players on roster → ${dups.join(', ')}`);

      // Player also on another team
      const multi = [];
      for (const p of players) {
        const norm = normalizeName(p.name);
        const teams = globalMap.get(norm) || [];
        if (teams.length > 1) multi.push(`${p.name} (also on ${teams.filter(t => t !== file.replace('.json','')).join(', ') || 'FA'})`);
      }
      if (multi.length) issues.push(`**${teamName}**: player on multiple teams → ${multi.join('; ')}`);

      // Player also in FA
      const faConflicts = players.filter(p => freeAgencyNorm.includes(normalizeName(p.name))).map(p => p.name);
      if (faConflicts.length) issues.push(`**${teamName}**: player also in Free Agency → ${faConflicts.join(', ')}`);
    }

    // Picks sanity
    if (scope === 'all' || scope === 'picks') {
      const labels = picks.map(pickLabel).filter(Boolean);
      const seenPick = new Set();
      const dupPicks = [];
      for (const lbl of labels) {
        if (seenPick.has(lbl)) dupPicks.push(lbl);
        else seenPick.add(lbl);
      }
      if (dupPicks.length) issues.push(`**${teamName}**: duplicate picks → ${dupPicks.join(', ')}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('2K Roster Audit')
    .setTimestamp(new Date());

  if (!issues.length) {
    embed.setColor(0x57F287).setDescription('All clear. No issues found.');
  } else {
    const desc = issues.slice(0, 20).join('\n');
    embed.setColor(0xED4245).setDescription(desc.length ? desc : 'Issues found.');
    if (issues.length > 20) embed.addFields({ name: 'More', value: `+${issues.length - 20} more…` });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export default { data, execute };
