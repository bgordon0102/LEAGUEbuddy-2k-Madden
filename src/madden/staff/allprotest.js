import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot, currentWeek } from '../../../madden/madden_data.js';
import { computeWeeklyList, computeSeasonTop100FromHistory } from '../../../madden/top_players.js';
import { hasStaffRole, loadRoleMap } from './staffUtils.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

const POSITION_NEEDS = {
  // Offense
  QB: 1, HB: 1, FB: 1,
  LT: 1, LG: 1, C: 1, RG: 1, RT: 1,
  WR: 3, TE: 1,
  // Defense
  LEDG: 1, REDG: 1,
  DT: 2,
  SAM: 1, MIKE: 1, WILL: 1,
  CB: 3, FS: 1, SS: 1,
};

const POS_ALIAS = {
  EDGE: 'REDG',
  REDGE: 'REDG',
  LEDGE: 'LEDG',
  OT: 'RT',
  T: 'RT',
  OG: 'RG',
  G: 'RG',
  OL: 'RG', // generic OL slots collapse to guard so we can still place them
};

function normalizePos(pos) {
  // Normalize whitespace/punctuation and map aliases so OL variants still count
  const raw = (pos || '').toString().trim().toUpperCase();
  const compact = raw.replace(/[^A-Z]/g, '');
  return POS_ALIAS[compact] || compact;
}

function bestListByPos(players, needs, excludedIds = new Set()) {
  const grouped = {};
  players.forEach(p => {
    const pos = normalizePos(p.position);
    if (!needs[pos]) return;
    const grade = Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0);
    if (!grouped[pos]) grouped[pos] = [];
    grouped[pos].push({ ...p, grade, displayPos: pos });
  });
  Object.keys(grouped).forEach(k => grouped[k].sort((a, b) => b.grade - a.grade));
  const team = [];
  const takePlayer = (p, slotPos) => {
    const actualPos = (p.displayPos || p.position || '').toUpperCase();
    const displayPos = slotPos || actualPos || 'UNK';
    team.push({ ...p, displayPos, grade: p.grade });
    excludedIds.add(p.id || p.name);
  };
  for (const [pos, count] of Object.entries(needs)) {
    let bucket = grouped[pos] || [];
    let taken = 0;
    for (const p of bucket) {
      if (excludedIds.has(p.id || p.name)) continue;
      takePlayer(p, pos);
      taken += 1;
      if (taken >= count) break;
    }
    // Fallback for OL slots ONLY when no players exist for that slot at all
    if (taken < count && bucket.length === 0 && ['LT','LG','C','RG','RT'].includes(pos)) {
      const remaining = players
        .filter(p => !excludedIds.has(p.id || p.name))
        .filter(p => {
          const pp = normalizePos(p.position);
          return ['LT','LG','C','RG','RT'].includes(pp);
        })
        .sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
      for (const p of remaining) {
        takePlayer(p, pos);
        taken += 1;
        if (taken >= count) break;
      }
    }
    // Fallback for SAM: pick best remaining LB if empty
    if (taken < count && pos === 'SAM') {
      const remaining = players
        .filter(p => !excludedIds.has(p.id || p.name))
        .filter(p => {
          const pp = normalizePos(p.position);
          return ['SAM','MIKE','WILL','LB'].includes(pp);
        })
        .sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
      for (const p of remaining) {
        takePlayer(p, pos);
        taken += 1;
        if (taken >= count) break;
      }
    }
  }
  return team;
}

function ensureCenter(team, players, excludedIds) {
  // Ensure all five OL spots are filled with the best available unused linemen
  const slots = ['LT', 'LG', 'C', 'RG', 'RT'];
  const hasSlot = new Set(team.filter(p => slots.includes(p.displayPos)).map(p => p.displayPos));
  const missing = slots.filter(s => !hasSlot.has(s));
  if (!missing.length) return team;

  const sorted = [...players].sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
  const tempUsed = new Set();

  const canFill = (slot, pos) => {
    if (slot === 'C') return ['C', 'LG', 'RG'].includes(pos); // never drop tackles at center
    if (slot === 'LT') return ['LT', 'OT', 'T', 'OL'].includes(pos);
    if (slot === 'RT') return ['RT', 'OT', 'T', 'OL'].includes(pos);
    if (slot === 'LG') return ['LG', 'OG', 'G', 'OL'].includes(pos);
    if (slot === 'RG') return ['RG', 'OG', 'G', 'OL'].includes(pos);
    return false;
  };

  const pickForSlot = (slot, allowUsed = false) => sorted.find(p => {
    const id = p.id || p.name;
    if (!allowUsed && excludedIds.has(id)) return false;
    if (tempUsed.has(id)) return false;
    const pos = normalizePos(p.position);
    return canFill(slot, pos);
  });

  const additions = [];
  missing.forEach(slot => {
    let cand = pickForSlot(slot, false);
    // If no unused lineman is left, allow reuse as a last resort so the embed isn't missing a slot
    if (!cand) cand = pickForSlot(slot, true);
    if (cand) {
      const id = cand.id || cand.name;
      tempUsed.add(id);
      excludedIds.add(id);
      additions.push({ ...cand, displayPos: slot, grade: Number(cand.seasonGrade ?? cand.grade ?? 0) });
    }
  });

  if (!additions.length) return team;
  return [...team, ...additions];
}

function formatTeamName(team) {
  return team || 'UNK';
}

function loadTeamEmojis() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'team_emojis.json'), 'utf8'));
  } catch {
    return {};
  }
}

function emojiForTeam(teamName, teamEmojis) {
  if (!teamName) return '';
  const name = teamName.trim().split(/\s+/).pop();
  const id = teamEmojis[name];
  if (!id) return '';
  const safe = name.replace(/[^A-Za-z0-9]/g, '');
  return `<:${safe}:${id}>`;
}

function getCoachMention(teamName, roleMap = {}) {
  if (!teamName) return '';
  const norm = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entry = Object.entries(roleMap || {}).find(([name]) => {
    if (!/coach$/i.test(name)) return false;
    const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n.includes(norm) || norm.includes(n);
  });
  return entry ? `<@&${entry[1]}>` : '';
}

function buildAllProEmbeds(firstTeam, secondTeam, leagueName, scopeLabel, roleMap) {
  const teamEmojis = loadTeamEmojis();
  const fmtLine = (p) => {
    const em = emojiForTeam(p.team, teamEmojis);
    const coach = getCoachMention(p.team, roleMap);
    return `${em ? em + ' ' : ''}${p.displayPos} — ${p.name} (${formatTeamName(p.team)}) • ${p.grade.toFixed(2)} ${coach}`;
  };
  const orderOff = ['QB','HB','FB','LT','LG','C','RG','RT','WR','WR','WR','TE'];
  const sortOff = (arr) => {
    const orderIdx = (pos) => {
      const i = orderOff.indexOf(pos);
      return i === -1 ? 99 : i;
    };
    return [...arr].sort((a, b) => {
      const oa = orderIdx(a.displayPos);
      const ob = orderIdx(b.displayPos);
      if (oa !== ob) return oa - ob;
      return Number(b.grade || 0) - Number(a.grade || 0);
    });
  };
  const firstOff = sortOff(firstTeam.filter(p => ['QB','HB','FB','LT','LG','C','RG','RT','WR','TE'].includes(p.displayPos)));
  const firstDef = firstTeam.filter(p => !firstOff.includes(p));
  const secondOff = sortOff(secondTeam.filter(p => ['QB','HB','FB','LT','LG','C','RG','RT','WR','TE'].includes(p.displayPos)));
  const secondDef = secondTeam.filter(p => !secondOff.includes(p));

  const embed1 = new EmbedBuilder()
    .setTitle(`All-Pro First Team — ${scopeLabel}`)
    .addFields(
      { name: 'Offense', value: firstOff.map(fmtLine).join('\n') || '—' },
      { name: 'Defense', value: firstDef.map(fmtLine).join('\n') || '—' }
    )
    .setFooter({ text: leagueName });

  const embed2 = new EmbedBuilder()
    .setTitle(`All-Pro Second Team — ${scopeLabel}`)
    .addFields(
      { name: 'Offense', value: secondOff.map(fmtLine).join('\n') || '—' },
      { name: 'Defense', value: secondDef.map(fmtLine).join('\n') || '—' }
    )
    .setFooter({ text: leagueName });

  return [embed1, embed2];
}

function loadSeasonList(leagueId) {
  try {
    return computeSeasonTop100FromHistory(leagueId) || [];
  } catch {
    return [];
  }
}

function loadWeeklyList(snapshot, weekIndex) {
  try {
    const weekly = computeWeeklyList(snapshot, weekIndex);
    return Array.isArray(weekly) ? weekly : (weekly?.top100 || []);
  } catch {
    return [];
  }
}

// If the season Top-100 lacks enough true centers, pull the best centers from weekly history (e.g., Creed Humphrey)
// so both All-Pro teams have real centers.
function injectCentersIfNeeded(players, minCenters = 2, leagueId = null) {
  const norm = (p) => POS_ALIAS[(p || '').toString().trim().toUpperCase().replace(/[^A-Z]/g, '')] ||
    (p || '').toString().trim().toUpperCase().replace(/[^A-Z]/g, '');
  const centers = players.filter(p => norm(p.position) === 'C');
  if (centers.length >= minCenters) return players;

  const harvested = [];
  if (leagueId) {
    try {
      const histDir = path.join(process.cwd(), 'data', 'madden', 'top_players_history', `${leagueId}.json`);
      const files = fs.readdirSync(histDir).filter(f => f.endsWith('.json'));
      const pool = [];
      files.forEach(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(histDir, f), 'utf8'));
          const arr = data.players || data.top100 || [];
          arr.forEach(p => {
            if (norm(p.position) === 'C') {
              pool.push({
                ...p,
                seasonGrade: Number(p.seasonGrade ?? p.grade ?? p.score ?? 0),
                id: p.id || `${p.name}-${f}`,
                name: p.name
              });
            }
          });
        } catch { /* ignore bad weekly file */ }
      });
      const grouped = new Map();
      pool.forEach(p => {
        const key = p.name || p.id;
        const entry = grouped.get(key) || { ...p, best: 0 };
        entry.best = Math.max(entry.best, Number(p.seasonGrade || 0));
        grouped.set(key, entry);
      });
      const bestHist = [...grouped.values()].sort((a, b) => b.best - a.best);
      harvested.push(...bestHist);
    } catch { /* missing history dir */ }
  }

  const sortedAdds = harvested
    .filter(Boolean)
    .sort((a, b) => Number(b.seasonGrade ?? b.grade ?? 0) - Number(a.seasonGrade ?? a.grade ?? 0));
  const needed = Math.max(0, minCenters - centers.length);
  const toAdd = sortedAdds.slice(0, needed);
  toAdd.forEach((c, idx) => {
    const id = c.id || c.name || `center-${idx}`;
    const exists = players.some(p => (p.id || p.name) === id);
    const safeId = exists ? `${id}-inj${idx}` : id;
    players.push({ ...c, id: safeId });
  });

  return players;
}

export const data = new SlashCommandBuilder()
  .setName('madden-allprotest')
  .setDescription('Post All-Pro First/Second teams (staff-only).')
  .setDefaultMemberPermissions(null)
  .addStringOption(opt =>
    opt.setName('scope')
      .setDescription('Use season or a specific week list')
      .addChoices(
        { name: 'Season (end of year)', value: 'season' },
        { name: 'Week', value: 'week' }
      )
  )
  .addIntegerOption(opt =>
    opt.setName('week')
      .setDescription('Week number (for weekly scope)')
      .setMinValue(1)
  )
  .addBooleanOption(opt =>
    opt.setName('public')
      .setDescription('Post publicly and tag Ghost Legacy')
  );

export async function execute(interaction, options = {}) {
  const isButton = interaction.isButton && interaction.isButton();
  let isPublic = interaction.options?.getBoolean?.('public') ?? options.public ?? false;
  const roleMap = loadRoleMap();
  const ghostRoleId = roleMap['Ghost Legacy'] || '1460399406397522145';

  // Defer replies
  if (!isButton) {
    try {
      await interaction.deferReply(isPublic ? {} : { flags: 64 });
    } catch (err) {
      if (err?.code === 10062) return;
      console.error('[allprotest] defer failed:', err);
      try { await interaction.reply({ content: 'Discord temporarily unavailable.', flags: 64 }); } catch {}
      return;
    }
  }

  // Auth
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!hasStaffRole(member, roleMap)) {
      const msg = 'Only Ghost Legacy Commish/Co-Commish can use this command.';
      if (isButton) return interaction.update({ content: msg, components: [], embeds: [] });
      return interaction.editReply({ content: msg });
    }
  } catch (err) {
    console.error('[allprotest] role check error:', err);
    if (!isButton) await interaction.editReply({ content: 'Error checking permissions.' });
    return;
  }

  // Parse button state (for future extension; not using pagination now)
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    if (isButton) return interaction.update({ content: 'No league configured.', components: [], embeds: [] });
    return interaction.editReply({ content: 'No league configured. Run /madden-set-league first.' });
  }

  // Load list
  const snapshot = loadLeagueSnapshot(leagueId);
  const scope = 'season'; // force final season scope
  const weekIdx = null;

  let list = [];
  if (scope === 'season') {
    list = loadSeasonList(leagueId);
  } else {
    list = loadWeeklyList(snapshot, weekIdx);
  }
  list = injectCentersIfNeeded(list, 2, leagueId);
  if (!list.length) {
    const msg = 'No player data found for that scope.';
    if (isButton) return interaction.update({ content: msg, components: [], embeds: [] });
    return interaction.editReply({ content: msg });
  }

  // Select first and second teams
  const sorted = list
    .map(p => ({ ...p, grade: Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0) }))
    .sort((a, b) => b.grade - a.grade);
  const used = new Set();
  let firstTeam = bestListByPos(sorted, POSITION_NEEDS, used);
  firstTeam = ensureCenter(firstTeam, sorted, used);
  let secondTeam = bestListByPos(sorted, POSITION_NEEDS, used);
  secondTeam = ensureCenter(secondTeam, sorted, used);

  const scopeLabel = scope === 'season' ? 'Season' : `Week ${weekIdx + 1}`;
  const leagueName = leagueId === '16594549' ? 'Ghost Legacy' : leagueId;
  const [embed1, embed2] = buildAllProEmbeds(firstTeam, secondTeam, leagueName, scopeLabel, roleMap);
  const content = isPublic ? `<@&${ghostRoleId}>` : undefined;

  if (isButton) {
    await interaction.update({ content, embeds: [embed1, embed2], components: [] });
  } else {
    await interaction.editReply({ content, embeds: [embed1, embed2] });
  }
}

export default { data, execute };
