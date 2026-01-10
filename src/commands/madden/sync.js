import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { createEAClientFromEnv, Stage } from '../../madden/ea_client.js';
import { getMessageForWeek } from '../../madden/madden_utils.js';
import { YEAR } from '../../madden/ea_constants.js';
import { resolveLeagueIdWithConfig } from '../../madden/madden_data.js';
import { loadTokens as loadTokensDb } from '../../madden/madden_db.js';
import { SnallabotProvider } from '../../madden/providers/SnallabotProvider.js';

const leagueDir = path.join(process.cwd(), 'data', 'madden', 'leagues');
const prevDir = path.join(leagueDir, 'previous');
const tokenFile = path.join(process.cwd(), 'data', 'madden', 'tokens.json');
const snapshotsDir = leagueDir;
const useSnallabot = (process.env.MADDEN_SYNC_USE_SNALLABOT ?? 'true').toLowerCase() !== 'false';

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
  await fs.mkdir(prevDir, { recursive: true });
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

export async function runSync(leagueId, provider, options = {}) {
  const weekOverride = options.week ? Number(options.week) : null;
  try {
    await ensureDir();
    const tokens = await loadTokens();
    if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
      throw new Error('No local EA tokens found. Run /madden-auth, log in, and then retry.');
    }
    const client = await createEAClientFromEnv({ ...process.env, EA_ACCESS_TOKEN: tokens.accessToken, EA_REFRESH_TOKEN: tokens.refreshToken, EA_ACCESS_TOKEN_EXPIRES_AT: tokens.expiry, EA_CONSOLE: tokens.console, EA_BLAZE_ID: tokens.blazeId, EA_GAME_YEAR: tokens.gameYear });
    let info = null;
    let currentWeek = null;
    let stage = Stage.SEASON;
    if (provider) {
      try {
        const wk = await provider.getCurrentWeek(String(leagueId));
        currentWeek = wk.week;
        stage = wk.stage === 'preseason' ? Stage.PRESEASON : Stage.SEASON;
      } catch (e) {
        console.warn('[madden-sync] provider getCurrentWeek failed, falling back to EA hub:', e?.message || e);
      }
    }
    if (!info || currentWeek === null || currentWeek === undefined || currentWeek <= 0) {
      info = await client.getLeagueInfo(Number(leagueId));
      const seasonInfo = info?.careerHubInfo?.seasonInfo || {};
      const infoDisplayWeek = seasonInfo.displayWeek;
      const infoWeek = seasonInfo.seasonWeek;
      // Madden hub appears to store seasonWeek as 0-based; displayWeek is already 1-based.
      const normalizedInfoWeek = Number.isInteger(infoDisplayWeek) && infoDisplayWeek > 0
        ? infoDisplayWeek
        : Number.isInteger(infoWeek)
          ? infoWeek + 1
          : null;
      if (normalizedInfoWeek) currentWeek = normalizedInfoWeek;
      const infoStage = seasonInfo.seasonWeekType ?? seasonInfo.seasonStage;
      stage = infoStage === 0 ? Stage.PRESEASON : Stage.SEASON;
    }
    // Fallback: parse from getLeagues seasonText if still unset/zero.
    if (currentWeek === null || currentWeek === undefined || currentWeek <= 0) {
      try {
        const leagues = await client.getLeagues();
        const found = leagues.find(l => String(l.leagueId) === String(leagueId));
        const text = found?.seasonText || '';
        // e.g., "Season 2025 PRE Wk 1" or "Season 2025 REG Wk 2"
        const match = /wk\s+(\d+)/i.exec(text);
        if (match) currentWeek = Number(match[1]) || currentWeek || 0;
        if (text.toLowerCase().includes('pre')) stage = Stage.PRESEASON;
      } catch (e) {
        console.warn('[madden-sync] getLeagues fallback failed:', e?.message || e);
      }
    }
    if (currentWeek === null || currentWeek === undefined) currentWeek = 0;
    if (weekOverride) currentWeek = weekOverride;

    const [teams, standings] = await Promise.all([
      client.getTeams(Number(leagueId)),
      client.getStandings(Number(leagueId)),
    ]);

    // Schedule fetch: try provider first, then EA across all relevant weeks.
    let schedule = { schedules: [] };
    if (provider) {
      try {
        schedule = await provider.getFullSchedule(String(leagueId));
      } catch (e) {
        console.warn('[madden-sync] provider getFullSchedule failed, falling back to EA:', e?.message || e);
      }
    }
    const weekBuckets = {
      preseason: [0, 1, 2, 3],
      season: Array.from({ length: 23 }, (_, i) => i).filter(i => i !== 21), // 0-22 skip 21 (Pro Bowl)
    };
    if (!schedule?.schedules?.length) {
      const allSchedules = [];
      const seen = new Set();
      const collectSchedule = async (wk, stg) => {
        try {
          const res = await client.getSchedules(Number(leagueId), stg, wk);
          const list = res?.gameScheduleInfoList || res?.schedules || [];
          for (const g of list) {
            const key = g?.scheduleId || `${g?.homeTeamId}-${g?.awayTeamId}-${g?.weekIndex}-${stg}`;
            if (seen.has(key)) continue;
            seen.add(key);
            allSchedules.push(g);
          }
        } catch (e) {
          console.warn(`[madden-sync] schedule fetch failed for week=${wk} stage=${stg}: ${e?.message || e}`);
        }
      };
      for (const wk of weekBuckets.preseason) await collectSchedule(wk, Stage.PRESEASON);
      for (const wk of weekBuckets.season) await collectSchedule(wk, Stage.SEASON);
      schedule = { schedules: allSchedules };
    }

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
    const prevPath = path.join(prevDir, `${leagueId}.json`);
    // Save previous snapshot for diffing (transactions, etc.)
    try {
      const existing = await fs.readFile(outPath, 'utf-8');
      await fs.writeFile(prevPath, existing, 'utf-8');
    } catch { /* no previous snapshot */ }
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
    const provider = useSnallabot ? new SnallabotProvider() : null;
    const summary = await runSync(leagueId, provider);
    const weekLabel = summary.currentWeek === null || summary.currentWeek === undefined
      ? 'unknown'
      : `${summary.currentWeek} (${getMessageForWeek(summary.currentWeek)})`;
    const embed = new EmbedBuilder()
      .setTitle('Madden Sync')
      .setColor(0x00cc66)
      .addFields(
        { name: 'League', value: String(summary.leagueId), inline: true },
        { name: 'Week', value: weekLabel, inline: true },
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
    const lower = msg.toLowerCase();
    let guidance = 'Try again shortly.';
    if (lower.includes('no local ea tokens')) {
      guidance = 'Run `/madden-auth` (or `/madden-auth reset` then `/madden-auth`), then rerun the sync.';
    } else if (lower.includes('no sessionkey') || lower.includes('auth_err_invalid_token') || lower.includes('server information was not found')) {
      guidance = 'Tokens look bad. Run `/madden-auth reset` then `/madden-auth` (PS5 Madden 2026 account), ensure `EA_CONSOLE=ps5` / `EA_GAME_YEAR=2026`, then rerun.';
    } else if (lower.includes('deleted') || lower.includes('league')) {
      guidance = 'Check the league ID. Run `/madden-set-league <your_league_id>` then rerun.';
    }
    const shortMsg = msg.length > 3000 ? `${msg.slice(0, 2997)}...` : msg;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Madden Sync Failed')
          .setDescription(`${shortMsg}\n(See server logs for full details)`)
          .addFields({ name: 'Next steps', value: guidance })
          .setColor(0xcc0000)
      ]
    });
  }
}

export default { data, execute, skipDeploy: true };
