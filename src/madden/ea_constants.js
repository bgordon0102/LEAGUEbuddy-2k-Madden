// Minimal constants extracted from Snallabot (Madden 25)
export const AUTH_SOURCE = 317239;
export const CLIENT_SECRET = "wfGAWnrxLroZOwwELYA2ZrAuaycuF2WDb00zOLv48Sb79viJDGlyD6OyK8pM5eIiv_20240731135155";
// Our local callback (served by auth_server). Override with EA_REDIRECT_URL if needed.
export const APP_REDIRECT_URL = process.env.EA_REDIRECT_URL || "http://localhost:4001/madden/callback";
// EA expects this redirect in the auth URL
export const REDIRECT_URL = APP_REDIRECT_URL;
export const CLIENT_ID = "MCA_25_COMP_APP";
export const MACHINE_KEY = "444d362e8e067fe2";

export const EA_LOGIN_URL = `https://accounts.ea.com/connect/auth?hide_create=true&release_type=prod&response_type=code&redirect_uri=${REDIRECT_URL}&client_id=${CLIENT_ID}&machineProfileKey=${MACHINE_KEY}&authentication_source=${AUTH_SOURCE}`;

// Madden 26 (release year 2026) EA service identifiers
export const TWO_DIGIT_YEAR = "26";
export const YEAR = "2026";

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
  ps5: `madden-${a}-ps5-gen5`,
  xbsx: `madden-${a}-xbsx-gen5`,
  stadia: `madden-${a}-stadia`,
}))(YEAR);

export const BLAZE_PRODUCT_NAME = ((a) => ({
  xone: `madden-${a}-xone-mca`,
  ps4: `madden-${a}-ps4-mca`,
  pc: `madden-${a}-pc-mca`,
  ps5: `madden-${a}-ps5-gen5-mca`,
  xbsx: `madden-${a}-xbsx-gen5-mca`,
  stadia: `madden-${a}-stadia-mca`,
}))(YEAR);

export const LeagueData = {
  TEAMS: "CareerMode_GetLeagueTeamsExport",
  STANDINGS: "CareerMode_GetStandingsExport",
  WEEKLY_SCHEDULE: "CareerMode_GetWeeklySchedulesExport",
};

export const Stage = {
  PRESEASON: 0,
  SEASON: 1,
};
