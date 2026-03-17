const COMMAND_DESCRIPTIONS = {
  franchisehub: 'Private front-office briefing with your roster pulse, accountability, and league leverage.',
  gamestrategy: 'Private matchup briefing with weekly edges, tendencies, and paid game-plan intel.',
  draftprimer: 'Private draft-room briefing with targets, pressure points, and class texture.',
  mycommands: 'Show the live Madden command board built for your role.',
  tradeblock: 'Run your trade block and keep your roster market visible.',
  roster: 'Open a full team roster card with contract, dev, and value context.',
  playersearch: 'Pull a live player card from the latest synced Madden roster.',
  recruiting: 'Open the private recruiting board and scan the top names quickly.',
  streamlink: 'Post your game stream with a live matchup hook and watch-window bio.',
  mockdraft: 'Show the current mock draft board using the live class and order.',
  myscouts: 'Open your private scouting board and move through the names you have touched.',
  schedule: 'Browse the live league schedule and jump into the current slate quickly.',
  pickvalue: 'Open the draft pick value board and scan the market fast.',
  scout: 'Work the draft board with private scouting pulls and team-aware filters.',
  bigboard: 'Browse the live draft class board with a cleaner league-wide view.',
};

const TITLES = {
  coachCommands: 'Madden Coach Command Center',
  staffCommands: 'Madden Staff Command Center',
  lightHub: 'LEAGUEbuddy — League Desk',
};

const FOOTERS = {
  coachOnly: 'Coach-facing board',
  staffOnly: 'Staff-facing board',
  privateLeagueHub: 'Private league desk',
  privateFranchiseHub: 'Private franchise briefing',
  strategy: 'Built from live weekly stats, roster state, injuries, standings, and matchup data.',
  roster: 'Live roster card',
  mockdraft: 'Live board, live order, live class',
};

export function coachCommandDescription(key, fallback = 'Coach-facing command.') {
  return COMMAND_DESCRIPTIONS[key] || fallback;
}

export function coachVoiceTitle(key, fallback = '') {
  return TITLES[key] || fallback;
}

export function coachVoiceFooter(key, fallback = '') {
  return FOOTERS[key] || fallback;
}

export function coachPanelIntro(panel, options = {}) {
  const team = options.teamName || 'your team';
  if (panel === 'lightHub') {
    return 'You are outside the coach lane right now, but you can still track the league board and play the sportsbook angle.';
  }
  if (panel === 'franchiseHub') {
    return '';
  }
  if (panel === 'coachCommands') {
    return 'Everything in your coach lane, cleaned up into one board.';
  }
  if (panel === 'staffCommands') {
    return 'Staff controls, league ops, and maintenance tools in one place.';
  }
  return '';
}

export function coachErrorBlurb(key, fallback = 'The board could not be built right now.') {
  const map = {
    noLeague: 'No Madden league is wired in yet.',
    noSnapshot: 'The current Madden export is not on the board yet.',
    noRecruiting: 'No recruiting board is loaded right now.',
    noTeam: 'Your coach role is not tied cleanly to a Madden team yet.',
  };
  return map[key] || fallback;
}
