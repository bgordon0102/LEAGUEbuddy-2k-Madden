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
import { computePlayerValue, buildValueMap, parsePickValue, getMaddenPickContext } from './madden_trade_modal_submit.js';
import { getTradeDraft, saveTradeDraft } from '../shared/trade_draft_store.js';
import { readRoster, normalizeName, resolveTeamNameForRoster, computePlayerValue2k, computePickValue2k, parsePickValue2k } from '../shared/rosterUtils.js';
import { getFirstRoundPickLabelsForTeam } from '../madden/pick_overrides_store.js';
import fs from 'fs';
import path from 'path';
import { getFullTeamName } from '../shared/madden_team_names.js';

const MENU_CUSTOM_ID = /^trade_builder_select_assets\|(yours|other)\|/;
const ADD_CUSTOM_ID = /^trade_builder_add\|(yours|other)\|/;
const RESET_CUSTOM_ID = /^trade_builder_reset\|/;
const PICK_MANUAL_BTN = /^trade_builder_pick_manual\|(yours|other)\|/;
const PICK_MANUAL_MODAL = /^trade_builder_pick_modal\|(yours|other)\|/;
export const customId = /^(trade_builder_add\|(yours|other)\|.+|trade_builder_select_assets\|(yours|other)\|.+|trade_builder_reset\|.+|trade_builder_pick_manual\|(yours|other)\|.+|trade_builder_pick_modal\|(yours|other)\|.+)$/;

const formatSalary = (n) => `$${Math.round(n || 0).toLocaleString()}`;
const parseSalary = (p) => {
  if (!p) return 0;
  if (typeof p === 'number') return p;
  if (typeof p.salaryPerYear === 'number') return p.salaryPerYear;
  const salaryStr = p.salaryPerYear || p.salary || (Array.isArray(p.contractYears) && p.contractYears[0]?.salary) || '';
  if (!salaryStr) return 0;
  const cleaned = String(salaryStr).replace(/[$,]/g, '').trim();
  const m = cleaned.match(/([0-9]*\\.?[0-9]+)/);
  if (!m) return 0;
  let val = Number(m[1]);
  if (/m/i.test(cleaned)) val *= 1_000_000;
  return Number.isFinite(val) ? val : 0;
};

function currentYearSalary(p) {
  const cy = Array.isArray(p?.contractYears) ? p.contractYears[0]?.salary : null;
  if (cy) return cy;
  if (p?.salaryPerYear) return p.salaryPerYear;
  return null;
}

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

function buildAssetSelectRows(side, draftId, snapshot, teamId) {
  // Madden path (default)
  const roster = rosterForTeam(snapshot, teamId)
    .slice()
    .sort((a, b) => {
      const ovrA = a.overallRating ?? a.playerBestOvr ?? a.playerSchemeOvr ?? a.teamSchemeOvr ?? a.ovrRating ?? 0;
      const ovrB = b.overallRating ?? b.playerBestOvr ?? b.playerSchemeOvr ?? b.teamSchemeOvr ?? b.ovrRating ?? 0;
      return ovrB - ovrA;
    });
  const seasonInfo = snapshot?.info?.careerHubInfo?.seasonInfo || {};
  const seasonTitle = (seasonInfo.seasonTitle || '').toLowerCase();
  const weekTypeRaw = seasonInfo.seasonWeekType ?? seasonInfo.seasonWeekTypeId ?? seasonInfo.weekType;
  const weekType = Number.isFinite(Number(weekTypeRaw)) ? Number(weekTypeRaw) : 1; // default to regular-season
  const isRegularOrPost = weekType === 1 || weekType === 2;
  const isOffseason =
    weekType === 8 || // explicit offseason code
    seasonTitle.includes('offseason') ||
    (seasonInfo.isDraftActive === false && seasonInfo.isLeagueStarted === true && !isRegularOrPost);
  const pickContext = getMaddenPickContext(snapshot);
  const draftBaseYear = Math.max(2027, pickContext.draftBaseYear);
  const teamMeta = teamLookup(snapshot, teamId);
  const teamName = getFullTeamName(teamMeta, String(teamId || ''));
  const allTeams = (snapshot?.teams?.leagueTeamInfoList || []).map(t =>
    getFullTeamName(t, t.abbrName || 'Team')
  ).filter(Boolean);

  const offensePos = new Set(['QB', 'HB', 'RB', 'FB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT']);
  const defensePos = new Set(['LE', 'RE', 'DL', 'DT', 'EDGE', 'REDGE', 'LEDGE', 'OLB', 'ROLB', 'LOLB', 'MLB', 'MIKE', 'WILL', 'SAM', 'CB', 'FS', 'SS', 'DB']);
  const specialPos = new Set(['K', 'P', 'LS']);

  const buckets = [
    { key: 'off', label: 'Offense', items: [] },
    { key: 'def', label: 'Defense', items: [] },
    { key: 'st', label: 'Special Teams', items: [] },
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

  const pickYearOptions = [draftBaseYear, draftBaseYear + 1, draftBaseYear + 2];
  const combinedPickOptions = [];

  pickYearOptions.forEach((pickYear) => {
    const firstRoundLabels = getFirstRoundPickLabelsForTeam(teamName, pickYear, allTeams);
    firstRoundLabels.forEach(label => {
      const parsed = parsePickValue(label, draftBaseYear, {
        currentYearExactAllowed: pickContext.currentYearExactAllowed,
      });
      combinedPickOptions.push({
        label,
        value: `pick:${label}`,
        description: `Val ${Number(parsed?.value || 0).toFixed(1)}`.slice(0, 100),
      });
    });
    [2, 3, 4, 5, 6, 7].forEach(round => {
      const roundLabel = `${pickYear} Round ${round}`;
      const parsed = parsePickValue(roundLabel, draftBaseYear, {
        currentYearExactAllowed: pickContext.currentYearExactAllowed,
      });
      combinedPickOptions.push({
        label: roundLabel,
        value: `pick:${roundLabel}`,
        description: `Val ${Number(parsed?.value || 0).toFixed(1)}`.slice(0, 100),
      });
    });
  });

  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_select_assets|${side}|${draftId}|picks|0`)
        .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} draft picks (2027-2029)`)
        .setMinValues(1)
        .setMaxValues(Math.min(5, combinedPickOptions.length))
        .addOptions(combinedPickOptions.slice(0, 25))
    )
  );

  return rows.slice(0, 5);
}

function summarizeAssets(draft, valueMap, seasonYear, pickOptions = {}) {
  // Madden path (default)
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
        const canonical = item.raw
          || (item.pickNum
            ? `${item.year} Round ${item.round} Pick ${item.pickNum}`
            : `${item.year} Round ${item.round}`);
        const parsed = parsePickValue(canonical, seasonYear, pickOptions) || {};
        const val = Number.isFinite(Number(item.value)) ? Number(item.value) : Number(parsed.value || 0);
        const label = parsed.label || canonical || item.raw;
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
  // Restrict to 2K rosters directory and avoid cross-league fallbacks
  const dir = path.join(process.cwd(), 'data', '2k', 'teams_rosters');
  const candidates = [
    `${teamName || ''}.json`,
    `${(teamName || '').replace(/ /g, '_')}.json`,
    `${(teamName || '').replace(/_/g, ' ')}.json`,
  ].map(s => s.toLowerCase());
  let file = null;
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    file = files.find(f => candidates.includes(f.toLowerCase()));
  } catch { /* ignore */ }
  if (!file) {
    console.warn('[rosterForTeam2k] roster file not found for', teamName, { dir, candidates });
    return { players: [], picks: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (Array.isArray(data)) return { players: data, picks: [] };
    return {
      players: Array.isArray(data?.players) ? data.players : [],
      picks: Array.isArray(data?.picks) ? data.picks : [],
    };
  } catch (err) {
    console.error('[rosterForTeam2k] failed to read', file, err);
    return { players: [], picks: [] };
  }
}

function buildAssetSelectRows2k(side, draftId, teamName) {
  const draft = getTradeDraft(draftId);
  const seasonYear = draft?.seasonYear || new Date().getFullYear();
  console.log('[buildAssetSelectRows2k]', { draftId, side, teamName, userId: draft?.userId });
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

  // Include any VIA picks already on the roster (keep their original labels)
  rosterForTeam2k(teamName).picks?.forEach(p => {
    const label = typeof p === 'string' ? p : p?.pick || '';
    if (label && !picks.includes(label)) picks.push(label);
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
      const sal = currentYearSalary(p);
      const salText = sal ? ` | ${String(sal).replace(/[$,]/g, '').match(/^[0-9.]+$/) ? `$${Number(String(sal).replace(/[$,]/g,'')).toLocaleString()}` : sal}` : '';
      const desc = `${p.position || 'UNK'} | OVR ${p.ovr || '??'} | Val ${val}${salText}`;
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
    const pickOpts = picks.slice(0, 25).map(p => {
      const parsed = parsePickValue2k(p, draft.seasonYear) || {};
      return {
        label: p,
        value: `pick:${p}`,
        description: `Val ${Number(parsed?.value || 0).toFixed(1)}`.slice(0, 100),
      };
    });
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
  const parseSalary = (p) => {
    if (!p) return 0;
    if (typeof p.salaryPerYear === 'number') return p.salaryPerYear;
    const salaryStr = p.salaryPerYear || p.salary || (Array.isArray(p.contractYears) && p.contractYears[0]?.salary) || '';
    if (!salaryStr) return 0;
    const cleaned = String(salaryStr).replace(/[$,]/g, '').trim();
    const m = cleaned.match(/([0-9]*\.?[0-9]+)/);
    if (!m) return 0;
    let val = Number(m[1]);
    if (/m/i.test(cleaned)) val *= 1_000_000;
    return Number.isFinite(val) ? val : 0;
  };

  const formatSalary = (n) => {
    if (!n) return '$0';
    const m = n / 1_000_000;
    return m >= 1 ? `$${m.toFixed(1)}M` : `$${n.toLocaleString()}`;
  };

  // currentYearSalary defined at top-level

  const summarize = (arr) => {
    let total = 0;
    let salary = 0;
    const lines = [];
    arr.forEach(item => {
      if (item.type === 'player') {
        const val = computePlayerValue2k(item);
        total += val;
        const sal = parseSalary(item);
        salary += sal;
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
    return { total, lines, salary, salaryPretty: formatSalary(salary) };
  };
  return {
    your: summarize(draft.assets?.your || []),
    other: summarize(draft.assets?.other || []),
  };
}

export function buildButtons(draftId) {
  const draft = getTradeDraft(draftId);
  const is2k = draft?.mode === '2k';
  // 2K: only allow manual pick entry in offseason when order known.
  let allowManualCurrentPick = !is2k;
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
  if (is2k && allowManualCurrentPick) {
    actionRow.addComponents(
      new ButtonBuilder().setCustomId(`trade_builder_pick_manual|yours|${draftId}`).setLabel('Type pick (yours)').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`trade_builder_pick_manual|other|${draftId}`).setLabel('Type pick (theirs)').setStyle(ButtonStyle.Secondary),
    );
  }
  actionRow.addComponents(
    new ButtonBuilder().setCustomId(`trade_builder_reset|${draftId}`).setLabel('Reset').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(submitId).setLabel('Submit').setStyle(ButtonStyle.Success),
  );
  rows.push(actionRow);
  return rows;
}

function buildPrivatePayload(interaction, payload) {
  return interaction.inGuild() ? { ...payload, flags: 64 } : payload;
}

async function refreshBuilder(interaction, draft, snapshot) {
  const doUpdate = async (payload) => {
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.update(payload);
  };

  if (draft.mode === '2k') {
    const summary = summarizeAssets2k(draft);
    const gap = summary.your.total - summary.other.total;
    const GAP_LIMIT = 50;
    // Salary matching validation per team (NBA 2025-26 rules)
    const yourSalary = summary.your.salary;
    const otherSalary = summary.other.salary;

    // Compute current team payrolls from 2K rosters (more tolerant matching)
    const embed = new EmbedBuilder()
      .setTitle('Trade Builder')
      .setDescription(
        [
          `Value gap (you - them): ${gap.toFixed(1)}${Math.abs(gap) > GAP_LIMIT ? ' — exceeds limit' : ' — within limit'}`,
        ].join('\n')
      )
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
    await doUpdate({
      content: null,
      embeds: [embed],
      components: buildButtons(draft.draftId),
    });
    return;
  }
  const valueMap = buildValueMap(snapshot);
  const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear
    || snapshot?.info?.calendarYear
    || new Date().getFullYear();
  const baseYear = Math.max(2027, seasonYear);
  const pickContext = getMaddenPickContext(snapshot);
  const summary = summarizeAssets(draft, valueMap, baseYear, {
    currentYearExactAllowed: pickContext.currentYearExactAllowed,
  });
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
  await doUpdate({
    content: null,
    embeds: [embed],
    components: buildButtons(draft.draftId),
  });
}

export async function execute(interaction) {
  const draftId = interaction.customId.split('|')[1];
  const draft = getTradeDraft(draftId);
  const leagueId = draft?.leagueId || resolveLeagueIdWithConfig(interaction.guildId);
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
    const snapshot = loadLeagueSnapshot(leagueId);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
  if (ADD_CUSTOM_ID.test(interaction.customId)) {
    const [, side, draftId] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft || !(draft.mode === '2k' ? draft[side === 'yours' ? 'yourTeamName' : 'otherTeamName'] : draft[side === 'yours' ? 'yourTeamId' : 'otherTeamId'])) {
      await interaction.reply(buildPrivatePayload(interaction, { content: 'Select both teams first.' }));
      return;
    }
    if (draft.mode === '2k') {
      // Hard override: specific user forced to Timberwolves to avoid wrong roster
      const forceTeam = (draft.userId === '840269359578611753' && side === 'yours')
        ? 'Minnesota Timberwolves'
        : null;
      const teamName = forceTeam || (side === 'yours' ? draft.yourTeamName : draft.otherTeamName);
      const rows = buildAssetSelectRows2k(side === 'yours' ? 'yours' : 'other', draftId, teamName);
      if (!rows?.length) {
        await interaction.reply(buildPrivatePayload(interaction, { content: 'No assets found for that team.' }));
        return;
      }
      await interaction.reply(buildPrivatePayload(interaction, { content: `Select assets for ${side === 'yours' ? 'your' : 'their'} team`, components: rows.slice(0, 5) }));
      if (rows.length > 5) {
        await interaction.followUp(buildPrivatePayload(interaction, {
          content: 'More options (picks / remaining positions):',
          components: rows.slice(5, 10),
        }));
      }
      return;
    }
    if (!leagueId) return;
    const snapshot = loadLeagueSnapshot(leagueId);
    const rows = buildAssetSelectRows(side === 'yours' ? 'yours' : 'other', draftId, snapshot, side === 'yours' ? draft.yourTeamId : draft.otherTeamId);
    if (!rows?.length) {
      await interaction.reply(buildPrivatePayload(interaction, { content: 'No assets found for that team. Try again after a sync.' }));
      return;
    }
    await interaction.reply(buildPrivatePayload(interaction, {
      content: `Select assets for ${side === 'yours' ? 'your' : 'their'} team`,
      components: rows.slice(0, 5), // Discord limit 5 rows
    }));
    return;
  }
  if (MENU_CUSTOM_ID.test(interaction.customId)) {
    const [, side, draftId] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft) {
      await interaction.reply(buildPrivatePayload(interaction, { content: 'Trade builder expired. Start again.' }));
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
    const draftYearBase = Math.max(
      2027,
      snapshot?.info?.careerHubInfo?.seasonInfo?.calendarYear || snapshot?.info?.calendarYear || new Date().getFullYear()
    );
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
        const rawValue = v.slice('pick:'.length);
        const parts = v.split(':');
        const isLegacyStructured = parts.length >= 3 && /^\d{4}$/.test(parts[1] || '');
        const year = parts[1];
        const rnd = parts[2];
        const pickNum = parts[3];
        const suffix = rnd === '1' ? 'st' : rnd === '2' ? 'nd' : rnd === '3' ? 'rd' : 'th';
        const raw = isLegacyStructured
          ? (pickNum ? `${year} ${rnd}${suffix} pick ${pickNum}` : `${year} ${rnd}${suffix}`)
          : rawValue;
        if (assetsArr.find(a => a.type === 'pick' && a.raw === raw)) return;
        const parsed = draft.mode === '2k'
          ? parsePickValue2k(raw, draft.seasonYear)
          : parsePickValue(raw, draftYearBase, {
            currentYearExactAllowed: getMaddenPickContext(snapshot).currentYearExactAllowed,
          });
        assetsArr.push({
          type: 'pick',
          raw: parsed?.canonical || raw,
          year: parsed?.year ?? Number(year),
          round: parsed?.round ?? Number(rnd),
          pickNum: parsed?.pickNum ?? (pickNum ? Number(pickNum) : null),
          protection: parsed?.protection,
          value: parsed?.value,
          label: parsed?.label,
          viaTeam: parsed?.viaTeam,
          originalOwner: parsed?.originalOwner,
          via: parsed?.via,
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
      await interaction.reply(buildPrivatePayload(interaction, { content: 'For NBA, add picks from the Picks menu.' }));
      return;
    }
    const [, side, draftId] = interaction.customId.split('|');
    const modalId = `trade_builder_pick_modal|${side}|${draftId}`;
    const modal = new ModalBuilder()
      .setCustomId(modalId)
      .setTitle('Add draft pick');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('pickLabel')
          .setLabel('Pick (e.g., 2027 R1 via Jets; 2027 R1P4 via Jets)')
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
      await interaction.reply(buildPrivatePayload(interaction, { content: 'Trade builder expired. Start again.' }));
      return;
    }
    if (!leagueId) {
      await interaction.reply(buildPrivatePayload(interaction, { content: 'No league configured. Run /madden-set-league first.' }));
      return;
    }
    const snapshot = loadLeagueSnapshot(leagueId);
    const pickContext = getMaddenPickContext(snapshot);
    const draftYearBase = Math.max(2027, pickContext.draftBaseYear);
    const rawInput = interaction.fields.getTextInputValue('pickLabel') || '';
    const parsed = draft.mode === '2k'
      ? parsePickValue2k(rawInput, draft.seasonYear)
      : parsePickValue(rawInput, draftYearBase, {
        currentYearExactAllowed: pickContext.currentYearExactAllowed,
      });
    if (!parsed) {
      await interaction.reply(buildPrivatePayload(interaction, { content: 'Could not parse that pick. Try formats like \"2027 Round 1\", \"2027 Round 1 via Jets\", or \"2027 Round 1 Pick 4 via Jets\".' }));
      return;
    }
    draft.assets = draft.assets || { your: [], other: [] };
    const assetsArr = draft.assets[side === 'yours' ? 'your' : 'other'] || [];
    const canonical = parsed.canonical
      || (parsed.pickNum
        ? `${parsed.year} Round ${parsed.round} Pick ${parsed.pickNum}`
        : `${parsed.year} Round ${parsed.round}`);
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
        viaTeam: parsed.viaTeam,
        originalOwner: parsed.originalOwner,
        via: parsed.via,
      });
    }
    draft.assets[side === 'yours' ? 'your' : 'other'] = assetsArr;
    saveTradeDraft(draftId, draft);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
}

export default { customId, execute };
