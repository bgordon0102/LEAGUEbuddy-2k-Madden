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
    // Only store votes and createdAt, not trade
    const serializableVotes = {};
    for (const [msgId, voteObj] of Object.entries(votes)) {
        const { votes, createdAt } = voteObj;
        serializableVotes[msgId] = { votes, createdAt };
    }
    fs.writeFileSync(VOTES_PATH, JSON.stringify(serializableVotes, null, 2));
}
