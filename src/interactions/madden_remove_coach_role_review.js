import { ButtonInteraction, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { loadRoleMap, hasStaffRole } from '../madden/staff/staffUtils.js';
import { updateAvailableTeamsPin } from '../../madden/available_teams.js';
import { updateFairSimBoard } from '../shared/fairsim_board.js';
import { markRemovalReviewResolved } from '../shared/madden_removal_review.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';

export const customId = /^madden_remove_coach_role_review\|([^|]+)\|([^|]+)$/;

function seasonKeyFromSnapshot(snapshot) {
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

function disableButtons(interaction) {
  const updatedRows = interaction.message.components.map((row) => {
    const newRow = ActionRowBuilder.from(row);
    newRow.components = newRow.components.map((btn) => ButtonBuilder.from(btn).setDisabled(true));
    return newRow;
  });
  return interaction.message.edit({ components: updatedRows });
}

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [, userId, roleId] = interaction.customId.match(customId) || [];
  const roleMap = loadRoleMap();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasStaffRole(member, roleMap)) {
    await interaction.reply({ content: 'Only staff can remove a coach role from this review card.', ephemeral: true });
    return;
  }

  const target = await interaction.guild.members.fetch(userId).catch(() => null);
  const role = interaction.guild.roles.cache.get(roleId) || await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!target || !role) {
    await interaction.reply({ content: 'Coach or role could not be resolved from this review card.', ephemeral: true });
    return;
  }

  await target.roles.remove(role).catch(async (error) => {
    await interaction.reply({ content: `Failed to remove role: ${error?.message || error}`, ephemeral: true });
  });
  if (interaction.replied) return;

  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = loadLeagueSnapshot(leagueId);
  const seasonKey = seasonKeyFromSnapshot(snapshot);
  markRemovalReviewResolved(interaction.guildId, seasonKey, userId, roleId);

  try { await updateAvailableTeamsPin(interaction.client, interaction.guildId, { allowCreate: true, delayMs: 0, retries: 3, retryDelayMs: 800, guild: interaction.guild, skipMemberFetch: false }); } catch {}
  try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch {}
  try { await disableButtons(interaction); } catch {}

  await interaction.reply({ content: `Removed ${role.name} from ${target.user.tag}.`, ephemeral: true });
}

export default { customId, execute };
