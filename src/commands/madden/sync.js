import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { createEAClientFromEnv, Stage } from '../../madden/ea_client.js';
import { getMessageForWeek } from '../../madden/madden_utils.js';
import { YEAR } from '../../madden/ea_constants.js';
import { resolveLeagueIdWithConfig } from '../../madden/madden_data.js';

const leagueDir = path.join(process.cwd(), 'data', 'madden', 'leagues');
const tokenFile = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

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

    const [teams, standings, schedule] = await Promise.all([
      client.getTeams(Number(leagueId)),
      client.getStandings(Number(leagueId)),
      client.getSchedules(Number(leagueId), stage, currentWeek ?? 1),
    ]);

    const snapshot = {
      fetchedAt: new Date().toISOString(),
      leagueId,
      stage,
      currentWeek,
      info,
      teams,
      standings,
      schedule,
    };

    const outPath = path.join(leagueDir, `${leagueId}.json`);
    await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    return {
      leagueId,
      currentWeek,
      stage,
      teamsCount: teams?.leagueTeamInfoList?.length ?? 0,
      standingsCount: standings?.teamStandingInfoList?.length ?? 0,
      gamesCount: schedule?.schedules?.length ?? 0,
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

export default { data, execute };
