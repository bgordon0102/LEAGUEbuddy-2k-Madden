import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { saveTradeDraft } from '../utils/trade_draft_store.js';

export const customId = 'trade_builder_start';

export async function execute(interaction) {
  if (!interaction.isButton() || interaction.customId !== customId) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  let snapshot;
  try {
    snapshot = loadLeagueSnapshot(leagueId);
  } catch {
    snapshot = null;
  }
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  if (!teams.length) {
    await interaction.reply({ content: 'Could not load league teams. Run weekly update first.', ephemeral: true });
    return;
  }
  const optionsAll = teams.map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsAFC = teams
    .filter(t => (t.divName || '').toUpperCase().includes('AFC'))
    .map(t => ({
      label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
      value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
    }));
  const optionsNFC = teams
    .filter(t => (t.divName || '').toUpperCase().includes('NFC'))
    .map(t => ({
      label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
      value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
    }));

  const limitOptions = (opts, keepValue) => {
    if (opts.length <= 25) return opts;
    const keep = opts.find(o => o.value === String(keepValue));
    const others = opts.filter(o => o.value !== String(keepValue));
    const trimmed = others.slice(0, 24);
    return keep ? [keep, ...trimmed] : opts.slice(0, 25);
  };

  const draftId = `builder_${interaction.user.id}_${Date.now()}`;
  saveTradeDraft(draftId, {
    draftId,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    leagueId,
    yourTeamId: null,
    otherTeamId: null,
    assets: { your: [], other: [] },
  });

  const rows = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_yours|${draftId}`)
        .setPlaceholder('Your team')
        .setDisabled(draft.yourTeamId ? true : false)
        .addOptions(
          draft.yourTeamId
            ? [{
              label: teams.find(t => String(t.teamId ?? t.teamIndex) === String(draft.yourTeamId))?.displayName || 'Your team',
              value: String(draft.yourTeamId),
            }]
            : limitOptions(optionsAll)
        )
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
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_builder_team_search_other|${draftId}`)
        .setLabel('Type other team')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];

  await interaction.reply({
    content: 'Select teams to start building the trade.',
    components: rows,
    ephemeral: true,
  });
}

export default { customId, execute };
