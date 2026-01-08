import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import { readRoster, saveRoster, upsertPlayer, removePlayerFromOtherRostersFuzzy, normalizeName } from '../utils/rosterUtils.js';
import { getSeasonState } from '../utils/seasonUtils.js';

const FA_CHANNEL_ID = '1455148525179502602';
const GHOST_PARADISE_ROLE_ID = '1428119680572325929';
const ANNOUNCE_CHANNEL_ID = '1455152984089694218'; // offseason announcements channel
const OFFER_ALERT_CHANNEL_ID = process.env.FREE_AGENCY_OFFER_ALERT_CHANNEL_ID || '1425555647167987792';
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const SEASON_PATH = path.join(process.cwd(), 'data', 'season.json');
const STAFF_REVIEW_CHANNEL_ID = '1455151770383814666';
const PENDING_FILE = path.join(process.cwd(), 'data', 'inseason_fa_pending.json');

function readCoachRoleMap() {
  try {
    return JSON.parse(fs.readFileSync(COACH_ROLE_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function readStaffRoles() {
  try {
    return JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getStaffMention() {
  const map = readStaffRoles();
  const ALLOWED = ['Paradise Commish', 'Paradise Co-Commish'];
  const ids = Array.from(
    new Set(
      Object.entries(map || {})
        .filter(([name]) => ALLOWED.includes(name))
        .map(([, id]) => id)
        .filter(Boolean)
    )
  );
  return ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '';
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writePending(data) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data ?? {}, null, 2));
  } catch (err) {
    console.error('[inseason_fa] Failed to write pending approvals:', err);
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

function loadFreeAgents() {
  const fa = readRoster('free agency');
  const players = fa?.roster?.players || [];
  return players.map(p => ({
    name: p.name,
    position: p.position || p.position_1 || '',
    ovr: p.ovr ?? '',
    age: p.age ?? computeSeasonAge(p.birthdate),
    img: p.imgUrl || p.imgURL || null,
  }));
}

export const customId = /^inseason_fa_(button|select|modal_.+|approve_.+|deny_.+)_?.*/;

export async function execute(interaction) {
  const state = getSeasonState();
  if (state.phase === 'offseason' || state.phase === 'playoffs') {
    await interaction.reply({ content: 'In-season free agency is available Weeks 1-29. It is locked during playoffs and the offseason.', ephemeral: true });
    return;
  }
  if (interaction.isModalSubmit() && interaction.customId.startsWith('inseason_fa_modal_')) {
    await handleModalSubmit(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('inseason_fa_approve_')) {
    await handleApproval(interaction, true);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('inseason_fa_deny_')) {
    await handleApproval(interaction, false);
    return;
  }

  if (interaction.customId === 'inseason_fa_button') {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      if (err?.code === 10062) return;
      throw err;
    }
    const faPlayers = loadFreeAgents();
    if (!faPlayers.length) {
      await interaction.editReply({ content: 'No free agents available.', components: [] });
      return;
    }
    // Top 25 by OVR (desc), fallback 0
    const options = faPlayers
      .sort((a, b) => (parseFloat(b.ovr) || 0) - (parseFloat(a.ovr) || 0) || a.name.localeCompare(b.name))
      .slice(0, 25)
      .map(p => ({
        label: `${p.name}${p.position ? ` (${p.position})` : ''}${p.ovr ? ` OVR ${p.ovr}` : ''}`,
        value: normalizeName(p.name),
      }));
    const menu = new StringSelectMenuBuilder()
      .setCustomId('inseason_fa_select')
      .setPlaceholder('Select a free agent')
      .addOptions(options);
    const row = new ActionRowBuilder().addComponents(menu);
    await interaction.editReply({
      content: 'Select a free agent to sign. (List limited to first 25; contact staff if missing.)',
      components: [row],
    });
    return;
  }

  if (interaction.customId === 'inseason_fa_select') {
    // No defer here; showModal must be first response
    const selected = interaction.values[0];
    const faPlayers = loadFreeAgents();
    const player = faPlayers.find(p => normalizeName(p.name) === selected);
    if (!player) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Free agent not found. Please retry.', flags: 64 });
      }
      return;
    }
    const team = getTeamFromMemberRoles(interaction.member);
    if (!team) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Could not detect your team from roles. Contact staff.', flags: 64 });
      }
      return;
    }
    // Launch modal to collect contract details
    const encoded = Buffer.from(player.name, 'utf8').toString('base64');
    const modal = new ModalBuilder()
      .setCustomId(`inseason_fa_modal_${encoded}`)
      .setTitle(`Sign ${player.name}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('years')
            .setLabel('Years')
            .setPlaceholder('e.g., 2')
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('salary')
            .setLabel('Avg Salary (per yr)')
            .setPlaceholder('e.g., $10M')
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      );
    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err?.code !== 10062) {
        console.error('[inseason_fa] showModal failed:', err);
      }
    }
  }
}

async function handleModalSubmit(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if (err?.code === 10062) return;
    throw err;
  }
  const encoded = interaction.customId.replace('inseason_fa_modal_', '');
  const playerName = Buffer.from(encoded, 'base64').toString('utf8');
  const team = getTeamFromMemberRoles(interaction.member);
  if (!team) {
    await interaction.editReply({ content: 'Could not detect your team from roles. Contact staff.' });
    return;
  }
  const faPlayers = loadFreeAgents();
  const player = faPlayers.find(p => normalizeName(p.name) === normalizeName(playerName));
  if (!player) {
    await interaction.editReply({ content: 'Free agent not found. Please retry.' });
    return;
  }

  const years = interaction.fields.getTextInputValue('years') || '';
  const salary = interaction.fields.getTextInputValue('salary') || '';
  const pending = readPending();
  const exists = Object.values(pending || {}).find(entry =>
    entry.team === team && normalizeName(entry.player?.name || entry.player) === normalizeName(player.name)
  );
  if (exists) {
    await interaction.editReply({ content: 'Request already submitted and pending review.' });
    return;
  }

  const requestId = `${Date.now()}`;
  pending[requestId] = {
    id: requestId,
    player: {
      ...player,
      img: player.img || player.imgUrl || player.imgURL || null,
      thumbnail: player.img || player.imgUrl || player.imgURL || null,
    },
    team,
    years,
    salary,
    coachId: interaction.user.id,
    createdAt: new Date().toISOString(),
    alertSent: false,
    staffMessageId: null,
  };
  writePending(pending);

  await sendOfferAlert(interaction.client, pending[requestId]);

  // Send to staff review channel
  try {
    const reviewChannel = await interaction.client.channels.fetch(STAFF_REVIEW_CHANNEL_ID).catch(() => null);
    if (reviewChannel && reviewChannel.isTextBased()) {
      const coachMap = readCoachRoleMap();
      const roleId = coachMap[team];
      const thumb = player.img || player.imgUrl || player.imgURL || null;
      const embed = new EmbedBuilder()
        .setTitle(`In-Season FA Request: ${player.name}`)
        .setColor(0xFEE75C)
        .addFields(
          { name: 'Team', value: team, inline: true },
          { name: 'Coach', value: roleId ? `<@&${roleId}>` : `<@${interaction.user.id}>`, inline: true },
          { name: 'Position', value: player.position || '—', inline: true },
          { name: 'OVR', value: player.ovr ? String(player.ovr) : '—', inline: true },
          { name: 'Age', value: player.age ? String(player.age) : '—', inline: true },
          { name: 'Terms', value: `${years || '—'} years${salary ? ` | ${salary}` : ''}`, inline: false },
        )
        .setFooter({ text: `Request ID: ${requestId}` })
        .setTimestamp(new Date());
      if (thumb) embed.setThumbnail(thumb);
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`inseason_fa_approve_${requestId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`inseason_fa_deny_${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
      );
      const latest = readPending();
      if (latest[requestId]?.staffMessageId) {
        // already sent
        return;
      }
      const msg = await reviewChannel.send({ content: getStaffMention(), embeds: [embed], components: [buttons] });
      if (latest[requestId]) {
        latest[requestId].staffMessageId = msg.id;
        writePending(latest);
      }
    }
  } catch (err) {
    console.error('[inseason_fa] Failed to send staff review:', err);
  }

  await interaction.editReply({ content: `Submitted to staff for approval (ID: ${requestId}).` });
}

async function sendOfferAlert(client, entry) {
  try {
    const pending = readPending();
    const stored = pending[entry.id];
    if (stored?.alertSent) return;
    if (stored) {
      stored.alertSent = true;
      writePending(pending);
    }
    const channel = await client.channels.fetch(OFFER_ALERT_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const expireTs = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const embed = new EmbedBuilder()
      .setTitle(`New In-Season FA Offer: ${entry.player.name}`)
      .setColor(0xf1c40f)
      .setDescription('You have an hour to send in an offer before they sign.')
      .addFields(
        { name: 'Position', value: entry.player.position || '—', inline: true },
        { name: 'OVR', value: entry.player.ovr ? String(entry.player.ovr) : '—', inline: true },
        { name: 'Timer', value: `<t:${expireTs}:R>`, inline: true },
      );
    if (entry.player.thumbnail || entry.player.img || entry.player.imgUrl || entry.player.imgURL) {
      const thumb = entry.player.thumbnail || entry.player.img || entry.player.imgUrl || entry.player.imgURL;
      embed.setThumbnail(thumb);
    }
    await channel.send({
      content: `<@&${GHOST_PARADISE_ROLE_ID}> ${entry.team} placed an in-season FA offer for ${entry.player.name}.`,
      embeds: [embed],
    });
  } catch (err) {
    console.error('[inseason_fa] Failed to send offer alert:', err);
  }
}

async function handleApproval(interaction, approve) {
  const id = interaction.customId.replace(approve ? 'inseason_fa_approve_' : 'inseason_fa_deny_', '');
  // Gate to commish/co-commish only
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const allowedRoles = ['Paradise Commish', 'Paradise Co-Commish'];
    const allowedIds = Object.entries(staffMap || {})
      .filter(([name]) => allowedRoles.includes(name))
      .map(([, rid]) => rid)
      .filter(Boolean);
    const memberRoles = interaction.member?.roles?.cache;
    const isStaff = allowedIds.length ? allowedIds.some(rid => memberRoles?.has(rid)) : false;
    if (!isStaff) {
      await interaction.reply({ content: 'Only Commish/Co-Commish can approve or deny in-season FA offers.', flags: 64 });
      return;
    }
  } catch {
    // if map missing, deny to be safe
    await interaction.reply({ content: 'Staff role map missing. Only Commish/Co-Commish may act.', flags: 64 });
    return;
  }
  const pending = readPending();
  const entry = pending[id];
  if (!entry) {
    try {
      await interaction.reply({ content: 'Request not found or already processed.', flags: 64 });
    } catch (err) {
      if (err?.code !== 10062) throw err;
    }
    return;
  }
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    if (err?.code === 10062) return;
    throw err;
  }
  // disable buttons
  try {
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`noop_${id}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(true),
      new ButtonBuilder().setCustomId(`noop2_${id}`).setLabel('Deny').setStyle(ButtonStyle.Danger).setDisabled(true)
    );
    await interaction.message.edit({ components: [disabledRow] });
  } catch {}

  if (!approve) {
    delete pending[id];
    writePending(pending);
    await interaction.editReply({ content: `Denied in-season FA request for ${entry.player.name}.` });
    return;
  }

  const rosterData = readRoster(entry.team);
  if (!rosterData) {
    await interaction.editReply({ content: `Roster not found for ${entry.team}.` });
    return;
  }
  const { rosterPath, roster } = rosterData;
  upsertPlayer(roster, entry.player.name, {
    ...entry.player,
    contractYears: entry.years || undefined,
    salaryPerYear: entry.salary || undefined,
    lastSigned: 'in-season free agency',
    lastUpdatedBy: interaction.user.id,
    lastUpdatedAt: new Date().toISOString(),
  });
  removePlayerFromOtherRostersFuzzy(entry.player.name, rosterPath);
  saveRoster(rosterPath, roster);

  // Announce (same channel as offseason announcements)
  try {
    const announceChannel = await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (announceChannel && announceChannel.isTextBased()) {
      const coachMap = readCoachRoleMap();
      const roleId = coachMap[entry.team];
       const thumb = entry.player.img || entry.player.imgUrl || entry.player.imgURL || entry.player.thumbnail || null;
      const embed = new EmbedBuilder()
        .setTitle(`In-Season Signing: ${entry.player.name}`)
        .setColor(0x57f287)
        .addFields(
          { name: 'Team', value: entry.team, inline: true },
          { name: 'Position', value: entry.player.position || '—', inline: true },
          { name: 'OVR', value: entry.player.ovr ? String(entry.player.ovr) : '—', inline: true },
          { name: 'Age', value: entry.player.age ? String(entry.player.age) : '—', inline: true },
          { name: 'Terms', value: `${entry.years || '—'} years${entry.salary ? ` | ${entry.salary}` : ''}`, inline: false },
        )
        .setTimestamp(new Date());
      if (thumb) embed.setThumbnail(thumb);
      await announceChannel.send({
        content: `${roleId ? `<@&${roleId}>` : ''} <@&${GHOST_PARADISE_ROLE_ID}> ${entry.player.name} signed with ${entry.team}.`,
        embeds: [embed],
      });
    }
  } catch (err) {
    console.error('[inseason_fa] Failed to announce:', err);
  }

  delete pending[id];
  writePending(pending);
  await interaction.editReply({ content: `Approved and signed ${entry.player.name} to ${entry.team}.` });
}

export default {
  customId,
  execute,
};
