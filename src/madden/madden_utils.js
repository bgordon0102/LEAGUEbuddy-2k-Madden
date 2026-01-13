// Extracted from Snallabot's madden_league_types (getMessageForWeek variants)
export const MADDEN_SEASON = 2026;

// stage: 0 = preseason, 1 = regular/post, 2 = playoff alt stages; offSeasonStage > 0 means offseason
export function getMessageForWeek(week, stage = 1, offSeasonStage = 0) {
  if (offSeasonStage && offSeasonStage > 0) {
    return `Offseason Stage ${offSeasonStage}`;
  }
  const wk = Number(week ?? 0);
  const st = Number(stage ?? 1);
  if (st === 0) {
    return `Preseason Week ${Math.max(1, wk)}`;
  }
  if (wk >= 1 && wk <= 18) return `Week ${wk}`;
  if (wk === 19) return "Wildcard Round";
  if (wk === 20) return "Divisional Round";
  if (wk === 21) return "Conference Championship Round";
  if (wk === 22) return "Super Bowl Bye";
  if (wk === 23) return "Super Bowl";
  return `Week ${wk}`;
}

export function getMessageForWeekShortened(week) {
  if (week < 1 || week > 23) {
    throw new Error("Invalid week number. Valid weeks are week 1-18 and for playoffs: Wildcard = 19, Divisional = 20, Conference Championship = 21, Super Bowl = 23");
  }
  if (week <= 18) return `Wk ${week}`;
  if (week === 19) return "Wildcard";
  if (week === 20) return "Divisional";
  if (week === 21) return "Conference Championship";
  if (week === 22) return "SB Bye";
  if (week === 23) return "Super Bowl";
  throw new Error("Unknown week " + week);
}
