import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { saveTradeDraft, deleteDraftsForUser } from '../utils/trade_draft_store.js';
import { normalizeName } from '../shared/rosterUtils.js';
import { resolveTeamNameForRoster } from '../shared/rosterUtils.js';

export const customId = /^trade_builder_start(?:_2k)?$/;

async function safeReply(interaction, payload) {
  try {
    return await interaction.reply(payload);
  } catch (err) {
    // Only send ephemeral reply, do not send public channel message
    throw err;
  }
}

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  if (!customId.test(interaction.customId)) return;
  const forceMode2k = interaction.customId.endsWith('_2k');
  const leagueId = forceMode2k ? null : resolveLeagueIdWithConfig(interaction.guildId);

  // ---------- NBA (2K) fallback ----------
  const east = [
    'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
    'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks',
    'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
  ];
  const west = [
    'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers',
    'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder',
    'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
  ];
  const nbaTeams = [...east, ...west];

  // Robust coach team detection for 2K
  const coachMapPath = path.join(process.cwd(), 'data/coachRoleMap.json');
  let coachMap = {};
  try { coachMap = JSON.parse(fs.readFileSync(coachMapPath, 'utf8')); } catch { }
  const userRoles = interaction.member?.roles?.cache || new Map();
  const userRoleIds = Array.from(userRoles.keys());
  const USER_TEAM_OVERRIDES = {
    // Timberwolves coach user
    '840269359578611753': 'Minnesota Timberwolves',
  };

  // Helper to normalize role/team strings
  const normSlug = (str = '') => str.toLowerCase().replace(/coach/g, '').replace(/[^a-z0-9]/g, '');
  const rosterFiles = (() => {
    try {
      const dir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .filter(f => !/free[_ ]?agency/i.test(f))
        .map(f => f.replace('.json', ''));
    } catch { return []; }
  })();

  const roleToTeam = Object.entries(coachMap).reduce((acc, [team, roleId]) => { acc[roleId] = team; return acc; }, {});

  // Collect all possible matches; if more than one, leave null to force manual pick
  const matches = new Set();

  // Priority 0: explicit user override
  const overrideTeam = USER_TEAM_OVERRIDES[interaction.user.id];
  if (overrideTeam) matches.add(overrideTeam);

  // Priority 1: exact roleId mapping
  userRoleIds.forEach(id => { if (roleToTeam[id]) matches.add(roleToTeam[id]); });

  // Hard overrides for known role ids
  if (userRoleIds.includes('1460736451473051739')) {
    matches.clear();
    matches.add('Minnesota Timberwolves');
  } else if (userRoleIds.includes('1460734654901653525')) {
    matches.clear();
    matches.add('Milwaukee Bucks');
  } else if (interaction.user.id === '1076243288056664234') {
    matches.clear();
    matches.add('Cleveland Cavaliers');
  }

  // Priority 2: role name matches roster slug
  for (const [, role] of userRoles) {
    const slug = normSlug(role.name);
    const hit = rosterFiles.find(t => normSlug(t.replace(/_/g, ' ')) === slug);
    if (hit) matches.add(hit.replace(/_/g, ' '));
  }

  let detectedTeam = null;
  if (matches.size === 1) {
    const only = Array.from(matches)[0];
    detectedTeam = /timberwolves/i.test(only) ? 'Minnesota Timberwolves'
      : /bucks/i.test(only) ? 'Milwaukee Bucks'
      : resolveTeamNameForRoster(only);
  }
  console.log('[trade_builder_start][detect]', {
    userId: interaction.user.id,
    userRoles: userRoleIds,
    roleMatches: Array.from(matches),
    detectedTeam,
    overrideTeam: USER_TEAM_OVERRIDES[interaction.user.id] || null,
  });

  // Try Madden first; if not configured or empty snapshot, switch to NBA mode
  let snapshot = null;
  let mode = forceMode2k ? '2k' : 'madden';
  if (!forceMode2k && leagueId) {
    try { snapshot = loadLeagueSnapshot(leagueId); } catch { snapshot = null; }
    const teams = snapshot?.teams?.leagueTeamInfoList || [];
    if (!teams.length) mode = '2k';
  } else {
    mode = '2k';
  }

  const limitOptions = (opts, keepValue) => {
    if (opts.length <= 25) return opts;
    const keep = opts.find(o => o.value === String(keepValue));
    const others = opts.filter(o => o.value !== String(keepValue));
    const trimmed = others.slice(0, 24);
    return keep ? [keep, ...trimmed] : opts.slice(0, 25);
  };

  const draftId = `builder_${interaction.user.id}_${Date.now()}`;
  // Clear stale drafts for this user to avoid reusing old team selections
  deleteDraftsForUser(interaction.user.id);
  // Pull current NBA season year (season.json) for pick parsing
  let seasonYear = null;
  try {
    const seasonPath = path.join(process.cwd(), 'data', 'season.json');
    if (fs.existsSync(seasonPath)) {
      const s = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      if (s.seasonYear) {
        seasonYear = Number(s.seasonYear);
      } else if (s.seasonNo) {
        // Our NBA seasons are labeled so seasonNo:1 corresponds to the 2025-26 season,
        // meaning draft picks are in the calendar year 2026.
        const baseStartYear = 2025;
        seasonYear = baseStartYear + Number(s.seasonNo); // season 1 -> 2026, season 2 -> 2027, etc.
      }
    }
  } catch { /* ignore */ }
  if (!seasonYear) {
    seasonYear = new Date().getFullYear();
  }

  if (mode === 'madden') {
    saveTradeDraft(draftId, {
      draftId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      leagueId,
      mode: 'madden',
      yourTeamId: null,
      otherTeamId: null,
      assets: { your: [], other: [] },
    });
  } else {
    const initialTeam = detectedTeam || USER_TEAM_OVERRIDES[interaction.user.id] || null;
    saveTradeDraft(draftId, {
      draftId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      mode: '2k',
      yourTeamName: initialTeam,
      yourTeamId: initialTeam,
      otherTeamName: null,
      seasonYear,
      assets: { your: [], other: [] },
    });
  }

  let rows;
  if (mode === 'madden') {
    const optionsAll = teams.map(t => ({
      label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
      value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
    }));
    const optionsAFC = teams
      .filter(t => (t.divName || '').toUpperCase().includes('AFC'))
      .map(t => ({
        label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
        value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
      }));
    const optionsNFC = teams
      .filter(t => (t.divName || '').toUpperCase().includes('NFC'))
      .map(t => ({
        label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
        value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
      }));
    rows = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_yours|${draftId}`)
          .setPlaceholder('Your team')
          .addOptions(limitOptions(optionsAll))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_afc|${draftId}`)
          .setPlaceholder('Select other team (AFC)')
          .addOptions(limitOptions(optionsAFC))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
          .setPlaceholder('Select other team (NFC)')
          .addOptions(limitOptions(optionsNFC))
      ),
    ];
  } else {
    const toOption = name => ({ label: name, value: name });
    const optionsEast = east.map(toOption);
    const optionsWest = west.map(toOption);
    // Put detected team (if any) at top of a combined list for convenience
    const allOptions = nbaTeams.map(toOption);
    const uniq = (arr) => Array.from(new Map(arr.map(o => [o.value, o])).values());
    const yourTeamOptions = detectedTeam
      ? uniq([toOption(detectedTeam), ...allOptions]).slice(0, 25)
      : allOptions.slice(0, 25);
    const lockYourTeam = !!(detectedTeam || USER_TEAM_OVERRIDES[interaction.user.id]);
    rows = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_yours|${draftId}`)
          .setPlaceholder(detectedTeam ? `Your team (auto): ${detectedTeam}` : 'Select your team')
          .setDisabled(lockYourTeam)
          .addOptions(yourTeamOptions)
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_afc|${draftId}`)
          .setPlaceholder('Select other team (East)')
          .addOptions(optionsEast.slice(0, 25))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
          .setPlaceholder('Select other team (West)')
          .addOptions(optionsWest.slice(0, 25))
      ),
    ];
  }

  await safeReply(interaction, {
    content: 'Select teams to start building the trade.',
    components: rows,
    ephemeral: true,
  });
}

export default { customId, execute };
