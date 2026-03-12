import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { updateFairSimBoard } from '../../shared/2k_fairsim_board.js';

export const data = new SlashCommandBuilder()
  .setName('2k-testmatchup')
  .setDescription('Staff: create a single 2K test matchup thread with the new buttons')
  .addStringOption(o => o.setName('teama').setDescription('Team A name').setRequired(false))
  .addStringOption(o => o.setName('teamb').setDescription('Team B name').setRequired(false))
  .addRoleOption(o => o.setName('teama_role').setDescription('Team A coach role to tag (optional)').setRequired(false))
  .addRoleOption(o => o.setName('teamb_role').setDescription('Team B coach role to tag (optional)').setRequired(false))
  .setDefaultMemberPermissions(null);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const roleA = interaction.options.getRole('teama_role');
  const roleB = interaction.options.getRole('teamb_role');
  const nameFromRole = (role) => role ? role.name.replace(/\s*Coach$/i, '').trim() : null;
  const teamA = interaction.options.getString('teama') || nameFromRole(roleA) || 'Team A';
  const teamB = interaction.options.getString('teamb') || nameFromRole(roleB) || 'Team B';
  const channel = interaction.channel;
  if (!channel?.isTextBased()) {
    await interaction.editReply({ content: 'Run this in a text channel.' });
    return;
  }
  const thread = await channel.threads.create({
    name: `${teamA} vs ${teamB} - TEST`,
    autoArchiveDuration: 10080,
    reason: '2K test matchup thread',
  });

  const mascot = (name) => {
    if (!name) return 'Team';
    const parts = name.trim().split(/\s+/);
    return parts[parts.length - 1] || name;
  };

    const statusRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`2k_game_status_complete|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel('Game Completed 🏁').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`2k_game_status_fairsim|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel('Fair Sim ⚖️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`2k_game_status_teamawin|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel(`${mascot(teamA)} Win 🛫`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`2k_game_status_teambwin|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel(`${mascot(teamB)} Win 🏠`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`2k_game_status_cpu|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel('CPU 🤖').setStyle(ButtonStyle.Secondary),
    );
  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`2k_game_status_staffstrikea|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel(`Staff Strike ${mascot(teamA)} 🚫`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`2k_game_status_staffstrikeb|${thread.id}|${encodeURIComponent(teamA)}|${encodeURIComponent(teamB)}`).setLabel(`Staff Strike ${mascot(teamB)} 🚫`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`set_game_info|${thread.id}`).setLabel('Set Game Info').setStyle(ButtonStyle.Primary),
  );

  const embed = {
    title: 'LEAGUEbuddy 2K Matchup (TEST)',
    description: [
      'Schedule and play your game. Use the buttons when needed:',
      '🏁 Game Completed — both coaches press; clears reminders.',
      '⚖️ Fair Sim — both coaches press; each gets 1 sim strike (max 5/season).',
      '🏠 Team A Win — only Team B coach or staff may press; Team A ready, Team B couldn’t (Team B gets 1 strike).',
      '🛫 Team B Win — only Team A coach or staff may press; Team B ready, Team A couldn’t (Team A gets 1 strike).',
      '🤖 CPU — for CPU matchups; no strikes, just stops reminders.',
      '🚫 Staff Strike — staff-only; adds 1 strike to a team when unresponsive.',
      'No deadline set in test mode.',
    ].join('\n'),
    color: 0x1E90FF,
    timestamp: new Date().toISOString(),
  };

  const commishIds = ['1460734128935665817', '1460734222238220326'];
  const mentions = [];
  if (roleA) mentions.push(`<@&${roleA.id}>`);
  if (roleB) mentions.push(`<@&${roleB.id}>`);
  mentions.push(...commishIds.map(id => `<@&${id}>`));

  const dedupContent = Array.from(new Set(mentions)).join(' ') || null;

  await thread.send({
    content: dedupContent,
    embeds: [embed],
    components: [statusRow, staffRow],
    allowedMentions: mentions.length ? { parse: ['roles'] } : { parse: [] },
  });
  await interaction.editReply({ content: `Test matchup thread created: <#${thread.id}>` });
  try { await updateFairSimBoard(interaction.client, interaction.guildId); } catch {}
}

export default { data, execute };
