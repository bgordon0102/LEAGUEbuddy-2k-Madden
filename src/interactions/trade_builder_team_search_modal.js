import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';
import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

export const customId = /^trade_builder_team_search_modal\|/;

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || !customId.test(interaction.customId)) return;
  const [, draftId] = interaction.customId.split('|');
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
    return;
  }
  const query = (interaction.fields.getTextInputValue('team_query') || '').toLowerCase().trim();
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
  draft.otherTeamName = match.displayName || match.nickName || match.cityName || match.abbrName || 'Team';
  draft.otherTeam = draft.otherTeamName || draft.otherTeamId || draft.otherTeam;
  saveTradeDraft(draftId, draft);

  const optionsAll = teams.map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsAFC = teams.filter(t => (t.divName || '').toUpperCase().includes('AFC')).map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsNFC = teams.filter(t => (t.divName || '').toUpperCase().includes('NFC')).map(t => ({
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
