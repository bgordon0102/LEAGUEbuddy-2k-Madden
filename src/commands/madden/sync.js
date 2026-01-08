import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { createEAClientFromEnv, Stage } from '../../madden/ea_client.js';
import { getMessageForWeek } from '../../madden/madden_utils.js';
import { YEAR } from '../../madden/ea_constants.js';
import { resolveLeagueIdWithConfig } from '../../madden/madden_data.js';
import { loadTokens as loadTokensDb } from '../../madden/madden_db.js';

const leagueDir = path.join(process.cwd(), 'data', 'madden', 'leagues');
const tokenFile = path.join(process.cwd(), 'data', 'madden', 'tokens.json');
const snapshotsDir = leagueDir;

const data = new SlashCommandBuilder()
  .setName('madden-sync')
  .setDescription('Pull Madden data directly from EA and save locally.')
  .addStringOption(option =>
    option.setName('league_id')
      .setDescription('Madden league ID (optional; defaults to saved/latest)')
      .setRequired(false)
  );

async function ensureDir() {
  await fs.mkdir(leagueDir, { recursive: true });
}

async function loadTokens() {
  const dbTokens = loadTokensDb();
  if (dbTokens && dbTokens.accessToken && dbTokens.refreshToken) return dbTokens;
  try {
    const txt = await fs.readFile(tokenFile, 'utf-8');
    const parsed = JSON.parse(txt);
    if (parsed?.gameYear && `${parsed.gameYear}` !== `${YEAR}`) {
      console.warn(`[madden-sync] Ignoring cached tokens from year ${parsed.gameYear}, current YEAR=${YEAR}`);
      try { await fs.unlink(tokenFile); } catch {}
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function runSync(leagueId) {
  try {
    await ensureDir();
    const tokens = await loadTokens();
    if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
      throw new Error('No local EA tokens found. Run /madden-auth, log in, and then retry.');
    }
    const client = await createEAClientFromEnv({ ...process.env, EA_ACCESS_TOKEN: tokens.accessToken, EA_REFRESH_TOKEN: tokens.refreshToken, EA_ACCESS_TOKEN_EXPIRES_AT: tokens.expiry, EA_CONSOLE: tokens.console, EA_BLAZE_ID: tokens.blazeId, EA_GAME_YEAR: tokens.gameYear });
    const info = await client.getLeagueInfo(Number(leagueId));
    const currentWeek = info?.careerHubInfo?.seasonInfo?.seasonWeek;
    const stage = info?.careerHubInfo?.seasonInfo?.seasonStage === 0 ? Stage.PRESEASON : Stage.SEASON;

    const [teams, standings] = await Promise.all([
      client.getTeams(Number(leagueId)),
      client.getStandings(Number(leagueId)),
    ]);

    // Fetch full schedule (preseason and season weeks) to avoid empty weeks.
    const allSchedules = [];
    const collectSchedule = async (wk, stg) => {
      try {
        const res = await client.getSchedules(Number(leagueId), stg, wk);
        const list = res?.schedules || [];
        allSchedules.push(...list);
      } catch (e) {
        console.warn(`[madden-sync] schedule fetch failed for week=${wk} stage=${stg}: ${e?.message || e}`);
      }
    };
    // Preseason weeks 0-3
    for (let wk = 0; wk < 4; wk++) {
      await collectSchedule(wk, Stage.PRESEASON);
    }
    // Regular season/playoff weeks 0-22 (cap at 22)
    for (let wk = 0; wk <= 22; wk++) {
      await collectSchedule(wk, Stage.SEASON);
    }
    const schedule = { schedules: allSchedules };

    // Fetch rosters (all teams + free agents)
    const rosters = {};
    const teamList = teams?.leagueTeamInfoList || [];
    await Promise.all(teamList.map(async (team, idx) => {
      try {
        const roster = await client.getTeamRoster(Number(leagueId), team.teamId, idx);
        rosters[team.teamId] = roster;
      } catch (e) {
        console.warn(`[madden-sync] roster fetch failed for teamId=${team?.teamId}: ${e?.message || e}`);
      }
    }));
    let freeAgents = [];
    try {
      freeAgents = await client.getFreeAgents(Number(leagueId));
    } catch (e) {
      console.warn('[madden-sync] free agents fetch failed:', e?.message || e);
    }

    // Fetch weekly stats for all weeks up to currentWeek (season) and preseason weeks 0-3
    const weeklyStats = [];
    const maxSeasonWeek = Math.max(1, currentWeek ?? 1);
    const collectWeek = async (wk, stg) => {
      const entry = { weekIndex: wk, stage: stg };
      try { entry.rushing = await client.getRushingStats(Number(leagueId), stg, wk); } catch (e) { entry.rushingError = e?.message || String(e); }
      try { entry.teamstats = await client.getTeamStats(Number(leagueId), stg, wk); } catch (e) { entry.teamstatsError = e?.message || String(e); }
      try { entry.punting = await client.getPuntingStats(Number(leagueId), stg, wk); } catch (e) { entry.puntingError = e?.message || String(e); }
      try { entry.receiving = await client.getReceivingStats(Number(leagueId), stg, wk); } catch (e) { entry.receivingError = e?.message || String(e); }
      try { entry.defense = await client.getDefensiveStats(Number(leagueId), stg, wk); } catch (e) { entry.defenseError = e?.message || String(e); }
      try { entry.kicking = await client.getKickingStats(Number(leagueId), stg, wk); } catch (e) { entry.kickingError = e?.message || String(e); }
      try { entry.passing = await client.getPassingStats(Number(leagueId), stg, wk); } catch (e) { entry.passingError = e?.message || String(e); }
      weeklyStats.push(entry);
    };
    // Preseason weeks (0-3)
    for (let wk = 0; wk < 4; wk++) {
      await collectWeek(wk, Stage.PRESEASON);
    }
    // Regular season weeks up to currentWeek (inclusive, cap at 22 for playoffs)
    const maxWeekToFetch = Math.min(22, maxSeasonWeek);
    for (let wk = 0; wk <= maxWeekToFetch; wk++) {
      await collectWeek(wk, Stage.SEASON);
    }

    // If schedule fetch returned empty, fall back to previous snapshot schedule if available from file
    let finalSchedule = schedule;
    let finalWeeklyStats = weeklyStats;
    try {
      const prevPath = path.join(leagueDir, `${leagueId}.json`);
      const prevRaw = await fs.readFile(prevPath, 'utf-8');
      const previous = JSON.parse(prevRaw);
      if ((schedule?.schedules?.length ?? 0) === 0 && previous?.schedule?.schedules?.length) {
        finalSchedule = previous.schedule;
      }
      if ((weeklyStats?.length ?? 0) === 0 && Array.isArray(previous?.weeklyStats)) {
        finalWeeklyStats = previous.weeklyStats;
      }
    } catch {}

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      leagueId,
      stage,
      currentWeek,
      info,
      teams,
      standings,
      schedule: finalSchedule,
      rosters: {
        teams: rosters,
        freeAgents,
      },
      weeklyStats: finalWeeklyStats,
    };

    const outPath = path.join(leagueDir, `${leagueId}.json`);
    await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Cleanup: keep only snapshots for this league to avoid accumulating old leagues.
    try {
      const files = await fs.readdir(snapshotsDir);
      await Promise.all(files.map(async f => {
        if (!f.endsWith('.json')) return;
        if (f === `${leagueId}.json`) return;
        try {
          await fs.unlink(path.join(snapshotsDir, f));
        } catch {}
      }));
    } catch (e) {
      console.warn('[madden-sync] cleanup skipped:', e?.message || e);
    }

    return {
      leagueId,
      currentWeek,
      stage,
      teamsCount: teams?.leagueTeamInfoList?.length ?? 0,
      standingsCount: standings?.teamStandingInfoList?.length ?? 0,
      gamesCount: finalSchedule?.schedules?.length ?? 0,
      rosterCount: Object.keys(rosters).length,
      hasFreeAgents: !!freeAgents,
      statsWeeks: finalWeeklyStats?.length ?? 0,
      outPath,
    };
  } catch (err) {
    console.error('❌ Madden sync failed:', err);
    if ((err.message || '').includes('Server Information was not found')) {
      try { await fs.unlink(tokenFile); } catch {}
    }
    throw err;
  }
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id') || resolveLeagueIdWithConfig(interaction.guildId);
  await interaction.deferReply({ ephemeral: true });

  try {
    if (!leagueId) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Madden Sync')
            .setDescription('No league set. Run /madden-set-league or provide league_id.')
            .setColor(0xffcc00)
        ]
      });
      return;
    }
    const summary = await runSync(leagueId);
    const embed = new EmbedBuilder()
      .setTitle('Madden Sync')
      .setColor(0x00cc66)
      .addFields(
        { name: 'League', value: String(summary.leagueId), inline: true },
        { name: 'Week', value: summary.currentWeek ? `${summary.currentWeek} (${getMessageForWeek(summary.currentWeek)})` : 'unknown', inline: true },
        { name: 'Teams', value: String(summary.teamsCount), inline: true },
        { name: 'Standings', value: String(summary.standingsCount), inline: true },
        { name: 'Games', value: String(summary.gamesCount), inline: true },
        { name: 'Rosters', value: `${summary.rosterCount} teams${summary.hasFreeAgents ? ' + FA' : ''}`, inline: true },
        { name: 'Stats Weeks', value: String(summary.statsWeeks), inline: true },
        { name: 'Saved', value: summary.outPath, inline: false }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const msg = typeof err?.message === 'string' ? err.message : 'Unknown error';
    const shortMsg = msg.length > 3900 ? `${msg.slice(0, 3897)}...` : msg;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Madden Sync Failed')
          .setDescription(`${shortMsg}\n(See server logs for full details)`)
          .setColor(0xcc0000)
      ]
    });
  }
}

export default { data, execute, skipDeploy: true };
