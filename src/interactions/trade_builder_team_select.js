import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';
import { resolveTeamNameForRoster } from '../shared/rosterUtils.js';
import { getFullTeamName } from '../shared/madden_team_names.js';

export const customId = /^trade_builder_team_(yours|other_afc|other_nfc)\|/;

async function safeUpdate(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  await interaction.deferUpdate();
  return interaction.editReply(payload);
}

async function safeMessage(interaction, content) {
  const payload = { content, embeds: [], components: [] };
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply(interaction.inGuild() ? { ...payload, flags: 64 } : payload);
}

const EAST = [
  'Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'Charlotte Hornets', 'Chicago Bulls',
  'Cleveland Cavaliers', 'Detroit Pistons', 'Indiana Pacers', 'Miami Heat', 'Milwaukee Bucks',
  'New York Knicks', 'Orlando Magic', 'Philadelphia 76ers', 'Toronto Raptors', 'Washington Wizards'
];
const WEST = [
  'Dallas Mavericks', 'Denver Nuggets', 'Golden State Warriors', 'Houston Rockets', 'Los Angeles Clippers',
  'Los Angeles Lakers', 'Memphis Grizzlies', 'Minnesota Timberwolves', 'New Orleans Pelicans', 'Oklahoma City Thunder',
  'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs', 'Utah Jazz'
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
      label: getFullTeamName(t, 'Unknown'),
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
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch {
    return;
  }
  const [prefix, draftId] = interaction.customId.split('|');
  const side = prefix.includes('yours') ? 'yourTeamId' : 'otherTeamId';
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await safeMessage(interaction, 'Trade builder expired. Press Start Trade Builder again.');
    return;
  }
  const leagueId = draft.leagueId || resolveLeagueIdWithConfig(interaction.guildId);
  let snapshot = null;
  if (draft.mode !== '2k') {
    if (!leagueId) {
      await safeMessage(interaction, 'No league configured. Run /madden-set-league first.');
      return;
    }
    try { snapshot = loadLeagueSnapshot(leagueId); } catch { snapshot = null; }
  }

  const selected = interaction.values[0];
  const prevYour = draft.yourTeamId;
  const prevOther = draft.otherTeamId;
  draft[side] = selected;

  // Hard user override for Timberwolves coach user ID
  const USER_TEAM_OVERRIDES = {
    '840269359578611753': 'Minnesota Timberwolves',
  };
  const userOverride = USER_TEAM_OVERRIDES[interaction.user.id];

  if (draft.mode === '2k') {
    const resolved = (() => {
      if (userOverride && side === 'yourTeamId') return userOverride;
      if (/timberwolves/i.test(selected)) return 'Minnesota Timberwolves';
      if (/bucks/i.test(selected)) return 'Milwaukee Bucks';
      return resolveTeamNameForRoster(selected);
    })();
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
    if (side === 'yourTeamId') draft.yourTeamName = getFullTeamName(team, selected);
    if (side === 'otherTeamId') draft.otherTeamName = getFullTeamName(team, selected);
    draft.yourTeam = draft.yourTeamName || draft.yourTeamId || draft.yourTeam;
    draft.otherTeam = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  }
  // If team selection changed, clear cached assets so roster list refreshes correctly.
  if (side === 'yourTeamId' && prevYour && prevYour !== selected && draft.assets?.your) {
    draft.assets.your = [];
  }
  if (side !== 'yourTeamId' && prevOther && prevOther !== selected && draft.assets?.other) {
    draft.assets.other = [];
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
