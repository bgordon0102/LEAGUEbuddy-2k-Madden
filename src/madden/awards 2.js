import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import { getPinId } from './pins_store.js'; // unused but kept in case future pinning is desired

const LEAGUE_DIR = path.join(process.cwd(), 'data', 'madden', 'leagues');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');
const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const AWARDS_FILE = path.join(process.cwd(), 'data', 'madden', 'awards.json');
const TEAM_EMOJIS_FILE = path.join(process.cwd(), 'data', 'madden', 'team_emojis.json');

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadSnapshot(leagueId) {
  const file = path.join(LEAGUE_DIR, `${leagueId}.json`);
  return loadJson(file, null);
}

function conferenceMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const div = (t.divisionName || t.divName || '').toUpperCase();
    if (div.includes('AFC')) map[t.teamId] = 'AFC';
    else if (div.includes('NFC')) map[t.teamId] = 'NFC';
  });
  return map;
}

function teamNameMap(snapshot) {
  const map = {};
  (snapshot?.teams?.leagueTeamInfoList || []).forEach(t => {
    const name = [t.cityName, t.displayName || t.nickName].filter(Boolean).join(' ').trim();
    map[t.teamId] = name || `Team ${t.teamId}`;
  });
  return map;
}

function coachMention(teamName, roleMap) {
  if (!teamName) return null;
  const target = teamName.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(roleMap || {})) {
    if (!key.endsWith(' Coach')) continue;
    const base = key.replace(/ Coach$/, '').toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<@&${val}>`;
    }
  }
  return null;
}

function teamEmoji(teamName, emojiMap) {
  if (!teamName) return '';
  const target = teamName.toLowerCase();
  const mascot = target.split(/\s+/).pop();
  for (const [key, val] of Object.entries(emojiMap || {})) {
    const base = key.toLowerCase();
    if (base === target || base === mascot || target.includes(base) || base.includes(target)) {
      return `<:${key.replace(/\s+/g, '')}:${val}>`;
    }
  }
  return '';
}

function isRookie(player) {
  // Per request: only players with yearsPro === 0 qualify as rookies
  if (player?.yearsPro !== undefined && player?.yearsPro !== null) {
    return Number(player.yearsPro) === 0;
  }
  return false;
}

function gatherWeeklyStats(snapshot, weekIndex) {
  const list = snapshot?.weeklyStats || [];
  const matches = list.filter(w => Number(w.weekIndex) === Number(weekIndex));
  const pickHighestStage = (arr) => {
    const copy = [...arr];
    copy.sort((a, b) => (Number(b.stage ?? b.stageIndex ?? 0)) - (Number(a.stage ?? a.stageIndex ?? 0)));
    return copy[0];
  };
  const hasPlayerData = (wk) => {
    const buckets = [
      wk?.passing?.playerPassingStatInfoList,
      wk?.rushing?.playerRushingStatInfoList,
      wk?.receiving?.playerReceivingStatInfoList,
      wk?.defense?.playerDefensiveStatInfoList,
    ];
    return buckets.some(b => Array.isArray(b) && b.length > 0);
  };

  // Try exact week
  if (matches.length) {
    const wk = pickHighestStage(matches);
    if (hasPlayerData(wk)) return wk;
  }

  // Fallback: latest week with player data (season stage preferred)
  const withData = list.filter(hasPlayerData);
  if (withData.length) {
    const seasonFirst = withData.filter(w => Number(w.stage ?? w.stageIndex ?? 0) === 1);
    if (seasonFirst.length) return pickHighestStage(seasonFirst.slice(-1));
    return pickHighestStage(withData.slice(-1));
  }

  // Last resort: any entry
  if (list.length) return pickHighestStage(list.slice(-1));
  return null;
}

function mergePlayerStats(weekly) {
  const agg = new Map();
  const add = (list, fields) => {
    (list || []).forEach(p => {
      const id = p.rosterId || `${p.fullName}-${p.teamId || ''}`;
      if (!id) return;
      const cur = agg.get(id) || { ...p, totals: {} };
      fields.forEach(f => {
        const val = Number(p[f] ?? 0);
        cur.totals[f] = (cur.totals[f] || 0) + (Number.isFinite(val) ? val : 0);
      });
      agg.set(id, cur);
    });
  };
  add(weekly?.passing?.playerPassingStatInfoList, ['passYds', 'passTDs', 'passInts']);
  add(weekly?.rushing?.playerRushingStatInfoList, ['rushYds', 'rushTDs', 'rushAtt', 'fumbles']);
  add(weekly?.receiving?.playerReceivingStatInfoList, ['recYds', 'recTDs', 'recCatches']);
  add(weekly?.defense?.playerDefensiveStatInfoList, [
    'defTotalTackles', 'defSoloTackles', 'defSacks',
    'defTacklesForLoss', 'defInts', 'defForcedFumbles',
    'defRecoveredFumbles', 'defPassDeflections', 'defTDs'
  ]);
  return agg;
}

function winBonus(player) {
  // If score present, use score to infer win; otherwise no bonus.
  if (player?.teamScore != null && player?.oppScore != null) {
    return player.teamScore > player.oppScore ? 5 : 0;
  }
  return 0;
}

function scoreOffense(p) {
  const pos = (p.position || '').toUpperCase();
  const t = p.totals || {};
  const passScore = (t.passYds || 0) * 0.04 + (t.passTDs || 0) * 6 - (t.passInts || 0) * 4;
  const rushScore = (t.rushYds || 0) * 0.1 + (t.rushTDs || 0) * 6;
  const recScore = (t.recYds || 0) * 0.1 + (t.recTDs || 0) * 6;
  let base = 0;
  if (pos === 'QB') {
    base = passScore + rushScore;
  } else if (['HB', 'FB'].includes(pos)) {
    base = rushScore + recScore;
  } else {
    base = recScore + rushScore;
  }
  if (t.passYds > 350 || t.rushYds > 125 || t.recYds > 125) base += 3;
  return base + winBonus(p);
}

function scoreDefense(p) {
  const t = p.totals || {};
  let score = 0;
  score += (t.defTotalTackles || 0) * 1;
  score += (t.defSacks || 0) * 4;
  score += (t.defTacklesForLoss || 0) * 2;
  score += (t.defInts || 0) * 6;
  score += (t.defForcedFumbles || 0) * 4;
  score += (t.defRecoveredFumbles || 0) * 2;
  score += (t.defPassDeflections || 0) * 1;
  score += (t.defTDs || 0) * 6;
  score += winBonus(p);
  return score;
}

function formatLine(p) {
  const t = p.totals || {};
  const parts = [];
  if (t.passYds || t.passTDs || t.passInts !== undefined) {
    parts.push(`Pass: ${Math.round(t.passYds || 0)}y / TD ${t.passTDs || 0} / INT ${t.passInts || 0}`);
  }
  if (t.rushYds || t.rushTDs) parts.push(`Rush: ${Math.round(t.rushYds || 0)}y / TD ${t.rushTDs || 0}`);
  if (t.recYds || t.recTDs || t.recCatches) parts.push(`Rec: ${Math.round(t.recYds || 0)}y / TD ${t.recTDs || 0} / REC ${t.recCatches || 0}`);
  if (t.defTotalTackles || t.defSacks || t.defInts || t.defPassDeflections) {
    parts.push(`Def: TAK ${t.defTotalTackles || 0} / SACK ${t.defSacks || 0} / INT ${t.defInts || 0} / PD ${t.defPassDeflections || 0}`);
  }
  return parts.join('\n') || 'No stats';
}

function pickWinner(players, conf) {
  let list = Array.from(players.values()).filter(p => p.conference === conf);
  if (!list.length) {
    // fallback if conference mapping missing
    list = Array.from(players.values());
  }
  if (!list.length) return null;
  list.forEach(p => { p.score = scoreOffense(p); });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.passTDs || b.totals?.rushTDs || b.totals?.recTDs || 0) - (a.totals?.passTDs || a.totals?.rushTDs || a.totals?.recTDs || 0))
    || ((b.totals?.passYds || b.totals?.rushYds || b.totals?.recYds || 0) - (a.totals?.passYds || a.totals?.rushYds || a.totals?.recYds || 0))
    || ((a.totals?.passInts || 0) - (b.totals?.passInts || 0)));
  return list[0];
}

function pickDefWinner(players, conf) {
  let list = Array.from(players.values()).filter(p => p.conference === conf);
  if (!list.length) {
    list = Array.from(players.values());
  }
  if (!list.length) return null;
  list.forEach(p => { p.score = scoreDefense(p); });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.defTDs || 0) - (a.totals?.defTDs || 0))
    || ((b.totals?.defInts || 0) - (a.totals?.defInts || 0))
    || ((b.totals?.defSacks || 0) - (a.totals?.defSacks || 0))
    || ((b.totals?.defTotalTackles || 0) - (a.totals?.defTotalTackles || 0)));
  return list[0];
}

function pickRookie(allPlayers, seasonYear) {
  const list = Array.from(allPlayers.values()).filter(p => isRookie(p, seasonYear));
  if (!list.length) return null;
  list.forEach(p => {
    const pos = (p.position || '').toUpperCase();
    if (['CB', 'FS', 'SS', 'LB', 'ROLB', 'LOLB', 'MLB', 'RE', 'LE', 'DT'].includes(pos)) {
      p.score = scoreDefense(p);
    } else {
      p.score = scoreOffense(p);
    }
  });
  list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || ((b.totals?.defTDs || b.totals?.passTDs || b.totals?.rushTDs || b.totals?.recTDs || 0) - (a.totals?.defTDs || a.totals?.passTDs || a.totals?.rushTDs || a.totals?.recTDs || 0))
    || ((b.totals?.passYds || b.totals?.rushYds || b.totals?.recYds || 0) - (a.totals?.passYds || a.totals?.rushYds || a.totals?.recYds || 0)));
  return list[0];
}

function normalizeGameScores(weekly) {
  // If weekly passing stats have teamScore/oppScore per player, great; otherwise ignore.
  // No-op placeholder: many datasets won't have this per-player; scoring still works.
}

export async function updateAwards(client, leagueId, weekOverride = null) {
  const snapshot = loadSnapshot(leagueId);
  if (!snapshot) {
    console.warn('[awards] Snapshot missing; run weekly update first.');
    return;
  }
  const channelMap = loadJson(CHANNEL_MAP_FILE);
  const roleMap = loadJson(ROLE_MAP_FILE);
  const emojiMap = loadJson(TEAM_EMOJIS_FILE);
  const awardsChannelId = channelMap['Awards'];
  if (!awardsChannelId) {
    console.warn('[awards] Awards channel missing.');
    return;
  }
  const channel = await client.channels.fetch(awardsChannelId).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn('[awards] Awards channel not text-based or missing.');
    return;
  }

  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || snapshot?.calendarYear;
  const currentWeek = Number(weekOverride ?? snapshot?.currentWeek ?? 0);
  const awardsWeek = currentWeek - 1; // always award the prior week
  if (awardsWeek < 1) {
    console.log('[awards] Not enough regular-season weeks completed; skipping awards.');
    return;
  }
  const targetWeekIdx = awardsWeek - 1;
  const isPlayoffs = awardsWeek >= 19; // assume weeks 19+ are playoffs

  // Load existing winners if present (allow re-post)
  const awardsStore = loadJson(AWARDS_FILE, {});
  const leagueStore = awardsStore[leagueId] || {};
  let existing = leagueStore[awardsWeek];
  const allNull =
    existing &&
    !existing.afc_offense &&
    !existing.nfc_offense &&
    !existing.afc_defense &&
    !existing.nfc_defense;
  if (allNull) {
    existing = null; // force recompute if previously stored as all N/A
  }

  let winners = existing;
  if (!winners) {
    let weekly = gatherWeeklyStats(snapshot, targetWeekIdx);
    if (!weekly) {
      console.warn('[awards] No weekly stats found for week', currentWeek, '; nothing to post.');
      return;
    }

    normalizeGameScores(weekly);
    const byPlayer = mergePlayerStats(weekly);
    const confMap = conferenceMap(snapshot);
    const teamNames = teamNameMap(snapshot);

    // Build roster lookup to enrich player metadata (yearsPro, name) for rookie detection
    const rosterLookup = new Map();
    const addRosterList = (list) => {
      (list || []).forEach(p => {
        if (p?.rosterId === undefined || p?.rosterId === null) return;
        rosterLookup.set(p.rosterId, p);
      });
    };
    Object.values(snapshot?.rosters?.teams || {}).forEach(r => addRosterList(r?.rosterInfoList || r?.rosterPlayerInfoList || []));
    addRosterList(snapshot?.rosters?.freeAgents?.rosterInfoList || snapshot?.rosters?.freeAgents || []);

    // attach team/conference/name metadata
    byPlayer.forEach(p => {
      p.teamName = teamNames[p.teamId] || 'Unknown';
      p.conference = confMap[p.teamId] || null;
      const rosterMatch = p.rosterId != null ? rosterLookup.get(p.rosterId) : null;
      p.fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || (rosterMatch ? `${rosterMatch.firstName || ''} ${rosterMatch.lastName || ''}`.trim() : '');
      if (p.yearsPro === undefined || p.yearsPro === null) {
        p.yearsPro = rosterMatch?.yearsPro;
      }
      if (p.draftYear === undefined || p.draftYear === null) {
        p.draftYear = rosterMatch?.draftYear;
      }
      if (p.isRookie === undefined || p.isRookie === null) {
        p.isRookie = rosterMatch?.isRookie;
      }
    });

    winners = {
      afc_offense: pickWinner(byPlayer, 'AFC'),
      nfc_offense: pickWinner(byPlayer, 'NFC'),
      afc_defense: pickDefWinner(byPlayer, 'AFC'),
      nfc_defense: pickDefWinner(byPlayer, 'NFC'),
      rookie_offense: isPlayoffs ? null : pickWinner(new Map(Array.from(byPlayer).filter(([,p]) => isRookie(p))), null),
      rookie_defense: isPlayoffs ? null : pickDefWinner(new Map(Array.from(byPlayer).filter(([,p]) => isRookie(p))), null),
    };
    // Fallbacks if any category didn't resolve
    const all = Array.from(byPlayer.values());
    const fallbackOff = (arr) => arr.sort((a,b)=> (b.totals?.passYds||b.totals?.rushYds||b.totals?.recYds||0) - (a.totals?.passYds||a.totals?.rushYds||a.totals?.recYds||0))[0];
    const fallbackDef = (arr) => arr.sort((a,b)=> (b.totals?.defTotalTackles||0) - (a.totals?.defTotalTackles||0))[0];
    if (!winners.afc_offense) winners.afc_offense = fallbackOff(all);
    if (!winners.nfc_offense) winners.nfc_offense = fallbackOff(all);
    if (!winners.afc_defense) winners.afc_defense = fallbackDef(all);
    if (!winners.nfc_defense) winners.nfc_defense = fallbackDef(all);
    if (!winners.rookie_offense && !isPlayoffs) winners.rookie_offense = fallbackOff(all.filter(p=>isRookie(p)));
    if (!winners.rookie_defense && !isPlayoffs) winners.rookie_defense = fallbackDef(all.filter(p=>isRookie(p)));

    // If rookie still missing, broaden to all weeks in the snapshot and pick best rookie by totals
    if ((!winners.rookie_offense || !winners.rookie_defense) && !isPlayoffs) {
      const agg = new Map();
      const addPlayerTotals = (wk) => {
        const mp = mergePlayerStats(wk);
        mp.forEach((val, key) => {
          const existing = agg.get(key) || { ...val, totals: {} };
          Object.entries(val.totals || {}).forEach(([k,v]) => {
            existing.totals[k] = (existing.totals[k] || 0) + (Number(v) || 0);
          });
          agg.set(key, existing);
        });
      };
      (snapshot?.weeklyStats || []).forEach(addPlayerTotals);
      agg.forEach(p => {
        p.teamName = teamNames[p.teamId] || 'Unknown';
        p.conference = confMap[p.teamId] || null;
        p.fullName = p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim();
      });
      const rookiesAllWeeks = new Map(Array.from(agg.entries()).filter(([,p]) => isRookie(p)));
      if (!winners.rookie_offense) winners.rookie_offense = pickWinner(rookiesAllWeeks, null);
      if (!winners.rookie_defense) winners.rookie_defense = pickDefWinner(rookiesAllWeeks, null);
    }
  }

  const allMissing =
    !winners.afc_offense &&
    !winners.nfc_offense &&
    !winners.afc_defense &&
    !winners.nfc_defense &&
    ((isPlayoffs) || (!winners.rookie_offense && !winners.rookie_defense));
  if (allMissing) {
    console.warn('[awards] Computed awards are empty for week', currentWeek, '; will retry on next update.');
    return;
  }

  const makeField = (label, p) => {
    if (!p) return { name: label, value: 'N/A', inline: false };
    const mention = coachMention(p.teamName, roleMap);
    const emoji = teamEmoji(p.teamName, emojiMap);
    const header = `${emoji ? emoji + ' ' : ''}${p.position || ''} ${p.fullName || 'Unknown'} — ${p.teamName}`;
    const line = formatLine(p);
    return {
      name: label,
      value: `${header}${mention ? ` (${mention})` : ''}\n${line}`,
      inline: false,
    };
  };

  const coachTag = roleMap['Madden Coach'] ? `<@&${roleMap['Madden Coach']}>` : null;

  const embed = new EmbedBuilder()
    .setTitle(`Weekly Awards — Week ${awardsWeek}${isPlayoffs ? ' (Playoffs)' : ''}`)
    .setDescription(coachTag ? coachTag : null)
    .setColor(0xf1c40f)
    .addFields(
      makeField('AFC Offensive Player of the Week', winners.afc_offense),
      makeField('NFC Offensive Player of the Week', winners.nfc_offense),
      makeField('AFC Defensive Player of the Week', winners.afc_defense),
      makeField('NFC Defensive Player of the Week', winners.nfc_defense),
      ...(isPlayoffs ? [] : [
        makeField('Offensive Rookie of the Week', winners.rookie_offense),
        makeField('Defensive Rookie of the Week', winners.rookie_defense),
      ]),
    )
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] }).catch(() => null);
  awardsStore[leagueId] = { ...leagueStore, [awardsWeek]: winners };
  saveJson(AWARDS_FILE, awardsStore);
}

export default { updateAwards };
