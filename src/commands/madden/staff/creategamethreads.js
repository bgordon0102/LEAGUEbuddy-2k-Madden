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

function buildThreadName(game, teams, week) {
  const away = teams[game.awayTeamId] || 'Away';
  const home = teams[game.homeTeamId] || 'Home';
  return `${away} vs ${home} - W${week}`;
}

function teamMentions(game, teams, roleMap) {
  const names = [
    teams[game.awayTeamId],
    teams[game.homeTeamId],
  ].filter(Boolean);
  const ids = names.map(n => roleMap[`${n} Coach`]).filter(Boolean);
  return ids.map(id => `<@&${id}>`).join(' ');
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
  const targetStage = 1; // regular season only
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const wk = (weekInput ?? snapshot.currentWeek ?? 1) || 1;
    const targetWeekIdx = Number(wk) - 1;
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
      return stage === targetStage && weekVal === Number(wk);
    });
    if (!gamesFinal.length) {
      await interaction.editReply({ content: `No games found for week ${wk} in the snapshot.` });
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
    let created = 0;
    const deadline = Math.floor((Date.now() + 48 * 3600 * 1000) / 1000);
    for (const game of gamesFinal) {
      const name = buildThreadName(game, teams, wk);
      try {
        const thread = await channel.threads.create({
          name,
          autoArchiveDuration: 10080, // 7 days
          reason: `Game thread for week ${wk}`,
        });
        const mentionText = teamMentions(game, teams, roleMap);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`madden_game_complete_${thread.id}`)
            .setLabel('Mark Game Complete')
            .setStyle(ButtonStyle.Success)
        );
        const embed = {
          title: 'Matchup Thread',
          description: `Welcome${mentionText ? ` ${mentionText}` : ''}!\nUse this thread to coordinate your matchup and mark it complete when done.\n\nDeadline: <t:${deadline}:R> (<t:${deadline}:f>)`,
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
            title: `Week ${wk} Threads Created`,
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
    await interaction.editReply({ content: `Created ${created}/${games.length} game threads for week ${wk}.` });
  } catch (err) {
    await interaction.editReply({ content: `Failed to create game threads: ${err.message || err}` });
  }
}

export const data = new SlashCommandBuilder()
  .setName('madden-creategamethreads')
  .setDescription('Create regular-season game threads for a given week (staff-only).')
  .addIntegerOption(o => o.setName('week').setDescription('Week number (defaults to current)').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export default { data, execute };
