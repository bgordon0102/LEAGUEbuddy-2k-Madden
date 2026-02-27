import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { deriveTeamNeeds } from './mockdraft.js';
import { loadTeamEmojis, formatTeamEmoji } from './mockdraft.js';

const ROLE_MAP_PATH = path.join(process.cwd(), 'data', 'madden', 'madden_role_ids.json');

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

function mapPositionToNeed(player) {
    const pos = (player.position || player.position_1 || '').toUpperCase();
    if (pos === 'QB') return 'QB';
    if (['LT', 'RT'].includes(pos)) return 'OT';
    if (['LG', 'C', 'RG'].includes(pos)) return 'IOL';
    if (['LE', 'RE', 'EDGE', 'EDG', 'LEDG', 'REDG', 'DE', 'RDE', 'LDE'].includes(pos)) return 'EDGE';
    if (['DT', 'NT', 'IDL', 'IDL1', 'IDL2', 'IDL3'].includes(pos)) return 'DT';
    if (['MLB', 'ILB', 'LB', 'LOLB', 'ROLB', 'OLB', 'SAM', 'MIKE', 'WILL'].includes(pos)) return 'LB';
    if (pos === 'CB') return 'CB';
    if (['FS', 'SS'].includes(pos)) return 'S';
    if (pos === 'WR') return 'WR';
    if (['HB', 'RB', 'FB'].includes(pos)) return 'RB';
    return 'BPA';
}

function resolveTeamNeeds(teamName, league, needsByTeam) {
    // Try exact normalized match first
    const norm = normalizeName(teamName);
    if (needsByTeam[norm]) return needsByTeam[norm];

    const teams = league?.teams?.leagueTeamInfoList || [];
    for (const t of teams) {
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
    const teams = league?.teams?.leagueTeamInfoList || [];
    const rosters = league?.rosters?.teams || {};
    let teamId = null;
    for (const t of teams) {
        const candidates = [
            `${t.cityName || ''} ${t.nickName || ''}`,
            t.nickName,
            t.displayName,
            t.abbrName,
            t.cityName,
        ].filter(Boolean).map(normalizeName);
        if (candidates.includes(norm)) {
            teamId = Number(t.teamId);
            break;
        }
    }
    if (teamId === null) return { wantDepthQB: false };
    const roster = rosters[teamId] || rosters[String(teamId)] || {};
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
        await interaction.reply({ content: 'You are not mapped to a Madden team. Contact a commissioner.', ephemeral: true });
        return;
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

    // Load prebuilt team stats (authoritative) and fall back to inline aggregation if missing
    const TEAM_STATS_PATH = path.join(process.cwd(), 'data', 'madden', 'team_stats.json');
    let seasonAgg = {};
    let seasonCounts = {};
    let playerAgg = {};
    const rosterNameById = {};
    for (const [tidStr, rosterTeam] of Object.entries(league.rosters?.teams || {})) {
        for (const p of rosterTeam?.rosterInfoList || []) {
            rosterNameById[p.rosterId] = p.displayName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unknown';
        }
    }
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

    // Needs, context, and draft class
    const needsByTeam = deriveTeamNeeds(league);
    const needs = resolveTeamNeeds(teamName, league, needsByTeam);
    const { wantDepthQB } = qbDepthStatus(teamName, league);
    const draftClass = loadDraftClass();
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

    const qbChoice = chooseQBForTeam(needs);
    const qbTargetRound = qbChoice?.projRound;
    const emojis = loadTeamEmojis();
    const teamEmoji = formatTeamEmoji(teamName, emojis);

    // Build 7 targets (1 per round) strictly from that round's 32-player slice
    const picks = [];
    const seen = new Set();
    const mapNeed = p => mapPositionToNeed(p);
    const metNeeds = new Set();
    let pickedQB = false;

    for (let round = 1; round <= 7; round++) {
        const start = (round - 1) * 32;
        const end = round * 32;
        const slice = draftClass.slice(start, end);
        const offset = seededRand(teamName, round, Math.max(1, slice.length));
        const rotated = slice.slice(offset).concat(slice.slice(0, offset));
        const allowQBThisRound = qbChoice && qbTargetRound === round;
        const take = (fn) => rotated.find(p => {
            if (seen.has(p.name)) return false;
            const n = mapNeed(p);
            // Do not allow a second QB once one is already selected
            if (pickedQB && n === 'QB') return false;
            // Only allow the pre-selected QB round unless we're in the round 7 emergency fallback
            if (n === 'QB' && !allowQBThisRound && round !== 7) return false;
            return fn(p);
        });

        const needIsQB = needs[0] === 'QB';
        const pendingTop3 = needs.slice(0, 3).filter(n => !metNeeds.has(n));
        const remainingRounds = 7 - round + 1;
        let target = null;

        // 1) Pre-selected QB round
        if (!target && allowQBThisRound) {
            // Try the pre-selected QB for variety; fall back to any QB in the slice
            target = take(p => mapNeed(p) === 'QB' && (!qbChoice || p.name === qbChoice.name))
                || take(p => mapNeed(p) === 'QB');
        }

        // 2) Unmet top-3 needs in order
        if (!target) {
            for (const n of pendingTop3) {
                target = take(p => mapNeed(p) === n);
                if (target) break;
            }
        }

        // 3) Avoid early QBs if QB not a need
        if (!target && !needs.includes('QB') && round <= 3) {
            target = take(p => mapNeed(p) !== 'QB');
        }

        // 4) Depth QB if weak depth (slice only)
        if (!target && wantDepthQB && round >= 4 && allowQBThisRound) {
            target = take(p => mapNeed(p) === 'QB');
        }

        // 5) Final round: if QB is any need and none picked, try QB (only once), regardless of planned round
        if (!target && round === 7 && needs.includes('QB') && !pickedQB) {
            target = rotated.find(p => !seen.has(p.name) && mapNeed(p) === 'QB') || target;
        }

        // 7) If remaining rounds equal unmet top-3 needs, force next unmet need
        if (!target && pendingTop3.length && remainingRounds <= pendingTop3.length) {
            const need = pendingTop3[0];
            target = take(p => mapNeed(p) === need) || target;
        }

        // 8) Fallback: first available in slice
        if (!target) target = take(() => true) || null;

        if (target) {
            seen.add(target.name);
            const n = mapNeed(target);
            if (n) metNeeds.add(n);
            if (n === 'QB') pickedQB = true; // lock out additional QBs
        }
        const school = target?.college || target?.College || target?.school || target?.schoolName || 'N/A';
        picks.push(target
            ? `${round}. ${target.name} (${target.position || target.position_1 || 'POS'}) — ${school} (Proj R${round})`
            : `${round}. No suggestion`);
    }
    // --- Stat-driven strategy logic ---
    // 1. Get teamId
    const teams = league?.teams?.leagueTeamInfoList || [];
    let teamId = null;
    for (const t of teams) {
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
    // Fallback: loose contains match
    if (teamId === null) {
        const target = normalizeName(teamName);
        const hit = teams.find(t => normalizeName(t.displayName || t.nickName || '').includes(target));
        if (hit) teamId = Number(hit.teamId);
    }
    // 2. Get win/loss record
    const standings = league?.standings?.teamStandingInfoList || [];
    const teamStanding = standings.find(s => Number(s.teamId) === teamId);
    const recordStr = teamStanding ? `${teamStanding.totalWins}-${teamStanding.totalLosses}` : 'N/A';
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
    if (teamStatsObj?.passSacksAllowed !== undefined) {
        statBlurbs.push(`Sacks allowed: ${teamStatsObj.passSacksAllowed}.`);
    }
    // Pre-compute leaders for stat weaving
    const qbs = players.filter(p => (p.position || '').toUpperCase() === 'QB').sort((a, b) => (b.passYds ?? 0) - (a.passYds ?? 0));
    const topQB = qbs[0];
    const rbs = players.filter(p => ['HB', 'RB', 'FB'].includes((p.position || '').toUpperCase())).sort((a, b) => (b.rushYds ?? 0) - (a.rushYds ?? 0));
    const topRB = rbs[0];
    const wrs = players.filter(p => (p.position || '').toUpperCase() === 'WR').sort((a, b) => (b.recYds ?? 0) - (a.recYds ?? 0));
    const topWR = wrs[0];
    const edges = players.filter(p => ['LE', 'RE', 'ROLB', 'LOLB', 'EDGE', 'EDG', 'OLB', 'DE', 'LEDG', 'REDG', 'RDE', 'LDE'].includes((p.position || '').toUpperCase())).sort((a, b) => (b.sacks ?? 0) - (a.sacks ?? 0));
    const topEdge = edges[0];
    const cbs = players.filter(p => (p.position || '').toUpperCase() === 'CB').sort((a, b) => (b.interceptions ?? 0) - (a.interceptions ?? 0));
    const topCB = cbs[0];

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
            "Bolster the line with tough, smart blockers who win with leverage and hands."
        ],
        EDGE: [
            "You need more juice off the edge. Look for explosive pass rushers to disrupt opposing QBs.",
            "A dominant EDGE can change games—prioritize pressure in your draft strategy.",
            "Adding speed and power to your front seven will boost your whole defense.",
            "Edge rushers are game-wreckers. Find one who fits your scheme.",
            "A relentless pass rusher will help your secondary and force turnovers.",
            "Target bend-and-burst off the edge to close out drives in two-minute situations."
        ],
        OT: [
            "Lock down the edges with a tackle who keeps your QB clean.",
            "Invest in an OT who can stonewall speed rushers and set the pocket depth.",
            "A reliable tackle stabilizes your pass game—secure one early.",
            "Upgrade tackle to improve both protection and perimeter run game.",
            "Bookend tackles make everything easier; target one with good feet and anchor.",
            "Find a tackle with range and anchor so you can live in true dropback pass sets."
        ],
        IOL: [
            "Control the interior with a guard/center who moves people off the ball.",
            "Add an IOL who can anchor vs. power and climb to backers in the run game.",
            "Interior pressure kills drives—shore up G/C spots to keep your QB clean.",
            "Target a versatile guard/center to solidify protections and short yardage.",
            "Win inside—draft an IOL who finishes blocks and keeps the pocket firm.",
            "Secure an IOL with processing and punch to sort games and blitzes."
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
            "Stack a separator who wins on third down and in the red zone."
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

    const statSnippet = (pos) => {
        const ts = seasonAgg[teamId] || {};
        const agg = seasonAgg[teamId] || {};
        const seenPass = ts.pass?.yds !== undefined || (seasonCounts[teamId]?.pass || 0) > 0;
        const seenRush = ts.rush?.yds !== undefined || (seasonCounts[teamId]?.rush || 0) > 0;
        const seenRec  = ts.rec?.yds  !== undefined || (seasonCounts[teamId]?.rec  || 0) > 0;
        const seenDef  = ts.def?.sacks !== undefined || (seasonCounts[teamId]?.def  || 0) > 0;

        if (pos === 'QB') {
            const qbName = ts.leaders?.passYds?.name || (topQB ? getPlayerName(topQB) : 'QB');
            const passYds = ts.pass?.yds ?? topQB?.passYds ?? agg.passYds;
            const passAtt = ts.pass?.att ?? agg.passAtt ?? 0;
            const passComp = ts.pass?.comp ?? agg.passComp ?? 0;
            const compPct = passAtt ? (passComp / passAtt) * 100 : null;
            const td = ts.pass?.td ?? agg.passTDs;
            const ints = ts.pass?.int ?? agg.passInts;
            const qbAge = topQB?.age ?? 0;
            if (seenPass && ints !== undefined && ints >= 15) return `${qbName} threw ${ints} INTs—start evaluating a new option at quarterback.`;
            if (seenPass && qbAge >= 33) return `${qbName} is ${qbAge}—begin lining up a replacement QB now.`;
            if (seenPass && passYds !== undefined && passYds < 3500) return `${qbName} produced ${passYds} pass yards—upgrade the signal-caller.`;
            if (seenPass && td !== undefined && ints !== undefined && ints > 0 && td / ints < 2) return `${qbName}'s TD/INT ratio is under 2:1 (TDs ${td}, INTs ${ints})—raise the floor at QB.`;
            if (seenPass && compPct !== null && compPct < 63) return `${qbName} completed only ${compPct.toFixed(1)}%—add accuracy and timing.`;
            if (seenPass && passYds !== undefined) return `${qbName} totaled ${passYds} pass yards—add competition and a long-term answer.`;
            return '';
        }
        if (pos === 'RB') {
            const leaderName = ts.leaders?.rushYds?.name || 'Top back';
            const rushYds = ts.rush?.yds ?? topRB?.rushYds ?? agg.rushYds;
            const rushAtt = ts.rush?.att ?? agg.rushAtt;
            const ypc = rushAtt ? rushYds / rushAtt : null;
            const td = ts.rush?.td ?? agg.rushTDs;
            if (seenRush && rushYds !== undefined && rushYds < 1100) return `${leaderName} managed ${rushYds} rush yards—find a true bell cow.`;
            if (seenRush && ypc !== null && ypc < 4.2) return `Run game averaged ${ypc.toFixed(2)} YPC—add a back who creates explosives.`;
            if (seenRush && td !== undefined && td < 10) return `Ground game scored ${td} rush TDs—add a finisher in the red zone.`;
            if (seenRush && rushYds !== undefined) return `${leaderName} posted ${rushYds} yards—pair him with another playmaker.`;
            return '';
        }
        if (pos === 'WR') {
            const leaderName = ts.leaders?.recYds?.name || 'Top target';
            const recYds = ts.rec?.yds ?? topWR?.recYds ?? agg.recYds;
            const recTDs = ts.rec?.td ?? agg.recTDs;
            if (seenRec && recYds !== undefined && recYds < 1000) return `${leaderName} topped out at ${recYds} yards—add a true weapon.`;
            if (seenRec && recTDs !== undefined && recTDs < 20) return `Receivers combined for ${recTDs} TDs—add a reliable scoring threat.`;
            if (seenRec && recYds !== undefined) return `${leaderName} logged ${recYds} yards—add another threat to tilt coverage.`;
            return '';
        }
        if (pos === 'EDGE') {
            const leaderVal = ts.leaders?.defSacks?.val;
            const leaderName = ts.leaders?.defSacks?.name || 'Top rusher';
            const teamSacks = ts.def?.sacks ?? agg.defSacks;
            if (seenDef && leaderVal !== undefined) {
                if (leaderVal < 10) return `${leaderName} had ${leaderVal} sacks—no double-digit threat; add a finisher off the edge.`;
                return `${leaderName} posted ${leaderVal} sacks (team ${teamSacks ?? '—'})—add another closer to keep pressure high.`;
            }
            if (seenDef && teamSacks !== undefined) return `Defense produced ${teamSacks} sacks—add edge juice to push the total up.`;
            return '';
        }
        if (pos === 'DT') {
            if (teamStatsObj?.rushYdsAllowed !== undefined) {
                const r = teamStatsObj.rushYdsAllowed;
                if (r > 1800) return `Run D allowed ${r} rush yards—fortify the interior.`;
                return `Run D gave up ${r} rush yards—reinforce DT rotation.`;
            }
            const dts = group(['DT','NT','IDL','IDL1','IDL2','IDL3']);
            if (dts.length) return `DT room avg OVR ${avgOvr(dts)}—add a stronger interior anchor.`;
            return '';
        }
        if (pos === 'LB') {
            if (teamStatsObj?.rushYdsAllowed !== undefined) {
                const r = teamStatsObj.rushYdsAllowed;
                if (r > 1800) return `Front seven leaked ${r} rush yards—add a backer who fills fast.`;
                return `Front seven allowed ${r} rush yards—tighten fits with a rangy backer.`;
            }
            const lbs = group(['MLB','ILB','LB','LOLB','ROLB','OLB','SAM','MIKE','WILL']);
            if (lbs.length) return `LB room avg OVR ${avgOvr(lbs)}—add speed and instincts inside.`;
            return '';
        }
        if (pos === 'CB') {
            const ints = ts.def?.ints ?? agg.defInts ?? topCB?.interceptions;
            if (ints !== undefined) {
                if (ints < 10) return `Defense snagged ${ints} INTs—add a playmaking corner to boost takeaways.`;
                return `Defense tallied ${ints} INTs—add cover depth to keep turnovers coming.`;
            }
            return '';
        }
        if (pos === 'S') {
            if (teamStatsObj?.passYdsAllowed !== undefined) {
                const p = teamStatsObj.passYdsAllowed;
                if (p > 4200) return `Secondary allowed ${p} pass yards—add a rangy safety.`;
                return `Pass D allowed ${p} yards—shore up the back end.`;
            }
            const safeties = group(['FS','SS']);
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

        // For the #1 need, force two sentences: stat/primary + an extra urgency/support line
        if (idx === 0) {
            // choose a different line for variety
            const altPool = pool.filter(line => line !== primary);
            const secondary = altPool.length ? altPool[seededRand(pos, 777, altPool.length)] : pickRandom(phrases.BPA);
            return [primary, secondary].filter(Boolean).join(' ');
        }
        return primary;
    }

    const needBlurbs = needs.length
        ? needs.slice(0, 3).map((pos, idx) => buildNeedLine(pos, idx)).filter(Boolean)
        : [pickRandom(phrases.BPA)];
    let blurb = needBlurbs.join(' ');
    const endings = [
        "Attack your biggest weaknesses early, then look for value and depth in later rounds.",
        "Front-load premium positions in the first three rounds, then draft BPA for depth.",
        "Hit a core need in rounds 1–2, then stack depth and special teams help late.",
        "Prioritize starters early; round out the roster with versatile depth on day three.",
        "Fill glaring holes first, then chase upside swings with developmental prospects.",
        "Secure starters early, then grab a capable backup QB/OL to protect your season.",
        "Address marquee needs up top, then target role players who upgrade sub-packages."
    ];
    blurb += ` ${pickRandom(endings)}`;

    const embed = new EmbedBuilder()
        .setTitle(`${teamEmoji ? teamEmoji + ' ' : ''}${teamName} — Draft Primer`)
        .setDescription(`**Players to Target**\n${picks.join('\n')}`)
        .addFields(
            { name: 'Top Team Needs', value: needs.length ? needs.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'No needs found.' },
            { name: 'Last Season Record', value: recordStr },
            { name: 'Strategy', value: blurb }
        )
        .setColor(0x00b0f4);
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export default { data, execute };
