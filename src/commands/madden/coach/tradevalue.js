import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const POSITIONS = [
  'QB', 'HB', 'FB', 'WR', 'TE',
  'LT', 'LG', 'C', 'RG', 'RT', 'LS',
  'LEDGE', 'REDGE', 'DT', 'SAM', 'WILL', 'MIKE',
  'CB', 'FS', 'SS',
  'K', 'P',
];

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function posWeight(position) {
  const map = {
    QB: 1.25, WR: 1.05, CB: 1.05, REDGE: 1.08, LEDGE: 1.08, DT: 1.02,
    LT: 1.05, RT: 1.04, LG: 1.0, RG: 1.0, C: 1.0,
    FS: 1.0, SS: 1.0, MLB: 0.98, WILL: 0.98, SAM: 0.98,
    HB: 0.95, FB: 0.8, TE: 0.98, K: 0.6, P: 0.6, LS: 0.5,
  };
  return map[position] || 1;
}
function devBonus(devTrait) {
  if (devTrait === 3) return 12;
  if (devTrait === 2) return 8;
  if (devTrait === 1) return 4;
  return 0;
}
function computePlayerValue(p) {
  if (!p) return 0;
  const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? 0;
  const age = p.age ?? 26;
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  const weight = posWeight(p.position);
  const base = Math.pow(ovr, 1.03) * weight;
  const dev = devBonus(p.devTrait);
  const agePenalty = Math.max(0, age - 27) * 1.2;
  const capPenalty = cap ? Math.min(cap / 12, 10) : 0;
  const raw = base + dev - agePenalty - capPenalty;
  return Math.max(1, Math.round(raw * 10) / 10);
}

function parsePickValueDot(label, seasonYear) {
  const m = /^(\d)\.(\d{1,2})(?:\s+(\d{2,4}))?$/.exec(label.trim());
  if (!m) return null;
  const round = Number(m[1]);
  const pick = Number(m[2]);
  let year = seasonYear;
  if (m[3]) {
    const y = Number(m[3]);
    year = y < 100 ? 2000 + y : y;
  }
  if (round < 1 || round > 7 || pick < 1 || pick > 32) return null;
  const baseChart = { 1: 800, 2: 400, 3: 200, 4: 100, 5: 60, 6: 40, 7: 20 };
  const base = baseChart[round] || 10;
  const slider = 1 - ((pick - 1) / 32) * 0.35;
  let val = Math.max(5, Math.round(base * slider * 10) / 10);
  if (seasonYear && year && year > seasonYear) {
    const diff = year - seasonYear;
    const decay = diff === 1 ? 0.85 : 0.7;
    val = Math.max(5, Math.round(val * decay * 10) / 10);
  }
  return val;
}

function findCoachTeamId(member, snapshot, roleMap) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const coachRoles = Object.entries(roleMap).filter(([k]) => k.endsWith(' Coach'));
  const memberRoleIds = new Set(member.roles.cache.keys());
  for (const [name, id] of coachRoles) {
    if (!memberRoleIds.has(id)) continue;
    const base = name.replace(/ Coach$/, '').toLowerCase();
    const team = teams.find(t => {
      const variants = [
        t.displayName, t.nickName, t.cityName, t.abbrName,
        `${t.cityName || ''} ${t.displayName || t.nickName || ''}`,
      ].map(x => (x || '').toLowerCase());
      return variants.some(v => v === base || v.includes(base) || base.includes(v));
    });
    if (team) return team.teamId;
  }
  return null;
}

function findTeamIdByName(snapshot, name) {
  if (!name) return null;
  const target = name.toLowerCase();
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const team = teams.find(t => {
    const variants = [
      t.displayName, t.nickName, t.cityName, t.abbrName,
      `${t.cityName || ''} ${t.displayName || t.nickName || ''}`,
    ].map(x => (x || '').toLowerCase());
    return variants.some(v => v === target || v.includes(target) || target.includes(v));
  });
  return team ? team.teamId : null;
}

function listTeams(snapshot) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  return teams.map(t => `${t.cityName} ${t.displayName || t.nickName || ''}`.trim());
}

function buildPickChoices(seasonYear) {
  const picks = [];
  const baseYear = seasonYear || new Date().getFullYear();
  const years = [baseYear, baseYear + 1, baseYear + 2];
  for (let r = 1; r <= 7; r++) {
    for (let p = 1; p <= 32; p++) {
      const base = `${r}.${p}`;
      years.forEach(y => picks.push(`${base} ${String(y).slice(-2)}`));
    }
  }
  return picks;
}

const data = new SlashCommandBuilder()
  .setName('madden-tradevalue')
  .setDescription('Estimate trade value for one of your players (by position).')
  .addStringOption(o => {
    o.setName('team').setDescription('Team (select from league)').setRequired(true).setAutocomplete(true);
    return o;
  })
  .addStringOption(o => {
    o.setName('position').setDescription('Player position').setRequired(true);
    POSITIONS.forEach(pos => o.addChoices({ name: pos, value: pos }));
    return o;
  })
  .addStringOption(o =>
    o.setName('player')
      .setDescription('Select a player from your roster')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addStringOption(o =>
    o.setName('pick')
      .setDescription('Optional pick, e.g., "1.26", "2.20 27" (current + next 2 years)')
      .setRequired(false)
      .setAutocomplete(true)
  )
  // Removed permission restriction so all coaches can use this command

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) {
      await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
      return;
    }
    const snapshot = loadLeagueSnapshot(leagueId);
    const roleMap = loadJson(ROLE_MAP_FILE);
    const teamOpt = interaction.options.getString('team');
    const teamId = teamOpt ? findTeamIdByName(snapshot, teamOpt) : null;
    if (!teamId) {
      await interaction.editReply({ content: 'Please select a team (start typing to search).' });
      return;
    }
    if (!teamId) {
      await interaction.editReply({ content: 'Could not find your team from your Madden coach role. Make sure you have your team role.' });
      return;
    }
    const position = interaction.options.getString('position');
    const playerName = interaction.options.getString('player');
    const roster = (snapshot?.rosters?.teams?.[teamId] || {}).rosterInfoList || [];
    const match = roster.find(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
      return full === playerName.toLowerCase();
    });
    if (!match) {
      await interaction.editReply({ content: 'Player not found on your roster for that position.' });
      return;
    }

    const val = computePlayerValue(match);
    const devEmoji = (() => {
      try {
        const map = loadJson(path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json'));
        const id = map[String(match.devTrait)] || map.hidden;
        return id ? `<:dev:${id}>` : '';
      } catch { return ''; }
    })();
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
    const pickInput = interaction.options.getString('pick');
    const pickVal = pickInput ? parsePickValueDot(pickInput, seasonYear) : null;

    const desc = [
      `${match.position} ${match.firstName} ${match.lastName} ${devEmoji}`,
      `OVR: ${match.overallRating ?? match.playerBestOvr ?? 'N/A'}`,
      `Age: ${match.age ?? 'N/A'}`,
      `Est. Trade Value: **${val.toFixed(1)}**`,
    ];
    if (pickInput) {
      desc.push(`Pick ${pickInput}: ${pickVal ? pickVal.toFixed(1) : 'N/A (format: 1.1 .. 7.32, picks 1-32, optional year e.g. 1.1 26)'}`);
      if (pickVal) desc.push(`Total (player + pick): ${(val + pickVal).toFixed(1)}`);
    }

    const embed = new EmbedBuilder()
      .setTitle('Trade Value Estimate')
      .setDescription(desc.join('\n'))
      .setColor(0x00b0f4);

    await interaction.editReply({ embeds: [embed] });
  } catch (e) {
    await interaction.editReply({ content: `Trade value lookup failed: ${e?.message || e}` });
  }
}

async function autocomplete(interaction) {
  if (interaction.commandName !== 'madden-tradevalue') return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) return interaction.respond([]);
  let snapshot = null;
  try { snapshot = loadLeagueSnapshot(leagueId); } catch { return interaction.respond([]); }
  const roleMap = loadJson(ROLE_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const focusedRaw = interaction.options.getFocused(true);
  if (focusedRaw?.name === 'team') {
    const teams = listTeams(snapshot);
    const filteredTeams = teams
      .filter(n => n.toLowerCase().includes((focusedRaw.value || '').toLowerCase()))
      .slice(0, 25)
      .map(n => ({ name: n, value: n }));
    return interaction.respond(filteredTeams);
  }
  if (focusedRaw?.name === 'pick') {
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
    const pickChoices = buildPickChoices(seasonYear);
    const filteredPicks = pickChoices
      .filter(p => p.toLowerCase().includes((focusedRaw.value || '').toLowerCase()))
      .slice(0, 25)
      .map(p => ({ name: p, value: p }));
    return interaction.respond(filteredPicks);
  }
  if (!member) return interaction.respond([]);
  const teamOpt = interaction.options.getString('team');
  const teamId = teamOpt ? findTeamIdByName(snapshot, teamOpt) : findCoachTeamId(member, snapshot, roleMap);
  if (!teamId) return interaction.respond([]);
  const position = interaction.options.getString('position');
  const focused = (focusedRaw?.value || '').toLowerCase();

  const roster = (snapshot?.rosters?.teams?.[teamId] || {}).rosterInfoList || [];
  const filtered = roster
    .filter(p => !position || p.position === position)
    .map(p => `${p.firstName || ''} ${p.lastName || ''}`.trim())
    .filter(name => name && name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(name => ({ name, value: name }));
  await interaction.respond(filtered);
}

export default { data, execute, autocomplete };
