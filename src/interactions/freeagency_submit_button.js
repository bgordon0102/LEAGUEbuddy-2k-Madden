import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { readRoster, saveRoster, upsertPlayer, removePlayerFromOtherRosters } from '../utils/rosterUtils.js';

const STORE_PATH = path.join(process.cwd(), 'data', 'freeagency.json');
const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const STAFF_ROLES = ['Paradise Commish', 'Schedule Tracker'];
const FREEAGENCY_LOG_PATH = path.join(process.cwd(), 'data', 'freeagency_log.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeStore(entries) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries ?? [], null, 2));
}

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(FREEAGENCY_LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeLog(log) {
  try {
    fs.writeFileSync(FREEAGENCY_LOG_PATH, JSON.stringify(log ?? [], null, 2));
  } catch (err) {
    console.error('[freeagency] Failed to write log:', err);
  }
}

// One handler covers submit + approve/deny buttons
export const customId = /^freeagency_(submit_button|approve|deny)_?.*/;
export const customId_modal_freeagency = 'freeagency_modal_submit';

export async function execute(interaction) {
  if (interaction.customId.startsWith('freeagency_submit_button')) {
    const modal = new ModalBuilder()
      .setCustomId(customId_modal_freeagency)
      .setTitle('Submit Free Agency Offer')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('team')
            .setLabel('Your Team')
            .setPlaceholder('e.g., New York Knicks')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('player')
            .setLabel('Player Name')
            .setPlaceholder('e.g., Julius Randle')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ovr')
            .setLabel('OVR')
            .setPlaceholder('e.g., 86')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('years')
            .setLabel('Years')
            .setPlaceholder('e.g., 3')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('salary')
            .setLabel('Salary Per Year')
            .setPlaceholder('e.g., $18M')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
  // Approve/deny buttons
  await execute_review(interaction);
}

export async function execute_modal_freeagency(interaction) {
  const team = interaction.fields.getTextInputValue('team');
  const player = interaction.fields.getTextInputValue('player');
  const ovr = interaction.fields.getTextInputValue('ovr');
  const years = interaction.fields.getTextInputValue('years');
  const salary = interaction.fields.getTextInputValue('salary');

  await interaction.deferReply({ ephemeral: true });

  const entry = {
    id: `${Date.now()}`,
    team,
    player,
    ovr,
    years,
    salary,
    status: 'pending',
    submittedBy: interaction.user.id,
    submittedAt: new Date().toISOString(),
  };

  const entries = readStore();
  entries.push(entry);
  writeStore(entries);

  let staffTags = '';
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    staffTags = STAFF_ROLES.map(r => staffMap[r]).filter(Boolean).map(id => `<@&${id}>`).join(' ');
  } catch (err) {
    console.error('[freeagency] Failed to read staffRoleMap.main.json:', err);
  }

  const embed = new EmbedBuilder()
    .setTitle('Free Agency Offer')
    .setColor(0x5865f2)
    .addFields(
      { name: 'Team', value: team, inline: true },
      { name: 'Player', value: player, inline: true },
      { name: 'OVR', value: ovr, inline: true },
      { name: 'Years', value: years, inline: true },
      { name: 'Salary / Yr', value: salary, inline: true },
      { name: 'Submitted By', value: `<@${interaction.user.id}>`, inline: false },
      { name: 'Status', value: 'Pending staff review', inline: false },
    )
    .setFooter({ text: `Offer ID: ${entry.id}` })
    .setTimestamp(new Date());

  const approveBtn = new ButtonBuilder()
    .setCustomId(`freeagency_approve_${entry.id}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success);
  const denyBtn = new ButtonBuilder()
    .setCustomId(`freeagency_deny_${entry.id}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

  await interaction.channel.send({
    content: staffTags || 'Staff review needed',
    embeds: [embed],
    components: [row],
  });

  await interaction.editReply({ content: 'Free agency offer submitted for staff review.' });
}

export async function execute_review(interaction) {
  const isApprove = interaction.customId.startsWith('freeagency_approve_');
  const entryId = interaction.customId.replace('freeagency_approve_', '').replace('freeagency_deny_', '');

  let allowedRoleIds = [];
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    allowedRoleIds = STAFF_ROLES.map(r => staffMap[r]).filter(Boolean);
  } catch (err) {
    console.error('[freeagency] Failed to read staffRoleMap.main.json:', err);
  }
  const memberRoles = interaction.member?.roles?.cache;
  const isStaff = allowedRoleIds.length ? allowedRoleIds.some(rid => memberRoles?.has(rid)) : true;
  if (!isStaff) {
    await interaction.reply({ content: 'Only staff may approve or deny free agency offers.', ephemeral: true });
    return;
  }

  const entries = readStore();
  const idx = entries.findIndex(e => e.id === entryId);
  if (idx === -1) {
    await interaction.reply({ content: 'Offer not found or already processed.', ephemeral: true });
    return;
  }
  entries[idx].status = isApprove ? 'approved' : 'denied';
  entries[idx].reviewedBy = interaction.user.id;
  entries[idx].reviewedAt = new Date().toISOString();
  writeStore(entries);

  const message = interaction.message;
  const embed = message.embeds?.[0];
  if (embed) {
    const baseFields = Array.isArray(embed.fields) ? embed.fields : [];
    const updated = EmbedBuilder.from(embed)
      .setColor(isApprove ? 0x57f287 : 0xed4245)
      .setFields(
        ...baseFields.filter(f => f.name !== 'Status' && f.name !== 'Reviewed By'),
        { name: 'Status', value: isApprove ? '✅ Approved' : '❌ Denied', inline: false },
        { name: 'Reviewed By', value: `<@${interaction.user.id}>`, inline: false },
      );
    await interaction.update({ embeds: [updated], components: [] });
  } else {
    await interaction.update({ content: isApprove ? 'Approved.' : 'Denied.', components: [] });
  }

  // Apply roster changes on approval
  if (isApprove) {
    try {
      const entry = entries[idx];
      const rosterData = readRoster(entry.team);
      if (!rosterData) {
        await interaction.followUp({ content: `Approved, but roster file not found for ${entry.team}.`, flags: 64 });
      } else {
        const { rosterPath, roster } = rosterData;
        const contractYears = parseInt(entry.years, 10) || entry.years;
        const salaryPerYear = entry.salary;
        upsertPlayer(roster, entry.player, {
          ovr: entry.ovr,
          contractYears,
          salaryPerYear,
          lastSigned: 'free agency',
          lastUpdatedBy: interaction.user.id,
          lastUpdatedAt: new Date().toISOString(),
        });
        removePlayerFromOtherRosters(entry.player, rosterPath);
        saveRoster(rosterPath, roster);
        await interaction.followUp({ content: `Roster updated for ${entry.team}: ${entry.player} signed.`, flags: 64 });
      }
      const log = readLog();
      log.push({
        id: entry.id,
        team: entry.team,
        player: entry.player,
        ovr: entry.ovr,
        years: entry.years,
        salary: entry.salary,
        reviewer: interaction.user.id,
        timestamp: new Date().toISOString(),
        action: 'approved',
      });
      writeLog(log);
    } catch (err) {
      console.error('[freeagency] Failed to update roster/log:', err);
      try { await interaction.followUp({ content: 'Approved, but roster/log update failed. Check logs.', flags: 64 }); } catch {}
    }
  }
}

export default {
  customId,
  execute,
  customId_modal_freeagency,
  execute_modal_freeagency,
  execute_review,
};
