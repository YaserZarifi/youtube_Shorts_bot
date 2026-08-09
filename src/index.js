import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl, escapeHtml, tgSetCommands } from "./telegram.js";
import { generateMetadata } from "./ai.js";
import { uploadShort, getVideoStats, getAccessToken } from "./youtube.js";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download cap

const FILTER_WORDS = new Set([
  "درهوایت",
]);

const TITLE_SUFFIX = " #shorts #persian #فارسی";
const MAX_TITLE_LENGTH = 100;

// Derive the posting schedule from wrangler.jsonc vars so editing config actually
// moves both /status and the scheduler. Slots are evenly spaced: the first at
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
  const taken = new Set(blockedTimes.map((t) => Math.floor(t / SLOT_GRID_MS)));
  const times = [];
  if (count <= 0) return times;

  let dayStr = fmt.format(new Date(startMs));
  let dayMidnight = parseLocalDateTime(dayStr, "00:00", timeZone);

  for (let day = 0; day < 3700 && times.length < count; day++) { // ~10yr safety guard
    for (let w = 0; w < schedule.windows.length && times.length < count; w++) {
      const t = slotTimeFor(schedule, dayMidnight, w);
      if (t < startMs) continue;
      const bucket = Math.floor(t / SLOT_GRID_MS);
      if (taken.has(bucket)) continue;
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
  if (cleaned) {
    await env.STATE.put(
      `pending:${chatId}`,
      JSON.stringify({
        step: "awaiting_title_confirmation",
        fileId,
        fileUniqueId,
        originalText: cleaned,
        fileSize: fileSize || 0,
      })
    );
    await tgSend(
      env,
      chatId,
      `📝 I found this caption:\n\n<b>${escapeHtml(cleaned)}</b>\n\nUse this as the video title?\n\nYou can edit it before continuing.`,
      {
        inline_keyboard: [
          [
            { text: "✅ Use this title", callback_data: "use_caption_title" },
            { text: "✏️ Edit title", callback_data: "edit_caption_title" },
          ],
        ],
      }
    );
  } else {
    await env.STATE.put(
      `pending:${chatId}`,
      JSON.stringify({
        step: "awaiting_caption",
        fileId,
        fileUniqueId,
        fileSize: fileSize || 0,
      })
    );
    await tgSend(env, chatId, "🎬 Got the video ✅\n\nPlease send me the video title/caption.");
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
    posted.unshift({ id: videoId, title: item.title, uploadedAt: Date.now() });
    await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

    await tgSend(env, item.chatId, `✅ Queued video is live: https://youtu.be/${videoId}\n📋 ${queue.length} left in queue.`);
  } catch (err) {
    console.error("Queued upload failed:", err.message);

    if (isQuotaError(err.message)) {
      await env.STATE.put("queuePaused", "YouTube daily quota exceeded");
      await tgSend(
        env,
        item.chatId,
        `🚫 YouTube upload quota exceeded. The queue is now PAUSED.\n\nIt'll auto-resume 24h after your last successful upload, or send /resumequeue to override manually.`
      );
      return;
    }

    item.failCount = (item.failCount || 0) + 1;
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

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();

  if (!isAuthorized(env, userId)) {
    await tgSend(env, chatId, "This bot is private.");
    return;
  }

  const media = message.video || message.document;

  if (media) {
    const queue = await getQueue(env);

    if (media.file_size && media.file_size > MAX_BYTES) {
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
/remove (position) — delete one video from the queue (e.g. /remove 1)
/clearqueue — wipe the entire queue
/resumequeue — resume the queue after it's been auto-paused (e.g. YouTube quota exceeded)
/status — detailed health check (queue, uploads, config, KV, token)
/preview (position) — see full title/description/hashtags for a queued video, with edit buttons

<b>History:</b>
/posted — see the last 10 videos actually posted to YouTube, with live view counts

<b>How scheduling works:</b>
Videos auto-post at most ${helpSchedule.uploadsPerDay} per day, each locked to a fixed time slot (shown in /queue) that never drifts. If you /postnow or /remove a video, the ones behind it move UP to fill the freed slots — nobody's time slides later. Use /setschedule to pin a video to your own time. There's no queue limit — the queue stores lightweight Telegram pointers, so videos can wait as long as needed.

<b>Access:</b>
This bot only responds to your authorized Telegram accounts.

/help — show this message again`;

    await tgSend(env, chatId, helpText);

    await tgSetCommands(env, [
      { command: "queue", description: "See all queued videos and schedule" },
      { command: "status", description: "Check bot health, capacity, and limits" },
      { command: "preview", description: "See full metadata for a queued video" },
      { command: "posted", description: "See the last 10 posted videos" },
      { command: "remove", description: "Delete one video from the queue" },
      { command: "postnow", description: "Upload a queued video immediately" },
      { command: "setschedule", description: "Set a custom date/time for a video" },
      { command: "resumequeue", description: "Resume queue after being paused" },
      { command: "clearqueue", description: "Wipe the entire queue" },
      { command: "help", description: "Show instructions" }
    ]);
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
      posted.unshift({ id: videoId, title: item.title, uploadedAt: Date.now() });
      await env.STATE.put("postedVideos", JSON.stringify(posted.slice(0, 200)));

      await tgSend(env, chatId, `✅ Live now: https://youtu.be/${videoId}\n📋 ${queue.length} left in queue.`);
    } catch (err) {
      console.error("Manual /postnow upload failed:", err.message);
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

    const [removed] = queue.splice(index, 1);
    repackQueue(env, queue);
    await saveQueue(env, queue);

    await tgSend(env, chatId, `🗑️ Removed "${escapeHtml(removed.title)}" from the queue. ${queue.length} left.`);
    return;
  }

  if (message.text === "/clearqueue") {
    await saveQueue(env, []);
    await tgSend(env, chatId, "🗑️ Queue cleared completely.");
    return;
  }

  if (message.text === "/resumequeue") {
    await env.STATE.delete("queuePaused");
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

    // The "~" times are the earliest end of each window; the real slot jitters later.
    const slotTimes = schedule.windows.map((w) => offsetToClock(w.startOffsetMin)).join(", ");
    const gapHrs = (schedule.gapMin / 60).toFixed(schedule.gapMin % 60 ? 1 : 0);
    const fitNote = schedule.fits ? "" : `\n⚠️ These slots span more than the posting window — later slots roll past ${offsetToClock(schedule.startMin + schedule.windowLenMin)} into the next window.`;

    const statusText = `📊 <b>Bot Status</b>

📋 Queue: <b>${queue.length}</b> video(s)
📅 Today's uploads: <b>${count}/${maxPerDay}</b>
🕒 Last upload: ${lastUploadAt ? formatReadable(lastUploadAt, timeZone) : "never"}
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
            ]]
        }
    );

    return;
}

    if (pending.step !== "awaiting_caption") return;

const cleanedInput = cleanCaption(message.text);

const meta = await generateMetadata(env, cleanedInput);

    await env.STATE.put(`draft:${chatId}`, JSON.stringify({ ...meta, originalText: cleanedInput, fileId: pending.fileId, fileUniqueId: pending.fileUniqueId, fileSize: pending.fileSize || 0 }));
    await env.STATE.put(`pending:${chatId}`, JSON.stringify({ step: "awaiting_confirmation" }));

    const hashtags = meta.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
    const preview = `<b>Title:</b> ${escapeHtml(meta.title)}\n\n<b>Description:</b>\n${escapeHtml(meta.description)}\n\n<b>Hashtags:</b> ${escapeHtml(hashtags)}`;

    // --- THE TWO BUTTONS ---
    await tgSend(env, chatId, preview, {
      inline_keyboard: [
        [
          { text: "✅ Accept AI version", callback_data: "accept" },
          { text: "📝 Use my text as title only", callback_data: "original" },
        ],
      ],
    });
  }
}

async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id.toString();
  if (!isAuthorized(env, userId)) return;

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

  if (cq.data === "use_caption_title") {
  const pendingRaw = await env.STATE.get(`pending:${chatId}`);
  if (!pendingRaw) return;

  const pending = JSON.parse(pendingRaw);

  await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
      step: "awaiting_ai_choice",
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
        fileId: pending.fileId,
        fileUniqueId: pending.fileUniqueId,
        originalText: pending.originalText,
        fileSize: pending.fileSize || 0,
    })
);

  await tgSend(env, chatId, "✏️ Send the new title:", {
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

  let meta;

  if (cq.data === "generate_ai") {
    meta = await generateMetadata(env, pending.originalText);
  } else {
    meta = {
      title: pending.originalText.slice(0, 100),
      description: "",
      hashtags: [],
    };
  }

  await env.STATE.put(
    `draft:${chatId}`,
    JSON.stringify({
      ...meta,
      originalText: pending.originalText,
      fileId: pending.fileId,
      fileUniqueId: pending.fileUniqueId,
      fileSize: pending.fileSize || 0,
    })
  );

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
  const newItem = { id: queueId, fileId: draft.fileId, fileUniqueId: draft.fileUniqueId, title, description, hashtags: tags, chatId, fileSize: draft.fileSize || 0 };
  queue.push(newItem);
  repackQueue(env, queue);
  await saveQueue(env, queue);

  const position = queue.findIndex((q) => q.id === queueId) + 1;
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  await tgEditMessage(
    env,
    chatId,
    cq.message.message_id,
    `📋 Added to queue at position ${position}, scheduled for ${formatReadable(newItem.scheduledAt, timeZone)}. I'll post it at that time and message you the link once it's live.`
  );
}
