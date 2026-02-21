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

const STORE_PATH = path.join(process.cwd(), 'data', 'freeagency_entries.json');
const STAFF_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const STAFF_ROLES = ['Paradise Commish', 'Paradise Co-Commish', 'Schedule Tracker'];
const STAFF_OFFER_CHANNEL_ID = process.env.FREE_AGENCY_STAFF_CHANNEL_ID || '1455151770383814666';
const ANNOUNCE_CHANNEL_ID = process.env.FREE_AGENCY_ANNOUNCE_CHANNEL_ID || '1455152984089694218';
const OFFER_ALERT_CHANNEL_ID = process.env.FREE_AGENCY_OFFER_ALERT_CHANNEL_ID || '1425555647167987792';
const GHOST_PARADISE_ROLE_ID = '1460733464721490108';
const SEASON_PATH = path.join(process.cwd(), 'data', 'season.json');

// Data store helpers
function readEntries() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries ?? [], null, 2));
}

function readCoachRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
  } catch {
    return {};
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
  const dist = (a, b) => {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost,
        );
      }
    }
    return dp[m][n];
  };
  // free agency roster first
  const fa = readRoster('free agency');
  const sources = [];
  if (Array.isArray(fa)) sources.push({ roster: fa, team: 'free agency' });
  else if (Array.isArray(fa?.players)) sources.push({ roster: fa.players, team: 'free agency' });
  else if (Array.isArray(fa?.roster)) sources.push({ roster: fa.roster, team: 'free agency' });
  else if (Array.isArray(fa?.roster?.players)) sources.push({ roster: fa.roster.players, team: 'free agency' });
  try {
    const dir = path.join(process.cwd(), 'data', 'teams_rosters');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const rosterArr = Array.isArray(data) ? data : (Array.isArray(data.players) ? data.players : []);
      sources.push({ roster: rosterArr, team: file.replace('.json', '').replace(/_/g, ' ') });
    }
  } catch {
    // ignore
  }
  for (const src of sources) {
    const found = src.roster.find(p => {
      const n = normalizeName(p.name || '');
      if (!n) return false;
      if (n === targetNorm || n.includes(targetNorm) || targetNorm.includes(n)) return true;
      // fuzzy: allow small typos
      return dist(n, targetNorm) <= 2;
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

function buildFAEmbed(entry, statusText = 'Open for offers') {
  const embed = new EmbedBuilder()
    .setTitle(`Free Agent: ${entry.player}`)
    .setColor(entry.status === 'signed' ? 0x57f287 : 0x5865f2)
    .setDescription(
      [
        `<@&${GHOST_PARADISE_ROLE_ID}>`,
        'Click the button to submit your offer (coaches only). Staff will review and finalize.',
        `Status: ${statusText}`,
      ].join('\n'),
    )
    .setFooter({ text: `FA ID: ${entry.id}` });
  if (entry.thumbnail) {
    embed.setThumbnail(entry.thumbnail);
  }
  embed.addFields(
    { name: 'Position', value: entry.position || '-', inline: true },
    { name: 'OVR', value: entry.ovr != null ? String(entry.ovr) : '-', inline: true },
    { name: 'Age', value: entry.age != null ? String(entry.age) : '-', inline: true },
  );
  return embed;
}

function buildStaffEmbed(entry) {
  const lines = entry.offers?.length
    ? entry.offers.map(o => `• ${o.team}${o.note ? ` — ${o.note}` : ''}`)
    : ['No offers yet'];
  const embed = new EmbedBuilder()
    .setTitle(`FA Review: ${entry.player}`)
    .setColor(entry.status === 'signed' ? 0x57f287 : 0x5865f2)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setFooter({ text: `FA ID: ${entry.id}` });
  if (entry.thumbnail) embed.setThumbnail(entry.thumbnail);
  return embed;
}

function chunkButtons(buttons, size = 5) {
  const rows = [];
  const limited = buttons.slice(0, 25); // Discord max components per message
  for (let i = 0; i < limited.length; i += size) {
    rows.push(new ActionRowBuilder().addComponents(limited.slice(i, i + size)));
  }
  return rows;
}

function getStaffRoleMentions() {
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    return STAFF_ROLES.map(r => staffMap[r]).filter(Boolean).map(id => `<@&${id}>`).join(' ');
  } catch {
    return '';
  }
}

// Custom IDs
export const customId = /^freeagency_(staff_add_button|staff_add_modal|offer_[a-zA-Z0-9]+|offer_modal_[a-zA-Z0-9]+|staff_pick_[a-zA-Z0-9]+_.+)_?.*/;
export const customId_modal_staff_add = 'freeagency_staff_add_modal';
export const customId_modal_offer_prefix = 'freeagency_offer_modal_';

// Staff add button handler (from pinned message)
export async function execute(interaction) {
  // Handle modal submits first so we don't try to showModal on them
  if (interaction.isModalSubmit()) {
    if (interaction.customId === customId_modal_staff_add) {
      await execute_modal_staff_add(interaction);
      return;
    }
    if (interaction.customId.startsWith(customId_modal_offer_prefix)) {
      await execute_modal_offer(interaction);
      return;
    }
  }

  if (!interaction.isButton()) {
    return;
  }

  if (interaction.customId === 'freeagency_staff_add_button') {
    // Staff gate
    try {
      const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
      const allowedRoleIds = STAFF_ROLES.map(r => staffMap[r]).filter(Boolean);
      const memberRoles = interaction.member?.roles?.cache;
      const isStaff = allowedRoleIds.length ? allowedRoleIds.some(rid => memberRoles?.has(rid)) : true;
      if (!isStaff) {
        await interaction.reply({ content: 'Staff only.', ephemeral: true });
        return;
      }
    } catch {
      // allow if map missing
    }
    const modal = new ModalBuilder()
      .setCustomId(customId_modal_staff_add)
      .setTitle('Add Free Agent (Staff)')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('player')
            .setLabel('Player Name')
            .setPlaceholder('e.g., LeBron James')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId.startsWith('freeagency_offer_')) {
    const entryId = interaction.customId.replace('freeagency_offer_', '');
    const modal = new ModalBuilder()
      .setCustomId(`${customId_modal_offer_prefix}${entryId}`)
      .setTitle('Submit Offer')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Offer details (years, salary, terms)')
            .setPlaceholder('e.g., 3 years, $18M per year')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId.startsWith('freeagency_staff_pick_')) {
    await handleStaffPick(interaction);
    return;
  }
}

// Staff add modal submit
export async function execute_modal_staff_add(interaction) {
  const player = interaction.fields.getTextInputValue('player');
  await interaction.deferReply({ flags: 64 });

  // Fuzzy match to existing players for canonical name/thumbnail
  const match = findPlayerDataAcrossRosters(player);
  const displayName = match?.player?.name || player;
  const thumbnail = match?.player?.imgUrl || match?.player?.imgURL || null;
  const position = match?.player?.position || match?.player?.position_1 || match?.player?.position1 || null;
  const ovr = match?.player?.ovr ?? null;
  const age = match?.player?.age ?? computeSeasonAge(match?.player?.birthdate);

  const entry = {
    id: `${Date.now()}`,
    player: displayName,
    thumbnail,
    position,
    ovr,
    age,
    status: 'open',
    offers: [],
  };
  const entries = readEntries();
  entries.push(entry);
  writeEntries(entries);

  // Post to FA channel (same channel)
  const offerBtn = new ButtonBuilder()
    .setCustomId(`freeagency_offer_${entry.id}`)
    .setLabel('Submit Offer')
    .setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder().addComponents(offerBtn);
  const faMessage = await interaction.channel.send({
    content: `<@&${GHOST_PARADISE_ROLE_ID}> Free agent available`,
    embeds: [buildFAEmbed(entry)],
    components: [row],
  });

  entry.faMessageId = faMessage.id;
  entry.faChannelId = faMessage.channelId;
  writeEntries(entries);

  await interaction.editReply({ content: `Free agent posted: ${player}` });
}

// Coach offer modal submit
export async function execute_modal_offer(interaction) {
  const entryId = interaction.customId.replace(customId_modal_offer_prefix, '');
  const note = interaction.fields.getTextInputValue('note') || '';
  await interaction.deferReply({ flags: 64 });

  const entries = readEntries();
  const entry = entries.find(e => e.id === entryId);
  if (!entry || entry.status === 'signed') {
    await interaction.editReply({ content: 'This free agent is no longer accepting offers.' });
    return;
  }

  const team = getTeamFromMemberRoles(interaction.member);
  if (!team) {
    await interaction.editReply({ content: 'Could not detect your team from roles. Contact staff.' });
    return;
  }

  // upsert offer by team
  entry.offers = entry.offers || [];
  const existingIdx = entry.offers.findIndex(o => o.team === team);
  const offer = {
    team,
    coachId: interaction.user.id,
    note,
    submittedAt: new Date().toISOString(),
  };
  if (existingIdx !== -1) entry.offers[existingIdx] = offer;
  else entry.offers.push(offer);
  writeEntries(entries);

  await interaction.editReply({ content: 'Offer submitted. Staff will review.' });

  await sendOfferAlert(interaction.client, entry, team, note);
  await sendOrUpdateStaffMessage(interaction.client, entry);
}

async function sendOrUpdateStaffMessage(client, entry) {
  try {
    const staffChannel = await client.channels.fetch(STAFF_OFFER_CHANNEL_ID).catch(() => null);
    if (!staffChannel || !staffChannel.isTextBased()) return;

    const buttons = (entry.offers || []).map(o =>
      new ButtonBuilder()
        .setCustomId(`freeagency_staff_pick_${entry.id}_${o.team.replace(/ /g, '_')}`)
        .setLabel(o.team)
        .setStyle(ButtonStyle.Success)
    );
    const rows = buttons.length ? chunkButtons(buttons) : [];
    const embed = buildStaffEmbed(entry);

    if (entry.staffMessageId) {
      try {
        const msg = await staffChannel.messages.fetch(entry.staffMessageId);
        await msg.edit({ embeds: [embed], components: rows });
        return;
      } catch {
        // fallthrough to send new
      }
    }
    const msg = await staffChannel.send({
      content: getStaffRoleMentions() || 'Staff review needed',
      embeds: [embed],
      components: rows,
    });
    entry.staffMessageId = msg.id;
    const entries = readEntries();
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx !== -1) {
      entries[idx] = entry;
      writeEntries(entries);
    }
  } catch (err) {
    console.error('[freeagency] Failed to send/update staff message:', err);
  }
}

async function sendOfferAlert(client, entry, team, note) {
  try {
    if (entry.alertSent) return;
    const channel = await client.channels.fetch(OFFER_ALERT_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const expireTs = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const embed = new EmbedBuilder()
      .setTitle(`New FA Offer: ${entry.player}`)
      .setColor(0xf1c40f)
      .setDescription(`Offer placed by ${team}. You have an hour to send in an offer before they sign.`)
      .addFields(
        { name: 'Position', value: entry.position || '-', inline: true },
        { name: 'OVR', value: entry.ovr != null ? String(entry.ovr) : '-', inline: true },
        { name: 'Timer', value: `<t:${expireTs}:R>`, inline: true },
      );
    if (note) {
      embed.addFields({ name: 'Offer Details', value: note.slice(0, 1024) });
    }
    if (entry.thumbnail) embed.setThumbnail(entry.thumbnail);
    await channel.send({
      content: `<@&${GHOST_PARADISE_ROLE_ID}> New offer for ${entry.player}.`,
      embeds: [embed],
    });
    // persist alertSent
    const entries = readEntries();
    const idx = entries.findIndex(e => e.id === entry.id);
    if (idx !== -1) {
      entries[idx].alertSent = true;
      writeEntries(entries);
    }
  } catch (err) {
    console.error('[freeagency] Failed to send offer alert:', err);
  }
}

async function handleStaffPick(interaction) {
  const parts = interaction.customId.split('_');
  const entryId = parts[3];
  const teamEncoded = parts.slice(4).join('_');
  const team = teamEncoded.replace(/_/g, ' ');
  // Gate to commish/co-commish only
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_MAP_PATH, 'utf8'));
    const allowedRoles = ['Paradise Commish', 'Paradise Co-Commish'];
    const allowedIds = Object.entries(staffMap || {})
      .filter(([name]) => allowedRoles.includes(name))
      .map(([, id]) => id)
      .filter(Boolean);
    const memberRoles = interaction.member?.roles?.cache;
    const isStaff = allowedIds.length ? allowedIds.some(rid => memberRoles?.has(rid)) : true;
    if (!isStaff) {
      await interaction.reply({ content: 'Only Commish/Co-Commish can finalize free agency signings.', flags: 64 });
      return;
    }
  } catch {
    // if map missing, allow by default
  }
  await interaction.deferReply({ flags: 64 });

  const entries = readEntries();
  const entry = entries.find(e => e.id === entryId);
  if (!entry) {
    await interaction.editReply({ content: 'Free agent entry not found.' });
    return;
  }
  if (entry.status === 'signed') {
    await interaction.editReply({ content: `Already signed by ${entry.signedTeam}.` });
    return;
  }

  // Disable buttons to prevent double-processing
  try {
    const disabledRows = interaction.message.components?.map(row => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components = newRow.components.map(btn => ButtonBuilder.from(btn).setDisabled(true));
      return newRow;
    });
    if (disabledRows?.length) {
      await interaction.message.edit({ components: disabledRows });
    }
  } catch {
    // non-fatal
  }

  const offer = (entry.offers || []).find(o => o.team === team);
  if (!offer) {
    await interaction.editReply({ content: 'Offer not found for that team.' });
    return;
  }

  // Move player to team
  let roster = readRoster(team);
  if (!roster) {
    await interaction.editReply({ content: `Roster not found for ${team}.` });
    return;
  }
  roster = Array.isArray(roster) ? roster : (Array.isArray(roster?.players) ? roster.players : []);
  if (!Array.isArray(roster)) {
    await interaction.editReply({ content: `Roster format invalid for ${team}.` });
    return;
  }
  const found = findPlayerDataAcrossRosters(entry.player);
  const payload = {
    ...(found?.player || {}),
    name: found?.player?.name || entry.player,
    lastSigned: 'free agency',
    lastUpdatedBy: interaction.user.id,
    lastUpdatedAt: new Date().toISOString(),
  };
  upsertPlayer(roster, payload);
  removePlayerFromOtherRostersFuzzy(payload.name);
  saveRoster(team, roster);

  entry.status = 'signed';
  entry.signedTeam = team;
  writeEntries(entries);

  await interaction.editReply({ content: `Signed ${entry.player} to ${team}.` });

  // Update staff message
  await sendOrUpdateStaffMessage(interaction.client, entry);

  // Update FA message to show signed and disable button
  try {
    if (entry.faChannelId && entry.faMessageId) {
      const faChannel = await interaction.client.channels.fetch(entry.faChannelId).catch(() => null);
      if (faChannel && faChannel.isTextBased()) {
        const msg = await faChannel.messages.fetch(entry.faMessageId).catch(() => null);
        if (msg) {
          const embed = buildFAEmbed(entry, `Signed by ${team}`);
          await msg.edit({
            embeds: [embed],
            components: [],
          });
        }
      }
    }
  } catch (err) {
    console.error('[freeagency] Failed to update FA message:', err);
  }

  // Announce signing in announce channel tagging coach role
  try {
    const coachMap = readCoachRoleMap();
    const roleId = coachMap[team];
    const announceChannel = await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (announceChannel && announceChannel.isTextBased()) {
      const noteText = offer.note ? `Offer: ${offer.note}` : '';
      const embed = new EmbedBuilder()
        .setTitle(`Free Agency Signing: ${entry.player}`)
        .setColor(0x57f287)
        .addFields(
          { name: 'Team', value: team, inline: true },
          { name: 'Position', value: entry.position || '-', inline: true },
          { name: 'OVR', value: entry.ovr != null ? String(entry.ovr) : '-', inline: true },
          { name: 'Age', value: entry.age != null ? String(entry.age) : '-', inline: true },
        )
        .setFooter({ text: `FA ID: ${entry.id}` });
      if (entry.thumbnail) embed.setThumbnail(entry.thumbnail);
      await announceChannel.send({
        content: `${roleId ? `<@&${roleId}>` : ''} <@&${GHOST_PARADISE_ROLE_ID}> ${entry.player} signed with ${team} via free agency. ${noteText}`.trim(),
        embeds: [embed],
      });
    }
  } catch (err) {
    console.error('[freeagency] Failed to announce signing:', err);
  }
}

export default {
  customId,
  execute,
};
