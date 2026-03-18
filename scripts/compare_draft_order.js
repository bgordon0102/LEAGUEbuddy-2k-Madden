import fs from 'fs';
import path from 'path';

// NOTE: We intentionally do NOT import `src/madden/coach/mockdraft.js` because it also registers
// Discord slash commands and can boot the bot when imported. This script is a lightweight
// diagnostic tool.

const DRAFT_ORDER_OVERRIDES_FILE = path.join(process.cwd(), 'data', 'madden', 'draft_order_overrides.json');
const PICK_TRADES_FILE = path.join(process.cwd(), 'data', 'madden', 'pick_trades.json');

function normalizeTeamKey(name = '') {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function safeReadJSON(file, fallback = null) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function loadOfficialDraftOrderOverride(league, seasonYear) {
    const raw = safeReadJSON(DRAFT_ORDER_OVERRIDES_FILE, null);
    if (!raw) return null;
    const seasonEntry = raw?.[String(seasonYear)];
    const items = Array.isArray(seasonEntry) ? seasonEntry : seasonEntry?.round1;
    if (!Array.isArray(items) || !items.length) return null;

    const teamInfo = league?.teams?.leagueTeamInfoList || [];
    const standings = league?.standings?.teamStandingInfoList || [];
    const standingById = new Map(standings.map((t) => [Number(t.teamId), t]));
    const getFullTeamName = (team) => (
        team?.displayName
        || `${team?.cityName || ''} ${team?.nickName || ''}`.trim()
        || team?.nickName
        || team?.teamName
        || `Team ${team?.teamId}`
    );
    const teamEntries = teamInfo.map((team) => {
        const fullName = getFullTeamName(team);
        const standing = standingById.get(Number(team.teamId));
        return {
            id: Number(team.teamId),
            name: fullName,
            nick: team.teamNickName || fullName.split(/\s+/).slice(-1)[0],
            w: Number(standing?.totalWins || 0),
            l: Number(standing?.totalLosses || 0),
            ties: Number(standing?.totalTies || 0),
            net: Number(standing?.netPts || 0),
            pf: Number(standing?.ptsFor || 0),
        };
    });

    const lookup = new Map();
    const addVariant = (key, team) => {
        const norm = normalizeTeamKey(key || '');
        if (norm) lookup.set(norm, team);
    };
    teamEntries.forEach((team) => {
        addVariant(team.name, team);
        addVariant(team.nick, team);
        const mascot = (team.name || '').split(/\s+/).slice(-1)[0];
        addVariant(mascot, team);
        addVariant((team.name || '').replace(/^new\s+/i, ''), team);
    });

    const order = items.map((item) => {
        const team = lookup.get(normalizeTeamKey(item.team || item.owner || ''));
        if (!team) return null;
        return { ...team, via: item.via || null };
    }).filter(Boolean);

    return order.length === items.length ? order : null;
}

function buildSoS(league) {
    const standings = league?.standings?.teamStandingInfoList || [];
    const schedule = league?.schedule?.schedules || [];
    const recordById = new Map(standings.map((t) => {
        const id = Number(t.teamId);
        const w = Number(t.totalWins || 0);
        const l = Number(t.totalLosses || 0);
        const ties = Number(t.totalTies || 0);
        const games = Math.max(1, w + l + ties);
        return [id, { w, l, ties, games, winPct: (w + (ties * 0.5)) / games }];
    }));
    const games = schedule.filter((g) => Number(g.stageIndex ?? g.stage ?? 1) === 1);
    const opps = new Map();
    for (const g of games) {
        const away = Number(g.awayTeamId);
        const home = Number(g.homeTeamId);
        if (!Number.isFinite(away) || !Number.isFinite(home)) continue;
        opps.set(away, (opps.get(away) || []).concat(home));
        opps.set(home, (opps.get(home) || []).concat(away));
    }
    const sos = {};
    for (const [id, list] of opps.entries()) {
        const pct = (list || [])
            .map((oppId) => recordById.get(Number(oppId))?.winPct)
            .filter((v) => Number.isFinite(v));
        sos[id] = pct.length ? (pct.reduce((a, b) => a + b, 0) / pct.length) : 0;
    }
    return sos;
}

function draftOrder(league) {
    const standings = league?.standings?.teamStandingInfoList || [];
    const sos = buildSoS(league);
    const teams = standings.map(t => ({
        id: Number(t.teamId),
        name: t.teamName,
        nick: t.teamNickName,
        w: Number(t.totalWins || 0),
        l: Number(t.totalLosses || 0),
        ties: Number(t.totalTies || 0),
        net: Number(t.netPts || 0),
        pf: Number(t.ptsFor || 0),
        playoff: Number(t.playoffStatus || 0),
    }));

    // Regular season approximation: non-playoff teams first by record, then SoS, then net, then PF.
    // (This matches the tie-break structure used in the main bot code.)
    const non = teams.filter(t => !t.playoff);
    const ply = teams.filter(t => !!t.playoff);

    const sortWithTies = (arr) => arr.sort((a, b) => {
        if (a.w !== b.w) return a.w - b.w;
        if (a.l !== b.l) return b.l - a.l;
        const sa = sos[a.id] ?? 0;
        const sb = sos[b.id] ?? 0;
        if (sa !== sb) return sa - sb;
        if (a.net !== b.net) return a.net - b.net;
        if (a.pf !== b.pf) return a.pf - b.pf;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return [...sortWithTies(non), ...sortWithTies(ply)].slice(0, 32);
}

function applyPickTrades(order, seasonYear) {
    const trades = safeReadJSON(PICK_TRADES_FILE, null);
    if (!trades || !Array.isArray(trades?.trades)) return order;
    // Minimal trade overlay: if a trade says { year, round: 1, owner, via, newOwner }, rewrite owner.
    const relevant = trades.trades.filter(t => Number(t.year) === Number(seasonYear) && Number(t.round || 1) === 1);
    if (!relevant.length) return order;
    const byKey = new Map(relevant.map(t => [`${normalizeTeamKey(t.owner)}|${normalizeTeamKey(t.via || '')}`, t]));
    return order.map(slot => {
        const key = `${normalizeTeamKey(slot.name)}|${normalizeTeamKey(slot.via || '')}`;
        const t = byKey.get(key);
        if (!t) return slot;
        return { ...slot, name: t.newOwner || slot.name };
    });
}

function latestLeagueFile() {
    const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
            file: path.join(dir, f),
            mtime: fs.statSync(path.join(dir, f)).mtimeMs,
            name: f,
        }))
        .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.file || null;
}

function fmtRow(row, idx) {
    const base = `${String(idx + 1).padStart(2, '0')}. ${row.name || row.nick || row.id}`;
    const rec = `${row.w ?? 0}-${row.l ?? 0}${row.ties ? `-${row.ties}` : ''}`;
    return `${base} (${rec})`;
}

const file = latestLeagueFile();
if (!file) {
    console.error('No league snapshot found under data/madden/leagues');
    process.exit(1);
}
const league = JSON.parse(fs.readFileSync(file, 'utf8'));
const seasonYear = Number(league?.info?.careerHubInfo?.seasonInfo?.calendarYear || league?.info?.calendarYear || league?.calendarYear || 0) + 1;

const official = loadOfficialDraftOrderOverride(league, seasonYear);
const computed = applyPickTrades(draftOrder(league), seasonYear);

console.log('Using league file:', file);
console.log('Draft year:', seasonYear);
console.log('\nOFFICIAL OVERRIDE (first 10):');
(official || []).slice(0, 10).forEach((r, i) => console.log(fmtRow(r, i)));
if (!official || !official.length) {
    const raw = safeReadJSON(DRAFT_ORDER_OVERRIDES_FILE, {});
    const rawCount = Array.isArray(raw?.[String(seasonYear)]) ? raw[String(seasonYear)].length : 0;
    console.log(`(override not resolved for this snapshot; raw override entries for ${seasonYear}: ${rawCount})`);
}
console.log('\nCOMPUTED DYNAMIC (first 10):');
computed.slice(0, 10).forEach((r, i) => console.log(fmtRow(r, i)));

if (official && official.length) {
    console.log('\nDIFF (first 32):');
    for (let i = 0; i < 32; i += 1) {
        const o = official[i];
        const c = computed[i];
        const ok = (o?.id === c?.id) || (String(o?.name || '').toLowerCase() === String(c?.name || '').toLowerCase());
        if (!ok) {
            console.log(`Pick ${i + 1}: override=${o?.name || o?.nick || o?.id} vs computed=${c?.name || c?.nick || c?.id}`);
        }
    }
}
