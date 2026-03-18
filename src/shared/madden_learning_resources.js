import fs from 'fs';
import path from 'path';

function hashSeed(...values) {
  const text = values.map((value) => String(value || '')).join('|');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return Math.abs(hash);
}

const RAW_RESOURCES = [
  { lane: 'offense', tags: ['slot', 'inside', 'separator'], label: 'Film Room: slot cross / inside separator', url: 'https://youtu.be/RcdTJQyplw8', source: 'Huddle.gg / YouTube' },
  { lane: 'offense', tags: ['outside', 'flood', 'cover3'], label: 'Film Room: Flood concept vs Cover 3', url: 'https://youtu.be/x3YgSXUCq-w', source: 'MUT.GG / YouTube' },
  { lane: 'offense', tags: ['box', 'rb', 'angle', 'texas'], label: 'Film Room: RB angle / cross-flat concept', url: 'https://youtu.be/A6V0zSVINb4', source: 'Madden School / YouTube' },
  { lane: 'offense', tags: ['coverage', 'dagger', 'middle'], label: 'Film Room: Dagger concept', url: 'https://youtu.be/ovaUis1SyII', source: 'Madden School / YouTube' },
  { lane: 'offense', tags: ['pressure', 'rpo', 'midblitz'], label: 'Film Room: RPO answer vs Mid Blitz', url: 'https://youtu.be/gdGK1jdCs1k', source: 'MUT.GG / YouTube' },
  { lane: 'offense', tags: ['balanced', 'y-post'], label: 'Film Room: Y-Post vs multiple coverages', url: 'https://youtu.be/VnSYjafXeEk', source: 'Madden School / YouTube' },
  { lane: 'offense', tags: ['general', 'offense', 'scheme'], label: 'Resource: Madden 26 offensive tips hub', url: 'https://www.madden-school.com/category/madden-26-offensive-tips/', source: 'Madden School' },
  { lane: 'offense', tags: ['outside', 'deep', 'cover3'], label: 'Resource: how to beat Cover 3 in Madden', url: 'https://www.mut.gg/news/how-to-beat-cover-3-in-madden-25/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['pressure', 'blitz', 'hot'], label: 'Resource: how to beat Mid Blitz in Madden 26', url: 'https://www.mut.gg/news/how-to-beat-mid-blitz-in-madden-26/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['slot', 'spacing', 'read'], label: 'Resource: reading the defense before you attack space', url: 'https://www.madden-school.com/reading-the-defense/', source: 'Madden School' },
  { lane: 'offense', tags: ['outside', 'trips', 'formation'], label: 'Search: Madden 26 trips / bunch beaters', url: 'https://www.youtube.com/results?search_query=madden+26+trips+bunch+beaters', source: 'YouTube search' },
  { lane: 'offense', tags: ['slot', 'pivot', 'choice'], label: 'Search: Madden 26 option / pivot / choice routes', url: 'https://www.youtube.com/results?search_query=madden+26+option+pivot+choice+routes', source: 'YouTube search' },
  { lane: 'offense', tags: ['outside', 'comeback', 'fade'], label: 'Search: Madden 26 outside release / comeback / fade', url: 'https://www.youtube.com/results?search_query=madden+26+comeback+fade+offense', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'stretch', 'widezone'], label: 'Search: Madden 26 outside zone / stretch', url: 'https://www.youtube.com/results?search_query=madden+26+outside+zone+stretch', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'texas', 'hb'], label: 'Search: Madden 26 Texas route / HB option', url: 'https://www.youtube.com/results?search_query=madden+26+texas+route+hb+option', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'mesh', 'zone'], label: 'Search: Madden 26 mesh concept', url: 'https://www.youtube.com/results?search_query=madden+26+mesh+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'spacing', 'underneath'], label: 'Search: Madden 26 spacing concept', url: 'https://www.youtube.com/results?search_query=madden+26+spacing+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'drive', 'dig'], label: 'Search: Madden 26 drive concept', url: 'https://www.youtube.com/results?search_query=madden+26+drive+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['balanced', 'playaction', 'crossers'], label: 'Search: Madden 26 play-action crossers', url: 'https://www.youtube.com/results?search_query=madden+26+play+action+crossers', source: 'YouTube search' },
  { lane: 'offense', tags: ['balanced', 'protection', 'idthemic'], label: 'Search: Madden 26 pass protection / slide / ID the Mike', url: 'https://www.youtube.com/results?search_query=madden+26+pass+protection+slide+ID+the+Mike', source: 'YouTube search' },
  { lane: 'offense', tags: ['slot', 'mesh', 'separator'], label: 'Search: Madden 26 mesh from the slot', url: 'https://www.youtube.com/results?search_query=madden+26+mesh+slot', source: 'YouTube search' },
  { lane: 'offense', tags: ['slot', 'seam', 'inside'], label: 'Search: Madden 26 slot seam beater', url: 'https://www.youtube.com/results?search_query=madden+26+slot+seam+beater', source: 'YouTube search' },
  { lane: 'offense', tags: ['slot', 'whip', 'pivot'], label: 'Search: Madden 26 whip and pivot routes', url: 'https://www.youtube.com/results?search_query=madden+26+whip+pivot+routes', source: 'YouTube search' },
  { lane: 'offense', tags: ['slot', 'choice', 'short'], label: 'Search: Madden 26 choice routes', url: 'https://www.youtube.com/results?search_query=madden+26+choice+routes', source: 'YouTube search' },
  { lane: 'offense', tags: ['outside', 'flood', 'sail'], label: 'Search: Madden 26 sail concept', url: 'https://www.youtube.com/results?search_query=madden+26+sail+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['outside', 'deep', 'go'], label: 'Search: Madden 26 go ball setup', url: 'https://www.youtube.com/results?search_query=madden+26+go+ball+setup', source: 'YouTube search' },
  { lane: 'offense', tags: ['outside', 'stack', 'bunch'], label: 'Search: Madden 26 bunch outside beater', url: 'https://www.youtube.com/results?search_query=madden+26+bunch+outside+beater', source: 'YouTube search' },
  { lane: 'offense', tags: ['outside', 'press', 'release'], label: 'Search: Madden 26 beat press coverage', url: 'https://www.youtube.com/results?search_query=madden+26+beat+press+coverage', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'stretch', 'edge'], label: 'Search: Madden 26 edge run game', url: 'https://www.youtube.com/results?search_query=madden+26+edge+run+game', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'toss', 'perimeter'], label: 'Search: Madden 26 toss and perimeter runs', url: 'https://www.youtube.com/results?search_query=madden+26+toss+perimeter+runs', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'counter', 'cutback'], label: 'Search: Madden 26 counter run', url: 'https://www.youtube.com/results?search_query=madden+26+counter+run', source: 'YouTube search' },
  { lane: 'offense', tags: ['box', 'splitzone', 'run'], label: 'Search: Madden 26 split zone', url: 'https://www.youtube.com/results?search_query=madden+26+split+zone', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'stick', 'underneath'], label: 'Search: Madden 26 stick concept', url: 'https://www.youtube.com/results?search_query=madden+26+stick+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'levels', 'zone'], label: 'Search: Madden 26 levels concept', url: 'https://www.youtube.com/results?search_query=madden+26+levels+concept', source: 'YouTube search' },
  { lane: 'offense', tags: ['coverage', 'curlflat', 'spacing'], label: 'Search: Madden 26 spacing vs zone', url: 'https://www.youtube.com/results?search_query=madden+26+spacing+vs+zone', source: 'YouTube search' },
  { lane: 'offense', tags: ['balanced', 'bunch', 'scheme'], label: 'Resource: Madden 26 Shotgun Mix playbook hub', url: 'https://www.madden-school.com/playbooks/shotgun-mix/offense/', source: 'Madden School' },
  { lane: 'offense', tags: ['balanced', 'formation', 'scheme'], label: 'Resource: Madden 26 Balanced offense playbook hub', url: 'https://www.madden-school.com/playbooks/balanced/offense/', source: 'Madden School' },
  { lane: 'offense', tags: ['balanced', 'tight', 'scheme'], label: 'Search: Madden 26 Gun Tight Doubles scheme', url: 'https://www.youtube.com/results?search_query=madden+26+gun+tight+doubles+scheme', source: 'YouTube search' },
  { lane: 'offense', tags: ['pressure', 'hot', 'blitz'], label: 'Search: Madden 26 beat blitz offense', url: 'https://www.youtube.com/results?search_query=madden+26+beat+blitz+offense', source: 'YouTube search' },
  { lane: 'offense', tags: ['pressure', 'checkdown', 'quickgame'], label: 'Search: Madden 26 quick game vs pressure', url: 'https://www.youtube.com/results?search_query=madden+26+quick+game+vs+pressure', source: 'YouTube search' },
  { lane: 'offense', tags: ['balanced', 'reddit', 'scheme'], label: 'Community: Madden offense scheme discussion', url: 'https://www.reddit.com/search/?q=madden%2026%20offense%20scheme', source: 'Reddit search' },
  { lane: 'offense', tags: ['howto', 'beginner', 'read'], label: 'How-To: Madden 26 offensive basics', url: 'https://www.youtube.com/results?search_query=madden+26+offensive+basics', source: 'YouTube search' },
  { lane: 'offense', tags: ['howto', 'beginner', 'protection'], label: 'How-To: Madden 26 pass protection basics', url: 'https://www.youtube.com/results?search_query=madden+26+pass+protection+basics', source: 'YouTube search' },
  { lane: 'offense', tags: ['howto', 'beginner', 'read', 'coverage'], label: 'How-To: Madden 26 read coverage', url: 'https://www.youtube.com/results?search_query=madden+26+read+coverage+basics', source: 'YouTube search' },
  { lane: 'offense', tags: ['howto', 'beginner', 'run'], label: 'How-To: Madden 26 run game basics', url: 'https://www.youtube.com/results?search_query=madden+26+run+game+basics', source: 'YouTube search' },

  { lane: 'defense', tags: ['pressure', '4man', 'rush'], label: 'Film Room: easy 4-man pressure setup', url: 'https://youtu.be/quCbw5yb-S4', source: 'Huddle.gg / YouTube' },
  { lane: 'defense', tags: ['slot', 'quarters', 'palms'], label: 'Film Room: Cover 4 Quarters / Palms', url: 'https://youtu.be/40nxauy81B0', source: 'Huddle.gg / YouTube' },
  { lane: 'defense', tags: ['coverage', 'cover3', 'midpoint'], label: 'Film Room: safety midpoint / Cover 3 spacing', url: 'https://youtu.be/YRUoAeBCVw0', source: 'Huddle.gg / YouTube' },
  { lane: 'defense', tags: ['runfit', 'front', 'disguise'], label: 'Film Room: Base Align and disguise rules', url: 'https://youtu.be/8fZqSZHQfyk', source: 'Madden School / YouTube' },
  { lane: 'defense', tags: ['shell', 'coverage', 'rotation'], label: 'Resource: coverage shells and late rotation', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'showblitz', 'mug'], label: 'Resource: how to Show Blitz', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'defense', tags: ['contain', 'scramble', 'qb'], label: 'Resource: how to stop quarterback scrambles', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-stop-quarterback', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'stunt', 'front'], label: 'Resource: how to use stunts', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-stunt', source: 'EA' },
  { lane: 'defense', tags: ['general', 'playbook', 'scheme'], label: 'Resource: top 5 defensive playbooks', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-playbooks', source: 'EA' },
  { lane: 'defense', tags: ['general', 'defense'], label: 'Resource: Madden 26 defensive tips hub', url: 'https://www.madden-school.com/category/madden-26-defensive-tips/', source: 'Madden School' },
  { lane: 'defense', tags: ['outside', 'quarters', 'boundary'], label: 'Search: Madden 26 Quarters outside leverage', url: 'https://www.youtube.com/results?search_query=madden+26+quarters+outside+leverage', source: 'YouTube search' },
  { lane: 'defense', tags: ['quickgame', 'timing', 'coverage', 'hooks', 'flats'], label: 'Search: Madden 26 defend quick game (hooks/flats)', url: 'https://www.youtube.com/results?search_query=madden+26+defend+quick+game+hooks+flats', source: 'YouTube search' },
  { lane: 'defense', tags: ['quickgame', 'stick', 'spacing', 'coverage'], label: 'Search: Madden 26 stop stick / spacing concepts', url: 'https://www.youtube.com/results?search_query=madden+26+stop+stick+spacing+concept', source: 'YouTube search' },
  { lane: 'defense', tags: ['quickgame', 'slants', 'man', 'press'], label: 'Search: Madden 26 stop slants (press/man tips)', url: 'https://www.youtube.com/results?search_query=madden+26+stop+slants+press+man', source: 'YouTube search' },
  { lane: 'defense', tags: ['vertical', 'deep', 'shotplay', 'quarters'], label: 'Search: Madden 26 defend shot plays (Quarters rules)', url: 'https://www.youtube.com/results?search_query=madden+26+defend+shot+plays+quarters+rules', source: 'YouTube search' },
  { lane: 'defense', tags: ['vertical', 'deep', 'shotplay', 'cover9'], label: 'Search: Madden 26 Cover 9 vs deep shots', url: 'https://www.youtube.com/results?search_query=madden+26+cover+9+vs+deep+shots', source: 'YouTube search' },
  { lane: 'defense', tags: ['vertical', 'deep', 'shade', 'leverage'], label: 'Search: Madden 26 outside leverage vs fades/posts', url: 'https://www.youtube.com/results?search_query=madden+26+outside+leverage+vs+fades+posts', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'inside', 'front', 'duo', 'insidezone'], label: 'Search: Madden 26 defend inside zone / duo (run fits)', url: 'https://www.youtube.com/results?search_query=madden+26+defend+inside+zone+duo+run+fits', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'outside', 'stretch', 'widezone', 'edge'], label: 'Search: Madden 26 defend outside zone / stretch (edge fits)', url: 'https://www.youtube.com/results?search_query=madden+26+defend+outside+zone+stretch+edge+fits', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'toss', 'perimeter', 'force'], label: 'Search: Madden 26 defend toss / perimeter runs (force rules)', url: 'https://www.youtube.com/results?search_query=madden+26+defend+toss+perimeter+runs+force+rules', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'counter', 'cutback', 'discipline'], label: 'Search: Madden 26 defend counter / cutbacks', url: 'https://www.youtube.com/results?search_query=madden+26+defend+counter+cutback', source: 'YouTube search' },
  { lane: 'defense', tags: ['slot', 'nickel', 'inside'], label: 'Search: Madden 26 nickel slot defense', url: 'https://www.youtube.com/results?search_query=madden+26+nickel+slot+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'doublemug', 'sim'], label: 'Search: Madden 26 Nickel Double Mug sim pressure', url: 'https://www.youtube.com/results?search_query=madden+26+nickel+double+mug+sim+pressure', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'singlemug', 'sim'], label: 'Search: Madden 26 Nickel Single Mug pressure', url: 'https://www.youtube.com/results?search_query=madden+26+nickel+single+mug+pressure', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'nickelover', 'edgeblitz'], label: 'Search: Madden 26 Nickel Over Edge Blitz 3', url: 'https://www.youtube.com/results?search_query=madden+26+nickel+over+edge+blitz+3', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'doublebracket', 'star'], label: 'Search: Madden 26 Double Bracket defense', url: 'https://www.youtube.com/results?search_query=madden+26+double+bracket+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'cover9', 'twohigh'], label: 'Search: Madden 26 Cover 9 defense', url: 'https://www.youtube.com/results?search_query=madden+26+cover+9+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'basealign', 'box'], label: 'Search: Madden 26 run fits and base align', url: 'https://www.youtube.com/results?search_query=madden+26+run+fits+base+align', source: 'YouTube search' },
  { lane: 'defense', tags: ['contain', 'scramble', 'rushlanes'], label: 'Search: Madden 26 QB contain / rush lanes', url: 'https://www.youtube.com/results?search_query=madden+26+qb+contain+rush+lanes', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'loop', 'sim'], label: 'Search: Madden 26 Blitz Loop 3', url: 'https://www.youtube.com/results?search_query=madden+26+blitz+loop+3', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'fieldsim', 'sim'], label: 'Search: Madden 26 Field Sim 3', url: 'https://www.youtube.com/results?search_query=madden+26+field+sim+3', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'showss', 'sim'], label: 'Search: Madden 26 Show SS Sim 2', url: 'https://www.youtube.com/results?search_query=madden+26+show+ss+sim+2', source: 'YouTube search' },
  { lane: 'defense', tags: ['pressure', 'crosssim', 'sim'], label: 'Search: Madden 26 Cross Sim 2', url: 'https://www.youtube.com/results?search_query=madden+26+cross+sim+2', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'palms', 'quarters'], label: 'Search: Madden 26 Cover 4 Palms setup', url: 'https://www.youtube.com/results?search_query=madden+26+cover+4+palms+setup', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'quarters', 'patternmatch'], label: 'Search: Madden 26 Quarters pattern match', url: 'https://www.youtube.com/results?search_query=madden+26+quarters+pattern+match', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'cover2man', 'man'], label: 'Search: Madden 26 Cover 2 Man defense', url: 'https://www.youtube.com/results?search_query=madden+26+cover+2+man+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['coverage', 'cover3cloud', 'zone'], label: 'Search: Madden 26 Cover 3 Cloud defense', url: 'https://www.youtube.com/results?search_query=madden+26+cover+3+cloud+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['slot', 'hookcurl', 'inside'], label: 'Search: Madden 26 hook curl defense', url: 'https://www.youtube.com/results?search_query=madden+26+hook+curl+defense', source: 'YouTube search' },
  { lane: 'defense', tags: ['outside', 'deepthird', 'boundary'], label: 'Search: Madden 26 deep third outside leverage', url: 'https://www.youtube.com/results?search_query=madden+26+deep+third+outside+leverage', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'force', 'edge'], label: 'Search: Madden 26 force defender rules', url: 'https://www.youtube.com/results?search_query=madden+26+force+defender+rules', source: 'YouTube search' },
  { lane: 'defense', tags: ['runfit', 'spill', 'front'], label: 'Search: Madden 26 spill and box fits', url: 'https://www.youtube.com/results?search_query=madden+26+spill+box+fits', source: 'YouTube search' },
  { lane: 'defense', tags: ['contain', 'spy', 'mobileqb'], label: 'Search: Madden 26 QB spy mobile QB', url: 'https://www.youtube.com/results?search_query=madden+26+qb+spy+mobile+qb', source: 'YouTube search' },
  { lane: 'defense', tags: ['general', 'reddit', 'defense'], label: 'Community: Madden defense discussion', url: 'https://www.reddit.com/search/?q=madden%2026%20defense%20scheme', source: 'Reddit search' },
  { lane: 'defense', tags: ['general', 'titleupdate', 'coverage'], label: 'Resource: Madden 26 title update coverage notes', url: 'https://www.mut.gg/news/title-update-august-28th-madden-nfl-26/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['general', 'titleupdate', 'xfactor'], label: 'Resource: Madden 26 February gameplay notes', url: 'https://www.mut.gg/news/madden-nfl-26-title-update-february-4th/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['howto', 'beginner', 'coverage'], label: 'How-To: Madden 26 defense basics', url: 'https://www.youtube.com/results?search_query=madden+26+defense+basics', source: 'YouTube search' },
  { lane: 'defense', tags: ['howto', 'beginner', 'user'], label: 'How-To: Madden 26 user defense basics', url: 'https://www.youtube.com/results?search_query=madden+26+user+defense+basics', source: 'YouTube search' },
  { lane: 'defense', tags: ['howto', 'beginner', 'runfit'], label: 'How-To: Madden 26 run defense basics', url: 'https://www.youtube.com/results?search_query=madden+26+run+defense+basics', source: 'YouTube search' },
  { lane: 'defense', tags: ['howto', 'beginner', 'pressure'], label: 'How-To: Madden 26 pass rush basics', url: 'https://www.youtube.com/results?search_query=madden+26+pass+rush+basics', source: 'YouTube search' },

  { lane: 'tendency', tags: ['pass-heavy', 'shells', 'rotation'], label: 'Resource: coverage shells and late rotation', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'tendency', tags: ['run-heavy', 'front', 'basealign'], label: 'Film Room: Base Align and disguise rules', url: 'https://youtu.be/8fZqSZHQfyk', source: 'Madden School / YouTube' },
  { lane: 'tendency', tags: ['balanced', 'read'], label: 'Resource: reading the defense', url: 'https://www.madden-school.com/reading-the-defense/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'showblitz', 'disguise'], label: 'Resource: Show Blitz and changing the picture', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'stunt', 'counter'], label: 'Resource: stunts to change the rush picture', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-stunt', source: 'EA' },
  { lane: 'tendency', tags: ['scramble', 'qb', 'contain'], label: 'Resource: stop quarterback scrambles', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-stop-quarterback', source: 'EA' },
  { lane: 'tendency', tags: ['slot', 'inside', 'read'], label: 'Search: Madden 26 defend slot option routes', url: 'https://www.youtube.com/results?search_query=madden+26+defend+slot+option+routes', source: 'YouTube search' },
  { lane: 'tendency', tags: ['outside', 'boundary', 'coverage'], label: 'Search: Madden 26 defend deep sideline shots', url: 'https://www.youtube.com/results?search_query=madden+26+defend+deep+sideline+shots', source: 'YouTube search' },
  { lane: 'tendency', tags: ['run-heavy', 'alley', 'fit'], label: 'Search: Madden 26 alley fit / force defender', url: 'https://www.youtube.com/results?search_query=madden+26+alley+fit+force+defender', source: 'YouTube search' },
  { lane: 'tendency', tags: ['balanced', 'user', 'defense'], label: 'Search: Madden 26 user defense tips', url: 'https://www.youtube.com/results?search_query=madden+26+user+defense+tips', source: 'YouTube search' },
  { lane: 'tendency', tags: ['pass-heavy', 'quickgame', 'reddit'], label: 'Community: Madden quick-game defense discussion', url: 'https://www.reddit.com/search/?q=madden%2026%20quick%20game%20defense', source: 'Reddit search' },
  { lane: 'tendency', tags: ['pressure', 'sim', 'reddit'], label: 'Community: Madden sim pressure discussion', url: 'https://www.reddit.com/search/?q=madden%2026%20sim%20pressure', source: 'Reddit search' },
  { lane: 'tendency', tags: ['pass-heavy', 'cover3', 'read'], label: 'Resource: how to beat Cover 3 in Madden', url: 'https://www.mut.gg/news/how-to-beat-cover-3-in-madden-25/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['pressure', 'midblitz', 'counter'], label: 'Resource: how to beat Mid Blitz in Madden 26', url: 'https://www.mut.gg/news/how-to-beat-mid-blitz-in-madden-26/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['balanced', 'formation', 'read'], label: 'Resource: Madden 26 offensive playbook hub', url: 'https://www.madden-school.com/playbooks/balanced/offense/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'trips', 'quickgame'], label: 'Search: Madden 26 defend trips formations', url: 'https://www.youtube.com/results?search_query=madden+26+defend+trips+formations', source: 'YouTube search' },
  { lane: 'tendency', tags: ['pass-heavy', 'bunch', 'quickgame'], label: 'Search: Madden 26 defend bunch formations', url: 'https://www.youtube.com/results?search_query=madden+26+defend+bunch+formations', source: 'YouTube search' },
  { lane: 'tendency', tags: ['run-heavy', 'zone', 'fit'], label: 'Search: Madden 26 defend outside zone', url: 'https://www.youtube.com/results?search_query=madden+26+defend+outside+zone', source: 'YouTube search' },
  { lane: 'tendency', tags: ['run-heavy', 'counter', 'fit'], label: 'Search: Madden 26 defend counter run', url: 'https://www.youtube.com/results?search_query=madden+26+defend+counter+run', source: 'YouTube search' },
  { lane: 'tendency', tags: ['pressure', 'showblitz', 'shells'], label: 'Search: Madden 26 disguise coverage shells', url: 'https://www.youtube.com/results?search_query=madden+26+disguise+coverage+shells', source: 'YouTube search' },
  { lane: 'tendency', tags: ['balanced', 'read', 'manzone'], label: 'Search: Madden 26 man vs zone reads', url: 'https://www.youtube.com/results?search_query=madden+26+man+vs+zone+reads', source: 'YouTube search' },
  { lane: 'tendency', tags: ['slot', 'inside', 'quickgame'], label: 'Search: Madden 26 stop slot quick game', url: 'https://www.youtube.com/results?search_query=madden+26+stop+slot+quick+game', source: 'YouTube search' },
  { lane: 'tendency', tags: ['outside', 'boundary', 'vertical'], label: 'Search: Madden 26 stop vertical outside shots', url: 'https://www.youtube.com/results?search_query=madden+26+stop+vertical+outside+shots', source: 'YouTube search' },
  { lane: 'tendency', tags: ['scramble', 'qb', 'spy'], label: 'Search: Madden 26 defend QB scramble tendencies', url: 'https://www.youtube.com/results?search_query=madden+26+defend+qb+scramble+tendencies', source: 'YouTube search' },
  { lane: 'tendency', tags: ['balanced', 'reddit', 'coachdna'], label: 'Community: Madden coach tendency discussion', url: 'https://www.reddit.com/search/?q=madden%2026%20playcalling%20tendency', source: 'Reddit search' },
  { lane: 'tendency', tags: ['howto', 'beginner', 'read'], label: 'How-To: Madden 26 read opponent tendencies', url: 'https://www.youtube.com/results?search_query=madden+26+read+opponent+tendencies', source: 'YouTube search' },
  { lane: 'tendency', tags: ['howto', 'beginner', 'counter'], label: 'How-To: Madden 26 counter playcalling', url: 'https://www.youtube.com/results?search_query=madden+26+counter+playcalling', source: 'YouTube search' },
];

const EXTRA_DIRECT_RESOURCES = [
  { lane: 'offense', tags: ['general', 'offense', 'howto', 'beginner'], label: 'Resource: Madden 26 tips and tricks hub', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub', source: 'EA' },
  { lane: 'offense', tags: ['howto', 'intermediate', 'coverage', 'read'], label: 'Resource: reading the defense before the snap', url: 'https://www.madden-school.com/reading-the-defense/', source: 'Madden School' },
  { lane: 'offense', tags: ['balanced', 'formation', 'scheme', 'howto'], label: 'Resource: Balanced offense playbook hub', url: 'https://www.madden-school.com/playbooks/balanced/offense/', source: 'Madden School' },
  { lane: 'offense', tags: ['trips', 'bunch', 'formation', 'scheme'], label: 'Resource: Shotgun Mix offense playbook hub', url: 'https://www.madden-school.com/playbooks/shotgun-mix/offense/', source: 'Madden School' },
  { lane: 'offense', tags: ['pressure', 'blitz', 'howto', 'counter'], label: 'Resource: beat Mid Blitz in Madden 26', url: 'https://www.mut.gg/news/how-to-beat-mid-blitz-in-madden-26/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['zone', 'cover3', 'howto', 'outside'], label: 'Resource: beat Cover 3 in Madden', url: 'https://www.mut.gg/news/how-to-beat-cover-3-in-madden-25/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['howto', 'beginner', 'scheme', 'general'], label: 'Resource: Madden 26 offensive tips collection', url: 'https://www.madden-school.com/category/madden-26-offensive-tips/', source: 'Madden School' },

  { lane: 'defense', tags: ['general', 'defense', 'howto', 'beginner'], label: 'Resource: Madden 26 tips and tricks hub', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub', source: 'EA' },
  { lane: 'defense', tags: ['coverage', 'shell', 'rotation', 'howto'], label: 'Resource: coverage shells and late rotation', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'showblitz', 'disguise', 'howto'], label: 'Resource: Show Blitz and pre-snap picture', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'defense', tags: ['contain', 'scramble', 'mobileqb', 'howto'], label: 'Resource: stop quarterback scrambles', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-stop-quarterback', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'front', 'stunt', 'howto'], label: 'Resource: use stunts to change the rush picture', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-stunt', source: 'EA' },
  { lane: 'defense', tags: ['howto', 'beginner', 'scheme', 'general'], label: 'Resource: Madden 26 defensive tips collection', url: 'https://www.madden-school.com/category/madden-26-defensive-tips/', source: 'Madden School' },
  { lane: 'defense', tags: ['playbook', 'scheme', 'general', 'intermediate'], label: 'Resource: top 5 defensive playbooks', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-playbooks', source: 'EA' },

  { lane: 'tendency', tags: ['balanced', 'read', 'howto', 'intermediate'], label: 'Resource: reading the defense', url: 'https://www.madden-school.com/reading-the-defense/', source: 'Madden School' },
  { lane: 'tendency', tags: ['shells', 'rotation', 'pass-heavy', 'howto'], label: 'Resource: coverage shells and late rotation', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'showblitz', 'counter', 'howto'], label: 'Resource: Show Blitz and changing the picture', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'tendency', tags: ['scramble', 'qb', 'contain', 'counter'], label: 'Resource: stop quarterback scrambles', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-stop-quarterback', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'midblitz', 'counter', 'howto'], label: 'Resource: beat Mid Blitz in Madden 26', url: 'https://www.mut.gg/news/how-to-beat-mid-blitz-in-madden-26/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['cover3', 'read', 'counter', 'howto'], label: 'Resource: beat Cover 3 in Madden', url: 'https://www.mut.gg/news/how-to-beat-cover-3-in-madden-25/', source: 'MUT.GG' },
];

const MATCHUP_DIRECT_RESOURCES = [
  { lane: 'offense', tags: ['pressure', 'protection', 'hotroute', 'audible', 'customstem', 'counter'], label: 'Resource: audibles, hot routes, and custom stems', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-hot-route-and-audible', source: 'EA' },
  { lane: 'offense', tags: ['coverage', 'read', 'throw', 'timing', 'howto'], label: 'Resource: passing the ball and leading throws', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-pass-the-ball', source: 'EA' },
  { lane: 'offense', tags: ['scramble', 'mobileqb', 'playmaker', 'brokenplay', 'counter'], label: 'Resource: Playmaker mechanic for off-schedule throws', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-playmaker', source: 'EA' },
  { lane: 'offense', tags: ['scramble', 'mobileqb', 'option', 'speedoption', 'qb'], label: 'Resource: QB slide and speed option rules', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-qb-slide', source: 'EA' },
  { lane: 'offense', tags: ['box', 'run', 'space', 'yac', 'ballcarrier'], label: 'Resource: ball carrier moves for space and finish', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-ball-carrier-moves', source: 'EA' },
  { lane: 'offense', tags: ['slot', 'outside', 'catchpoint', 'aggressive', 'possession'], label: 'Resource: catch types and catch-point control', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-catch-the-ball', source: 'EA' },
  { lane: 'offense', tags: ['cover2', 'zone', 'sideline', 'fade', 'counter'], label: 'Resource: how to beat Cover 2 defenses in Madden 26', url: 'https://www.madden-school.com/cover-2/', source: 'Madden School' },
  { lane: 'offense', tags: ['cover3', 'zone', 'flood', 'curlflat', 'counter'], label: 'Resource: how to beat Cover 3 defenses in Madden 26', url: 'https://www.madden-school.com/cover-3/', source: 'Madden School' },
  { lane: 'offense', tags: ['cover4', 'quarters', 'palms', 'match', 'counter'], label: 'Resource: how to beat Cover 4 defenses in Madden 26', url: 'https://www.madden-school.com/cover-4/', source: 'Madden School' },
  { lane: 'offense', tags: ['man', 'press', 'release', 'separator', 'counter'], label: 'Resource: how to beat man coverage in Madden 26', url: 'https://www.madden-school.com/man-to-man/', source: 'Madden School' },
  { lane: 'offense', tags: ['match', 'quarters', 'palms', 'zone', 'counter'], label: 'Resource: how to beat match coverage in Madden 26', url: 'https://www.madden-school.com/match-coverage/', source: 'Madden School' },
  { lane: 'offense', tags: ['cover2', 'fade', 'hotroute', 'outside', 'release'], label: 'Resource: fade hot route vs Cover 2', url: 'https://www.madden-school.com/use-the-fade-hot-route-to-destroy-cover-2-defenses-in-madden-26/', source: 'Madden School' },
  { lane: 'offense', tags: ['bunch', 'cover4', 'cover2', 'deepshot', 'counter'], label: 'Resource: Gun Bunch Bunch Trail vs Cover 2 and Cover 4', url: 'https://www.madden-school.com/madden-18-gun-bunch-bunch-trail/', source: 'Madden School' },
  { lane: 'offense', tags: ['bunch', 'cover3', 'deepshot', 'counter', 'post'], label: 'Resource: Gun Bunch Deep Corner vs Cover 3', url: 'https://www.madden-school.com/madden-18-gun-bunch-deep-corner-cover-3-beater/', source: 'Madden School' },
  { lane: 'offense', tags: ['bunch', 'cover3', 'deepshot', 'counter', 'checkdown'], label: 'Resource: Gun Bunch Str Offset Mtn Deep Post vs Cover 3', url: 'https://www.madden-school.com/an-easy-1-play-touchdown-against-any-cover-3-defense-in-madden-25/', source: 'Madden School' },
  { lane: 'offense', tags: ['bunch', 'man', 'blitz', 'pivot', 'counter'], label: 'Resource: Gun Bunch X Nasty Y Option Pivot vs man blitz', url: 'https://www.madden-school.com/an-easy-way-to-beat-every-man-blitz-in-madden-25-1-play-td/', source: 'Madden School' },
  { lane: 'offense', tags: ['bunch', 'man', 'wheel', 'counter', 'yflex'], label: 'Resource: Gun Bunch Y-Flex Verticals vs man coverage', url: 'https://www.madden-school.com/this-routes-destroys-any-man-coverage-free-ebook-preview/', source: 'Madden School' },
  { lane: 'offense', tags: ['empty', 'bunch', 'cover3', 'sideline', 'counter'], label: 'Resource: Gun Bunch Empty Z Spot vs Cover 3', url: 'https://www.madden-school.com/madden-18-gun-bunch-empty-z-spot-cover-3-beater/', source: 'Madden School' },
  { lane: 'offense', tags: ['empty', 'bunch', 'playaction', 'reads', 'counter'], label: 'Resource: Gun Empty Bunch PA MTN Read', url: 'https://www.madden-school.com/gun-empty-bunch-pa-mtn-read/', source: 'Madden School' },
  { lane: 'offense', tags: ['trips', 'te', 'cover3', 'deepshot', 'counter'], label: 'Resource: Gun Trips TE Flex PA Shot Crossers vs Cover 3', url: 'https://www.madden-school.com/madden-25-cover-3-beating-money-play-gun-trips-te-flex-ebook-preview/', source: 'Madden School' },
  { lane: 'offense', tags: ['trips', 'redzone', 'goalline', 'zone', 'counter'], label: 'Resource: Gun Y Trips Wk GL Fork Zig for red-zone zone coverage', url: 'https://www.madden-school.com/madden-25-red-zone-money-play-that-destroys-zone-defense/', source: 'Madden School' },
  { lane: 'offense', tags: ['tight', 'run-heavy', 'inside', 'blast', 'counter'], label: 'Resource: IForm Tight HB Blast with motion for better run blocking', url: 'https://www.madden-school.com/iform-tight-hb-blast/', source: 'Madden School' },
  { lane: 'offense', tags: ['trio', 'te', 'middle', 'reads', 'counter'], label: 'Resource: Gun Trio TE In quick-read passing concept', url: 'https://www.madden-school.com/free-madden-25-tips-gun-trio-te/', source: 'Madden School' },
  { lane: 'offense', tags: ['trips', 'smash', 'man', 'zone', 'counter'], label: 'Resource: Pistol Trips Smash route stress concept', url: 'https://www.madden-school.com/one-hardest-routes-stop-madden-25/', source: 'Madden School' },
  { lane: 'offense', tags: ['xfactor', 'superstar', 'deepball', 'scramble', 'ballcarrier'], label: 'Resource: top 3 offensive X-Factors', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-3-offensive-x-factors', source: 'EA' },
  { lane: 'offense', tags: ['abilities', 'xfactor', 'deepball', 'singlecoverage', 'aggressive'], label: 'Ability guide: Double Me X-Factor', url: 'https://www.mut.gg/abilities/double-me-xf/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['abilities', 'xfactor', 'scramble', 'mobileqb', 'brokenplay'], label: 'Ability guide: Run & Gun X-Factor', url: 'https://www.mut.gg/abilities/run-gun-xf/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['abilities', 'xfactor', 'ballcarrier', 'space', 'yac'], label: 'Ability guide: Phenom X-Factor', url: 'https://www.mut.gg/abilities/phenom-xf/', source: 'MUT.GG' },
  { lane: 'offense', tags: ['trips', 'bunch', 'tight', 'formations', 'matchup'], label: 'Resource: best offensive playbooks in Madden 26', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-best-offensive-playbooks', source: 'EA' },
  { lane: 'offense', tags: ['pressure', 'cover2', 'cover3', 'cover4', 'slotfade'], label: 'Resource: top 5 offensive tips', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-offensive-tips', source: 'EA' },
  { lane: 'offense', tags: ['general', 'offense', 'scheme', 'formations', 'matchup'], label: 'Resource: Madden 26 offense tips hub', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/beginner-tips-hub/offense-tips-hub', source: 'EA' },
  { lane: 'offense', tags: ['pressure', 'blitz', 'counter', 'quickgame', 'read'], label: 'Resource: top 5 offense tips', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-offensive-tips', source: 'EA' },

  { lane: 'defense', tags: ['coverage', 'hands', 'intercept', 'swat', 'ballskills'], label: 'Resource: intercept and swat timing', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-intercept-the-ball', source: 'EA' },
  { lane: 'defense', tags: ['coverage', 'user', 'switchstick', 'fieldcoverage'], label: 'Resource: Switch Stick for full-field coverage', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-switch-stick', source: 'EA' },
  { lane: 'defense', tags: ['coverage', 'shell', 'customzones', 'routecommit', 'disguise'], label: 'Resource: coverage shells, custom zones, and route commit', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'showblitz', 'disguise', 'mug'], label: 'Resource: how to show blitz', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'stunt', 'front', 'fourman'], label: 'Resource: how to use stunts', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-stunt', source: 'EA' },
  { lane: 'defense', tags: ['pressure', 'passrush', 'blocksteer', 'shed'], label: 'Resource: block steer for pass rush wins', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-block-steer', source: 'EA' },
  { lane: 'defense', tags: ['runfit', 'tackle', 'space', 'openfield', 'finish'], label: 'Resource: tackling and open-field finish', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-tackle', source: 'EA' },
  { lane: 'defense', tags: ['xfactor', 'superstar', 'passrush', 'coverage', 'hybrid'], label: 'Resource: top 3 defensive X-Factors', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-3-defensive-x-factors', source: 'EA' },
  { lane: 'defense', tags: ['abilities', 'xfactor', 'coverage', 'man', 'zone'], label: 'Ability guide: Universal Coverage X-Factor', url: 'https://www.mut.gg/abilities/universal-coverage-xf/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['abilities', 'zone', 'middle', 'ko', 'slot'], label: 'Ability guide: Mid Zone KO', url: 'https://www.mut.gg/abilities/s6-mid-zone-ko/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['abilities', 'zone', 'deep', 'inside', 'ko'], label: 'Ability guide: Deep In Zone KO', url: 'https://www.mut.gg/abilities/deep-in-zone-ko/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['abilities', 'press', 'chuck', 'fatigue', 'slot'], label: 'Ability guide: Chuck Out', url: 'https://www.mut.gg/abilities/chuck-out/', source: 'MUT.GG' },
  { lane: 'defense', tags: ['playbook', 'mug', 'quarters', 'palms', 'pressure'], label: 'Resource: top 5 defensive playbooks', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-playbooks', source: 'EA' },
  { lane: 'defense', tags: ['runfit', 'pressure', 'coverage', 'matchup', 'counter'], label: 'Resource: top 5 defensive tips', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-tips', source: 'EA' },
  { lane: 'defense', tags: ['general', 'defense', 'scheme', 'matchup', 'formations'], label: 'Resource: Madden 26 defense tips hub', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/beginner-tips-hub/defense-tips-hub', source: 'EA' },
  { lane: 'defense', tags: ['runfit', 'pressure', 'coverage', 'general'], label: 'Resource: top 5 defense tips', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-tips', source: 'EA' },
  { lane: 'defense', tags: ['coverage', 'balancing', 'gameplay', 'deepdive'], label: 'Resource: gameplay deep dive and coverage tuning', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/news/madden-26-gridiron-notes-gameplay-deep-dive', source: 'EA' },
  { lane: 'defense', tags: ['runfit', 'counter', 'shotgun', 'box', 'front'], label: 'Resource: stopping Shotgun HB Counter from a 5-2 front', url: 'https://www.madden-school.com/stopping-shotgun-hb-counter-plays-madden-25/', source: 'Madden School' },

  { lane: 'tendency', tags: ['pressure', 'audible', 'counter', 'adjustment', 'customstem'], label: 'Resource: audibles and hot routes vs pressure looks', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-hot-route-and-audible', source: 'EA' },
  { lane: 'tendency', tags: ['pass-heavy', 'timing', 'throw', 'read', 'coverage'], label: 'Resource: passing mechanics vs tight windows', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-pass-the-ball', source: 'EA' },
  { lane: 'tendency', tags: ['scramble', 'mobileqb', 'brokenplay', 'counter'], label: 'Resource: Playmaker for broken-play responses', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-playmaker', source: 'EA' },
  { lane: 'tendency', tags: ['run-heavy', 'option', 'qb', 'contain', 'counter'], label: 'Resource: QB slide and speed option rules', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-qb-slide', source: 'EA' },
  { lane: 'tendency', tags: ['run-heavy', 'space', 'fit', 'tackle'], label: 'Resource: ball carrier moves and open-field finish', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-ball-carrier-moves', source: 'EA' },
  { lane: 'tendency', tags: ['pass-heavy', 'catchpoint', 'outside', 'slot'], label: 'Resource: catch-point control and catch type usage', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-catch-the-ball', source: 'EA' },
  { lane: 'tendency', tags: ['pass-heavy', 'user', 'switchstick', 'counter'], label: 'Resource: Switch Stick for late-field adjustments', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-switch-stick', source: 'EA' },
  { lane: 'tendency', tags: ['bunch', 'trips', 'slot', 'separator', 'counter'], label: 'Film Room: slot separator for bunch and trips spacing', url: 'https://youtu.be/RcdTJQyplw8', source: 'Huddle.gg / YouTube' },
  { lane: 'tendency', tags: ['redzone', 'goalline', 'rb', 'angle', 'texas'], label: 'Film Room: RB angle / Texas route in compressed space', url: 'https://youtu.be/A6V0zSVINb4', source: 'Madden School / YouTube' },
  { lane: 'tendency', tags: ['tight', 'empty', 'middle', 'dagger', 'counter'], label: 'Film Room: Dagger from tight or empty spacing', url: 'https://youtu.be/ovaUis1SyII', source: 'Madden School / YouTube' },
  { lane: 'tendency', tags: ['tight', 'compressed', 'ypost', 'redzone', 'counter'], label: 'Film Room: Y-Post for tight-window and red-zone throws', url: 'https://youtu.be/VnSYjafXeEk', source: 'Madden School / YouTube' },
  { lane: 'tendency', tags: ['redzone', 'goalline', 'bunch', 'tight', 'empty'], label: 'Resource: top 5 offensive tips for compressed red-zone offense', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-offensive-tips', source: 'EA' },
  { lane: 'tendency', tags: ['run-heavy', 'goalline', 'runfit', 'box', 'counter'], label: 'Resource: top 5 defensive tips for run-fit counters', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-5-defensive-tips', source: 'EA' },
  { lane: 'tendency', tags: ['redzone', 'goalline', 'coverage', 'hands', 'counter'], label: 'Resource: intercept and swat timing in condensed windows', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-intercept-the-ball', source: 'EA' },
  { lane: 'tendency', tags: ['goalline', 'redzone', 'runfit', 'coverage', 'counter'], label: 'Resource: gameplay deep dive for red-zone and fit tuning', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/news/madden-26-gridiron-notes-gameplay-deep-dive', source: 'EA' },
  { lane: 'tendency', tags: ['pass-heavy', 'cover2', 'zone', 'sideline', 'counter'], label: 'Resource: attacking Cover 2 rules in Madden 26', url: 'https://www.madden-school.com/cover-2/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'cover3', 'zone', 'flood', 'counter'], label: 'Resource: attacking Cover 3 rules in Madden 26', url: 'https://www.madden-school.com/cover-3/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'cover4', 'quarters', 'match', 'counter'], label: 'Resource: attacking Cover 4 rules in Madden 26', url: 'https://www.madden-school.com/cover-4/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'man', 'press', 'release', 'counter'], label: 'Resource: attacking man coverage in Madden 26', url: 'https://www.madden-school.com/man-to-man/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'match', 'quarters', 'palms', 'counter'], label: 'Resource: attacking match coverage in Madden 26', url: 'https://www.madden-school.com/match-coverage/', source: 'Madden School' },
  { lane: 'tendency', tags: ['pass-heavy', 'deepball', 'singlecoverage', 'xfactor'], label: 'Resource: top 3 offensive X-Factors', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-3-offensive-x-factors', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'coverage', 'hybrid', 'xfactor'], label: 'Resource: top 3 defensive X-Factors', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-top-3-defensive-x-factors', source: 'EA' },
  { lane: 'tendency', tags: ['pass-heavy', 'press', 'ko', 'man', 'zone'], label: 'Ability guide: Universal Coverage X-Factor', url: 'https://www.mut.gg/abilities/universal-coverage-xf/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['pass-heavy', 'middle', 'slot', 'ko', 'counter'], label: 'Ability guide: Mid Zone KO', url: 'https://www.mut.gg/abilities/s6-mid-zone-ko/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['pass-heavy', 'deep', 'inside', 'ko', 'counter'], label: 'Ability guide: Deep In Zone KO', url: 'https://www.mut.gg/abilities/deep-in-zone-ko/', source: 'MUT.GG' },
  { lane: 'tendency', tags: ['balanced', 'formations', 'bunch', 'trips', 'overview'], label: 'Resource: best offensive playbooks in Madden 26', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-best-offensive-playbooks', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'shell', 'routecommit', 'disguise', 'counter'], label: 'Resource: coverage shells, custom zones, and route commit', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-coverage-shells', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'mug', 'showblitz', 'counter', 'disguise'], label: 'Resource: how to show blitz', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-show-blitz', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'stunt', 'fourman', 'front', 'counter'], label: 'Resource: how to use stunts', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-use-stunt', source: 'EA' },
  { lane: 'tendency', tags: ['pressure', 'passrush', 'shed', 'counter'], label: 'Resource: block steer to finish pressure', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-block-steer', source: 'EA' },
  { lane: 'tendency', tags: ['run-heavy', 'tackle', 'space', 'counter'], label: 'Resource: tackling in space and finishing drives', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub/m26-how-to-tackle', source: 'EA' },
  { lane: 'tendency', tags: ['balanced', 'scheme', 'formation', 'overview'], label: 'Resource: Madden 26 tips and tricks hub', url: 'https://www.ea.com/games/madden-nfl/madden-nfl-26/tips-and-tricks-hub', source: 'EA' },
];

const RESOURCE_HISTORY_FILE = path.join(process.cwd(), 'data', 'madden', 'learning_resource_history.json');

function normalizeResourceUrl(url = '') {
  return String(url || '').trim().toLowerCase().replace(/\/+$/, '');
}

function isResourceLandingPage(resource = {}) {
  const label = String(resource?.label || '').toLowerCase();
  const url = normalizeResourceUrl(resource?.url || '');
  return (
    label.includes('hub')
    || label.includes('collection')
    || label.includes('playbook hub')
    || url.endsWith('/tips-and-tricks-hub')
    || url.includes('/beginner-tips-hub/')
    || url.includes('/category/')
    || url.includes('/playbooks/')
  );
}

function ensureResourceHistoryDir() {
  fs.mkdirSync(path.dirname(RESOURCE_HISTORY_FILE), { recursive: true });
}

function baseResourceHistory() {
  return {
    assignments: {},
    recentByScope: {},
  };
}

function loadResourceHistory() {
  ensureResourceHistoryDir();
  if (!fs.existsSync(RESOURCE_HISTORY_FILE)) return baseResourceHistory();
  try {
    const parsed = JSON.parse(fs.readFileSync(RESOURCE_HISTORY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? { ...baseResourceHistory(), ...parsed } : baseResourceHistory();
  } catch {
    return baseResourceHistory();
  }
}

function saveResourceHistory(history) {
  ensureResourceHistoryDir();
  fs.writeFileSync(RESOURCE_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function scopeFromSeedKey(lane, seedKey = '') {
  const parts = String(seedKey || '').split(':');
  const team = parts[0] || 'unknown_team';
  const week = parts[2] || 'unknown_week';
  return {
    assignmentKey: `${lane}|${seedKey}`,
    scopeKey: `${lane}|${team}`,
    week,
  };
}

const RESOURCES = [...RAW_RESOURCES, ...EXTRA_DIRECT_RESOURCES, ...MATCHUP_DIRECT_RESOURCES].filter((resource) => {
  const url = String(resource?.url || '').toLowerCase();
  const source = String(resource?.source || '').toLowerCase();
  return !url.includes('youtube.com/results')
    && !url.includes('reddit.com/search')
    && !source.includes('search')
    && !source.includes('mut.gg')
    && !isResourceLandingPage(resource);
}).filter((resource, index, list) => {
  const key = `${resource?.lane || 'unknown'}|${normalizeResourceUrl(resource?.url)}`;
  return index === list.findIndex((entry) => `${entry?.lane || 'unknown'}|${normalizeResourceUrl(entry?.url)}` === key);
});

function inferResourceKind(resource = {}) {
  const url = String(resource?.url || '').toLowerCase();
  const source = String(resource?.source || '').toLowerCase();
  if (url.includes('youtube.com/results') || url.includes('reddit.com/search') || source.includes('search')) return 'search';
  if (url.includes('youtu.be/') || url.includes('youtube.com/watch')) return 'video';
  if (url.includes('reddit.com/')) return 'community';
  return 'article';
}

function isDirectLearningResource(resource = {}) {
  return inferResourceKind(resource) !== 'search';
}

function resourceSpecificityScore(resource = {}) {
  const kind = inferResourceKind(resource);
  if (kind === 'video') return 3;
  if (kind === 'article') return 2;
  if (kind === 'community') return 1;
  return 0;
}

function offensiveStruggleTags(ownStats = {}, oppStats = {}) {
  const tags = [];
  const passAtt = Number(ownStats?.pass?.att || 0);
  const sacksTaken = Number(ownStats?.pass?.sacksTaken || 0);
  const comps = Number(ownStats?.pass?.comp || 0);
  const compPct = passAtt > 0 ? (comps / passAtt) * 100 : 0;
  const rushYpg = Number(ownStats?.games || 0) > 0 ? Number(ownStats?.rush?.yds || 0) / Number(ownStats.games) : 0;
  const oppSacks = Number(oppStats?.games || 0) > 0 ? Number(oppStats?.def?.sacks || 0) / Number(oppStats.games) : 0;
  if (sacksTaken >= 10 || oppSacks >= 2.5) tags.push('pressure', 'protection', 'howto');
  if (compPct > 0 && compPct < 63) tags.push('read', 'coverage', 'howto', 'beginner');
  if (rushYpg > 0 && rushYpg < 70) tags.push('run', 'box', 'howto');
  return tags;
}

function defensiveStruggleTags(ownStats = {}, oppStats = {}) {
  const tags = [];
  const games = Math.max(1, Number(ownStats?.games || 0));
  const passAllowed = Number(ownStats?.def?.passYdsAllowed || 0) / games;
  const rushAllowed = Number(ownStats?.def?.rushYdsAllowed || 0) / games;
  const oppPassRate = Number(oppStats?.pass?.att || 0) / Math.max(1, Number(oppStats?.pass?.att || 0) + Number(oppStats?.rush?.att || 0));
  if (passAllowed >= 230 || oppPassRate >= 0.62) tags.push('coverage', 'shell', 'howto', 'beginner');
  if (rushAllowed >= 115) tags.push('runfit', 'front', 'howto');
  if (Number(ownStats?.def?.sacks || 0) / games < 1.5) tags.push('pressure', 'passrush', 'howto');
  return tags;
}

function tendencyStruggleTags(ownStats = {}, oppStats = {}) {
  const tags = [];
  const games = Math.max(1, Number(ownStats?.games || 0));
  const passAllowed = Number(ownStats?.def?.passYdsAllowed || 0) / games;
  const rushAllowed = Number(ownStats?.def?.rushYdsAllowed || 0) / games;
  if (passAllowed >= 230) tags.push('read', 'counter', 'howto');
  if (rushAllowed >= 115) tags.push('fit', 'counter', 'howto');
  if (Number(oppStats?.pass?.sacksTaken || 0) <= games) tags.push('disguise');
  return tags;
}

function advancedPerformanceTags(ownStats = {}, side = 'offense') {
  if (side === 'offense') {
    const games = Math.max(1, Number(ownStats?.games || 0));
    const passYpg = Number(ownStats?.pass?.yds || 0) / games;
    const rushYpg = Number(ownStats?.rush?.yds || 0) / games;
    const passAtt = Number(ownStats?.pass?.att || 0);
    const compPct = passAtt > 0 ? (Number(ownStats?.pass?.comp || 0) / passAtt) * 100 : 0;
    const sacksTaken = Number(ownStats?.pass?.sacksTaken || 0) / games;
    if ((passYpg >= 220 || rushYpg >= 110) && compPct >= 66 && sacksTaken <= 1.5) return ['advanced'];
    return [];
  }
  const games = Math.max(1, Number(ownStats?.games || 0));
  const passAllowed = Number(ownStats?.def?.passYdsAllowed || 0) / games;
  const rushAllowed = Number(ownStats?.def?.rushYdsAllowed || 0) / games;
  const sacks = Number(ownStats?.def?.sacks || 0) / games;
  if (passAllowed <= 205 && rushAllowed <= 100 && sacks >= 2.3) return ['advanced'];
  return [];
}

function selectResource(lane, preferredTags = [], seedKey = '', options = {}) {
  const tagSet = new Set(preferredTags.filter(Boolean).map((tag) => String(tag).toLowerCase()));
  const avoidBeginner = Boolean(options?.avoidBeginner);
  const persistChoice = options?.persistChoice !== false;
  const history = persistChoice ? loadResourceHistory() : null;
  const { assignmentKey, scopeKey, week } = scopeFromSeedKey(lane, seedKey);
  const recentUrls = persistChoice
    ? (history.recentByScope?.[scopeKey] || []).slice(-3).map((entry) => normalizeResourceUrl(entry?.url))
    : [];
  const avoidUrls = new Set([...(options?.avoidUrls || []), ...recentUrls].map((url) => normalizeResourceUrl(url)));
  const lanePool = RESOURCES
    .filter((resource) => resource.lane === lane)
    .filter((resource) => isDirectLearningResource(resource))
    .filter((resource) => !(avoidBeginner && (resource.tags || []).includes('beginner')))
    .filter((resource) => !avoidUrls.has(normalizeResourceUrl(resource.url)));
  if (persistChoice) {
    const existingUrl = normalizeResourceUrl(history.assignments?.[assignmentKey]?.url);
    const existing = RESOURCES.find((resource) => resource.lane === lane && normalizeResourceUrl(resource.url) === existingUrl);
    if (existing) return existing;
  }
  const scored = lanePool
    .map((resource) => {
      const tags = resource.tags || [];
      const score = tags.reduce((sum, tag) => sum + (tagSet.has(String(tag).toLowerCase()) ? 1 : 0), 0);
      return {
        resource,
        score,
        exactMatches: tags.reduce((sum, tag) => sum + (tagSet.has(String(tag).toLowerCase()) ? 1 : 0), 0),
        specificity: resourceSpecificityScore(resource),
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.exactMatches !== a.exactMatches) return b.exactMatches - a.exactMatches;
      return b.specificity - a.specificity;
    });
  const topScore = scored[0]?.score ?? 0;
  const threshold = Math.max(0, topScore - (topScore >= 3 ? 1 : 0));
  const pool = scored
    .filter((entry) => entry.score >= threshold)
    .slice(0, Math.min(6, scored.length))
    .sort((a, b) => {
      const aRank = hashSeed(seedKey, lane, a.resource.url, ...preferredTags);
      const bRank = hashSeed(seedKey, lane, b.resource.url, ...preferredTags);
      return aRank - bRank;
    })
    .map((entry) => entry.resource);
  const fallbackPool = pool.length ? pool : lanePool;
  if (!fallbackPool.length) return null;
  const index = hashSeed(lane, seedKey, ...preferredTags) % fallbackPool.length;
  const chosen = fallbackPool[index];
  if (persistChoice && chosen) {
    history.assignments[assignmentKey] = { week, url: chosen.url };
    const recent = Array.isArray(history.recentByScope[scopeKey]) ? history.recentByScope[scopeKey] : [];
    const withoutCurrentWeek = recent.filter((entry) => entry?.week !== week);
    history.recentByScope[scopeKey] = [...withoutCurrentWeek, { week, url: chosen.url }].slice(-6);
    saveResourceHistory(history);
  }
  return chosen;
}

export function pickOffenseLearningResource(profileTag = 'balanced', fieldProfile = null, ownStats = {}, oppStats = {}, seedKey = '', options = {}) {
  const advancedTags = advancedPerformanceTags(ownStats, 'offense');
  const tags = [profileTag, ...advancedTags, ...offensiveStruggleTags(ownStats, oppStats)];
  if (fieldProfile?.area) tags.push(fieldProfile.area);
  if (fieldProfile?.label) tags.push(String(fieldProfile.label).toLowerCase());
  const oppSacks = Number(oppStats?.def?.sacks || 0);
  const ownSacksTaken = Number(ownStats?.pass?.sacksTaken || 0);
  if (oppSacks >= 10 || ownSacksTaken >= 10) tags.push('pressure');
  if (fieldProfile?.area === 'slot') tags.push('inside', 'separator');
  if (fieldProfile?.area === 'outside') tags.push('outside', 'boundary');
  if (fieldProfile?.area === 'box') tags.push('box', 'rb');
  if (profileTag === 'vertical') tags.push('deep', 'coverage', 'timing');
  if (profileTag === 'spread') tags.push('quickgame', 'audible', 'hotroute');
  if (profileTag === 'ground') tags.push('run', 'space', 'ballcarrier');
  return selectResource('offense', tags, seedKey, {
    avoidBeginner: advancedTags.includes('advanced'),
    avoidUrls: options?.avoidUrls || [],
  });
}

export function pickDefenseLearningResource(profileTag = 'balanced', defensiveMismatch = null, fieldVulnerability = null, seedKey = '', ownStats = {}, oppStats = {}, options = {}) {
  const advancedTags = advancedPerformanceTags(ownStats, 'defense');
  const tags = [profileTag, ...advancedTags, ...defensiveStruggleTags(ownStats, oppStats)];

  // Add inferred opponent pass-style tags so we can pick more specific learning links (quick game vs shot plays).
  // This is intentionally light-weight: we only use stats already provided to this function.
  const oppGames = Math.max(1, Number(oppStats?.games || 0));
  const oppPassYpg = Number(oppStats?.pass?.yds || 0) / oppGames;
  const oppPassAtt = Number(oppStats?.pass?.att || 0) / oppGames;
  const oppComp = Number(oppStats?.pass?.comp || 0) / oppGames;
  const oppYpa = oppPassAtt > 0 ? (oppPassYpg / oppPassAtt) : 0;
  const oppCompPct = oppPassAtt > 0 ? ((oppComp / oppPassAtt) * 100) : 0;
  if (oppYpa >= 8.8) tags.push('vertical', 'deep');
  if (oppCompPct >= 67 && oppYpa <= 7.2) tags.push('quickgame', 'timing');
  if (defensiveMismatch?.type === 'protection') tags.push('pressure', 'sim', 'showblitz');
  if (defensiveMismatch?.type === 'scramble') tags.push('contain', 'mobileqb', 'scramble');
  if (defensiveMismatch?.type === 'coverage') tags.push('switchstick', 'coverage', 'user');
  if (fieldVulnerability?.area) tags.push(fieldVulnerability.area);
  if (fieldVulnerability?.area === 'slot') tags.push('inside', 'nickel');
  if (fieldVulnerability?.area === 'outside') tags.push('boundary', 'coverage');
  if (fieldVulnerability?.area === 'box') tags.push('runfit', 'alley', 'box');
  if (profileTag === 'zone') tags.push('shell', 'coverage');
  if (profileTag === 'pressure') tags.push('passrush', 'showblitz');
  return selectResource('defense', tags, seedKey, {
    avoidBeginner: advancedTags.includes('advanced'),
    avoidUrls: options?.avoidUrls || [],
  });
}

export function pickTendencyLearningResource(tendency = 'balanced', fieldVulnerability = null, seedKey = '', ownStats = {}, oppStats = {}, options = {}) {
  const advancedTags = advancedPerformanceTags(ownStats, 'defense');
  const tags = [tendency, ...advancedTags, ...tendencyStruggleTags(ownStats, oppStats)];
  if (fieldVulnerability?.area) tags.push(fieldVulnerability.area);
  if (tendency === 'pass-heavy') tags.push('shells', 'rotation', 'quickgame');
  if (tendency === 'run-heavy') tags.push('front', 'fit', 'alley');
  if (Number(oppStats?.pass?.att || 0) > Number(oppStats?.rush?.att || 0) * 1.75) tags.push('pass-heavy', 'timing', 'coverage');
  if (Number(oppStats?.rush?.att || 0) > Number(oppStats?.pass?.att || 0) * 1.25) tags.push('run-heavy', 'space', 'fit');
  if (Number(oppStats?.rush?.yds || 0) > 0 && Number(oppStats?.pass?.att || 0) > 0) tags.push('balanced', 'overview');
  return selectResource('tendency', tags, seedKey, {
    avoidBeginner: advancedTags.includes('advanced'),
    avoidUrls: options?.avoidUrls || [],
  });
}

function resourceConceptLabel(resource = null) {
  const tags = new Set((resource?.tags || []).map((tag) => String(tag).toLowerCase()));
  if (tags.has('slot') || tags.has('inside') || tags.has('separator')) return 'slot separation and inside leverage';
  if (tags.has('outside') || tags.has('boundary') || tags.has('flood')) return 'boundary stress and outside leverage';
  if (tags.has('box') || tags.has('rb') || tags.has('angle') || tags.has('texas')) return 'space stress on the box and second level';
  if (tags.has('pressure') || tags.has('sim') || tags.has('showblitz')) return 'pressure picture, mug looks, and post-snap stress';
  if (tags.has('shells') || tags.has('rotation') || tags.has('coverage')) return 'coverage shells, late spin, and leverage';
  if (tags.has('runfit') || tags.has('alley') || tags.has('front')) return 'run fits, alley control, and force-player rules';
  if (tags.has('read')) return 'diagnosing the defense and finding the clean answer';
  if (tags.has('howto')) return 'the how-to mechanics behind this week\'s problem';
  return 'the core concept driving this matchup';
}

export function buildLearningBridge(resource = null, lane = 'offense', struggleNote = '') {
  if (!resource?.url) return '';
  const concept = resourceConceptLabel(resource);
  if (lane === 'offense') {
    return `The linked resource matches this week directly: it is a ${concept} teaching cut, so the same spacing and leverage points in your plan are what you should be looking for when you watch it.${struggleNote ? ` ${struggleNote}` : ''}`;
  }
  if (lane === 'defense') {
    return `The linked resource matches the defensive read here: it is built around ${concept}, which is exactly how this matchup wants to stress your coverage picture or front structure.${struggleNote ? ` ${struggleNote}` : ''}`;
  }
  return `The linked resource is tied to this tendency report on purpose: it teaches ${concept}, which is the cleanest way to understand what this opponent wants the game to look like.${struggleNote ? ` ${struggleNote}` : ''}`;
}

export function buildLearningStruggleNote(lane = 'offense', ownStats = {}, oppStats = {}) {
  if (lane === 'offense') {
    const passAtt = Number(ownStats?.pass?.att || 0);
    const sacksTaken = Number(ownStats?.pass?.sacksTaken || 0);
    const compPct = passAtt > 0 ? (Number(ownStats?.pass?.comp || 0) / passAtt) * 100 : 0;
    const games = Math.max(1, Number(ownStats?.games || 0));
    const rushYpg = Number(ownStats?.rush?.yds || 0) / games;
    if (sacksTaken >= 10) return `It is also worth the click because your offense has already taken ${sacksTaken} sacks, so the protection and quick-answer details matter right now.`;
    if (compPct > 0 && compPct < 63) return `It is also worth the click because your pass game is under ${compPct.toFixed(1)}% completions, so the read and leverage mechanics are not optional right now.`;
    if (rushYpg > 0 && rushYpg < 70) return `It is also worth the click because the run game is only at ${rushYpg.toFixed(1)} yards per game, so the fit and spacing details should help clean that up.`;
    return '';
  }
  if (lane === 'defense') {
    const games = Math.max(1, Number(ownStats?.games || 0));
    const passAllowed = Number(ownStats?.def?.passYdsAllowed || 0) / games;
    const rushAllowed = Number(ownStats?.def?.rushYdsAllowed || 0) / games;
    const sacks = Number(ownStats?.def?.sacks || 0) / games;
    if (passAllowed >= 230) return `It is also worth the click because your defense is allowing ${passAllowed.toFixed(1)} pass yards per game, so the shell and leverage teaching is directly relevant.`;
    if (rushAllowed >= 115) return `It is also worth the click because your front is allowing ${rushAllowed.toFixed(1)} rush yards per game, so the run-fit detail should help.`;
    if (sacks < 1.5) return `It is also worth the click because the rush is only producing ${sacks.toFixed(1)} sacks per game, so the pressure-picture coaching should help create cleaner heat.`;
    return '';
  }
  const games = Math.max(1, Number(ownStats?.games || 0));
  const passAllowed = Number(ownStats?.def?.passYdsAllowed || 0) / games;
  const rushAllowed = Number(ownStats?.def?.rushYdsAllowed || 0) / games;
  if (passAllowed >= 230) return `It is also worth the click because your defense has been softer through the air than it needs to be, so the tendency-counter detail matters.`;
  if (rushAllowed >= 115) return `It is also worth the click because your box and alley fits have been under pressure, so the tendency-counter detail matters.`;
  return '';
}

export function formatLearningResource(resource = null) {
  if (!resource?.url) return '';
  const kind = inferResourceKind(resource);
  const kindLabel =
    kind === 'video'
      ? 'Video'
      : kind === 'article'
        ? 'Article'
        : kind === 'community'
          ? 'Community'
          : 'Resource';
  return `${kindLabel}: ${resource.label} — ${resource.source}\n${resource.url}`;
}
