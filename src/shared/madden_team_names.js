export function getFullTeamName(team = {}, fallback = 'Team') {
  const city = String(team?.cityName || '').trim();
  const mascot = String(team?.displayName || team?.nickName || team?.teamName || '').trim();
  const full = [city, mascot].filter(Boolean).join(' ').trim();
  return full || mascot || city || fallback;
}

export function getFullTeamNameFromParts(cityName = '', displayName = '', nickName = '', fallback = 'Team') {
  const city = String(cityName || '').trim();
  const mascot = String(displayName || nickName || '').trim();
  const full = [city, mascot].filter(Boolean).join(' ').trim();
  return full || mascot || city || fallback;
}
