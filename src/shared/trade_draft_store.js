const drafts = new Map();

export function saveTradeDraft(draftId, draft) {
  if (!draftId || !draft) return;
  drafts.set(draftId, { ...draft, savedAt: Date.now() });
}

export function getTradeDraft(draftId) {
  if (!draftId) return null;
  return drafts.get(draftId) || null;
}

export function deleteTradeDraft(draftId) {
  if (!draftId) return;
  drafts.delete(draftId);
}
