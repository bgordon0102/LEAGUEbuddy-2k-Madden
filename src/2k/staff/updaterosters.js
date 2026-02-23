import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { normalizeName, readRoster } from '../../shared/rosterUtils.js';

const PENDING_FILE = path.join(process.cwd(), 'data', 'updaterosters_pending.json');
const SELECT_PENDING_FILE = path.join(process.cwd(), 'data', 'updaterosters_type_pending.json');
const STAFF_ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'staffRoleMap.main.json');

const ALLOWED_STAFF_NAMES = ['Paradise Commish', 'Paradise Co-Commish'];
const TEAM_ALIASES = {
  heat: 'Miami Heat',
  'hea t': 'Miami Heat',
  suns: 'Phoenix Suns',
  celtics: 'Boston Celtics',
  'celt os': 'Boston Celtics',
  celtos: 'Boston Celtics',
  knicks: 'New York Knicks',
  nets: 'Brooklyn Nets',
  lakers: 'Los Angeles Lakers',
  clippers: 'Los Angeles Clippers',
  warriors: 'Golden State Warriors',
  sixers: 'Philadelphia 76ers',
  '76ers': 'Philadelphia 76ers',
  pels: 'New Orleans Pelicans',
  pelicans: 'New Orleans Pelicans',
  wolves: 'Minnesota Timberwolves',
  twolves: 'Minnesota Timberwolves',
  blazers: 'Portland Trail Blazers',
  mavs: 'Dallas Mavericks',
  spurs: 'San Antonio Spurs',
  jazz: 'Utah Jazz',
  bucks: 'Milwaukee Bucks',
};

function readStaffRoleIds() {
  try {
    const map = JSON.parse(fs.readFileSync(STAFF_ROLE_MAP_PATH, 'utf8'));
    return Object.entries(map || {})
      .filter(([name]) => ALLOWED_STAFF_NAMES.includes(name))
      .map(([, id]) => id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePending(data) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data ?? {}, null, 2));
}

export function readSelectPending() {
  try {
    return JSON.parse(fs.readFileSync(SELECT_PENDING_FILE, 'utf8'));
  } catch {
    return {};
  }
}
export function writeSelectPending(data) {
  fs.writeFileSync(SELECT_PENDING_FILE, JSON.stringify(data ?? {}, null, 2));
}

async function ocrImage(buffer) {
  // Boost contrast so yellow highlights render as dark text on light background
  const highContrast = await sharp(buffer)
    .flatten({ background: '#ffffff' })
    .grayscale()
    .normalize()
    .threshold(150)
    .toBuffer();
  const primary = await Tesseract.recognize(highContrast, 'eng', {
    langPath: process.cwd(),
  });
  let text = primary.data?.text || '';
  if (!text.trim() || text.trim().length < 8) {
    // Fallback to softer processing if threshold clipped too hard
    const fallback = await sharp(buffer).flatten({ background: '#ffffff' }).grayscale().normalize().toBuffer();
    const secondary = await Tesseract.recognize(fallback, 'eng', { langPath: process.cwd() });
    if ((secondary.data?.text || '').trim().length > text.trim().length) {
      text = secondary.data.text;
    }
  }
  return text;
}

function cleanLines(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 2);
}

function parseSignLine(line) {
  const lower = line.toLowerCase();
  if (!lower.includes('sign')) return null;
  if (lower.includes('hire') || lower.includes('fire')) return null;
  const match = line.match(/^(.*?)\s+sign\s+(.*)$/i);
  if (!match) return null;
  const team = match[1].trim();
  const rest = match[2].trim();
  const toIdx = rest.toLowerCase().indexOf(' to ');
  const beforeTo = toIdx !== -1 ? rest.slice(0, toIdx).trim() : rest;
  const parts = beforeTo.split(/\s+/);
  let position = null;
  let player = beforeTo;
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(parts[0])) {
    position = parts[0];
    player = parts.slice(1).join(' ');
  }
  return {
    type: 'sign',
    team,
    player: player.trim(),
    position: position || null,
    raw: line,
  };
}

function parseWaiveLine(line) {
  const lower = line.toLowerCase();
  if (!lower.includes('waive')) return null;
  if (lower.includes('hire') || lower.includes('fire')) return null;
  const match = line.match(/^(.*?)\s+waive\s+(.*)$/i);
  if (!match) return null;
  const team = match[1].trim();
  const rest = match[2].trim();
  const parts = rest.split(/\s+/);
  let position = null;
  let player = rest;
  if (parts.length > 1 && /^[A-Z]{1,3}$/.test(parts[0])) {
    position = parts[0];
    player = parts.slice(1).join(' ');
  }
  return {
    type: 'waive',
    team,
    player: player.trim(),
    position: position || null,
    raw: line,
  };
}

function classifyAsset(assetText) {
  const txt = assetText.trim();
  if (!txt) return null;
  if (/round/i.test(txt) || /^'\d{2}/.test(txt)) {
    return { type: 'pick', value: txt };
  }
  const parts = txt.split(',');
  const player = parts[0].trim();
  const position = parts[1]?.trim() || null;
  return { type: 'player', name: player, position, raw: txt };
}

function parseTradeLine(line) {
  const lower = line.toLowerCase();
  if (!lower.includes('trade')) return null;
  if (lower.includes('hire') || lower.includes('fire')) return null;
  // Pattern: TeamA trade: ... TeamB trade: ...
  const match = line.match(/^(.*?)\s+trade:\s*(.+?)(?:\s+([A-Za-z .]+?)\s+trade:\s*(.+))?$/i);
  if (!match) return null;
  const teamA = match[1].trim();
  const assetsA = (match[2] || '').split(/\s*\/\s*/).map(classifyAsset).filter(Boolean);
  const teamB = match[3]?.trim();
  const assetsB = teamB ? (match[4] || '').split(/\s*\/\s*/).map(classifyAsset).filter(Boolean) : [];
  const entries = [];
  if (assetsA.length) entries.push({ type: 'trade', team: teamA, assets: assetsA, raw: line });
  if (teamB && assetsB.length) entries.push({ type: 'trade', team: teamB, assets: assetsB, raw: line });
  return entries.length ? entries : null;
}

function parseByType(type, lines) {
  const out = [];
  if (type === 'sign' || type === 'auto') out.push(...lines.map(parseSignLine).filter(Boolean));
  if (type === 'waive' || type === 'auto') out.push(...lines.map(parseWaiveLine).filter(Boolean));
  if (type === 'trade' || type === 'auto') {
    for (const l of lines) {
      const parsed = parseTradeLine(l);
      if (parsed) out.push(...parsed);
    }
  }
  return out;
}

function getRosterCached(cache, team) {
  const keyRaw = String(team || '').trim();
  const key = keyRaw.toLowerCase();
  if (cache[key]) return cache[key];
  const alias = TEAM_ALIASES[key] || keyRaw;
  const data = readRoster(alias, { force2k: true });
  let normalized = null;
  if (data?.roster && Array.isArray(data.roster.players)) {
    normalized = { roster: data.roster, rosterPath: data.rosterPath || alias };
  } else if (Array.isArray(data?.players)) {
    normalized = { roster: { players: data.players, picks: data.picks || [] }, rosterPath: alias };
  } else if (Array.isArray(data)) {
    normalized = { roster: { players: data, picks: [] }, rosterPath: alias };
  }
  console.log('[updaterosters][getRosterCached]', { team: keyRaw, alias, found: !!normalized, rosterPath: normalized?.rosterPath, players: normalized?.roster?.players?.length });
  cache[key] = normalized;
  return normalized;
}

function findPlayer(rosterObj, name) {
  if (!rosterObj?.players) return null;
  const norm = normalizeName(name);
  return rosterObj.players.find(p => normalizeName(p.name || '') === norm);
}

function buildWarnings(type, entries, rosterCache) {
  const warnings = [];
  if (type === 'sign') {
    for (const e of entries) {
      const data = getRosterCached(rosterCache, e.team);
      if (data && findPlayer(data.roster, e.player)) {
        warnings.push(`${e.player} already on ${e.team} (signing already applied)`);
      }
    }
  } else if (type === 'waive') {
    const faData = getRosterCached(rosterCache, 'free agency');
    for (const e of entries) {
      const data = getRosterCached(rosterCache, e.team);
      if (!data) continue;
      const onTeam = findPlayer(data.roster, e.player);
      if (!onTeam) {
        if (faData && findPlayer(faData.roster, e.player)) {
          warnings.push(`${e.player} already in free agency (waive likely applied)`);
        } else {
          warnings.push(`${e.player} not found on ${e.team}`);
        }
      }
    }
  } else if (type === 'trade') {
    for (const e of entries) {
      const data = getRosterCached(rosterCache, e.team);
      if (!data) continue;
      for (const asset of e.assets || []) {
        if (asset.type !== 'player') continue;
        if (!findPlayer(data.roster, asset.name)) {
          warnings.push(`${asset.name} not found on ${e.team} (trade may be already processed)`);
        }
      }
    }
  }
  return warnings;
}

export const data = new SlashCommandBuilder()
  .setName('2k-updaterosters')
  .setDescription('Staff: OCR roster updates (signings, waives, trades) from a screenshot')
  .addStringOption(option =>
    option.setName('type')
      .setDescription('Which transaction type this screenshot contains')
      .setRequired(true)
      .addChoices(
        { name: 'Signing', value: 'sign' },
        { name: 'Waive', value: 'waive' },
        { name: 'Trade', value: 'trade' },
        { name: 'Auto (mixed)', value: 'auto' },
      ))
  .addAttachmentOption(option =>
    option.setName('image')
      .setDescription('Screenshot of the transactions page')
      .setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    if (err?.code === 10062) return; // interaction expired
    throw err;
  }
  const staffRoleIds = readStaffRoleIds();
  const isStaff = staffRoleIds.length
    ? interaction.member?.roles?.cache?.some(r => staffRoleIds.includes(r.id))
    : interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
  if (!isStaff) {
    await interaction.editReply({ content: 'Only Paradise Commish/Co-Commish can use this command.' });
    return;
  }

  const attachment = interaction.options.getAttachment('image');
  if (!attachment?.url) {
    await interaction.editReply({ content: 'Please upload an image.' });
    return;
  }

  const type = interaction.options.getString('type');
  if (!type) {
    const selectId = `${Date.now()}`;
    const pending = readSelectPending();
    pending[selectId] = {
      id: selectId,
      attachmentUrl: attachment.url,
      requester: interaction.user.id,
      createdAt: new Date().toISOString(),
    };
    writeSelectPending(pending);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`updaterosters_picktype_${selectId}`)
      .setPlaceholder('Select transaction type')
      .addOptions(
        { label: 'Signing', value: 'sign' },
        { label: 'Waive', value: 'waive' },
        { label: 'Trade', value: 'trade' },
      );
    const row = new ActionRowBuilder().addComponents(menu);
    const cancelRow = new ActionRowBuilder().addComponents(
      { type: 2, style: 4, label: 'Cancel', custom_id: `updaterosters_typecancel_${selectId}` }
    );
    await interaction.editReply({
      content: 'Choose the transaction type for this screenshot:',
      components: [row, cancelRow],
    });
    return;
  }

  await processAndSummarize(interaction, type, attachment.url);
}

export async function processAndSummarize(interaction, type, attachmentUrl) {
  try {
    const res = await fetch(attachmentUrl);
    const arrBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrBuf);
    const text = await ocrImage(buffer);
    const lines = cleanLines(text);
    const rosterCache = {};
    const parsed = parseByType(type, lines);
    if (!parsed.length) {
      await interaction.editReply({ content: 'No transactions detected. Make sure the screenshot contains the selected type.' });
      return;
    }

    const groups = { sign: [], waive: [], trade: [] };
    parsed.forEach(e => { if (e.type && groups[e.type]) groups[e.type].push(e); });

    const valid = { sign: [], waive: [], trade: [] };
    const invalidTeams = new Set();
    ['sign','waive','trade'].forEach(k => {
      groups[k].forEach(e => {
        if (getRosterCached(rosterCache, e.team)) valid[k].push(e);
        else invalidTeams.add(e.team);
      });
    });
    const totalValid = valid.sign.length + valid.waive.length + valid.trade.length;
    if (!totalValid) {
      await interaction.editReply({ content: 'No transactions matched known team rosters. Check team names in the screenshot.' });
      return;
    }

    const warnings = [
      ...buildWarnings('sign', valid.sign, rosterCache),
      ...buildWarnings('waive', valid.waive, rosterCache),
      ...buildWarnings('trade', valid.trade, rosterCache),
    ];

    const pending = readPending();
    const id = `${Date.now()}`;
    pending[id] = {
      id,
      type,
      entries: valid,
      requester: interaction.user.id,
      createdAt: new Date().toISOString(),
    };
    writePending(pending);

    const summaryLines = [];
    if (valid.sign.length) summaryLines.push(`Signings (${valid.sign.length}):`, ...valid.sign.slice(0,5).map(e=>e.raw));
    if (valid.waive.length) summaryLines.push(`Waives (${valid.waive.length}):`, ...valid.waive.slice(0,5).map(e=>e.raw));
    if (valid.trade.length) summaryLines.push(`Trades (${valid.trade.length}):`, ...valid.trade.slice(0,5).map(e=>e.raw));

    await interaction.editReply({
      content: [
        `Detected ${totalValid} transaction(s) (sign: ${valid.sign.length}, waive: ${valid.waive.length}, trade entries: ${valid.trade.length}).`,
        summaryLines.join('\n') + ((valid.sign.length+valid.waive.length+valid.trade.length)>15 ? '\n...' : ''),
        invalidTeams.size ? `Ignored (unknown team): ${Array.from(invalidTeams).join(', ')}` : null,
        warnings.length ? `Already done / issues:\n${warnings.slice(0, 10).join('\n')}${warnings.length > 10 ? '\n...' : ''}` : null,
        'Confirm to apply to rosters.',
      ].filter(Boolean).join('\n'),
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Confirm', custom_id: `updaterosters_confirm_${id}` },
            { type: 2, style: 4, label: 'Cancel', custom_id: `updaterosters_cancel_${id}` },
          ],
        },
      ],
    });
  } catch (err) {
    console.error('[updaterosters] Failed:', err);
    try {
      await interaction.editReply({ content: 'Failed to process image. Try again with a clearer screenshot.' });
    } catch {
      // interaction might be expired; ignore
    }
  }
}

export default { data, execute };
