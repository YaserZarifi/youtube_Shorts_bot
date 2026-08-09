import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl, escapeHtml, tgSetCommands } from "./telegram.js";
import { generateMetadata, validateAIMetadata } from "./ai.js";
import { uploadShort, getVideoStats, getAccessToken } from "./youtube.js";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download cap

const FILTER_WORDS = new Set([
  "درهوایت",
]);

const TITLE_SUFFIX = " #shorts #persian #فارسی";
const MAX_TITLE_LENGTH = 100;

// Single source of truth for the Telegram "/" command menu — edit this list
// and it propagates automatically (see ensureCommandsRegistered below), no
// manual BotFather step and no need to send /help after a deploy.
const BOT_COMMANDS = [
  { command: "queue", description: "See all queued videos and schedule" },
  { command: "logs", description: "See recent activity (/logs errors to filter)" },
  { command: "history", description: "Full timeline for one video by ID" },
  { command: "status", description: "Check bot health, capacity, and limits" },
  { command: "preview", description: "See full metadata for a queued video" },
  { command: "posted", description: "See the last 10 posted videos" },
  { command: "remove", description: "Delete one video from the queue" },
  { command: "postnow", description: "Upload a queued video immediately" },
  { command: "setschedule", description: "Set a custom date/time for a video" },
  { command: "resumequeue", description: "Resume queue after being paused" },
  { command: "clearqueue", description: "Wipe the entire queue" },
  { command: "help", description: "Show instructions" },
];

// Registers BOT_COMMANDS with Telegram only when the list has actually
// changed since last time (hash stored in KV), so this is safe to call on
// every webhook request without spamming the setMyCommands API.
async function ensureCommandsRegistered(env) {
  const desiredHash = String(hashStr(JSON.stringify(BOT_COMMANDS)));
  const storedHash = await env.STATE.get("botCommandsHash");
  if (storedHash === desiredHash) return;
  await tgSetCommands(env, BOT_COMMANDS);
  await env.STATE.put("botCommandsHash", desiredHash);
}

// Derive the posting schedule from wrangler.jsonc vars so editing config actually
// moves both /status and the scheduler. Slots are evenly spaced: the first atimport { generateMetadata, validateAIMetadata } from "./ai.js";

// POSTING_WINDOW_START_HOUR, each MIN_HOURS_BETWEEN_UPLOADS apart, MAX_UPLOADS_PER_DAY
// of them. Offsets are minutes-from-midnight and may exceed 1440 (past-midnight slots).
function getSchedule(env) {
  const perDay = Math.max(1, parseInt(env.MAX_UPLOADS_PER_DAY || "3", 10));
  const gapMin = Math.round(Math.max(0, parseFloat(env.MIN_HOURS_BETWEEN_UPLOADS || "4")) * 60);
  const startMin = Math.round(Math.max(0, parseFloat(env.POSTING_WINDOW_START_HOUR || "14")) * 60);
  const endHour = parseFloat(env.POSTING_WINDOW_END_HOUR ?? "23");
  const windowLenMin = (((Math.round(endHour * 60) - startMin) % 1440) + 1440) % 1440 || 1440;
  // Organic jitter up to 1h, but always shorter than the gap so windows never overlap.
  const jitterMin = Math.min(60, Math.max(0, gapMin - 15));
  const windows = [];
  for (let i = 0; i < perDay; i++) {
    const off = startMin + i * gapMin;
    windows.push({ startOffsetMin: off, endOffsetMin: off + jitterMin });
  }
  const lastOffset = (perDay - 1) * gapMin;
  return { uploadsPerDay: perDay, windows, startMin, gapMin, windowLenMin, fits: lastOffset <= windowLenMin };
}

function offsetToClock(offMin) {
  const m = (((Math.round(offMin) % 1440) + 1440) % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function cleanCaption(text = "") {
  let cleaned = text;

  // Remove Telegram usernames
  cleaned = cleaned.replace(/@[A-Za-z0-9_]{5,}/g, "");

  // Remove Telegram links
  cleaned = cleaned.replace(
    /https?:\/\/(?:t\.me|telegram\.me)\/\S+|(?:t\.me|telegram\.me)\/\S+/gi,
    ""
  );

  // Remove any remaining URLs
  cleaned = cleaned.replace(
    /https?:\/\/\S+|www\.\S+/gi,
    ""
  );

  // Remove unwanted words exactly
  for (const word of FILTER_WORDS) {
    cleaned = cleaned.split(word).join("");
  }

  // Normalize spaces
  cleaned = cleaned.replace(/[ \t]+/g, " ");

  // Normalize blank lines
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  cleaned = cleaned.trim();

  if (
    cleaned &&
    cleaned.length + TITLE_SUFFIX.length <= MAX_TITLE_LENGTH
  ) {
    cleaned += TITLE_SUFFIX;
  }

  return cleaned;
}

// Summarizes what cleanCaption() is about to strip, so the confirmation
// message can tell the user *why* their caption looks different, without
// changing cleanCaption()'s own return contract for its other callers.
function getCleanupSummary(text = "") {
  const parts = [];
  const usernames = (text.match(/@[A-Za-z0-9_]{5,}/g) || []).length;
  if (usernames) parts.push(`${usernames} username${usernames === 1 ? "" : "s"}`);

  const tgLinkRe = /https?:\/\/(?:t\.me|telegram\.me)\/\S+|(?:t\.me|telegram\.me)\/\S+/gi;
  const tgLinks = (text.match(tgLinkRe) || []).length;
  const withoutTgLinks = text.replace(tgLinkRe, "");
  const otherUrls = (withoutTgLinks.match(/https?:\/\/\S+|www\.\S+/gi) || []).length;
  const totalLinks = tgLinks + otherUrls;
  if (totalLinks) parts.push(`${totalLinks} link${totalLinks === 1 ? "" : "s"}`);

  let filteredWords = 0;
  for (const word of FILTER_WORDS) {
    filteredWords += text.split(word).length - 1;
  }
  if (filteredWords) parts.push(`${filteredWords} filtered word${filteredWords === 1 ? "" : "s"}`);

  return parts.length ? `🧹 Removed: ${parts.join(", ")}` : "";
}

function isAuthorized(env, userId) {
  const allowed = (env.MY_TELEGRAM_USER_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowed.includes(userId.toString());
}

async function getQueue(env) {
  const raw = await env.STATE.get("queue");
  return raw ? JSON.parse(raw) : [];
}

async function saveQueue(env, queue) {
  await env.STATE.put("queue", JSON.stringify(queue));
}

const EVENT_LOG_CAP = 200;

// Append a lifecycle event to the rolling `eventLog` array in KV (same
// capped-array pattern as `postedVideos`). Fire-and-forget: any failure in
// here is swallowed with console.error so logging can never throw or interrupt
// the bot operation it's recording. `meta` is optional small extra context.
async function logEvent(env, type, message, meta) {
  try {
    const raw = await env.STATE.get("eventLog");
    const log = raw ? JSON.parse(raw) : [];
    log.unshift({ type, message, meta: meta || undefined, timestamp: Date.now() });
    await env.STATE.put("eventLog", JSON.stringify(log.slice(0, EVENT_LOG_CAP)));
  } catch (err) {
    console.error("logEvent failed:", type, err.message);
  }
}

// Mint a permanent, human-readable ID for a freshly received video:
// VID-YYYYMMDD-NNNN, where the date is today in UTC (matching the ytcount:{today}
// convention) and NNNN is a per-day sequence starting at 0001. The counter lives
// in a single KV key per day (vidCounter:{YYYYMMDD}); this is a plain read-then-
// write, not an atomic increment — fine for a single-user bot with no realistic
// concurrent-intake race. Exactly one extra KV read + write per intake; no
// per-video keys. Across a UTC day boundary the day string changes, so the new
// day's counter is absent and naturally restarts at 0001. A short TTL lets stale
// day-counters self-clean — the minted VID itself is permanent, stored on the item.
async function nextVideoId(env) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // UTC YYYYMMDD
  const counterKey = `vidCounter:${day}`;
  const n = parseInt((await env.STATE.get(counterKey)) || "0", 10) + 1;
  await env.STATE.put(counterKey, String(n), { expirationTtl: 60 * 60 * 48 });
  return `VID-${day}-${String(n).padStart(4, "0")}`;
}

function dateKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function formatReadable(ms, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
}

function getTimeZoneOffsetMs(timeZone, ms) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(ms));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hour = map.hour === "24" ? "0" : map.hour;
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, hour, map.minute, map.second);
  return asUTC - ms;
}

function parseLocalDateTime(dateStr, timeStr, timeZone) {
  const [y, mo, d] = (dateStr || "").split("-").map(Number);
  const [h, mi] = (timeStr || "").split(":").map(Number);
  if (!y || !mo || !d || isNaN(h) || isNaN(mi)) return null;
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const offset = getTimeZoneOffsetMs(timeZone, guess);
    guess = Date.UTC(y, mo - 1, d, h, mi) - offset;
  }
  return guess;
}

const SLOT_GRID_MS = 15 * 60 * 1000; // 15-minute posting grid (matches the */15 cron)

function hashStr(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return hash;
}

// Absolute ms for a given local day + window index, snapped to the 15-min grid.
// Depends only on the day and window (not the video), so a slot is a stable
// anchor: whichever video fills it lands on the exact same time. Offsets are
// minutes from that day's midnight and may exceed 1440 (rolls into next day).
function slotTimeFor(schedule, dayMidnightMs, windowIndex) {
  const win = schedule.windows[windowIndex];
  const startMs = dayMidnightMs + win.startOffsetMin * 60000;
  const endMs = dayMidnightMs + win.endOffsetMin * 60000;
  const randomDec = Math.abs(Math.sin(hashStr(String(dayMidnightMs) + windowIndex) || 1));
  const raw = startMs + Math.floor(randomDec * (endMs - startMs));
  const snapped = Math.floor(raw / SLOT_GRID_MS) * SLOT_GRID_MS;
  return Math.max(startMs, snapped);
}

// The next `count` auto-slot times at or after `startMs`, skipping any 15-min
// bucket already taken by a blocked (manually scheduled) time.
function generateAutoSlots(env, startMs, count, blockedTimes = []) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const schedule = getSchedule(env);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const gapMs = schedule.gapMin * 60000;
  const taken = new Set(blockedTimes.map((t) => Math.floor(t / SLOT_GRID_MS)));
  const times = [];
  if (count <= 0) return times;

  // An auto slot must respect MIN_HOURS_BETWEEN_UPLOADS from every manually
  // pinned (blocked) time too, not just avoid landing in its exact bucket —
  // otherwise a /setschedule move can leave an auto video sitting minutes away.
  const tooCloseToBlocked = (t) => blockedTimes.some((b) => Math.abs(t - b) < gapMs);

  let dayStr = fmt.format(new Date(startMs));
  let dayMidnight = parseLocalDateTime(dayStr, "00:00", timeZone);

  for (let day = 0; day < 3700 && times.length < count; day++) { // ~10yr safety guard
    for (let w = 0; w < schedule.windows.length && times.length < count; w++) {
      const t = slotTimeFor(schedule, dayMidnight, w);
      if (t < startMs) continue;
      const bucket = Math.floor(t / SLOT_GRID_MS);
      if (taken.has(bucket)) continue;
      if (tooCloseToBlocked(t)) continue;
      taken.add(bucket);
      times.push(t);
    }
    dayMidnight += 24 * 60 * 60 * 1000;
    dayStr = fmt.format(new Date(dayMidnight));
    dayMidnight = parseLocalDateTime(dayStr, "00:00", timeZone);
  }
  return times;
}

// Assign each video a persisted scheduledAt: manual items keep theirs, auto items
// (in queue order) take the earliest free slots from now on. Then sort so array
// order matches time order (the cron always posts queue[0]). Mutates queue.
function repackQueue(env, queue) {
  const now = Date.now();

  for (const item of queue) {
    // migrate the old field name if present
    if (item.manualScheduledAt && !item.scheduledAt) {
      item.scheduledAt = item.manualScheduledAt;
      item.manual = true;
      delete item.manualScheduledAt;
    }
  }

  const isManual = (it) => it.manual && it.scheduledAt;
  const blocked = queue.filter(isManual).map((it) => it.scheduledAt);
  const autoItems = queue.filter((it) => !isManual(it));
  const slots = generateAutoSlots(env, now, autoItems.length, blocked);
  autoItems.forEach((it, i) => {
    it.scheduledAt = slots[i];
  });

  queue.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return queue;
}

function isQuotaError(message) {
  return /quota|dailyLimitExceeded|uploadLimitExceeded/i.test(message || "");
}

async function fetchWithRetry(url, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Start the intake flow for a freshly received video. Only the Telegram file
// pointer (fileId/fileUniqueId) goes into pending/draft state — the actual
// bytes are downloaded from Telegram at upload time, never stored in KV.
async function beginIntake(env, chatId, { fileId, fileUniqueId, caption, fileSize }) {
  const cleaned = cleanCaption(caption || "");
  const cleanupNote = getCleanupSummary(caption || "");
  const vid = await nextVideoId(env);
  await logEvent(env, "VIDEO_RECEIVED", "Video received", {
    vid,
    caption: cleaned ? cleaned.slice(0, 80) : undefined,
    chatId,
  });
  if (cleaned) {
    await env.STATE.put(
      `pending:${chatId}`,
      JSON.stringify({
        step: "awaiting_title_confirmation",
        vid,
        fileId,
        fileUniqueId,
        originalText: cleaned,
        fileSize: fileSize || 0,
      })
    );
    await tgSend(
      env,
      chatId,
      `📝 I found this caption:\n\n<b>${escapeHtml(cleaned)}</b>\n\n${cleanupNote ? escapeHtml(cleanupNote) + "\n\n" : ""}Use this as the video title?\n\nYou can edit it before continuing.`,
      {
        inline_keyboard: [
          [
            { text: "✅ Use this title", callback_data: "use_caption_title" },
            { text: "✏️ Edit title", callback_data: "edit_caption_title" },
          ],
          [{ text: "🚫 Cancel", callback_data: "cancel" }],
        ],
      }
    );
  } else {
    await env.STATE.put(
      `pending:${chatId}`,
      JSON.stringify({
        step: "awaiting_caption",
        vid,
        fileId,
        fileUniqueId,
        fileSize: fileSize || 0,
      })
    );
    await tgSend(env, chatId, "🎬 Got the video ✅\n\nPlease send me the video title/caption (or /cancel to abort).");
  }
}

// Get a queued video's bytes right before upload. New-format items carry a
// Telegram file pointer (item.fileId): file_ids can expire, so resolve a current
// download URL and fetch fresh at post time instead of persisting bytes in KV.
// Legacy items (queued before the pointer refactor) instead carry item.videoKey,
// with their bytes still sitting in KV under that key — read those directly.
// Throws on failure (missing pointer, expired file, or a videoKey blob that's
// gone) so callers route it into their fetch-failure handling.
async function fetchVideoBytes(env, item) {
  if (item.fileId) {
    const fileUrl = await tgGetFileUrl(env, item.fileId);
    const fileRes = await fetchWithRetry(fileUrl, 2);
    return fileRes.arrayBuffer();
  }
  if (item.videoKey) {
    const bytes = await env.STATE.get(item.videoKey, "arrayBuffer");
    if (!bytes) throw new Error(`legacy videoKey ${item.videoKey} not found in KV`);
    await logEvent(env, "SCHEMA_FALLBACK_USED", "Legacy videoKey fallback used", { vid: item.vid, title: item.title });
    return bytes;
  }
  throw new Error("queue item has neither fileId nor videoKey");
}

const QUEUE_PAGE_SIZE = 8;

// Render one page of the /queue list. Positions shown are the item's real
// queue position (global), not a per-page index, so /remove, /setschedule,
// /postnow and /preview keep working with the numbers the user sees.
function renderQueuePage(env, queue, page, pausedNote) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const totalPages = Math.max(1, Math.ceil(queue.length / QUEUE_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * QUEUE_PAGE_SIZE;
  const list = queue
    .slice(start, start + QUEUE_PAGE_SIZE)
    .map((q, i) => {
      const sizeMb = ((q.fileSize || (20 * 1024 * 1024)) / (1024 * 1024)).toFixed(1);
      const shortTitle = q.title.length > 40 ? q.title.substring(0, 37) + "..." : q.title;
      const timeStr = q.scheduledAt ? formatReadable(q.scheduledAt, timeZone) : "unscheduled";
      return `<b>${start + i + 1}.</b> ${escapeHtml(shortTitle)}\n   └ 🕒 ${timeStr} · 📁 ${sizeMb}MB`;
    })
    .join("\n\n");

  const row = [];
  if (safePage > 1) row.push({ text: "◀️ Prev", callback_data: `qp:${safePage - 1}` });
  if (safePage < totalPages) row.push({ text: "Next ▶️", callback_data: `qp:${safePage + 1}` });

  const text = `${pausedNote}📋 ${queue.length} video(s) queued (page ${safePage}/${totalPages}):\n\n${list}\n\nTo remove one, send: /remove (position number)\nTo clear everything: /clearqueue`;
  return { text, keyboard: { inline_keyboard: [row] } };
}

// Log lines are single short lines, so more fit per page than /queue items
// while staying well under Telegram's 4096-char message limit.
const LOGS_PAGE_SIZE = 15;

async function getEventLog(env) {
  const raw = await env.STATE.get("eventLog");
  return raw ? JSON.parse(raw) : [];
}

// Icon per event type — granular within three severity buckets so /logs reads
// at a glance: success (🎬/🤖/📝/✅/⏫/▶️), warning (⚠️/🗑️/⏸️/♻️), error (❌/🚫).
const EVENT_ICONS = {
  VIDEO_RECEIVED: "🎬",
  AI_STARTED: "🤖",
  DRAFT_CREATED: "📝",
  QUEUE_ADDED: "✅",
  UPLOAD_STARTED: "⏫",
  UPLOAD_SUCCESS: "✅",
  QUEUE_RESUMED: "▶️",
  VIDEO_REJECTED: "⚠️",
  QUEUE_REMOVED: "🗑️",
  QUEUE_PAUSED: "⏸️",
  SCHEMA_FALLBACK_USED: "♻️",
  AI_VALIDATION_WARNING: "🩺",
  AI_FAILED: "❌",
  UPLOAD_FAILED: "❌",
  QUOTA_EXCEEDED: "🚫",
};

// Severity bucket per type. Drives the /logs errors triage filter (warning+error).
const EVENT_SEVERITY = {
  VIDEO_RECEIVED: "success",
  AI_STARTED: "success",
  DRAFT_CREATED: "success",
  QUEUE_ADDED: "success",
  UPLOAD_STARTED: "success",
  UPLOAD_SUCCESS: "success",
  QUEUE_RESUMED: "success",
  VIDEO_REJECTED: "warning",
  QUEUE_REMOVED: "warning",
  QUEUE_PAUSED: "warning",
  SCHEMA_FALLBACK_USED: "warning",
  AI_VALIDATION_WARNING: "warning",
  AI_FAILED: "error",
  UPLOAD_FAILED: "error",
  QUOTA_EXCEEDED: "error",
};

const isErrorishEvent = (ev) => EVENT_SEVERITY[ev.type] === "warning" || EVENT_SEVERITY[ev.type] === "error";

// Best-known lifecycle status for a video, keyed by an event type. Used by
// /history's no-arg index and each timeline's header to say where a video is.
const VID_STATUS = {
  VIDEO_RECEIVED: "received",
  VIDEO_REJECTED: "rejected",
  AI_STARTED: "processing",
  AI_FAILED: "AI failed",
  DRAFT_CREATED: "drafted",
  QUEUE_ADDED: "queued",
  QUEUE_REMOVED: "removed",
  UPLOAD_STARTED: "uploading",
  SCHEMA_FALLBACK_USED: "uploading",
  UPLOAD_SUCCESS: "posted",
  UPLOAD_FAILED: "upload failed",
};

// Turn an event's small meta into a short trailing detail, HTML-escaped since
// the message is sent with HTML parse mode. Titles/captions are clipped.
function eventDetail(ev) {
  const m = ev.meta || {};
  const clip = (s) => (String(s).length > 40 ? String(s).slice(0, 37) + "..." : String(s));
  if (m.warnings && m.warnings.length) {
    const more = m.warnings.length > 1 ? ` (+${m.warnings.length - 1} more)` : "";
    return ` — "${escapeHtml(clip(m.title || ""))}": ${escapeHtml(clip(m.warnings[0]))}${more}`;
  }
  if (m.title) return ` — "${escapeHtml(clip(m.title))}"` + (m.error ? ` (${escapeHtml(m.error)})` : "");
  if (m.error) return ` (${escapeHtml(m.error)})`;
  if (m.reason) return ` — ${escapeHtml(m.reason)}`;
  if (m.caption) return ` — "${escapeHtml(clip(m.caption))}"`;
  if (typeof m.count === "number") return ` — ${m.count} item(s)`;
  if (m.via) return ` (${escapeHtml(m.via)})`;
  return "";
}

// One rendered event line: "time icon message — detail". Shared by /logs and
// /history so both use the exact same time/icon/detail convention.
function formatEventLine(ev, timeZone) {
  const icon = EVENT_ICONS[ev.type] || "•";
  return `${escapeHtml(formatReadable(ev.timestamp, timeZone))} ${icon} ${escapeHtml(ev.message)}${eventDetail(ev)}`;
}

// Render one page of /logs, mirroring renderQueuePage exactly (same pagination
// math, same button shape). `filter` is "errors" or "all"; the errors filter is
// carried across pages via an ":e" segment on the lp: callback so paging stays
// within the filtered view.
function renderLogsPage(env, entries, page, filter) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const totalPages = Math.max(1, Math.ceil(entries.length / LOGS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * LOGS_PAGE_SIZE;
  const filterSeg = filter === "errors" ? ":e" : "";
  const list = entries
    .slice(start, start + LOGS_PAGE_SIZE)
    .map((ev) => formatEventLine(ev, timeZone))
    .join("\n");

  const row = [];
  if (safePage > 1) row.push({ text: "◀️ Prev", callback_data: `lp:${safePage - 1}${filterSeg}` });
  if (safePage < totalPages) row.push({ text: "Next ▶️", callback_data: `lp:${safePage + 1}${filterSeg}` });

  const header = filter === "errors"
    ? `🧾 ${entries.length} warning/error event(s) (page ${safePage}/${totalPages}):`
    : `🧾 ${entries.length} event(s) logged (page ${safePage}/${totalPages}):`;
  const text = `${header}\n\n${list}`;
  return { text, keyboard: { inline_keyboard: [row] } };
}

// Resolve a /history argument to a concrete VID. Accepts a full
// "VID-YYYYMMDD-NNNN" (case-insensitive) returned as-is, or a bare numeric
// suffix ("42", "0042") matched against the most recent VID in the log with
// that sequence number. `log` is newest-first, so the first match is newest.
// Returns null if a suffix query matches nothing.
function resolveVid(log, arg) {
  const raw = (arg || "").trim();
  if (/^VID-\d{8}-\d{4}$/i.test(raw)) return raw.toUpperCase();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const suffix = `-${digits.padStart(4, "0")}`;
  for (const ev of log) {
    const v = ev.meta && ev.meta.vid;
    if (v && v.endsWith(suffix)) return v;
  }
  return null;
}

// Full chronological timeline for one VID (oldest-first — a timeline reads
// better top-to-bottom in intake order, unlike newest-first /logs). Reuses the
// same per-event line format as /logs. Returns null if no events match (aged
// out of the capped log, or a typo'd ID). A YouTube link line is appended only
// when an UPLOAD_SUCCESS event for this VID actually carries a videoId.
function renderHistoryTimeline(env, log, vid) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const events = log.filter((ev) => ev.meta && ev.meta.vid === vid).reverse();
  if (events.length === 0) return null;
  const latest = events[events.length - 1];
  const status = VID_STATUS[latest.type] || "seen";
  const lines = events.map((ev) => formatEventLine(ev, timeZone)).join("\n");
  const success = events.find((ev) => ev.type === "UPLOAD_SUCCESS" && ev.meta && ev.meta.videoId);
  const linkLine = success ? `\n\n🔗 https://youtu.be/${escapeHtml(success.meta.videoId)}` : "";
  return `🎬 <b>${escapeHtml(vid)}</b> — ${escapeHtml(status)}\n\n${lines}${linkLine}`;
}

// No-argument /history: a lookup index of the most recent 10 distinct VIDs seen
// in the event log, each with its current best-known status (inferred from that
// VID's most recent event). Scans the already-fetched eventLog — no extra KV
// key tracking "all VIDs". Returns null if the log has no VID-tagged events.
function renderHistoryIndex(env, log) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const seen = new Map(); // vid -> its most recent event (log is newest-first)
  for (const ev of log) {
    const v = ev.meta && ev.meta.vid;
    if (v && !seen.has(v)) seen.set(v, ev);
    if (seen.size >= 10) break;
  }
  if (seen.size === 0) return null;
  const lines = [];
  for (const [vid, ev] of seen) {
    const status = VID_STATUS[ev.type] || "seen";
    const icon = EVENT_ICONS[ev.type] || "•";
    lines.push(`${icon} <b>${escapeHtml(vid)}</b> — ${escapeHtml(status)} · ${escapeHtml(formatReadable(ev.timestamp, timeZone))}`);
  }
  return `🎬 <b>Recent videos</b> (last ${seen.size}):\n\n${lines.join("\n")}\n\nSend <code>/history &lt;id&gt;</code> for a full timeline (e.g. <code>/history ${escapeHtml([...seen.keys()][0].slice(-4))}</code>).`;
}

async function sendWeeklyDigest(env) {
  const notifyId = (env.MY_TELEGRAM_USER_ID || "").split(",")[0].trim();
  if (!notifyId) return;

  const postedRaw = await env.STATE.get("postedVideos");
  const posted = postedRaw ? JSON.parse(postedRaw) : [];
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentWeek = posted.filter((p) => p.uploadedAt >= weekAgo);

  if (recentWeek.length === 0) {
    await tgSend(env, notifyId, "📊 <b>Weekly Digest</b>\n\nNo videos posted this week.");
    return;
  }

  const stats = await getVideoStats(env, recentWeek.map((p) => p.id));
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  let totalViews = 0;
  const list = recentWeek
    .map((p, i) => {
      const views = parseInt(stats[p.id]?.viewCount ?? "0", 10);
      totalViews += views;
      return `${i + 1}. ${escapeHtml(p.title)}\n   👁️ ${views} views · 🕒 ${formatReadable(p.uploadedAt, timeZone)}`;
    })
    .join("\n\n");

  await tgSend(env, notifyId, `📊 <b>Weekly Digest</b>\n\n${recentWeek.length} video(s) posted this week · ${totalViews} total views\n\n${list}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("ok");
    if (url.pathname !== "/webhook") return new Response("not found", { status: 404 });

    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    try {
      await ensureCommandsRegistered(env);
    } catch (err) {
      console.error("ensureCommandsRegistered failed:", err.message);
    }

    const update = await request.json();
    try {
      if (update.message) await handleMessage(update.message, env);
      if (update.callback_query) await handleCallback(update.callback_query, env);
    } catch (err) {
      console.error(err);
    }
    return new Response("ok");
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "0 9 * * 5") {
      ctx.waitUntil(sendWeeklyDigest(env));
    } else {
      ctx.waitUntil(processQueueTick(env));
    }
  },
};

async function processQueueTick(env) {
  const paused = await env.STATE.get("queuePaused");
  if (paused) {
    const lastUploadAt = parseInt((await env.STATE.get("lastUploadAt")) || "0", 10);
    const hoursSinceLastUpload = lastUploadAt ? (Date.now() - lastUploadAt) / (1000 * 60 * 60) : 0;
    if (lastUploadAt && hoursSinceLastUpload >= 24) {
      await env.STATE.delete("queuePaused");
      await logEvent(env, "QUEUE_RESUMED", "Queue auto-resumed after 24h", { via: "automatic" });
      const notifyId = (env.MY_TELEGRAM_USER_ID || "").split(",")[0].trim();
      if (notifyId) {
        await tgSend(env, notifyId, `▶️ Queue auto-resumed — it's been 24h since your last upload, so quota should have reset. I'll try the next video on the next hourly check.`);
      }
    } else {
      console.log("Queue is paused:", paused);
      return;
    }
  }

  const queue = await getQueue(env);
  if (queue.length === 0) {
    console.log("Queue empty, nothing to post.");
    return;
  }

  // Assign times to any legacy items that predate persisted scheduling.
  if (queue.some((q) => !q.scheduledAt)) {
    repackQueue(env, queue);
    await saveQueue(env, queue);
  }

  const item = queue[0];

  if (Date.now() < item.scheduledAt) {
    console.log("Not time to post yet.");
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `ytcount:${today}`;
  const count = parseInt((await env.STATE.get(countKey)) || "0", 10);

  // Fetch the video bytes fresh from Telegram right before uploading. If the
  // original file is gone (expired file_id, deleted message), this is a
  // distinct, unrecoverable failure — handle it separately from upload errors.
  let videoBytes;
  try {
    videoBytes = await fetchVideoBytes(env, item);
  } catch (err) {
    console.error("Telegram fetch failed for queued item:", item.id, err.message);
    item.fetchFailCount = (item.fetchFailCount || 0) + 1;
    if (item.fetchFailCount >= 2) {
      queue.shift();
      repackQueue(env, queue);
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `🗑️ Dropped "${escapeHtml(item.title)}" — the original video is no longer available on Telegram (the file expired or the message was deleted), so it can't be uploaded. Please resend it if you still want it posted.`
      );
    } else {
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `⚠️ Couldn't fetch "${escapeHtml(item.title)}" from Telegram (attempt ${item.fetchFailCount}/2). Will retry next cycle — if it keeps failing, the original video is probably gone.`
      );
    }
    return;
  }

  try {
    await logEvent(env, "UPLOAD_STARTED", "Upload started", { vid: item.vid, title: item.title });
    const videoId = await uploadShort(env, videoBytes, {
      title: item.title,
      description: item.description,
      tags: item.hashtags,
    });

    queue.shift();
    repackQueue(env, queue);
    await saveQueue(env, queue);
    // Legacy items stored their bytes in KV under videoKey; free that blob now
    // that it's posted. New-format items never persisted bytes, so skip this.
    if (item.videoKey) await env.STATE.delete(item.videoKey);
    await env.STATE.put(countKey, (count + 1).toString(), { expirationTtl: 60 * 60 * 26 });
    await env.STATE.put("lastUploadAt", Date.now().toString());

    const postedRaw = await env.STATE.get("postedVideos");
    const posted = postedRaw ? JSON.parse(postedRaw) : [];
    posted.unshift({ id: videoId, vid: item.vid, title: item.title, uploadedAt: Date.now() });
    await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

    await logEvent(env, "UPLOAD_SUCCESS", "Video uploaded to queue", { vid: item.vid, title: item.title, videoId });
    await tgSend(env, item.chatId, `✅ Queued video is live: https://youtu.be/${videoId}\n📋 ${queue.length} left in queue.`);
  } catch (err) {
    console.error("Queued upload failed:", err.message);

    if (isQuotaError(err.message)) {
      await env.STATE.put("queuePaused", "YouTube daily quota exceeded");
      await logEvent(env, "QUOTA_EXCEEDED", "YouTube daily quota exceeded", { title: item.title });
      await logEvent(env, "QUEUE_PAUSED", "Queue paused", { reason: "YouTube daily quota exceeded" });
      await tgSend(
        env,
        item.chatId,
        `🚫 YouTube upload quota exceeded. The queue is now PAUSED.\n\nIt'll auto-resume 24h after your last successful upload, or send /resumequeue to override manually.`
      );
      return;
    }

    item.failCount = (item.failCount || 0) + 1;
    await logEvent(env, "UPLOAD_FAILED", "Upload failed", { vid: item.vid, title: item.title, error: err.message });
    if (item.failCount >= 2) {
      // Drop its slot and re-queue as an auto item so it gets the latest slot,
      // freeing the front for videos behind it instead of blocking them.
      queue.shift();
      item.manual = false;
      item.scheduledAt = undefined;
      queue.push(item);
      repackQueue(env, queue);
      await saveQueue(env, queue);
      const newPos = queue.findIndex((q) => q.id === item.id) + 1;
      await tgSend(
        env,
        item.chatId,
        `❌ Upload failed twice for "${item.title}": ${err.message}\n↩️ Moved to the back of the queue (position ${newPos}) so it doesn't block other videos. I'll retry it again later.`
      );
    } else {
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `❌ Scheduled upload failed for "${item.title}" (attempt ${item.failCount}/2): ${err.message}\nWill retry next cycle.`
      );
    }
  }
}

// Re-run AI metadata generation for a draft (new or existing), stacking any
// newly given guidance on top of whatever guidance was already collected
// from earlier regenerations, then persist the updated draft and send the
// refreshed preview with Accept / Use-my-text / Regenerate buttons. Shared
// by the very first generation, the explicit "generate_ai" choice, and every
// subsequent /regenerate tap — so there is exactly one preview format.
async function regenerateAndSendPreview(env, chatId, draft, newGuidance) {
  const extraGuidance = newGuidance
    ? [...(draft.extraGuidance || []), newGuidance]
    : (draft.extraGuidance || []);

  // Progress placeholder: edited in place once the AI call resolves, so the
  // user sees "Generating..." replaced by the real result instead of a
  // silent gap while env.AI.run() executes.
  const progress = await tgSend(env, chatId, "🤖 Generating title, description and hashtags...");
  const progressMsgId = progress?.result?.message_id;

  await logEvent(env, "AI_STARTED", "AI metadata generation started", { vid: draft.vid, guidanceCount: extraGuidance.length });
  let meta;
  try {
    meta = await generateMetadata(env, draft.originalText, extraGuidance);
  } catch (err) {
    await logEvent(env, "AI_FAILED", "AI metadata generation failed", { vid: draft.vid, error: err.message });
    if (progressMsgId) {
      await tgEditMessage(env, chatId, progressMsgId, "❌ AI generation failed. Please try again or use your original text.");
    }
    throw err;
  }

  const aiWarnings = validateAIMetadata(meta);
  if (aiWarnings.length) {
    await logEvent(env, "AI_VALIDATION_WARNING", "AI output flagged for review", { vid: draft.vid, title: meta.title, warnings: aiWarnings });
  }

  const updatedDraft = { ...draft, ...meta, extraGuidance };
  await env.STATE.put(`draft:${chatId}`, JSON.stringify(updatedDraft));
  await logEvent(env, "DRAFT_CREATED", "Draft created", { vid: draft.vid, title: meta.title, guidanceCount: extraGuidance.length });
  await env.STATE.put(`pending:${chatId}`, JSON.stringify({ step: "awaiting_confirmation" }));

  const hashtags = meta.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  const warningsBanner = aiWarnings.length ? `⚠️ <b>Review before accepting:</b>\n${aiWarnings.map((w) => `• ${escapeHtml(w)}`).join("\n")}\n\n` : "";
  const guidanceNote = extraGuidance.length ? `\n\n<i>Applied ${extraGuidance.length} regeneration instruction${extraGuidance.length === 1 ? "" : "s"}.</i>` : "";
  const preview = `${warningsBanner}<b>Title:</b> ${escapeHtml(meta.title)}\n\n<b>Description:</b>\n${escapeHtml(meta.description)}\n\n<b>Hashtags:</b> ${escapeHtml(hashtags)}${guidanceNote}`;

  const previewKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Accept AI version", callback_data: "accept" },
        { text: "📝 Use my text as title only", callback_data: "original" },
      ],
      [{ text: "🔄 Regenerate", callback_data: "regenerate" }],
      [{ text: "🚫 Cancel", callback_data: "cancel" }],
    ],
  };

  if (progressMsgId) {
    await tgEditMessage(env, chatId, progressMsgId, preview, previewKeyboard);
  } else {
    await tgSend(env, chatId, preview, previewKeyboard);
  }
}


async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();

  if (!isAuthorized(env, userId)) {
    await tgSend(env, chatId, "This bot is private.");
    return;
  }

  if (message.text === "/cancel") {
    await env.STATE.delete(`pending:${chatId}`);
    await env.STATE.delete(`draft:${chatId}`);
    await tgSend(env, chatId, "🚫 Cancelled. Send a new video whenever you're ready.");
    return;
  }

  const media = message.video || message.document;

  if (media) {
    const queue = await getQueue(env);

    if (media.file_size && media.file_size > MAX_BYTES) {
      await logEvent(env, "VIDEO_REJECTED", "Video rejected", {
        reason: `over 20MB limit (${(media.file_size / 1024 / 1024).toFixed(1)}MB)`,
      });
      await tgSend(
        env,
        chatId,
        `⚠️ That file is ${(media.file_size / 1024 / 1024).toFixed(1)}MB — over the 20MB limit Telegram bots can download. Please compress it and resend.`
      );
      return; // rejected, nothing downloaded
    }

    // Dedupe against the current queue only (no extra KV reads). file_unique_id
    // is stable per underlying file, so a repeat submission is easy to catch.
    const dup = queue.find((q) => q.fileUniqueId && q.fileUniqueId === media.file_unique_id);
    if (dup) {
      await env.STATE.put(
        `pending:${chatId}`,
        JSON.stringify({
          step: "awaiting_dupe_confirmation",
          fileId: media.file_id,
          fileUniqueId: media.file_unique_id,
          caption: message.caption || "",
          fileSize: media.file_size || 0,
        }),
        { expirationTtl: 60 * 30 }
      );
      await tgSend(
        env,
        chatId,
        `⚠️ This looks like a video already in the queue ("${escapeHtml(dup.title)}"). Queue it again anyway?`,
        {
          inline_keyboard: [
            [
              { text: "✅ Yes, queue it again", callback_data: "dupe_confirm" },
              { text: "❌ No, cancel", callback_data: "dupe_cancel" },
            ],
          ],
        }
      );
      return;
    }

    await beginIntake(env, chatId, {
      fileId: media.file_id,
      fileUniqueId: media.file_unique_id,
      caption: message.caption || "",
      fileSize: media.file_size || 0,
    });
    return;
  }

  if (message.text === "/help" || message.text === "/start") {
    const helpSchedule = getSchedule(env);
    const helpText = `🤖 <b>Reels → YouTube Bot</b>

<b>Uploading a video:</b>
Just send a video (under 20MB). I'll ask what it's about, generate a Persian title/description/hashtags with AI, and let you accept or use your own text as the title. It then goes into the upload queue.

<b>Queue commands:</b>
/queue — see all queued videos with their scheduled date & time
/postnow (position) — upload a specific queued video immediately, bypassing the schedule (e.g. /postnow 2)
/setschedule (position) YYYY-MM-DD HH:MM — set a custom date/time for a queued video (e.g. /setschedule 2 2026-08-05 18:30). If it's too close to another upload, I'll adjust it automatically.
/defaultschedule — clear all manual /setschedule pins and reset the whole queue back to the default auto-schedule, in original order.
/remove (position) — delete one video from the queue (e.g. /remove 1)
/clearqueue — wipe the entire queue
/resumequeue — resume the queue after it's been auto-paused (e.g. YouTube quota exceeded)
/status — detailed health check (queue, uploads, config, KV, token)
/preview (position) — see full title/description/hashtags for a queued video, with edit buttons

<b>History:</b>
/posted — see the last 10 videos actually posted to YouTube, with live view counts
/logs — see recent bot activity (received, AI, uploads, pauses…). /logs errors shows only warnings & errors. Paginate with /logs 2 or the buttons.
/history (id) — full timeline for one video by its ID (e.g. /history VID-20260809-0001, or just /history 0001). No ID shows a list of recent videos.

<b>How scheduling works:</b>
Videos auto-post at most ${helpSchedule.uploadsPerDay} per day, each locked to a fixed time slot (shown in /queue) that never drifts. If you /postnow or /remove a video, the ones behind it move UP to fill the freed slots — nobody's time slides later. Use /setschedule to pin a video to your own time. There's no queue limit — the queue stores lightweight Telegram pointers, so videos can wait as long as needed.

<b>Access:</b>
This bot only responds to your authorized Telegram accounts.

/help — show this message again`;

    await tgSend(env, chatId, helpText);

    await tgSetCommands(env, BOT_COMMANDS);
    return;
  }

  if (message.text?.startsWith("/queue")) {
    const paused = await env.STATE.get("queuePaused");
    const pausedNote = paused ? `⏸️ Queue is currently PAUSED (${paused}). Auto-resumes 24h after your last upload, or send /resumequeue now.\n\n` : "";
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgSend(env, chatId, `${pausedNote}📋 Queue is empty.`);
      return;
    }
    // Assign times to any legacy items that predate persisted scheduling.
    if (queue.some((q) => !q.scheduledAt)) {
      repackQueue(env, queue);
      await saveQueue(env, queue);
    }
    const parts = message.text.trim().split(/\s+/);
    const pageArg = parseInt(parts[1], 10);
    const page = isNaN(pageArg) || pageArg < 1 ? 1 : pageArg;
    const { text, keyboard } = renderQueuePage(env, queue, page, pausedNote);
    await tgSend(env, chatId, text, keyboard.inline_keyboard[0].length ? keyboard : undefined);
    return;
  }

  if (message.text?.startsWith("/logs")) {
    const parts = message.text.trim().split(/\s+/);
    const filter = parts[1] === "errors" ? "errors" : "all";
    // Page arg is parts[2] for "/logs errors 2", else parts[1] for "/logs 2".
    const pageArg = parseInt(filter === "errors" ? parts[2] : parts[1], 10);
    const page = isNaN(pageArg) || pageArg < 1 ? 1 : pageArg;

    const all = await getEventLog(env);
    const entries = filter === "errors" ? all.filter(isErrorishEvent) : all;
    if (entries.length === 0) {
      await tgSend(env, chatId, filter === "errors" ? "🧾 No warnings or errors logged yet." : "🧾 No events logged yet.");
      return;
    }
    const { text, keyboard } = renderLogsPage(env, entries, page, filter);
    await tgSend(env, chatId, text, keyboard.inline_keyboard[0].length ? keyboard : undefined);
    return;
  }

  if (message.text?.startsWith("/history")) {
    const parts = message.text.trim().split(/\s+/);
    const arg = parts[1];
    const log = await getEventLog(env);

    if (!arg) {
      const text = renderHistoryIndex(env, log);
      await tgSend(env, chatId, text || "🎬 No videos tracked yet. Send a video and it'll be assigned an ID like <b>VID-20260809-0001</b>.");
      return;
    }

    const vid = resolveVid(log, arg);
    const text = vid ? renderHistoryTimeline(env, log, vid) : null;
    if (!text) {
      await tgSend(env, chatId, `🔍 No history found for "<b>${escapeHtml(arg)}</b>". It might be a typo, or the video may be old enough to have aged out of the log. Send /history to see recent video IDs.`);
      return;
    }
    await tgSend(env, chatId, text);
    return;
  }

  if (message.text?.startsWith("/setschedule")) {
    const parts = message.text.trim().split(/\s+/);
    const index = parseInt(parts[1], 10) - 1;
    const dateStr = parts[2];
    const timeStr = parts[3];
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";

    const queue = await getQueue(env);
    if (isNaN(index) || index < 0 || index >= queue.length) {
      await tgSend(env, chatId, "⚠️ Give a valid queue position. Send /queue to see positions.");
      return;
    }
    if (!dateStr || !timeStr) {
      await tgSend(env, chatId, "⚠️ Usage: /setschedule (position) YYYY-MM-DD HH:MM\nExample: /setschedule 2 2026-08-05 18:30");
      return;
    }

    const targetMs = parseLocalDateTime(dateStr, timeStr, timeZone);
    if (!targetMs || isNaN(targetMs)) {
      await tgSend(env, chatId, "⚠️ Couldn't parse that. Use format: YYYY-MM-DD HH:MM (24-hour)");
      return;
    }
    if (targetMs < Date.now()) {
      await tgSend(env, chatId, "⚠️ That time is in the past. Pick a future date/time.");
      return;
    }

    const item = queue[index];
    // Snap up to the next 15-min grid tick so the shown time is exactly when it posts.
    item.manual = true;
    item.scheduledAt = Math.ceil(targetMs / SLOT_GRID_MS) * SLOT_GRID_MS;
    delete item.manualScheduledAt;
    repackQueue(env, queue);
    await saveQueue(env, queue);

    const actualTime = item.scheduledAt;
    const adjustedNote =
      Math.abs(actualTime - targetMs) > 60000
        ? `\n\n⚠️ Adjusted to the nearest 15-minute slot — it'll go out at ${formatReadable(actualTime, timeZone)}.`
        : "";

    await tgSend(
      env,
      chatId,
      `🗓️ Requested time for "${escapeHtml(item.title)}": ${formatReadable(targetMs, timeZone)}.${adjustedNote}\n\nSend /queue to see the full updated schedule.`
    );
    return;
  }

  if (message.text === "/defaultschedule") {
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgSend(env, chatId, "📭 Queue is empty — nothing to reset.");
      return;
    }

    // Drop every manual pin (/setschedule override) and restore original
    // intake order via the vid (VID-YYYYMMDD-NNNN sorts chronologically by
    // when each video was received), then let repackQueue auto-slot everyone
    // from scratch, exactly as if no /setschedule had ever been used.
    let pinnedCount = 0;
    for (const item of queue) {
      if (item.manual) pinnedCount++;
      delete item.manual;
      delete item.manualScheduledAt;
    }
    queue.sort((a, b) => (a.vid || "").localeCompare(b.vid || ""));
    repackQueue(env, queue);
    await saveQueue(env, queue);

    await logEvent(env, "SCHEDULE_RESET", "All videos reset to default auto-schedule", { pinnedCount, total: queue.length });
    await tgSend(
      env,
      chatId,
      `🔄 Reset ${queue.length} video(s) to the default auto-schedule${pinnedCount ? ` (cleared ${pinnedCount} manual pin${pinnedCount === 1 ? "" : "s"})` : ""}.\n\nSend /queue to see the updated schedule.`
    );
    return;
  }

  if (message.text === "/posted") {
    const postedRaw = await env.STATE.get("postedVideos");
    const posted = postedRaw ? JSON.parse(postedRaw) : [];
    if (posted.length === 0) {
      await tgSend(env, chatId, "📭 No videos posted yet.");
      return;
    }
    const recent = posted.slice(0, 10);
    const stats = await getVideoStats(env, recent.map((p) => p.id));
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";
    const list = recent
      .map((p, i) => {
        const views = stats[p.id]?.viewCount ?? "?";
        return `${i + 1}. ${escapeHtml(p.title)}\n   👁️ ${views} views · 🕒 ${formatReadable(p.uploadedAt, timeZone)}\n   🔗 https://youtu.be/${p.id}`;
      })
      .join("\n\n");
    await tgSend(env, chatId, `📼 Last ${recent.length} posted video(s):\n\n${list}`);
    return;
  }

  if (message.text?.startsWith("/postnow")) {
    const parts = message.text.trim().split(/\s+/);
    const index = parseInt(parts[1], 10) - 1;

    const queue = await getQueue(env);
    if (isNaN(index) || index < 0 || index >= queue.length) {
      await tgSend(env, chatId, "⚠️ Give a valid queue position. Send /queue to see positions.");
      return;
    }

    const item = queue[index];

    await tgSend(env, chatId, `⏫ Posting "${escapeHtml(item.title)}" now...`);

    let videoBytes;
    try {
      videoBytes = await fetchVideoBytes(env, item);
    } catch (err) {
      console.error("Telegram fetch failed for /postnow:", item.id, err.message);
      await tgSend(
        env,
        chatId,
        `❌ Couldn't fetch "${escapeHtml(item.title)}" from Telegram — the original video may be gone (file expired or message deleted). It's still in the queue; resend the video if it's no longer recoverable.`
      );
      return;
    }

    try {
      await logEvent(env, "UPLOAD_STARTED", "Upload started", { vid: item.vid, title: item.title });
      const videoId = await uploadShort(env, videoBytes, {
        title: item.title,
        description: item.description,
        tags: item.hashtags,
      });

      queue.splice(index, 1);
      repackQueue(env, queue);
      await saveQueue(env, queue);
      // Legacy items stored their bytes in KV under videoKey; free that blob now
      // that it's posted. New-format items never persisted bytes, so skip this.
      if (item.videoKey) await env.STATE.delete(item.videoKey);

      const today = new Date().toISOString().slice(0, 10);
      const countKey = `ytcount:${today}`;
      const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
      await env.STATE.put(countKey, (count + 1).toString(), { expirationTtl: 60 * 60 * 26 });
      await env.STATE.put("lastUploadAt", Date.now().toString());

      const postedRaw = await env.STATE.get("postedVideos");
      const posted = postedRaw ? JSON.parse(postedRaw) : [];
      posted.unshift({ id: videoId, vid: item.vid, title: item.title, uploadedAt: Date.now() });
      await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

      await logEvent(env, "UPLOAD_SUCCESS", "Video posted via /postnow", { vid: item.vid, title: item.title, videoId });
      await tgSend(env, chatId, `✅ Live now: https://youtu.be/${videoId}\n📋 ${queue.length} left in queue.`);
    } catch (err) {
      console.error("Manual /postnow upload failed:", err.message);
      // Behavior unchanged: /postnow never auto-pauses. Just record the right
      // event type — quota errors get QUOTA_EXCEEDED, everything else FAILED.
      if (isQuotaError(err.message)) {
        await logEvent(env, "QUOTA_EXCEEDED", "YouTube daily quota exceeded", { title: item.title });
      } else {
        await logEvent(env, "UPLOAD_FAILED", "Upload failed via /postnow", { vid: item.vid, title: item.title, error: err.message });
      }
      await tgSend(env, chatId, `❌ Upload failed: ${err.message}\nIt's still in the queue — nothing was removed.`);
    }
    return;
  }

  if (message.text?.startsWith("/remove")) {
    const parts = message.text.trim().split(/\s+/);
    const index = parseInt(parts[1], 10) - 1;
    const queue = await getQueue(env);

    if (isNaN(index) || index < 0 || index >= queue.length) {
      await tgSend(env, chatId, `⚠️ Give a valid number. Send /queue to see positions.`);
      return;
    }

    const item = queue[index];
    await tgSend(
      env,
      chatId,
      `⚠️ Remove "${escapeHtml(item.title)}" (position ${index + 1}) from the queue? This can't be undone.`,
      {
        inline_keyboard: [[
          { text: "🗑️ Yes, remove it", callback_data: `rm:${index + 1}:y` },
          { text: "❌ Cancel", callback_data: `rm:${index + 1}:n` },
        ]],
      }
    );
    return;
  }

  if (message.text === "/clearqueue") {
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgSend(env, chatId, "Queue is already empty.");
      return;
    }
    await tgSend(
      env,
      chatId,
      `⚠️ This will permanently remove ${queue.length} queued video(s). This can't be undone. Are you sure?`,
      {
        inline_keyboard: [[
          { text: "🗑️ Yes, clear everything", callback_data: "cq:y" },
          { text: "❌ Cancel", callback_data: "cq:n" },
        ]],
      }
    );
    return;
  }

  if (message.text === "/resumequeue") {
    await env.STATE.delete("queuePaused");
    await logEvent(env, "QUEUE_RESUMED", "Queue resumed", { via: "manual" });
    await tgSend(env, chatId, "▶️ Queue resumed. It'll try uploading again on the next hourly check.");
    return;
  }

  if (message.text === "/status") {
    const paused = await env.STATE.get("queuePaused");
    const queue = await getQueue(env);
    const today = new Date().toISOString().slice(0, 10);
    const countKey = `ytcount:${today}`;
    const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
    const schedule = getSchedule(env);
    const maxPerDay = schedule.uploadsPerDay;
    const lastUploadAt = parseInt((await env.STATE.get("lastUploadAt")) || "0", 10);
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";

    let tokenStatus = "✅ OK";
    try {
      await getAccessToken(env);
    } catch (err) {
      tokenStatus = `❌ ${err.message}`;
    }

    const postedRaw = await env.STATE.get("postedVideos");
    const postedCount = postedRaw ? JSON.parse(postedRaw).length : 0;

    // Where the next auto video would land (no cap anymore — pointers don't expire).
    const autoCount = queue.filter((it) => !(it.manual && it.scheduledAt)).length;
    const blockedTimes = queue.filter((it) => it.manual && it.scheduledAt).map((it) => it.scheduledAt);
    const projectedSlots = generateAutoSlots(env, Date.now(), autoCount + 1, blockedTimes);
    const nextSlot = projectedSlots[projectedSlots.length - 1];
    const lastQueued = queue.length ? queue[queue.length - 1].scheduledAt : null;
    // Front of the queue = the actual next video to post (queue is stored sorted
    // by scheduledAt). Distinct from nextSlot, which is where a brand-new video
    // added right now would land (behind everything already queued).
    const nextUp = queue.length ? queue[0].scheduledAt : null;

    // The "~" times are the earliest end of each window; the real slot jitters later.
    const slotTimes = schedule.windows.map((w) => offsetToClock(w.startOffsetMin)).join(", ");
    const gapHrs = (schedule.gapMin / 60).toFixed(schedule.gapMin % 60 ? 1 : 0);
    const fitNote = schedule.fits ? "" : `\n⚠️ These slots span more than the posting window — later slots roll past ${offsetToClock(schedule.startMin + schedule.windowLenMin)} into the next window.`;

    const statusText = `📊 <b>Bot Status</b>

📋 Queue: <b>${queue.length}</b> video(s)
📅 Today's uploads: <b>${count}/${maxPerDay}</b>
🕒 Last upload: ${lastUploadAt ? formatReadable(lastUploadAt, timeZone) : "never"}
📤 Next video will post: ${nextUp ? formatReadable(nextUp, timeZone) : "—"}
🗓️ Queue posts through: ${lastQueued ? formatReadable(lastQueued, timeZone) : "—"}
⏭️ Next new video would post: ${formatReadable(nextSlot, timeZone)}
⏸️ Paused: ${paused ? `yes (${paused})` : "no"}
🔑 YouTube token: ${tokenStatus}

⚙️ <b>Posting config</b> (from wrangler.jsonc)
• Uploads/day: <b>${maxPerDay}</b>
• Daily slots (approx): ${slotTimes} (${timeZone})
• First slot: ${offsetToClock(schedule.startMin)} · spacing: ~${gapHrs}h
• Privacy: ${env.YT_PRIVACY_STATUS || "public"}${fitNote}

🗄️ <b>Storage (KV)</b>
• Queue holds lightweight Telegram pointers — no size limit in practice
• Posted history: ${postedCount} record(s) (capped at 200)
• Free-tier budget: 1,000 writes/day · 100,000 reads/day
• Live usage is only visible in the Cloudflare dashboard`;

    await tgSend(env, chatId, statusText);
    return;
  }

  if (message.text?.startsWith("/preview")) {
    const parts = message.text.trim().split(/\s+/);
    const index = parseInt(parts[1], 10) - 1;
    const queue = await getQueue(env);

    if (isNaN(index) || index < 0 || index >= queue.length) {
      await tgSend(env, chatId, "⚠️ Give a valid queue position. Send /queue to see positions.");
      return;
    }

    const item = queue[index];
    const hashtagsText = (item.hashtags || []).map((h) => `#${h.replace(/^#/, "")}`).join(" ");
    const preview = `<b>Title:</b> ${escapeHtml(item.title)}\n\n<b>Description:</b>\n${escapeHtml(item.description || "(none)")}\n\n<b>Hashtags:</b> ${escapeHtml(hashtagsText || "(none)")}`;

    await tgSend(env, chatId, preview, {
      inline_keyboard: [
        [
          { text: "✏️ Edit Title", callback_data: `et:${item.id}` },
          { text: "✏️ Edit Description", callback_data: `ed:${item.id}` },
          { text: "✏️ Edit Hashtags", callback_data: `eh:${item.id}` },
        ],
      ],
    });
    return;
  }

  if (message.text) {
    const editPendingRaw = await env.STATE.get(`editpending:${chatId}`);
    if (editPendingRaw) {
      const { itemId, field } = JSON.parse(editPendingRaw);
      const queue = await getQueue(env);
      const item = queue.find((q) => q.id === itemId);
      await env.STATE.delete(`editpending:${chatId}`);

      if (!item) {
        await tgSend(env, chatId, "⚠️ That queued item no longer exists, nothing was changed.");
        return;
      }

      if (field === "hashtags") {
        item.hashtags = message.text.split(",").map((h) => h.trim().replace(/^#/, "")).filter(Boolean);
      } else {
        item[field] = message.text.trim();
      }

      await saveQueue(env, queue);
      await tgSend(env, chatId, `✅ Updated ${field} for "${escapeHtml(item.title)}".`);
      return;
    }
  }

  if (message.text) {

  const pendingRaw = await env.STATE.get(`pending:${chatId}`);

  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw);

    if (pending.step === "awaiting_title_confirmation") {
      await env.STATE.put(
        `pending:${chatId}`,
        JSON.stringify({
          step: "awaiting_ai_choice",
          vid: pending.vid,
          fileId: pending.fileId,
          fileUniqueId: pending.fileUniqueId,
          originalText: message.text.trim(),
          fileSize: pending.fileSize || 0,
        })
      );

      await tgSend(
        env,
        chatId,
        `✅ Title updated:\n\n<b>${escapeHtml(message.text.trim())}</b>\n\nDo you want AI to generate optimized title, description and hashtags?`,
        {
          inline_keyboard: [
            [
              {
                text: "✨ Yes, use AI",
                callback_data: "generate_ai",
              },
              {
                text: "❌ No, use my title",
                callback_data: "use_raw_title",
              },
            ],
            [{ text: "🚫 Cancel", callback_data: "cancel" }],
          ],
        }
      );

      return;
    }
  }
    if (!pendingRaw) {
      await tgSend(env, chatId, "Send me a video first (under 20MB).");
      return;
    }
    const pending = JSON.parse(pendingRaw);

    if (pending.step === "editing_caption_title") {

    pending.originalText = message.text.trim();

    await env.STATE.put(
        `pending:${chatId}`,
        JSON.stringify({
            step: "awaiting_ai_choice",
            vid: pending.vid,
            fileId: pending.fileId,
            fileUniqueId: pending.fileUniqueId,
            originalText: pending.originalText,
            fileSize: pending.fileSize || 0,
        })
    );

    await tgSend(
        env,
        chatId,
        `✅ Title updated!

Do you want AI to generate Title + Description + Hashtags?`,
        {
            inline_keyboard: [[
                {
                    text: "✨ Yes, use AI",
                    callback_data: "generate_ai"
                },
                {
                    text: "❌ No, use my title",
                    callback_data: "use_raw_title"
                }
            ], [
                { text: "🚫 Cancel", callback_data: "cancel" }
            ]]
        }
    );

    return;
}

    if (pending.step === "awaiting_regenerate_prompt") {
      const draftRaw = await env.STATE.get(`draft:${chatId}`);
      if (!draftRaw) {
        await tgSend(env, chatId, "⚠️ This request expired, please resend the video.");
        return;
      }
      await regenerateAndSendPreview(env, chatId, JSON.parse(draftRaw), message.text.trim());
      return;
    }

    if (pending.step !== "awaiting_caption") return;

    const cleanedInput = cleanCaption(message.text);

    await regenerateAndSendPreview(env, chatId, {
      vid: pending.vid,
      originalText: cleanedInput,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      fileSize: pending.fileSize || 0,
      extraGuidance: [],
    });
    return;
  }
}

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id.toString();
  if (!isAuthorized(env, userId)) return;

  if (cq.data === "cancel") {
    await env.STATE.delete(`pending:${chatId}`);
    await env.STATE.delete(`draft:${chatId}`);
    await tgAnswerCallback(env, cq.id, "Cancelled");
    await tgEditMessage(env, chatId, cq.message.message_id, "🚫 Cancelled. Send a new video whenever you're ready.");
    return;
  }

  if (cq.data.startsWith("qp:")) {
    const page = parseInt(cq.data.split(":")[1], 10) || 1;
    await tgAnswerCallback(env, cq.id, "");
    const paused = await env.STATE.get("queuePaused");
    const pausedNote = paused ? `⏸️ Queue is currently PAUSED (${paused}). Auto-resumes 24h after your last upload, or send /resumequeue now.\n\n` : "";
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgEditMessage(env, chatId, cq.message.message_id, `${pausedNote}📋 Queue is empty.`);
      return;
    }
    const { text, keyboard } = renderQueuePage(env, queue, page, pausedNote);
    await tgEditMessage(env, chatId, cq.message.message_id, text, keyboard.inline_keyboard[0].length ? keyboard : undefined);
    return;
  }

  if (cq.data.startsWith("lp:")) {
    // Format: "lp:PAGE" (all) or "lp:PAGE:e" (errors filter carried across pages).
    const segs = cq.data.split(":");
    const page = parseInt(segs[1], 10) || 1;
    const filter = segs[2] === "e" ? "errors" : "all";
    await tgAnswerCallback(env, cq.id, "");
    const all = await getEventLog(env);
    const entries = filter === "errors" ? all.filter(isErrorishEvent) : all;
    if (entries.length === 0) {
      await tgEditMessage(env, chatId, cq.message.message_id, filter === "errors" ? "🧾 No warnings or errors logged yet." : "🧾 No events logged yet.");
      return;
    }
    const { text, keyboard } = renderLogsPage(env, entries, page, filter);
    await tgEditMessage(env, chatId, cq.message.message_id, text, keyboard.inline_keyboard[0].length ? keyboard : undefined);
    return;
  }

  if (cq.data.startsWith("rm:")) {
    const [, posStr, action] = cq.data.split(":");
    const position = parseInt(posStr, 10);

    if (action === "n") {
      await tgAnswerCallback(env, cq.id, "Cancelled");
      await tgEditMessage(env, chatId, cq.message.message_id, "Cancelled — nothing removed.");
      return;
    }

    const queue = await getQueue(env);
    const index = position - 1;
    if (isNaN(index) || index < 0 || index >= queue.length) {
      await tgAnswerCallback(env, cq.id, "Queue changed");
      await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ The queue changed since this was asked — please check /queue and try again.");
      return;
    }

    const [removed] = queue.splice(index, 1);
    repackQueue(env, queue);
    await saveQueue(env, queue);
    if (removed.videoKey) await env.STATE.delete(removed.videoKey);
    await logEvent(env, "QUEUE_REMOVED", "Video removed from queue", { vid: removed.vid, title: removed.title });

    await tgAnswerCallback(env, cq.id, "Removed");
    await tgEditMessage(env, chatId, cq.message.message_id, `🗑️ Removed "${escapeHtml(removed.title)}" from the queue. ${queue.length} left.`);
    return;
  }

  if (cq.data === "cq:y" || cq.data === "cq:n") {
    if (cq.data === "cq:n") {
      await tgAnswerCallback(env, cq.id, "Cancelled");
      await tgEditMessage(env, chatId, cq.message.message_id, "Cancelled — queue unchanged.");
      return;
    }

    const cleared = await getQueue(env);
    for (const item of cleared) {
      if (item.videoKey) await env.STATE.delete(item.videoKey);
    }
    await saveQueue(env, []);
    await logEvent(env, "QUEUE_REMOVED", "Queue cleared", { count: cleared.length });

    await tgAnswerCallback(env, cq.id, "Cleared");
    await tgEditMessage(env, chatId, cq.message.message_id, `🗑️ Queue cleared completely (${cleared.length} video(s) removed).`);
    return;
  }

  if (cq.data === "dupe_confirm" || cq.data === "dupe_cancel") {
    const pendingRaw = await env.STATE.get(`pending:${chatId}`);
    if (!pendingRaw) {
      await tgAnswerCallback(env, cq.id, "Expired");
      return;
    }
    const pending = JSON.parse(pendingRaw);
    if (pending.step !== "awaiting_dupe_confirmation") {
      await tgAnswerCallback(env, cq.id, "Expired");
      return;
    }
    if (cq.data === "dupe_cancel") {
      await env.STATE.delete(`pending:${chatId}`);
      await tgAnswerCallback(env, cq.id, "Cancelled");
      await tgEditMessage(env, chatId, cq.message.message_id, "❌ Cancelled — the duplicate video was not queued.");
      return;
    }
    await tgAnswerCallback(env, cq.id, "OK");
    await tgEditMessage(env, chatId, cq.message.message_id, "✅ Continuing with the duplicate.");
    await beginIntake(env, chatId, {
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      caption: pending.caption || "",
      fileSize: pending.fileSize || 0,
    });
    return;
  }

  if (cq.data.startsWith("et:") || cq.data.startsWith("ed:") || cq.data.startsWith("eh:")) {
    const [prefix, itemId] = cq.data.split(":");
    const fieldMap = { et: "title", ed: "description", eh: "hashtags" };
    const field = fieldMap[prefix];

    await tgAnswerCallback(env, cq.id, "Reply with the new value");

    const queue = await getQueue(env);
    const item = queue.find((q) => q.id === itemId);
    if (!item) {
      await tgSend(env, chatId, "⚠️ That queued item no longer exists.");
      return;
    }

    await env.STATE.put(`editpending:${chatId}`, JSON.stringify({ itemId, field }), { expirationTtl: 60 * 30 });

    const fieldLabel = { title: "Title", description: "Description", hashtags: "Hashtags (comma-separated, no # needed)" }[field];
    const currentValue = field === "hashtags" ? (item.hashtags || []).join(", ") : (item[field] || "(none)");

    await tgSend(env, chatId, `Current ${fieldLabel}:\n${escapeHtml(currentValue)}\n\nReply with the new value:`, {
      force_reply: true,
      selective: true,
    });
    return;
  }

  if (cq.data === "regenerate") {
    const draftRaw = await env.STATE.get(`draft:${chatId}`);
    if (!draftRaw) {
      await tgAnswerCallback(env, cq.id, "Expired");
      await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ This request expired, please resend the video.");
      return;
    }
    await env.STATE.put(`pending:${chatId}`, JSON.stringify({ step: "awaiting_regenerate_prompt" }));
    await tgAnswerCallback(env, cq.id, "");
    await tgSend(
      env,
      chatId,
      "🔄 Want to give any guidance for the regeneration (tone, focus, what to avoid, etc.)? Type it below, or tap Skip to just regenerate.",
      { inline_keyboard: [[{ text: "⏭️ Skip", callback_data: "regenerate_skip" }], [{ text: "🚫 Cancel", callback_data: "cancel" }]] }
    );
    return;
  }

  if (cq.data === "regenerate_skip") {
    const pendingRaw = await env.STATE.get(`pending:${chatId}`);
    const pending = pendingRaw ? JSON.parse(pendingRaw) : null;
    if (!pending || pending.step !== "awaiting_regenerate_prompt") {
      await tgAnswerCallback(env, cq.id, "Expired");
      return;
    }
    const draftRaw = await env.STATE.get(`draft:${chatId}`);
    if (!draftRaw) {
      await tgAnswerCallback(env, cq.id, "Expired");
      await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ This request expired, please resend the video.");
      return;
    }
    await tgAnswerCallback(env, cq.id, "Regenerating...");
    await regenerateAndSendPreview(env, chatId, JSON.parse(draftRaw));
    return;
  }

  if (cq.data === "use_caption_title") {
  const pendingRaw = await env.STATE.get(`pending:${chatId}`);
  if (!pendingRaw) return;

  const pending = JSON.parse(pendingRaw);

  await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
      step: "awaiting_ai_choice",
      vid: pending.vid,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      originalText: pending.originalText,
      fileSize: pending.fileSize || 0,
    })
  );

  await tgAnswerCallback(env, cq.id, "Title accepted");

  await tgSend(
    env,
    chatId,
    "Do you want AI to generate optimized title, description and hashtags?",
    {
      inline_keyboard: [
        [
          {
            text: "✨ Yes, use AI",
            callback_data: "generate_ai",
          },
          {
            text: "❌ No, use my title",
            callback_data: "use_raw_title",
          },
        ],
        [{ text: "🚫 Cancel", callback_data: "cancel" }],
      ],
    }
  );

  return;
}


if (cq.data === "edit_caption_title") {
  await tgAnswerCallback(env, cq.id, "Reply with the new title");

const pendingRaw = await env.STATE.get(`pending:${chatId}`);
const pending = JSON.parse(pendingRaw);

await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
        step: "editing_caption_title",
        vid: pending.vid,
        fileId: pending.fileId,
        fileUniqueId: pending.fileUniqueId,
        originalText: pending.originalText,
        fileSize: pending.fileSize || 0,
    })
);

  await tgSend(env, chatId, "✏️ Send the new title (or /cancel to abort):", {
    force_reply: true,
  });

  return;
}

if (cq.data === "generate_ai" || cq.data === "use_raw_title") {

  const pendingRaw = await env.STATE.get(`pending:${chatId}`);

  if (!pendingRaw) {
    await tgAnswerCallback(env, cq.id, "Expired");
    return;
  }

  const pending = JSON.parse(pendingRaw);

  if (cq.data === "generate_ai") {
    await tgAnswerCallback(env, cq.id, "Generating...");
    await regenerateAndSendPreview(env, chatId, {
      vid: pending.vid,
      originalText: pending.originalText,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      fileSize: pending.fileSize || 0,
      extraGuidance: [],
    });
    return;
  }

  const meta = {
    title: pending.originalText.slice(0, 100),
    description: "",
    hashtags: [],
  };

  await env.STATE.put(
    `draft:${chatId}`,
    JSON.stringify({
      ...meta,
      vid: pending.vid,
      originalText: pending.originalText,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      fileSize: pending.fileSize || 0,
    })
  );
  await logEvent(env, "DRAFT_CREATED", "Draft created", { vid: pending.vid, title: meta.title });

  await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
      step: "awaiting_confirmation",
    })
  );

  const hashtags = meta.hashtags
    .map((h) => `#${h.replace(/^#/, "")}`)
    .join(" ");

  const preview =
    `<b>Title:</b> ${escapeHtml(meta.title)}\n\n` +
    `<b>Description:</b>\n${escapeHtml(meta.description || "(none)")}\n\n` +
    `<b>Hashtags:</b> ${escapeHtml(hashtags || "(none)")}`;

  await tgAnswerCallback(env, cq.id, "Ready");

  await tgSend(env, chatId, preview, {
    inline_keyboard: [
      [
        {
          text: "✅ Add to queue",
          callback_data: "accept",
        },
      ],
    ],
  });

  return;
}


  await tgAnswerCallback(env, cq.id, "Added to queue");

  const draftRaw = await env.STATE.get(`draft:${chatId}`);
  if (!draftRaw) {
    await tgEditMessage(env, chatId, cq.message.message_id, "This request expired, please resend the video.");
    return;
  }
  const draft = JSON.parse(draftRaw);

  let title, description, tags;

if (cq.data === "accept" || cq.data === "generate_ai") {
  ({ title, description, hashtags: tags } = draft);

} else if (cq.data === "original" || cq.data === "use_raw_title") {
  title = cleanCaption(draft.originalText).slice(0, 100);
  description = "";
  tags = [];

} else {
  await tgSend(env, chatId, "⚠️ Unknown option.");
  return;
}

  if (!draft.fileId) {
    await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ Lost track of that video, please resend it.");
    return;
  }

  const queueId = `${chatId}-${Date.now()}`;
  await env.STATE.delete(`draft:${chatId}`);
  await env.STATE.delete(`pending:${chatId}`);

  const queue = await getQueue(env);
  const newItem = { id: queueId, vid: draft.vid, fileId: draft.fileId, fileUniqueId: draft.fileUniqueId, title, description, hashtags: tags, chatId, fileSize: draft.fileSize || 0 };
  queue.push(newItem);
  repackQueue(env, queue);
  await saveQueue(env, queue);
  await logEvent(env, "QUEUE_ADDED", "Video added to queue", { vid: draft.vid, title, scheduledAt: newItem.scheduledAt });

  const position = queue.findIndex((q) => q.id === queueId) + 1;
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  await tgEditMessage(
    env,
    chatId,
    cq.message.message_id,
    `📋 Added to queue at position ${position}, scheduled for ${formatReadable(newItem.scheduledAt, timeZone)}. I'll post it at that time and message you the link once it's live.`
  );
}
