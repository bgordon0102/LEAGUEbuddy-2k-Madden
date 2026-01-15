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

// Trade value: VALUE = OVERALL * (1.0 + POSITION + AGE + DEV TRAIT + YEARS LEFT + CAP HIT)
function posAdj(position) {
  const map = {
    QB: 0.25, WR: 0.05, CB: 0.05, REDGE: 0.08, LEDGE: 0.08, DT: 0.02,
    LT: 0.05, RT: 0.04, LG: 0, RG: 0, C: 0,
    FS: 0, SS: 0, MLB: -0.02, WILL: -0.02, SAM: -0.02,
    HB: -0.05, FB: -0.2, TE: -0.02, K: -0.4, P: -0.4, LS: -0.5,
  };
  return map[position] || 0;
}
function ageAdj(age) {
  if (!age) return 0;
  if (age <= 24) return 0.08;
  if (age <= 27) return 0.04;
  if (age <= 29) return 0;
  if (age <= 32) return -0.04;
  return -0.08;
}
function devAdj(devTrait) {
  if (devTrait === 3) return 0.28;
  if (devTrait === 2) return 0.20;
  if (devTrait === 1) return 0.12;
  return 0;
}
function yearsAdj(yearsLeftRaw) {
  const years = Number(yearsLeftRaw ?? 0);
  if (!Number.isFinite(years) || years <= 0) return 0;
  return Math.min(years, 4) * 0.015;
}
function capAdj(cap) {
  const c = Number(cap || 0);
  if (!Number.isFinite(c) || c <= 0) return 0;
  return -Math.min(c / 150, 0.2);
}
function computePlayerValue(p) {
  if (!p) return 0;
  const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? 0;
  const age = p.age ?? 26;
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  const yearsLeft = p.contractYearsLeft ?? p.contractLengthRemaining ?? p.contractLength ?? p.yearsRemaining ?? p.desiredLength ?? 0;

  const pos = posAdj(p.position);
  const ageFactor = ageAdj(age);
  const dev = devAdj(p.devTrait);
  const yrs = yearsAdj(yearsLeft);
  const capHit = capAdj(cap);

  const multiplier = 1.0 + pos + ageFactor + dev + yrs + capHit;
  const safeMultiplier = Math.max(0.1, multiplier);
  const base = Math.pow(Math.max(0, ovr - 40), 2) / 10;
  const raw = base * safeMultiplier;
  return Math.max(1, Math.round(raw * 10) / 10);
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
    const names = teams.map(t => `${t.cityName} ${t.displayName || t.nickName || ''}`.trim());
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
        `${t.cityName || ''} ${t.displayName || t.nickName || ''}`,
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
      `${t.cityName || ''} ${t.displayName || t.nickName || ''}`,
    ].map(x => (x || '').toLowerCase());
    const target = (teamInput || '').toLowerCase();
    return variants.some(v => target.includes(v) || v.includes(target));
  });
  const teamId = teamMatch?.teamId;
  if (!teamId) {
    await interaction.editReply({ content: 'Team not found. Please select a team from the list.' });
    return;
  }
  const teamName = `${teamMatch.cityName || ''} ${teamMatch.displayName || teamMatch.nickName || ''}`.trim() || 'Unknown';
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
