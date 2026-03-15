import fs from 'fs';
import path from 'path';
import { resolveOriginalPickOwner } from '../madden/pick_overrides_store.js';
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade, loadTradeCounts } from '../shared/madden_trade_utils.js';
import { saveTradeDraft } from '../shared/trade_draft_store.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function posAdj(position) {
  const map = {
    QB: 0.35, WR: 0.08, CB: 0.08, REDGE: 0.10, LEDGE: 0.10, DT: 0.05,
    LT: 0.08, RT: 0.06, LG: 0.02, RG: 0.02, C: 0.02,
    FS: 0.02, SS: 0.02, MLB: -0.04, WILL: -0.04, SAM: -0.04,
    HB: -0.03, FB: -0.2, TE: -0.01, K: -0.45, P: -0.45, LS: -0.55,
  };
  return map[position] || 0;
}

function ageAdj(age) {
  if (!age) return 0;
  if (age <= 23) return 0.24;
  if (age <= 25) return 0.17;
  if (age <= 27) return 0.07;
  if (age <= 29) return -0.10;
  if (age <= 31) return -0.16;
  if (age <= 33) return -0.24;
  if (age <= 34) return -0.30;
  if (age <= 35) return -0.38;
  if (age <= 36) return -0.45;
  return -0.50;
}

function devAdj(devTrait) {
  // 0=Normal,1=Star,2=Superstar,3=XFactor
  if (devTrait === 3) return 0.45; // X-Factor
  if (devTrait === 2) return 0.30; // Superstar
  if (devTrait === 1) return 0.18; // Star
  return 0;
}

function yearsAdj(yearsLeftRaw) {
  const years = Number(yearsLeftRaw ?? 0);
  if (!Number.isFinite(years) || years <= 0) return 0;
  return Math.min(years, 4) * 0.015;
}

function capAdj(cap, isRookie = false) {
  const c = Number(cap || 0);
  if (!Number.isFinite(c) || c <= 0) return 0;
  // Rookies: soften cap penalty so high signing bonuses don't crater value
  if (isRookie) return -Math.min(c / 200, 0.05);
  // Penalize large cap hits; scaled to ~0.2 at 30M+
  return -Math.min(c / 150, 0.2);
}

export function computePlayerValue(p) {
  if (!p) return 0;
  const ovr = p.overallRating ?? p.playerBestOvr ?? p.ovrRating ?? 0;
  const age = p.age ?? 26;
  const yearsPro = Number(p.yearsPro ?? 0);
  const cap = Number(p.contractSalary || 0) + Number(p.contractBonus || 0);
  const yearsLeft = p.contractYearsLeft ?? p.contractLengthRemaining ?? p.contractLength ?? p.yearsRemaining ?? 0;
  const draftRound = Number(p.draftRound ?? p.draftYearRound ?? p.collegeDraftRound ?? 0);
  const draftPick = Number(p.draftPick ?? p.draftSelection ?? p.pickNumber ?? 0);
  const isRookie = p.isRookie === true || yearsPro === 0 || age <= 22;
  const pos = (p.position || '').toUpperCase();
  const isQB = pos === 'QB';
  const eliteFloorByPos = {
    QB: 340,
    WR: 245,
    CB: 245,
    LT: 235,
    RT: 210,
    EDGE: 235,
    REDGE: 235,
    LEDGE: 235,
    RE: 235,
    LE: 235,
    DT: 205,
  };
  const positionMultiplier = {
    QB: 1.28,
    WR: 1.10,
    CB: 1.10,
    LT: 1.08,
    RT: 1.02,
    LG: 0.94,
    RG: 0.94,
    C: 0.96,
    EDGE: 1.10,
    REDGE: 1.10,
    LEDGE: 1.10,
    RE: 1.08,
    LE: 1.08,
    DT: 1.00,
    FS: 0.92,
    SS: 0.92,
    MLB: 0.90,
    MIKE: 0.90,
    WILL: 0.90,
    SAM: 0.88,
    HB: 0.88,
    RB: 0.88,
    FB: 0.50,
    TE: 0.86,
    K: 0.18,
    P: 0.14,
    LS: 0.08,
  };
  const ageMultiplier = (() => {
    if (age <= 22) return 1.18;
    if (age <= 24) return 1.12;
    if (age <= 26) return 1.06;
    if (age <= 28) return 1.00;
    if (age <= 30) return 0.94;
    if (age <= 32) return 0.86;
    if (age <= 34) return 0.76;
    return 0.66;
  })();
  const devMultiplier = (() => {
    if (p.devTrait === 3) return 1.16;
    if (p.devTrait === 2) return 1.10;
    if (p.devTrait === 1) return 1.05;
    return 1.00;
  })();
  const contractMultiplier = (() => {
    const years = Number(yearsLeft || 0);
    const base = years > 0 ? 1 + Math.min(years, 4) * 0.015 : 0.96;
    const capPenalty = isRookie ? Math.min(cap / 800, 0.03) : Math.min(cap / 180, 0.10);
    return Math.max(0.85, base - capPenalty);
  })();
  const rookieMultiplier = (() => {
    if (!isRookie) return 1;
    if (draftRound === 1 && draftPick > 0 && draftPick <= 5) return isQB ? 1.24 : 1.18;
    if (draftRound === 1 && draftPick > 0 && draftPick <= 10) return isQB ? 1.18 : 1.12;
    if (draftRound === 1) return 1.08;
    return 1.03;
  })();

  const base = Math.max(0, (ovr - 60)) ** 2 * 0.18 + Math.max(0, (ovr - 60)) * 2.5;
  let value = base
    * (positionMultiplier[pos] || 0.96)
    * ageMultiplier
    * devMultiplier
    * contractMultiplier
    * rookieMultiplier;

  if (isQB && age >= 25 && age <= 31 && ovr >= 84) value *= 1.10;
  if (!isQB && age <= 25 && ovr >= 84) value *= 1.06;
  if (!['K', 'P', 'LS'].includes(pos)) value *= 1.08;

  if (isRookie && draftRound === 1 && draftPick > 0) {
    const rookieFloor = (() => {
      if (isQB && draftPick <= 5) return 300;
      if (isQB && draftPick <= 10) return 260;
      if (draftPick <= 5) return 240;
      if (draftPick <= 10) return 210;
      return 0;
    })();
    if (rookieFloor > 0) value = Math.max(value, rookieFloor + Math.max(0, (ovr - 75) * 5));
  }

  const eliteFloor = eliteFloorByPos[pos];
  if (eliteFloor && ovr >= 95 && age <= 30) {
    value = Math.max(value, eliteFloor + Math.max(0, (ovr - 95) * 18));
  }

  if (['K', 'P', 'LS'].includes(pos)) {
    value = Math.min(value, pos === 'K' ? 35 : pos === 'P' ? 28 : 16);
  }
  if (value > 300) {
    const softCap = isQB ? 1000 : 900;
    const curve = isQB ? 260 : 220;
    value = 300 + (softCap - 300) * (1 - Math.exp(-(value - 300) / curve));
  }
  return Math.max(10, Math.round(value * 10) / 10);
}

function normalizeKey(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildValueMap(snapshot) {
  const map = new Map(); // key -> {player, value}
  const rosters = snapshot?.rosters?.teams || {};
  Object.values(rosters).forEach(r => {
    (r?.rosterInfoList || []).forEach(p => {
      const full = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
      const normFull = normalizeKey(full);
      const last = (p.lastName || '').toLowerCase();
      const normLast = normalizeKey(last);
      const val = computePlayerValue(p);
      const keys = new Set();
      if (full) keys.add(full);
      if (normFull) keys.add(normFull);
      if (last) keys.add(last);
      if (normLast) keys.add(normLast);
      if (p.firstName && p.lastName) {
        const last = (p.lastName || '').toLowerCase();
        const initLast = `${p.firstName[0].toLowerCase()} ${last}`;
        keys.add(initLast);
        keys.add(normalizeKey(initLast));
      }
      keys.forEach(k => map.set(k, { player: p, value: val }));
    });
  });
  return map;
}

function averageRoundPickValue(round) {
  let total = 0;
  for (let pickNum = 1; pickNum <= 32; pickNum += 1) total += currentPickValue(round, pickNum);
  return Math.round(total / 32);
}

function formatPickLabel(year, round, pickNum, viaTeam) {
  const base = `${year} Round ${round}${pickNum ? ` Pick ${pickNum}` : ''}`;
  return viaTeam ? `${base} via ${viaTeam}` : base;
}

export function getMaddenPickContext(snapshot) {
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1;
  const isRegularOrPost = weekType === 1 || weekType === 2;
  const isOffseason =
    weekType === 8 ||
    seasonTitle.includes('offseason') ||
    (seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && !isRegularOrPost);
  const seasonYear = Number(
    snapshot?.info?.calendarYear
    || seasonInfo?.calendarYear
    || seasonInfo?.seasonYear
    || new Date().getFullYear()
  );
  const draftBaseYear = isRegularOrPost ? seasonYear + 1 : seasonYear;
  return {
    isOffseason,
    isRegularOrPost,
    seasonYear,
    draftBaseYear,
    currentYearExactAllowed: isOffseason,
  };
}

function parsePickValue(label, seasonYear, options = {}) {
  // Flexible parse: allow "2026 Round 1 Pick 5", "2027 Round 1 via Jets", "Round 1 Pick 5", "1.05", "1st", etc.
  const trimmed = (label || '').trim();
  if (!trimmed) return null;
  const viaMatch = trimmed.match(/\s+via\s+(.+)$/i);
  const viaTeamRaw = viaMatch?.[1]?.trim() || '';
  const coreLabel = viaMatch ? trimmed.slice(0, viaMatch.index).trim() : trimmed;
  const viaTeam = viaTeamRaw.replace(/^\(|\)$/g, '').trim() || null;
  const season = seasonYear || new Date().getFullYear();
  const currentYearExactAllowed = options.currentYearExactAllowed !== false;
  const resolveViaTeam = typeof options.resolveViaTeam === 'function' ? options.resolveViaTeam : null;
  const resolvedViaTeam = resolveViaTeam && viaTeam ? resolveViaTeam(viaTeam) : viaTeam;
  let year = season;
  let round = null;
  let pickNum = null;
  let explicitYear = false;

  // try dot notation first: 1.10 (round.pick) optional year
  const dotMatch = /^(\d{1,2})\.(\d{1,2})(?:\s+(\d{2,4}))?$/i.exec(coreLabel);
  if (dotMatch) {
    round = Number(dotMatch[1]);
    pickNum = Number(dotMatch[2]);
    if (dotMatch[3]) {
      const y = Number(dotMatch[3]);
      year = y < 100 ? 2000 + y : y;
      explicitYear = true;
    }
  } else {
    const nums = (coreLabel.match(/\d+/g) || []).map(n => Number(n));
    if (nums.length >= 3) {
      year = nums[0] >= 100 ? nums[0] : season;
      round = nums[1];
      pickNum = nums[2];
      explicitYear = true;
    } else if (nums.length === 2) {
      if (nums[0] >= 100) {
        year = nums[0];
        round = nums[1];
        explicitYear = true;
      } else {
        round = nums[0];
        pickNum = nums[1];
      }
    } else if (nums.length === 1) {
      round = nums[0];
    }
  }

  if (!round || round < 1 || round > 7) return null;
  if (!year) year = season;
  const seasonForCalc = season;
  const floorMap = { 1: 150, 2: 110, 3: 85, 4: 65, 5: 50, 6: 35, 7: 25 };
  const floor = floorMap[round] || 10;
  let value;
  let labelPick = pickNum && pickNum > 0 ? pickNum : null;
  const isFuture = year > seasonForCalc;
  const isCurrentYear = year === seasonForCalc;
  const shouldAverageRound = isFuture || (isCurrentYear && !currentYearExactAllowed);
  if (shouldAverageRound) {
    const baseFuture = Math.max(floor, averageRoundPickValue(round));
    const diff = year - seasonForCalc;
    const decay = diff <= 0 ? 1 : diff === 1 ? 0.8 : 0.65;
    value = Math.round(baseFuture * decay);
    if (round === 1 && diff === 1 && value < 240) value = 240;
    if (round === 1 && diff >= 2 && value < 200) value = 200;
    labelPick = null;
  } else {
    if (!pickNum || pickNum < 1) return null;
    const pickValueCurve = currentPickValue(round, pickNum);
    value = Math.max(floor, pickValueCurve);
  }
  const originalOwner = resolvedViaTeam && Number(round) === 1
    ? resolveOriginalPickOwner(resolvedViaTeam, year, round)
    : (resolvedViaTeam || null);
  const normLabel = formatPickLabel(year, round, labelPick, resolvedViaTeam);
  return {
    value: Math.max(5, Math.round(value)),
    label: normLabel,
    year,
    round,
    pickNum: labelPick,
    isFuture,
    viaTeam: resolvedViaTeam,
    originalOwner,
    via: originalOwner ? originalOwner.slice(0, 3).toUpperCase() : undefined,
    canonical: formatPickLabel(year, round, labelPick, resolvedViaTeam),
  };
}

function parseAssets(text, valueMap, seasonYear, pickOptions = {}) {
  const parts = (text || '')
    .split(/[\n,]+/)
    .map(t => t.trim())
    .filter(Boolean);
  let total = 0;
  const matched = [];
  const unmatched = [];
  const posPrefixes = ['qb', 'hb', 'rb', 'wr', 'te', 'lt', 'lg', 'c', 'rg', 'rt', 'le', 're', 'dt', 'mlb', 'olb', 'cb', 'fs', 'ss', 'k', 'p', 'fb', 'will', 'sam', 'mike', 'ledge', 'redge'];
  parts.forEach(part => {
    const raw = part;
    const key = raw.toLowerCase();
    const normKey = normalizeKey(raw);
    const colonSplit = raw.includes(':') ? raw.split(':').pop().trim() : raw;
    const colonKey = colonSplit.toLowerCase();
    const normColon = normalizeKey(colonSplit);
    let stripped = key;
    const firstToken = key.split(/\s+/)[0];
    if (posPrefixes.includes(firstToken)) {
      stripped = key.slice(firstToken.length).trim();
    }
    const normStripped = normalizeKey(stripped);
    let entry = null;
    // picks first
    const pickVal = parsePickValue(part, seasonYear, pickOptions);
    if (pickVal) {
      total += pickVal.value;
      matched.push({ label: pickVal.label, player: null, value: pickVal.value });
      return;
    }
    // direct
    if (valueMap.has(key)) entry = valueMap.get(key);
    else if (valueMap.has(normKey)) entry = valueMap.get(normKey);
    else if (valueMap.has(colonKey)) entry = valueMap.get(colonKey);
    else if (valueMap.has(normColon)) entry = valueMap.get(normColon);
    else if (valueMap.has(stripped)) entry = valueMap.get(stripped);
    else if (valueMap.has(normStripped)) entry = valueMap.get(normStripped);
    if (entry) {
      total += entry.value;
      const p = entry.player;
      const resolvedLabel = p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() || part : part;
      matched.push({ label: resolvedLabel, player: entry.player, value: entry.value });
    } else {
      unmatched.push(part);
    }
  });
  return { total, matched, unmatched };
}

function resolveTeamRoleId(teamName, snapshot, roleMap) {
  if (!teamName) return null;
  const target = teamName.toLowerCase();
  const variants = new Set([target]);

  // Direct map match
  for (const [name, id] of Object.entries(roleMap)) {
    if (!name.endsWith(' Coach')) continue;
    const base = name.replace(/ Coach$/, '').toLowerCase();
    if (base === target) return id;
    if (base.includes(target) || target.includes(base)) return id;
  }

  // Try matching against league snapshot (display/nick/abbr/city)
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const team = teams.find(t => {
    const cands = [
      t.displayName,
      t.nickName,
      t.abbrName,
      t.cityName,
    ].map(x => (x || '').toLowerCase());
    cands.forEach(c => variants.add(c));
    return cands.includes(target) || cands.some(c => c.includes(target) || target.includes(c));
  });
  if (team) {
    const candidates = [
      team.displayName,
      team.nickName,
      team.abbrName,
      team.cityName,
    ].filter(Boolean).map(x => x.toLowerCase());
    candidates.forEach(c => variants.add(c));
    for (const [name, id] of Object.entries(roleMap)) {
      if (!name.endsWith(' Coach')) continue;
      const base = name.replace(/ Coach$/, '').toLowerCase();
      if (candidates.includes(base) || variants.has(base) || base.includes(target) || target.includes(base)) return id;
    }
  }

  return null;
}

function teamDisplay(snapshot, teamName) {
  if (!teamName) return teamName;
  const t = (snapshot?.teams?.leagueTeamInfoList || []).find(tt => {
    const cands = [
      tt.displayName,
      tt.nickName,
      tt.abbrName,
      tt.cityName,
    ].map(x => (x || '').toLowerCase());
    return cands.includes(teamName.toLowerCase());
  });
  return t ? getFullTeamName(t, teamName) : teamName;
}

const VALUE_THRESHOLD = 50;

function currentPickValue(round, pickNum) {
  // Compute overall pick number (cap at 224)
  const r = Math.max(1, Number(round) || 1);
  const p = Math.max(1, Number(pickNum) || 1);
  const overall = Math.min(224, p > 32 ? p : (r - 1) * 32 + p);
  // Hand-tuned top of round 1, then smooth decay
  if (overall === 1) return 800;
  if (overall === 2) return 525;
  if (overall === 3) return 475;
  if (overall === 4) return 425;
  if (overall === 5) return 400;
  // decay from pick 6 onward: 400 * exp(-k*(overall-5)), k tuned so pick 224 ≈ 10
  const k = 0.0145;
  const val = 400 * Math.exp(-k * (overall - 5));
  return Math.max(10, val);
}

function formatValueSummary(sendTotal, recvTotal, gap, flip = false) {
  const youSend = flip ? recvTotal : sendTotal;
  const theySend = flip ? sendTotal : recvTotal;
  const netRaw = typeof gap === 'number' ? gap : (Number(sendTotal) - Number(recvTotal));
  const net = flip ? -netRaw : netRaw;
  const gapAbs = Math.abs(net);
  const thresholdLine = gapAbs <= VALUE_THRESHOLD
    ? `Value check: within limit (gap ${gapAbs.toFixed(1)} ≤ ${VALUE_THRESHOLD})`
    : `Value check: exceeds limit (gap ${gapAbs.toFixed(1)} > ${VALUE_THRESHOLD})`;
  return [
    `You send: ${Number(youSend).toFixed(1)}`,
    `They send: ${Number(theySend).toFixed(1)}`,
    thresholdLine,
  ].join('\n');
}

function buildTradeEmbed({ yourTeam, otherTeam, assetsSent, assetsReceived, notes, valueSummary, hideInstructions = false, assetsSentValueLines, assetsReceivedValueLines }) {
  const safeString = (v) => (typeof v === 'string' && v.length ? v : (v != null ? String(v) : '—'));
  const safeArray = (arr) => Array.isArray(arr) ? arr.filter(Boolean) : [];
  const embed = new EmbedBuilder()
    .setTitle('Trade Proposal')
    .setDescription(hideInstructions ? null : 'List the exact players/picks going each way. Pick format: Year + Round (no pick #), e.g., “2027 1st Round”, “2027 3rd Round”, “2028 1st Round”. Example send: “QB Bo Nix, 2027 1st Round, 2027 3rd Round, 2028 1st Round”; receive: “QB Lamar Jackson, 2027 5th Round”. Trades lock after Week 8.')
    .addFields(
      { name: 'Your Team', value: safeString(yourTeam), inline: true },
      { name: 'Other Team', value: safeString(otherTeam), inline: true },
      { name: 'Assets You Send', value: safeArray(assetsSentValueLines).length ? safeArray(assetsSentValueLines).join('\n') : safeString(assetsSent) },
      { name: 'Assets You Receive', value: safeArray(assetsReceivedValueLines).length ? safeArray(assetsReceivedValueLines).join('\n') : safeString(assetsReceived) },
    )
    .setColor(0x5865f2);
  if (valueSummary) {
    embed.addFields({ name: 'Trade Value Check', value: safeString(valueSummary) });
  }
  if (notes) embed.addFields({ name: 'Notes', value: safeString(notes) });
  // Remove duplicate per-team breakdowns to avoid redundancy
  return embed;
}

export const customId = 'madden_trade_modal_submit';
export { parseAssets, buildValueMap, buildTradeEmbed, formatValueSummary, parsePickValue };

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || interaction.customId !== customId) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  if (!canTrade(leagueId)) {
    await interaction.reply({ content: 'Trades are locked starting Week 13. Try again next season.', ephemeral: true });
    return;
  }
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch { return; }

  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadJson(CHANNEL_MAP_FILE);
    const yourTeamRaw = interaction.fields.getTextInputValue('yourTeam');
    const otherTeamRaw = interaction.fields.getTextInputValue('otherTeam');
    const assetsSent = interaction.fields.getTextInputValue('assetsSent');
    const assetsReceived = interaction.fields.getTextInputValue('assetsReceived');
    const notes = interaction.fields.getTextInputValue('notes');
    const pickContext = getMaddenPickContext(snapshot);
    const draftYearBase = Math.max(2027, pickContext.draftBaseYear);
    const valueMap = buildValueMap(snapshot);
    const pickOptions = { currentYearExactAllowed: pickContext.currentYearExactAllowed };
    const sendVal = parseAssets(assetsSent, valueMap, draftYearBase, pickOptions);
    const recvVal = parseAssets(assetsReceived, valueMap, draftYearBase, pickOptions);
    const gap = sendVal.total - recvVal.total;
    const sendItems = (sendVal.matched || sendVal.items || []).map(it => ({ name: it.label || it.name || it.asset || 'Asset', value: it.value ?? 0 }));
    const recvItems = (recvVal.matched || recvVal.items || []).map(it => ({ name: it.label || it.name || it.asset || 'Asset', value: it.value ?? 0 }));
    const valueSummary = formatValueSummary(sendVal.total, recvVal.total, gap, false);
    const unmatched = [...sendVal.unmatched, ...recvVal.unmatched];

    const yourTeam = teamDisplay(snapshot, yourTeamRaw);
    const otherTeam = teamDisplay(snapshot, otherTeamRaw);

    // Enforce per-team trade cap before sending proposal
    const counts = loadTradeCounts();
    const overCap = [yourTeam, otherTeam].find(t => t && (counts[t] || 0) >= 5);
    if (overCap) {
      await interaction.editReply({ content: `Trade blocked: ${overCap} has already made 5 trades this season.` });
      return;
    }

    const sendLines = sendItems.map(i => `${i.name || 'Asset'} (${Number(i.value || 0).toFixed(1)})`);
    const recvLines = recvItems.map(i => `${i.name || 'Asset'} (${Number(i.value || 0).toFixed(1)})`);

    const embed = buildTradeEmbed({
      yourTeam,
      otherTeam,
      assetsSent,
      assetsReceived,
      notes,
      valueSummary,
      hideInstructions: true,
      assetsSentValueLines: sendLines,
      assetsReceivedValueLines: recvLines,
    });
    const formatItems = (items) => {
      if (!items?.length) return 'None';
      return items.map(i => `${i.name || i.label || 'Asset'} (${Number(i.value || 0).toFixed(1)})`).join('\n');
    };
    embed.addFields(
      { name: `${yourTeam} sends (value)`, value: formatItems(sendItems), inline: false },
      { name: `${otherTeam} sends (value)`, value: formatItems(recvItems), inline: false },
    );
    // Build an ephemeral preview draft (no DM/finalize yet)
    const draftId = `draft_${interaction.user.id}_${Date.now()}`;
    saveTradeDraft(draftId, {
      draftId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      yourTeamRaw,
      otherTeamRaw,
      yourTeam,
      otherTeam,
      assetsSent,
      assetsReceived,
      notes,
      sendVal,
      recvVal,
      sendItems,
      recvItems,
      gap,
      seasonYear,
      unmatched,
      savedAt: Date.now(),
    });

    const modifyBtn = new ButtonBuilder()
      .setCustomId(`madden_trade_preview_modify|${draftId}`)
      .setLabel('Modify Deal')
      .setStyle(ButtonStyle.Secondary);
    const submitBtn = new ButtonBuilder()
      .setCustomId(`madden_trade_preview_submit|${draftId}`)
      .setLabel('Check Value')
      .setStyle(ButtonStyle.Primary);
    const previewRow = new ActionRowBuilder().addComponents(modifyBtn, submitBtn);

    await interaction.editReply({
      content: 'Preview — use Modify to adjust or Check Value to run the value check and send for approval.',
      embeds: [embed],
      components: [previewRow],
      ephemeral: true,
    });
  } catch (e) {
    await interaction.editReply({ content: `Trade submission failed: ${e?.message || e}` });
  }
}

export default { customId, execute };
