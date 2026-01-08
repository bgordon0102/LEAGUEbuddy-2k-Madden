import fs from 'fs';
const VOTES_PATH = './data/committeeVotes.json';

export function loadCommitteeVotes() {
    try {
        return JSON.parse(fs.readFileSync(VOTES_PATH, 'utf8'));
    } catch {
        return {};
    }
}

export function saveCommitteeVotes(votes) {
    // Remove any non-serializable properties (like timeout) before saving
    const serializableVotes = {};
    for (const [msgId, voteObj] of Object.entries(votes)) {
        const { trade, votes, createdAt } = voteObj;
        serializableVotes[msgId] = { trade, votes, createdAt };
    }
    fs.writeFileSync(VOTES_PATH, JSON.stringify(serializableVotes, null, 2));
}
