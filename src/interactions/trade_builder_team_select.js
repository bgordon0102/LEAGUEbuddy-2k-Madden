import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';
import { resolveTeamNameForRoster } from '../shared/rosterUtils.js';

export const customId = /^trade_builder_team_(yours|other_afc|other_nfc)\|/;

async function safeUpdate(interaction, payload) {
  try {
    return await interaction.update(payload);
  } catch (err) {
    if ([10062, 40060, 50027].includes(err?.code) && interaction.channel?.isTextBased()) {
      return interaction.channel.send(
        typeof payload === 'string'
          ? payload
          : { ...payload, content: 'Trade builder interaction expired. Please press Start Trade Builder again.', components: [] }
      ).catch(() => {});
    }
    throw err;
  }
}

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

function buildTeamOptions(snapshot, conference) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  return teams
    .filter(t => {
      if (!conference) return true;
      const div = (t.divName || '').toUpperCase();
      return conference === 'AFC' ? div.includes('AFC') : div.includes('NFC');
    })
    .map(t => ({
      label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
      value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
    }));
}

function limitOptions(options, keepValue) {
  if (options.length <= 25) return options;
  if (!keepValue) return options.slice(0, 25);
  const keep = options.find(o => o.value === String(keepValue));
  const others = options.filter(o => o.value !== String(keepValue));
  const trimmed = others.slice(0, 24);
  return keep ? [keep, ...trimmed] : options.slice(0, 25);
}

export async function execute(interaction) {
  if (!interaction.isStringSelectMenu()) return;
  const [prefix, draftId] = interaction.customId.split('|');
  const side = prefix.includes('yours') ? 'yourTeamId' : 'otherTeamId';
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Press Start Trade Builder again.', ephemeral: true });
    return;
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  let snapshot = null;
  if (draft.mode !== '2k') {
    if (!leagueId) {
      await interaction.reply({ content: 'No league configured. Run /madden-set-league first.', ephemeral: true });
      return;
    }
    try { snapshot = loadLeagueSnapshot(leagueId); } catch { snapshot = null; }
  }

  const selected = interaction.values[0];
  const prevYour = draft.yourTeamId;
  const prevOther = draft.otherTeamId;
  draft[side] = selected;

  if (draft.mode === '2k') {
    const resolved = resolveTeamNameForRoster(selected);
    if (side === 'yourTeamId') {
      draft.yourTeamName = resolved;
      draft.yourTeamId = resolved;
    } else {
      draft.otherTeamName = resolved;
      draft.otherTeamId = resolved;
      draft.otherTeam = resolved;
    }
  } else {
    const optionsAll = limitOptions(buildTeamOptions(snapshot), draft.yourTeamId);
    const optionsAFC = limitOptions(buildTeamOptions(snapshot, 'AFC'));
    const optionsNFC = limitOptions(buildTeamOptions(snapshot, 'NFC'));
    const team = (snapshot?.teams?.leagueTeamInfoList || []).find(t => String(t.teamId ?? t.teamIndex) === String(selected));
    if (side === 'yourTeamId') draft.yourTeamName = team?.displayName || team?.nickName || team?.cityName || selected;
    if (side === 'otherTeamId') draft.otherTeamName = team?.displayName || team?.nickName || team?.cityName || selected;
    draft.yourTeam = draft.yourTeamName || draft.yourTeamId || draft.yourTeam;
    draft.otherTeam = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  }
  // If team selection changed, clear cached assets so roster list refreshes correctly
  if (draft.mode === '2k') {
    if (side === 'yourTeamId' && prevYour && prevYour !== selected && draft.assets?.your) {
      draft.assets.your = [];
    }
    if (side !== 'yourTeamId' && prevOther && prevOther !== selected && draft.assets?.other) {
      draft.assets.other = [];
    }
  }
  saveTradeDraft(draftId, draft);

  const components = [];

  const yourOptions = draft.yourTeamId
    ? [{ label: draft.yourTeamName || 'Your team', value: String(draft.yourTeamId) }]
    : (draft.mode === '2k'
        ? [...EAST, ...WEST].map(t => ({ label: t, value: t })).slice(0, 25)
        : limitOptions(buildTeamOptions(snapshot), draft.yourTeamId));
  components.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_yours|${draftId}`)
        .setPlaceholder(draft.yourTeamName ? `Your team: ${draft.yourTeamName}` : 'Select your team')
        // Keep 2K selectable to override wrong auto-detection; Madden still locks after pick
        .setDisabled(draft.mode === '2k' ? false : !!draft.yourTeamId)
        .addOptions(yourOptions)
    )
  );

  const otherEastOptions = draft.mode === '2k'
    ? (draft.otherTeamName && EAST.includes(draft.otherTeamName)
        ? [{ label: draft.otherTeamName, value: draft.otherTeamName }]
        : EAST.map(t => ({ label: t, value: t })))
    : limitOptions(buildTeamOptions(snapshot, 'AFC'));
  components.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_afc|${draftId}`)
        .setPlaceholder(draft.mode === '2k'
          ? (draft.otherTeamName && EAST.includes(draft.otherTeamName) ? `Other team: ${draft.otherTeamName}` : 'Select other team (East)')
          : 'Select other team (AFC)')
        .setDisabled(!!draft.otherTeamId && draft.mode === '2k' && EAST.includes(draft.otherTeamName))
        .addOptions(draft.mode === '2k'
          ? otherEastOptions.slice(0, 25)
          : otherEastOptions)
    )
  );

  const otherWestOptions = draft.mode === '2k'
    ? (draft.otherTeamName && WEST.includes(draft.otherTeamName)
        ? [{ label: draft.otherTeamName, value: draft.otherTeamName }]
        : WEST.map(t => ({ label: t, value: t })))
    : limitOptions(buildTeamOptions(snapshot, 'NFC'));
  components.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
        .setPlaceholder(draft.mode === '2k'
          ? (draft.otherTeamName && WEST.includes(draft.otherTeamName) ? `Other team: ${draft.otherTeamName}` : 'Select other team (West)')
          : 'Select other team (NFC)')
        .setDisabled(!!draft.otherTeamId && draft.mode === '2k' && WEST.includes(draft.otherTeamName))
        .addOptions(draft.mode === '2k'
          ? otherWestOptions.slice(0, 25)
          : otherWestOptions)
    )
  );

  const haveBothTeams = draft.mode === '2k'
    ? (draft.yourTeamName && draft.otherTeamName)
    : (draft.yourTeamId && draft.otherTeamId);
  if (haveBothTeams) {
    components.push(...buildButtons(draftId));
    // keep at most 5 rows to satisfy Discord limits
    components.splice(5);
  }

  const embed = new EmbedBuilder()
    .setTitle('Trade Builder')
    .setDescription('Select both teams, then add assets to see live values.')
    .addFields(
      { name: 'You', value: draft.yourTeamName || '—', inline: true },
      { name: 'Other', value: draft.otherTeamName || '—', inline: true },
    )
    .setColor(0x5865f2);

  await safeUpdate(interaction, {
    content: null,
    embeds: [embed],
    components,
  });
}

export default { customId, execute };
