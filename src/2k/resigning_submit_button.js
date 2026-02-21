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
import { readRoster, saveRoster, upsertPlayer, removePlayerFromOtherRostersFuzzy, normalizeName } from '../shared/rosterUtils.js';
import { getSeasonState } from '../shared/seasonUtils.js';

const STORE_PATH = path.join(process.cwd(), 'data', 'resignings.json');
const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const STAFF_ROLES = ['Paradise Commish', 'Paradise Co-Commish', 'Schedule Tracker'];
const RESIGNING_LOG_PATH = path.join(process.cwd(), 'data', 'resigning_log.json');
const ANNOUNCE_CHANNEL_ID = process.env.FREE_AGENCY_ANNOUNCE_CHANNEL_ID || '1455152984089694218';
const STAFF_REVIEW_CHANNEL_ID = '1455151770383814666';
const GHOST_PARADISE_ROLE_ID = '1460733464721490108';
const SEASON_PATH = path.join(process.cwd(), 'data', 'season.json');

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
    return JSON.parse(fs.readFileSync(RESIGNING_LOG_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeLog(log) {
  try {
    fs.writeFileSync(RESIGNING_LOG_PATH, JSON.stringify(log ?? [], null, 2));
  } catch (err) {
    console.error('[resigning] Failed to write log:', err);
  }
}

function readCoachRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getStaffTags() {
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    return STAFF_ROLES.map(r => staffMap[r]).filter(Boolean).map(id => `<@&${id}>`).join(' ');
  } catch {
    return '';
  }
}

function getTeamFromMemberRoles(member) {
  const map = readCoachRoleMap(); // Team -> roleId
  if (!member?.roles?.cache) return null;
  const roleToTeam = Object.entries(map).reduce((acc, [team, roleId]) => {
    if (roleId) acc[roleId] = team;
    return acc;
  }, {});
  for (const [roleId] of member.roles.cache) {
    if (roleToTeam[roleId]) return roleToTeam[roleId];
  }
  return null;
}

function findPlayerDataAcrossRosters(targetName) {
  const targetNorm = normalizeName(targetName);
  const sources = [];
  try {
    const dir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const rosterArr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
      sources.push({ roster: rosterArr, team: file.replace('.json', '').replace(/_/g, ' ') });
    }
  } catch { }
  for (const src of sources) {
    const found = src.roster.find(p => {
      const n = normalizeName(p.name || '');
      return n === targetNorm || n.includes(targetNorm) || targetNorm.includes(n);
    });
    if (found) return { player: found, team: src.team };
  }
  return null;
}

function computeSeasonAge(birthdate) {
  if (!birthdate) return null;
  let seasonNo = 1;
  try {
    const seasonData = JSON.parse(fs.readFileSync(SEASON_PATH, 'utf8'));
    if (seasonData.seasonNo) seasonNo = Number(seasonData.seasonNo);
  } catch {
    // ignore
  }
  const seasonYear = 2024 + seasonNo; // season 1 = 2025
  const refDate = new Date(`${seasonYear}-10-20`);
  const birth = new Date(birthdate);
  if (Number.isNaN(birth.getTime())) return null;
  let age = refDate.getFullYear() - birth.getFullYear();
  if (refDate.getMonth() < birth.getMonth() || (refDate.getMonth() === birth.getMonth() && refDate.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

// One handler covers submit + approve/deny buttons
export const customId = /^resigning_(submit_button|approve|deny)_?.*/;

export async function execute(interaction) {
  // Lock during playoffs/offseason; allow during regular season through week 15
  const seasonState = getSeasonState();
  const cutoff = seasonState.tradeCutoff ?? 15;
  const isRegularOpen = seasonState.phase === 'regular' && seasonState.currentWeek <= cutoff;
  const isOffseasonOpen = seasonState.phase === 'offseason';
  if (!(isRegularOpen || isOffseasonOpen)) {
    await interaction.reply({ content: `Re-signing is open Weeks 1-${cutoff} and in the offseason. Locked Weeks 16-29 and during playoffs. Current week: ${seasonState.currentWeek}, phase: ${seasonState.phase}.`, ephemeral: true });
    return;
  }
  if (interaction.customId.startsWith('resigning_submit_button')) {
    const inferredTeam = getTeamFromMemberRoles(interaction.member);
    const modal = new ModalBuilder()
      .setCustomId('resigning_modal_submit')
      .setTitle('Submit Re-Signing Offer')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('team')
            .setLabel('Team Name')
            .setPlaceholder('e.g., New York Knicks')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(inferredTeam || ''),
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
            .setCustomId('terms')
            .setLabel('Years / Salary')
            .setPlaceholder('e.g., 3 years, $18M per year')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
  // Approve/deny buttons
  await execute_review(interaction);
}

export const customId_modal_resigning = 'resigning_modal_submit';

export async function execute_modal_resigning(interaction) {
  const team = interaction.fields.getTextInputValue('team');
  const player = interaction.fields.getTextInputValue('player');
  const terms = interaction.fields.getTextInputValue('terms') || '';

  await interaction.deferReply({ ephemeral: true });

  const found = findPlayerDataAcrossRosters(player);
  const resolvedName = found?.player?.name || player;
  const position = found?.player?.position || found?.player?.position_1 || found?.player?.position1 || null;
  const ovr = found?.player?.ovr ?? null;
  const age = found?.player?.age ?? computeSeasonAge(found?.player?.birthdate);
  const thumbnail = found?.player?.imgUrl || found?.player?.imgURL || null;

  const entry = {
    id: `${Date.now()}`,
    team,
    player: resolvedName,
    position,
    ovr,
    age,
    thumbnail,
    terms,
    status: 'pending',
    submittedBy: interaction.user.id,
    submittedAt: new Date().toISOString(),
  };

  const entries = readStore();
  entries.push(entry);
  writeStore(entries);

  // Duplicate guard: block if player exists on another roster
  let dupeTeams = [];
  try {
    const dir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const full = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const roster = Array.isArray(data) ? data : data.players || [];
      if (!Array.isArray(roster)) continue;
      const found = roster.find(p => p?.name && p.name.toLowerCase() === player.toLowerCase());
      if (found) {
        dupeTeams.push(file.replace('.json', '').replace(/_/g, ' '));
      }
    }
  } catch (err) {
    console.error('[resigning] Duplicate scan failed:', err);
  }
  if (dupeTeams.length) {
    await interaction.editReply({ content: `Warning: ${player} already exists on ${dupeTeams.join(', ')}. Approver should resolve before finalizing.` });
  }

  const embed = new EmbedBuilder()
    .setTitle('Re-Signing Offer')
    .setColor(0x1e90ff)
    .addFields(
      { name: 'Team', value: team, inline: true },
      { name: 'Player', value: resolvedName, inline: true },
      { name: 'Position', value: position || '—', inline: true },
      { name: 'OVR', value: ovr != null ? String(ovr) : '—', inline: true },
      { name: 'Age', value: age != null ? String(age) : '—', inline: true },
      { name: 'Terms', value: terms || '—', inline: false },
      { name: 'Submitted By', value: `<@${interaction.user.id}>`, inline: false },
      { name: 'Status', value: 'Pending staff review', inline: false },
    )
    .setFooter({ text: `Offer ID: ${entry.id}` })
    .setTimestamp(new Date());
  const thumb =
    thumbnail ||
    found?.player?.imgUrl ||
    found?.player?.imgURL ||
    found?.player?.image ||
    found?.player?.img ||
    null;
  if (thumb) embed.setThumbnail(thumb);

  const approveBtn = new ButtonBuilder()
    .setCustomId(`resigning_approve_${entry.id}`)
    .setLabel('Approve')
    .setStyle(ButtonStyle.Success);
  const denyBtn = new ButtonBuilder()
    .setCustomId(`resigning_deny_${entry.id}`)
    .setLabel('Deny')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder().addComponents(approveBtn, denyBtn);

  try {
    const reviewChannel = await interaction.client.channels.fetch(STAFF_REVIEW_CHANNEL_ID);
    if (reviewChannel && reviewChannel.isTextBased()) {
      await reviewChannel.send({
        content: `${getStaffTags()}`,
        embeds: [embed],
        components: [row],
      });
    } else {
      await interaction.channel.send({ content: `${getStaffTags() || 'Staff review needed'}`, embeds: [embed], components: [row] });
    }
  } catch (err) {
    console.error('[resigning] Failed to send review message:', err);
    await interaction.channel.send({ content: `${getStaffTags() || 'Staff review needed'}`, embeds: [embed], components: [row] });
  }

  await interaction.editReply({ content: 'Re-signing offer submitted for staff review.' });
}

export async function execute_review(interaction) {
  const isApprove = interaction.customId.startsWith('resigning_approve_');
  const entryId = interaction.customId.replace('resigning_approve_', '').replace('resigning_deny_', '');

  // Staff gate
  let allowedRoleIds = [];
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    allowedRoleIds = STAFF_ROLES.map(r => staffMap[r]).filter(Boolean);
  } catch (err) {
    console.error('[resigning] Failed to read staffRoleMap.main.json:', err);
  }
  const memberRoles = interaction.member?.roles?.cache;
  const isStaff = allowedRoleIds.length ? allowedRoleIds.some(rid => memberRoles?.has(rid)) : true;
  if (!isStaff) {
    await interaction.reply({ content: 'Only staff may approve or deny re-signing offers.', ephemeral: true });
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

  // Update embed
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
        const found = findPlayerDataAcrossRosters(entry.player);
        const payload = {
          ...(found?.player || {}),
          name: found?.player?.name || entry.player,
          position: entry.position || found?.player?.position || found?.player?.position_1 || found?.player?.position1,
          ovr: entry.ovr ?? found?.player?.ovr,
          age: entry.age ?? computeSeasonAge(found?.player?.birthdate),
          terms: entry.terms || undefined,
          lastSigned: 'resigning',
          lastUpdatedBy: interaction.user.id,
          lastUpdatedAt: new Date().toISOString(),
        };
        upsertPlayer(roster, payload.name, payload);
        removePlayerFromOtherRostersFuzzy(payload.name, rosterPath);
        saveRoster(rosterPath, roster);
        await interaction.followUp({ content: `Roster updated for ${entry.team}: ${payload.name} re-signed.`, flags: 64 });

        // Announce re-signing in announcements channel
        try {
          const announceChannel = await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
          if (announceChannel && announceChannel.isTextBased()) {
            const coachMap = readCoachRoleMap();
            const roleId = coachMap[entry.team];
            const embed = new EmbedBuilder()
              .setTitle(`Re-Signed: ${payload.name}`)
              .setColor(0x1e90ff)
              .addFields(
                { name: 'Team', value: entry.team, inline: true },
                { name: 'OVR', value: payload.ovr != null ? String(payload.ovr) : '-', inline: true },
                { name: 'Terms', value: entry.terms || '—', inline: false },
              )
              .setFooter({ text: `Re-signing ID: ${entry.id}` })
              .setTimestamp(new Date());
            const thumb = found?.player?.imgUrl || found?.player?.imgURL || payload.imgUrl || payload.imgURL;
            if (thumb) embed.setThumbnail(thumb);
            await announceChannel.send({
              content: `${roleId ? `<@&${roleId}>` : ''} <@&${GHOST_PARADISE_ROLE_ID}> ${payload.name} re-signed with ${entry.team}.`,
              embeds: [embed],
            });
          }
        } catch (err) {
          console.error('[resigning] Failed to announce:', err);
        }
      }
      const log = readLog();
      log.push({
        id: entry.id,
        team: entry.team,
        player: entry.player,
        ovr: entry.ovr,
        terms: entry.terms,
        reviewer: interaction.user.id,
        timestamp: new Date().toISOString(),
        action: 'approved',
      });
      writeLog(log);
    } catch (err) {
      console.error('[resigning] Failed to update roster/log:', err);
      try { await interaction.followUp({ content: 'Approved, but roster/log update failed. Check logs.', flags: 64 }); } catch { }
    }
  }
}

export default {
  customId,
  execute,
  customId_modal_resigning,
  execute_modal_resigning,
  execute_review,
};
