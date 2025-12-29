import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { readRoster, normalizeName } from '../../utils/rosterUtils.js';

export const data = new SlashCommandBuilder()
  .setName('rostervalidate')
  .setDescription('Scan rosters for missing teams, malformed files, and duplicate players.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const rosterDir = path.join(process.cwd(), 'data', 'teams_rosters');
  const coachRoleMapPath = path.join(process.cwd(), 'data', 'coachRoleMap.json');
  let teamNames = [];
  try {
    const coachMap = JSON.parse(fs.readFileSync(coachRoleMapPath, 'utf8'));
    teamNames = Object.keys(coachMap || {});
  } catch {
    // fallback: derive from filenames
    teamNames = fs.readdirSync(rosterDir).filter(f => f.endsWith('.json') && f !== 'free_agency.json').map(f => f.replace('.json', '').replace(/_/g, ' '));
  }

  const missing = [];
  const malformed = [];
  const duplicates = new Map(); // normName -> Set of teams

  for (const team of teamNames) {
    const rosterData = readRoster(team);
    if (!rosterData) {
      missing.push(team);
      continue;
    }
    const { roster } = rosterData;
    if (!Array.isArray(roster.players)) {
      malformed.push(team);
      continue;
    }
    for (const player of roster.players) {
      if (!player?.name) continue;
      const key = normalizeName(player.name);
      if (!duplicates.has(key)) duplicates.set(key, new Set());
      duplicates.get(key).add(team);
    }
  }

  const dupList = [];
  for (const [key, teams] of duplicates.entries()) {
    if (teams.size > 1) {
      dupList.push({ name: key, teams: Array.from(teams) });
    }
  }

  const lines = [];
  lines.push(`Checked ${teamNames.length} teams.`);
  lines.push(missing.length ? `Missing rosters (${missing.length}): ${missing.join(', ')}` : 'No missing rosters.');
  lines.push(malformed.length ? `Malformed rosters (${malformed.length}): ${malformed.join(', ')}` : 'No malformed rosters.');
  if (dupList.length) {
    const dupStr = dupList.map(d => `${d.name}: ${d.teams.join(', ')}`).join('\n');
    lines.push(`Duplicate players (${dupList.length}):\n${dupStr}`);
  } else {
    lines.push('No duplicate players found.');
  }

  await interaction.editReply({ content: lines.join('\n') });
}

export default { data, execute };
