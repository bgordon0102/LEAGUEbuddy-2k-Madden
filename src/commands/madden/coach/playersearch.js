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

// Lightweight reuse of trade value logic (mirrors madden-tradevalue)
function posWeight(position) {
  const map = {
    QB: 1.6,
    WR: 0.27,
    TE: 0.21,
    HB: 0.25,
    FB: -0.65,
    LT: 0.17, RT: 0.17, LG: 0.10, RG: 0.10, C: 0.13, LS: -0.4,
    REDGE: 0.29, LEDGE: 0.27, DT: 0.22,
    MIKE: 0.29, WILL: 0.27, SAM: 0.22, MLB: 0.27,
    CB: 0.29, FS: 0.19, SS: 0.21,
    K: -0.85, P: -0.90,
  };
  return map[position] ?? 0;
}
function devBonus(devTrait) {
  if (devTrait === 3) return 0.6;
  if (devTrait === 2) return 0.3;
  if (devTrait === 1) return 0.05;
  return -0.2;
}
function yearsLeftBonus(yearsLeft) {
  const table = { 0: -0.2, 1: -0.1, 2: 0, 3: 0.1, 4: 0.15, 5: 0.2, 6: 0.25, 7: 0.3, 8: 0.35 };
  const clamped = Math.max(0, Math.min(8, Math.round(yearsLeft)));
  return table[clamped] ?? 0;
}
function ageAdjust(age) {
  if (!Number.isFinite(age)) return 0;
  if (age <= 20) return 4.2;
  if (age <= 22) return 3.3 - (age - 22) * 0.3;
  if (age <= 25) return 2.4 - (age - 23) * 0.45;
  if (age <= 27) return 0.6 - (age - 25) * 0.15;
  if (age <= 29) return 0.2 - (age - 27) * 0.1;
  if (age <= 32) return -0.1 - (age - 30) * 0.2;
  if (age <= 35) return -0.7 - (age - 33) * 0.3;
  if (age <= 38) return -1.55 - (age - 38) * 0.1;
  return -1.7;
}
function capHitAdjust(cap) {
  if (!Number.isFinite(cap)) return 0;
  if (cap < 1_000_000) return 0.25;
  if (cap < 2_000_000) return 0.20;
  if (cap < 4_000_000) return 0.10;
  if (cap < 7_000_000) return 0.00;
  if (cap < 10_000_000) return -0.10;
  if (cap < 15_000_000) return -0.20;
  return -0.30;
}
function computePlayerValue(p) {
  if (!p) return 0;
  const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? 0;
  const age = p.age ?? 26;
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  const yearsLeft = p.contractYearsLeft ?? p.desiredLength ?? 2;
  const base = Math.pow(Math.max(ovr, 60), 1.8) / 5;
  const posAdj = posWeight(p.position);
  const dev = devBonus(p.devTrait);
  const ageAdj = ageAdjust(age);
  const capAdj = capHitAdjust(cap);
  const yearsAdj = yearsLeftBonus(yearsLeft);
  const raw = base * (1 + posAdj) + dev + ageAdj + capAdj + yearsAdj;
  return Math.max(0.1, Math.round(raw * 10) / 10);
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
