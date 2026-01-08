import { SlashCommandBuilder } from 'discord.js';
import { promises as fs } from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { createEAClientFromEnv, Stage } from '../../madden/ea_client.js';
import { getMessageForWeek } from '../../madden/madden_utils.js';

const leagueDir = path.join(process.cwd(), 'data', 'madden', 'leagues');
const tokenFile = path.join(process.cwd(), 'data', 'madden', 'tokens.json');

const data = new SlashCommandBuilder()
  .setName('madden-sync')
  .setDescription('Pull Madden data directly from EA and save locally.')
  .addStringOption(option =>
    option.setName('league_id')
      .setDescription('Madden league ID')
      .setRequired(true)
  );

async function ensureDir() {
  await fs.mkdir(leagueDir, { recursive: true });
}

async function loadTokens() {
  try {
    const txt = await fs.readFile(tokenFile, 'utf-8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

async function execute(interaction) {
  const leagueId = interaction.options.getString('league_id');
  await interaction.deferReply({ ephemeral: true });

  try {
    await ensureDir();
    const tokens = await loadTokens();
    if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Madden Sync')
            .setDescription('No local EA tokens found. Run /madden-auth, log in, and then retry.')
            .setColor(0xffcc00)
        ]
      });
      return;
    }
    const client = await createEAClientFromEnv({ ...process.env, EA_ACCESS_TOKEN: tokens.accessToken, EA_REFRESH_TOKEN: tokens.refreshToken, EA_ACCESS_TOKEN_EXPIRES_AT: tokens.expiry, EA_CONSOLE: tokens.console, EA_BLAZE_ID: tokens.blazeId });
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

    const embed = new EmbedBuilder()
      .setTitle('Madden Sync')
      .setColor(0x00cc66)
      .addFields(
        { name: 'League', value: String(leagueId), inline: true },
        { name: 'Week', value: currentWeek ? `${currentWeek} (${getMessageForWeek(currentWeek)})` : 'unknown', inline: true },
        { name: 'Teams', value: String(teams?.leagueTeamInfoList?.length ?? 0), inline: true },
        { name: 'Standings', value: String(standings?.teamStandingInfoList?.length ?? 0), inline: true },
        { name: 'Games', value: String(schedule?.schedules?.length ?? 0), inline: true },
        { name: 'Saved', value: outPath, inline: false }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Madden sync failed:', err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Madden Sync Failed')
          .setDescription(err.message || 'Unknown error')
          .setColor(0xcc0000)
      ]
    });
  }
}

export default { data, execute };
