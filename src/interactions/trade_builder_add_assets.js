import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { computePlayerValue, buildValueMap, parsePickValue } from './madden_trade_modal_submit.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { readRoster, normalizeName, resolveTeamNameForRoster, computePlayerValue2k, computePickValue2k, parsePickValue2k } from '../shared/rosterUtils.js';
import fs from 'fs';
import path from 'path';

const MENU_CUSTOM_ID = /^trade_builder_select_assets\|(yours|other)\|/;
const ADD_CUSTOM_ID = /^trade_builder_add\|(yours|other)\|/;
const RESET_CUSTOM_ID = /^trade_builder_reset\|/;
const PICK_MANUAL_BTN = /^trade_builder_pick_manual\|(yours|other)\|/;
const PICK_MANUAL_MODAL = /^trade_builder_pick_modal\|(yours|other)\|/;
export const customId = /^(trade_builder_add\|(yours|other)\|.+|trade_builder_select_assets\|(yours|other)\|.+|trade_builder_reset\|.+|trade_builder_pick_manual\|(yours|other)\|.+|trade_builder_pick_modal\|(yours|other)\|.+)$/;

export function teamLookup(snapshot, teamIdOrName) {
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const target = String(teamIdOrName || '').toLowerCase();
  return teams.find(t => {
    const ids = [
      String(t.teamId ?? ''),
      String(t.teamIndex ?? ''),
      (t.displayName || '').toLowerCase(),
      (t.nickName || '').toLowerCase(),
      (t.abbrName || '').toLowerCase(),
      (t.cityName || '').toLowerCase(),
    ];
    return ids.includes(target) || ids.some(v => v && target && (v.includes(target) || target.includes(v)));
  });
}

export function rosterForTeam(snapshot, teamIdOrName) {
  const rosters = snapshot?.rosters?.teams || {};
  const teams = snapshot?.teams?.leagueTeamInfoList || [];
  const meta = teamLookup(snapshot, teamIdOrName);
  const matchIds = new Set([
    String(teamIdOrName || '').toLowerCase(),
    String(meta?.teamId ?? '').toLowerCase(),
    String(meta?.teamIndex ?? '').toLowerCase(),
    (meta?.displayName || '').toLowerCase(),
    (meta?.nickName || '').toLowerCase(),
    (meta?.abbrName || '').toLowerCase(),
    (meta?.cityName || '').toLowerCase(),
  ].filter(Boolean));

  // Primary: find roster bucket that matches team info
  const teamBucket = Object.entries(rosters).find(([key, r]) => {
    const ids = [
      String(r?.teamId ?? '').toLowerCase(),
      String(r?.teamIndex ?? '').toLowerCase(),
      (teams.find(t => String(t.teamId ?? '') === String(r.teamId))?.displayName || '').toLowerCase(),
      String(key || '').toLowerCase(),
    ];
    return ids.some(id => matchIds.has(id));
  })?.[1];
  if (teamBucket?.rosterInfoList?.length) return teamBucket.rosterInfoList;

  // Fallback: flatten all rosters and filter by player.teamId matching meta
  const targetId = String((meta?.teamId ?? teamIdOrName) || '').toLowerCase();
  const allPlayers = Object.values(rosters).flatMap(r => r?.rosterInfoList || []);
  const filtered = allPlayers.filter(p => String(p.teamId ?? '').toLowerCase() === targetId);
  if (filtered.length) return filtered;

  // Last resort: return the first roster bucket (better than empty)
  return Object.values(rosters).flatMap(r => r?.rosterInfoList || []);
}

function pickOptions(currentYear) {
  const rounds = [1, 2, 3, 4, 5, 6, 7];
  const yr = Number(currentYear) || new Date().getFullYear();
  const years = [yr, yr + 1, yr + 2];
  const current = [];
  const future = [];
  years.forEach(y => {
    rounds.forEach(r => {
      if (y === yr) {
        current.push({ label: `${y} Round ${r}`, value: `pick:${y}:${r}` });
      } else {
        // Future years: round-only
        future.push({ label: `${y} Round ${r}`, value: `pick:${y}:${r}` });
      }
    });
  });
  return { current, future };
}

function buildAssetSelectRows(side, draftId, snapshot, teamId) {
  // Madden path (default)
  const roster = rosterForTeam(snapshot, teamId)
    .slice()
    .sort((a, b) => {
      const ovrA = a.overallRating ?? a.playerBestOvr ?? a.playerSchemeOvr ?? a.teamSchemeOvr ?? a.ovrRating ?? 0;
      const ovrB = b.overallRating ?? b.playerBestOvr ?? b.playerSchemeOvr ?? b.teamSchemeOvr ?? b.ovrRating ?? 0;
      return ovrB - ovrA;
    });
  const year = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();

  const offensePos = new Set(['QB', 'HB', 'RB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT']);
  const defensePos = new Set(['LE', 'RE', 'DL', 'DT', 'EDGE', 'REDGE', 'LEDGE', 'OLB', 'ROLB', 'LOLB', 'MLB', 'MIKE', 'WILL', 'SAM', 'CB', 'FS', 'SS', 'DB']);
  const specialPos = new Set(['K', 'P', 'LS']);

  const buckets = [
    { key: 'off', label: 'Offense', items: [] },
    { key: 'def', label: 'Defense', items: [] },
    { key: 'st', label: 'Special Teams / Picks', items: [] },
  ];

  roster.forEach(p => {
    const pos = (p.position || '').toUpperCase();
    const val = computePlayerValue(p);
    const ovr = p.overallRating ?? p.playerBestOvr ?? p.playerSchemeOvr ?? p.teamSchemeOvr ?? p.ovrRating ?? '??';
    const age = p.age ?? (p.yearsPro != null ? (18 + Number(p.yearsPro)) : '??');
    const label = `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Player';
    const opt = new StringSelectMenuOptionBuilder()
      .setLabel(label.slice(0, 90))
      .setDescription(`${p.position || 'UNK'} | Age ${age} | OVR ${ovr} | Val ${val.toFixed(1)}`.slice(0, 100))
      .setValue(`player:${p.rosterId}`);
    if (offensePos.has(pos)) buckets[0].items.push(opt);
    else if (defensePos.has(pos)) buckets[1].items.push(opt);
    else buckets[2].items.push(opt);
  });

  // add picks separated into current/future buckets
  const pickBuckets = pickOptions(year);
  const futurePickRow = pickBuckets.future.slice(0, 25).length
    ? new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_select_assets|${side}|${draftId}|picks_future|0`)
        .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} future picks`)
        .setMinValues(1)
        .setMaxValues(Math.min(5, pickBuckets.future.slice(0, 25).length))
        .addOptions(pickBuckets.future.slice(0, 25))
    )
    : null;

  // Limit player buckets to top 25 to avoid extra pages; keep single row per category
  const rows = buckets
    .map(bucket => bucket.items.slice(0, 25))
    .filter(arr => arr.length)
    .map((opts, idx) => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_select_assets|${side}|${draftId}|${buckets[idx].key}|0`)
        .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} ${buckets[idx].label}`)
        .setMinValues(1)
        .setMaxValues(Math.min(5, opts.length))
        .addOptions(opts)
    ));
  if (futurePickRow) rows.push(futurePickRow);
  // manual current-year pick entry button row
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`trade_builder_pick_manual|${side}|${draftId}`)
        .setLabel('Type current-year pick')
        .setStyle(ButtonStyle.Secondary)
    )
  );
  // enforce Discord max 5 rows
  return rows.slice(0, 5);
  return rows;
}

function summarizeAssets(draft, valueMap, seasonYear) {
  // Madden path (default)
  const currentPickValue = (round, pickNum) => {
    const r = Number(round);
    const p = Math.min(32, Math.max(1, Number(pickNum) || 1));
    if (r === 1) {
      if (p === 1) return 400;
      if (p === 2) return 350;
      if (p === 3) return 300;
      const start = 280;
      const end = 150;
      const t = (p - 4) / (32 - 4);
      return start + (end - start) * t;
    }
    const curves = {
      2: { start: 170, end: 120 },
      3: { start: 125, end: 85 },
      4: { start: 95, end: 65 },
      5: { start: 70, end: 45 },
      6: { start: 50, end: 30 },
      7: { start: 32, end: 18 },
    };
    const curve = curves[r] || { start: 20, end: 10 };
    const t = (p - 1) / 31;
    return curve.start + (curve.end - curve.start) * t;
  };

  const summarize = (arr) => {
    let total = 0;
    const lines = [];
    arr.forEach(item => {
      if (item.type === 'player') {
        const found = valueMap.get(item.key);
        const val = found?.value ?? 0;
        total += val;
        lines.push(`${item.label} (${item.pos || 'UNK'}) — ${val.toFixed(1)}`);
      } else if (item.type === 'pick') {
        // Prefer stored structured data to avoid mis-parsing
        const parsedStored = { year: item.year, round: item.round, pickNum: item.pickNum };
        const parsedFallback = parsePickValue(item.raw, seasonYear) || {};
        const yr = parsedStored.year || parsedFallback.year || seasonYear;
        const rnd = parsedStored.round || parsedFallback.round;
        const pk = parsedStored.pickNum || parsedFallback.pickNum;
        let val = 0;
        let label = item.raw;
        if (yr && rnd) {
          const currentYear = seasonYear || new Date().getFullYear();
          if (pk && yr === currentYear) {
            val = currentPickValue(rnd, pk);
            label = `${yr} Round ${rnd} Pick ${pk}`;
          } else {
            // future or round-only
            const floorMap = { 1: 150, 2: 110, 3: 85, 4: 65, 5: 50, 6: 35, 7: 25 };
            const futureBaseChart = { 1: 300, 2: 200, 3: 150, 4: 110, 5: 80, 6: 60, 7: 40 };
            const floor = floorMap[rnd] || 10;
            const diff = yr - currentYear;
            if (diff > 0) {
              const decay = diff === 1 ? 0.85 : 0.7;
              val = Math.max(5, Math.round((futureBaseChart[rnd] || floor) * decay));
              if (rnd === 1 && diff === 1 && val < 250) val = 250;
              if (rnd === 1 && diff >= 2 && val < 200) val = 200;
            } else if (pk) {
              val = Math.max(floor, currentPickValue(rnd, pk));
            }
            label = pk ? `${yr} Round ${rnd} Pick ${pk}` : `${yr} Round ${rnd}`;
          }
        } else {
          const parsed = parsedFallback;
          val = parsed?.value || 0;
          label = parsed?.label || item.raw;
        }
        total += val;
        lines.push(`${label} — ${Number(val).toFixed(1)}`);
      }
    });
    return { total, lines };
  };
  return {
    your: summarize(draft.assets?.your || []),
    other: summarize(draft.assets?.other || []),
  };
}

// ---------- NBA (2K) helpers ----------
function rosterForTeam2k(teamName) {
  const resolved = resolveTeamNameForRoster(teamName);
  const data = readRoster(resolved);
  if (Array.isArray(data)) return { players: data, picks: [] };
  return {
    players: Array.isArray(data?.players) ? data.players : [],
    picks: Array.isArray(data?.picks) ? data.picks : [],
  };
}

function buildAssetSelectRows2k(side, draftId, teamName) {
  const draft = getTradeDraft(draftId);
  const seasonYear = draft?.seasonYear || new Date().getFullYear();
  const { players } = rosterForTeam2k(teamName);
  // Generate pick options: 2026-2030 1st/2nd; protections (top3/5/10/lottery) only for next 3 seasons
  const baseYear = seasonYear;
  const yearsFirst = [baseYear, baseYear + 1, baseYear + 2, baseYear + 3, baseYear + 4];
  const yearsProtected = [baseYear, baseYear + 1, baseYear + 2];
  const protectionTags = ['top 3 protected', 'top 5 protected', 'top 10 protected', 'lottery protected'];
  const picks = [];
  yearsFirst.forEach(y => {
    picks.push(`${y} Round 1`);
    protectionTags.forEach(tag => {
      if (yearsProtected.includes(y)) picks.push(`${y} Round 1 (${tag})`);
    });
    picks.push(`${y} Round 2`);
  });
  if (!players.length && !picks.length) return [];
  const buckets = [
    { key: 'guards', label: 'Guards', items: [] },
    { key: 'wings', label: 'Wings/Forwards', items: [] },
    { key: 'bigs', label: 'Bigs', items: [] },
  ];
  players
    .slice()
    .sort((a, b) => (Number(b.ovr || 0)) - (Number(a.ovr || 0)))
    .forEach(p => {
      const posRaw = (p.position || '').toUpperCase();
      const primary = posRaw.split(/[\\/]/)[0].trim().split(/\s+/)[0] || posRaw;
      const val = computePlayerValue2k(p);
      const desc = `${p.position || 'UNK'} | OVR ${p.ovr || '??'} | Val ${val}`;
      const opt = new StringSelectMenuOptionBuilder()
        .setLabel((p.name || 'Player').slice(0, 90))
        .setDescription(desc.slice(0, 100))
        .setValue(`player:${p.name}`);
      if (primary === 'PG' || primary === 'SG') buckets[0].items.push(opt);
      else if (primary === 'SF' || primary === 'PF') buckets[1].items.push(opt);
      else if (primary === 'C') buckets[2].items.push(opt);
      else buckets[1].items.push(opt); // default unknowns to wings
    });

  const rows = buckets
    .map(b => b.items.slice(0, 25))
    .filter(arr => arr.length)
    .map((opts, idx) =>
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_select_assets|${side}|${draftId}|${buckets[idx].key}|0`)
          .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} ${buckets[idx].label}`)
          .setMinValues(1)
          .setMaxValues(Math.min(5, opts.length))
          .addOptions(opts)
      )
    );

  if (picks.length) {
    const pickOpts = picks.slice(0, 25).map(p => ({
      label: p,
      value: `pick:${p}`
    }));
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`trade_builder_select_assets|${side}|${draftId}|picks|0`)
          .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} picks`)
          .setMinValues(1)
          .setMaxValues(Math.min(5, pickOpts.length))
          .addOptions(pickOpts)
      )
    );
  }
  return rows;
}

function summarizeAssets2k(draft) {
  const summarize = (arr) => {
    let total = 0;
    const lines = [];
    arr.forEach(item => {
      if (item.type === 'player') {
        const val = computePlayerValue2k(item);
        total += val;
        lines.push(`${item.label} (${item.pos || 'UNK'}) — ${val.toFixed(1)}`);
      } else if (item.type === 'pick') {
        const raw = item.raw || '';
        // Prevent revaluation if pick string contains 'VIA'
        if (raw.includes('VIA')) {
          lines.push(raw);
        } else {
          const parsed = parsePickValue2k(raw, draft.seasonYear);
          const val = item.value ?? parsed?.value ?? 0;
          const label = parsed?.label || raw || 'Pick';
          total += val;
          lines.push(`${label} — ${val.toFixed(1)}`);
        }
      }
    });
    return { total, lines };
  };
  return {
    your: summarize(draft.assets?.your || []),
    other: summarize(draft.assets?.other || []),
  };
}

export function buildButtons(draftId) {
  const draft = getTradeDraft(draftId);
  const is2k = draft?.mode === '2k';
  let allowManualCurrentPick = true;
  if (is2k) {
    // Only allow manual pick entry in the offseason when draft order is known
    try {
      const seasonPath = path.join(process.cwd(), 'data', 'season.json');
      if (fs.existsSync(seasonPath)) {
        const season = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
        allowManualCurrentPick = (season.phase || '').toLowerCase() === 'offseason';
      }
    } catch { /* ignore */ }
    if (!allowManualCurrentPick) allowManualCurrentPick = false;
  }
  const submitId = draft?.mode === '2k'
    ? `trade_preview_submit|${draftId}`
    : `madden_trade_preview_submit|${draftId}`;
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade_builder_add|yours|${draftId}`).setLabel('Add your assets').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`trade_builder_add|other|${draftId}`).setLabel("Add their assets").setStyle(ButtonStyle.Secondary),
    ),
  ];

  const actionRow = new ActionRowBuilder();
  if (!is2k || allowManualCurrentPick) {
    actionRow.addComponents(
      new ButtonBuilder().setCustomId(`trade_builder_pick_manual|yours|${draftId}`).setLabel('Type current pick (yours)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`trade_builder_pick_manual|other|${draftId}`).setLabel('Type current pick (theirs)').setStyle(ButtonStyle.Secondary),
    );
  }
  actionRow.addComponents(
    new ButtonBuilder().setCustomId(`trade_builder_reset|${draftId}`).setLabel('Reset').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(submitId).setLabel('Submit').setStyle(ButtonStyle.Success),
  );
  rows.push(actionRow);
  return rows;
}

async function refreshBuilder(interaction, draft, snapshot) {
  if (draft.mode === '2k') {
    const summary = summarizeAssets2k(draft);
    const gap = summary.your.total - summary.other.total;
    const GAP_LIMIT = 50;
    const embed = new EmbedBuilder()
      .setTitle('Trade Builder')
      .setDescription(`Gap (you - them): ${gap.toFixed(1)}${Math.abs(gap) > GAP_LIMIT ? ' — exceeds limit' : ' — within limit'}`)
      .addFields(
        {
          name: `Your team: ${draft.yourTeamName || '—'} (Total ${summary.your.total.toFixed(1)})`,
          value: summary.your.lines.length ? summary.your.lines.join('\n') : 'No assets yet.',
          inline: false,
        },
        {
          name: `Other team: ${draft.otherTeamName || '—'} (Total ${summary.other.total.toFixed(1)})`,
          value: summary.other.lines.length ? summary.other.lines.join('\n') : 'No assets yet.',
          inline: false,
        },
      )
      .setColor(0x5865f2);
    draft.assetsSent = summary.your.lines.join('\n');
    draft.assetsReceived = summary.other.lines.join('\n');
    saveTradeDraft(draft.draftId, draft);
    await interaction.update({
      content: null,
      embeds: [embed],
      components: buildButtons(draft.draftId),
    });
    return;
  }
  const valueMap = buildValueMap(snapshot);
  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
  const summary = summarizeAssets(draft, valueMap, seasonYear);
  const gap = summary.your.total - summary.other.total;
  // Persist team labels for later submit
  draft.yourTeam = draft.yourTeamName || draft.yourTeamId || '—';
  draft.otherTeam = draft.otherTeamName || draft.otherTeamId || '—';
  const embed = new EmbedBuilder()
    .setTitle('Trade Builder')
    .setDescription(`Gap (you - them): ${gap.toFixed(1)}`)
    .addFields(
      {
        name: `Your team: ${draft.yourTeamName || draft.yourTeamId || '—'} (Total ${summary.your.total.toFixed(1)})`,
        value: summary.your.lines.length ? summary.your.lines.join('\n') : 'No assets yet.',
        inline: false,
      },
      {
        name: `Other team: ${draft.otherTeamName || draft.otherTeamId || '—'} (Total ${summary.other.total.toFixed(1)})`,
        value: summary.other.lines.length ? summary.other.lines.join('\n') : 'No assets yet.',
        inline: false,
      },
    )
    .setColor(0x5865f2);
  // Keep string assets for compatibility with submit handler
  draft.assetsSent = summary.your.lines.join('\n');
  draft.assetsReceived = summary.other.lines.join('\n');
  saveTradeDraft(draft.draftId, draft);
  await interaction.update({
    content: null,
    embeds: [embed],
    components: buildButtons(draft.draftId),
  });
}

export async function execute(interaction) {
  const leagueId = resolveLeagueIdWithConfig(interaction.guildId);
  const draftId = interaction.customId.split('|')[1];
  const draft = getTradeDraft(draftId);
  const isNBA = draft?.mode === '2k';
  if (RESET_CUSTOM_ID.test(interaction.customId)) {
    const draftId = interaction.customId.split('|')[1];
    const draft = getTradeDraft(draftId);
    if (!draft) return;
    draft.assets = { your: [], other: [] };
    // Also clear team selections in 2K so the user can re-pick cleanly
    if (draft.mode === '2k') {
      draft.otherTeamName = null;
      draft.otherTeamId = null;
      draft.otherTeam = null;
    }
    saveTradeDraft(draftId, draft);
    if (draft.mode === '2k') {
      await refreshBuilder(interaction, draft, null);
      return;
    }
    if (!leagueId) return;
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
  if (ADD_CUSTOM_ID.test(interaction.customId)) {
    const [, side, draftId] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft || !(draft.mode === '2k' ? draft[side === 'yours' ? 'yourTeamName' : 'otherTeamName'] : draft[side === 'yours' ? 'yourTeamId' : 'otherTeamId'])) {
      await interaction.reply({ content: 'Select both teams first.', ephemeral: true });
      return;
    }
    if (draft.mode === '2k') {
      const rows = buildAssetSelectRows2k(side === 'yours' ? 'yours' : 'other', draftId, side === 'yours' ? draft.yourTeamName : draft.otherTeamName);
      if (!rows?.length) {
        await interaction.reply({ content: 'No assets found for that team.', ephemeral: true });
        return;
      }
      await interaction.reply({ content: `Select assets for ${side === 'yours' ? 'your' : 'their'} team`, components: rows.slice(0, 5), ephemeral: true });
      if (rows.length > 5) {
        await interaction.followUp({
          content: 'More options (picks / remaining positions):',
          components: rows.slice(5, 10),
          ephemeral: true,
        });
      }
      return;
    }
    if (!leagueId) return;
    const snapshot = loadLeagueSnapshot(leagueId);
    const rows = buildAssetSelectRows(side === 'yours' ? 'yours' : 'other', draftId, snapshot, side === 'yours' ? draft.yourTeamId : draft.otherTeamId);
    if (!rows?.length) {
      await interaction.reply({ content: 'No assets found for that team. Try again after a sync.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `Select assets for ${side === 'yours' ? 'your' : 'their'} team`,
      components: rows.slice(0, 5), // Discord limit 5 rows
      ephemeral: true,
    });
    return;
  }
  if (MENU_CUSTOM_ID.test(interaction.customId)) {
    const [, side, draftId] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft) {
      await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
      return;
    }
    if (draft.mode === '2k') {
      const rosterData = rosterForTeam2k(side === 'yours' ? draft.yourTeamName : draft.otherTeamName);
      const rosterMap = new Map(rosterData.players.map(p => [normalizeName(p.name), p]));
      const sel = interaction.values || [];
      const assetsArr = draft.assets?.[side === 'yours' ? 'your' : 'other'] || [];
      sel.forEach(v => {
        if (v.startsWith('player:')) {
          const name = v.slice('player:'.length);
          const p = rosterMap.get(normalizeName(name));
          if (!p) return;
          if (assetsArr.find(a => a.type === 'player' && normalizeName(a.label) === normalizeName(name))) return;
          const salary = (Array.isArray(p.contractYears) && p.contractYears[0]?.salary) ? Number(String(p.contractYears[0].salary).replace(/[^0-9.]/g, '')) : 0;
          const yearsInNBA = Number(p.yearsInNBA || 0);
          const ageVal = (() => {
            if (p.birthdate) return p.birthdate; // keep birthdate string if available
            if (p.age) return Number(p.age);
            if (yearsInNBA) return yearsInNBA + 19;
            return null;
          })();
          assetsArr.push({
            type: 'player',
            label: p.name,
            pos: p.position,
            ovr: Number(p.ovr) || 0,
            age: ageVal,
            salary,
            yearsLeft: Array.isArray(p.contractYears) ? p.contractYears.length : 0,
            contractYears: p.contractYears,
            yearsInNBA
          });
        } else if (v.startsWith('pick:')) {
          const raw = v.slice('pick:'.length);
          if (assetsArr.find(a => a.type === 'pick' && a.raw === raw)) return;
          const parsed = parsePickValue2k(raw, draft.seasonYear) || {};
          assetsArr.push({
            type: 'pick',
            raw,
            year: parsed.year,
            round: parsed.round,
            pickNum: parsed.pickNum,
            protection: parsed.protection,
            value: parsed.value,
            label: parsed.label,
          });
        }
      });
      draft.assets = draft.assets || { your: [], other: [] };
      draft.assets[side === 'yours' ? 'your' : 'other'] = assetsArr;
      saveTradeDraft(draftId, draft);
      await refreshBuilder(interaction, draft, null);
      return;
    }
    if (!leagueId) return;
    const snapshot = loadLeagueSnapshot(leagueId);
    const roster = rosterForTeam(snapshot, side === 'yours' ? draft.yourTeamId : draft.otherTeamId);
    const rosterMap = new Map(roster.map(p => [String(p.rosterId), p]));
    const sel = interaction.values || [];
    const assetsArr = draft.assets?.[side === 'yours' ? 'your' : 'other'] || [];
    sel.forEach(v => {
      if (v.startsWith('player:')) {
        const rid = v.split(':')[1];
        const p = rosterMap.get(rid);
        if (!p) return;
        const key = `${p.firstName || ''} ${p.lastName || ''}`.trim().toLowerCase();
        // dedupe
        if (assetsArr.find(a => a.type === 'player' && a.rosterId === rid)) return;
        assetsArr.push({
          type: 'player',
          rosterId: rid,
          key,
          label: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
          pos: p.position,
        });
      } else if (v.startsWith('pick:')) {
        const parts = v.split(':'); // pick:year:round[:pick]
        const year = parts[1];
        const rnd = parts[2];
        const pickNum = parts[3];
        const suffix = rnd === '1' ? 'st' : rnd === '2' ? 'nd' : rnd === '3' ? 'rd' : 'th';
        const raw = pickNum ? `${year} ${rnd}${suffix} pick ${pickNum}` : `${year} ${rnd}${suffix}`;
        if (assetsArr.find(a => a.type === 'pick' && a.raw === raw)) return;
        const parsed = draft.mode === '2k'
          ? parsePickValue2k(raw, draft.seasonYear)
          : parsePickValue(raw, loadLeagueSnapshot(leagueId)?.info?.careerHubInfo?.seasonInfo?.seasonYear);
        assetsArr.push({
          type: 'pick',
          raw,
          year: parsed?.year ?? Number(year),
          round: parsed?.round ?? Number(rnd),
          pickNum: parsed?.pickNum ?? (pickNum ? Number(pickNum) : null),
          protection: parsed?.protection,
          value: parsed?.value,
          label: parsed?.label,
        });
      }
    });
    draft.assets = draft.assets || { your: [], other: [] };
    draft.assets[side === 'yours' ? 'your' : 'other'] = assetsArr;
    // persist label strings for submit
    saveTradeDraft(draftId, draft);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }

  if (PICK_MANUAL_BTN.test(interaction.customId)) {
    const draft = getTradeDraft(interaction.customId.split('|')[2]);
    if (draft?.mode === '2k') {
      await interaction.reply({ content: 'For NBA, add picks from the Picks menu.', ephemeral: true });
      return;
    }
    const [, side, draftId] = interaction.customId.split('|');
    const modalId = `trade_builder_pick_modal|${side}|${draftId}`;
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Add current-year pick');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('pickLabel')
          .setLabel('Enter pick (e.g., 2026 Round 1 Pick 5)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && PICK_MANUAL_MODAL.test(interaction.customId)) {
    const [, side, draftId] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft) {
      await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
      return;
    }
    const rawInput = interaction.fields.getTextInputValue('pickLabel') || '';
    const parsed = draft.mode === '2k'
      ? parsePickValue2k(rawInput, draft.seasonYear)
      : parsePickValue(rawInput, loadLeagueSnapshot(leagueId)?.info?.careerHubInfo?.seasonInfo?.seasonYear);
    if (!parsed) {
      await interaction.reply({ content: 'Could not parse that pick. Try formats like \"2026 Round 1\" or \"2026 Round 1 Pick 5\".', ephemeral: true });
      return;
    }
    draft.assets = draft.assets || { your: [], other: [] };
    const assetsArr = draft.assets[side === 'yours' ? 'your' : 'other'] || [];
    const canonical = parsed.pickNum
      ? `${parsed.year} Round ${parsed.round} Pick ${parsed.pickNum}`
      : `${parsed.year} Round ${parsed.round}`;
    if (!assetsArr.find(a => a.type === 'pick' && a.raw === canonical)) {
      assetsArr.push({
        type: 'pick',
        raw: canonical,
        year: parsed.year,
        round: parsed.round,
        pickNum: parsed.pickNum,
        protection: parsed.protection,
        value: parsed.value,
        label: parsed.label,
      });
    }
    draft.assets[side === 'yours' ? 'your' : 'other'] = assetsArr;
    saveTradeDraft(draftId, draft);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
}

export default { customId, execute };
