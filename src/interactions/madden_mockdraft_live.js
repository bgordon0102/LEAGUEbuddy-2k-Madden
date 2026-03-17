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
  setMockDraftParticipantTeams,
  setMockDraftTickerActive,
  sessionLink,
  startMockDraftSession,
  syncMockDraftSessionMessage,
  updateMockDraftSession,
} from '../shared/madden_mock_draft_live.js';
import { getCoachAssignmentMap } from '../shared/madden_coach_assignments.js';

export const customId = /^madden_mockdraft_(live|pick|invite|search)\|/;
const SCOUTING_HUB_CHANNEL_ID = '1460288930946482299';

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

async function sendMockDraftSummaryDMs(client, sessionId) {
  const session = getMockDraftSession(sessionId);
  if (!session || session.summarySentAt) return;
  const allResults = (session.picks || [])
    .map((pick) => `${pick.pickNumber}. ${pick.teamName} — ${pick.prospectName} (${pick.position})${pick.userId !== 'auto' && pick.grade ? ` • ${pick.grade}` : ''}`)
    .join('\n') || 'No picks were made.';
  const topOfBoard = (session.picks || [])
    .slice(0, 8)
    .map((pick) => `${pick.pickNumber}. ${pick.teamName} — ${pick.prospectName} (${pick.position})${pick.userId !== 'auto' && pick.grade ? ` • ${pick.grade}` : ''}`)
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
        { name: 'Top Of The Mock', value: topOfBoard, inline: false },
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
        const onClockPayload = {
          content: `<@${currentOwner}> you are on the clock. Make your pick in this room.`,
          embeds: [buildMockDraftOnClockEmbed(session)],
          components: [
            ...buildPickMenu(session),
            ...buildPickControlComponents(session.id),
          ],
        };
        await channel?.send?.(onClockPayload).catch(() => null);
        break;
      }
      await delay(900);
      const next = autoPickMockDraft(sessionId, session.hostId);
      const madePick = next?.picks?.[next.picks.length - 1];
      if (!madePick) break;
      await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
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

function buildPickControlComponents(sessionId) {
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

async function handleButton(interaction) {
  const [, action, sessionId, pageRaw] = interaction.customId.split('|');

  if (action === 'create') {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Start Mock Draft')
          .setColor(0x5865f2)
          .setDescription('This mock draft now runs in one private-prep mode only.\n\nIt creates a clean private draft room in the scouting hub, no matter where you launch it. Flow: create room, invite coaches, start draft, then the room self-cleans after the draft ends.'),
      ],
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: 'madden_mockdraft_live|create_private', label: 'Create Private Draft Room' },
          ],
        },
      ],
      flags: 64,
    });
    return;
  }

  if (action === 'create_private') {
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
    await interaction.reply(privatePayload('That mock draft session is no longer available.'));
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
      const inviteOptions = await buildCoachInviteOptions(interaction.guild, session);
      const content = inviteOptions.length
        ? 'Choose the league coaches you want to add to the private draft room.'
        : 'No league coaches were found from current assignments yet. Make sure coach assignments are current, then try again.';
      await interaction.reply({ ...buildInvitePickerPayload(session, inviteOptions, 0, content), flags: 64 });
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
      if (currentOwner !== interaction.user.id) {
        await interaction.reply(privatePayload(`It is not your team on the clock right now. The current GM is <@${currentOwner}>.`));
        return;
      }
      await interaction.reply({
        content: 'Choose from the top of the current board. The draft will auto-sim forward again after your pick.',
        components: [...buildPickMenu(session), ...buildPickControlComponents(session.id)],
        flags: 64,
      });
      return;
    }
    if (action === 'search') {
      await interaction.showModal(buildSearchModal(sessionId));
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
    await interaction.reply(privatePayload(error?.message || 'Mock draft action failed.'));
  }
}

async function handlePickSelect(interaction) {
  const [, sessionId] = interaction.customId.split('|');
  const prospectId = interaction.values?.[0];
  const session = getMockDraftSession(sessionId);
  if (!session) {
    await interaction.update({ content: 'That mock draft session is no longer available.', embeds: [], components: [] });
    return;
  }
  try {
    const next = makeMockDraftPick(sessionId, interaction.user.id, prospectId);
    await syncMockDraftSessionMessage(interaction.client, next);
    const madePick = next.picks[next.picks.length - 1];
    const channel = await interaction.client.channels.fetch(next.channelId).catch(() => null);
    await channel?.send?.({ embeds: [buildMockDraftPickEmbed(next, madePick)] }).catch(() => null);
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Pick Submitted')
          .setColor(0x5865f2)
          .setDescription(`Pick ${madePick.pickNumber} is locked in: **${madePick.teamName} — ${madePick.prospectName} (${madePick.position})**.\n\nChoose whether to continue the live mock, finish the rest with CPU, or end it here.`),
      ],
      components: buildPickControlComponents(sessionId),
    });
  } catch (error) {
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('Pick Failed')
          .setColor(0xe74c3c)
          .setDescription(error?.message || 'That pick could not be submitted.'),
      ],
      components: [],
    });
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
      ...buildPickControlComponents(sessionId),
    ],
    flags: 64,
  });
}

async function handleInviteSelect(interaction) {
  const [, sessionId, pageRaw] = interaction.customId.split('|');
  const session = getMockDraftSession(sessionId);
  if (!session) {
    await interaction.update({ content: 'That mock draft session is no longer available.', embeds: [], components: [] });
    return;
  }
  if (session.hostId !== interaction.user.id) {
    await interaction.update({ content: 'Only the host can invite coaches into this room.', embeds: [], components: [] });
    return;
  }
  const channel = await interaction.client.channels.fetch(session.channelId).catch(() => null);
  if (session.roomType !== 'private_inline' && !channel?.members?.add) {
    await interaction.update({ content: 'This draft room is not accepting invites right now.', embeds: [], components: [] });
    return;
  }
  const allowedCoachIds = new Set((await buildCoachInviteOptions(interaction.guild, session)).map((option) => option.data.value));
  const invited = [];
  for (const userId of interaction.values || []) {
    if (!allowedCoachIds.has(userId)) continue;
    try {
      if (session.roomType !== 'private_inline') {
        await channel.members.add(userId);
      }
      joinMockDraftSession(sessionId, userId);
      setMockDraftParticipantTeams(sessionId, userId, coachTeamsForMember(await interaction.guild.members.fetch(userId).catch(() => null)));
      invited.push(`<@${userId}>`);
    } catch {}
  }
  const refreshed = getMockDraftSession(sessionId);
  const inviteOptions = await buildCoachInviteOptions(interaction.guild, refreshed);
  const page = Number(pageRaw || 0);
  await interaction.update({
    content: invited.length
      ? session.roomType === 'private'
        ? `Added ${invited.join(', ')} to <#${session.channelId}>. Start the draft from inside that room when you are ready.`
        : `Invited ${invited.join(', ')} to <#${session.channelId}>. They can press \`Join\` inside the room when they are ready.`
      : 'No invites were sent.',
    ...buildInvitePickerPayload(refreshed, inviteOptions, page),
  });
}

export async function execute(interaction) {
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
  }
}

export default { customId, execute };
