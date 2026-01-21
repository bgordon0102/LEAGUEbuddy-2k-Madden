import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { getTradeDraft } from '../utils/trade_draft_store.js';
import { rosterForTeam, buildButtons } from './trade_builder_add_assets.js';

export const customId = /^trade_builder_search_modal\|(yours|other)\|/;

export async function execute(interaction) {
  if (!interaction.isModalSubmit() || !customId.test(interaction.customId)) return;
  const [, side, draftId] = interaction.customId.split('|');
  const query = (interaction.fields.getTextInputValue('query') || '').toLowerCase().trim();
  const draft = getTradeDraft(draftId);
  if (!draft) {
    await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
    return;
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league configured.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const teamId = side === 'yours' ? draft.yourTeamId : draft.otherTeamId;
  const roster = rosterForTeam(snapshot, teamId);
  const matches = roster
    .filter(p => {
      const name = `${p.firstName || ''} ${p.lastName || ''}`.toLowerCase();
      return name.includes(query);
    })
    .sort((a, b) => {
      const oa = a.overallRating ?? a.playerBestOvr ?? a.playerSchemeOvr ?? a.teamSchemeOvr ?? a.ovrRating ?? 0;
      const ob = b.overallRating ?? b.playerBestOvr ?? b.playerSchemeOvr ?? b.teamSchemeOvr ?? b.ovrRating ?? 0;
      return ob - oa;
    })
    .slice(0, 25);

  if (!matches.length) {
    await interaction.reply({ content: 'No players matched that search.', ephemeral: true });
    return;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`trade_builder_select_assets|${side}|${draftId}|search`)
    .setPlaceholder('Select player(s) to add')
    .setMinValues(1)
    .setMaxValues(Math.min(5, matches.length))
    .addOptions(
      matches.map(p => {
        const ovr = p.overallRating ?? p.playerBestOvr ?? p.playerSchemeOvr ?? p.teamSchemeOvr ?? p.ovrRating ?? '??';
        const age = p.age ?? (p.yearsPro != null ? (18 + Number(p.yearsPro)) : '??');
        const label = `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Player';
        return new StringSelectMenuOptionBuilder()
          .setLabel(label.slice(0, 90))
          .setDescription(`${p.position || 'UNK'} | Age ${age} | OVR ${ovr}`.slice(0, 100))
          .setValue(`player:${p.rosterId}`);
      })
    );

  await interaction.reply({
    content: 'Select players to add',
    components: [new ActionRowBuilder().addComponents(select)],
    ephemeral: true,
  });
}

export default { customId, execute };
