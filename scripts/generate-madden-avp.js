import fs from 'fs';
import path from 'path';
import {
    applyPickTrades,
    draftOrder,
    loadDraftClass,
    loadOfficialDraftOrderOverride,
    deriveTeamNeeds,
    prospectGroup,
} from '../src/madden/coach/mockdraft.js';
import { resolveLeagueIdWithConfig, loadLeagueSnapshot } from '../src/madden/madden_data.js';

const OUTPUT_FILE = path.join(process.cwd(), 'data', 'madden', 'madden_avp.json');

function seededRand(seedStr, salt, max) {
    const str = `${seedStr}|${salt}`;
    let h = 0;
    for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return max > 0 ? h % max : 0;
}

function premiumPositionValue(group) {
    const values = {
        QB: 10,
        OT: 8,
        EDGE: 8,
        CB: 7,
        WR: 7,
        IOL: 5,
        DT: 5,
        S: 5,
        LB: 4,
        TE: 2,
        RB: 1,
        BPA: 0,
    };
    return values[group] || 0;
}

function findNeedsForTeam(teamName, needsMap, altName) {
    const normalizeName = (name = '') => name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const clean = (s) => normalizeName((s || '').replace(/\(via.*$/i, '').trim());
    const norm = clean(teamName);
    const mascotOnly = norm.split(/city|town|club/)[0] || norm;
    const variants = new Set([norm, mascotOnly]);
    if (altName) variants.add(clean(altName));

    for (const k of variants) {
        if (needsMap?.[k]) return needsMap[k];
    }
    return [];
}

function chooseVariantCandidate(scoredCandidates, seedStr, salt) {
    if (!Array.isArray(scoredCandidates) || !scoredCandidates.length) return null;
    const sorted = [...scoredCandidates].sort((a, b) => a.score - b.score || a.index - b.index);
    const bestScore = sorted[0].score;
    const pool = sorted
        .filter((entry, idx) => idx < 5 && entry.score <= bestScore + 16)
        .slice(0, 5);
    if (pool.length <= 1) return pool[0];
    const weights = [8, 5, 3, 2, 1].slice(0, pool.length);
    const total = weights.reduce((sum, value) => sum + value, 0);
    let roll = seededRand(seedStr, salt, total);
    for (let idx = 0; idx < pool.length; idx += 1) {
        roll -= weights[idx];
        if (roll < 0) return pool[idx];
    }
    return pool[0];
}

function autoPickProspect(session) {
    const slot = session.order[session.currentPickIndex];
    if (!slot) return session.availableProspects[0] || null;
    const needs = findNeedsForTeam(slot.name, session.teamNeeds || {}, slot.nick);
    const needSet = new Set((needs || []).slice(0, 4));
    const scoredCandidates = [];

    for (let idx = 0; idx < session.availableProspects.length; idx += 1) {
        if (idx > 26) break;
        const prospect = session.availableProspects[idx];
        const group = prospectGroup(prospect);
        const overall = Number(prospect.overall || 0);
        const needRank = needs.indexOf(group);

        const boardPenalty = idx * 6;
        const needBonus = needRank === 0 ? 26 : needRank === 1 ? 18 : needRank === 2 ? 11 : needRank === 3 ? 6 : 0;
        const premiumBonus = premiumPositionValue(group) * 2;
        const eliteBonus = overall >= 84 ? 14 : overall >= 80 ? 8 : 0;

        let score = boardPenalty - needBonus - premiumBonus - eliteBonus;
        if (needSet.has(group)) score -= 12;

        // early RB/TE dampener when not truly elite
        if (['RB', 'TE'].includes(group) && idx < 12 && overall < 84 && !needSet.has(group)) score += 20;

        score += seededRand(session.variantSeed || session.id, `${slot.name}|${session.currentPickIndex}|${prospect.name}`, 8);
        scoredCandidates.push({ index: idx, score, prospect });
    }

    const chosen = chooseVariantCandidate(
        scoredCandidates,
        session.variantSeed || session.id,
        `${slot.name}|pick_${session.currentPickIndex + 1}`,
    );
    return chosen?.prospect || session.availableProspects[0] || null;
}

function makeAutoSession({ guildId, leagueId, draftYear, order, prospects, teamNeeds, variantSeed }) {
    return {
        id: `sim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        guildId,
        leagueId,
        draftYear,
        status: 'live',
        order,
        availableProspects: prospects.map((p) => ({ ...p })),
        teamNeeds,
        picks: [],
        currentPickIndex: 0,
        variantSeed,
    };
}

function runOneDraft(base, salt) {
    const session = makeAutoSession({ ...base, variantSeed: `${base.variantSeed}|${salt}` });

    while (session.currentPickIndex < session.order.length && session.availableProspects.length) {
        const prospect = autoPickProspect(session);
        if (!prospect) break;

        const pickNumber = session.currentPickIndex + 1;
        session.picks.push({ pickNumber, prospectId: prospect.id });

        session.availableProspects = session.availableProspects.filter((p) => p.id !== prospect.id);
        session.currentPickIndex += 1;
    }

    return session.picks;
}

function ensureOutputDir() {
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
}

function mean(values) {
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

function main() {
    const sims = Number(process.argv[2] || 1000);
    const guildId = process.argv[3] || null;

    if (!guildId) {
        console.error('Usage: node scripts/generate-madden-avp.js <simCount=1000> <guildId>');
        process.exit(1);
    }

    const leagueId = resolveLeagueIdWithConfig(guildId);
    const league = leagueId ? loadLeagueSnapshot(leagueId) : null;
    if (!league) {
        console.error('League snapshot is not ready for this guildId.');
        process.exit(1);
    }

    const draftYear = (() => {
        const y = Number(league?.calendarYear || league?.calendar?.year || 0);
        return y || new Date().getFullYear();
    })();

    const officialOrder = loadOfficialDraftOrderOverride(league, draftYear);
    const rawOrder = officialOrder || draftOrder(league);
    const order = (officialOrder || applyPickTrades(rawOrder, draftYear)).slice(0, 32);

    const prospects = loadDraftClass().map((p) => ({
        id: String(p.id || `${(p.name || 'player').toLowerCase().replace(/[^a-z0-9]/g, '')}_${p.position_1 || p.position || ''}`),
        name: p.name,
        rank: Number(p.RNK || p.rank || p.order || 9999),
        position: p.position_1 || p.position,
        school: p.school,
        overall: Number(p.overall ?? p.ovr ?? p.rating ?? p.OVR ?? 0),
    })).sort((a, b) => a.rank - b.rank);

    const teamNeeds = deriveTeamNeeds(league);

    const pickSamplesByProspect = new Map();
    const base = {
        guildId,
        leagueId,
        draftYear,
        order,
        prospects,
        teamNeeds,
        variantSeed: `avp|${guildId}|${leagueId}|${draftYear}`,
    };

    for (let i = 0; i < sims; i += 1) {
        const picks = runOneDraft(base, String(i));
        for (const p of picks) {
            if (!pickSamplesByProspect.has(p.prospectId)) pickSamplesByProspect.set(p.prospectId, []);
            pickSamplesByProspect.get(p.prospectId).push(p.pickNumber);
        }
    }

    const out = {
        generatedAt: Date.now(),
        guildId,
        leagueId,
        draftYear,
        sims,
        prospects: {},
    };

    for (const prospect of prospects) {
        const samples = pickSamplesByProspect.get(prospect.id) || [];
        out.prospects[prospect.id] = {
            name: prospect.name,
            position: prospect.position,
            school: prospect.school,
            boardRank: prospect.rank,
            avp: samples.length ? Number(mean(samples).toFixed(2)) : null,
            medianPick: samples.length ? median(samples) : null,
            samples: samples.length,
        };
    }

    ensureOutputDir();
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(out, null, 2));
    console.log(`Wrote AVP file: ${OUTPUT_FILE}`);
}

main();
