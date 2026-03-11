import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'data', 'madden', 'thread_reminders.json');
const EIGHT_HOURS = 8 * 60 * 60 * 1000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { threads: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();
let clientRef = null;

export function initNotifier(client) {
  clientRef = client;
  setInterval(async () => {
    const now = Date.now();
    const entries = Object.entries(state.threads || {});
    for (const [threadId, info] of entries) {
      if (info.status !== 'pending') continue;
      const last = info.lastReminder || info.created || 0;
      if (now - last < EIGHT_HOURS) continue;
      try {
        const thread = await client.channels.fetch(threadId).catch(() => null);
        if (!thread || !thread.isTextBased()) continue;
        const mention = info.mention || '';
        await thread.send({
          content: `${mention} ⏰ Friendly reminder: please schedule your game and choose an outcome with the buttons above.`,
          allowedMentions: mention ? { parse: ['roles', 'users'] } : { parse: [] },
        });
        info.lastReminder = now;
      } catch {
        // ignore failures
      }
    }
    saveState(state);
  }, 60 * 60 * 1000); // check hourly
}

export function registerThread(threadId, mention) {
  state.threads = state.threads || {};
  state.threads[threadId] = {
    status: 'pending',
    created: Date.now(),
    lastReminder: Date.now(),
    mention: mention || '',
  };
  saveState(state);
}

export function markThreadDone(threadId, status = 'done') {
  if (!state.threads || !state.threads[threadId]) return;
  state.threads[threadId].status = status;
  saveState(state);
}

export function resetThread(threadId) {
  if (!state.threads || !state.threads[threadId]) return;
  state.threads[threadId].status = 'pending';
  state.threads[threadId].lastReminder = Date.now();
  saveState(state);
}

export default { initNotifier, registerThread, markThreadDone, resetThread };
