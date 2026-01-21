import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../madden/madden_data.js';
import { computePlayerValue, buildValueMap, parsePickValue } from './madden_trade_modal_submit.js';
import { getTradeDraft, saveTradeDraft } from '../utils/trade_draft_store.js';

const MENU_CUSTOM_ID = /^trade_builder_select_assets\|(yours|other)\|/;
const ADD_CUSTOM_ID = /^trade_builder_add\|(yours|other)\|/;
const RESET_CUSTOM_ID = /^trade_builder_reset\|/;
export const customId = /^(trade_builder_add\|(yours|other)\|.+|trade_builder_select_assets\|(yours|other)\|.+|trade_builder_reset\|.+)$/;

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
  const years = [yr, yr + 1];
  const opts = [];
  years.forEach(y => {
    rounds.forEach(r => {
      const suffix = r === 1 ? 'st' : r === 2 ? 'nd' : r === 3 ? 'rd' : 'th';
      opts.push({ label: `${y} ${r}${suffix}`, value: `pick:${y}:${r}` });
    });
  });
  return opts;
}

function buildAssetSelectRows(side, draftId, snapshot, teamId) {
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

  const offensePos = new Set(['QB','HB','RB','FB','WR','TE','LT','LG','C','RG','RT']);
  const defensePos = new Set(['LE','RE','DL','DT','EDGE','REDGE','LEDGE','OLB','ROLB','LOLB','MLB','MIKE','WILL','SAM','CB','FS','SS','DB']);
  const specialPos = new Set(['K','P','LS']);

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

  // add picks to special/picks bucket
  pickOptions(year).forEach(p => buckets[2].items.push(new StringSelectMenuOptionBuilder().setLabel(p.label).setValue(p.value)));

  const rows = buckets
    .map(bucket => bucket.items.slice(0, 25))
    .filter(arr => arr.length)
    .map((opts, idx) => new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`trade_builder_select_assets|${side}|${draftId}|${buckets[idx].key}`)
        .setPlaceholder(`Add ${side === 'yours' ? 'your' : 'their'} ${buckets[idx].label}`)
        .setMinValues(1)
        .setMaxValues(Math.min(5, opts.length))
        .addOptions(opts)
    ));
  return rows;
}

function summarizeAssets(draft, valueMap, seasonYear) {
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
        const parsed = parsePickValue(item.raw, seasonYear);
        const val = parsed?.value || 0;
        total += val;
        lines.push(`${parsed?.label || item.raw} — ${val.toFixed(1)}`);
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
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade_builder_add|yours|${draftId}`).setLabel('Add your assets').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`trade_builder_add|other|${draftId}`).setLabel("Add their assets").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`trade_builder_search|yours|${draftId}`).setLabel('Search your team').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`trade_builder_search|other|${draftId}`).setLabel('Search their team').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`trade_builder_reset|${draftId}`).setLabel('Reset').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`madden_trade_preview_submit|${draftId}`).setLabel('Submit').setStyle(ButtonStyle.Success),
    )
  ];
}

async function refreshBuilder(interaction, draft, snapshot) {
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
  if (!leagueId) return;
  if (RESET_CUSTOM_ID.test(interaction.customId)) {
    const draftId = interaction.customId.split('|')[1];
    const draft = getTradeDraft(draftId);
    if (!draft) return;
    draft.assets = { your: [], other: [] };
    saveTradeDraft(draftId, draft);
    const snapshot = loadLeagueSnapshot(leagueId);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
  if (ADD_CUSTOM_ID.test(interaction.customId)) {
    const [ , side, draftId ] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft || !draft[side === 'yours' ? 'yourTeamId' : 'otherTeamId']) {
      await interaction.reply({ content: 'Select both teams first.', ephemeral: true });
      return;
    }
    const snapshot = loadLeagueSnapshot(leagueId);
    const rows = buildAssetSelectRows(side === 'yours' ? 'yours' : 'other', draftId, snapshot, side === 'yours' ? draft.yourTeamId : draft.otherTeamId);
    if (!rows?.length) {
      await interaction.reply({ content: 'No assets found for that team. Try again after a sync.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `Select assets for ${side === 'yours' ? 'your' : 'their'} team`,
      components: rows.slice(0, 3), // max 3 rows for Discord limit
      ephemeral: true,
    });
    return;
  }
  if (MENU_CUSTOM_ID.test(interaction.customId)) {
    const [ , side, draftId ] = interaction.customId.split('|');
    const draft = getTradeDraft(draftId);
    if (!draft) {
      await interaction.reply({ content: 'Trade builder expired. Start again.', ephemeral: true });
      return;
    }
    const snapshot = loadLeagueSnapshot(leagueId);
    const valueMap = buildValueMap(snapshot);
    const seasonYear = snapshot?.info?.careerHubInfo?.seasonInfo?.seasonYear;
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
        const [, year, rnd] = v.split(':');
        const raw = `${year} ${rnd}rd`;
        if (assetsArr.find(a => a.type === 'pick' && a.raw === raw)) return;
        assetsArr.push({ type: 'pick', raw });
      }
    });
    draft.assets = draft.assets || { your: [], other: [] };
    draft.assets[side === 'yours' ? 'your' : 'other'] = assetsArr;
    // persist label strings for submit
    saveTradeDraft(draftId, draft);
    await refreshBuilder(interaction, draft, snapshot);
    return;
  }
}

export default { customId, execute };
