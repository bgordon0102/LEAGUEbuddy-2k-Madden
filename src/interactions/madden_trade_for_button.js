import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { canTrade } from '../shared/madden_trade_utils.js';
import { saveTradeDraft } from '../shared/trade_draft_store.js';
import { buildButtons } from './trade_builder_add_assets.js';

const ROLE_MAP_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

function loadRoleMap() {
  try { return JSON.parse(fs.readFileSync(ROLE_MAP_FILE, 'utf8')); } catch { return {}; }
}

export const customId = /^madden_trade_for|^mtrade/;

function parseTeamAndPlayer(customId) {
  if (customId.startsWith('mtrade:')) {
    const parts = customId.split(':');
    // mtrade:team:rosterId:label
    const team = decodeURIComponent(parts[1] || '');
    const label = decodeURIComponent(parts[3] || '');
    return { team, player: label === ':' ? '' : label };
  }
  // New format: madden_trade_for:team:rosterId:label
  if (customId.includes(':')) {
    const parts = customId.split(':');
    if (parts.length >= 4) {
      const team = decodeURIComponent(parts[1] || '');
      const labelRaw = decodeURIComponent(parts.slice(3).join(':') || '');
      const label = labelRaw === ':' ? '' : labelRaw;
      return { team, player: label };
    }
  }
  // Legacy format fallback
  let team = '';
  let player = '';
  if (customId.includes('::')) {
    const parts = customId.split('::');
    if (parts.length >= 3) {
      team = decodeURIComponent(parts[1] || '').replace(/_/g, ' ');
      player = decodeURIComponent(parts.slice(2).join('::') || '').replace(/_/g, ' ');
    }
  }
  return { team, player };
}

function getCoachTeamFromRoles(interaction, snapshot) {
  const member = interaction.member;
  const roles = member?.roles?.cache;
  if (!roles) return null;
  // First, try explicit role map matching
  const roleMap = loadRoleMap();
  for (const [name, id] of Object.entries(roleMap)) {
    if (!name.endsWith(' Coach')) continue;
    if (roles.has(id)) {
      return name.replace(/ Coach$/, '');
    }
  }
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  for (const r of roles.values()) {
    if (!r.name.endsWith('Coach')) continue;
    const base = r.name.replace(/ Coach$/, '').toLowerCase();
    const match = teams.find(t => {
      const candidates = [
        t.displayName,
        t.nickName,
        t.abbrName,
        t.cityName,
      ].map(x => (x || '').toLowerCase());
      return candidates.includes(base);
    });
    if (match) return match.displayName || match.nickName || match.cityName || 'Team';
  }
  return null;
}

export async function execute(interaction) {
  if (!interaction.isButton()) return;
  if (!customId.test(interaction.customId)) return;
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  if (!leagueId) {
    await interaction.reply({ content: 'No league set. Run /madden-set-league first.', ephemeral: true });
    return;
  }
  if (!canTrade(leagueId)) {
    await interaction.reply({ content: 'Trades are locked starting Week 13. Try again next season.', ephemeral: true });
    return;
  }
  const snapshot = loadLeagueSnapshot(leagueId);
  const { team: otherTeamInit } = parseTeamAndPlayer(interaction.customId);
  const yourTeamName = getCoachTeamFromRoles(interaction, snapshot) || '';
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const norm = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matchTeam = (name) => {
    const target = norm(name);
    if (!target) return null;
    // Pass 1: strict match on names or exact abbreviation
    const exact = teams.find(t => {
      const cands = [t.displayName, t.nickName, t.cityName].map(norm);
      return cands.includes(target) || norm(t.abbrName) === target;
    });
    if (exact) return exact;
    // Pass 2: loose contains check (exclude abbreviations to avoid CAR vs Cardinals collisions)
    return teams.find(t => {
      const cands = [t.displayName, t.nickName, t.cityName].map(norm);
      return cands.some(c => c && (c.includes(target) || target.includes(c)));
    }) || null;
  };
  const optionsAll = teams.map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsAFC = teams.filter(t => (t.divName || '').toUpperCase().includes('AFC')).map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const optionsNFC = teams.filter(t => (t.divName || '').toUpperCase().includes('NFC')).map(t => ({
    label: t.displayName || t.nickName || t.cityName || t.abbrName || 'Unknown',
    value: String(t.teamId ?? t.teamIndex ?? t.displayName ?? t.nickName),
  }));
  const limitOptions = (opts, keepValue) => {
    if (opts.length <= 25) return opts;
    const keep = opts.find(o => o.value === String(keepValue));
    const others = opts.filter(o => o.value !== String(keepValue));
    const trimmed = others.slice(0, 24);
    return keep ? [keep, ...trimmed] : opts.slice(0, 25);
  };

  const yourTeamId = matchTeam(yourTeamName)?.teamId || null;
  const otherTeamId = matchTeam(otherTeamInit)?.teamId || null;
  const draftId = `builder_${interaction.user.id}_${Date.now()}`;
  saveTradeDraft(draftId, {
    draftId,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    leagueId,
    yourTeamId,
    otherTeamId,
    yourTeamName: yourTeamName || null,
    otherTeamName: otherTeamInit || null,
    assets: { your: [], other: [] },
  });

  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_yours|${draftId}`)
        .setPlaceholder(yourTeamName ? `Your team: ${yourTeamName}` : 'Select your team')
        .setDisabled(yourTeamId ? true : false)
        .addOptions(
          yourTeamId
            ? [{
              label: yourTeamName || 'Your team',
              value: String(yourTeamId),
            }]
            : limitOptions(optionsAll, yourTeamId)
        )
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_afc|${draftId}`)
        .setPlaceholder('Select other team (AFC)')
        .addOptions(limitOptions(optionsAFC))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_team_other_nfc|${draftId}`)
        .setPlaceholder('Select other team (NFC)')
        .addOptions(limitOptions(optionsNFC))
    ),
  ];
  // Respect Discord 5-row limit. When both teams are already known, drop team selectors
  // and show only the action buttons.
  if (yourTeamId && otherTeamId) {
    components.length = 0;
    components.push(...buildButtons(draftId));
  }

  await interaction.reply({
    content: `Trade Builder\nYou: ${yourTeamName || '—'}\nOther: ${otherTeamInit || '—'}\nSelect both teams, then add assets to see live values.`,
    components,
    ephemeral: true,
  });
}

export default { customId, execute };
