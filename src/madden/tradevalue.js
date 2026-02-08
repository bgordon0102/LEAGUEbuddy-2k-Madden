import { SlashCommandBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../madden/madden_data.js';

function buildRosterIndex(snapshot) {
  const index = [];
  const teams = snapshot?.rosters?.teams || {};
  Object.values(teams).forEach(team => {
    (team?.rosterInfoList || []).forEach(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim();
      index.push({
        name: full || p.displayName || p.playerName || p.fullName || '',
        rosterId: p.rosterId || p.playerId || p.esnId,
        position: (p.position || '').toUpperCase(),
        ovr: p.playerBestOvr || p.playerSchemeOvr || p.ovr || 0,
        teamId: team.teamId,
        teamName: team.teamName || team.name || '',
      });
    });
  });
  return index;
}

function findPlayers(index, input) {
  const terms = (input || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const picks = [];
  const missing = [];
  terms.forEach(term => {
    const t = term.toLowerCase();
    const hit = index.find(p => p.name.toLowerCase() === t) || index.find(p => p.name.toLowerCase().includes(t));
    if (hit) picks.push(hit); else missing.push(term);
  });
  return { picks, missing };
}

export const data = new SlashCommandBuilder()
  .setName('madden-tradevalue')
  .setDescription('Quickly total trade value (OVR) for two sides of a trade (comma-separated names).')
  .addStringOption(o => o.setName('team_a').setDescription('Players for Team A (comma-separated names)').setRequired(true))
  .addStringOption(o => o.setName('team_b').setDescription('Players for Team B (comma-separated names)').setRequired(true))
  .setDMPermission(false);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply('No league configured. Run /madden-set-league first.');
    return;
  }
  let snap;
  try {
    snap = loadLeagueSnapshot(leagueId);
  } catch (e) {
    await interaction.editReply('Could not load league snapshot.');
    return;
  }
  const rosterIdx = buildRosterIndex(snap);
  const sideA = interaction.options.getString('team_a');
  const sideB = interaction.options.getString('team_b');
  const { picks: aPlayers, missing: aMissing } = findPlayers(rosterIdx, sideA);
  const { picks: bPlayers, missing: bMissing } = findPlayers(rosterIdx, sideB);

  const fmt = (p) => `${p.position} ${p.name} (OVR ${p.ovr})`;
  const sum = arr => arr.reduce((acc, p) => acc + (Number(p.ovr) || 0), 0);
  const totalA = sum(aPlayers);
  const totalB = sum(bPlayers);

  const lines = [];
  lines.push(`**Team A Total**: ${totalA}`);
  lines.push(aPlayers.length ? aPlayers.map(fmt).join('\n') : '_none_');
  lines.push('');
  lines.push(`**Team B Total**: ${totalB}`);
  lines.push(bPlayers.length ? bPlayers.map(fmt).join('\n') : '_none_');
  if (aMissing.length || bMissing.length) {
    lines.push('\nMissing matches:');
    if (aMissing.length) lines.push(`Team A: ${aMissing.join(', ')}`);
    if (bMissing.length) lines.push(`Team B: ${bMissing.join(', ')}`);
  }

  await interaction.editReply({ content: lines.join('\n') });
}

export default { data, execute };
