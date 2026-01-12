import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { normalizeName } from '../../utils/rosterUtils.js';

const ROSTER_DIR = path.join(process.cwd(), 'data', 'teams_rosters');
const PENDING_FILE = path.join(process.cwd(), 'data', 'removeretires_pending.json');

function loadRosters() {
  const files = fs.readdirSync(ROSTER_DIR).filter(f => f.endsWith('.json'));
  const rosters = [];
  for (const file of files) {
    try {
      const full = path.join(ROSTER_DIR, file);
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const roster = Array.isArray(data)
        ? { players: data, picks: [] }
        : { players: data.players || [], picks: data.picks || [] };
      rosters.push({ file, full, roster });
    } catch (err) {
      console.error('[removeretires] Failed to read roster:', file, err);
    }
  }
  return rosters;
}

function saveRoster(full, roster) {
  fs.writeFileSync(full, JSON.stringify(roster, null, 2));
}

function removePlayerAcrossRosters(name, rosters) {
  const target = normalizeName(name);
  for (const r of rosters) {
    const before = r.roster.players.length;
    r.roster.players = r.roster.players.filter(p => normalizeName(p.name || '') !== target);
    if (r.roster.players.length !== before) {
      saveRoster(r.full, r.roster);
      return r.file.replace('.json', '').replace(/_/g, ' ');
    }
  }
  return null;
}

async function ocrImage(buffer) {
  // Convert to high-contrast grayscale for better OCR
  const processed = await sharp(buffer).grayscale().toBuffer();
  const result = await Tesseract.recognize(processed, 'eng', {
    langPath: process.cwd(), // uses eng.traineddata if present
  });
  return result.data?.text || '';
}

function loadAllPlayerNames() {
  const rosters = loadRosters();
  const names = new Set();
  for (const r of rosters) {
    for (const p of r.roster.players) {
      if (p.name) names.add(p.name);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
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
    console.error('[removeretires] Failed to write pending file:', err);
  }
}

export const data = new SlashCommandBuilder()
  .setName('2k-removeretires')
  .setDescription('Staff: upload a screenshot of retirees or specify a single player to remove')
  .addAttachmentOption(option =>
    option.setName('image')
      .setDescription('Screenshot image')
      .setRequired(false))
  .addStringOption(option =>
    option.setName('player')
      .setDescription('Single player name to remove manually')
      .setRequired(false)
      .setAutocomplete(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function autocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused() || '';
    const all = loadAllPlayerNames();
    const filtered = focused
      ? all.filter(name => name.toLowerCase().includes(focused.toLowerCase()))
      : all;
    const options = filtered.slice(0, 25).map(name => ({ name, value: name }));
    await interaction.respond(options);
  } catch (err) {
    console.error('[removeretires autocomplete] Failed:', err);
    try { await interaction.respond([]); } catch {}
  }
}

export async function execute(interaction) {
  await interaction.deferReply({ flags: 64 });
  const manualPlayer = interaction.options.getString('player');
  const attachment = interaction.options.getAttachment('image');
  try {
    const rosters = loadRosters();

    // Manual single-player removal path
    if (manualPlayer) {
      const pending = readPending();
      const id = `${Date.now()}`;
      pending[id] = { names: [manualPlayer], requester: interaction.user.id };
      writePending(pending);
      await interaction.editReply({
        content: `Confirm removal of ${manualPlayer}?`,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 3, label: 'Confirm', custom_id: `removeretires_confirm_${id}` },
              { type: 2, style: 4, label: 'Cancel', custom_id: `removeretires_cancel_${id}` },
            ],
          },
        ],
      });
      return;
    }

    // OCR path
    if (!attachment || !attachment.url) {
      await interaction.editReply({ content: 'Provide an image or a player name.' });
      return;
    }
    const res = await fetch(attachment.url);
    const arrBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    const text = await ocrImage(buffer);
    const names = text.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 2);
    if (!names.length) {
      await interaction.editReply({ content: 'No names detected from OCR.' });
      return;
    }
    const pending = readPending();
    const id = `${Date.now()}`;
    pending[id] = { names, requester: interaction.user.id };
    writePending(pending);
    const summary = names.slice(0, 20).join(', ');
    await interaction.editReply({
      content: `Detected ${names.length} name(s): ${summary}${names.length > 20 ? ' ...' : ''}\nConfirm removal?`,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Confirm', custom_id: `removeretires_confirm_${id}` },
            { type: 2, style: 4, label: 'Cancel', custom_id: `removeretires_cancel_${id}` },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('[removeretires] Failed:', err);
    await interaction.editReply({ content: 'Failed to process image or update rosters. Check logs.' });
  }
}

export default { data, execute, autocomplete };
