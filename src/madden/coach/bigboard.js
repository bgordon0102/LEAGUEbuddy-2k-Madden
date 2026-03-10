import { SlashCommandBuilder } from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';
import { classIdForSeason, buildPages } from '../../../madden/helpers/bigboard_helpers.js';
import fs from 'fs';
import path from 'path';

const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_PATH, 'utf8')); }
  catch { return {}; }
}

function isStaff(member) {
  if (!member) return false;
  const roles = member.roles?.cache;
  if (!roles?.size) return false;
  const roleMap = loadRoleMap();
  const staffIds = Object.entries(roleMap)
    .filter(([name]) =>
      /commish/i.test(name) ||
      /trade committee/i.test(name) ||
      /^ghost legacy$/i.test(name.trim()))
    .map(([, id]) => id);
  return staffIds.some(id => roles.has(id));
}

export const data = new SlashCommandBuilder()
  .setName('madden-bigboard')
  .setDescription('View the Madden draft big board (paged, 32 prospects per page)');

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    try { await interaction.deferReply({ flags: 64 }); } catch (_) {}
  }
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    const payload = { content: 'No league set. Run /madden-set-league first.' };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: 64 });
    return;
  }
  try {
    const snapshot = loadLeagueSnapshot(leagueId);
    const calendarYear =
      snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
      || snapshot?.info?.calendarYear
      || snapshot?.calendarYear;

    const classId = classIdForSeason(calendarYear);
    const { embeds, baseId } = buildPages(snapshot, classId, leagueId);

    const components = [];
    if (embeds.length > 1) {
      const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${baseId}_0`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(`${baseId}_1`).setLabel('Next').setStyle(ButtonStyle.Primary).setDisabled(embeds.length <= 1),
      );
      components.push(row);
    }

    await interaction.editReply({ embeds: [embeds[0]], components });
  } catch (err) {
    console.error('[madden-bigboard] failed:', err);
    try {
      await interaction.editReply({ content: 'Failed to load big board.' });
    } catch (_) {}
  }
}

export default { data, execute };
