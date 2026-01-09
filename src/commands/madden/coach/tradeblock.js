import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../../../madden/madden_data.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const BLOCK_FILE = path.join(process.cwd(), 'data', 'madden', 'trade_block.json');
const CHANNEL_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_channel_ids.json');

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase();
}

function findCoachTeam(member, roleMap, snapshot) {
  const coachRoles = Object.entries(roleMap).filter(([name]) => name.endsWith(' Coach'));
  const memberRole = coachRoles.find(([, id]) => member.roles.cache.has(id));
  if (!memberRole) return null;
  const raw = memberRole[0].replace(/ Coach$/, '');
  const target = normalizeName(raw);
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  for (const t of teams) {
    const names = [
      t.displayName,
      t.nickName,
      t.abbrName,
      t.cityName,
    ].map(normalizeName);
    if (names.includes(target)) return t.teamId;
  }
  return null;
}

function getRoster(snapshot, teamId) {
  return snapshot?.rosters?.teams?.[teamId]?.rosterInfoList || [];
}

function loadChannelMap() {
  try { return JSON.parse(fs.readFileSync(CHANNEL_MAP_FILE, 'utf8')); } catch { return {}; }
}

async function announce(client, roleMap, channelMap, teamName, playerLabelText, positionText, rosterId) {
  const coachRoleId = roleMap['Madden Coach'];
  const coachTag = coachRoleId ? `<@&${coachRoleId}>` : null;
  const tradeChannelId = channelMap['Trade Block'] || channelMap['Pending Trades'] || channelMap['Transaction Log'];
  if (!tradeChannelId) return;
  const channel = await client.channels.fetch(tradeChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  // Short customId: mtrade:team:rosterId:label (kept well under Discord limits)
  const safeTeam = encodeURIComponent((teamName || 'team').slice(0, 12));
  const safeId = rosterId ? String(rosterId).slice(0, 18) : 'p';
  let shortLabel = (playerLabelText || 'player').slice(0, 25);
  const base = `mtrade:${safeTeam}:${safeId}:`;
  const room = 90 - base.length; // ensure well under 100
  if (shortLabel.length > room) shortLabel = shortLabel.slice(0, Math.max(5, room));
  const customId = `${base}${encodeURIComponent(shortLabel)}`;
  const embed = {
    title: 'New Trade Block Addition',
    description: `${playerLabelText}\nTeam: ${teamName}`,
    color: 0x00AE86,
    timestamp: new Date().toISOString(),
  };
  const btn = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel('Trade For')
    .setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder().addComponents(btn);
  const msg = await channel.send({ content: coachTag || null, embeds: [embed], components: [row] }).catch(() => null);
  return msg?.id;
}

function getPositions(snapshot, teamId) {
  const roster = getRoster(snapshot, teamId);
  const set = new Set(roster.map(p => p.position).filter(Boolean));
  return Array.from(set).sort();
}

function playerLabel(p) {
  const fn = p.firstName || '';
  const ln = p.lastName || '';
  const name = `${fn} ${ln}`.trim() || (p.fullName || '').trim();
  return name || `#${p.rosterId}`;
}

function findPlayer(roster, name) {
  const target = normalizeName(name);
  return roster.find(p => normalizeName(playerLabel(p)) === target);
}

function formatDev(dev) {
  const map = { 0: 'Normal', 1: 'Star', 2: 'Superstar', 3: 'X-Factor' };
  const emojiMap = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'madden', 'dev_emojis.json'), 'utf8')); } catch { return {}; }
  })();
  const emojiId = emojiMap?.[dev] ?? emojiMap?.[String(dev)];
  if (emojiId) return `<:dev_${dev}:${emojiId}>`;
  return map[dev] || 'Normal';
}

const data = new SlashCommandBuilder()
  .setName('madden-tradeblock')
  .setDescription('Manage your Madden trade block (coaches only).')
  .addStringOption(o =>
    o.setName('action')
      .setDescription('add or remove')
      .setRequired(true)
      .addChoices(
        { name: 'add', value: 'add' },
        { name: 'remove', value: 'remove' },
      )
  )
  // Required player after action to satisfy Discord ordering
  .addStringOption(o =>
    o.setName('position')
      .setDescription('Filter by position')
      .setRequired(true)
      .addChoices(
        { name: 'All positions', value: 'ALL' },
        { name: 'QB', value: 'QB' },
        { name: 'HB', value: 'HB' },
        { name: 'FB', value: 'FB' },
        { name: 'WR', value: 'WR' },
        { name: 'TE', value: 'TE' },
        { name: 'LT', value: 'LT' },
        { name: 'LG', value: 'LG' },
        { name: 'C', value: 'C' },
        { name: 'RG', value: 'RG' },
        { name: 'RT', value: 'RT' },
        { name: 'LE', value: 'LE' },
        { name: 'RE', value: 'RE' },
        { name: 'DT', value: 'DT' },
        { name: 'LOLB', value: 'LOLB' },
        { name: 'MLB', value: 'MLB' },
        { name: 'ROLB', value: 'ROLB' },
        { name: 'CB', value: 'CB' },
        { name: 'FS', value: 'FS' },
        { name: 'SS', value: 'SS' },
        { name: 'K', value: 'K' },
        { name: 'P', value: 'P' }
      )
  )
  .addStringOption(o =>
    o.setName('player')
      .setDescription('Player name')
      .setRequired(true)
      .setAutocomplete(true)
  );

async function autocomplete(interaction) {
  let responded = false;
  const timeout = setTimeout(async () => {
    if (!responded) {
      responded = true;
      try { await interaction.respond([]); } catch {}
    }
  }, 1500);
  try {
    const focused = interaction.options.getFocused(true);
    const roleMap = loadJson(ROLE_MAP_FILE);
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) throw new Error('no league');
    const snapshot = loadLeagueSnapshot(leagueId);
    const teamId = findCoachTeam(interaction.member, roleMap, snapshot);
    if (!teamId) throw new Error('no team');
    const action = interaction.options.getString('action');
    const positionChoice = interaction.options.getString('position');
    const positionFilter = positionChoice === 'ALL' ? null : positionChoice;
    const roster = getRoster(snapshot, teamId);
    const block = loadJson(BLOCK_FILE);

    if (focused.name === 'player') {
      if (action === 'remove') {
        const existing = block[teamId] || [];
        const filtered = existing.filter(p => !positionFilter || p.position === positionFilter);
        const list = filtered.map(p => p.name).filter(n => !focused.value || n.toLowerCase().includes(focused.value.toLowerCase()));
        responded = true;
        clearTimeout(timeout);
        await interaction.respond(list.slice(0, 25).map(n => ({ name: n, value: n })));
        return;
      }
      const list = roster
        .filter(p => !positionFilter || p.position === positionFilter)
        .map(p => playerLabel(p))
        .filter(n => !focused.value || n.toLowerCase().includes(focused.value.toLowerCase()));
      responded = true;
      clearTimeout(timeout);
      await interaction.respond(list.slice(0, 25).map(n => ({ name: n, value: n })));
      return;
    }

    responded = true;
    clearTimeout(timeout);
    await interaction.respond([]);
  } catch (e) {
    if (!responded) {
      responded = true;
      clearTimeout(timeout);
      try { await interaction.respond([]); } catch {}
    }
  }
}

async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });
  try {
    const action = interaction.options.getString('action');
    const positionChoice = interaction.options.getString('position');
    const positionFilter = positionChoice === 'ALL' ? null : positionChoice;
    const playerName = interaction.options.getString('player');
    const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
    if (!leagueId) throw new Error('No league set. Run /madden-set-league first.');
    const snapshot = loadLeagueSnapshot(leagueId);
    const roleMap = loadJson(ROLE_MAP_FILE);
    const channelMap = loadChannelMap();
    const teamId = findCoachTeam(interaction.member, roleMap, snapshot);
    if (!teamId) {
      await interaction.editReply({ content: 'Could not determine your team from your coach role.' });
      return;
    }
    const roster = getRoster(snapshot, teamId);
    const block = loadJson(BLOCK_FILE);
    block[teamId] = block[teamId] || [];

    if (action === 'add') {
      const player = findPlayer(
        roster.filter(p => !positionFilter || p.position === positionFilter),
        playerName
      );
      if (!player) {
        await interaction.editReply({ content: 'Player not found on your roster (check position filter if set).' });
        return;
      }
      const already = block[teamId].some(p => p.rosterId === player.rosterId);
      if (already) {
        await interaction.editReply({ content: `${playerLabel(player)} is already on your trade block.` });
        return;
      }
      block[teamId].push({
        rosterId: player.rosterId,
        name: playerLabel(player),
        position: player.position,
        ovr: player.playerBestOvr || player.teamSchemeOvr || player.playerSchemeOvr || '',
        age: player.age || '',
        dev: formatDev(player.devTrait),
        messageId: null,
      });
      saveJson(BLOCK_FILE, block);
      await interaction.editReply({ content: `${playerLabel(player)} (${player.position}) added to your trade block.` });
      const teamName = (snapshot.teams?.leagueTeamInfoList || []).find(t => t.teamId === teamId)?.displayName || 'Team';
      const meta = `${playerLabel(player)} (${player.position}) — OVR ${player.playerBestOvr || player.teamSchemeOvr || player.playerSchemeOvr || 'N/A'}, Age ${player.age ?? 'N/A'}, Dev ${formatDev(player.devTrait)}`;
      const msgId = await announce(interaction.client, roleMap, channelMap, teamName, meta, player.position || 'N/A', player.rosterId);
      if (msgId) {
        block[teamId][block[teamId].length - 1].messageId = msgId;
        saveJson(BLOCK_FILE, block);
      }
      return;
    }

    if (action === 'remove') {
      const idx = block[teamId].findIndex(p => normalizeName(p.name) === normalizeName(playerName));
      if (idx === -1) {
        await interaction.editReply({ content: `${playerName} is not on your trade block.` });
        return;
      }
      const removed = block[teamId][idx];
      block[teamId].splice(idx, 1);
      saveJson(BLOCK_FILE, block);
      // try to delete the trade block message if we created one
      try {
        if (removed.messageId) {
          const tradeChannelId = channelMap['Trade Block'] || channelMap['Pending Trades'] || channelMap['Transaction Log'];
          if (tradeChannelId) {
            const channel = await interaction.client.channels.fetch(tradeChannelId).catch(() => null);
            if (channel && channel.isTextBased()) {
              const msg = await channel.messages.fetch(removed.messageId).catch(() => null);
              if (msg) await msg.delete().catch(() => null);
            }
          }
        }
      } catch { /* ignore */ }
      await interaction.editReply({ content: `${removed.name} removed from your trade block.` });
      return;
    }

    await interaction.editReply({ content: 'Invalid action.' });
  } catch (e) {
    await interaction.editReply({ content: `Trade block failed: ${e?.message || e}` });
  }
}

export default { data, execute, autocomplete };
