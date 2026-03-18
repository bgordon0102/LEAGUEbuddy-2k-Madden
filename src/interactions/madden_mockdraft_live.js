import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { loadRoleMap } from '../madden/staff/staffUtils.js';
import {
  autoPickMockDraft,
  buildMockDraftOnClockEmbed,
  buildMockDraftPickEmbed,
  buildMockDraftSessionMessage,
  buildMockDraftTickerMessage,
  buildPickMenu,
  cancelMockDraftSession,
  coachTeamsForMember,
  createMockDraftSessionWithRoom,
  deleteMockDraftSession,
  endMockDraftSession,
  findActiveMockDraftSession,
  getMockDraftSession,
  joinMockDraftSession,
  leaveMockDraftSession,
  listUserAssignedSlots,
  makeMockDraftPick,
  simulateMockDraftPick,
  setMockDraftParticipantTeams,
  setMockDraftTickerActive,
  sessionLink,
  startMockDraftSession,
  syncMockDraftSessionMessage,
  updateMockDraftSession,
} from '../shared/madden_mock_draft_live.js';
import { getCoachAssignmentMap } from '../shared/madden_coach_assignments.js';

export const customId = /^madden_mockdraft(_live)?\|/;
const SCOUTING_HUB_CHANNEL_ID = '1460288930946482299';
const INVITE_REPLY_TTL_MS = 1000 * 60 * 20;

function inviteKey(sessionId, userId) {
  return `${sessionId}:${userId}`;
}

function privatePayload(content) {
  return { content, flags: 64 };
}

const SESSION_MAX_IDLE_MS = 1000 * 60 * 60 * 6;

function sessionIsUntouchedLobby(session) {
  return session
    && session.status === 'lobby'
    && Number(session.currentPickIndex || 0) === 0
    && (!Array.isArray(session.picks) || session.picks.length === 0)
    && (session.participants?.length || 0) <= 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMockDraftInviteDM(client, session, member) {
  const user = member?.user || await client.users.fetch(member?.id || '').catch(() => null);
  if (!user) return false;
  const roomLink = sessionLink(session);
  const assignedTeams = coachTeamsForMember(member);
  const teamText = assignedTeams.length ? assignedTeams.join(', ') : 'your league team';

  const inviteRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`madden_mockdraft_live|invite_accept|${session.id}`)
      .setLabel('Accept Invite')
      .setStyle(3),
    new ButtonBuilder()
      .setCustomId(`madden_mockdraft_live|invite_decline|${session.id}`)
      .setLabel('Decline')
      .setStyle(4),
  );

  const embed = new EmbedBuilder()
    .setTitle(`Private Mock Draft Invite • ${session.draftYear}`)
    .setColor(0x5865f2)
    .setDescription(
      `You’ve been invited to a private LEAGUEbuddy mock draft in scouting hub.${roomLink ? `\n\nOpen room: ${roomLink}` : `\n\nRoom: <#${session.channelId}>`}\n\nPress **Accept Invite** to join, or **Decline** to ignore it.`
    )
    .addFields(
      { name: 'Your Team', value: teamText, inline: false },
      {
        name: 'How It Works',
        value: 'The room carries the full first-round mock. CPU runs non-user picks. When your team is up, make your pick there or use `Sim My Pick`.',
        inline: false,
      },
      {
        name: 'What To Do',
        value: '1. Open the private room\n2. Follow the board as it moves\n3. Make your pick when your team is on the clock',
        inline: false,
      },
    );

  await user.send({ embeds: [embed], components: [inviteRow] }).catch(() => null);
  return true;
}

function pendingInviteFor(session, userId) {
  session.pendingInvites = session.pendingInvites || {};
  const key = String(userId);
  const invite = session.pendingInvites[key];
  if (!invite) return null;
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    delete session.pendingInvites[key];
    return null;
  }
  return invite;
}

function setPendingInvite(session, userId, hostId) {
  session.pendingInvites = session.pendingInvites || {};
  session.pendingInvites[String(userId)] = {
    hostId: String(hostId),
    createdAt: Date.now(),
    expiresAt: Date.now() + INVITE_REPLY_TTL_MS,
  };
}

function clearPendingInvite(session, userId) {
  if (!session?.pendingInvites) return;
  delete session.pendingInvites[String(userId)];
}

async function notifyHostInviteResult(client, session, hostId, message) {
  const host = await client.users.fetch(hostId).catch(() => null);
  await host?.send?.({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Mock Draft Invite Update').setDescription(message)] }).catch(() => null);
}

async function sendMockDraftSummaryDMs(client, sessionId) {
  const session = getMockDraftSession(sessionId);
  console.log(`[MockDraft] handleButton: sessionId=${sessionId}, session=`, session);
  if (!session || session.summarySentAt) return;
  // Show all picks for DM summary
  const allResults = (session.picks || [])
    .map((pick) => `Pick ${pick.pickNumber}: ${pick.teamName} — ${pick.prospectName} (${pick.position})${pick.userId !== 'auto' && pick.grade ? ` • ${pick.grade}` : ''}`)
    .join('\n') || 'No picks were made.';

  for (const participant of session.participants || []) {
    const user = await client.users.fetch(participant.userId).catch(() => null);
    if (!user) continue;
    const teamText = participant.teamNames?.length ? participant.teamNames.join(', ') : 'No assigned team';
    const userPickItems = (session.picks || []).filter((pick) => pick.userId === participant.userId);
    const userPicks = userPickItems
      .map((pick) => `${pick.pickNumber}. ${pick.teamName} — ${pick.prospectName} (${pick.position})${pick.grade ? ` • ${pick.grade}` : ''}`)
      .join('\n') || 'No coach-made picks in this mock.';
    const userRecaps = userPickItems
      .map((pick) => `Pick ${pick.pickNumber}: ${pick.synopsis || `${pick.teamName} selected ${pick.prospectName}.`}`)
      .join('\n') || 'No personal pick recap for this mock.';
    const summaryEmbed = new EmbedBuilder()
      .setTitle(`Mock Draft Summary • ${session.draftYear}`)
      .setColor(0x5865f2)
      .setDescription(`Your private mock draft is over. You were in it as ${teamText}.`)
      .addFields(
        { name: 'Your Picks', value: userPicks, inline: false },
        { name: 'Your Pick Recaps', value: userRecaps.slice(0, 1024), inline: false },
      );
    const fullResultsEmbed = new EmbedBuilder()
      .setTitle(`Full First Round • ${session.draftYear}`)
      .setColor(0x1e90ff)
      .setDescription(allResults.slice(0, 4096));
    await user.send({ embeds: [summaryEmbed, fullResultsEmbed] }).catch(() => null);
  }

  updateMockDraftSession(sessionId, (live) => {
    live.summarySentAt = Date.now();
    return live;
  });
}

async function cleanupPrivateDraftRoom(client, sessionId, reason = 'Mock draft complete.') {
  const session = getMockDraftSession(sessionId);
  console.log(`[MockDraft] handlePickSelect: sessionId=${sessionId}, session=`, session);
  if (!session || session.roomType !== 'private') {
    deleteMockDraftSession(sessionId);
    return;
  }
  const channel = await client.channels.fetch(session.channelId).catch(() => null);
  await channel?.send?.({ content: `${reason} This room will clean itself up shortly.` }).catch(() => null);
  setTimeout(async () => {
    const live = getMockDraftSession(sessionId) || session;
    const thread = await client.channels.fetch(live.channelId).catch(() => null);
    if (thread?.delete) {
      await thread.delete('Mock draft cleanup').catch(async () => {
        await thread.setLocked?.(true).catch(() => null);
        await thread.setArchived?.(true).catch(() => null);
      });
    }
    deleteMockDraftSession(sessionId);
  }, 15000);
}

async function runMockDraftTicker(client, sessionId, { forceCpu = false } = {}) {
  let session = getMockDraftSession(sessionId);
  if (!session || session.status !== 'live' || session.tickerActive) return;
  setMockDraftTickerActive(sessionId, true);
  try {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    while (true) {
      session = getMockDraftSession(sessionId);
      if (!session || session.status !== 'live') break;
      const currentOwner = session.pickOwners?.[String(session.currentPickIndex)] || null;
      if (currentOwner && !forceCpu) {
        // Public suspense: announce who's on the clock
        const onClockPayload = {
          content: `<@${currentOwner}> is on the clock! Please prepare your pick.`,
          embeds: [buildMockDraftOnClockEmbed(session)],
          components: buildOnClockAnnouncementComponents(session.id),
        };
        await channel?.send?.(onClockPayload).catch(() => null);
        // Private suspense: open pick panel for the coach
        // Optimize: use cached member if available
        const guild = client.guilds.cache.get(session.guildId) || await client.guilds.fetch(session.guildId).catch(() => null);
        const member = guild?.members.cache.get(currentOwner) || (guild ? await guild.members.fetch(currentOwner).catch(() => null) : null);
        // Do NOT send DM for pick panel. Only send ephemeral/private pick panel in main channel.
        break;
      }
      await delay(900);
      const next = autoPickMockDraft(sessionId, session.hostId);
      const madePick = next?.picks?.[next.picks.length - 1];
      if (!madePick) break;
      if (!next) {
        console.error('[MockDraft] runMockDraftTicker: next (session) is undefined before embed send.', {
          sessionId,
          madePick,
          channel: channel?.id
        });
        await channel?.send?.({
          embeds: [
            new EmbedBuilder()
              .setTitle('Pick Failed')
              .setColor(0xe74c3c)
              .setDescription('Pick failed due to an internal error (missing draft state).\nSessionId: ' + sessionId)
          ]
        });
        break;
      }
      // Detailed logging before embed send
      console.log('[MockDraft] runMockDraftTicker: About to send embed. Session:', {
        id: next.id,
        status: next.status,
        currentPickIndex: next.currentPickIndex,
        picks: next.picks,
        channelId: next.channelId,
        leagueId: next.leagueId
      });
      console.log('[MockDraft] runMockDraftTicker: About to send embed. Pick:', madePick);
      try {
        await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] });
      } catch (err) {
        console.error('[MockDraft] Error sending embed:', {
          next,
          madePick,
          error: err
        });
      }
      await syncMockDraftSessionMessage(client, next);
      if (next.status === 'done') break;
    }
    session = getMockDraftSession(sessionId);
    if (session?.status === 'done') {
      const channel = await client.channels.fetch(session.channelId).catch(() => null);
      await channel?.send?.({
        embeds: [
          new EmbedBuilder()
            .setTitle('Live Mock Complete')
            .setColor(0x2ecc71)
            .setDescription('The first-round mock is complete. Participant summaries are being sent now.'),
        ],
      }).catch(() => null);
      await syncMockDraftSessionMessage(client, session);
      await sendMockDraftSummaryDMs(client, sessionId);
      if (session.roomType === 'private') {
        await cleanupPrivateDraftRoom(client, sessionId, 'The private mock draft is finished.');
      }
    }
  } finally {
    setMockDraftTickerActive(sessionId, false);
  }
}

function buildPickControlComponents(sessionId, interaction) {
  // Only show 'Finish Draft With CPU' and 'End Here' to the host
  const session = getMockDraftSession(sessionId);
  const isHost = interaction && interaction.user && interaction.user.id === session?.hostId;
  const controls = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_mockdraft_live|simmypick|${sessionId}`)
        .setLabel('Sim My Pick')
        .setStyle(2),
      new ButtonBuilder()
        .setCustomId(`madden_mockdraft_live|search|${sessionId}`)
        .setLabel('Search Player')
        .setStyle(2),
    ),
  ];
  if (isHost) {
    controls.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|finishcpu|${sessionId}`)
          .setLabel('Finish Draft With CPU')
          .setStyle(1),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|endhere|${sessionId}`)
          .setLabel('End Here')
          .setStyle(4),
      )
    );
  }
  return controls;
}

function buildOnClockAnnouncementComponents(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`madden_mockdraft_live|pick|${sessionId}`)
        .setLabel('Open Private Pick Panel')
        .setStyle(1),
      new ButtonBuilder()
        .setCustomId(`madden_mockdraft_live|myteams|${sessionId}`)
        .setLabel('My Team Picks')
        .setStyle(2),
    ),
  ];
}

function buildPostPickControlComponents(sessionId) {
  return (interaction) => {
    const session = getMockDraftSession(sessionId);
    const isHost = interaction && interaction.user && interaction.user.id === session?.hostId;
    if (!isHost) {
      // Non-hosts get no controls
      return [];
    }
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|continuelive|${sessionId}`)
          .setLabel('Continue Live')
          .setStyle(3),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|search|${sessionId}`)
          .setLabel('Search Player')
          .setStyle(2),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|finishcpu|${sessionId}`)
          .setLabel('Finish Draft With CPU')
          .setStyle(1),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|endhere|${sessionId}`)
          .setLabel('End Here')
          .setStyle(4),
      ),
    ];
  };
}

function buildSearchModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(`madden_mockdraft_search|${sessionId}`)
    .setTitle('Search Draft Board')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('query')
          .setLabel('Player, position, or school')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50),
      ),
    );
}

function coachRoleIds() {
  const roleMap = loadRoleMap();
  return Object.entries(roleMap)
    .filter(([name, id]) => name.endsWith(' Coach') && id)
    .map(([, id]) => id);
}

async function buildCoachInviteOptions(guild, session) {
  if (!guild) return [];
  const membersById = new Map();

  const assignments = getCoachAssignmentMap({ guildId: guild.id });
  for (const userId of assignments?.userToTeams?.keys?.() || []) {
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (!member?.user || member.user.bot) continue;
    membersById.set(member.id, member);
  }

  if (!membersById.size) {
    const ids = coachRoleIds();
    for (const roleId of ids) {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
      if (!role) continue;
      if (role.members?.size) {
        for (const member of role.members.values()) {
          if (!member?.user || member.user.bot) continue;
          membersById.set(member.id, member);
        }
        continue;
      }
      const fetchedMembers = await Promise.all(
        [...guild.members.cache.keys()].map((memberId) => Promise.resolve(guild.members.cache.get(memberId)))
      ).catch(() => []);
      for (const member of fetchedMembers || []) {
        if (!member?.user || member.user.bot) continue;
        if (!member.roles?.cache?.has(roleId)) continue;
        membersById.set(member.id, member);
      }
    }
  }
  return [...membersById.values()]
    .filter((member) => member.id !== session.hostId)
    .sort((a, b) => {
      const aName = (a.displayName || a.user?.username || a.id).toLowerCase();
      const bName = (b.displayName || b.user?.username || b.id).toLowerCase();
      return aName.localeCompare(bName);
    })
    .map((member) => {
      const display = member.displayName || member.user?.globalName || member.user?.username || member.id;
      const username = member.user?.username || member.id;
      const assignedTeams = (assignments?.userToTeams?.get?.(member.id) || coachTeamsForMember({ guildId: guild.id, userId: member.id }) || []).filter(Boolean);
      const teamLabel = assignedTeams.length ? assignedTeams.join(' / ') : 'Unassigned Team';
      const joined = session.participants?.some((participant) => participant.userId === member.id);
      const inRoom = member.id === session.hostId || joined;
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${display} • ${teamLabel}`.slice(0, 100))
        .setDescription(`${username}${inRoom ? ' • already in room' : ''}`.slice(0, 100))
        .setValue(member.id)
        .setDefault(false);
    });
}

function buildInvitePickerPayload(session, inviteOptions = [], page = 0, content = null) {
  const totalPages = Math.max(1, Math.ceil(inviteOptions.length / 25));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const visibleOptions = inviteOptions.slice(safePage * 25, (safePage + 1) * 25);
  const embed = new EmbedBuilder()
    .setTitle('Invite Coaches')
    .setColor(0x5865f2)
    .setDescription(`Add league coaches to <#${session.channelId}>. The room itself holds the live draft and the only start controls.`)
    .addFields({
      name: 'Invite Pool',
      value: inviteOptions.length
        ? `${inviteOptions.length} league coaches available${totalPages > 1 ? ` • Page ${safePage + 1}/${totalPages}` : ''}`
        : 'No league coaches found to invite right now.',
      inline: false,
    });
  const components = [];
  if (visibleOptions.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`madden_mockdraft_invite|${session.id}|${safePage}`)
          .setPlaceholder('Invite league coaches to the draft room')
          .setMinValues(1)
          .setMaxValues(Math.min(10, visibleOptions.length))
          .addOptions(visibleOptions),
      ),
    );
  }
  if (totalPages > 1) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|invite_prev|${session.id}|${safePage}`)
          .setLabel('Prev Coaches')
          .setStyle(2)
          .setDisabled(safePage === 0),
        new ButtonBuilder()
          .setCustomId(`madden_mockdraft_live|invite_next|${session.id}|${safePage}`)
          .setLabel('Next Coaches')
          .setStyle(2)
          .setDisabled(safePage >= totalPages - 1),
      ),
    );
  }
  return {
    content: content || undefined,
    embeds: [embed],
    components,
  };
}

async function handleInviteSelect(interaction) {
  const [, sessionId, pageRaw] = String(interaction.customId || '').split('|');
  const session = sessionId ? getMockDraftSession(sessionId) : null;
  if (!session) {
    await interaction.reply(privatePayload('That mock draft session is no longer active.'));
    return;
  }
  if (interaction.user.id !== session.hostId) {
    await interaction.reply(privatePayload('Only the mock draft host can invite coaches.'));
    return;
  }

  const guild = interaction.guild;
  const page = Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 0;
  const selectedIds = Array.from(new Set(interaction.values || [])).filter(Boolean);
  if (!selectedIds.length) {
    await interaction.reply(privatePayload('No coaches selected.'));
    return;
  }

  await interaction.deferReply({ flags: 64 }).catch(() => null);

  let alreadyInRoom = 0;
  let alreadyPending = 0;
  let invited = 0;
  let dmFailed = 0;

  for (const userId of selectedIds) {
    const freshSession = getMockDraftSession(sessionId);
    if (!freshSession) break;

    const alreadyJoined = freshSession.participants?.some((p) => p.userId === userId);
    if (alreadyJoined) {
      alreadyInRoom += 1;
      continue;
    }

    const pending = pendingInviteFor(freshSession, userId);
    if (pending) {
      alreadyPending += 1;
      continue;
    }

    updateMockDraftSession(sessionId, (live) => {
      setPendingInvite(live, userId, live.hostId);
      return live;
    });

    const member = guild?.members?.cache?.get(userId) || await guild?.members?.fetch?.(userId).catch(() => null);
    if (!member) {
      dmFailed += 1;
      updateMockDraftSession(sessionId, (live) => {
        clearPendingInvite(live, userId);
        return live;
      });
      continue;
    }

    const ok = await sendMockDraftInviteDM(interaction.client, freshSession, member);

    if (ok) {
      invited += 1;
    } else {
      dmFailed += 1;
      updateMockDraftSession(sessionId, (live) => {
        clearPendingInvite(live, userId);
        return live;
      });
    }
  }

  const inviteOptions = await buildCoachInviteOptions(guild, getMockDraftSession(sessionId) || session);
  await interaction.editReply({
    ...buildInvitePickerPayload(session, inviteOptions, page),
    content: [
      invited ? `Invited: **${invited}**` : null,
      alreadyPending ? `Already pending: **${alreadyPending}**` : null,
      alreadyInRoom ? `Already in room: **${alreadyInRoom}**` : null,
      dmFailed ? `DM failed: **${dmFailed}** (check their DM privacy settings)` : null,
    ].filter(Boolean).join(' • ') || 'No invites sent.',
  }).catch(() => null);
}

async function handleButton(interaction) {
  const [, action, sessionId, pageRaw] = interaction.customId.split('|');
  const baseSession = sessionId ? getMockDraftSession(sessionId) : null;

  if (action === 'invite_prev' || action === 'invite_next') {
    if (!baseSession) {
      await interaction.reply(privatePayload('That mock draft session is no longer active.'));
      return;
    }
    if (interaction.user.id !== baseSession.hostId) {
      await interaction.reply(privatePayload('Only the mock draft host can edit invites.'));
      return;
    }
    const currentPage = Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 0;
    const inviteOptions = await buildCoachInviteOptions(interaction.guild, baseSession);
    const totalPages = Math.max(1, Math.ceil(inviteOptions.length / 25));
    const nextPage = action === 'invite_next'
      ? Math.min(totalPages - 1, currentPage + 1)
      : Math.max(0, currentPage - 1);
    await interaction.update(buildInvitePickerPayload(baseSession, inviteOptions, nextPage)).catch(() => null);
    return;
  }

  if (action === 'invite_accept' || action === 'invite_decline') {
    if (!baseSession) {
      await interaction.reply(privatePayload('That invite is no longer active.'));
      return;
    }
    const pending = pendingInviteFor(baseSession, interaction.user.id);
    if (!pending) {
      await interaction.reply(privatePayload('That invite is no longer pending (it may have expired).'));
      return;
    }

    if (action === 'invite_decline') {
      updateMockDraftSession(sessionId, (live) => {
        clearPendingInvite(live, interaction.user.id);
        return live;
      });
      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Invite Declined').setDescription('No worries — you can ignore this mock draft invite.')],
        components: [],
      });
      await notifyHostInviteResult(
        interaction.client,
        baseSession,
        pending.hostId,
        `<@${interaction.user.id}> declined the mock draft invite for ${baseSession.draftYear}.`,
      );
      return;
    }

    const joined = joinMockDraftSession(sessionId, interaction.user.id);
    updateMockDraftSession(sessionId, (live) => {
      clearPendingInvite(live, interaction.user.id);
      return live;
    });

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2ecc71)
          .setTitle('Invite Accepted')
          .setDescription(`You’re in. Open <#${baseSession.channelId}> to follow the mock and make picks when you’re on the clock.`),
      ],
      components: [],
    });

    await notifyHostInviteResult(
      interaction.client,
      baseSession,
      pending.hostId,
      `<@${interaction.user.id}> accepted the invite and joined the mock draft room.`,
    );

    await syncMockDraftSessionMessage(interaction.client, joined).catch(() => null);
    return;
  }

  if (action === 'create') {
    await interaction.deferReply({ flags: 64 });
    const scoutingHub = interaction.guild.channels.cache.get(SCOUTING_HUB_CHANNEL_ID)
      || await interaction.guild.channels.fetch(SCOUTING_HUB_CHANNEL_ID).catch(() => null);
    if (!scoutingHub?.threads?.create) {
      await interaction.editReply('Scouting hub is not available for private mock draft rooms right now.');
      return;
    }

    const existing = findActiveMockDraftSession(interaction.guildId, SCOUTING_HUB_CHANNEL_ID);
    let usableExisting = existing;
    if (usableExisting) {
      const existingChannel = await interaction.client.channels.fetch(usableExisting.channelId).catch(() => null);
      const existingMessage = usableExisting.messageId && existingChannel?.messages?.fetch
        ? await existingChannel.messages.fetch(usableExisting.messageId).catch(() => null)
        : null;
      const staleLegacy =
        usableExisting.roomType !== 'private'
        || usableExisting.originalChannelId !== SCOUTING_HUB_CHANNEL_ID;
      const inaccessible = !existingChannel || !existingMessage;
      const staleByAge = (Date.now() - Number(usableExisting.updatedAt || usableExisting.createdAt || 0)) > SESSION_MAX_IDLE_MS;
      if (staleLegacy || inaccessible || staleByAge) {
        endMockDraftSession(usableExisting.id, usableExisting.hostId);
        deleteMockDraftSession(usableExisting.id);
        usableExisting = null;
      }
    }
    if (usableExisting) {
      if (sessionIsUntouchedLobby(usableExisting) && usableExisting.hostId === interaction.user.id) {
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('Private Draft Room Ready')
              .setColor(0x5865f2)
              .setDescription(`Your private mock draft room is already waiting in scouting hub: <#${usableExisting.channelId}>.\n\nOpen that room to invite coaches and start the draft.`),
          ],
        });
        return;
      }
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('Private Draft Room Already Active')
            .setColor(0xf39c12)
            .setDescription(`There is already an active private mock draft room in scouting hub: <#${usableExisting.channelId}>.`),
        ],
      });
      return;
    }

    const roomName = `Mock Draft ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    const room = await scoutingHub.threads.create({
      name: roomName,
      autoArchiveDuration: 60,
      type: ChannelType.PrivateThread,
      reason: 'Private mock draft room',
      invitable: false,
    }).catch(() => null);
    if (!room) {
      await interaction.editReply('Could not create the private scouting-hub draft room.');
      return;
    }

    const session = createMockDraftSessionWithRoom({
      guildId: interaction.guildId,
      channelId: room.id,
      originalChannelId: SCOUTING_HUB_CHANNEL_ID,
      hostId: interaction.user.id,
      roomType: 'private',
    });
    setMockDraftParticipantTeams(session.id, interaction.user.id, coachTeamsForMember(interaction.member));
    await room.members.add(interaction.user.id).catch(() => null);
    const current = getMockDraftSession(session.id);
    const tickerMessage = await room.send(buildMockDraftSessionMessage(current));
    updateMockDraftSession(session.id, (draftSession) => {
      draftSession.messageId = tickerMessage.id;
      return draftSession;
    });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Private Draft Room Created')
          .setColor(0x2ecc71)
          .setDescription(`Your mock draft room is ready in scouting hub: <#${room.id}>.\n\nOpen that room to invite coaches and start the draft.`),
      ],
    });
    return;
  }

  const session = getMockDraftSession(sessionId);
  if (!session) {
    console.error(`[MockDraft] Session not found for sessionId: ${sessionId} (action: ${action})`);
    await interaction.reply(privatePayload('That mock draft session is no longer available. If you believe this is an error, please try again or contact support.'));
    return;
  }

  try {
    if (action === 'join') {
      if (session.roomType === 'private') {
        await interaction.reply(privatePayload('Private draft rooms add invited coaches directly. No separate join step is needed.'));
        return;
      }
      const next = joinMockDraftSession(sessionId, interaction.user.id);
      const withTeams = setMockDraftParticipantTeams(sessionId, interaction.user.id, coachTeamsForMember(interaction.member));
      await interaction.update(buildMockDraftSessionMessage(withTeams || next));
      return;
    }
    if (action === 'leave') {
      const next = leaveMockDraftSession(sessionId, interaction.user.id);
      await interaction.update(buildMockDraftSessionMessage(next));
      return;
    }
    if (action === 'start') {
      const next = startMockDraftSession(sessionId, interaction.user.id);
      if (session.roomType === 'private') {
        await syncMockDraftSessionMessage(interaction.client, next);
        await interaction.update({
          content: `Draft started in <#${next.channelId}>. The live mock now runs entirely inside that room.`,
          embeds: [],
          components: [],
        });
      } else {
        await interaction.update(buildMockDraftSessionMessage(next));
      }
      void runMockDraftTicker(interaction.client, sessionId);
      return;
    }
    if (action === 'invite') {
      if (session.hostId !== interaction.user.id) {
        await interaction.reply(privatePayload('Only the host can send invites for this mock draft.'));
        return;
      }
      await interaction.deferReply({ flags: 64 });
      const inviteOptions = await buildCoachInviteOptions(interaction.guild, session);
      const content = inviteOptions.length
        ? 'Choose the league coaches you want to add to the private draft room.'
        : 'No league coaches were found from current assignments yet. Make sure coach assignments are current, then try again.';
      await interaction.editReply(buildInvitePickerPayload(session, inviteOptions, 0, content));
      return;
    }
    if (action === 'invite_prev' || action === 'invite_next') {
      if (session.hostId !== interaction.user.id) {
        await interaction.reply(privatePayload('Only the host can send invites for this mock draft.'));
        return;
      }
      const inviteOptions = await buildCoachInviteOptions(interaction.guild, session);
      const currentPage = Number(pageRaw || 0);
      const delta = action === 'invite_next' ? 1 : -1;
      const nextPage = Math.max(0, currentPage + delta);
      await interaction.update(buildInvitePickerPayload(session, inviteOptions, nextPage));
      return;
    }
    if (action === 'cancel') {
      const next = cancelMockDraftSession(sessionId, interaction.user.id);
      if (session.roomType === 'private') {
        await interaction.update({ content: 'Private mock draft cancelled. The scouting-hub room will clean itself up.', embeds: [], components: [] });
        await sendMockDraftSummaryDMs(interaction.client, sessionId);
        await cleanupPrivateDraftRoom(interaction.client, sessionId, 'The private mock draft was cancelled.');
      } else {
        await interaction.update(buildMockDraftSessionMessage(next));
      }
      return;
    }
    if (action === 'end') {
      const next = endMockDraftSession(sessionId, interaction.user.id);
      if (session.roomType === 'private') {
        await interaction.update({ content: 'Private mock draft ended. The scouting-hub room will clean itself up.', embeds: [], components: [] });
        await sendMockDraftSummaryDMs(interaction.client, sessionId);
        await cleanupPrivateDraftRoom(interaction.client, sessionId, 'The private mock draft was ended by the host.');
      } else {
        await interaction.update(buildMockDraftSessionMessage(next));
      }
      return;
    }
    if (action === 'myteams') {
      const assigned = listUserAssignedSlots(session, interaction.user.id);
      const embed = new EmbedBuilder()
        .setTitle('My Team Picks')
        .setColor(0x5865f2)
        .setDescription(assigned.length
          ? assigned.map((item) => `${item.pickNumber}. ${item.teamName} — ${item.status}`).join('\n')
          : 'You do not control any live team picks in this session.');
      await interaction.reply({ embeds: [embed], flags: 64 });
      return;
    }
    if (action === 'pick') {
      const currentOwner = session.pickOwners?.[String(session.currentPickIndex)];
      if (!currentOwner) {
        console.error(`[MockDraft] No currentOwner found for pick index: ${session.currentPickIndex} in session: ${sessionId}`);
        await interaction.reply(privatePayload('No team is currently on the clock. Please wait for your turn or contact support if this persists.'));
        return;
      }
      if (currentOwner !== interaction.user.id) {
        await interaction.reply(privatePayload(`It is not your team on the clock right now. The current GM is <@${currentOwner}>.`));
        return;
      }
      await interaction.reply({
        content: 'Your private pick panel is open. This selection is only visible to you. Choose from the top of the board, search for a player, or let CPU simulate your pick.',
        components: [...buildPickMenu(session, currentOwner === interaction.user.id), ...buildPickControlComponents(session.id, interaction)],
        flags: 64,
      });
      return;
    }
    if (action === 'search') {
      await interaction.showModal(buildSearchModal(sessionId));
      return;
    }
    if (action === 'simmypick') {
      const next = simulateMockDraftPick(sessionId, interaction.user.id);
      await syncMockDraftSessionMessage(interaction.client, next);
      const madePick = next?.picks?.[next.picks.length - 1];
      const channel = await interaction.client.channels.fetch(next.channelId).catch(() => null);
      await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle('Pick Simulated')
            .setColor(0x5865f2)
            .setDescription(`CPU made your pick: **${madePick.pickNumber}. ${madePick.teamName} — ${madePick.prospectName} (${madePick.position})**.\n\nChoose whether to continue the live mock, finish the rest with CPU, or end it here.`),
        ],
        components: buildPostPickControlComponents(sessionId),
      });
      return;
    }
    if (action === 'auto') {
      const next = autoPickMockDraft(sessionId, interaction.user.id);
      const madePick = next?.picks?.[next.picks.length - 1];
      if (next.roomType === 'private') {
        await interaction.update({ content: 'CPU advanced the board.', embeds: [], components: [] });
        if (madePick) {
          const channel = await interaction.client.channels.fetch(next.channelId).catch(() => null);
          await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
        }
      } else {
        await interaction.update(buildMockDraftSessionMessage(next));
        if (madePick) {
          const channel = await interaction.client.channels.fetch(next.channelId).catch(() => null);
          await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
        }
      }
      void runMockDraftTicker(interaction.client, sessionId);
      return;
    }
    if (action === 'finishcpu') {
      await interaction.update({ content: 'CPU is finishing the rest of the first round...', embeds: [], components: [] });
      void runMockDraftTicker(interaction.client, sessionId, { forceCpu: true });
      return;
    }
    if (action === 'continuelive') {
      await interaction.update({ content: 'The live draft is moving again. It will pause again in this room at the next coach-controlled pick.', embeds: [], components: [] });
      void runMockDraftTicker(interaction.client, sessionId);
      return;
    }
    if (action === 'endhere') {
      const next = endMockDraftSession(sessionId, interaction.user.id);
      await syncMockDraftSessionMessage(interaction.client, next);
      await interaction.update({ content: 'Mock draft ended here. The scouting-hub room will clean itself up.', embeds: [], components: [] });
      if (session.roomType === 'private') {
        await sendMockDraftSummaryDMs(interaction.client, sessionId);
        await cleanupPrivateDraftRoom(interaction.client, sessionId, 'The private mock draft was ended early.');
      }
      return;
    }
  } catch (error) {
    const payload = privatePayload(error?.message || 'Mock draft action failed.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => null);
      return;
    }
    await interaction.reply(payload).catch(() => null);
  }
}

async function handlePickSelect(interaction) {
  const [, sessionId] = interaction.customId.split('|');
  const prospectId = interaction.values?.[0];
  const session = getMockDraftSession(sessionId);
  // Defer immediately. If we miss Discord's acknowledgement window we'll get 10062 (Unknown interaction).
  // In that case there's nothing we can send back to the user, so just log and return.
  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (err?.code === 10062) {
      console.warn('[MockDraft] PickSelect: interaction expired before deferUpdate()', { sessionId, prospectId, userId: interaction.user?.id });
      return;
    }
    throw err;
  }
  if (!session) {
    console.error(`[MockDraft] PickSelect: Session not found for sessionId: ${sessionId}`);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Pick Failed')
          .setColor(0xe74c3c)
          .setDescription(
            'This pick could not be submitted because the mock draft session is no longer active or has expired.'
            + '\nSessionId: ' + sessionId
          ),
      ],
      components: [],
    }).catch(() => null);
    return;
  }
  try {
    const next = makeMockDraftPick(sessionId, interaction.user.id, prospectId);
    await syncMockDraftSessionMessage(interaction.client, next);
    const madePick = next.picks[next.picks.length - 1];
    const channel = await interaction.client.channels.fetch(next.channelId).catch(() => null);
    await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
    const isHost = interaction && interaction.user && interaction.user.id === next.hostId;
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Pick Submitted')
          .setColor(0x5865f2)
          .setDescription(`Pick ${madePick.pickNumber} is locked in: **${madePick.teamName} — ${madePick.prospectName} (${madePick.position})**.`),
      ],
      components: isHost ? buildPostPickControlComponents(sessionId)(interaction) : [],
    }).catch(() => null);
    // Only prompt host to continue/end, others auto-advance
    if (!isHost) {
      void runMockDraftTicker(interaction.client, sessionId);
    }
  } catch (error) {
    const message = error?.message || 'That pick could not be submitted.';
    console.error('[MockDraft] handlePickSelect error', {
      sessionId,
      prospectId,
      userId: interaction.user?.id,
      name: error?.name,
      message: error?.message,
    });
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Pick Failed')
          .setColor(0xe74c3c)
          .setDescription(message + '\nSessionId: ' + sessionId)
      ],
      components: [],
    }).catch(() => null);
  }
}

async function handleSearchModal(interaction) {
  const [, sessionId] = interaction.customId.split('|');
  const session = getMockDraftSession(sessionId);
  if (!session) {
    await interaction.reply(privatePayload('That mock draft session is no longer available.'));
    return;
  }
  const query = String(interaction.fields.getTextInputValue('query') || '').trim().toLowerCase();
  const matches = (session.availableProspects || [])
    .filter((prospect) =>
      prospect.name.toLowerCase().includes(query)
      || prospect.position.toLowerCase().includes(query)
      || prospect.school.toLowerCase().includes(query))
    .slice(0, 25)
    .map((prospect) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${prospect.rank} ${prospect.name}`.slice(0, 100))
        .setDescription(`${prospect.position} • ${prospect.school}`.slice(0, 100))
        .setValue(prospect.id),
    );

  if (!matches.length) {
    await interaction.reply(privatePayload(`No draft-board matches found for "${query}".`));
    return;
  }

  await interaction.reply({
    content: `Search results for "${query}":`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`madden_mockdraft_pick|${sessionId}`)
          .setPlaceholder('Choose a matching prospect')
          .addOptions(matches),
      ),
      ...buildPickControlComponents(sessionId, interaction),
    ],
  });
}

async function execute(interaction) {
  if (interaction instanceof ButtonInteraction) {
    await handleButton(interaction);
    return;
  }
  if (interaction instanceof ModalSubmitInteraction) {
    await handleSearchModal(interaction);
    return;
  }
  if (interaction instanceof StringSelectMenuInteraction) {
    if (interaction.customId.startsWith('madden_mockdraft_invite|')) {
      await handleInviteSelect(interaction);
      return;
    }
    await handlePickSelect(interaction);
    return;
  }
  await interaction.reply(privatePayload('That action is not supported in this mock draft.'));
}

export default { customId, execute };
