import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { loadLeagueSnapshot, currentWeek, getDefaultLeagueId } from '../../../madden/madden_data.js';
import { getFullTeamName } from '../../shared/madden_team_names.js';
import { loadWeeklyGameLog } from '../weekly_game_log.js';
import { coachCommandDescription } from '../../shared/madden_coach_voice.js';

const TEAM_EMOJIS_PATH = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

export const data = new SlashCommandBuilder()
  .setName('madden-schedule')
  .setDescription(coachCommandDescription('schedule'));

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function buildTeamMaps(snapshot) {
  const names = new Map();
  const byId = new Map();
  for (const team of snapshot?.teams?.leagueTeamInfoList || []) {
    const fullName = getFullTeamName(team, `Team ${team.teamId}`);
    names.set(Number(team.teamId), fullName);
    byId.set(Number(team.teamId), team);
  }
  return { names, byId };
}

function standingsMap(snapshot) {
  const map = new Map();
  for (const standing of snapshot?.standings?.teamStandingInfoList || []) {
    map.set(Number(standing.teamId), standing);
  }
  return map;
}

function formatRecord(standing) {
  if (!standing) return '0-0';
  const wins = Number(standing.totalWins || 0);
  const losses = Number(standing.totalLosses || 0);
  const ties = Number(standing.totalTies || 0);
  return ties ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
}

function teamShortName(teamName = '') {
  const parts = String(teamName || '').trim().split(/\s+/);
  return parts[parts.length - 1] || teamName || 'Team';
}

function emojiForTeam(teamName, emojiMap) {
  const mascot = teamShortName(teamName);
  const id = emojiMap?.[teamName] || emojiMap?.[mascot];
  return id ? `<:${String(mascot).replace(/[^A-Za-z0-9_]/g, '')}:${id}>` : mascot;
}

function regularSeasonGames(snapshot) {
  return (snapshot?.schedule?.schedules || [])
    .filter((game) => Number(game?.stageIndex ?? game?.stage ?? -1) === 1)
    .slice()
    .sort((a, b) => Number(a.weekIndex ?? 0) - Number(b.weekIndex ?? 0) || Number(a.scheduleId ?? 0) - Number(b.scheduleId ?? 0));
}

function totalRegularWeeks(snapshot) {
  const weeks = regularSeasonGames(snapshot).map((game) => Number(game.weekIndex ?? -1));
  return weeks.length ? Math.max(...weeks) + 1 : 18;
}

function weekGames(snapshot, weekIndex) {
  return regularSeasonGames(snapshot).filter((game) => Number(game.weekIndex ?? -1) === Number(weekIndex));
}

function latestCompletedRegularWeekIndex(snapshot) {
  const weeks = (snapshot?.weeklyStats || [])
    .filter((week) => Number(week?.stage ?? week?.stageIndex ?? 0) === 1)
    .map((week) => Number(week?.weekIndex ?? -1))
    .filter((week) => week >= 0);
  return weeks.length ? Math.max(...weeks) : -1;
}

function gameStatus(game) {
  const status = Number(game?.status ?? 0);
  if (status >= 2) return 'played';
  if (status === 1) return 'scheduled';
  return 'upcoming';
}

function inferredGameStatus(snapshot, game) {
  const explicit = gameStatus(game);
  if (explicit === 'played') return 'played';
  const latestCompleted = latestCompletedRegularWeekIndex(snapshot);
  const weekIndex = Number(game?.weekIndex ?? -1);
  if (weekIndex >= 0 && weekIndex <= latestCompleted) return 'played_inferred';
  return explicit;
}

function ledgerEntryForGame(ledger, game) {
  return ledger?.games?.find((entry) =>
    String(entry?.scheduleId || '') === String(game?.scheduleId || '')
  ) || null;
}

function playerName(row) {
  return row?.fullName || row?.displayName || `${row?.firstName || ''} ${row?.lastName || ''}`.trim() || 'Unknown';
}

function teamWeeklyTotals(snapshot, weekIndex, teamId) {
  const weekEntries = (snapshot?.weeklyStats || []).filter((week) =>
    Number(week?.weekIndex ?? -1) === Number(weekIndex) &&
    Number(week?.stage ?? week?.stageIndex ?? 0) === 1
  );
  const weekly = weekEntries.sort((a, b) => Number(b?.playerCount || 0) - Number(a?.playerCount || 0))[0];
  if (!weekly) return null;

  const sum = (list, fields) => {
    const out = {};
    for (const row of list || []) {
      if (Number(row?.teamId) !== Number(teamId)) continue;
      for (const field of fields) out[field] = (out[field] || 0) + Number(row?.[field] || 0);
    }
    return out;
  };

  const passing = sum(weekly?.passing?.playerPassingStatInfoList, ['passYds', 'passTDs', 'passInts', 'passComp', 'passAtt']);
  const rushing = sum(weekly?.rushing?.playerRushingStatInfoList, ['rushYds', 'rushTDs', 'rushAtt']);
  const receiving = sum(weekly?.receiving?.playerReceivingStatInfoList, ['recYds', 'recTDs', 'recCatches']);
  const defense = sum(weekly?.defense?.playerDefensiveStatInfoList, ['defSacks', 'defInts', 'defTotalTackles', 'defPassDeflections']);

  const best = (list, scoreFn) =>
    (list || [])
      .filter((row) => Number(row?.teamId) === Number(teamId))
      .slice()
      .sort((a, b) => scoreFn(b) - scoreFn(a))[0] || null;

  return {
    passing,
    rushing,
    receiving,
    defense,
    teamstats: (weekly?.teamstats?.teamStatInfoList || []).find((row) => Number(row?.teamId) === Number(teamId)) || null,
    kicking: sum(weekly?.kicking?.playerKickingStatInfoList, ['fGMade', 'xPMade']),
    passer: best(weekly?.passing?.playerPassingStatInfoList, (row) => Number(row?.passYds || 0)),
    rusher: best(weekly?.rushing?.playerRushingStatInfoList, (row) => Number(row?.rushYds || 0)),
    receiver: best(weekly?.receiving?.playerReceivingStatInfoList, (row) => Number(row?.recYds || 0)),
    defender: best(
      weekly?.defense?.playerDefensiveStatInfoList,
      (row) => (Number(row?.defSacks || 0) * 5) + (Number(row?.defInts || 0) * 6) + Number(row?.defTotalTackles || 0),
    ),
  };
}

function inferredPoints(totals) {
  if (!totals) return null;
  const passingTds = Number(totals?.passing?.passTDs || 0);
  const rushingTds = Number(totals?.rushing?.rushTDs || 0);
  const defensiveTds = Number(totals?.defense?.defTDs || 0);
  const fieldGoals = Number(totals?.kicking?.fGMade || 0);
  const patMade = Number(totals?.kicking?.xPMade || 0);
  const safeties = Number(totals?.defense?.defSafeties || 0);
  const twoPoint = Number(totals?.teamstats?.off2PtConv || 0);
  return ((passingTds + rushingTds + defensiveTds) * 6) + (fieldGoals * 3) + patMade + (safeties * 2) + (twoPoint * 2);
}

function gameDisplayScores(snapshot, game) {
  const ledger = loadWeeklyGameLog(getDefaultLeagueId());
  const logged = ledgerEntryForGame(ledger, game);
  if (logged && (Number(logged.awayScore || 0) > 0 || Number(logged.homeScore || 0) > 0)) {
    return {
      awayScore: Number(logged.awayScore || 0),
      homeScore: Number(logged.homeScore || 0),
      inferred: String(logged.scoreSource || '') !== 'schedule',
    };
  }
  const explicitAway = Number(game?.awayScore || 0);
  const explicitHome = Number(game?.homeScore || 0);
  if (explicitAway > 0 || explicitHome > 0 || Number(game?.status ?? 0) >= 2) {
    return { awayScore: explicitAway, homeScore: explicitHome, inferred: false };
  }
  const weekIndex = Number(game?.weekIndex ?? -1);
  const awayTotals = teamWeeklyTotals(snapshot, weekIndex, Number(game?.awayTeamId));
  const homeTotals = teamWeeklyTotals(snapshot, weekIndex, Number(game?.homeTeamId));
  const awayScore = inferredPoints(awayTotals);
  const homeScore = inferredPoints(homeTotals);
  if (awayScore === null || homeScore === null) return null;
  return { awayScore, homeScore, inferred: true };
}

function formatGameSide(emoji, record, score, isWinner) {
  const side = `${emoji} ${record} ${score}`;
  return isWinner ? `**${side}**` : side;
}

function formatMatchupContext(awayEmoji, awayRecord, homeEmoji, homeRecord) {
  return `${awayEmoji} (${awayRecord}) @ ${homeEmoji} (${homeRecord})`;
}

function formatResultContext({ status, scoreView, ledgerEntry }) {
  if (status === 'played' || status === 'played_inferred') {
    if (scoreView) {
      return `Final: ${Number(scoreView.awayScore || 0)}-${Number(scoreView.homeScore || 0)}`;
    }
    return 'Final logged';
  }
  if (status === 'played_special') {
    return `Outcome: ${ledgerEntry?.outcomeLabel || 'Result Logged'}`;
  }
  return 'Upcoming';
}

function compactGameLine(snapshot, game, names, standings, emojiMap, ledger = null) {
  const awayId = Number(game.awayTeamId);
  const homeId = Number(game.homeTeamId);
  const awayName = names.get(awayId) || 'Away';
  const homeName = names.get(homeId) || 'Home';
  const awayEmoji = emojiForTeam(awayName, emojiMap);
  const homeEmoji = emojiForTeam(homeName, emojiMap);
  const awayRecord = formatRecord(standings.get(awayId));
  const homeRecord = formatRecord(standings.get(homeId));
  const ledgerEntry = ledgerEntryForGame(ledger, game);
  const status = ledgerEntry?.played ? (ledgerEntry?.outcomeLabel ? 'played_special' : 'played') : inferredGameStatus(snapshot, game);
  const scoreView = gameDisplayScores(snapshot, game);

  const matchup = formatMatchupContext(awayEmoji, awayRecord, homeEmoji, homeRecord);
  const result = formatResultContext({ status, scoreView, ledgerEntry });
  return `${matchup} • ${result}`;
}

function weekMenuOptions(totalWeeks, selectedWeek) {
  return Array.from({ length: totalWeeks }, (_, index) => ({
    label: `Week ${index + 1}`,
    value: String(index),
    default: index === Number(selectedWeek),
  })).slice(0, 25);
}

export function buildScheduleWeekView(snapshot, weekIndex) {
  const ledger = loadWeeklyGameLog(getDefaultLeagueId());
  const emojiMap = safeReadJSON(TEAM_EMOJIS_PATH, {});
  const { names } = buildTeamMaps(snapshot);
  const standings = standingsMap(snapshot);
  const totalWeeks = totalRegularWeeks(snapshot);
  const clampedWeek = Math.max(0, Math.min(totalWeeks - 1, Number(weekIndex || 0)));
  const snapshotGames = weekGames(snapshot, clampedWeek);
  const ledgerGames = (ledger?.games || []).filter((entry) =>
    Number(entry?.stageIndex ?? 0) === 1 &&
    Number(entry?.weekIndex ?? -1) === clampedWeek
  );
  const games = snapshotGames.map((game) => {
    const logged = ledgerEntryForGame(ledger, game);
    return logged ? {
      ...game,
      awayScore: logged.awayScore,
      homeScore: logged.homeScore,
      status: logged.played ? 2 : game.status,
    } : game;
  });
  const current = Math.max(1, Number(currentWeek(snapshot) || 1));
  const playedGames = games.filter((game) => {
    const ledgerEntry = ledgerEntryForGame(ledger, game);
    if (ledgerEntry?.played) return true;
    return ['played', 'played_inferred'].includes(inferredGameStatus(snapshot, game));
  });

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`Madden Schedule — Week ${clampedWeek + 1}`)
    .setDescription(
      games.length
        ? games.map((game) => compactGameLine(snapshot, game, names, standings, emojiMap, ledger)).join('\n')
        : (ledgerGames.length
          ? ledgerGames.map((game) => compactGameLine(snapshot, game, names, standings, emojiMap, ledger)).join('\n')
          : 'No regular-season games found for this week.'),
    )
    .setFooter({ text: `Regular season only • current league week: ${current}` });

  const weekRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('madden_schedule_page')
      .setPlaceholder(`Week ${clampedWeek + 1}`)
      .addOptions(weekMenuOptions(totalWeeks, clampedWeek)),
  );

  const gameRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`madden_schedule_game|${clampedWeek}`)
      .setPlaceholder(playedGames.length ? 'View Game Stats' : 'No played games this week')
      .setDisabled(!playedGames.length)
      .addOptions(
        (playedGames.length ? playedGames : games.slice(0, 1)).map((game) => {
          const awayName = names.get(Number(game.awayTeamId)) || 'Away';
          const homeName = names.get(Number(game.homeTeamId)) || 'Home';
          const scoreView = gameDisplayScores(snapshot, game);
          const awayScore = scoreView?.awayScore ?? Number(game.awayScore || 0);
          const homeScore = scoreView?.homeScore ?? Number(game.homeScore || 0);
          const label = playedGames.length
            ? `${teamShortName(awayName)} ${awayScore} vs ${homeScore} ${teamShortName(homeName)}`
            : 'No played games';
          return {
            label: label.slice(0, 100),
            value: String(game.scheduleId || `${clampedWeek}:${game.awayTeamId}:${game.homeTeamId}`),
          };
        }),
      ),
  );

  return { embed, components: [gameRow, weekRow], weekIndex: clampedWeek };
}

function teamTotalsLine(totals) {
  if (!totals) return 'No weekly stat export found for this game.';
  return [
    `Pass ${Number(totals.passing?.passYds || 0)} yds`,
    `Rush ${Number(totals.rushing?.rushYds || 0)} yds`,
    `TO ${Number(totals.passing?.passInts || 0)}`,
    `Sacks ${Number(totals.defense?.defSacks || 0)}`,
  ].join(' • ');
}

function playerStatLine(row, type) {
  if (!row) return 'No stat line';
  if (type === 'pass') return `${playerName(row)} • ${Number(row.passYds || 0)} yds • ${Number(row.passTDs || 0)} TD • ${Number(row.passInts || 0)} INT`;
  if (type === 'rush') return `${playerName(row)} • ${Number(row.rushYds || 0)} yds • ${Number(row.rushTDs || 0)} TD`;
  if (type === 'rec') return `${playerName(row)} • ${Number(row.recYds || 0)} yds • ${Number(row.recTDs || 0)} TD`;
  return `${playerName(row)} • ${Number(row.defTotalTackles || 0)} tk • ${Number(row.defSacks || 0)} sacks • ${Number(row.defInts || 0)} INT`;
}

export function buildGameDetailView(snapshot, weekIndex, scheduleId) {
  const ledger = loadWeeklyGameLog(getDefaultLeagueId());
  const emojiMap = safeReadJSON(TEAM_EMOJIS_PATH, {});
  const { names } = buildTeamMaps(snapshot);
  const standings = standingsMap(snapshot);
  const games = weekGames(snapshot, weekIndex);
  const game = games.find((entry) => String(entry.scheduleId || `${weekIndex}:${entry.awayTeamId}:${entry.homeTeamId}`) === String(scheduleId));
  if (!game) return null;

  const awayId = Number(game.awayTeamId);
  const homeId = Number(game.homeTeamId);
  const awayName = names.get(awayId) || 'Away';
  const homeName = names.get(homeId) || 'Home';
  const awayEmoji = emojiForTeam(awayName, emojiMap);
  const homeEmoji = emojiForTeam(homeName, emojiMap);
  const awayRecord = formatRecord(standings.get(awayId));
  const homeRecord = formatRecord(standings.get(homeId));
  const awayTotals = teamWeeklyTotals(snapshot, weekIndex, awayId);
  const homeTotals = teamWeeklyTotals(snapshot, weekIndex, homeId);
  const scoreView = gameDisplayScores(snapshot, game);
  const awayScore = scoreView?.awayScore ?? Number(game.awayScore || 0);
  const homeScore = scoreView?.homeScore ?? Number(game.homeScore || 0);
  const ledgerEntry = ledgerEntryForGame(ledger, game);
  const status = ledgerEntry?.played ? (ledgerEntry?.outcomeLabel ? 'played_special' : 'played') : inferredGameStatus(snapshot, game);
  const matchupLine = formatMatchupContext(awayEmoji, awayRecord, homeEmoji, homeRecord);
  const resultLine = formatResultContext({ status, scoreView, ledgerEntry });

  const embed = new EmbedBuilder()
    .setColor(0x00b0f4)
    .setTitle(`Week ${weekIndex + 1} — Game Stats`)
    .setDescription([
      matchupLine,
      resultLine,
    ].filter(Boolean).join('\n'))
    .addFields(
      {
        name: `${awayEmoji} ${teamShortName(awayName)}`,
        value: [
          teamTotalsLine(awayTotals),
          `Pass: ${playerStatLine(awayTotals?.passer, 'pass')}`,
          `Rush: ${playerStatLine(awayTotals?.rusher, 'rush')}`,
          `Rec: ${playerStatLine(awayTotals?.receiver, 'rec')}`,
          `Def: ${playerStatLine(awayTotals?.defender, 'def')}`,
        ].join('\n'),
      },
      {
        name: `${homeEmoji} ${teamShortName(homeName)}`,
        value: [
          teamTotalsLine(homeTotals),
          `Pass: ${playerStatLine(homeTotals?.passer, 'pass')}`,
          `Rush: ${playerStatLine(homeTotals?.rusher, 'rush')}`,
          `Rec: ${playerStatLine(homeTotals?.receiver, 'rec')}`,
          `Def: ${playerStatLine(homeTotals?.defender, 'def')}`,
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Pulled from weekly export stats' });

  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`madden_schedule_game|${weekIndex}`)
        .setPlaceholder('View Game Stats')
        .addOptions(
          weekGames(snapshot, weekIndex)
            .filter((entry) => {
              const logged = ledgerEntryForGame(ledger, entry);
              if (logged?.played) return true;
              return ['played', 'played_inferred'].includes(inferredGameStatus(snapshot, entry));
            })
            .map((entry) => {
              const away = names.get(Number(entry.awayTeamId)) || 'Away';
              const home = names.get(Number(entry.homeTeamId)) || 'Home';
              const scoreView = gameDisplayScores(snapshot, entry);
              return {
                label: `${teamShortName(away)} ${scoreView?.awayScore ?? Number(entry.awayScore || 0)} vs ${scoreView?.homeScore ?? Number(entry.homeScore || 0)} ${teamShortName(home)}`.slice(0, 100),
                value: String(entry.scheduleId || `${weekIndex}:${entry.awayTeamId}:${entry.homeTeamId}`),
                default: String(entry.scheduleId || `${weekIndex}:${entry.awayTeamId}:${entry.homeTeamId}`) === String(scheduleId),
              };
            }),
        ),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('madden_schedule_page')
        .setPlaceholder(`Week ${weekIndex + 1}`)
        .addOptions(weekMenuOptions(totalRegularWeeks(snapshot), weekIndex)),
    ),
  ];

  return { embed, components };
}

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const leagueId = getDefaultLeagueId();
    if (!leagueId) throw new Error('No synced Madden league found. Run weekly update first.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const initialWeek = Math.max(0, Math.min(totalRegularWeeks(snapshot) - 1, Number(currentWeek(snapshot) || 1) - 1));
    const view = buildScheduleWeekView(snapshot, initialWeek);
    await interaction.editReply({ embeds: [view.embed], components: view.components });
  } catch (err) {
    await interaction.editReply({ content: `Failed to load schedule: ${err.message}` });
  }
}

export default { data, execute };
