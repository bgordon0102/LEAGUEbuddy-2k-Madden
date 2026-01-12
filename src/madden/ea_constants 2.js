// Minimal constants extracted from Snallabot (Madden 26)
export const AUTH_SOURCE = 317239;
export const CLIENT_SECRET = "teJpJ9cSXFqZAuKNW8IuHpy8D4dwWPoVrPoek38iCnrGbrUSfjqnHMBAv8iCVjeSm_20250910175618";
// Our local callback (served by auth_server). Override with EA_REDIRECT_URL if needed.
export const APP_REDIRECT_URL = process.env.EA_REDIRECT_URL || "http://localhost:4001/madden/callback";
// EA expects this redirect in the auth URL
export const REDIRECT_URL = APP_REDIRECT_URL;
export const CLIENT_ID = "MCA_26_COMP_APP";
export const MACHINE_KEY = "444d362e8e067fe2";

export const EA_LOGIN_URL = `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}`;

// Madden 26 (release year 2026) EA service identifiers
export const TWO_DIGIT_YEAR = "26";
export const YEAR = "2026";

// Entitlement helpers (mirrored from Snallabot dashboard)
export const VALID_ENTITLEMENTS = ((a) => ({
  xone: `MADDEN_${a}XONE`,
  ps4: `MADDEN_${a}PS4`,
  pc: `MADDEN_${a}PC`,
  ps5: `MADDEN_${a}PS5`,
  xbsx: `MADDEN_${a}XBSX`,
  stadia: `MADDEN_${a}SDA`,
}))(TWO_DIGIT_YEAR);

export const ENTITLEMENT_TO_SYSTEM = ((a) => ({
  [`MADDEN_${a}XONE`]: "xone",
  [`MADDEN_${a}PS4`]: "ps4",
  [`MADDEN_${a}PC`]: "pc",
  [`MADDEN_${a}PS5`]: "ps5",
  [`MADDEN_${a}XBSX`]: "xbsx",
  [`MADDEN_${a}SDA`]: "stadia",
}))(TWO_DIGIT_YEAR);

export const ENTITLEMENT_TO_VALID_NAMESPACE = ((a) => ({
  [`MADDEN_${a}XONE`]: ["xbox"],
  [`MADDEN_${a}PS4`]: ["ps3", "psn"],
  [`MADDEN_${a}PC`]: ["cem_ea_id"],
  [`MADDEN_${a}PS5`]: ["ps3", "psn"],
  [`MADDEN_${a}XBSX`]: ["xbox"],
  [`MADDEN_${a}SDA`]: ["stadia"],
}))(TWO_DIGIT_YEAR);

export const ConsoleOverride = {
  NONE: "Default",
  XBOX_ONE: "Xbox One",
  PS4: "PS4",
  PC: "PC",
  PS5: "PS5",
  XBOX_X: "XBOX Series X",
  STADIA: "Stadia",
};

export const CONSOLE_OVERRIDE_TO_ENTITLEMENT = ((a) => ({
  [ConsoleOverride.XBOX_ONE]: `MADDEN_${a}XONE`,
  [ConsoleOverride.PS4]: `MADDEN_${a}PS4`,
  [ConsoleOverride.PC]: `MADDEN_${a}PC`,
  [ConsoleOverride.PS5]: `MADDEN_${a}PS5`,
  [ConsoleOverride.XBOX_X]: `MADDEN_${a}XBSX`,
  [ConsoleOverride.STADIA]: `MADDEN_${a}SDA`,
}))(TWO_DIGIT_YEAR);

export const CONSOLE_OVERRIDE_TO_VALID_NAMESPACE = {
  [ConsoleOverride.XBOX_ONE]: ["xbox"],
  [ConsoleOverride.PS4]: ["ps3", "psn"],
  [ConsoleOverride.PC]: ["cem_ea_id"],
  [ConsoleOverride.PS5]: ["ps3", "psn"],
  [ConsoleOverride.XBOX_X]: ["xbox"],
  [ConsoleOverride.STADIA]: ["stadia"],
};

export const SystemConsole = {
  XBOX_ONE: "xone",
  PS4: "ps4",
  PC: "pc",
  PS5: "ps5",
  XBOX_X: "xbsx",
  STADIA: "stadia",
};

// Gen-specific naming (Snallabot pattern: add -gen5 for ps5/xbsx)
export const BLAZE_SERVICE = ((a) => ({
  xone: `madden-${a}-xone`,
  ps4: `madden-${a}-ps4`,
  pc: `madden-${a}-pc`,
  ps5: `madden-${a}-ps5`,
  xbsx: `madden-${a}-xbsx`,
  stadia: `madden-${a}-stadia`,
}))(YEAR);

export const BLAZE_PRODUCT_NAME = ((a) => ({
  xone: `madden-${a}-xone-mca`,
  ps4: `madden-${a}-ps4-mca`,
  pc: `madden-${a}-pc-mca`,
  ps5: `madden-${a}-ps5-mca`,
  xbsx: `madden-${a}-xbsx-mca`,
  stadia: `madden-${a}-stadia-mca`,
}))(YEAR);

// Some EA deployments still use non-gen suffixes; provide both to retry on 404.
function buildVariantsForYear(consoleKey, yearStr) {
  const variants = [];
  const base = `madden-${yearStr}-${consoleKey}`;
  const gen5 = (consoleKey === 'ps5' || consoleKey === 'xbsx') ? `madden-${yearStr}-${consoleKey}-gen5` : null;

  // Default gen5 + mca, then non-mca
  if (gen5) variants.push({ service: gen5, product: `${gen5}-mca` });
  if (gen5) variants.push({ service: gen5, product: base });

  // Base service with mca/non-mca
  variants.push({ service: base, product: `${base}-mca` });
  variants.push({ service: base, product: base });

  return variants;
}

export function getServiceVariantsForConsole(consoleKey) {
  // Force PS5 to known Madden 25/26 endpoints to avoid noisy 404s
  if (consoleKey === 'ps5') {
    const y = YEAR;
    const base = `madden-${y}-ps5`;
    const gen5 = `madden-${y}-ps5-gen5`;
    return [
      { service: gen5, product: `${gen5}-mca` },
      { service: gen5, product: gen5 },
      { service: base, product: `${base}-mca` },
      { service: base, product: base },
    ];
  }

  // Include current YEAR, two-digit YEAR, and a legacy fallback of YEAR-1 and its two-digit form.
  const numericYear = Number(YEAR);
  const legacyYear = Number.isFinite(numericYear) ? numericYear - 1 : null;
  const legacyTwoDigit = legacyYear ? String(legacyYear).slice(-2) : null;
  const yearCandidates = [YEAR, TWO_DIGIT_YEAR, legacyYear, legacyTwoDigit].filter(Boolean);
  const seen = new Set();
  const variants = [];

  for (const y of yearCandidates) {
    for (const v of buildVariantsForYear(consoleKey, y)) {
      const key = `${v.service}|${v.product}`;
      if (!seen.has(key) && v.service && v.product) {
        seen.add(key);
        variants.push(v);
      }
    }
  }

  return variants;
}

export const LeagueData = {
  TEAMS: "CareerMode_GetLeagueTeamsExport",
  STANDINGS: "CareerMode_GetStandingsExport",
  WEEKLY_SCHEDULE: "CareerMode_GetWeeklySchedulesExport",
  TEAM_ROSTER: "CareerMode_GetTeamRostersExport",
  RUSHING_STATS: "CareerMode_GetWeeklyRushingStatsExport",
  TEAM_STATS: "CareerMode_GetWeeklyTeamStatsExport",
  PUNTING_STATS: "CareerMode_GetWeeklyPuntingStatsExport",
  RECEIVING_STATS: "CareerMode_GetWeeklyReceivingStatsExport",
  DEFENSIVE_STATS: "CareerMode_GetWeeklyDefensiveStatsExport",
  KICKING_STATS: "CareerMode_GetWeeklyKickingStatsExport",
  PASSING_STATS: "CareerMode_GetWeeklyPassingStatsExport",
};

export const Stage = {
  PRESEASON: 0,
  SEASON: 1,
};
