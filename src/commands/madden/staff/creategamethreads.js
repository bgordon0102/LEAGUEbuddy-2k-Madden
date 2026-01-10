import { SlashCommandBuilder, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const STAFF_ROLES = ['Madden Commish', 'Madden Co-Commish'];

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function normalizeName(name) {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === 'g-men' || lower === 'gmen') return 'Giants';
  if (lower === 'pack' || lower === 'packers') return 'Packers';
  if (lower === 'jags') return 'Jaguars';
  if (lower === 'vikes' || lower === 'vikings') return 'Vikings';
  if (lower === 'fins' || lower === 'fins up' || lower === 'phins' || lower === 'dolphins') return 'Dolphins';
  if (lower === 'bucs' || lower === 'buccs' || lower === 'buccaneers') return 'Buccaneers';
  if (lower === 'pats' || lower === 'patriots') return 'Patriots';
  if (lower === 'bolts' || lower === 'chargers') return 'Chargers';
  return name;
}

function hasStaffRole(member, roleMap) {
  return STAFF_ROLES.some(r => {
    const id = roleMap[r];
    return id && member.roles.cache.has(id);
  });
}

function teamMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const nick = normalizeName(t.nickName || t.displayName);
    const city = t.cityName;
    map[t.teamId] = nick || city || `Team ${t.teamId}`;
  });
  return map;
}

function buildThreadName(game, teams, weekLabel) {
  const away = teams[game.awayTeamId] || 'Away';
  const home = teams[game.homeTeamId] || 'Home';
  return `${away} vs ${home} - ${weekLabel}`;
}

function teamMentions(game, teams, roleMap) {
  const names = [
    teams[game.awayTeamId],
    teams[game.homeTeamId],
  ].filter(Boolean);
  const ids = names.map(n => roleMap[`${n} Coach`]).filter(Boolean);
  return ids.map(id => `<@&${id}>`).join(' ');
}

function pickField(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return Number(obj[k]);
  }
  return null;
}

function pointsFromSchedule(snapshot) {
  const out = {};
  const games = (snapshot?.schedule?.schedules || []).filter(g => Number(g.stageIndex ?? g.stage ?? 1) === 1);
  games.forEach(g => {
    const away = g.awayTeamId, home = g.homeTeamId;
    const ascore = Number(g.awayScore ?? 0);
    const hscore = Number(g.homeScore ?? 0);
    if (!out[away]) out[away] = { for: 0, against: 0, games: 0 };
    if (!out[home]) out[home] = { for: 0, against: 0, games: 0 };
    out[away].for += ascore; out[away].against += hscore; out[away].games += 1;
    out[home].for += hscore; out[home].against += ascore; out[home].games += 1;
  });
  return out;
}

function buildRankMaps(snapshot) {
  const standings = snapshot?.standings?.teamStandingInfoList || [];
  const gp = (s) => pickField(s, ['gamesPlayed']) ?? ((s.totalWins || 0) + (s.totalLosses || 0) + (s.totalTies || 0));
  const byTeam = Object.fromEntries(standings.map(s => [s.teamId, s]));
  const schedulePts = pointsFromSchedule(snapshot);

  const metrics = {
    offPtsPerG: {
      getter: s => {
        const pts = pickField(s, ['pointsFor', 'totalPointsFor', 'offPts', 'ptsFor']);
        const games = gp(s) || 0;
        return pts != null ? (games ? pts / games : pts) : null;
      },
      rankKey: 'ptsForRank',
      desc: true,
    },
    offPassYds: { getter: s => pickField(s, ['offPassYds', 'offPassYards', 'passYdsFor']), rankKey: 'offPassYdsRank', desc: true },
    offRushYds: { getter: s => pickField(s, ['offRushYds', 'offRushYards', 'rushYdsFor']), rankKey: 'offRushYdsRank', desc: true },
    defPtsPerG: {
      getter: s => {
        const pts = pickField(s, ['pointsAgainst', 'ptsAllowed', 'defPtsAllowed', 'ptsAgainst']);
        const games = gp(s) || 0;
        return pts != null ? (games ? pts / games : pts) : null;
      },
      rankKey: 'ptsAgainstRank',
      desc: false,
    },
    defPassYds: { getter: s => pickField(s, ['defPassYds', 'defPassYdsAllowed', 'defPassYardsAllowed', 'passYdsAllowed', 'oppPassYds']), rankKey: 'defPassYdsRank', desc: false },
    defRushYds: { getter: s => pickField(s, ['defRushYds', 'defRushYdsAllowed', 'defRushYardsAllowed', 'rushYdsAllowed', 'oppRushYds']), rankKey: 'defRushYdsRank', desc: false },
  };

  const values = {};
  const ranks = {};

  for (const [key, cfg] of Object.entries(metrics)) {
    const list = standings.map(s => {
      const val = cfg.getter(s);
      const rank = cfg.rankKey ? s[cfg.rankKey] : null;
      return { teamId: s.teamId, val, rank };
    }).filter(x => x.val !== null && x.val !== undefined || x.rank !== null && x.rank !== undefined);
    list.sort((a, b) => {
      const av = a.val ?? 0;
      const bv = b.val ?? 0;
      return cfg.desc ? (bv - av) : (av - bv);
    });
    list.forEach((x, idx) => {
      if (!ranks[key]) ranks[key] = {};
      ranks[key][x.teamId] = x.rank || (idx + 1);
      if (!values[x.teamId]) values[x.teamId] = {};
      values[x.teamId][key] = x.val;
    });
  }

  // Fill missing points per game from schedule aggregates if possible
  Object.keys(byTeam).forEach(tid => {
    const v = values[tid] = values[tid] || {};
    const sched = schedulePts[tid];
    const games = gp(byTeam[tid]) || sched?.games || 0;
    if ((v.offPtsPerG === undefined || v.offPtsPerG === null) && sched && games) {
      v.offPtsPerG = sched.for / games;
    }
    if ((v.defPtsPerG === undefined || v.defPtsPerG === null) && sched && games) {
      v.defPtsPerG = sched.against / games;
    }
  });

  return { ranks, values, standings: byTeam };
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleMap = loadJson(ROLE_MAP_FILE);
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.editReply({ content: 'Only Madden Commish/Co-Commish can use this command.' });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.editReply({ content: 'No league set. Run /madden-set-league first.' });
    return;
  }

  const weekInput = interaction.options.getInteger('week');
  const playoffRound = interaction.options.getString('playoff_round');
  const playoffMap = {
    wildcard: 19, // Madden exports are usually 1-based; WC often week 19
    divisional: 20,
    conference: 21,
    superbowl: 23,
  };
  const targetStage = 1; // regular season only
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const wkNumeric = playoffRound ? playoffMap[playoffRound] : (weekInput ?? snapshot.currentWeek ?? 1) || 1;
    const weekLabel = playoffRound ? `PO-${playoffRound}` : `W${wkNumeric}`;
    const targetWeekIdx = Number(wkNumeric) - 1;
    const games = (snapshot?.schedule?.schedules || []).filter(g => {
      const stage = Number(g.stageIndex ?? g.stage ?? 1);
      const rawWeek = Number(g.seasonWeek ?? g.seasonWeekIndex ?? g.weekIndex ?? g.week ?? -1);
      const weekVal = Number.isNaN(rawWeek) ? -1 : rawWeek;
      return stage === targetStage && weekVal === targetWeekIdx;
    });
    // Fallback: if none matched, try 1-based week
    const gamesFinal = games.length ? games : (snapshot?.schedule?.schedules || []).filter(g => {
      const stage = Number(g.stageIndex ?? g.stage ?? 1);
      const rawWeek = Number(g.seasonWeek ?? g.seasonWeekIndex ?? g.weekIndex ?? g.week ?? -1);
      const weekVal = Number.isNaN(rawWeek) ? -1 : rawWeek;
      return stage === targetStage && weekVal === Number(wkNumeric);
    });
    if (!gamesFinal.length) {
      await interaction.editReply({ content: `No games found for ${playoffRound ? playoffRound : `week ${wkNumeric}`} in the snapshot.` });
      return;
    }
    const threadsChannelId = channelMap['Game threads'];
    if (!threadsChannelId) {
      await interaction.editReply({ content: 'Game threads channel ID not set.' });
      return;
    }
    const channel = await interaction.client.channels.fetch(threadsChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.editReply({ content: 'Game threads channel not found or not text-based.' });
      return;
    }
    const teams = teamMap(snapshot);
    const ranks = buildRankMaps(snapshot);
    let created = 0;
    const deadline = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000);
    for (const game of gamesFinal) {
      const name = buildThreadName(game, teams, weekLabel);
      try {
        const thread = await channel.threads.create({
          name,
          autoArchiveDuration: 10080, // 7 days
          reason: `Game thread for ${weekLabel}`,
        });
        const mentionText = teamMentions(game, teams, roleMap);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`madden_game_complete_${thread.id}`)
            .setLabel('Mark Game Complete')
            .setStyle(ButtonStyle.Success)
        );
        const statLine = (tid) => {
          const v = ranks.values[tid] || {};
          const r = ranks.ranks;
          const s = ranks.standings[tid] || {};
          const fmt = (val, decimals = 1) => val != null ? (Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals)).toString() : '–';
          const offPts = v.offPtsPerG ?? s.ptsFor ?? s.pointsFor ?? s.offPts;
          const defPts = v.defPtsPerG ?? s.ptsAgainst ?? s.pointsAgainst ?? s.defPtsAllowed;
          const passO = v.offPassYds ?? s.offPassYds;
          const rushO = v.offRushYds ?? s.offRushYds;
          const passD = v.defPassYds ?? s.defPassYds;
          const rushD = v.defRushYds ?? s.defRushYds;
          return [
            `Off Pts/G ${fmt(offPts)} (R${r?.offPtsPerG?.[tid] || s.ptsForRank || '–'})`,
            `Pass Yds ${fmt(passO,0)} (R${r?.offPassYds?.[tid] || s.offPassYdsRank || '–'})`,
            `Rush Yds ${fmt(rushO,0)} (R${r?.offRushYds?.[tid] || s.offRushYdsRank || '–'})`,
            `Opp Pts/G ${fmt(defPts)} (R${r?.defPtsPerG?.[tid] || s.ptsAgainstRank || '–'})`,
            `Opp Pass ${fmt(passD,0)} (R${r?.defPassYds?.[tid] || s.defPassYdsRank || '–'})`,
            `Opp Rush ${fmt(rushD,0)} (R${r?.defRushYds?.[tid] || s.defRushYdsRank || '–'})`,
          ].join('\n');
        };
        const embed = {
          title: 'Matchup Thread',
          description: `Welcome${mentionText ? ` ${mentionText}` : ''}!\nUse this thread to coordinate your matchup and mark it complete when done.\n\n${teams[game.awayTeamId] || 'Away'} stats:\n${statLine(game.awayTeamId)}\n\n${teams[game.homeTeamId] || 'Home'} stats:\n${statLine(game.homeTeamId)}\n\nDeadline: <t:${deadline}:R> (<t:${deadline}:f>)`,
          color: 0x00b0f4,
          timestamp: new Date().toISOString(),
        };
        await thread.send({ embeds: [embed], components: [row] });
        created += 1;
      } catch (e) {
        console.warn('[madden-creategamethreads] Failed to create thread', name, e?.message || e);
      }
    }
    try {
      const announceChannelId = channelMap['Madden League Buddy Announcements'];
      const coachRoleId = roleMap['Madden Coach'];
      const coachTag = coachRoleId ? `<@&${coachRoleId}>` : '';
      if (announceChannelId) {
        const announce = await interaction.client.channels.fetch(announceChannelId).catch(() => null);
        if (announce && announce.isTextBased()) {
          const embed = {
            title: playoffRound ? `${playoffRound} Threads Created` : `Week ${wkNumeric} Threads Created`,
            description: `Deadline to play: <t:${deadline}:F> (<t:${deadline}:R>).`,
            color: 0x00b0f4,
            timestamp: new Date().toISOString(),
          };
          await announce.send({ content: coachTag || null, embeds: [embed] });
        }
      }
    } catch (e) {
      console.warn('[madden-creategamethreads] Failed to post announcement:', e?.message || e);
    }
    await interaction.editReply({ content: `Created ${created}/${games.length} game threads for ${playoffRound ? playoffRound : `week ${wkNumeric}`}.` });
  } catch (err) {
    await interaction.editReply({ content: `Failed to create game threads: ${err.message || err}` });
  }
}

export const data = new SlashCommandBuilder()
  .setName('madden-creategamethreads')
  .setDescription('Create game threads for a given week (regular season or playoffs) (staff-only).')
  .addIntegerOption(o => o.setName('week').setDescription('Regular-season week number (defaults to current)').setRequired(false))
  .addStringOption(o =>
    o.setName('playoff_round')
      .setDescription('Playoff round')
      .setRequired(false)
      .addChoices(
        { name: 'Wild Card', value: 'wildcard' },
        { name: 'Divisional', value: 'divisional' },
        { name: 'Conference', value: 'conference' },
        { name: 'Super Bowl', value: 'superbowl' },
      )
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export default { data, execute };
