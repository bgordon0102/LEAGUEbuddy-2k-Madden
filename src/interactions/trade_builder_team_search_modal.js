import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';
import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

export const customId = /^trade_builder_team_search_modal\|/;
const EAST = [
  'Atlanta Hawks','Boston Celtics','Brooklyn Nets','Charlotte Hornets','Chicago Bulls',
  'Cleveland Cavaliers','Detroit Pistons','Indiana Pacers','Miami Heat','Milwaukee Bucks',
  'New York Knicks','Orlando Magic','Philadelphia 76ers','Toronto Raptors','Washington Wizards'
];
const WEST = [
  'Dallas Mavericks','Denver Nuggets','Golden State Warriors','Houston Rockets','Los Angeles Clippers',
  'Los Angeles Lakers','Memphis Grizzlies','Minnesota Timberwolves','New Orleans Pelicans','Oklahoma City Thunder',
  'Phoenix Suns','Portland Trail Blazers','Sacramento Kings','San Antonio Spurs','Utah Jazz'
];

function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || !customId.test(interaction.customId)) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
    return;
  }
  const query = (interaction.fields.getTextInputValue('team_query') || '').toLowerCase().trim();
  if (draft.mode === '2k') {
    const all = [...EAST, ...WEST];
    const aliases = {
      'okc': 'Oklahoma City Thunder',
      'thunder': 'Oklahoma City Thunder',
      'oklahoma': 'Oklahoma City Thunder',
      'oklahomacity': 'Oklahoma City Thunder',
      'atl': 'Atlanta Hawks',
      'hawks': 'Atlanta Hawks',
    };
    const aliasHit = aliases[query.replace(/\s+/g, '')];
    const scored = all
      .map(t => {
        const name = t.toLowerCase();
        const parts = name.split(/\s+/);
        const exact = name === query;
        const starts = name.startsWith(query) || parts.some(p => p.startsWith(query));
        const contains = name.includes(query);
        // Higher score for exact > startswith > contains; longer overlap helps disambiguate
        const overlap = query ? Math.max(...parts.map(p => commonPrefixLen(p, query)), 0) : 0;
        const score = exact ? 3 : starts ? 2 : contains ? 1 : 0;
        return { team: t, score: score * 10 + overlap };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    const match = aliasHit || scored[0]?.team;
    if (!match) {
      await interaction.reply({ content: 'No team matched that search.', ephemeral: true });
      return;
    }
    draft.otherTeamName = match;
    draft.otherTeamId = match;
    draft.otherTeam = match;
    saveTradeDraft(draftId, draft);

    const embed = new EmbedBuilder()
      .setTitle('Trade Builder')
      .setDescription('Select both teams, then add assets to see live values.')
      .addFields(
        { name: 'You', value: draft.yourTeamName || '—', inline: true },
        { name: 'Other', value: draft.otherTeamName || '—', inline: true },
      )
      .setColor(0x5865f2);

    const components = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_yours|${draftId}`)
          .setPlaceholder(draft.yourTeamName ? `Your team: ${draft.yourTeamName}` : 'Select your team')
          .addOptions((draft.yourTeamName ? [draft.yourTeamName] : all).slice(0,25).map(t => ({ label: t, value: t })))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_afc|${draftId}`)
          .setPlaceholder('Select other team (East)')
          .addOptions(EAST.map(t => ({ label: t, value: t })).slice(0,25))
      ),
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
          .setPlaceholder('Select other team (West)')
          .addOptions(WEST.map(t => ({ label: t, value: t })).slice(0,25))
      ),
    ];
    if (draft.yourTeamName && draft.otherTeamName) {
      components.push(...buildButtons(draftId));
      components.splice(5);
    }
    await interaction.reply({ embeds: [embed], components, ephemeral: true });
    return;
  }

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const scored = teams
    .map(t => {
      const parts = [
        t.displayName, t.nickName, t.cityName, t.abbrName,
      ].map(x => (x || '').toLowerCase());
      const exact = parts.some(p => p === query);
      const starts = parts.some(p => p.startsWith(query));
      const contains = parts.some(p => p.includes(query));
      const score = exact ? 3 : starts ? 2 : contains ? 1 : 0;
      return { team: t, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.team.displayName || '').localeCompare(b.team.displayName || ''));
  const match = scored[0]?.team;
  if (!match) {
    await interaction.reply({ content: 'No team matched that search.', ephemeral: true });
    return;
  }
  draft.otherTeamId = match.teamId ?? match.teamIndex ?? match.displayName ?? match.nickName;
  draft.otherTeamName = getFullTeamName(match, 'Team');
  draft.otherTeam = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  saveTradeDraft(draftId, draft);

  const optionsAll = teams.map(t => ({
    label: getFullTeamName(t, 'Unknown'),
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsAFC = teams.filter(t => (t.divName || '').toUpperCase().includes('AFC')).map(t => ({
    label: getFullTeamName(t, 'Unknown'),
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsNFC = teams.filter(t => (t.divName || '').toUpperCase().includes('NFC')).map(t => ({
    label: getFullTeamName(t, 'Unknown'),
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const limitOptions = (opts, keepValue) => {
    if (opts.length <= 25) return opts;
    const keep = opts.find(o => o.value === String(keepValue));
    const others = opts.filter(o => o.value !== String(keepValue));
    const trimmed = others.slice(0, 24);
    return keep ? [keep, ...trimmed] : opts.slice(0, 25);
  };

  const embed = new EmbedBuilder()
    .setTitle('Trade Builder')
    .setDescription('Select both teams, then add assets to see live values.')
    .addFields(
      { name: 'You', value: draft.yourTeamName || '—', inline: true },
      { name: 'Other', value: draft.otherTeamName || '—', inline: true },
    )
    .setColor(0x5865f2);

  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_yours|${draftId}`)
        .setPlaceholder(draft.yourTeamName ? `Your team: ${draft.yourTeamName}` : 'Select your team')
        .addOptions(limitOptions(optionsAll, draft.yourTeamId))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_afc|${draftId}`)
        .setPlaceholder('Select other team (AFC)')
        .addOptions(limitOptions(optionsAFC))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
        .setPlaceholder('Select other team (NFC)')
        .addOptions(limitOptions(optionsNFC))
    ),
  ];
  if (draft.yourTeamId && draft.otherTeamId) {
    components.push(...buildButtons(draftId));
  }

  await interaction.reply({
    content: null,
    embeds: [embed],
    components,
    ephemeral: true,
  });
}

export default { customId, execute };
