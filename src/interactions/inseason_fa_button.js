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
import { readRoster, saveRoster, upsertPlayer, removePlayerFromOtherRostersFuzzy, normalizeName, computePlayerValue2k } from '../utils/rosterUtils.js';
import { getSeasonState } from '../utils/seasonUtils.js';

const FA_CHANNEL_ID = '1455148525179502602';
const ANNOUNCE_CHANNEL_ID = '1455152984089694218'; // offseason announcements channel (disabled during testing)
const OFFER_ALERT_CHANNEL_ID = process.env.FREE_AGENCY_OFFER_ALERT_CHANNEL_ID || '1425555647167987792';
const COACH_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'coachRoleMap.json');
const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');
const SEASON_PATH = path.join(process.cwd(), 'data', 'season.json');
const STAFF_REVIEW_CHANNEL_ID = '1455151770383814666';
const PENDING_FILE = path.join(process.cwd(), 'data', 'inseason_fa_pending.json');
// Role names that are allowed to approve/deny in-season free agents
const APPROVER_ROLE_NAMES = ['Paradise Commish', 'Paradise Co-Commish', 'League Buddy', 'LEAGUEbuddy Admin'];
const APPROVER_ROLE_IDS = ['1460399404241522759']; // explicit commish role to always tag
// Prefix used to tag the coach who submitted an offer (falls back to the user if the role is missing)
const COACH_TAG_PREFIX = 'Coach:';

function resolveTeamName(name) {
  const base = name.replace(/\s+coach$/i, '').trim();
  const cleaned = normalizeName(base);
  try {
    const teamsPath = path.join(process.cwd(), 'data', 'teams.json');
    const teams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
    const match = teams.find(t => {
      const n = normalizeName(t.name || '');
      return n === cleaned || n.includes(cleaned) || cleaned.includes(n);
    });
    if (match?.name) return match.name;
  } catch { /* ignore */ }
  return base;
}

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

function getStaffMention(guild) {
  const map = readStaffRoles();
  const ids = Array.from(
    new Set(
      Object.entries(map || {})
        .filter(([name]) => APPROVER_ROLE_NAMES.includes(name))
        .map(([, id]) => id)
        .filter(Boolean)
    )
  ).concat(APPROVER_ROLE_IDS);
  const validIds = guild?.roles?.cache ? ids.filter(id => guild.roles.cache.has(id)) : ids;
  return validIds.length ? validIds.map(id => `<@&${id}>`).join(' ') : '';
}

function getCoachMention(guild, team, coachMap) {
  const roleId = coachMap?.[team];
  const validRole = roleId && guild?.roles?.cache?.has(roleId);
  return validRole ? `<@&${roleId}>` : null;
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
  const players = Array.isArray(fa)
    ? fa
    : Array.isArray(fa?.players)
      ? fa.players
      : Array.isArray(fa?.roster)
        ? fa.roster
        : Array.isArray(fa?.roster?.players)
          ? fa.roster.players
          : [];
  return players.map(p => ({
    name: p.name,
    position: p.position || p.position_1 || '',
    ovr: p.ovr ?? '',
    age: p.age ?? computeSeasonAge(p.birthdate),
    img: p.imgUrl || p.imgURL || null,
  }));
}

export const customId = /^inseason_fa_(button|select|select_more|search_btn|search_modal|modal_.+|approve_.+|deny_.+)_?.*/;

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
    const sorted = faPlayers.sort(
      (a, b) => (parseFloat(b.ovr) || 0) - (parseFloat(a.ovr) || 0) || a.name.localeCompare(b.name)
    );

    const toOption = (p) => ({
      label: `${p.name}${p.position ? ` (${p.position})` : ''}${p.ovr ? ` OVR ${p.ovr}` : ''}`,
      value: normalizeName(p.name),
    });

    const firstOptions = sorted.slice(0, 25).map(toOption);
    const rows = [];
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('inseason_fa_select')
          .setPlaceholder('Top free agents')
          .addOptions(firstOptions)
      )
    );
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('inseason_fa_search_btn')
          .setLabel('Search all free agents')
          .setStyle(ButtonStyle.Secondary)
      )
    );

    await interaction.editReply({
      content: 'Select a free agent to sign.',
      components: rows,
    });
    return;
  }

  if (interaction.customId === 'inseason_fa_search_btn') {
    const modal = new ModalBuilder()
      .setCustomId('inseason_fa_search_modal')
      .setTitle('Search Free Agents');
    const queryInput = new TextInputBuilder()
      .setCustomId('fa_search_query')
      .setLabel('Player name (partial ok)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
    try {
      await interaction.showModal(modal);
    } catch (err) {
      if (err?.code !== 10062) console.error('[inseason_fa] search modal error', err);
    }
    return;
  }

  if (interaction.customId === 'inseason_fa_select' || interaction.customId === 'inseason_fa_select_more') {
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

  if (interaction.isModalSubmit() && interaction.customId === 'inseason_fa_search_modal') {
    const query = interaction.fields.getTextInputValue('fa_search_query')?.trim().toLowerCase();
    const tokens = (query || '').split(/\s+/).filter(Boolean);
    const faPlayers = loadFreeAgents();
    const matches = faPlayers.filter(p => {
      const name = (p.name || '').toLowerCase();
      return tokens.length
        ? tokens.every(t => name.includes(t))
        : name.includes(query);
    });
    if (!matches.length) {
      await interaction.reply({ content: 'No free agents matched that search.', flags: 64 });
      return;
    }
    const options = [];
    const seen = new Set();
    for (const p of matches) {
      const val = normalizeName(p.name);
      if (seen.has(val)) continue;
      seen.add(val);
      options.push({
        label: `${p.name}${p.position ? ` (${p.position})` : ''}${p.ovr ? ` OVR ${p.ovr}` : ''}`,
        value: val,
      });
      if (options.length >= 25) break;
    }
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('inseason_fa_select_more')
        .setPlaceholder('Search results')
        .addOptions(options)
    );
    await interaction.reply({ content: 'Select a free agent from search results.', components: [row], flags: 64 });
    return;
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
      const coachMention = getCoachMention(reviewChannel.guild, team, coachMap) || `<@${interaction.user.id}>`;
      const staffMention = getStaffMention(reviewChannel.guild);
      const content = [staffMention].filter(Boolean).join(' '); // only commish/co-commish
      const msg = await reviewChannel.send({ content, embeds: [embed], components: [buttons] });
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
    if (!entry || entry.alertSent) return;
    const channel = await client.channels.fetch(OFFER_ALERT_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const gpTag = '<@&1460733464721490108>'; // Ghost Paradise
    const embed = new EmbedBuilder()
      .setTitle('In-Season FA Request')
      .setColor(0xFEE75C)
      .addFields(
        { name: 'Team', value: entry.team || 'Unknown', inline: true },
        { name: 'Player', value: entry.player?.name || 'Unknown', inline: true },
        { name: 'Position', value: entry.player?.position || '—', inline: true },
        { name: 'OVR', value: entry.player?.ovr ? String(entry.player.ovr) : '—', inline: true },
        { name: 'Terms', value: `${entry.years || '—'} years${entry.salary ? ` | ${entry.salary}` : ''}`, inline: false },
      )
      .setFooter({ text: `Request ID: ${entry.id}` })
      .setTimestamp(new Date());
    const thumb = entry.player?.img || entry.player?.imgUrl || entry.player?.imgURL;
    if (thumb) embed.setThumbnail(thumb);

    await channel.send({ content: gpTag, embeds: [embed] });

    // mark alertSent
    const pending = readPending();
    if (pending[entry.id]) {
      pending[entry.id].alertSent = true;
      writePending(pending);
    }
  } catch (err) {
    console.error('[inseason_fa] Failed to send offer alert:', err);
  }
}

async function handleApproval(interaction, approve) {
  const id = interaction.customId.replace(approve ? 'inseason_fa_approve_' : 'inseason_fa_deny_', '');
  console.log('[inseason_fa][approve] start', { id, team: interaction.customId });
  // Gate to commish/co-commish only
  try {
    const staffMap = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    const allowedIds = Object.entries(staffMap || {})
      .filter(([name]) => APPROVER_ROLE_NAMES.includes(name))
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

  const rosterData = readRoster(entry.team, { force2k: true }) || readRoster(resolveTeamName(entry.team), { force2k: true });
  const rosterPath = rosterData?.rosterPath || rosterData?.path;
  const roster = rosterData?.roster || rosterData;
  console.log('[inseason_fa][approve] roster lookup', {
    entryTeam: entry.team,
    teamName: resolveTeamName(entry.team),
    found: !!rosterData,
    rosterPath,
    hasPlayers: Array.isArray(roster?.players),
  });
  if (!rosterData) {
    await interaction.editReply({ content: `Roster not found for ${resolveTeamName(entry.team)}.` });
    return;
  }
  // Preserve any existing contractYears if present; store offer details for reference
  const contractYears = Array.isArray(entry.player.contractYears) ? entry.player.contractYears : undefined;
  const playerValue = computePlayerValue2k(entry.player) || Number(entry.player.val ?? entry.player.value ?? entry.player.valuation ?? 0);

  upsertPlayer(roster, {
    ...entry.player,
    contractYears: contractYears || undefined,
    contractYearsText: entry.years || undefined,
    salaryPerYear: entry.salary || undefined,
    salaryText: entry.salary || undefined,
    val: playerValue || undefined,
    lastSigned: 'in-season free agency',
    lastUpdatedBy: interaction.user.id,
    lastUpdatedAt: new Date().toISOString(),
  });
  removePlayerFromOtherRostersFuzzy(entry.player.name, rosterPath);
  saveRoster(rosterPath, roster);

  // Announce signing
  try {
    const announceChannel = await interaction.client.channels.fetch(ANNOUNCE_CHANNEL_ID).catch(() => null);
    if (announceChannel && announceChannel.isTextBased()) {
      const gpTag = '<@&1460733464721490108>'; // Ghost Paradise
      const embed = new EmbedBuilder()
        .setTitle('In-Season Free Agent Signed')
        .setColor(0x57F287)
        .addFields(
          { name: 'Team', value: resolveTeamName(entry.team), inline: true },
          { name: 'Player', value: `${entry.player.name} (${entry.player.position || '—'})`, inline: true },
          { name: 'OVR', value: entry.player.ovr ? String(entry.player.ovr) : '—', inline: true },
          { name: 'Terms', value: `${entry.years || '—'} years${entry.salary ? ` | ${entry.salary}` : ''}`, inline: false },
        )
        .setTimestamp(new Date());
      const thumb = entry.player?.img || entry.player?.imgUrl || entry.player?.imgURL;
      if (thumb) embed.setThumbnail(thumb);
      await announceChannel.send({ content: gpTag, embeds: [embed] });
    }
  } catch (err) {
    console.error('[inseason_fa] failed to send announcement', err);
  }

  delete pending[id];
  writePending(pending);
  await interaction.editReply({ content: `Approved and signed ${entry.player.name} to ${entry.team}.` });
}

export default {
  customId,
  execute,
};
