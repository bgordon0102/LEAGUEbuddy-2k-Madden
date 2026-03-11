import { SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../madden/madden_data.js';

const FAIR_FILE = path.join(process.cwd(), 'data', 'madden', 'fairsims.json');

function loadFair() {
  try { return JSON.parse(fs.readFileSync(FAIR_FILE, 'utf8')); } catch { return {}; }
}
function saveFair(data) {
  fs.mkdirSync(path.dirname(FAIR_FILE), { recursive: true });
  fs.writeFileSync(FAIR_FILE, JSON.stringify(data, null, 2));
}

function seasonKey(snapshot, overrideYear) {
  if (overrideYear) return `year_${overrideYear}`;
  const yr = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  return `year_${yr}`;
}

export const data = new SlashCommandBuilder()
  .setName('madden-reset-fairsims')
  .setDescription('Staff: reset fair-sim usage for a coach')
  .addUserOption(o => o.setName('coach').setDescription('Coach user').setRequired(true))
  .addIntegerOption(o => o.setName('year').setDescription('Season calendar year (optional)').setRequired(false))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  const isAdmin = interaction.member?.permissions?.has(PermissionsBitField.Flags.ManageGuild);
  if (!isAdmin) {
    await interaction.reply({ content: 'Staff only.', ephemeral: true });
    return;
  }
  const coach = interaction.options.getUser('coach');
  const yearOverride = interaction.options.getInteger('year');
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const snapshot = leagueId ? loadLeagueSnapshot(leagueId) : null;
  const key = seasonKey(snapshot, yearOverride);
  const fair = loadFair();
  if (!fair[key]) fair[key] = {};
  fair[key][coach.id] = 0;
  saveFair(fair);
  await interaction.reply({ content: `Fair sim count reset for ${coach} (${key}).`, ephemeral: true });
}

export default { data, execute };
