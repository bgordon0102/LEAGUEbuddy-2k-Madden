import fs from 'fs';
import path from 'path';
import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade, loadTradeCounts } from '../shared/madden_trade_utils.js';
import { saveTradeDraft } from '../shared/trade_draft_store.js';

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
  const attr = (keys) => {
    for (const k of keys) {
      if (p[k] != null) return Number(p[k]) || 0;
    }
    return 0;
  };
  const spd = attr(['speedRating', 'spd', 'speed']);
  const acc = attr(['accelerationRating', 'acc', 'acceleration']);
  const agi = attr(['agilityRating', 'agi', 'agility']);
  const str = attr(['strengthRating', 'str', 'strength']);
  const athAvg = (spd + acc + agi) / 3 || 0;
  const athBoost = Math.max(-0.12, Math.min(0.30, (athAvg - 80) / 35)); // slightly steeper spread
  const isOffSkill = ['QB', 'HB', 'RB', 'WR', 'TE', 'FB'].includes(p.position);
  const isDB = ['CB', 'FS', 'SS'].includes(p.position);
  const isEdge = ['REDGE', 'LEDGE', 'EDGE', 'ROLB', 'LOLB', 'RE', 'LE'].includes(p.position);
  const isDT = ['DT', 'IDL', 'DI'].includes(p.position);
  const isOL = ['LT', 'LG', 'C', 'RG', 'RT'].includes(p.position);
  const passBlock = attr(['passBlockRating', 'pbk']);
  const runBlock = attr(['runBlockRating', 'rbk']);
  const blockBoost = isOL ? Math.max(0, (passBlock + runBlock) / 2 - 75) / 60 : 0;
  const rushMove = attr(['finesseMovesRating', 'fmv']) + attr(['powerMovesRating', 'pmv']);
  const passRushBoost = (isEdge || isDT) ? Math.max(0, (rushMove / 2 - 75) / 40) : 0;
  const cover = attr(['manCoverageRating', 'pressCoverageRating', 'zoneCoverageRating', 'mcv', 'zcv']);
  const coverBoost = isDB ? Math.max(0, (cover - 75) / 45) : 0;
  const draftRound = Number(p.draftRound ?? p.draftYearRound ?? p.collegeDraftRound ?? 0);
  const draftPick = Number(p.draftPick ?? p.draftSelection ?? p.pickNumber ?? 0);
  const isRookie = p.isRookie === true || yearsPro === 0 || age <= 22;

  const pos = posAdj(p.position);
  const ageFactor = ageAdj(age);
  const dev = devAdj(p.devTrait);
  const yrs = yearsAdj(yearsLeft);
  const capHit = capAdj(cap, isRookie);
  // Heavier weight for franchise QBs in prime window (ages 26-32) with high OVR/dev
  let qbPrimeBoost = 0;
  const isQB = p.position === 'QB';
  const highOvrQB = isQB && ovr >= 85;
  const primeAgeQB = isQB && age >= 26 && age <= 32;
  if (highOvrQB) qbPrimeBoost += 0.12;
  if (primeAgeQB) qbPrimeBoost += 0.15;
  if (isQB && p.devTrait >= 2) qbPrimeBoost += 0.08; // SS/X get an extra nudge
  // Young upside boost for any position
  let youthUpside = 0;
  if (age <= 24 && ovr >= 80) youthUpside += 0.18;
  if (age <= 26 && ovr >= 85) youthUpside += 0.13;
  // Young franchise QB bonus and athletic boost
  if (isQB) {
    if (age <= 25 && ovr >= 82) youthUpside += 0.22;
    if (age <= 27 && ovr >= 85) youthUpside += 0.15;
    if (p.devTrait >= 2) youthUpside += 0.08;
    const qbAth = Math.max(0, ((spd + acc) / 2) - 80) / 40; // mobile QB bump slightly larger
    qbPrimeBoost += qbAth;
  }
  // Rookie pedigree bump: top-round rookies carry extra value even at lower OVR
  let rookiePedigree = 0;
  if (isRookie && draftRound === 1) {
    if (draftPick > 0 && draftPick <= 5) rookiePedigree += 0.35;
    else if (draftPick > 0 && draftPick <= 10) rookiePedigree += 0.25;
    else rookiePedigree += 0.18;
    if (p.devTrait >= 2) rookiePedigree += 0.08;
    // Extra bump for skill positions taken very high
    const isSkill = ['QB', 'WR', 'HB', 'RB', 'TE'].includes(p.position);
    if (isSkill && draftPick > 0 && draftPick <= 3) rookiePedigree += 0.06;
  }
  // Veteran decay for high OVR past prime
  let vetDrag = 0;
  if (age >= 30 && ovr >= 88) vetDrag -= 0.18;
  if (age >= 32 && ovr >= 85) vetDrag -= 0.24;
  if (age >= 34 && ovr >= 82) vetDrag -= 0.32;
  if (age >= 35 && ovr >= 80) vetDrag -= 0.40;

  const multiplier = 1.0
    + pos
    + ageFactor
    + dev
    + yrs
    + capHit
    + qbPrimeBoost
    + youthUpside
    + rookiePedigree
    + vetDrag
    + (athBoost * (isOffSkill || isDB || isEdge ? 1.1 : 0.6))
    + blockBoost
    + passRushBoost
    + coverBoost;
  const safeMultiplier = Math.max(0.2, multiplier); // prevent negative/zero
  // Non-linear base to widen gap between elite and low OVR
  const base = Math.pow(Math.max(0, ovr - 40), 2) / 10;
  // Global spread to raise ceiling and widen separation
  let value = base * safeMultiplier * 1.2; // boost overall range
  if (ovr >= 96) value *= 1.12;
  if (ovr >= 98) value *= 1.08;
  // Floor elite QBs: 94+ → 500+, 90–93 → 400+
  if (p.position === 'QB') {
    if (ovr >= 94 && value < 500) value = 500;
    else if (ovr >= 90 && value < 400) value = 400;
  }
  // Elite veteran floor: keep high-OVR vets from cratering
  if (ovr >= 95 && age >= 34 && value < 250) {
    value = 250 + (ovr - 95) * 12; // 95 -> 250, 99 -> 298
  }
  // Rookie pedigree floors (keep top picks from looking cheap)
  if (isRookie && draftRound === 1 && draftPick > 0 && draftPick <= 5) {
    const floor = p.position === 'QB' ? 425 : 325;
    if (value < floor) value = floor + Math.max(0, (ovr - 70) * 4);
  } else if (isRookie && draftRound === 1 && draftPick > 0 && draftPick <= 10) {
    const floor = p.position === 'QB' ? 360 : 300;
    if (value < floor) value = floor + Math.max(0, (ovr - 70) * 3);
  }
  // Fallback rookie QB franchise floor (for cases missing draft data)
  if (isQB && isRookie && age <= 22 && p.devTrait >= 2) {
    const qbRookieFloor = 420 + Math.max(0, (ovr - 74) * 5); // 76 OVR -> 430
    if (value < qbRookieFloor) value = qbRookieFloor;
  }
  // Fallback rookie top-pick floor for non-QB skill positions when draft data present
  if (isRookie && !isQB && ['WR', 'HB', 'RB', 'TE'].includes(p.position) && draftRound === 1 && draftPick > 0) {
    let floor = 0;
    if (draftPick === 1) floor = 360;
    else if (draftPick <= 5) floor = 340;
    else if (draftPick <= 10) floor = 310;
    if (floor > 0 && value < floor) value = floor + Math.max(0, (ovr - 70) * 3);
  }
  // Fallback floor for elite rookie skill players when draft data missing
  if (isRookie && !isQB && ['WR', 'HB', 'RB', 'TE'].includes(p.position) && draftRound === 0 && draftPick === 0) {
    const baseFloor = (p.devTrait >= 2) ? 330 : 300;
    const uplift = Math.max(0, (ovr - 70) * 3);
    if (value < baseFloor) value = baseFloor + uplift;
  }
  // Clamp to global bounds to align with cross-sport scale
  value = Math.min(1000, value);
  return Math.max(40, Math.round(value * 10) / 10);
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

function parsePickValue(label, seasonYear) {
  // Flexible parse: allow "2026 Round 1 Pick 5", "Round 1 Pick 5", "1.05", "1st", etc.
  const trimmed = (label || '').trim();
  if (!trimmed) return null;
  const season = seasonYear || new Date().getFullYear();
  let year = season;
  let round = null;
  let pickNum = null;

  // try dot notation first: 1.10 (round.pick) optional year
  const dotMatch = /^(\d{1,2})\.(\d{1,2})(?:\s+(\d{2,4}))?$/i.exec(trimmed);
  if (dotMatch) {
    round = Number(dotMatch[1]);
    pickNum = Number(dotMatch[2]);
    if (dotMatch[3]) {
      const y = Number(dotMatch[3]);
      year = y < 100 ? 2000 + y : y;
    }
  } else {
    const nums = (trimmed.match(/\d+/g) || []).map(n => Number(n));
    if (nums.length >= 3) {
      year = nums[0] >= 100 ? nums[0] : season;
      round = nums[1];
      pickNum = nums[2];
    } else if (nums.length === 2) {
      if (nums[0] >= 100) {
        year = nums[0];
        round = nums[1];
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
  // derive pickNum midpoint if missing
  if (!pickNum || pickNum < 1) {
    const start = (round - 1) * 32 + 1;
    const end = round * 32;
    pickNum = Math.floor((start + end) / 2);
  }
  const pickValueCurve = currentPickValue(round, pickNum);
  const floorMap = { 1: 150, 2: 110, 3: 85, 4: 65, 5: 50, 6: 35, 7: 25 };
  const floor = floorMap[round] || 10;
  let value;
  let labelPick = pickNum;
  const isFuture = year > season;
  if (isFuture) {
    // Future picks: round averages aligned to new current curve (slightly discounted vs current year)
    const futureBaseChart = { 1: 275, 2: 165, 3: 120, 4: 90, 5: 65, 6: 45, 7: 32 };
    const baseFuture = futureBaseChart[round] || floor;
    const diff = year - season;
    const futureDecay = diff === 1 ? 0.85 : 0.7;
    value = Math.max(5, Math.round(baseFuture * futureDecay));
    if (round === 1 && diff === 1 && value < 250) value = 250;
    if (round === 1 && diff >= 2 && value < 200) value = 200;
    labelPick = null;
  } else {
    value = Math.max(floor, pickValueCurve);
  }
  const yearLabel = year ? year : season;
  const normLabel = `Round ${round}${labelPick ? ` Pick ${labelPick}` : ''} (${yearLabel})`;
  return {
    value: Math.max(5, Math.round(value)),
    label: normLabel,
    year,
    round,
    pickNum: labelPick,
    isFuture,
  };
}

function parseAssets(text, valueMap, seasonYear) {
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
    const pickVal = parsePickValue(part, seasonYear);
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
  return t ? (t.displayName || t.nickName || t.cityName) : teamName;
}

const VALUE_THRESHOLD = 50;

function currentPickValue(round, pickNum) {
  // Compute overall pick number (cap at 224)
  const r = Math.max(1, Number(round) || 1);
  const p = Math.max(1, Number(pickNum) || 1);
  const overall = Math.min(224, (r - 1) * 32 + p);
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
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
    const valueMap = buildValueMap(snapshot);
    const sendVal = parseAssets(assetsSent, valueMap, seasonYear);
    const recvVal = parseAssets(assetsReceived, valueMap, seasonYear);
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
