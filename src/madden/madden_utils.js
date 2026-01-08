// Extracted from Snallabot's madden_league_types (getMessageForWeek variants)
export const MADDEN_SEASON = 2026;

export function getMessageForWeek(week) {
  if (week < 1 || week > 23 || week === 22) {
    throw new Error("Invalid week number. Valid weeks are week 1-18 and for playoffs: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23");
  }
  if (week <= 18) return `Week ${week}`;
  if (week === 19) return "Wildcard Round";
  if (week === 20) return "Divisional Round";
  if (week === 21) return "Conference Championship Round";
  if (week === 23) return "Super Bowl";
  throw new Error("Unknown week " + week);
}

export function getMessageForWeekShortened(week) {
  if (week < 1 || week > 23 || week === 22) {
    throw new Error("Invalid week number. Valid weeks are week 1-18 and for playoffs: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23");
  }
  if (week <= 18) return `Wk ${week}`;
  if (week === 19) return "Wildcard";
  if (week === 20) return "Divisional";
  if (week === 21) return "Conference Championship";
  if (week === 23) return "Super Bowl";
  throw new Error("Unknown week " + week);
}
