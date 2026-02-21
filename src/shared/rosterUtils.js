import fs from 'fs';
import path from 'path';

// Return the current 2K roster directory (prefers data/2k/teams_rosters, falls back to legacy path)
export function get2kRostersDir() {
  const primary = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
  const legacy = path.join(process.cwd(), 'data', 'teams_rosters');
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(legacy)) return legacy;
  return primary; // default to primary path even if missing; callers may create it
}

export function normalizeName(name) {
  return name ? name.trim() : '';
}

// --- NBA 2K trade value model ---
export function computePlayerValue2k(player) {
  if (!player) return 0;
  // Accept a wider set of keys coming from different roster exports
  const ovr = Number(
    player.ovr ??
    player.OVR ??
    player.rating ??
    player.Rating ??
    player.overall ??
    player.Overall ??
    0
  );
  const positionRaw = (player.position || player.Position || '').toUpperCase();
  const position = positionRaw.split(/[\\s/]+/)[0] || positionRaw;
  const age = deriveAge(player);
  const { salary, yearsLeft } = deriveContract(player);
  const archetype = (player.archetype || player.role || '').toLowerCase();
  const wingspanIn = parseFloat(String(player.wingspan || player.Wingspan || '').replace(/[^0-9.]/g, '')) || null;
  const heightIn = (() => {
    const h = String(player.height || player.Height || '');
    const m = h.match(/(\d+)'(\d+)/);
    if (m) return Number(m[1]) * 12 + Number(m[2]);
    const d = h.match(/(\d+)\s*in/);
    if (d) return Number(d[1]);
    return null;
  })();

  // Base spreads elite talent more aggressively
  const base = Math.pow(Math.max(0, ovr - 50), 2.35);

  let mult = 1;

  // Age curve – heavier premium for young, steeper decay for vets
  if (age <= 22) mult += 0.32;
  else if (age <= 25) mult += 0.24;
  else if (age <= 27) mult += 0.10;
  else if (age <= 30) mult += 0.00;
  else if (age <= 32) mult -= 0.12;
  else if (age <= 34) mult -= 0.20;
  else mult -= 0.40;

  // Position scarcity (slight boost to creators and elite bigs)
  const posAdj = { PG: 0.08, SG: 0.05, SF: 0.03, PF: 0.00, C: 0.07 };
  mult += posAdj[position] || 0;

  // Franchise cornerstone bonuses (Wemby-type protection)
  if (ovr >= 94 && age <= 25) mult += 0.18;
  else if (ovr >= 90 && age <= 26) mult += 0.12;

  // Elite ceilings
  if (ovr >= 96) mult += 0.12;
  else if (ovr >= 92) mult += 0.08;
  else if (ovr >= 88) mult += 0.04;

  // Contract effects
  const capHit = salary / 10_000_000; // normalize to $10M
  const drag = Math.min(0.36, Math.max(0, capHit - 1) * 0.09); // stronger penalty; none <=$10M
  mult -= drag;
  if (yearsLeft >= 3 && capHit <= 1.2) mult += 0.08; // cheap multi-year
  if (yearsLeft >= 4) mult += 0.05;
  else if (yearsLeft === 3) mult += 0.02;
  else if (yearsLeft === 1) mult -= 0.07;

  // Defensive premium for long wings / stoppers
  const isWing = ['SG','SF','PF'].includes(position);
  const isBig = ['PF','C'].includes(position);
  const lengthBonus = (wingspanIn && heightIn && wingspanIn - heightIn >= 3) ? 0.05 : 0;
  const defenseTag = /defender|lock|clamp|perimeter|rim|anchor|menace|3-and-d|3 and d|two-way|2-way|2 way/i;
  const defenseBonus = defenseTag.test(archetype || '') ? 0.05 : 0;
  mult += lengthBonus + defenseBonus;
  if (isWing && (lengthBonus || defenseBonus)) {
    mult += 0.03; // wingspan + D stack
  }
  if (isBig && defenseBonus) {
    mult += 0.02; // rim protectors get a touch more
  }

  // Clamp multiplier to sane bounds
  mult = Math.max(0.35, Math.min(1.8, mult));

  // Elite tier uplift to widen separation
  let tier = 1;
  if (ovr >= 96) tier = 1.55;
  else if (ovr >= 92) tier = 1.40;
  else if (ovr >= 88) tier = 1.20;
  else if (ovr >= 86) tier = 1.12;
  else if (ovr >= 84) tier = 1.08;
  // Young elite kicker
  if (ovr >= 84 && age <= 25) tier += 0.05;

  // Extra youth premium for high-OVR players still on the upswing
  let youthUplift = 1;
  if (ovr >= 92 && age <= 21) youthUplift += 0.18;
  else if (ovr >= 90 && age <= 24) youthUplift += 0.12;
  else if (ovr >= 86 && age <= 25) youthUplift += 0.10;
  else if (ovr >= 80 && age <= 26) youthUplift += 0.08;
  else if (ovr >= 75 && ovr <= 79 && age <= 22) youthUplift += 0.10;
  // Elite prodigies: push them toward top-end valuations
  if (ovr >= 88 && age <= 22) youthUplift += 0.07;
  // Generational teens (e.g., 18–19 y/o 85+ OVR) get an extra shove
  const prodigyBoost = (age <= 19 && ovr >= 85) ? 1.6 : 1;
  // High-upside teens/early-20s in upper-70s get a stronger prodigy nudge
  const risingStarBoost = (age <= 21 && ovr >= 77 && ovr <= 79) ? 1.2 : 1;

  // Young high-upside starter tier (Castle-type): 82–86 OVR and age ≤22
  let youngHighUpside = 1;
  if (age <= 22 && ovr >= 82 && ovr <= 86) {
    youngHighUpside += 0.60;
    // Extra premium if they're a wing (young superstar wing scarcity)
    if (['SF','PF'].includes(position)) youngHighUpside += 0.30;
  } else if (age <= 22 && ovr >= 80 && ['SF','PF'].includes(position)) {
    youngHighUpside += 0.20;
  }

  // Young core boost for 80+ under 25 to lift guys like Mobley into the top tier
  let youngCoreBoost = 1;
  if (age <= 24 && ovr >= 86) youngCoreBoost += 1.2;
  else if (age <= 24 && ovr >= 84) youngCoreBoost += 0.9;
  else if (age <= 25 && ovr >= 80) youngCoreBoost += 0.6;

  // Extra premium for high-OVR youth (≤25 and 85+)
  let youngEliteBoost = 1;
  if (age <= 25 && ovr >= 90) youngEliteBoost += 0.35;
  else if (age <= 25 && ovr >= 87) youngEliteBoost += 0.28;
  else if (age <= 25 && ovr >= 85) youngEliteBoost += 0.22;

  // Prime boost for established stars (raises players like Donovan Mitchell in mid/late 20s)
  let primeBoost = 1;
  if (ovr >= 94 && age >= 25 && age <= 30) primeBoost += 1.10;
  else if (ovr >= 90 && age >= 25 && age <= 30) primeBoost += 0.95;
  else if (ovr >= 88 && age >= 25 && age <= 31) primeBoost += 0.85;
  else if (ovr >= 86 && age >= 25 && age <= 31) primeBoost += 0.55;
  else if (ovr >= 85 && age >= 25 && age <= 31) primeBoost += 0.25;

  // Extra elite bump purely on OVR, regardless of age
  let eliteBoost = 1;
  if (ovr >= 98) eliteBoost += 0.36;
  else if (ovr >= 96) eliteBoost += 0.30;
  else if (ovr >= 95) eliteBoost += 0.22;
  else if (ovr >= 88) eliteBoost += 0.10;

  // Super-tier separation so 90+ guys are much harder to acquire (realism)
  let superTierBoost = 1;
  if (ovr >= 96) superTierBoost = 1.55;
  else if (ovr >= 94) superTierBoost = 1.35;
  else if (ovr >= 91) superTierBoost = 1.18;

  // Upper-mid tier lift (86–90): keep late‑All‑Stars expensive but below the super tier
  let upperMidBoost = 1;
  if (ovr >= 88 && ovr <= 90) {
    upperMidBoost += 0.22;
  } else if (ovr >= 86 && ovr < 88) {
    upperMidBoost += 0.14;
  }

  // Guard creator bump (Fox-type): mid/high OVR guards in prime get some extra weight (tempered)
  let guardPrimeBoost = 1;
  if (['PG','SG'].includes(position) && ovr >= 88 && age >= 24 && age <= 30) {
    guardPrimeBoost += 0.08;
  } else if (['PG','SG'].includes(position) && ovr >= 85 && age >= 24 && age <= 28) {
    guardPrimeBoost += 0.05;
  }

  // All-Star guard premium (Mitchell-type): make high-OVR prime guards more expensive
  let guardAllStarBoost = 1;
  if (['PG','SG'].includes(position) && ovr >= 90 && age >= 24 && age <= 30) {
    guardAllStarBoost += 0.55;
  } else if (['PG','SG'].includes(position) && ovr >= 88 && age >= 24 && age <= 30) {
    guardAllStarBoost += 0.40;
  }

  // Young lead-guard premium (Castle-type): high-upside guards under 22 get a strong lift
  let youthGuardBoost = 1;
  if (['PG','SG'].includes(position) && age <= 22 && ovr >= 83 && ovr <= 86) {
    youthGuardBoost += 0.75;
  } else if (['PG','SG'].includes(position) && age <= 22 && ovr >= 80) {
    youthGuardBoost += 0.35;
  }

  // Young big-man premium: modern mobile bigs with upside are harder to acquire
  let youthBigBoost = 1;
  if (['PF','C'].includes(position) && age <= 23 && ovr >= 82) {
    youthBigBoost += 0.35;
  } else if (['PF','C'].includes(position) && age <= 23 && ovr >= 78) {
    youthBigBoost += 0.22;
  }

  // Elite big-man boost: 86+ bigs (PF/C) get extra scarcity weight
  let eliteBigBoost = 1;
  if (['PF','C'].includes(position) && ovr >= 96) {
    eliteBigBoost += 0.55;
  } else if (['PF','C'].includes(position) && ovr >= 92) {
    eliteBigBoost += 0.32;
  } else if (['PF','C'].includes(position) && ovr >= 89) {
    eliteBigBoost += 0.24;
  } else if (['PF','C'].includes(position) && ovr >= 86) {
    eliteBigBoost += 0.15;
  }

  // Wing prime bump: mid-prime wings get a bigger lift (premium trade scarcity)
  let wingPrimeBoost = 1;
  if (['SF','PF'].includes(position) && ovr >= 88 && age >= 23 && age <= 29) {
    wingPrimeBoost += 0.40;
  } else if (['SF','PF'].includes(position) && ovr >= 85 && age >= 23 && age <= 30) {
    wingPrimeBoost += 0.28;
  }

  // Low-band uplift so 67–75 OVR players aren't all floor-capped
  let lowBandBoost = 1;
  if (ovr >= 67 && ovr <= 75) {
    // Scales from 0% at 67 to +60% at 75
    lowBandBoost += ((ovr - 67) / 8) * 0.60;
  }

  // Rookie multiplier (boost Year 1 upside/controlled deal)
  const yearsInNBA = Number(player?.yearsInNBA || 0);
  // Stronger rookie bump to surface early upside/cheap deals
  const rookieBoost = yearsInNBA <= 1 ? 1.35 : 1;

  // Senior decline to keep mid/late-30s vets below rising cores
  let seniorPenalty = 1;
  if (age >= 36) seniorPenalty = 0.72;
  else if (age >= 34) seniorPenalty = 0.82;
  else if (age >= 32) seniorPenalty = 0.90;

  const raw = Math.round(base * mult * tier * youthUplift * prodigyBoost * risingStarBoost * youngHighUpside * youngCoreBoost * youngEliteBoost * primeBoost * eliteBoost * superTierBoost * upperMidBoost * guardPrimeBoost * guardAllStarBoost * youthGuardBoost * youthBigBoost * eliteBigBoost * wingPrimeBoost * lowBandBoost * rookieBoost * seniorPenalty * 10) / 10;
  // Scale down overall to align 2K top values with Madden top values; hard cap at 1000
  let scaled = raw * 0.0155; // heavier top end, still capped
  // Soft cap around 1000 with tapering (above 980, apply diminishing returns)
  let capped = scaled;
  if (capped > 980) {
    const over = capped - 980;
    capped = 980 + over * 0.35; // steep taper past 980
  }
  if (capped > 1050) capped = 1050; // hard stop a bit above 1000

  // Ensure solid vets (OVR 80+) retain meaningful value even with age/contract drag
  const vetFloor = (ovr >= 80)
    ? 380 + Math.max(0, (ovr - 80)) * 15 // 80→380, 85→455, 90→530
    : 0;
  // Prime guard/wing floor to lift mid-late 20s stars
  const primeFloor = (ovr >= 86 && age >= 24 && age <= 31)
    ? 540 + Math.max(0, ovr - 86) * 20 // 86→540, 90→620, 95→720
    : 0;

  // Franchise floor: 94+ OVR and <=28 yrs should be near untouchable (Shai/Tatum/SKD tier)
  const franchiseFloor = (ovr >= 94 && age <= 30)
    ? 850 + Math.max(0, ovr - 94) * 35 // 94→850, 96→920, 98→990, 99→1025 (capped later)
    : 0;

  // High-90s prime (90–93) still command a steep floor when under 29
  const highNinetiesFloorBase = (ovr >= 90 && ovr < 94 && age <= 29)
    ? 700 + Math.max(0, ovr - 90) * 22 // 90→700, 93→766
    : 0;
  const highNinetiesFloor = (age >= 33) ? highNinetiesFloorBase * 0.8 : highNinetiesFloorBase;

  // Upper-mid floor for 86–90 to keep all-star wings/guards pricey even without youth
  const upperMidFloorBase = (ovr >= 86 && ovr <= 90)
    ? 600 + Math.max(0, ovr - 86) * 20 // 86→600, 90→680
    : 0;
  const upperMidFloor = (age >= 33) ? upperMidFloorBase * 0.75 : upperMidFloorBase;

  // Elite big-man floor: keep 86+ bigs above mid-tier guards even without youth
  const eliteBigFloorBase = (['PF','C'].includes(position) && ovr >= 86)
    ? 620 + Math.max(0, ovr - 86) * 18 // 86→620, 90→692, 93→746
    : 0;
  const eliteBigFloor = (age >= 33) ? eliteBigFloorBase * 0.85 : eliteBigFloorBase;

  // Rookie floor for 75–82 OVR Year 1 players so they aren't stuck at late‑bench values
  const rookieFloor = (yearsInNBA <= 1 && ovr >= 75 && ovr <= 82)
    ? 320 + Math.max(0, ovr - 75) * 18 // 75→320, 82→446
    : 0;
  // Floor for young rising players (75–79 OVR, ≤22) so they aren't lumped with older role guys
  const youngFloor = (ovr >= 75 && ovr <= 79 && age <= 22)
    ? 220 + Math.max(0, ovr - 75) * 25 // 75→220, 79→320
    : 0;
  // Premium floor for under-22 high-upside starters (82–86 OVR) to surface above mid-prime vets
  const youthPremiumFloor = (age <= 22 && ovr >= 82 && ovr <= 86)
    ? 500 + Math.max(0, ovr - 82) * 25 // 82→500, 84→550, 86→600
    : 0;
  // Young big-man floor to keep mobile upside bigs above role-player tiers
  const youthBigFloor = (['PF','C'].includes(position) && age <= 23 && ovr >= 82)
    ? 460 + Math.max(0, ovr - 82) * 22 // 82→460, 85→526
    : 0;
  // Low floor for 70–75 OVR
  const lowFloor = (ovr >= 70 && ovr <= 75) ? 40 : 0;

  // Absolute global floor
  const globalFloor = 40;

  // Smooth minimum curve for 67–79 OVR to avoid clustering at the floor
  const curveFloor = (ovr >= 67 && ovr <= 79)
    ? 40 + Math.max(0, (ovr - 67)) * 15 // 67→40, 70→85, 74→145, 78→205, 79→220
    : 0;

  return Math.round(Math.max(
    capped,
    vetFloor,
    primeFloor,
    franchiseFloor,
    highNinetiesFloor,
    upperMidFloor,
    eliteBigFloor,
    rookieFloor,
    youngFloor,
    youthPremiumFloor,
    youthBigFloor,
    lowFloor,
    curveFloor,
    globalFloor
  ) * 10) / 10;
}

// --- NBA 2K draft pick valuation ---
// Scaled to the 2K player value range (elite players ~4500-6500 in this model)
export function computePickValue2k(year, round, pickNum, seasonYear, protection) {
  const r = Number(round);
  if (!r || r < 1 || r > 2) return 0; // NBA two rounds; treat others as 0

  const currentYear = seasonYear || new Date().getFullYear();
  const diff = Number(year) - currentYear;

  // If pick missing, assume middle of round
  const pick = Number(pickNum) || (r === 1 ? 15 : 45);

  // Current-year curves (directly in our 2K value scale)
  // Goal: mid‑R1 ~240, early ~332, late ~142. R2 mid ~80–90.
  const curveR1 = (p) => {
    const start = 332;  // pick 1
    const end = 142;    // pick 30
    const t = Math.min(1, Math.max(0, (p - 1) / 29)); // p=1 ->0, p=30 ->1
    return start + (end - start) * t;
  };
  const curveR2 = (p) => {
    const start = 120;  // pick 31
    const end = 50;     // pick 60
    const t = Math.min(1, Math.max(0, (p - 31) / 29)); // p=31 ->0, p=60 ->1
    return start + (end - start) * t;
  };

  const floorMap = { 1: 100, 2: 50 };

  // Current season (diff <= 0)
  if (diff <= 0) {
    const base = r === 1 ? curveR1(pick) : curveR2(pick);
    const raw = Math.max(floorMap[r] || 50, Math.round(base));
    const protectionMultipliers = {
      top3: 0.96,
      top5: 0.93,
      top10: 0.88,
      lottery: 0.82,
    };
    const mult = protection ? (protectionMultipliers[protection] || 1) : 1;
    return Math.round(raw * mult);
  }

  // Future picks: decay the current-year value by distance, keep meaningful but lower
  // Decay ~20% per year out, floor protected.
  const currentMid = r === 1 ? 240 : 80; // representative mid value to scale decay
  const yearsOut = Math.max(1, diff);
  const decay = Math.pow(0.7, yearsOut); // 0.7, 0.49, 0.343...
  const val = Math.max(floorMap[r] || 50, Math.round(currentMid * decay));
  // Apply protection multiplier if present (slight discount; bigger discount for broader protections)
  const protectionMultipliers = {
    top3: 0.96,
    top5: 0.93,
    top10: 0.88,
    lottery: 0.82,
  };
  const mult = protection ? (protectionMultipliers[protection] || 1) : 1;
  return Math.round(val * mult);
}

export function parsePickValue2k(label, seasonYear) {
  if (!label) return null;
  const lower = label.toLowerCase();
  // detect protection clauses
  let protection = null;
  if (/lottery\s*protected/.test(lower) || /\btop\s*14\b/.test(lower)) protection = 'lottery';
  else if (/top\s*10\s*protected/.test(lower)) protection = 'top10';
  else if (/top\s*5\s*protected/.test(lower)) protection = 'top5';
  else if (/top\s*3\s*protected/.test(lower)) protection = 'top3';

  // Extract year
  let year;
  const yearMatch = lower.match(/20\d{2}/);
  if (yearMatch) {
    year = Number(yearMatch[0]);
  } else {
    const twoMatch = lower.match(/\b'?([0-9]{2})\b/);
    if (twoMatch) {
      const two = Number(twoMatch[1]);
      const base = seasonYear || new Date().getFullYear();
      const century = Math.floor(base / 100) * 100;
      year = century + two; // assume current century
    } else {
      year = seasonYear || new Date().getFullYear();
    }
  }

  // Round
  let round = null;
  if (/1st|first|round\s*1/.test(lower)) round = 1;
  else if (/2nd|second|round\s*2/.test(lower)) round = 2;

  // Pick number (optional)
  const pickMatch = lower.match(/pick\s*(\d{1,2})/);
  const pickNum = pickMatch ? Number(pickMatch[1]) : null;

  if (!round) return null;
  const value = computePickValue2k(year, round, pickNum, seasonYear, protection);
  const protectionText = protection
    ? (protection === 'lottery' ? ' (lottery protected)' : ` (top ${protection.replace('top','')} protected)`)
    : '';
  const labelOut = (pickNum
    ? `${year} Round ${round} Pick ${pickNum}`
    : `${year} Round ${round}`) + protectionText;
  return { year, round, pickNum, value, label: labelOut, protection };
}

export function deriveAge(player) {
  // If birthdate exists, compute as of Oct 20 of current season year (season 1 -> 2025)
  try {
    if (player.birthdate) {
      let seasonNo = 1;
      try {
        const seasonPath = path.join(process.cwd(), 'data', 'season.json');
        if (fs.existsSync(seasonPath)) {
          const s = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
          if (s.seasonNo) seasonNo = Number(s.seasonNo);
        }
      } catch { /* ignore */ }
      // Base start date is Oct 20, 2025 for season 1; seasonNo advances the year
      const seasonYear = 2024 + seasonNo; // season 1 -> 2025, season 2 -> 2026, etc.
      const ref = new Date(`${seasonYear}-10-20`);
      const birth = new Date(player.birthdate);
      let age = ref.getFullYear() - birth.getFullYear();
      if (ref < new Date(ref.getFullYear(), birth.getMonth(), birth.getDate())) age--;
      return age;
    }
  } catch { /* ignore */ }
  const ageField = player.age ?? player.Age;
  return Number(ageField) || (Number(player.yearsInNBA ?? player.YearsInNBA) + 19) || 24;
}

export function deriveContract(player) {
  const years = Array.isArray(player.contractYears) ? player.contractYears : [];
  const salaryStr = years[0]?.salary || player.salary || player.Salary || '';
  const salary = Number(String(salaryStr).replace(/[^0-9.]/g, '')) || 0;
  const yearsLeft = years.length || Number(player.contractYearsLeft || player.ContractYearsLeft || 0) || 1;
  return { salary, yearsLeft };
}

// Resolve fuzzy team labels (nicknames, coach role names) to roster file names
export function resolveTeamNameForRoster(name) {
  const input = (name || '').replace(/coach$/i, '').trim();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  let teams = [];
  try {
    teams = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'teams.json'), 'utf8'));
  } catch { /* ignore */ }

  // direct nickname map
  const aliases = {
    'cavs': 'Cleveland Cavaliers',
    'cavaliers': 'Cleveland Cavaliers',
    'lac': 'Los Angeles Clippers',
    'laclippers': 'Los Angeles Clippers',
    'laclips': 'Los Angeles Clippers',
    'losangelesclippers': 'Los Angeles Clippers',
    'sixers': 'Philadelphia 76ers',
    '76ers': 'Philadelphia 76ers',
    'dubs': 'Golden State Warriors',
    'warriors': 'Golden State Warriors',
    'pels': 'New Orleans Pelicans',
    'peli': 'New Orleans Pelicans',
    'blazers': 'Portland Trail Blazers',
    'clips': 'Los Angeles Clippers',
    'lakers': 'Los Angeles Lakers',
    'knicks': 'New York Knicks',
    'nets': 'Brooklyn Nets',
    'mavs': 'Dallas Mavericks',
    'wolves': 'Minnesota Timberwolves',
    'twolves': 'Minnesota Timberwolves',
    'spurs': 'San Antonio Spurs',
    'suns': 'Phoenix Suns',
    'thunder': 'Oklahoma City Thunder',
    'wiz': 'Washington Wizards',
    'bucks': 'Milwaukee Bucks',
    'bulls': 'Chicago Bulls',
    'heat': 'Miami Heat',
    'magic': 'Orlando Magic',
    'pistons': 'Detroit Pistons',
    'hornets': 'Charlotte Hornets',
    'hawks': 'Atlanta Hawks',
    'jazz': 'Utah Jazz',
    'kings': 'Sacramento Kings',
    'raptors': 'Toronto Raptors',
    'rockets': 'Houston Rockets',
    'pacers': 'Indiana Pacers',
    'grizzlies': 'Memphis Grizzlies',
    'nuggets': 'Denver Nuggets',
    'pelicans': 'New Orleans Pelicans',
    'celtics': 'Boston Celtics',
  };
  const nick = aliases[norm(input)];
  if (nick) return nick;

  const candidates = teams.length ? teams : [];
  const match = candidates.find(t => {
    const names = [
      t.name,
      t.abbreviation,
      t.nickname,
      t.city,
    ].filter(Boolean).map(norm);
    const n = norm(input);
    return names.some(v => v === n || v.includes(n) || n.includes(v));
  });
  return match?.name || input;
}

// Convert a human team string ("Milwaukee Bucks") into plausible file name variants.
function rosterFileCandidates(team) {
  const cleaned = normalizeName(team);
  const variants = new Set();
  const add = (s) => variants.add(s.replace(/_+/g, '_').replace(/^_+|_+$/g, ''));
  add(cleaned);
  add(cleaned.replace(/\s+/g, '_'));
  add(cleaned.replace(/[^A-Za-z0-9]+/g, '_'));
  add(cleaned.replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '_'));
  return [...variants].filter(Boolean);
}

export function readRoster(team) {
  const rostersDirs = [
    path.join(process.cwd(), 'data', '2k', 'teams_rosters'),
    path.join(process.cwd(), 'teams_rosters'),
    path.join(process.cwd(), 'data', 'teams_rosters')
  ];

  const candidates = rosterFileCandidates(team).map(name => `${name}.json`);

  for (const dir of rostersDirs) {
    if (!fs.existsSync(dir)) continue;

    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) {
        try {
          return JSON.parse(fs.readFileSync(full, 'utf-8'));
        } catch {
          return [];
        }
      }
    }

    // Fallback: case-insensitive scan within this dir
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const lower = candidates.map(c => c.toLowerCase());
      const match = files.find(f => lower.includes(f.toLowerCase()));
      if (match) {
        return JSON.parse(fs.readFileSync(path.join(dir, match), 'utf-8'));
      }
    } catch {
      // ignore and try next dir
    }
  }

  return [];
}

// Ensure pick entries have a fixed value; convert strings to {pick, value}
export function ensurePickValues(roster) {
  if (!roster || typeof roster !== 'object') return roster;
  const seasonYear = (() => {
    try {
      const seasonPath = path.join(process.cwd(), 'data', 'season.json');
      if (fs.existsSync(seasonPath)) {
        const s = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
        if (s.seasonYear) return Number(s.seasonYear);
        if (s.seasonNo) return 2025 + Number(s.seasonNo); // season 1 => 2026
      }
    } catch { /* ignore */ }
    return new Date().getFullYear();
  })();

  const picksArr = Array.isArray(roster.picks) ? roster.picks : [];
  const normalizePickObj = (p) => {
    if (typeof p === 'object' && p.pick && p.value != null) return p;
    const pickStr = typeof p === 'string' ? p : p?.pick || '';
    if (!pickStr) return p;
    const lower = pickStr.toLowerCase();
    const year = Number((lower.match(/(20\d{2})/) || [])[1]);
    const round = /1st|round 1/.test(lower) ? 1 : /2nd|round 2/.test(lower) ? 2 : null;
    const prot = (() => {
      if (/lottery/.test(lower)) return 'lottery';
      if (/top\s*10/.test(lower)) return 'top 10';
      if (/top\s*5/.test(lower)) return 'top 5';
      if (/top\s*3/.test(lower)) return 'top 3';
      return null;
    })();
    const val = round ? computePickValue2k(year || seasonYear, round, null, seasonYear, prot) : 0;
    return { pick: pickStr, value: val };
  };
  roster.picks = picksArr.map(normalizePickObj);
  return roster;
}

export function saveRoster(team, roster) {
  const targets = [
    path.join(process.cwd(), 'data', '2k', 'teams_rosters', `${team}.json`),
    path.join(process.cwd(), 'data', 'teams_rosters', `${team}.json`)
  ];
  // Save to first available directory (preferring 2k path) and ensure dir exists
  for (const file of targets) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(roster, null, 2));
      return true;
    } catch {
      // try next target
    }
  }
  return false;
}

export function upsertPlayer(roster, player) {
  const existingIndex = roster.findIndex(p => p.id === player.id || normalizeName(p.name) === normalizeName(player.name));
  if (existingIndex >= 0) {
    roster[existingIndex] = { ...roster[existingIndex], ...player };
  } else {
    roster.push(player);
  }
  return roster;
}

// Remove a player from all other rosters (fuzzy by name); returns true if removed
export function removePlayerFromOtherRostersFuzzy(playerName) {
  const rosterDirs = [
    path.join(process.cwd(), 'data', '2k', 'teams_rosters'),
    path.join(process.cwd(), 'data', 'teams_rosters'),
  ];

  let removed = false;

  for (const dir of rosterDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const roster = JSON.parse(fs.readFileSync(full, 'utf-8'));
        const arr = Array.isArray(roster) ? roster : Array.isArray(roster?.players) ? roster.players : null;
        if (!Array.isArray(arr)) continue;

        const idx = arr.findIndex(p => normalizeName(p.name) === normalizeName(playerName));
        if (idx >= 0) {
          arr.splice(idx, 1);
          if (Array.isArray(roster?.players)) {
            roster.players = arr;
            fs.writeFileSync(full, JSON.stringify(roster, null, 2));
          } else {
            fs.writeFileSync(full, JSON.stringify(arr, null, 2));
          }
          removed = true;
        }
      } catch (e) {
        console.error(`[rosterUtils] Failed to update ${file}:`, e);
      }
    }
  }

  return removed;
}
