import fs from 'fs';
import path from 'path';
import { EmbedBuilder } from 'discord.js';

const BIGBOARD_DIRS = [
  path.join(process.cwd(), 'data', 'draft_classes', '2k'),
  path.join(process.cwd(), 'bot', 'draft classes', 'big boards'),
];

function loadBoard() {
  const seasonPath = path.join(process.cwd(), 'data', 'season.json');
  let seasonNo = 1;
  try {
    if (fs.existsSync(seasonPath)) {
      const seasonData = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
      if (seasonData && seasonData.seasonNo) seasonNo = seasonData.seasonNo;
    }
  } catch { /* ignore */ }
  const classString = `CUS${seasonNo.toString().padStart(2, '0')}`;
  for (const dir of BIGBOARD_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.includes(classString) && f.toLowerCase().includes('big board') && f.toLowerCase().endsWith('.json'));
    if (files.length) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
        return Object.values(data).filter(p => p && p.name && (p.position_1 || p.position));
      } catch { /* ignore */ }
    }
  }
  return [];
}

export const customId = /^2k_bigboard_select_(\d+)$/;

export async function execute(interaction) {
  if (!interaction.isStringSelectMenu()) return;
  const match = interaction.customId.match(customId);
  if (!match) return;
  const selected = interaction.values?.[0];
  if (!selected) return;

  const players = loadBoard();
  if (!players.length) {
    await interaction.update({ content: 'No big board found.', embeds: [], components: [] });
    return;
  }

  const player = players.find(p => (p.name || '').toLowerCase() === selected.toLowerCase());
  if (!player) {
    await interaction.update({ content: 'Player not found on this board.', embeds: [], components: [] });
    return;
  }

  const rank = players.findIndex(p => (p.name || '').toLowerCase() === selected.toLowerCase()) + 1;
  const pos = player.position_1 || player.position || 'Pos';
  const team = player.team || player.college || 'N/A';
  const ht = player.height || 'N/A';
  const wt = player.weight ? `${player.weight} lbs` : 'N/A';
  const wingspan = player.wingspan || player.wingspan_inches || null;
  const age = player.age ? `${player.age}` : null;
  const classYear = player.class || null;
  const handle = player.handle || null;
  const nationality = player.nationality || player.country || null;
  const about = player.about && String(player.about).trim().length ? String(player.about) : ' ';
  const strengths = [player.strength_1, player.strength_2, player.strength_3].filter(Boolean).join(', ');
  const weaknesses = [player.weakness_1, player.weakness_2, player.weakness_3].filter(Boolean).join(', ');
  const proComp = player.pro_comp || player.comparison || null;

  // Load user-specific scouting notes if any
  let scoutingText = null;
  try {
    const scoutPath = path.join(process.cwd(), 'data', 'scout_points.json');
    if (fs.existsSync(scoutPath)) {
      const scoutData = JSON.parse(fs.readFileSync(scoutPath, 'utf8'));
      const userScouting = scoutData?.[interaction.user.id]?.playersScouted || {};
      const notes = userScouting[player.name];
      if (Array.isArray(notes) && notes.length) {
        scoutingText = notes.join(', ');
      }
    }
  } catch (err) {
    console.error('[2k_bigboard_select] failed to read scouting', err);
  }

  const fields = [
    { name: 'Team', value: team, inline: false },
    classYear ? { name: 'Class', value: classYear, inline: false } : null,
    age ? { name: 'Age', value: age, inline: false } : null,
    nationality ? { name: 'Nationality', value: nationality, inline: false } : null,
    { name: 'Physicals', value: `Ht: ${ht}   Wt: ${wt}${wingspan ? `   Wingspan: ${wingspan}` : ''}`, inline: false },
    handle ? { name: 'Handle', value: handle, inline: false } : null,
    { name: 'About', value: about, inline: false },
    strengths ? { name: 'Strengths', value: strengths, inline: false } : null,
    weaknesses ? { name: 'Weaknesses', value: weaknesses, inline: false } : null,
    proComp ? { name: 'Pro Comp', value: proComp, inline: false } : null,
    scoutingText ? { name: 'Your Scouting Notes', value: scoutingText, inline: false } : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle(`${pos} - ${player.name}`)
    .setColor(0x1f8b4c);
  const imageUrl = [player.image, player.img, player.portrait].find(u => u && String(u).trim().length);
  if (imageUrl) {
    const cleaned = String(imageUrl).trim().replace(/^http:/, 'https:');
    embed.setThumbnail(cleaned);
  }
  if (fields.length) embed.addFields(fields);

  await interaction.update({ embeds: [embed], components: interaction.message.components });
}

export default { execute, customId };
