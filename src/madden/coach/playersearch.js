import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { computePlayerValue } from '../../../madden/madden_trade_modal_submit.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';

const DEV_EMOJI_PATH = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function devLabel(dev, emojis) {
  const emojiId = emojis?.[dev] ?? emojis?.[String(dev)];
  if (emojiId) return `<:dev_${dev}:${emojiId}>`;
  const map = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
  return map[dev] || 'Normal';
}

function heightToFeetInches(h) {
  const inches = Number(h);
  if (!Number.isFinite(inches)) return 'N/A';
  const ft = Math.floor(inches / 12);
  const rem = inches % 12;
  return `${ft}'${rem}"`;
}

export const data = new SlashCommandBuilder()
  .setName('madden-playersearch')
  .setDescription('Search Madden players in the latest synced roster by team and position.')
  .addStringOption(o =>
    o.setName('team')
      .setDescription('Team (start typing to select)')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(o => {
    o.setName('position')
      .setDescription('Player position')
      .setRequired(true);
    const POSITIONS = ['QB', 'HB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LS', 'LEDGE', 'REDGE', 'DT', 'SAM', 'WILL', 'MIKE', 'CB', 'FS', 'SS', 'K', 'P'];
    POSITIONS.forEach(p => o.addChoices({ name: p, value: p }));
    return o;
  })
  .addStringOption(o =>
    o.setName('player')
      .setDescription('Player on that team/position')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .setDMPermission(false);

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.respond([]);
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const focused = (interaction.options.getFocused() || '').toLowerCase();
  const focusedName = interaction.options.getFocused(true).name;
  const teams = snapshot?.teams?.leagueTeamInfoList || [];

  // Team autocomplete
  if (focusedName === 'team') {
    const names = teams.map(t => getFullTeamName(t, `Team ${t.teamId}`));
    const filtered = names
      .filter(n => n.toLowerCase().includes(focused))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  // Player autocomplete depends on selected team (and position if provided)
  const teamOpt = interaction.options.getString('team');
  const positionOpt = interaction.options.getString('position');
  if (focusedName === 'player') {
    if (!teamOpt) return interaction.respond([]);
    const teamMatch = teams.find(t => {
      const variants = [
        t.displayName, t.nickName, t.cityName, t.abbrName,
        getFullTeamName(t, ''),
      ].map(x => (x || '').toLowerCase());
      return variants.some(v => teamOpt.toLowerCase().includes(v) || v.includes(teamOpt.toLowerCase()));
    });
    const teamId = teamMatch?.teamId;
    const roster = teamId ? (snapshot?.rosters?.teams?.[teamId]?.rosterInfoList || []) : [];
    const names = roster
      .filter(p => !positionOpt || (p.position || '').toLowerCase() === positionOpt.toLowerCase())
      .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
      .filter(Boolean);
    const filtered = Array.from(new Set(names))
      .filter(n => n.toLowerCase().includes(focused))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 25);
    return interaction.respond(filtered.map(n => ({ name: n, value: n })));
  }

  return interaction.respond([]);
}

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-setleague first.', ephemeral: true });
    return;
  }
  const teamInput = interaction.options.getString('team');
  const positionInput = interaction.options.getString('position');
  const playerInput = interaction.options.getString('player');
  await interaction.deferReply({ ephemeral: true });

  const snapshot = loadLeagueSnapshot(leagueId);
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const teamMatch = teams.find(t => {
    const variants = [
      t.displayName, t.nickName, t.cityName, t.abbrName,
      getFullTeamName(t, ''),
    ].map(x => (x || '').toLowerCase());
    const target = (teamInput || '').toLowerCase();
    return variants.some(v => target.includes(v) || v.includes(target));
  });
  const teamId = teamMatch?.teamId;
  if (!teamId) {
    await interaction.editReply({ content: 'Team not found. Please select a team from the list.' });
    return;
  }
  const teamName = getFullTeamName(teamMatch, 'Unknown');
  const roster = (snapshot?.rosters?.teams?.[teamId]?.rosterInfoList) || [];
  const rosters = snapshot?.rosters?.teams || {};
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});

  const matches = roster.filter(p => {
    const full = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
    const posOk = !positionInput || (p.position || '').toLowerCase() === positionInput.toLowerCase();
    return posOk && full === playerInput.toLowerCase();
  });

  if (!matches.length) {
    await interaction.editReply({ content: 'Player not found for that team/position.' });
    return;
  }

  const p = matches[0];
  const dev = devLabel(p.devTrait, devEmojis);
  const ht = heightToFeetInches(p.height);
  const wt = p.weight ? `${p.weight} lbs` : 'N/A';
  const years = Number.isFinite(p.yearsPro) ? `${p.yearsPro}` : 'N/A';
  const ovr = p.playerBestOvr ?? p.overallRating ?? 'N/A';
  const tradeVal = computePlayerValue(p);
  const desc = [
    `Team: ${teamName}`,
    `OVR: ${ovr} • Dev: ${dev}`,
    `Ht/Wt: ${ht} / ${wt}`,
    `Age: ${p.age ?? 'N/A'} • Years Pro: ${years}`,
    `Est. Trade Value: ${tradeVal.toFixed(1)}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${p.position || ''} ${p.firstName || ''} ${p.lastName || ''}`.trim())
    .setDescription(desc)
    .setColor(0x1e90ff);

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute, autocomplete };
