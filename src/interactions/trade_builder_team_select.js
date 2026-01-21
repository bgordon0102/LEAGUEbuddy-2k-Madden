import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft, saveTradeDraft } from '../utils/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';

export const customId = /^trade_builder_team_(yours|other_afc|other_nfc)\|/;

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
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  let snapshot;
  try { snapshot = loadLeagueSnapshot(leagueId); } catch { snapshot = null; }
  const optionsAll = limitOptions(buildTeamOptions(snapshot), draft.yourTeamId);
  const optionsAFC = limitOptions(buildTeamOptions(snapshot, 'AFC'));
  const optionsNFC = limitOptions(buildTeamOptions(snapshot, 'NFC'));
  const selected = interaction.values[0];
  draft[side] = selected;
  const team = (snapshot?.teams?.leagueTeamInfoList || []).find(t => String(t.teamId ?? t.teamIndex) === String(selected));
  if (side === 'yourTeamId') draft.yourTeamName = team?.displayName || team?.nickName || team?.cityName || selected;
  if (side === 'otherTeamId') draft.otherTeamName = team?.displayName || team?.nickName || team?.cityName || selected;
  draft.yourTeam = draft.yourTeamName || draft.yourTeamId || draft.yourTeam;
  draft.otherTeam = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  saveTradeDraft(draftId, draft);

  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_yours|${draftId}`)
        .setPlaceholder(draft.yourTeamName ? `Your team: ${draft.yourTeamName}` : 'Select your team')
        .setDisabled(draft.yourTeamId ? true : false)
        .addOptions(
          draft.yourTeamId
            ? [{
              label: draft.yourTeamName || 'Your team',
              value: String(draft.yourTeamId),
            }]
            : optionsAll
        )
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_afc|${draftId}`)
        .setPlaceholder('Select other team (AFC)')
        .addOptions(optionsAFC)
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
        .setPlaceholder('Select other team (NFC)')
        .addOptions(optionsNFC)
    ),
  ];

  let typeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`trade_builder_team_search_other|${draftId}`)
      .setLabel('Type other team')
      .setStyle(ButtonStyle.Secondary)
  );
  components.push(typeRow);

  if (draft.yourTeamId && draft.otherTeamId) {
    // when adding builder buttons, drop the type-row if needed to stay <=5 components
    components.push(...buildButtons(draftId));
    if (components.length > 5) {
      components.splice(3, 1); // remove the type-row
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('Trade Builder')
    .setDescription('Select both teams, then add assets to see live values.')
    .addFields(
      { name: 'You', value: draft.yourTeamName || '—', inline: true },
      { name: 'Other', value: draft.otherTeamName || '—', inline: true },
    )
    .setColor(0x5865f2);

  await interaction.update({
    content: null,
    embeds: [embed],
    components,
  });
}

export default { customId, execute };
