import fs from 'fs';
import path from 'path';
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { computePlayerValue } from '../../../interactions/madden_trade_modal_submit.js';

const DEV_LABEL = { 0: 'Normal', 1: 'Star', 2: 'SS', 3: 'X' };
const DEV_EMOJI_FILE = path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function num(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function capHit(p) {
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  return cap > 0 ? `$${(cap / 1_000_000).toFixed(1)}M` : '—';
}

function dev(p, emojis) {
  const d = p.devTrait ?? p.dev ?? 0;
  const emojiId = emojis?.[d] ?? emojis?.[String(d)];
  if (emojiId) return `<:dev_${d}:${emojiId}>`;
  return DEV_LABEL[d] || DEV_LABEL[0];
}

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findTeam(snapshot, name) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const target = normalize(name);
  const label = (t) => [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
  // Build candidate keys
  const withCandidates = teams.map(t => {
    const candidates = [
      t.cityName,
      t.displayName || t.nickName,
      t.displayName,
      t.teamName,
      t.abbrName,
      label(t),
    ].filter(Boolean).map(normalize);
    return { team: t, candidates };
  });
  // Exact match first
  const exact = withCandidates.find(({ candidates }) => candidates.some(c => c === target));
  if (exact) return exact.team;
  // Prefix match next
  const prefix = withCandidates.find(({ candidates }) => candidates.some(c => target.startsWith(c) || c.startsWith(target)));
  if (prefix) return prefix.team;
  // Fallback to includes
  const fuzzy = withCandidates.find(({ candidates }) => candidates.some(c => c.includes(target) || target.includes(c)));
  return fuzzy?.team;
}

function chunkLines(lines, maxCount = 12) {
  const chunks = [];
  let current = [];
  for (const line of lines) {
    if (current.length >= maxCount) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export const data = new SlashCommandBuilder()
  .setName('madden-roster')
  .setDescription('View the full roster for a Madden team')
  .addStringOption(o =>
    o.setName('team')
      .setDescription('Team name (city, nickname, or abbreviation)')
      .setRequired(true)
      .setAutocomplete(true)
  );

export function buildRosterEmbeds(snapshot, teamName) {
  const teamInfo = findTeam(snapshot, teamName);
  if (!teamInfo) return { error: `Team not found for "${teamName}". Try full city or nickname.` };
  const teamId = teamInfo.teamId;
  const roster = snapshot?.rosters?.teams?.[teamId]?.rosterInfoList || [];
  if (!roster.length) return { error: `No roster data for ${teamInfo.cityName} ${teamInfo.nickName}.` };

  const lines = roster
    .slice()
    .sort((a, b) => (Number(b.overallRating ?? b.playerBestOvr ?? b.ovrRating ?? 0) - Number(a.overallRating ?? a.playerBestOvr ?? a.ovrRating ?? 0)))
    .map(p => {
    const pos = p.position || '—';
    const age = p.age ?? '—';
    const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? '—';
    const devTrait = dev(p, loadJson(DEV_EMOJI_FILE, {}));
    const cap = capHit(p);
    const value = num(computePlayerValue(p));
    const name = `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unknown';
    return `**${pos}** ${name} • OVR ${ovr} • Age ${age} • Dev ${devTrait} • Cap ${cap} • Value ${value}`;
  });

  const chunks = chunkLines(lines, 12);
  const embeds = chunks.map((chunk, idx) => new EmbedBuilder()
    .setTitle(`${teamInfo.cityName} ${teamInfo.displayName || teamInfo.nickName} — Roster`)
    .setDescription(chunk.join('\n'))
    .setColor(0x00a3ff)
    .setFooter({ text: chunks.length > 1 ? `Page ${idx + 1}/${chunks.length}` : null })
  );
  return { embeds, teamInfo };
}

export async function execute(interaction) {
  const teamInput = interaction.options.getString('team');
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No Madden league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    if (!snapshot) {
      await interaction.reply({ content: 'Could not load the current Madden league snapshot.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const result = buildRosterEmbeds(snapshot, teamInput);
    if (result.error) {
      await interaction.editReply({ content: result.error });
      return;
    }
    const buttons = [];
    if (result.embeds.length > 1) {
      const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');
      const baseId = `madden_roster_page_${leagueId}_${result.teamInfo.teamId}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${baseId}_0`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`${baseId}_1`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(result.embeds.length <= 1)
      );
      buttons.push(row);
    }
    await interaction.editReply({ embeds: [result.embeds[0]], components: buttons });
  } catch (err) {
    console.error('[madden-roster] failed:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: 'Failed to load roster.' });
    } else {
      await interaction.reply({ content: 'Failed to load roster.', ephemeral: true });
    }
  }
}

export default { data, execute, autocomplete };

export async function autocomplete(interaction) {
  if (!interaction.isAutocomplete()) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const focused = interaction.options.getFocused().toLowerCase();
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    const opts = teams.map(t => [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim());
    const filtered = opts
      .filter(name => name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map(name => ({ name, value: name }));
    await interaction.respond(filtered);
  } catch {
    await interaction.respond([]);
  }
}
