import fs from 'fs';
import path from 'path';

const STORE_PATH = path.join(process.cwd(), 'data', 'trade_drafts.json');
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

const drafts = new Map();

// Load persisted drafts on startup (best effort)
try {
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  const obj = JSON.parse(raw);
  Object.entries(obj || {}).forEach(([id, draft]) => drafts.set(id, draft));
} catch {
  // ignore missing/invalid file
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const obj = {};
    drafts.forEach((val, key) => { obj[key] = val; });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[trade_draft_store] persist failed:', e?.message || e);
  }
}

function prune() {
  const now = Date.now();
  let changed = false;
  drafts.forEach((draft, id) => {
    if (now - (draft.savedAt || 0) > MAX_AGE_MS) {
      drafts.delete(id);
      changed = true;
    }
  });
  if (changed) persist();
}

export function saveTradeDraft(draftId, draft) {
  if (!draftId || !draft) return;
  drafts.set(draftId, { ...draft, savedAt: Date.now() });
  persist();
}

export function getTradeDraft(draftId) {
  if (!draftId) return null;
  prune();
  return drafts.get(draftId) || null;
}

export function deleteTradeDraft(draftId) {
  if (!draftId) return;
  drafts.delete(draftId);
  persist();
}

// Remove all drafts for a given user (helpful to avoid stale selections carrying over)
export function deleteDraftsForUser(userId) {
  if (!userId) return;
  let changed = false;
  drafts.forEach((draft, id) => {
    if (draft.userId === userId) {
      drafts.delete(id);
      changed = true;
    }
  });
  if (changed) persist();
}
