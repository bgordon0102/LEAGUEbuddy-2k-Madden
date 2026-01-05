import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { readRoster, saveRoster, upsertPlayer } from '../../utils/rosterUtils.js';
import { TEAM_FILES, TEAM_ALIASES } from '../../utils/config.js';
import { getSeasonState } from '../../utils/seasonUtils.js';

const DRAFT_RESULTS_DIR = path.join(process.cwd(), 'bot', 'draft classes', 'draft results');
const FALLBACK_RESULTS_PATH = path.join(process.cwd(), 'data', 'drafted_prospects.json');
const FREE_AGENCY_TEAM = 'free agency';
const FA_ALIASES = ['free agent', 'free agents', 'free agency', 'fa', 'und'];

function resolveDraftResultsPath(classNo) {
  const files = [];
  try {
    fs.readdirSync(DRAFT_RESULTS_DIR).forEach(f => {
      if (f.toLowerCase().endsWith('.json')) files.push(f);
    });
  } catch {
    return { path: FALLBACK_RESULTS_PATH, found: fs.existsSync(FALLBACK_RESULTS_PATH) };
  }
  const targetName = `2k26_cus0${classNo} - draft results.json`;
  const direct = files.find(f => f.toLowerCase() === targetName);
  if (direct) {
    return { path: path.join(DRAFT_RESULTS_DIR, direct), found: true };
  }
  // Try fuzzy match containing CUS0X and "draft results"
  const regex = new RegExp(`cus0${classNo}.*draft results`, 'i');
  const fuzzy = files.find(f => regex.test(f));
  if (fuzzy) {
    return { path: path.join(DRAFT_RESULTS_DIR, fuzzy), found: true };
  }
  // Fallback: latest file
  if (files.length === 0) return { path: FALLBACK_RESULTS_PATH, found: fs.existsSync(FALLBACK_RESULTS_PATH) };
  let latest = files[0];
  let latestMtime = fs.statSync(path.join(DRAFT_RESULTS_DIR, latest)).mtimeMs;
  for (const f of files.slice(1)) {
    const m = fs.statSync(path.join(DRAFT_RESULTS_DIR, f)).mtimeMs;
    if (m > latestMtime) {
      latest = f;
      latestMtime = m;
    }
  }
  const resolved = path.join(DRAFT_RESULTS_DIR, latest);
  return { path: resolved, found: true };
}

function loadProspects(classNo) {
  const { path: p, found } = resolveDraftResultsPath(classNo);
  if (!found) {
    throw new Error(`Draft results file not found. Expected: ${p}`);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  const players = [];

  const extract = (item) => {
    if (!item || typeof item !== 'object') return null;
    const team = item.team || item.Team || item.teamName || item.draftedBy || item.drafted_by || item['Draft Team'];
    const name = item.name || item.Name || item.player || item.Player;
    if (!team || !name) return null;
    return { ...item, team, name };
  };

  if (Array.isArray(data)) {
    for (const item of data) {
      const parsed = extract(item);
      if (parsed) players.push(parsed);
    }
  } else if (data && typeof data === 'object') {
    for (const [teamOrKey, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        value.forEach(player => {
          const parsed = extract({ ...player, team: player.team || teamOrKey });
          if (parsed) players.push(parsed);
        });
      } else if (value && typeof value === 'object') {
        const parsed = extract({ ...value, team: value.team || teamOrKey });
        if (parsed) players.push(parsed);
      }
    }
  }
  return { players, sourcePath: p };
}

function addToRoster(team, player) {
  const rosterData = readRoster(team);
  if (!rosterData) return false;
  const { rosterPath, roster } = rosterData;
  upsertPlayer(roster, player.name, {
    ...player,
    lastUpdatedBy: 'merge-draft',
    lastUpdatedAt: new Date().toISOString(),
  });
  saveRoster(rosterPath, roster);
  return true;
}

function derivePosition(player) {
  if (player.position) return player.position;
  const p1 = player.position_1 || player.position1;
  const p2 = player.position_2 || player.position2;
  const cleanP2 = p2 && !/^n\/a$/i.test(p2) ? p2 : null;
  if (p1 && cleanP2) return `${p1} / ${cleanP2}`;
  if (p1) return p1;
  if (cleanP2) return cleanP2;
  return '';
}

function resolveTeamName(teamRaw) {
  if (!teamRaw) return null;
  const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const key = teamRaw.toLowerCase().trim();

  // 1) Direct match against TEAM_FILES keys
  if (TEAM_FILES[key]) return key;

  // 2) Alias mapping
  if (TEAM_ALIASES[key]) {
    const file = TEAM_ALIASES[key];
    const found = Object.entries(TEAM_FILES).find(([, v]) => v === file);
    if (found) return found[0];
  }

  // 3) Normalized comparison (ignoring spaces/punctuation)
  const normalizedInput = normalize(teamRaw);
  for (const name of Object.keys(TEAM_FILES)) {
    const normalizedName = normalize(name);
    if (normalizedInput === normalizedName || normalizedInput.includes(normalizedName) || normalizedName.includes(normalizedInput)) {
      return name;
    }
  }

  // 4) Alias normalized comparison
  for (const [alias, file] of Object.entries(TEAM_ALIASES)) {
    const normalizedAlias = normalize(alias);
    if (normalizedInput === normalizedAlias || normalizedInput.includes(normalizedAlias) || normalizedAlias.includes(normalizedInput)) {
      const found = Object.entries(TEAM_FILES).find(([, v]) => v === file);
      if (found) return found[0];
    }
  }

  return null;
}

function mergePlayers(players) {
  const addedToTeams = [];
  const addedToFA = [];
  const unresolved = [];
  const isFAAlias = (val) => {
    if (!val) return false;
    const norm = val.toLowerCase().trim();
    if (FA_ALIASES.includes(norm)) return true;
    return FA_ALIASES.includes(norm.replace(/[^a-z0-9 ]/g, '').trim());
  };
  for (const p of players) {
    const teamRaw = p.team;
    if (!teamRaw) {
      unresolved.push(p);
      continue;
    }
    const isFA = isFAAlias(teamRaw);
    const teamName = resolveTeamName(teamRaw);
    const playerWithPosition = { ...p, position: derivePosition(p) };
    if (isFA) {
      const ok = addToRoster(FREE_AGENCY_TEAM, playerWithPosition);
      if (ok) addedToFA.push(playerWithPosition.name);
      continue;
    }
    if (!teamName) {
      unresolved.push(p);
      continue;
    }
    const ok = addToRoster(teamName, playerWithPosition);
    if (ok) {
      addedToTeams.push(`${playerWithPosition.name} -> ${teamName}`);
    } else {
      const faOk = addToRoster(FREE_AGENCY_TEAM, playerWithPosition);
      if (faOk) addedToFA.push(playerWithPosition.name);
      else unresolved.push(playerWithPosition);
    }
  }
  return { addedToTeams, addedToFA, unresolved };
}

function previewPlayers(players) {
  let teamCount = 0;
  let faCount = 0;
  const unresolvedList = [];
  const isFAAlias = (val) => {
    if (!val) return false;
    const norm = val.toLowerCase().trim();
    if (FA_ALIASES.includes(norm)) return true;
    return FA_ALIASES.includes(norm.replace(/[^a-z0-9 ]/g, '').trim());
  };
  for (const p of players) {
    const teamRaw = p.team;
    if (!teamRaw) { unresolvedList.push(p); continue; }
    const isFA = isFAAlias(teamRaw);
    const teamName = resolveTeamName(teamRaw);
    if (isFA) faCount++;
    else if (teamName) teamCount++;
    else unresolvedList.push(p);
  }
  return { teamCount, faCount, unresolvedCount: unresolvedList.length, unresolvedList };
}

export const data = new SlashCommandBuilder()
  .setName('mergedraft')
  .setDescription('Merge drafted prospects into team rosters; undrafted go to free agency')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const state = getSeasonState();
  const classNo = state.seasonNo || 1;
  try {
    const { players, sourcePath } = loadProspects(classNo);
    if (!players.length) {
      await interaction.editReply({ content: `No prospects parsed for class ${classNo}. Checked: ${sourcePath}. Ensure it has name/team fields.` });
      return;
    }

    const preview = previewPlayers(players);
  const summary = [
    `Source: ${path.basename(sourcePath)}`,
    `Will add to teams: ${preview.teamCount}`,
    `Will add to free agency: ${preview.faCount}`,
    `Unresolved teams: ${preview.unresolvedCount}`,
    preview.unresolvedList && preview.unresolvedList.length
      ? `Unresolved sample: ${preview.unresolvedList.slice(0, 10).map(p => `${p.name} [${p.team || 'no team'}]`).join(', ')}`
      : '',
    '',
    'Press Confirm to apply.'
  ].join('\n');
    await interaction.editReply({
      content: summary,
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Confirm', custom_id: `mergedraft_confirm_${classNo}` },
          { type: 2, style: 2, label: 'Cancel', custom_id: `mergedraft_cancel_${classNo}` }
        ]
      }]
    });
  } catch (err) {
    console.error('[mergedraft] Failed:', err);
    await interaction.editReply({ content: `Failed to prepare draft merge: ${err.message || err}` });
  }
}

export async function confirmMerge(interaction, classNo) {
  try {
    const { players, sourcePath } = loadProspects(classNo);
    if (!players.length) {
      await interaction.editReply({ content: `No prospects parsed for class ${classNo}. Checked: ${sourcePath}. Ensure it has name/team fields.`, components: [] });
      return;
    }
    const { addedToTeams, addedToFA, unresolved } = mergePlayers(players);
    const summary = [
      `Source: ${path.basename(sourcePath)}`,
      `Drafted to teams: ${addedToTeams.length}${addedToTeams.length ? ` (${addedToTeams.slice(0,10).join(', ')})` : ''}`,
      `Added to free agency: ${addedToFA.length}${addedToFA.length ? ` (${addedToFA.slice(0,10).join(', ')})` : ''}`,
      unresolved.length ? `Unresolved teams: ${unresolved.length} (${unresolved.slice(0,10).map(p => `${p.name} [${p.team || 'no team'}]`).join(', ')})` : ''
    ].filter(Boolean).join('\n');
    // Mark scouting closed after merge
    const seasonPath = path.join(process.cwd(), 'data', 'season.json');
    try {
      const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      seasonData.scoutingClosed = true;
      fs.writeFileSync(seasonPath, JSON.stringify(seasonData, null, 2));
    } catch (err) {
      console.error('[mergedraft] Failed to mark scouting closed:', err);
    }
    await interaction.editReply({ content: summary, components: [] });
  } catch (err) {
    console.error('[mergedraft confirm] Failed:', err);
    await interaction.editReply({ content: `Failed to merge draft results: ${err.message || err}`, components: [] });
  }
}

export default { data, execute };
