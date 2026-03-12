import { ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import fs from 'fs';
import path from 'path';

console.log('[set_game_info_2k] File loaded and ready');

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', '2k', 'nba_role_ids.json');
const COMMISH_FALLBACK = ['1460734128935665817', '1460734222238220326'];

const loadRoleMap = () => {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
};

const resolveCommishRoleIds = () => {
  const roleMap = loadRoleMap();
  return Array.from(new Set([
    roleMap['Ghost Paradise Commish'],
    roleMap['Ghost Paradise Co-Commish'],
    ...COMMISH_FALLBACK,
  ].filter(Boolean)));
};

const resolveCommishMentions = () => {
  const ids = resolveCommishRoleIds();
  return ids.map(id => `<@&${id}>`);
};

export const customId = /^set_game_info\|(.+)$/;
export const customId_modal = /^set_game_info_modal\|(.+)$/;

export async function execute(interaction) {
  if (!(interaction instanceof ButtonInteraction)) return;
  const [, threadId] = interaction.customId.match(customId) || [];
  if (!threadId) return;

  const modal = new ModalBuilder()
    .setCustomId(`set_game_info_modal|${threadId}`)
    .setTitle('Set Game Info')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('ingame_date')
          .setLabel('In-game date')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. March 31st')
      )
    );

  try { await interaction.showModal(modal); }
  catch (err) {
    console.error('[set_game_info_2k][button] Failed to show modal:', err);
    try { await interaction.reply({ content: 'Could not open modal.', flags: 64 }); } catch {}
  }
}

export async function execute_modal(interaction) {
  if (!interaction.isModalSubmit()) return;
  const [, threadId] = interaction.customId.match(customId_modal) || [];
  if (!threadId) return;

  const dateText = interaction.fields.getTextInputValue('ingame_date')?.trim();
  if (!dateText) {
    try { await interaction.reply({ content: 'Please provide an in-game date.', flags: 64 }); } catch {}
    return;
  }

  let msg = interaction.message;
  if (!msg && interaction.channel?.messages?.fetch) {
    try {
      const fetched = await interaction.channel.messages.fetch({ limit: 5 });
      msg = fetched?.first();
    } catch {}
  }
  if (!msg) {
    try { await interaction.reply({ content: 'Could not find the message to update.', flags: 64 }); } catch {}
    return;
  }

  const embeds = (msg.embeds || []).map(e => e.toJSON());
  if (embeds.length) {
    const embed = embeds[0];
    const desc = embed.description || '';
    if (/\*\*In-game date:\*\*/i.test(desc)) {
      embed.description = desc.replace(/\*\*In-game date:\*\*.*?(?=\n|$)/i, `**In-game date:** **${dateText}**`);
    } else {
      embed.description = [desc.trim(), `**In-game date:** **${dateText}**`].filter(Boolean).join('\n');
    }
    embeds[0] = embed;
  }

  const commishMentions = resolveCommishMentions();
  const existingMentions = msg.content ? msg.content.match(/<@&?\d+>/g) || [] : [];
  const mentionSet = new Set([...existingMentions, ...commishMentions]);
  const mentionList = Array.from(mentionSet);

  // Keep any non-mention text but ensure required mentions are present once
  const nonMentionText = (msg.content || '').replace(/<@&?\d+>/g, '').trim();
  const newContentParts = [];
  if (mentionList.length) newContentParts.push(mentionList.join(' '));
  if (nonMentionText) newContentParts.push(nonMentionText);
  const newContent = newContentParts.join(' ').trim() || null;

  try {
    await msg.edit({ content: newContent, embeds });
  } catch (err) {
    console.error('[set_game_info_2k][modal] message.edit failed:', err);
    try { await interaction.reply({ content: 'Failed to update the thread message.', flags: 64 }); } catch {}
    return;
  }

  const mergedMentions = mentionList.join(' ');
  try { await interaction.reply({ content: 'Game info set.', flags: 64 }); } catch {}
  try {
    await interaction.channel.send({
      content: mergedMentions ? `${mergedMentions} Game info is set.` : 'Game info is set.',
      allowedMentions: { parse: ['roles', 'users'] },
    });
  } catch {}
}

export default { customId, execute, customId_modal, execute_modal };
