import fs from 'fs';
import path from 'path';

const QUEUE_FILE = path.join(process.cwd(), 'data', 'madden', 'content_review_queue.json');
const FEEDBACK_FILE = path.join(process.cwd(), 'data', 'madden', 'rumor_feedback.json');
const SCHEDULER_FILE = path.join(process.cwd(), 'data', 'madden', 'story_scheduler.json');
const STAFF_LOG_FILE = path.join(process.cwd(), 'data', 'madden', 'staff_activity_log.json');

function safeReadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isRumorLogEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'rumor_mill') return true;
  const type = String(entry.type || '');
  return type.startsWith('rumor_queue');
}

export async function clearMaddenRumorState(client, guildId, options = {}) {
  const {
    clearQueue = true,
    clearFeedback = true,
    clearScheduler = true,
    clearStaffLog = true,
  } = options;

  const summary = {
    clearedReviewCards: 0,
    clearedQueueItems: 0,
    clearedFeedback: false,
    clearedSchedulerHistory: false,
    clearedStaffLogEntries: 0,
  };

  if (clearQueue) {
    const queue = safeReadJSON(QUEUE_FILE, {});
    for (const [id, item] of Object.entries(queue)) {
      if (!item || item.guildId !== guildId || item.kind !== 'rumor_mill') continue;
      if (item.staffChannelId && item.reviewMessageId && client) {
        const channel = await client.channels.fetch(item.staffChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.messages.delete(item.reviewMessageId).catch(() => null);
          summary.clearedReviewCards += 1;
        }
      }
      delete queue[id];
      summary.clearedQueueItems += 1;
    }
    saveJSON(QUEUE_FILE, queue);
  }

  if (clearFeedback) {
    const feedback = safeReadJSON(FEEDBACK_FILE, {});
    if (feedback[guildId]) {
      delete feedback[guildId];
      saveJSON(FEEDBACK_FILE, feedback);
    }
    summary.clearedFeedback = true;
  }

  if (clearScheduler) {
    const scheduler = safeReadJSON(SCHEDULER_FILE, {});
    scheduler.rumorCursorByGuild = scheduler.rumorCursorByGuild || {};
    scheduler.rumorHistoryByGuild = scheduler.rumorHistoryByGuild || {};
    if (Object.prototype.hasOwnProperty.call(scheduler.rumorCursorByGuild, guildId)) {
      delete scheduler.rumorCursorByGuild[guildId];
    }
    if (Object.prototype.hasOwnProperty.call(scheduler.rumorHistoryByGuild, guildId)) {
      delete scheduler.rumorHistoryByGuild[guildId];
    }
    scheduler.lastRumorQueuedAt = 0;
    saveJSON(SCHEDULER_FILE, scheduler);
    summary.clearedSchedulerHistory = true;
  }

  if (clearStaffLog) {
    const entries = safeReadJSON(STAFF_LOG_FILE, []);
    const next = Array.isArray(entries)
      ? entries.filter((entry) => !(entry?.guildId === guildId && isRumorLogEntry(entry)))
      : [];
    summary.clearedStaffLogEntries = Array.isArray(entries) ? Math.max(0, entries.length - next.length) : 0;
    saveJSON(STAFF_LOG_FILE, next);
  }

  return summary;
}

export default { clearMaddenRumorState };
