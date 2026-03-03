import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { deriveTeamNeeds, loadTeamEmojis, formatTeamEmoji, draftOrder, applyPickTrades } from './mockdraft.js';
import { computeSeasonTop100FromHistory } from '../top_players.js';

const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');
const PLAYER_STATS_PATH = path.join(process.cwd(), 'data', 'madden', 'player_stats.json');
const POS_ALIAS = { EDGE: 'REDG', REDGE: 'REDG', LEDGE: 'LEDG' };
const POSITION_NEEDS = {
    // Offense
    QB: 1, HB: 1, FB: 1,
    LT: 1, LG: 1, C: 1, RG: 1, RT: 1,
    WR: 3, TE: 1,
    // Defense
    LEDG: 1, REDG: 1,
    DT: 2,
    SAM: 1, MIKE: 1, WILL: 1,
    CB: 3, FS: 1, SS: 1,
};

function normalizeName(name = '') {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getMetricOvr(p) {
    return p.playerBestOvr ?? p.teamSchemeOvr ?? p.overallRating ?? p.playerSchemeOvr ?? 0;
}

function getCoachTeam(member) {
    // Determine a coach's team from their Discord roles using the Madden role map.
    if (!member) return null;
    let roleMap = {};
    try {
        roleMap = JSON.parse(fs.readFileSync(ROLE_MAP_PATH, 'utf8'));
    } catch {
        return null;
    }
    const roles = member.roles?.cache;
    if (!roles) return null;
    for (const [name, id] of Object.entries(roleMap)) {
        if (!name.endsWith(' Coach')) continue;
        if (roles.has(id)) return name.replace(/ Coach$/, '');
    }
    return null;
}

function buildAllProTeams(list) {
    const grouped = {};
    list.forEach(p => {
        let pos = (p.position || p.displayPos || '').toUpperCase();
        if (POS_ALIAS[pos]) pos = POS_ALIAS[pos];
        if (!POSITION_NEEDS[pos]) return;
        const grade = Number(p.seasonGrade ?? p.grade ?? p.weeklyGrade ?? p.score ?? 0);
        if (!grouped[pos]) grouped[pos] = [];
        grouped[pos].push({ ...p, displayPos: pos, grade });
    });
    Object.keys(grouped).forEach(k => grouped[k].sort((a, b) => b.grade - a.grade));
    const first = [];
    const excluded = new Set();
    const take = (arr, pos, count) => {
        let taken = 0;
        for (const p of arr || []) {
            const id = p.id || `${p.name}-${p.teamId || ''}`;
            if (excluded.has(id)) continue;
            first.push(p);
            excluded.add(id);
            taken += 1;
            if (taken >= count) break;
        }
    };
    for (const [pos, cnt] of Object.entries(POSITION_NEEDS)) {
        take(grouped[pos], pos, cnt);
    }
    const second = [];
    const takeSecond = (arr, pos, count) => {
        let taken = 0;
        for (const p of arr || []) {
            const id = p.id || `${p.name}-${p.teamId || ''}`;
            if (excluded.has(id)) continue;
            second.push(p);
            excluded.add(id);
            taken += 1;
            if (taken >= count) break;
        }
    };
    for (const [pos, cnt] of Object.entries(POSITION_NEEDS)) {
        takeSecond(grouped[pos], pos, cnt);
    }
    return { first, second };
}

function mapPositionToNeed(player) {
    const pos = (player.position || player.position_1 || '').trim().toUpperCase();
    if (POS_ALIAS[pos]) pos = POS_ALIAS[pos];
    if (pos === 'QB') return 'QB';
    if (['LT', 'RT'].includes(pos)) return 'OT';
    if (['LG', 'C', 'RG'].includes(pos)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(pos)) return 'EDGE';
    if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(pos)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    if (pos === 'CB') return 'CB';
    if (['FS', 'SS'].includes(pos)) return 'S';
    if (pos === 'TE') return 'TE';
    if (pos === 'WR') return 'WR';
    if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
    return 'BPA';
}

function resolveTeamNeeds(teamName, league, needsByTeam) {
    // Try exact normalized match first
    const norm = normalizeName(teamName);
    if (needsByTeam[norm]) return needsByTeam[norm];

    const leagueTeamsNeed = league?.teams?.leagueTeamInfoList || [];
    for (const t of leagueTeamsNeed) {
        const candidates = [
            `${t.cityName || ''} ${t.nickName || ''}`,
            t.nickName,
            t.displayName,
            t.abbrName,
            t.cityName,
        ].filter(Boolean).map(normalizeName);
        if (candidates.includes(norm)) {
            const key = candidates[0]; // normalized city+nick
            return needsByTeam[key] || needsByTeam[normalizeName(t.nickName || '')] || [];
        }
    }
    // Fallback: find closest that contains the norm
    const fuzzy = Object.entries(needsByTeam).find(([k]) => k.includes(norm) || norm.includes(k));
    return fuzzy ? fuzzy[1] : [];
}

function qbDepthStatus(teamName, league) {
    // Return whether the team should look for a depth QB based on roster.
    const norm = normalizeName(teamName);
    const leagueTeamsDepth = league?.teams?.leagueTeamInfoList || [];
    const rosters = league?.rosters?.teams || {};
    let depthTeamId = null;
    for (const t of leagueTeamsDepth) {
        const candidates = [
            `${t.cityName || ''} ${t.nickName || ''}`,
            t.nickName,
            t.displayName,
            t.abbrName,
            t.cityName,
        ].filter(Boolean).map(normalizeName);
        if (candidates.includes(norm)) {
            depthTeamId = Number(t.teamId);
            break;
        }
    }
    if (depthTeamId === null) return { wantDepthQB: false };
    const roster = rosters[depthTeamId] || rosters[String(depthTeamId)] || {};
    const players = roster.rosterInfoList || [];
    const qbs = players.filter(p => (p.position || '').toUpperCase() === 'QB')
        .sort((a, b) => getMetricOvr(b) - getMetricOvr(a));
    const count = qbs.length;
    const starterOvr = qbs[0] ? getMetricOvr(qbs[0]) : 0;
    const backupOvr = qbs[1] ? getMetricOvr(qbs[1]) : 0;
    const wantDepthQB = count < 2 || backupOvr < 70;
    return { wantDepthQB, starterOvr, backupOvr, qbCount: count };
}

function loadDraftClass() {
    const dir = path.join(process.cwd(), 'data', 'draft_classes', 'madden');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir)
        .filter(f => f.toLowerCase().includes('cus') && f.toLowerCase().includes('big board') && f.endsWith('.json'))
        .sort();
    if (!files.length) return [];
    const data = JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
    return Object.values(data).filter(p => p && p.name);
}

function seededRand(teamName, round, max) {
    // Simple deterministic hash to diversify picks per team/round
    const str = `${teamName}|${round}`;
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h % max;
}

export const data = new SlashCommandBuilder()
    .setName('madden-draftprimer')
    .setDescription('Get a draft primer: 7 players to target (1 per round) and a draft strategy blurb.')
    .setDMPermission(false);

export async function execute(interaction) {
    const teamName = getCoachTeam(interaction.member);
    if (!teamName) {
        await interaction.reply({ content: 'You are not mapped to a Madden team. Contact a commissioner.', flags: 64 });
        return;
    }
    // Avoid Discord "Unknown interaction" by deferring immediately (ephemeral via flags)
    if (!interaction.deferred && !interaction.replied) {
        try {
            await interaction.deferReply({ flags: 64 });
        } catch (err) {
            if (err?.code === 10062 || err?.code === 40060) return;
            throw err;
        }
    }
    // Load latest league file
    const leagueFile = (() => {
        const dir = path.join(process.cwd(), 'data', 'madden', 'leagues');
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.json'))
            .map(f => ({ f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        return files.length ? path.join(dir, files[0].f) : null;
    })();
    if (!leagueFile) {
        await interaction.reply({ content: 'No league snapshot found.', ephemeral: true });
        return;
    }
    const league = JSON.parse(fs.readFileSync(leagueFile, 'utf8'));
    const leagueId = league?.info?.leagueId || league?.leagueId || league?.info?.leagueInfo?.leagueId || 'default';

    // Resolve teamId early (used throughout)
    const leagueTeamsAll = league?.teams?.leagueTeamInfoList || [];
    let teamId = null;
    for (const t of leagueTeamsAll) {
        const candidates = [
            `${t.cityName || ''} ${t.nickName || ''}`,
            t.nickName,
            t.displayName,
            t.abbrName,
            t.cityName,
        ].filter(Boolean).map(normalizeName);
        const target = normalizeName(teamName);
        if (candidates.includes(target)) {
            teamId = Number(t.teamId);
            break;
        }
    }
    if (teamId === null) {
        const target = normalizeName(teamName);
        const hit = leagueTeamsAll.find(t => normalizeName(t.displayName || t.nickName || '').includes(target));
        if (hit) teamId = Number(hit.teamId);
    }

    // Load prebuilt team stats (authoritative) and fall back to inline aggregation if missing
    let seasonAgg = {};
    let seasonCounts = {};
    let playerAgg = {};
    const playerStats = fs.existsSync(PLAYER_STATS_PATH) ? JSON.parse(fs.readFileSync(PLAYER_STATS_PATH, 'utf8')) : {};
    const rosterNameById = {};
    const rosterAgeById = {};
    const rosterOvrById = {};
    const rosterYearsLeftById = {};
    for (const [tidStr, rosterTeam] of Object.entries(league.rosters?.teams || {})) {
        for (const p of rosterTeam?.rosterInfoList || []) {
            rosterNameById[p.rosterId] = p.displayName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unknown';
            rosterAgeById[p.rosterId] = p.age ?? p.playerAge ?? null;
            rosterOvrById[p.rosterId] = getMetricOvr(p);
            rosterYearsLeftById[p.rosterId] = p.contractYearsLeft ?? p.contractLength ?? null;
        }
    }
    const TEAM_STATS_PATH = path.join(process.cwd(), 'data', 'madden', 'team_stats.json');
    const teamNameById = Object.fromEntries((league.teams?.leagueTeamInfoList || []).map(t => [Number(t.teamId), `${t.cityName || ''} ${t.nickName || ''}`.trim() || t.displayName || t.abbrName || String(t.teamId)]));
    const useTeamStatsFile = fs.existsSync(TEAM_STATS_PATH);
    if (useTeamStatsFile) {
        seasonAgg = JSON.parse(fs.readFileSync(TEAM_STATS_PATH, 'utf8'));
        // counts: assume data present for categories where numbers exist
        seasonCounts = Object.fromEntries(Object.entries(seasonAgg).map(([tid, stats]) => {
            const c = {};
            if (stats.pass?.yds !== undefined) c.pass = 1;
            if (stats.rush?.yds !== undefined) c.rush = 1;
            if (stats.rec?.yds !== undefined) c.rec = 1;
            if (stats.def?.sacks !== undefined) c.def = 1;
            return [tid, c];
        }));
        playerAgg = {}; // not needed when using prebuilt team stats
        // Fill gaps with weekly aggregation if a team is missing in team_stats.json
        const presentIds = new Set(Object.keys(seasonAgg).map(k => String(k)));
        const presentNames = new Set(Object.values(seasonAgg).map(s => normalizeName(s.teamName || '')));
        const bumpCount = (map, teamId, cat) => {
            map[teamId] = map[teamId] || {};
            map[teamId][cat] = (map[teamId][cat] || 0) + 1;
        };
        const latestSeason = Math.max(...(league.weeklyStats || [{ seasonIndex: 0 }]).map(w => w.seasonIndex || 0));
        const isRegularSeason = (w) => {
            const stage = w.stage ?? w.stageIndex;
            return stage === 1;
        };
        for (const week of (league.weeklyStats || [])
            .filter(w => (w.seasonIndex || 0) === latestSeason)
            .filter(w => isRegularSeason(w))
            .filter(w => (w.weekIndex ?? 0) <= 18)) {
            const addAgg = (obj, key, val) => {
                if (val === undefined || val === null) return;
                obj[key] = (obj[key] || 0) + val;
            };
            const ensureTeam = (tid) => {
                const tidStr = String(tid);
                if (!presentIds.has(tidStr)) {
                    seasonAgg[tid] = seasonAgg[tid] || {};
                }
                return seasonAgg[tid];
            };
            for (const p of week.passing?.playerPassingStatInfoList || []) {
                const tidStr = String(p.teamId);
                const teamNameNorm = normalizeName(teamNameById[p.teamId] || '');
                if (presentIds.has(tidStr) || presentNames.has(teamNameNorm)) continue; // already covered by prebuilt stats
                const team = ensureTeam(p.teamId);
                const pass = team.pass || (team.pass = { yds: 0, td: 0, int: 0, sacksTaken: 0, comp: 0, att: 0 });
                addAgg(pass, 'yds', p.passYds);
                addAgg(pass, 'td', p.passTDs);
                addAgg(pass, 'int', p.passInts);
                addAgg(pass, 'comp', p.passComp);
                addAgg(pass, 'att', p.passAtt);
                addAgg(pass, 'sacksTaken', p.passSacks);
                bumpCount(seasonCounts, p.teamId, 'pass');
                if (p.rosterId != null) {
                    const name = rosterNameById[p.rosterId] || p.fullName || 'Player';
                    playerAgg[p.rosterId] = playerAgg[p.rosterId] || { teamId: p.teamId, name };
                    addAgg(playerAgg[p.rosterId], 'passYds', p.passYds);
                    addAgg(playerAgg[p.rosterId], 'passTDs', p.passTDs);
                    addAgg(playerAgg[p.rosterId], 'passInts', p.passInts);
                    addAgg(playerAgg[p.rosterId], 'passComp', p.passComp);
                    addAgg(playerAgg[p.rosterId], 'passAtt', p.passAtt);
                }
            }
            for (const r of week.rushing?.playerRushingStatInfoList || []) {
                const tidStr = String(r.teamId);
                const teamNameNorm = normalizeName(teamNameById[r.teamId] || '');
                if (presentIds.has(tidStr) || presentNames.has(teamNameNorm)) continue;
                const team = ensureTeam(r.teamId);
                const rush = team.rush || (team.rush = { yds: 0, td: 0, att: 0 });
                addAgg(rush, 'yds', r.rushYds);
                addAgg(rush, 'td', r.rushTDs);
                addAgg(rush, 'att', r.rushAtt);
                bumpCount(seasonCounts, r.teamId, 'rush');
                if (r.rosterId != null) {
                    const name = rosterNameById[r.rosterId] || r.fullName || 'Player';
                    playerAgg[r.rosterId] = playerAgg[r.rosterId] || { teamId: r.teamId, name };
                    addAgg(playerAgg[r.rosterId], 'rushYds', r.rushYds);
                    addAgg(playerAgg[r.rosterId], 'rushAtt', r.rushAtt);
                    addAgg(playerAgg[r.rosterId], 'rushTDs', r.rushTDs);
                }
            }
            for (const r of week.receiving?.playerReceivingStatInfoList || []) {
                const tidStr = String(r.teamId);
                const teamNameNorm = normalizeName(teamNameById[r.teamId] || '');
                if (presentIds.has(tidStr) || presentNames.has(teamNameNorm)) continue;
                const team = ensureTeam(r.teamId);
                const rec = team.rec || (team.rec = { yds: 0, td: 0 });
                addAgg(rec, 'yds', r.recYds);
                addAgg(rec, 'td', r.recTDs);
                bumpCount(seasonCounts, r.teamId, 'rec');
                if (r.rosterId != null) {
                    const name = rosterNameById[r.rosterId] || r.fullName || 'Player';
                    playerAgg[r.rosterId] = playerAgg[r.rosterId] || { teamId: r.teamId, name };
                    addAgg(playerAgg[r.rosterId], 'recYds', r.recYds);
                    addAgg(playerAgg[r.rosterId], 'recTDs', r.recTDs);
                }
            }
            for (const d of week.defense?.playerDefensiveStatInfoList || []) {
                const tidStr = String(d.teamId);
                const teamNameNorm = normalizeName(teamNameById[d.teamId] || '');
                if (presentIds.has(tidStr) || presentNames.has(teamNameNorm)) continue;
                const team = ensureTeam(d.teamId);
                const def = team.def || (team.def = { sacks: 0, ints: 0 });
                addAgg(def, 'sacks', d.defSacks);
                addAgg(def, 'ints', d.defInts);
                bumpCount(seasonCounts, d.teamId, 'def');
                if (d.rosterId != null) {
                    const name = rosterNameById[d.rosterId] || d.fullName || 'Player';
                    playerAgg[d.rosterId] = playerAgg[d.rosterId] || { teamId: d.teamId, name };
                    addAgg(playerAgg[d.rosterId], 'sacks', d.defSacks);
                    addAgg(playerAgg[d.rosterId], 'ints', d.defInts);
                }
            }
        }
    } else {
        seasonAgg = {};
        seasonCounts = {};
        playerAgg = {};
        const bumpCount = (teamId, cat) => {
            if (teamId === undefined || teamId === null) return;
            seasonCounts[teamId] = seasonCounts[teamId] || {};
            seasonCounts[teamId][cat] = (seasonCounts[teamId][cat] || 0) + 1;
        };
        function addAgg(obj, key, val) {
            if (val === undefined || val === null) return;
            obj[key] = (obj[key] || 0) + val;
        }
        // Only aggregate the latest seasonIndex, regular season only (stage=1), up to week 18
        const latestSeason = Math.max(...(league.weeklyStats || [{ seasonIndex: 0 }]).map(w => w.seasonIndex || 0));
        const isRegularSeason = (w) => {
            const stage = w.stage ?? w.stageIndex;
            return stage === 1;
        };
        for (const week of (league.weeklyStats || [])
            .filter(w => (w.seasonIndex || 0) === latestSeason)
            .filter(w => isRegularSeason(w))
            .filter(w => (w.weekIndex ?? 0) <= 18)) {
            const passing = week.passing?.playerPassingStatInfoList || [];
            for (const p of passing) {
                const tid = p.teamId;
                seasonAgg[tid] = seasonAgg[tid] || {};
                addAgg(seasonAgg[tid], 'passYds', p.passYds);
                addAgg(seasonAgg[tid], 'passSacksTaken', p.passSacks);
                addAgg(seasonAgg[tid], 'passTDs', p.passTDs);
                addAgg(seasonAgg[tid], 'passInts', p.passInts);
                addAgg(seasonAgg[tid], 'passComp', p.passComp);
                addAgg(seasonAgg[tid], 'passAtt', p.passAtt);
                bumpCount(tid, 'pass');
                const pid = p.rosterId;
                if (pid != null) {
                    playerAgg[pid] = playerAgg[pid] || { teamId: tid, name: rosterNameById[pid] || p.fullName || 'Player' };
                    addAgg(playerAgg[pid], 'passYds', p.passYds);
                    addAgg(playerAgg[pid], 'passTDs', p.passTDs);
                    addAgg(playerAgg[pid], 'passInts', p.passInts);
                    addAgg(playerAgg[pid], 'passComp', p.passComp);
                    addAgg(playerAgg[pid], 'passAtt', p.passAtt);
                }
            }
            const rushing = week.rushing?.playerRushingStatInfoList || [];
            for (const r of rushing) {
                const tid = r.teamId;
                seasonAgg[tid] = seasonAgg[tid] || {};
                addAgg(seasonAgg[tid], 'rushYds', r.rushYds);
                addAgg(seasonAgg[tid], 'rushAtt', r.rushAtt);
                addAgg(seasonAgg[tid], 'rushTDs', r.rushTDs);
                bumpCount(tid, 'rush');
                const pid = r.rosterId;
                if (pid != null) {
                    playerAgg[pid] = playerAgg[pid] || { teamId: tid, name: rosterNameById[pid] || r.fullName || 'Player' };
                    addAgg(playerAgg[pid], 'rushYds', r.rushYds);
                    addAgg(playerAgg[pid], 'rushAtt', r.rushAtt);
                    addAgg(playerAgg[pid], 'rushTDs', r.rushTDs);
                }
            }
            const receiving = week.receiving?.playerReceivingStatInfoList || [];
            for (const r of receiving) {
                const tid = r.teamId;
                seasonAgg[tid] = seasonAgg[tid] || {};
                addAgg(seasonAgg[tid], 'recYds', r.recYds);
                addAgg(seasonAgg[tid], 'recTDs', r.recTDs);
                bumpCount(tid, 'rec');
                const pid = r.rosterId;
                if (pid != null) {
                    playerAgg[pid] = playerAgg[pid] || { teamId: tid, name: rosterNameById[pid] || r.fullName || 'Player' };
                    addAgg(playerAgg[pid], 'recYds', r.recYds);
                    addAgg(playerAgg[pid], 'recTDs', r.recTDs);
                }
            }
            const defense = week.defense?.playerDefensiveStatInfoList || [];
            for (const d of defense) {
                const tid = d.teamId;
                seasonAgg[tid] = seasonAgg[tid] || {};
                addAgg(seasonAgg[tid], 'defSacks', d.defSacks);
                addAgg(seasonAgg[tid], 'defInts', d.defInts);
                bumpCount(tid, 'def');
                const pid = d.rosterId;
                if (pid != null) {
                    playerAgg[pid] = playerAgg[pid] || { teamId: tid, name: rosterNameById[pid] || d.fullName || 'Player' };
                    addAgg(playerAgg[pid], 'sacks', d.defSacks);
                    addAgg(playerAgg[pid], 'ints', d.defInts);
                }
            }
        }
    }

    // Resolve teamId early for downstream logic
    // teamId already resolved above; no redeclare here

    // Needs, context, and draft class
    const needsByTeam = deriveTeamNeeds(league);
    let needs = resolveTeamNeeds(teamName, league, needsByTeam);
    const { wantDepthQB } = qbDepthStatus(teamName, league);

    if (teamId != null) {
        const edgePlayers = (league.rosters?.teams?.[teamId]?.rosterInfoList || []).filter(p => {
            const pos = (p.position || '').trim().toUpperCase();
            return ['LE','RE','EDGE','EDG','LEDG','REDG','DE','RDE','LDE','ROLB','LOLB','OLB'].includes(pos);
        });
        const edgeSacks = edgePlayers.reduce((s,p)=> s + (p.sacks ?? playerAgg[p.rosterId]?.sacks ?? 0), 0);
        const topEdgeSackVal = edgePlayers.reduce((m,p)=> Math.max(m, p.sacks ?? playerAgg[p.rosterId]?.sacks ?? 0), 0);
        const bestEdgeOvr = edgePlayers.reduce((m,p)=> Math.max(m, getMetricOvr(p)), 0);
        const teamDefSacks = (() => {
            const key = String(teamId);
            const ts = seasonAgg[teamId] || seasonAgg[key] || {};
            return ts.def?.sacks ?? ts.defSacks ?? null;
        })();
        const effectiveSacks = (teamDefSacks !== null && teamDefSacks !== undefined && teamDefSacks !== 0)
            ? teamDefSacks
            : edgeSacks;
        // Drop EDGE if production is already solid (lower threshold when DT is carrying)
        const dtCarry = topEdgeSackVal === 0 && effectiveSacks >= 32;
        if (needs.includes('EDGE') && (effectiveSacks >= 40 || (effectiveSacks >= 35 && topEdgeSackVal >= 8) || (bestEdgeOvr >= 84 && effectiveSacks >= 32) || dtCarry)) {
            needs = needs.filter(n => n !== 'EDGE');
            if (!needs.length) needs = ['BPA'];
        }
        // WR depth bump: if WR need is present or WR room thin, pull WR into top 3
        const wrs = (league.rosters?.teams?.[teamId]?.rosterInfoList || []).filter(p => (p.position || '').toUpperCase() === 'WR')
            .map(p => ({...p, ovr: getMetricOvr(p), yds: p.recYds ?? playerAgg[p.rosterId]?.recYds ?? 0}))
            .sort((a,b)=> (b.ovr - a.ovr) || (b.yds - a.yds));
        const wr2 = wrs[1], wr3 = wrs[2];
        const wrWeak = (wr2 && (wr2.ovr < 78 || wr2.yds < 800)) || (wr3 && wr3.ovr < 75);
        if (wrWeak && !needs.slice(0,3).includes('WR')) {
            // Insert WR into position 2 or 3
            needs = [needs[0], 'WR', ...needs.slice(1)].filter(Boolean);
            needs = Array.from(new Set(needs)); // dedupe
        }
        // Clamp needs to top 5 after adjustments
        needs = needs.slice(0, 5);
    }
    const draftClass = loadDraftClass()
        .sort((a, b) => (a.RNK ?? a.rank ?? a.order ?? 9999) - (b.RNK ?? b.rank ?? b.order ?? 9999))
        .map((p, i) => ({ ...p, __idx: i }));
    // Precompute QB prospects with projected round to diversify QB suggestions
    const qbProspects = draftClass
        .map((p, idx) => ({ ...p, projRound: Math.floor(idx / 32) + 1 }))
        .filter(p => mapPositionToNeed(p) === 'QB');

    function chooseQBForTeam(teamNeeds) {
        if (!qbProspects.length || !teamNeeds.includes('QB')) return null;
        const top = teamNeeds[0] === 'QB';
        const early = qbProspects.filter(p => p.projRound <= 2);
        const mid = qbProspects.filter(p => p.projRound >= 3 && p.projRound <= 4);
        const late = qbProspects.filter(p => p.projRound >= 5);

        // Bias top-need teams toward the top QB on the board (index 0), but still allow variety.
        if (top && early.length) {
            const roll = seededRand(teamName, 98, 100); // 0-99
            if (roll < 60) return early[0];                     // 60%: best QB (likely LaRon Williams)
            if (roll < 80 && early.length > 1) return early[1]; // 20%: second-best early QB
            return early[seededRand(teamName, 99, early.length)]; // 20%: any other early QB
        }

        const pool = mid.length ? mid : late.length ? late : qbProspects;
        const pick = pool[seededRand(teamName, 99, pool.length)];
        return pick || null;
    }

    let qbChoice = needs.includes('QB') ? chooseQBForTeam(needs) : null;
    let qbTargetRound = qbChoice?.projRound;
    const emojis = loadTeamEmojis();
    const teamEmoji = formatTeamEmoji(teamName, emojis);

    // --- QB de-prioritize BEFORE picks (needs) so picks reflect it ---
    const qbDeprioritizeEarly = () => {
        const teamRoster = (league?.rosters?.teams?.[teamId] || league?.rosters?.teams?.[String(teamId)] || {});
        const rosterPlayers = teamRoster.rosterInfoList || [];
        const qbs = [];
        for (const p of rosterPlayers.filter(p => (p.position || '').toUpperCase() === 'QB')) {
            const agg = playerAgg[p.rosterId] || {};
            qbs.push({
                ...p,
                passYds: p.passYds ?? agg.passYds,
                passTDs: p.passTDs ?? agg.passTDs,
                passInts: p.passInts ?? agg.passInts,
                age: p.age ?? rosterAgeById[p.rosterId],
                yearsLeft: p.contractYearsLeft ?? rosterYearsLeftById[p.rosterId]
            });
        }
        const top = qbs.sort((a, b) => (b.passYds ?? 0) - (a.passYds ?? 0) || (getMetricOvr(b) - getMetricOvr(a)))[0];
        if (teamId != null && needs.includes('QB') && top) {
            const passYds = top.passYds ?? 0;
            const td = top.passTDs ?? 0;
            const ints = top.passInts ?? 0;
            const age = top.age ?? 0;
            const yearsLeft = top.yearsLeft ?? null;
            const strongProd = passYds >= 3500 && (td / Math.max(1, ints)) >= 1.4 && ints <= 28;
            if (strongProd && age < 33 && (yearsLeft === null || yearsLeft > 1)) {
                needs = needs.filter(n => n !== 'QB');
                if (!needs.length) needs = ['BPA'];
            }
        }
    };
    qbDeprioritizeEarly();

    // Build 7 targets (1 per round) guided by true draft slot and team needs
    // Derive pick slots (after trades) for realism
    const tradedOrder = applyPickTrades(draftOrder(league));
    const teamNorm = normalizeName(teamName);
    const teamSlots = tradedOrder
        .map((p, i) => ({ slot: i + 1, norm: normalizeName(p.name || p.nick || ''), via: p.via }))
        .filter(p => p.norm === teamNorm);
    const firstSlot = teamSlots.length ? Math.min(...teamSlots.map(p => p.slot)) : 16;

    const maxWR = 2;
    const maxQBPrimary = 1;
    const maxQBDepth = wantDepthQB ? 1 : 0;
    let wrCount = 0;
    let qbCount = 0;
    const needPickCount = Object.create(null);
    const seen = new Set();
    const mapNeed = p => mapPositionToNeed(p);
    const projectedRound = (p) => Math.max(1, Math.floor(((p?.__idx ?? 0)) / 32) + 1);
    const withinRound = (p, round) => {
        const pr = projectedRound(p);
        // Tighten to the projected round; for R7 allow any 7+
        if (round === 7) return pr >= 7;
        return pr === round;
    };

    let picks = [];
    const top3Needs = (needs.length ? needs.slice(0, 3) : ['BPA']).filter(Boolean);

    const forceCamForRams = (round, basePick) => {
        if (normalizeName(teamName) !== 'losangelesrams') return null;
        if (round !== 1 || basePick < 14 || basePick > 20) return null;
        return draftClass.find(p => normalizeName(p.name || '') === 'camthompson');
    };

    for (let round = 1; round <= 7; round++) {
        const basePick = firstSlot + 32 * (round - 1);
        const low = Math.max(1, basePick - 5);
        const high = basePick + 15;
        let window = draftClass.filter((p, idx) => {
            const rank = (p.__idx ?? idx) + 1;
            return rank >= low && rank <= high;
        }).filter(p => withinRound(p, round));
        if (!window.length) window = draftClass.filter((p, idx) => {
            const rank = (p.__idx ?? idx) + 1;
            return rank >= basePick - 15 && rank <= basePick + 25;
        }).filter(p => withinRound(p, round));

        const teamNormLower = normalizeName(teamName);

        const canTake = (p) => {
            if (!p || seen.has(p.name)) return false;
            if (!withinRound(p, round)) return false;
            const n = mapNeed(p);
            if (n === 'WR' && wrCount >= maxWR) return false;
            if (n === 'QB') {
                const steelersBlock = teamNormLower === 'steelers' && round <= 2;
                if (steelersBlock) return false;
                const allowNeedQB = needs.includes('QB') && qbCount < maxQBPrimary;
                const allowDepthQB = !needs.includes('QB') && qbCount < maxQBDepth && round >= 5;
                const allowNeedDepth = needs.includes('QB') && qbCount < (maxQBPrimary + maxQBDepth) && round >= 5;
                if (!(allowNeedQB || allowDepthQB || allowNeedDepth)) return false;
            }
            return true;
        };

        // Rams bias toward Cam Thompson in the teens
        let target = forceCamForRams(round, basePick);
        if (target && !canTake(target)) target = null;

        const unmetNeeds = top3Needs.filter(n => (needPickCount[n] || 0) === 0);
        const needPriority = unmetNeeds.length ? unmetNeeds : top3Needs;

        const pickForNeeds = (pool, needsList) => {
            for (const need of needsList) {
                const hit = pool.find(p => {
                    if (!canTake(p)) return false;
                    const n = mapNeed(p);
                    if (need === 'BPA') return true;
                    return n === need;
                });
                if (hit) return hit;
            }
            return null;
        };

        if (!target) target = pickForNeeds(window, needPriority);
        if (!target) target = pickForNeeds(window, ['BPA']);
        if (!target) {
            const roundFiltered = draftClass.filter(p => withinRound(p, round));
            target = pickForNeeds(roundFiltered, needPriority);
        }
        if (!target) {
            const roundFiltered = draftClass.filter(p => withinRound(p, round));
            target = roundFiltered.find(p => canTake(p));
        }

        if (target) {
            seen.add(target.name);
            const n = mapNeed(target);
            needPickCount[n] = (needPickCount[n] || 0) + 1;
            if (n === 'WR') wrCount++;
            if (n === 'QB') qbCount++;
        }
        const school = target?.college || target?.College || target?.school || target?.schoolName || 'N/A';
        picks.push(target
            ? `${round}. ${target.name} (${target.position || target.position_1 || 'POS'}) — ${school} (Proj R${projectedRound(target)})`
            : `${round}. No suggestion`);
    }

    // Post-process: cap WR suggestions to 2 by swapping later WRs to best non-WR available
    const wrIndices = picks
        .map((line, idx) => ({ line, idx }))
        .filter(x => /\(WR\)/.test(x.line));
    if (wrIndices.length > 2) {
        const usedNames = new Set(picks.map(l => l.split('. ')[1]?.split(' (')[0]).filter(Boolean));
        const replacementPool = draftClass.filter(p => mapNeed(p) !== 'WR' && !usedNames.has(p.name));
    if (process.env.MOCK_DEBUG) console.log('[WR CAP]', teamName, 'wrIndices', wrIndices.length, 'pool', replacementPool.length);
        let repIdx = 0;
        for (let i = 2; i < wrIndices.length; i++) {
            const targetIdx = wrIndices[i].idx;
            let rep = replacementPool[repIdx++];
            if (!rep) break;
            // ensure replacement still roughly matches that round
            if (!withinRound(rep, targetIdx + 1)) {
                rep = replacementPool.find(p => withinRound(p, targetIdx + 1) && !usedNames.has(p.name)) || rep;
            }
            usedNames.add(rep.name);
            const school = rep.college || rep.College || rep.school || rep.schoolName || 'N/A';
            picks[targetIdx] = `${targetIdx + 1}. ${rep.name} (${rep.position || rep.position_1 || 'POS'}) — ${school} (Proj R${projectedRound(rep)})`;
        }
    }
    if (process.env.MOCK_DEBUG) console.log('[WR COUNT]', teamName, wrCount);

    // Capture top needs early (will also refine later for display)
    let topNeedsBase = top3Needs;

    // Get standings early (needed for pick balancing)
    const standings = league?.standings?.teamStandingInfoList || [];
    const teamStanding = standings.find(s => Number(s.teamId) === teamId);
    const recordStr = teamStanding ? `${teamStanding.totalWins}-${teamStanding.totalLosses}` : 'N/A';

    // Post-process picks: rebuild unless QB is the only meaningful need
    // Rebuild block is disabled for now; keep earlier pick logic that respects round window and WR/QB caps.
    const qbOnlyNeed = true;
    if (!qbOnlyNeed) {
        const topNeeds = topNeedsBase.filter(n => n !== 'QB');
        const needPool = Array.from(new Set([...topNeeds].filter(n => n && n !== 'QB')));
        if (process.env.MOCK_DEBUG && teamName === 'Broncos') {
            console.log('[REBUILD NEEDS]', needPool);
        }
        const capPerNeed = needPool.length ? Math.max(2, Math.ceil(7 / needPool.length)) : 7;
        const needCount = Object.create(null);
        const rebuilt = [];
        const seenNames = new Set();

        const pickFrom = (pool, enforceNeeds = true, round = 1) => {
            // apply a small deterministic skip so late picking teams don't always get the very top names
            const skipBase = seededRand(teamName, 800 + round, Math.min(6, pool.length || 1));
            // increase skip for teams picking in the back half of round 1 (records 10+ wins) to avoid elite top-5 falling
            const backHalfBias = teamStanding
                ? (teamStanding.totalWins >= 12 ? 6
                    : teamStanding.totalWins >= 10 ? 4
                    : teamStanding.totalWins >= 9 ? 2
                    : 0)
                : 0;
            const skip = Math.min(pool.length, skipBase + backHalfBias);
            const list = pool
                .filter(p => !seenNames.has(p.name) && mapNeed(p) !== 'QB')
                .filter(p => !(round === 1 && backHalfBias > 0 && (p.__idx ?? 99) < 8)) // late picking teams avoid top-8 overall
                .slice(skip);
            for (const need of needPool) {
                if (enforceNeeds && needCount[need] >= capPerNeed) continue;
                const cand = list.find(p => mapNeed(p) === need);
                if (cand) return { cand, need };
            }
            if (!enforceNeeds) {
                const cand = list[0];
                if (cand) return { cand, need: mapNeed(cand) };
            }
            return null;
        };

        for (let round = 1; round <= 7; round++) {
            const start = (round - 1) * 32;
            const end = round * 32;
            const slice = draftClass.slice(start, end);

            if (process.env.MOCK_DEBUG && teamName === 'Broncos' && round === 1) {
                console.log('[BRONCOS R1] needs=', topNeeds.join(','), 'slice WR names=', slice.filter(p=>mapNeed(p)==='WR').map(p=>p.name));
            }

            // Force R1 to align with top need for non-QB teams; avoid top-8 elites for late pickers
            if (round === 1 && !topNeedsBase.includes('QB')) {
                const eliteGate = (teamStanding && teamStanding.totalWins >= 10);
                const r1Needs = topNeeds.filter(n => n !== 'BPA');
                const needList = r1Needs.length ? r1Needs : topNeeds;
                let pickedR1 = null;
                for (const need of needList) {
                    const poolR1 = draftClass.filter(p =>
                        !seenNames.has(p.name) &&
                        mapNeed(p) === need &&
                        (!eliteGate || ((p.__idx ?? 99) >= 8))
                    );
                    if (process.env.MOCK_DEBUG && teamName === 'Broncos') {
                        console.log(`[R1_FORCE ${teamName}] need=${need} pool=${poolR1.map(p=>p.name).slice(0,5).join(',')}`);
                    }
                    if (poolR1.length) {
                        pickedR1 = poolR1[seededRand(teamName, 901 + need.length, Math.min(poolR1.length, 6)) % poolR1.length];
                        needCount[need] = (needCount[need] || 0) + 1;
                        break;
                    }
                }
                if (pickedR1) {
                    seenNames.add(pickedR1.name);
                    const school = pickedR1.college || pickedR1.College || pickedR1.school || pickedR1.schoolName || 'N/A';
                    rebuilt.push(`${round}. ${pickedR1.name} (${pickedR1.position || pickedR1.position_1 || 'POS'}) — ${school} (Proj R${round})`);
                    continue;
                }
            }

            let picked = null;
            if (round === 1) {
                picked = pickFrom(slice, true, round)
                      || pickFrom(draftClass, true, round);
                if (!picked) {
                    const eliteGate = (teamStanding && teamStanding.totalWins >= 10);
                    const alt = draftClass.find(p =>
                        !seenNames.has(p.name) &&
                        needPool.includes(mapNeed(p)) &&
                        mapNeed(p) !== 'QB' &&
                        (!eliteGate || ((p.__idx ?? 99) >= 8))
                    );
                    if (alt) picked = { cand: alt, need: mapNeed(alt) };
                }
            }

            if (!picked) {
                picked = pickFrom(slice, true, round)
                      || pickFrom(draftClass.slice(start, Math.min(end + 16, draftClass.length)), true, round)
                      || pickFrom(draftClass, true, round);
            }

            // Early rounds must stay within needs; later rounds may fallback to BPA
            if (!picked && round >= 3) {
                picked = pickFrom(slice, false, round)
                      || pickFrom(draftClass.slice(start, Math.min(end + 32, draftClass.length)), false, round)
                      || pickFrom(draftClass, false, round);
            }

            let pick = picked?.cand || null;
            const needHit = picked?.need;
            // Round 1 safety: ensure pick matches a listed need (non-QB teams)
            if (round === 1 && pick && !needPool.includes(mapNeed(pick))) {
                const eliteGate = (teamStanding && teamStanding.totalWins >= 10);
                const alt = draftClass.find(p =>
                    !seenNames.has(p.name) &&
                    needPool.includes(mapNeed(p)) &&
                    mapNeed(p) !== 'QB' &&
                    (!eliteGate || ((p.__idx ?? 99) >= 8))
                );
                if (alt) {
                    if (process.env.MOCK_DEBUG && teamName === 'Broncos') console.log('[BRONCOS ALT]', alt.name);
                    pick = alt;
                }
            }
            if (pick) {
                seenNames.add(pick.name);
                if (needHit) needCount[needHit] = (needCount[needHit] || 0) + 1;
            }
            const school = pick?.college || pick?.College || pick?.school || pick?.schoolName || 'N/A';
            rebuilt.push(pick ? `${round}. ${pick.name} (${pick.position || pick.position_1 || 'POS'}) — ${school} (Proj R${round})`
                               : `${round}. No suggestion`);
        }

        // Allow ONE late depth QB if roster is thin (rounds 4+ only)
        if (wantDepthQB) {
            const depthQB = draftClass
                .map((p, idx) => ({ p, proj: Math.floor(idx / 32) + 1 }))
                .filter(({ p }) => !seenNames.has(p.name) && mapNeed(p) === 'QB')
                .filter(({ proj }) => proj >= 4) // prefer day-3/late day-2 QBs for depth
                .map(({ p }) => p)[0]
                || draftClass.find(p => !seenNames.has(p.name) && mapNeed(p) === 'QB');
            if (depthQB) {
                const school = depthQB.college || depthQB.College || depthQB.school || depthQB.schoolName || 'N/A';
                rebuilt[6] = `7. ${depthQB.name} (${depthQB.position || depthQB.position_1 || 'QB'}) — ${school} (Proj R7)`;
            }
        }
        if (process.env.MOCK_DEBUG) console.log(`[MOCK_POST] Rebuilt non-QB picks for ${teamName}`);
        picks = rebuilt;
    }
    // --- Stat-driven strategy logic ---
    let topNeedsFinal = topNeedsBase;
    if ((!wantDepthQB || (teamStanding && teamStanding.totalWins >= 9)) && topNeedsFinal.includes('QB')) {
        topNeedsFinal = topNeedsFinal.filter(n => n !== 'QB');
        if (!topNeedsFinal.length) topNeedsFinal = ['BPA'];
    }
    // 3. Get roster and stat context
    const rosters = league?.rosters?.teams || {};
    const roster = rosters[teamId] || rosters[String(teamId)] || {};
    const players = roster.rosterInfoList || [];
    // 4. Stat-based blurbs for needs
    const statBlurbs = [];
    // Import OL proxy logic from top_players.js
    function computeOlProxy(teamStats, winPct = 0.5) {
        const passAtt = Math.max(1, teamStats.passAtt || 0);
        const rushAtt = Math.max(1, teamStats.rushAtt || 0);
        const ypa = ((teamStats.passYds || 0) / passAtt);
        const ypc = ((teamStats.rushYds || 0) / rushAtt);
        const sackRate = ((teamStats.passSacksAllowed || 0) / passAtt) * 100;
        let score = 50;
        score += Math.min(12, ypa) * 2.5;
        score -= sackRate * 8;
        score += Math.min(7, ypc) * 2.0;
        score *= (1 + 0.05 * winPct);
        score *= 0.6;
        return Math.max(40, Math.min(82, score));
    }
    // Get team stats from league snapshot
    // Team stats may be absent in snapshot; default to empty object
    const teamStatsObj = league?.teamstats?.teamStatInfoList?.find?.(t => Number(t.teamId) === teamId) || {};
    const winPct = teamStanding ? ((teamStanding.totalWins + 0.5 * (teamStanding.totalTies || 0)) / ((teamStanding.totalWins || 0) + (teamStanding.totalLosses || 0) + (teamStanding.totalTies || 0))) : 0.5;
    function getPlayerName(p) {
        return p.name || p.fullName || p.displayName || ((p.firstName || '') + ' ' + (p.lastName || '')).trim() || 'Unknown';
    }
    // Team-level stat blurbs (always include when available)
    if (teamStanding && (teamStanding.ptsFor !== undefined || teamStanding.netPts !== undefined)) {
        const pf = teamStanding.ptsFor ?? '—';
        const pa = teamStanding.ptsFor !== undefined && teamStanding.netPts !== undefined
            ? (teamStanding.ptsFor - teamStanding.netPts)
            : '—';
        statBlurbs.push(`Team scoring: PF ${pf}, PA ${pa}.`);
    }
    const sacksAllowed = seasonAgg[teamId]?.pass?.sacksTaken ?? seasonAgg[String(teamId)]?.pass?.sacksTaken ?? teamStatsObj?.passSacksAllowed;
    if (sacksAllowed !== undefined) {
        statBlurbs.push(`Sacks allowed: ${sacksAllowed}.`);
    }
    // Pre-compute leaders for stat weaving (prioritize passing yards, then starts/overall as fallback)
    // Pre-compute leaders (prefer prebuilt player_stats.json)
    const teamPlayers = Object.values(playerStats)
        .filter(p => teamId != null && Number(p.teamId) === Number(teamId))
        .map(p => ({
        ...p,
        age: p.age ?? rosterAgeById[p.rosterId],
        overall: p.overall ?? rosterOvrById[p.rosterId],
        yearsLeft: p.contractYearsLeft ?? rosterYearsLeftById[p.rosterId]
    }));
    const getVal = (obj, path) => path.split('.').reduce((o,k)=> (o && o[k] !== undefined ? o[k] : undefined), obj);
    const topBy = (arr, path) => arr.slice().sort((a,b)=>(getVal(b,path) ?? 0)-(getVal(a,path) ?? 0))[0];

    const qbs = teamPlayers.filter(p => (p.position || '').toUpperCase() === 'QB');
    const topQB = topBy(qbs, 'pass.yds') ||
        players
            .filter(p => (p.position || '').toUpperCase() === 'QB')
            .map(p => {
                const agg = playerAgg[p.rosterId] || {};
                const passYds = p.passYds ?? agg.passYds ?? 0;
                const passTDs = p.passTDs ?? agg.passTDs;
                const passInts = p.passInts ?? agg.passInts;
                const age = p.age ?? rosterAgeById[p.rosterId];
                return { ...p, passYds, passTDs, passInts, age };
            })
            .sort((a, b) => (b.passYds ?? 0) - (a.passYds ?? 0) || (getMetricOvr(b) - getMetricOvr(a)))[0];

    const topRB = topBy(teamPlayers.filter(p => ['HB','RB','FB'].includes((p.position || '').toUpperCase())), 'rush.yds') ||
        players.filter(p => ['HB','RB','FB'].includes((p.position || '').toUpperCase())).sort((a, b) => (b.rushYds ?? 0) - (a.rushYds ?? 0))[0];

    const topWR = topBy(teamPlayers.filter(p => (p.position || '').toUpperCase() === 'WR'), 'rec.yds') ||
        players.filter(p => (p.position || '').toUpperCase() === 'WR').sort((a, b) => (b.recYds ?? 0) - (a.recYds ?? 0))[0];

    const topTE = topBy(teamPlayers.filter(p => (p.position || '').toUpperCase() === 'TE'), 'rec.yds') ||
        players.filter(p => (p.position || '').toUpperCase() === 'TE')
            .map(p => {
                const agg = playerAgg[p.rosterId] || {};
                return { ...p, recYds: p.recYds ?? agg.recYds, recTDs: p.recTDs ?? agg.recTDs };
            })
            .sort((a, b) => (b.recYds ?? 0) - (a.recYds ?? 0) || (getMetricOvr(b) - getMetricOvr(a)))[0];

    const topEdge = topBy(teamPlayers.filter(p => ['LE','RE','EDGE','EDG','LEDG','REDG','DE','RDE','LDE','ROLB','LOLB','OLB'].includes((p.position || '').toUpperCase())), 'def.sacks') ||
        players.filter(p => ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'OLB', 'DE', 'LEDG', 'REDG', 'RDE', 'LDE'].includes((p.position || '').toUpperCase()))
            .sort((a, b) => (b.sacks ?? 0) - (a.sacks ?? 0))[0];

    const topCB = topBy(teamPlayers.filter(p => (p.position || '').toUpperCase() === 'CB'), 'def.ints') ||
        players.filter(p => (p.position || '').toUpperCase() === 'CB')
            .sort((a, b) => (b.interceptions ?? 0) - (a.interceptions ?? 0))[0];

    // QB de-prioritize if high production, not old, not expiring
    if (teamId != null && needs.includes('QB') && topQB) {
        const passYds = topQB.pass?.yds ?? topQB.passYds ?? playerAgg[topQB.rosterId]?.passYds ?? 0;
        const td = topQB.pass?.td ?? topQB.passTDs ?? playerAgg[topQB.rosterId]?.passTDs ?? 0;
        const ints = topQB.pass?.int ?? topQB.passInts ?? playerAgg[topQB.rosterId]?.passInts ?? 0;
        const qbAge = topQB.age ?? rosterAgeById[topQB.rosterId] ?? 0;
        const qbYearsLeft = topQB.yearsLeft ?? rosterYearsLeftById[topQB.rosterId] ?? null;
        // Treat ~4k yards with a solid TD/INT ratio as “stable” production
        const strongProd = passYds >= 3500 && (td / Math.max(1, ints)) >= 1.4 && ints <= 28;
        if (strongProd && qbAge < 33 && (qbYearsLeft === null || qbYearsLeft > 1)) {
            needs = needs.filter(n => n !== 'QB');
            if (!needs.length) needs = ['BPA'];
        }
        // Winning teams with functional production shouldn't list QB as a primary need
        if (needs.includes('QB') && teamStanding && teamStanding.totalWins >= 9 && passYds >= 2000) {
            needs = needs.filter(n => n !== 'QB');
            if (!needs.length) needs = ['BPA'];
        }
        // If roster already has an 80+ OVR QB, treat QB as depth only
        if (needs.includes('QB') && getMetricOvr(topQB) >= 80) {
            needs = needs.filter(n => n !== 'QB');
            if (!needs.length) needs = ['BPA'];
        }
        // If depth is already adequate (wantDepthQB false), drop QB from primary needs
        if (needs.includes('QB') && !wantDepthQB) {
            needs = needs.filter(n => n !== 'QB');
            if (!needs.length) needs = ['BPA'];
        }
        // Contenders: drop QB need outright if winning double-digit games
        if (needs.includes('QB') && teamStanding && teamStanding.totalWins >= 10) {
            needs = needs.filter(n => n !== 'QB');
            if (!needs.length) needs = ['BPA'];
        }
    } else if (needs.includes('QB') && teamStanding && teamStanding.totalWins >= 9) {
        // No QB stats available, but winning: treat QB as depth only
        needs = needs.filter(n => n !== 'QB');
        if (!needs.length) needs = ['BPA'];
    }

    // Existing strategy phrases
    const phrases = {
        QB: [
            "Your quarterback room is in flux. Target a franchise QB to lead your offense for years to come.",
            "A new signal-caller could transform your team. Don't hesitate to invest early in a top QB.",
            "Quarterback is the engine of your offense—find a leader who can elevate everyone around him.",
            "Stabilize your passing game by adding a talented young QB to the roster.",
            "A dynamic QB could be the missing piece for a playoff run.",
            "Even with a solid starter, secure a capable backup QB so an injury doesn't derail your season.",
            "Use an early pick on a QB who fits your scheme; let him develop behind your vet if needed.",
            "If the board lines up, swing on a high-ceiling QB and let competition raise the room.",
            "Secure a poised, accurate passer to steady the offense in high-leverage spots."
        ],
        OL: [
            "Your offensive line needs reinforcements. Prioritize protection for your QB and open up the run game.",
            "Building in the trenches is key—target versatile linemen who can anchor your offense.",
            "A strong OL will help every skill player shine. Invest in blockers early.",
            "Shoring up the line will pay dividends all season long.",
            "Drafting OL talent is never a bad move—depth and flexibility are crucial.",
            "Bolster the line with tough, smart blockers who win with leverage and hands.",
            "Keep your QB clean with linemen who sort stunts and blitzes on sight.",
            "Add maulers who can reset the line of scrimmage and finish in the run game."
        ],
        EDGE: [
            "You need more juice off the edge. Look for explosive pass rushers to disrupt opposing QBs.",
            "A dominant EDGE can change games—prioritize pressure in your draft strategy.",
            "Adding speed and power to your front seven will boost your whole defense.",
            "Edge rushers are game-wreckers. Find one who fits your scheme.",
            "A relentless pass rusher will help your secondary and force turnovers.",
            "Target bend-and-burst off the edge to close out drives in two-minute situations.",
            "Pair a speed rusher with your power end to stress protections on every snap.",
            "Hunt a closer who wins one-on-one so you can rush four and cover seven."
        ],
        OT: [
            "Lock down the edges with a tackle who keeps your QB clean.",
            "Invest in an OT who can stonewall speed rushers and set the pocket depth.",
            "A reliable tackle stabilizes your pass game—secure one early.",
            "Upgrade tackle to improve both protection and perimeter run game.",
            "Bookend tackles make everything easier; target one with good feet and anchor.",
            "Find a tackle with range and anchor so you can live in true dropback pass sets.",
            "Add a tackle who wins vs. speed-to-power so your QB can attack downfield."
        ],
        IOL: [
            "Control the interior with a guard/center who moves people off the ball.",
            "Add an IOL who can anchor vs. power and climb to backers in the run game.",
            "Interior pressure kills drives—shore up G/C spots to keep your QB clean.",
            "Target a versatile guard/center to solidify protections and short yardage.",
            "Win inside—draft an IOL who finishes blocks and keeps the pocket firm.",
            "Secure an IOL with processing and punch to sort games and blitzes.",
            "A nasty interior trio lets you live in inside zone and duo—find a finisher."
        ],
        TE: [
            "Add a tight end who can threaten seams and hold up in the run game.",
            "A reliable TE outlet will help your QB on third downs—find one with hands and toughness.",
            "Target a TE who can block on the edge and create mismatches up the seam.",
            "A versatile TE keeps your offense multiple—look for one who can flex and inline.",
            "Shore up red-zone efficiency with a TE who wins in traffic.",
            "Find a TE who separates underneath and finishes blocks on the perimeter.",
            "Pair your QB with a TE who boxes out in the red zone and seals the edge on stretch."
        ],
        DT: [
            "Win inside with a disruptive DT who can collapse the pocket and clog run lanes.",
            "Shore up the interior with a powerful DT—stop the run on early downs and push the pocket on third.",
            "Interior disruption makes edge rushers better. Target a DT who commands doubles.",
            "Add a stout DT to keep linebackers clean and firm up your run fits.",
            "Control the A-gaps with a DT who anchors and penetrates when needed.",
            "Find a DT who can two-gap on early downs and push the pocket on third."
        ],
        LB: [
            "Bolster your second level with a smart, rangy linebacker who can play SAM/MIKE/WILL.",
            "Add a linebacker who can fill and flow—strengthen run fits and underneath coverage.",
            "A versatile LB who can stack, scrape, and cover backs/TEs will stabilize your defense.",
            "Improve your LB room with a communicator who aligns the front and cleans up tackling lanes.",
            "Depth at LB keeps your sub-packages flexible—find a backer who can cover and blitz.",
            "Target a backer who runs and hits so you can stay light in sub without sacrificing run fits."
        ],
        CB: [
            "Your secondary needs a lockdown corner. Target athletic CBs who can match up with top WRs.",
            "Coverage is king—add depth and talent at cornerback to slow down high-powered offenses.",
            "A ball-hawking CB could swing close games in your favor.",
            "Shore up your pass defense with a physical, smart corner.",
            "Elite corners are hard to find—don't pass up a good one.",
            "Find a corner with press skills and recovery speed to disrupt timing routes."
        ],
        S: [
            "Safety play is a weakness. Look for rangy, instinctive safeties to solidify the back end.",
            "A versatile safety can erase mistakes and make big plays. Target one who fits your style.",
            "Upgrade your last line of defense with a hard-hitting, smart safety.",
            "A leader at safety will help organize your defense and prevent big plays.",
            "Don't overlook the value of a playmaking safety.",
            "Add a safety who can spin down vs. the run and carry seams in sub packages."
        ],
        WR: [
            "You need more weapons at receiver. Target explosive WRs who can stretch the field.",
            "A reliable WR corps will help your QB and open up the offense.",
            "Look for route technicians and deep threats to diversify your passing game.",
            "Adding a go-to WR could unlock your offense's potential.",
            "Depth at WR is key—find playmakers who can step up.",
            "Stack a separator who wins on third down and in the red zone.",
            "Give your QB a vertical hammer and a slot separator to win every coverage look.",
            "A true WR1 tilts coverage—add one to free up your run game and TE."
        ],
        RB: [
            "A dynamic running back could take your offense to the next level. Look for speed and vision.",
            "Bolster your backfield with a tough, versatile RB.",
            "A strong run game will help control the clock and keep your defense fresh.",
            "Find a back who can contribute as a runner and receiver.",
            "RB depth is important—target a playmaker who fits your scheme.",
            "Add a back with burst and hands to stress defenses on early downs and in the screen game."
        ],
        BPA: [
            "You have flexibility—target the best player available and build depth across the roster.",
            "Draft for value and upside, regardless of position.",
            "With few glaring needs, you can afford to take chances on high-ceiling prospects.",
            "Stay open-minded and let the board come to you.",
            "Depth wins championships—add talent wherever you can.",
            "Let the board dictate—stack talent and create competition at every spot."
        ]
    };
    function pickRandom(arr) {
        return arr[Math.floor(Math.random() * arr.length)];
    }
    // Build a detailed blurb that touches the top 5 needs with decreasing urgency and woven stats
    const toneWeights = [1.0, 0.9, 0.8];
    // Helpers for roster-based fallbacks
    const avgOvr = (arr) => arr.length ? Math.round(arr.reduce((s,p)=>s+getMetricOvr(p),0)/arr.length) : 0;
    const group = (positions) => players.filter(p => positions.includes((p.position || '').toUpperCase()));
    const sackVal = (p) => p?.def?.sacks ?? p?.sacks ?? playerAgg[p?.rosterId]?.sacks ?? 0;

    const statSnippet = (pos) => {
        const key = teamId != null ? String(teamId) : null;
        const ts = (key && (seasonAgg[teamId] || seasonAgg[key])) || {};
        const agg = ts; // seasonAgg holds team totals already
        const counts = (key && (seasonCounts[teamId] || seasonCounts[key])) || {};
        const seenPass = ts.pass?.yds !== undefined || (counts.pass || 0) > 0;
        const seenRush = ts.rush?.yds !== undefined || (counts.rush || 0) > 0;
        const seenRec  = ts.rec?.yds  !== undefined || (counts.rec  || 0) > 0;
        const seenDef  = ts.def?.sacks !== undefined || (counts.def  || 0) > 0;
        const yearsLeft = (p) => {
            if (!p) return null;
            if (p.yearsLeft !== undefined && p.yearsLeft !== null) return p.yearsLeft;
            if (p.contractYearsLeft !== undefined && p.contractYearsLeft !== null) return p.contractYearsLeft;
            if (p.rosterId !== undefined && rosterYearsLeftById[p.rosterId] !== undefined) return rosterYearsLeftById[p.rosterId];
            return null;
        };
        const edgeList = teamPlayers.filter(p => ['LE','RE','EDGE','EDG','LEDG','REDG','DE','RDE','LDE','ROLB','LOLB','OLB'].includes((p.position || '').toUpperCase()));
        const dtList = teamPlayers.filter(p => ['DT','NT','IDL','IDL1','IDL2','IDL3'].includes((p.position || '').toUpperCase()));
        const edgeSacks = edgeList.reduce((s,p)=> s + sackVal(p), 0);
        const dtSacks = dtList.reduce((s,p)=> s + sackVal(p), 0);
        const teamDefSacks = ts.def?.sacks ?? agg.defSacks;
        const topPassRusher = [...edgeList, ...dtList].sort((a,b)=> sackVal(b)-sackVal(a))[0];

        if (pos === 'QB') {
            const qbName = topQB ? (topQB.name || getPlayerName(topQB)) : (ts.leaders?.passYds?.name || 'QB');
            const passYds = topQB?.pass?.yds ?? topQB?.passYds ?? agg.passYds ?? ts.pass?.yds ?? ts.leaders?.passYds?.val;
            const passTDs = topQB?.pass?.td ?? topQB?.passTDs ?? agg.passTDs ?? ts.pass?.td;
            const passInts = topQB?.pass?.int ?? topQB?.passInts ?? agg.passInts ?? ts.pass?.int;
            const passAtt = topQB?.pass?.att ?? ts.pass?.att ?? agg.passAtt ?? 0;
            const passComp = topQB?.pass?.comp ?? ts.pass?.comp ?? agg.passComp ?? 0;
            const compPct = passAtt ? (passComp / passAtt) * 100 : null;
            const td = passTDs;
            const ints = passInts;
            const qbAge = topQB?.age ?? 0;
            const qbYearsLeft = yearsLeft(topQB);
            const strongProd = (passYds !== undefined && passYds >= 4300 && td !== undefined && td >= 30) ||
                (passYds !== undefined && passYds >= 4000 && td !== undefined && ints !== undefined && ints > 0 && (td / ints) >= 2.2);
            if (seenPass && qbYearsLeft !== null && qbYearsLeft <= 1) return `${qbName} is in a contract year—decide on an extension or draft a successor.`;
            if (seenPass && qbAge >= 35) return `${qbName} is ${qbAge}—line up a succession plan at quarterback now.`;
            // Madden statlines carry more interceptions; raise the flag threshold to avoid overreacting
            if (seenPass && ints !== undefined && ints >= 22 && !strongProd) return `${qbName} threw ${ints} INTs—start evaluating a new option at quarterback.`;
            if (seenPass && qbAge >= 33) return `${qbName} is ${qbAge}—begin lining up a replacement QB now.`;
            // If production is strong, don't nudge replacement
            const tdIntRatio = (td !== undefined && ints !== undefined) ? (td / Math.max(1, ints)) : Infinity;
            if (passYds !== undefined && passYds >= 3800 && tdIntRatio >= 1.6 && (ints ?? 0) <= 20) return '';
            if (seenPass && passYds !== undefined && passYds < 3500) return `${qbName} produced ${passYds} pass yards—raise the ceiling at QB.`;
            // Relax turnover concern for high-volume Madden passing; only flag if ratio is really lopsided
            if (seenPass && td !== undefined && ints !== undefined && ints > 0 && (td / ints) < 1.6) return `${qbName}'s TD/INT ratio is under 1.6:1 (TDs ${td}, INTs ${ints})—raise the floor at QB.`;
            if (seenPass && compPct !== null && compPct < 63) return `${qbName} completed only ${compPct.toFixed(1)}%—add accuracy and timing.`;
            return '';
        }
        if (pos === 'TE') {
            const te = topTE;
            const name = te ? getPlayerName(te) : 'Top TE';
            const recYds = te?.recYds ?? null;
            const recTDs = te?.recTDs ?? null;
            const yl = yearsLeft(te);
            if (yl !== null && yl <= 1) return `${name} is in a contract year—secure a TE who can block and win seams.`;
            if (recYds !== null && recYds < 450) return `${name} managed ${recYds} receiving yards—add a TE who can work seams and third downs.`;
            if (recTDs !== null && recTDs < 5) return `${name} scored ${recTDs} TDs—boost red-zone punch with a dual-threat TE.`;
            return '';
        }
        if (pos === 'RB') {
            const leaderName = topRB ? (topRB.name || getPlayerName(topRB)) : (ts.leaders?.rushYds?.name || 'Top back');
            const yl = yearsLeft(topRB);
            const rushYds = ts.rush?.yds ?? topRB?.rushYds ?? agg.rushYds;
            const rushAtt = ts.rush?.att ?? agg.rushAtt;
            const ypc = rushAtt ? rushYds / rushAtt : null;
            const td = ts.rush?.td ?? agg.rushTDs;
            if (yl !== null && yl <= 1) return `${leaderName} is in a contract year—line up a back who keeps your ground game steady.`;
            if (seenRush && rushYds !== undefined && rushYds < 1100) return `${leaderName} managed ${rushYds} rush yards—find a true bell cow.`;
            if (seenRush && ypc !== null && ypc < 4.2) return `Run game averaged ${ypc.toFixed(2)} YPC—add a back who creates explosives.`;
            if (seenRush && td !== undefined && td < 10) return `Ground game scored ${td} rush TDs—add a finisher in the red zone.`;
            if (seenRush && rushYds !== undefined) return `${leaderName} posted ${rushYds} yards—pair him with another playmaker.`;
            return '';
        }
        if (pos === 'WR') {
            const leaderName = topWR ? (topWR.name || getPlayerName(topWR)) : (ts.leaders?.recYds?.name || 'Top target');
            const leaderYds = topWR?.rec?.yds ?? topWR?.recYds ?? ts.leaders?.recYds?.val;
            const recYds = leaderYds ?? ts.rec?.yds ?? agg.recYds;
            const recTDs = topWR?.rec?.td ?? topWR?.recTDs ?? ts.rec?.td ?? agg.recTDs;
            const yl = yearsLeft(topWR);
            const wrs = group(['WR']).sort((a, b) => {
                const byYds = (b.recYds ?? 0) - (a.recYds ?? 0);
                if (byYds !== 0) return byYds;
                return (getMetricOvr(b) || 0) - (getMetricOvr(a) || 0);
            });
            const wr2 = wrs[1];
            const wr3 = wrs[2];
            const wrOvr = p => p ? (p.overall ?? rosterOvrById[p.rosterId] ?? getMetricOvr(p)) : 0;
            const wrYds = p => p ? (p.recYds ?? p.rec?.yds ?? playerAgg[p.rosterId]?.recYds) : 0;
            if (topWR && wr2 && wrOvr(topWR) >= 88 && (wrOvr(wr2) < 82 || yl !== null && yl <= 1 || yearsLeft(wr2) !== null && yearsLeft(wr2) <= 1)) {
                return `${leaderName} is entrenched as WR1—add a WR2 to keep coverage honest and hedge contracts.`;
            }
            if (topWR && wr2 && wrYds(topWR) >= 1200 && wrYds(wr2) < 800) {
                return `${leaderName} carried the passing game—find a reliable WR2 to balance targets.`;
            }
            if (wr2 && wr3 && wrOvr(wr3) < 75) {
                return `You’re light at WR3—add a slot/third receiver to keep 11-personnel dangerous.`;
            }
            if (yl !== null && yl <= 1) return `${leaderName} is in a contract year—add another WR to protect your pass game.`;
            if (recYds !== undefined && recYds >= 1300) {
                const wr2 = wrs[1];
                const wr2Yds = wr2 ? wrYds(wr2) : 0;
                if (wr2Yds < 900) return `${leaderName} is a true WR1 at ${recYds} yards—add a WR2/WR3 to punish doubles and keep coverage honest.`;
                return `${leaderName} is rolling at ${recYds} yards—add depth so the offense stays multiple when teams bracket him.`;
            }
            if (recYds !== undefined && recYds < 950) return `${leaderName} topped out at ${recYds} yards—add a true weapon to stretch coverage.`;
            if (recTDs !== undefined && recTDs < 15) return `${leaderName} scored ${recTDs} TDs—add a reliable scoring threat.`;
            if (recYds !== undefined) return `${leaderName} logged ${recYds} yards—add another threat to tilt coverage.`;
            return '';
        }
        if (pos === 'EDGE') {
            const leaderVal = topEdge?.def?.sacks ?? ts.leaders?.defSacks?.val ?? sackVal(topPassRusher);
            const leaderName = topEdge ? (topEdge.name || getPlayerName(topEdge)) : (ts.leaders?.defSacks?.name || getPlayerName(topPassRusher) || 'Top rusher');
            const teamSacks = edgeSacks || teamDefSacks;
            const leaderPos = (topPassRusher?.position || '').toUpperCase();
            const yl = yearsLeft(topEdge || topPassRusher);
            if (yl !== null && yl <= 1) return `${leaderName} is in a contract year—add an EDGE to keep pressure constant.`;
            if (teamSacks && teamSacks >= 45) return ''; // production already strong; deprioritize EDGE
            if (teamSacks && teamSacks >= 40) return `Edge group produced ${teamSacks} sacks—focus elsewhere unless elite value falls.`;
            if (seenDef && leaderVal !== undefined) {
                if (leaderPos && ['DT','NT','IDL','IDL1','IDL2','IDL3'].includes(leaderPos)) {
                    return `${leaderName} (DT) is carrying the rush with ${leaderVal} sacks—add a true edge finisher so QBs can’t step up.`;
                }
                if (leaderVal < 8) return `${leaderName} had ${leaderVal} sacks—need more edge juice; add a finisher.`;
                return `${leaderName} posted ${leaderVal} sacks (edge total ${teamSacks ?? '—'})—add another closer to keep pressure high.`;
            }
            if (seenDef && teamSacks !== undefined) return `Edge group produced ${teamSacks} sacks—add edge juice to push the total up.`;
            return '';
        }
        if (pos === 'DT') {
            const dts = group(['DT','NT','IDL','IDL1','IDL2','IDL3']);
            const topDt = dts[0];
            const yl = yearsLeft(topDt);
            if (yl !== null && yl <= 1) return `${topDt ? getPlayerName(topDt) : 'Top DT'} is in a contract year—shore up the interior now.`;
            if (dtSacks !== undefined && dtSacks < 8) return `Interior rush produced ${dtSacks} sacks—add a DT who can collapse the pocket (a QB’s worst nightmare).`;
            if (teamStatsObj?.rushYdsAllowed !== undefined) {
                const r = teamStatsObj.rushYdsAllowed;
                if (r > 1800) return `Run D allowed ${r} rush yards—fortify the interior.`;
                return `Run D gave up ${r} rush yards—reinforce DT rotation.`;
            }
            if (dts.length) {
                const topDtSacks = Math.max(...dts.map(sackVal));
                if (topDtSacks >= 8 && edgeSacks < 30) return `Interior rush is carrying (${topDtSacks} DT sacks)—add edge heat to finish plays.`;
                return `DT room avg OVR ${avgOvr(dts)}—add a stronger interior anchor.`;
            }
            return '';
        }
        if (pos === 'LB') {
            const lbs = group(['MLB','ILB','LB','LOLB','ROLB','OLB','SAM','MIKE','WILL']);
            const topLb = lbs[0];
            const yl = yearsLeft(topLb);
            if (yl !== null && yl <= 1) return `${topLb ? getPlayerName(topLb) : 'Top LB'} is in a contract year—add speed and communication at linebacker.`;
            if (teamStatsObj?.rushYdsAllowed !== undefined) {
                const r = teamStatsObj.rushYdsAllowed;
                if (r > 1800) return `Front seven leaked ${r} rush yards—add a backer who fills fast.`;
                return `Front seven allowed ${r} rush yards—tighten fits with a rangy backer.`;
            }
            if (lbs.length) return `LB room avg OVR ${avgOvr(lbs)}—add speed and instincts inside.`;
            return '';
        }
        if (pos === 'CB') {
            const ints = ts.def?.ints ?? agg.defInts ?? topCB?.interceptions;
            const yl = yearsLeft(topCB);
            if (yl !== null && yl <= 1) return `${topCB ? getPlayerName(topCB) : 'Top corner'} is in a contract year—add coverage depth now.`;
            if (ints !== undefined) {
                if (ints < 10) return `Defense snagged ${ints} INTs—add a playmaking corner to boost takeaways.`;
                return `Defense tallied ${ints} INTs—add cover depth to keep turnovers coming.`;
            }
            return '';
        }
        if (pos === 'S') {
            const safeties = group(['FS','SS']);
            const topS = safeties[0];
            const yl = yearsLeft(topS);
            if (yl !== null && yl <= 1) return `${topS ? getPlayerName(topS) : 'Top safety'} is in a contract year—secure range on the back end.`;
            if (teamStatsObj?.passYdsAllowed !== undefined) {
                const p = teamStatsObj.passYdsAllowed;
                if (p > 4200) return `Secondary allowed ${p} pass yards—add a rangy safety.`;
                return `Pass D allowed ${p} yards—shore up the back end.`;
            }
            if (safeties.length) return `Safety room avg OVR ${avgOvr(safeties)}—add range and leadership.`;
            return '';
        }
        if (pos === 'OT' || pos === 'IOL') {
            const sacksAllowed = ts.pass?.sacksTaken ?? agg.passSacksTaken ?? teamStatsObj?.passSacksAllowed;
            const ypc = teamStatsObj?.rushAtt ? (teamStatsObj.rushYds || 0) / Math.max(1, teamStatsObj.rushAtt) : undefined;
            if (sacksAllowed !== undefined && sacksAllowed > 40) return `Allowed ${sacksAllowed} sacks—shore up protection on the line.`;
            if (ypc !== undefined && ypc < 4.2) return `Run game at ${ypc.toFixed(2)} YPC—upgrade the interior to move people.`;
            if (sacksAllowed !== undefined) return `Allowed ${sacksAllowed} sacks—add OL depth to stay clean.`;
            return '';
        }
        return '';
    };

    function buildNeedLine(pos, idx) {
        const pool = phrases[pos] ? [...phrases[pos]] : [];
        const stat = statSnippet(pos);
        if (!pool.length && !stat) return '';
        const weight = toneWeights[idx] ?? 0.6;
        const pickIdx = Math.min(Math.max(pool.length - 1, 0), Math.floor((1 - weight) * Math.max(pool.length - 1, 0)));
        const primary = stat || pool[pickIdx] || '';

        return primary;
    }

    // Show only the top 3 needs to keep the primer concise
    const needsDisplay = (topNeedsFinal.length >= 3 ? topNeedsFinal : [...topNeedsFinal, ...Array(3 - topNeedsFinal.length).fill('BPA')]).slice(0, 3);
    const needBlurbs = needs.length
        ? needsDisplay.map((pos, idx) => buildNeedLine(pos, idx)).filter(Boolean)
        : [pickRandom(phrases.BPA)];

    // Use deterministic-but-varied selection per team to avoid repeated blurbs across teams
    // Pull top-100 season grades for this team to weave into blurb
    const seasonTop = computeSeasonTop100FromHistory(leagueId) || [];
    const { first: allProFirst, second: allProSecond } = buildAllProTeams(seasonTop);
    const teamTop = seasonTop.filter(p =>
        (teamId != null && Number(p.teamId) === Number(teamId)) ||
        normalizeName(p.team || '') === normalizeName(teamName));
    const topStar = teamTop.slice().sort((a,b)=>Number(b.grade||0)-Number(a.grade||0))[0];
    const lowStar = teamTop.slice().sort((a,b)=>Number(a.grade||0)-Number(b.grade||0))[0];
    const apFirstHit = allProFirst.find(p =>
        (teamId != null && Number(p.teamId) === Number(teamId)) ||
        normalizeName(p.team || '') === normalizeName(teamName));
    const apSecondHit = allProSecond.find(p =>
        (teamId != null && Number(p.teamId) === Number(teamId)) ||
        normalizeName(p.team || '') === normalizeName(teamName));

    const top100Count = teamTop.length;
    const apFirstCount = allProFirst.filter(p => (teamId != null && Number(p.teamId) === Number(teamId)) || normalizeName(p.team || '') === normalizeName(teamName)).length;
    const apSecondCount = allProSecond.filter(p => (teamId != null && Number(p.teamId) === Number(teamId)) || normalizeName(p.team || '') === normalizeName(teamName)).length;

    const blurb = (() => {
        const endings = [
            "Attack your biggest weaknesses early, then look for value and depth in later rounds.",
            "Front-load premium positions in the first three rounds, then draft BPA for depth.",
            "Hit a core need in rounds 1–2, then stack depth and special teams help late.",
            "Prioritize starters early; round out the roster with versatile depth on day three.",
            "Fill glaring holes first, then chase upside swings with developmental prospects.",
            "Secure starters early, then grab a capable backup QB/OL to protect your season.",
            "Address marquee needs up top, then target role players who upgrade sub-packages."
        ];
        const closing = endings[seededRand(teamName, 'ending', endings.length)];
        const end = endings[seededRand(teamName, 'ending', endings.length)];
        const topGradeVal = (obj) => Number(obj?.seasonGrade ?? obj?.grade ?? obj?.avgGrade ?? 0);
        const posLabel = (p) => {
            const n = mapNeed(p);
            const map = {
                QB: 'QB',
                WR: 'receiver',
                TE: 'tight end',
                RB: 'runner', HB: 'runner',
                OT: 'tackle',
                IOL: 'interior lineman',
                OL: 'lineman',
                EDGE: 'edge rusher',
                DT: 'interior defender',
                LB: 'linebacker',
                SAM: 'linebacker',
                MIKE: 'linebacker',
                WILL: 'linebacker',
                CB: 'corner',
                S: 'safety',
            };
            return map[n] || needsDisplay[0] || 'unit';
        };
        const needSet = new Set(needsDisplay);
        const allProLine = (() => {
            if (apFirstHit && needSet.has(mapNeed(apFirstHit))) {
                const g = topGradeVal(apFirstHit).toFixed(1);
                return `First-team All-Pro ${apFirstHit.name} (${g}) anchors your ${posLabel(apFirstHit)} group—add another ${posLabel(apFirstHit)} to keep it elite.`;
            }
            if (apSecondHit && needSet.has(mapNeed(apSecondHit))) {
                const g = topGradeVal(apSecondHit).toFixed(1);
                return `Second-team All-Pro ${apSecondHit.name} (${g}) needs a complementary ${posLabel(apSecondHit)} so defenses can’t key on him.`;
            }
            if (topStar && needSet.has(mapNeed(topStar)) && topGradeVal(topStar) > 70) {
                const g = topGradeVal(topStar).toFixed(1);
                return `${topStar.name} graded ${g}; add another ${posLabel(topStar)} to maximize that advantage.`;
            }
            return '';
        })();
        const lowLine = (() => {
            if (lowStar && lowStar !== topStar && needSet.has(mapNeed(lowStar))) {
                const lg = topGradeVal(lowStar);
                if (lg > 0 && lg < 85) {
                    return `${lowStar.name} is at ${lg.toFixed(1)} — upgrade the ${posLabel(lowStar)} spot with a starting-caliber prospect.`;
                }
            }
            return '';
        })();
        const lines = [];
        if (allProLine) lines.push(allProLine);
        if (needBlurbs[0]) lines.push(needBlurbs[0]);
        if (needBlurbs[1]) lines.push(needBlurbs[1]);
        if (needBlurbs[2]) lines.push(needBlurbs[2]);
        if (lowLine) lines.push(lowLine);
        lines.push(closing);
        return lines.filter(Boolean).join(' ');
    })();

    // Final safety: if displayed needs do NOT include QB, strip any QB still lingering in picks
    if (!needsDisplay.includes('QB')) {
        const nonQBs = draftClass.filter(p => (p.position || p.position_1 || '').trim().toUpperCase() !== 'QB');
        const usedNames = new Set();
        picks = picks.map((line, idx) => {
            const isQB = line.toUpperCase().includes('(QB');
            if (!isQB) {
                const nm = line.match(/^\d+\.\s+([^()]+)\(/);
                if (nm) usedNames.add(nm[1].trim());
                return line;
            }
            const replacement = nonQBs.find(p => {
                if (usedNames.has(p.name)) return false;
                const posNeed = mapNeed(p);
                if (posNeed === 'WR' && wrCount >= maxWR) return false;
                return true;
            });
            if (replacement) {
                usedNames.add(replacement.name);
                if (mapNeed(replacement) === 'WR') wrCount++;
                const school = replacement.college || replacement.College || replacement.school || replacement.schoolName || 'N/A';
                return `${idx + 1}. ${replacement.name} (${replacement.position || replacement.position_1 || 'POS'}) — ${school} (Proj R${idx + 1})`;
            }
            return `${idx + 1}. No suggestion`;
        });
    }

    const embed = new EmbedBuilder()
        .setTitle(`${teamEmoji ? teamEmoji + ' ' : ''}${teamName} — Draft Primer`)
        .setDescription(`**Players to Target**\n${picks.join('\n')}`)
        .addFields(
            { name: 'Top Team Needs', value: needsDisplay.map((n, i) => `${i + 1}. ${n}`).join('\n') },
            { name: 'Last Season Record', value: recordStr },
            { name: 'Roster Accolades', value: `Top 100: ${top100Count}\nAll-Pro 1st: ${apFirstCount}\nAll-Pro 2nd: ${apSecondCount}` },
            { name: 'Strategy', value: blurb }
        )
        .setColor(0x00b0f4);
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ embeds: [embed] });
    } else {
        await interaction.reply({ embeds: [embed], flags: 64 });
    }
}

export default { data, execute };
