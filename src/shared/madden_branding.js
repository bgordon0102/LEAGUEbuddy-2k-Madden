export const LEAGUEBUDDY_EMOJI_ID = '1428128921056051261';
export const LEAGUEBUDDY_EMOJI = `<:LEAGUEbuddy:${LEAGUEBUDDY_EMOJI_ID}>`;

export function brandTitle(title = '') {
  return `${LEAGUEBUDDY_EMOJI} ${String(title || '').trim()}`.trim();
}

export function brandText(text = 'LEAGUEbuddy') {
  return `${LEAGUEBUDDY_EMOJI} ${String(text || '').trim()}`.trim();
}
