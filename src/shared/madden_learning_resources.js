function hashSeed(...values) {
  const text = values.map((value) => String(value || '')).join('|');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash) + text.charCodeAt(i);
  return Math.abs(hash);
}

const RESOURCES = [
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
  const lanePool = RESOURCES
    .filter((resource) => resource.lane === lane)
    .filter((resource) => !(avoidBeginner && (resource.tags || []).includes('beginner')));
  const scored = lanePool
    .map((resource) => {
      const tags = resource.tags || [];
      const score = tags.reduce((sum, tag) => sum + (tagSet.has(String(tag).toLowerCase()) ? 1 : 0), 0);
      return { resource, score };
    })
    .sort((a, b) => b.score - a.score);
  const topScore = scored[0]?.score ?? 0;
  const pool = scored
    .filter((entry) => entry.score === topScore)
    .map((entry) => entry.resource);
  const fallbackPool = pool.length ? pool : lanePool;
  if (!fallbackPool.length) return null;
  const index = hashSeed(lane, seedKey, ...preferredTags) % fallbackPool.length;
  return fallbackPool[index];
}

export function pickOffenseLearningResource(profileTag = 'balanced', fieldProfile = null, ownStats = {}, oppStats = {}, seedKey = '') {
  const advancedTags = advancedPerformanceTags(ownStats, 'offense');
  const tags = [profileTag, ...advancedTags, ...offensiveStruggleTags(ownStats, oppStats)];
  if (fieldProfile?.area) tags.push(fieldProfile.area);
  const oppSacks = Number(oppStats?.def?.sacks || 0);
  const ownSacksTaken = Number(ownStats?.pass?.sacksTaken || 0);
  if (oppSacks >= 10 || ownSacksTaken >= 10) tags.push('pressure');
  if (fieldProfile?.area === 'slot') tags.push('inside', 'separator');
  if (fieldProfile?.area === 'outside') tags.push('outside', 'boundary');
  if (fieldProfile?.area === 'box') tags.push('box', 'rb');
  return selectResource('offense', tags, seedKey, { avoidBeginner: advancedTags.includes('advanced') });
}

export function pickDefenseLearningResource(profileTag = 'balanced', defensiveMismatch = null, fieldVulnerability = null, seedKey = '', ownStats = {}, oppStats = {}) {
  const advancedTags = advancedPerformanceTags(ownStats, 'defense');
  const tags = [profileTag, ...advancedTags, ...defensiveStruggleTags(ownStats, oppStats)];
  if (defensiveMismatch?.type === 'protection') tags.push('pressure', 'sim', 'showblitz');
  if (fieldVulnerability?.area) tags.push(fieldVulnerability.area);
  if (fieldVulnerability?.area === 'slot') tags.push('inside', 'nickel');
  if (fieldVulnerability?.area === 'outside') tags.push('boundary', 'coverage');
  if (fieldVulnerability?.area === 'box') tags.push('runfit', 'alley', 'box');
  return selectResource('defense', tags, seedKey, { avoidBeginner: advancedTags.includes('advanced') });
}

export function pickTendencyLearningResource(tendency = 'balanced', fieldVulnerability = null, seedKey = '', ownStats = {}, oppStats = {}) {
  const advancedTags = advancedPerformanceTags(ownStats, 'defense');
  const tags = [tendency, ...advancedTags, ...tendencyStruggleTags(ownStats, oppStats)];
  if (fieldVulnerability?.area) tags.push(fieldVulnerability.area);
  if (tendency === 'pass-heavy') tags.push('shells', 'rotation', 'quickgame');
  if (tendency === 'run-heavy') tags.push('front', 'fit', 'alley');
  return selectResource('tendency', tags, seedKey, { avoidBeginner: advancedTags.includes('advanced') });
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
  return `${resource.label} — ${resource.source}\n${resource.url}`;
}
