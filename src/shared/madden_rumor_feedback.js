import fs from 'fs';
import path from 'path';

const STORE_FILE = path.join(process.cwd(), 'data', 'madden', 'rumor_feedback.json');

function safeReadJSON(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data ?? {}, null, 2));
}

export function loadRumorFeedback() {
  return safeReadJSON(STORE_FILE, {});
}

export function saveRumorFeedback(data) {
  saveJSON(STORE_FILE, data || {});
}

export function getRumorFeedbackForGuild(guildId) {
  const store = loadRumorFeedback();
  return store?.[guildId] || {
    deniedKeys: {},
    deniedCategories: {},
    approvedKeys: {},
    approvedCategories: {},
    lastUpdatedAt: 0,
  };
}

export function recordRumorReviewFeedback({ guildId, action, item, reviewedBy }) {
  if (!guildId || !item || item.kind !== 'rumor_mill') return null;
  const normalizedAction = action === 'approve' ? 'approve' : 'deny';
  const keyField = normalizedAction === 'approve' ? 'approvedKeys' : 'deniedKeys';
  const categoryField = normalizedAction === 'approve' ? 'approvedCategories' : 'deniedCategories';
  const key = String(item.rumorKey || '').trim();
  const category = String(item.rumorCategory || '').trim();

  const store = loadRumorFeedback();
  const guildStore = store[guildId] || {
    deniedKeys: {},
    deniedCategories: {},
    approvedKeys: {},
    approvedCategories: {},
    history: [],
    lastUpdatedAt: 0,
  };

  if (key) guildStore[keyField][key] = Number(guildStore[keyField][key] || 0) + 1;
  if (category) guildStore[categoryField][category] = Number(guildStore[categoryField][category] || 0) + 1;
  guildStore.history = [
    ...(Array.isArray(guildStore.history) ? guildStore.history : []),
    {
      action: normalizedAction,
      key,
      category,
      reviewedBy: reviewedBy ? String(reviewedBy) : '',
      at: Date.now(),
    },
  ].slice(-500);
  guildStore.lastUpdatedAt = Date.now();
  store[guildId] = guildStore;
  saveRumorFeedback(store);
  return guildStore;
}

export default {
  loadRumorFeedback,
  saveRumorFeedback,
  getRumorFeedbackForGuild,
  recordRumorReviewFeedback,
};
