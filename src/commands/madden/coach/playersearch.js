import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

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
  .setDescription('Search Madden players in the latest synced roster.')
  .addStringOption(o =>
    o.setName('name')
      .setDescription('Player name (partial ok)')
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
  const rosters = snapshot?.rosters?.teams || {};
  const focused = (interaction.options.getFocused() || '').toLowerCase();

  const names = [];
  Object.values(rosters).forEach(team => {
    (team?.rosterInfoList || []).forEach(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim();
      if (full) names.push(full);
    });
  });

  // Dedupe and sort alphabetically
  const sorted = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
  const filtered = sorted.filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(filtered.map(n => ({ name: n, value: n })));
}

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-setleague first.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name').toLowerCase();
  await interaction.deferReply({ ephemeral: true });

  const snapshot = loadLeagueSnapshot(leagueId);
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const teamById = Object.fromEntries(teams.map(t => [Number(t.teamId), t.displayName || t.nickName || t.cityName || `Team ${t.teamId}`]));
  const rosters = snapshot?.rosters?.teams || {};
  const devEmojis = safeReadJSON(DEV_EMOJI_PATH, {});

  const matches = [];
  Object.values(rosters).forEach(team => {
    (team?.rosterInfoList || []).forEach(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
      if (full.includes(name)) matches.push(p);
    });
  });

  if (!matches.length) {
    await interaction.editReply({ content: `No players found matching "${name}".` });
    return;
  }

  const top = matches.slice(0, 5);
  const fields = top.map(p => {
    const teamName = teamById[Number(p.teamId)] || 'FA/Unknown';
    const dev = devLabel(p.devTrait, devEmojis);
    const ht = heightToFeetInches(p.height);
    const wt = p.weight ? `${p.weight} lbs` : 'N/A';
    return {
      name: `${p.position || ''} ${p.firstName || ''} ${p.lastName || ''}`.trim(),
      value: [
        `Team: ${teamName}`,
        `OVR: ${p.playerBestOvr ?? 'N/A'} • Dev: ${dev}`,
        `Ht/Wt: ${ht} / ${wt}`
      ].join('\n')
    };
  });

  const embed = new EmbedBuilder()
    .setTitle('Madden Player Search')
    .setDescription(`Showing ${fields.length} of ${matches.length} match(es).`)
    .addFields(fields)
    .setColor(0x1e90ff);

  await interaction.editReply({ embeds: [embed] });
}

export default { data, execute, autocomplete };
