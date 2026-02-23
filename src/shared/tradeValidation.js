// NBA trade validation for 2025-26 season.
// Assumptions: we only have player salaries; we ignore exceptions/bird/apron mechanics.
// We apply cap space first; if a team was below the cap pre-trade, they can't use matching to cross it.

export const SALARY_CAP = 154_647_000;
export const LUXURY_TAX = 187_895_000;
export const FIRST_APRON = 195_945_000;
export const SECOND_APRON = 207_824_000;

function matchingMaxIncoming(outgoing) {
  if (outgoing <= 7_500_000) return outgoing * 2.0 + 250_000;
  if (outgoing <= 29_000_000) return outgoing + 7_500_000;
  return outgoing * 1.25 + 250_000;
}

function buildTeamResult(payrollBefore, outgoing, incoming) {
  const capSpace = Math.max(0, SALARY_CAP - payrollBefore);
  const overCapBefore = payrollBefore >= SALARY_CAP;

  let maxAllowed;
  if (!overCapBefore) {
    // Under cap before trade: can only add outgoing + remaining cap space
    maxAllowed = outgoing + capSpace;
  } else {
    // At/over cap: use matching tiers
    maxAllowed = matchingMaxIncoming(outgoing);
  }

  const payrollAfter = payrollBefore - outgoing + incoming;
  const overage = Math.max(0, incoming - maxAllowed);
  const valid = overage <= 0;

  return {
    payrollBefore,
    payrollAfter,
    outgoing,
    incoming,
    capSpace,
    maxAllowed,
    overage,
    valid,
  };
}

export function validateTrade(teamAOutgoing, teamAIncoming, teamBOutgoing, teamBIncoming, teamAPayroll, teamBPayroll) {
  const teamA = buildTeamResult(teamAPayroll, teamAOutgoing, teamAIncoming);
  const teamB = buildTeamResult(teamBPayroll, teamBOutgoing, teamBIncoming);

  return {
    valid: teamA.valid && teamB.valid,
    teamA,
    teamB,
  };
}

export default {
  validateTrade,
  matchingMaxIncoming,
  SALARY_CAP,
  LUXURY_TAX,
  FIRST_APRON,
  SECOND_APRON,
};
