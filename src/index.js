import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl, escapeHtml } from "./telegram.js";
import { generateMetadata } from "./ai.js";
import { uploadShort, getVideoStats, getAccessToken } from "./youtube.js";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download cap

const FILTER_WORDS = new Set([
  "درهوایت",
]);

const TITLE_SUFFIX = " #shorts #persian #فارسی";
const MAX_TITLE_LENGTH = 100;

const UPLOAD_SCHEDULE = {
  uploadsPerDay: 3,
  windows: [
    { start: "14:00", end: "15:00" },
    { start: "18:00", end: "20:00" },
    { start: "21:00", end: "23:00" },
  ],
};

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

async function computeScheduleTimes(env, queueItems) {
  const timeZone = env.DISPLAY_TIMEZONE || "UTC";
  const now = Date.now();
  let currentDayStr = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

  const utcToday = new Date(now).toISOString().slice(0, 10);
  const usedTodayCount = parseInt((await env.STATE.get(`ytcount:${utcToday}`)) || "0", 10);

  let currentDayMidnight = parseLocalDateTime(currentDayStr, "00:00", timeZone);
  let windowIndex = usedTodayCount;
  let cursor = now;
  const times = [];

  for (const item of queueItems) {
    if (item.manualScheduledAt) {
      const mTime = Math.max(item.manualScheduledAt, cursor);
      times.push(mTime);
      cursor = mTime + 1;
      continue;
    }

    while (true) {
      if (windowIndex >= UPLOAD_SCHEDULE.windows.length) {
        currentDayMidnight += 24 * 60 * 60 * 1000;
        currentDayStr = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(currentDayMidnight));
        currentDayMidnight = parseLocalDateTime(currentDayStr, "00:00", timeZone);
        windowIndex = 0;
      }

      const win = UPLOAD_SCHEDULE.windows[windowIndex];
      const [startH, startM] = win.start.split(":").map(Number);
      const [endH, endM] = win.end.split(":").map(Number);
      const startMs = currentDayMidnight + ((startH * 60 + startM) * 60000);
      const endMs = currentDayMidnight + ((endH * 60 + endM) * 60000);

      let hash = 0;
      const seedStr = item.id + currentDayStr + windowIndex;
      for (let i = 0; i < seedStr.length; i++) {
        hash = (Math.imul(31, hash) + seedStr.charCodeAt(i)) | 0;
      }
      const randomDec = Math.abs(Math.sin(hash || 1));
      const randomMs = startMs + Math.floor(randomDec * (endMs - startMs));

      if (randomMs > cursor) {
        times.push(randomMs);
        cursor = randomMs + 1;
        windowIndex++;
        break;
      } else {
        windowIndex++;
      }
    }
  }
  return times;
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

  const scheduleTimes = await computeScheduleTimes(env, queue);
  const nextTime = scheduleTimes[0];

  if (Date.now() < nextTime) {
    console.log("Not time to post yet.");
    return;
  }

  const item = queue[0];
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `ytcount:${today}`;
  const count = parseInt((await env.STATE.get(countKey)) || "0", 10);

  const videoBytes = await env.STATE.get(item.videoKey, "arrayBuffer");
  if (!videoBytes) {
    console.error("Queued video missing from storage, dropping item:", item.id);
    queue.shift();
    await saveQueue(env, queue);
    return;
  }

  try {
    const videoId = await uploadShort(env, videoBytes, {
      title: item.title,
      description: item.description,
      tags: item.hashtags,
    });

    queue.shift();
    await saveQueue(env, queue);
    await env.STATE.delete(item.videoKey);
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
      queue.shift();
      queue.push(item);
      await saveQueue(env, queue);
      await tgSend(
        env,
        item.chatId,
        `❌ Upload failed twice for "${item.title}": ${err.message}\n↩️ Moved to the back of the queue (position ${queue.length}) so it doesn't block other videos. I'll retry it again later.`
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
    const newFileSize = media.file_size || 0;
    const currentStorage = queue.reduce((acc, item) => acc + (item.fileSize || (20 * 1024 * 1024)), 0);
    const MAX_KV_BYTES = 800 * 1024 * 1024;

    if (currentStorage + newFileSize > MAX_KV_BYTES) {
      const usedMb = (currentStorage / (1024 * 1024)).toFixed(1);
      await tgSend(
        env,
        chatId,
        `⚠️ Cannot accept video: Storage limit reached (${usedMb}MB / 800MB reserved). Please wait for queued videos to upload.`
      );
      return;
    }

    const mockItem = { id: "temp-check" };
    const simulatedTimes = await computeScheduleTimes(env, [...queue, mockItem]);
    const projectedTime = simulatedTimes[simulatedTimes.length - 1];
    const MAX_TTL_MS = 28 * 24 * 60 * 60 * 1000;

    if (projectedTime - Date.now() > MAX_TTL_MS) {
      const timeZone = env.DISPLAY_TIMEZONE || "UTC";
      const dateStr = formatReadable(projectedTime, timeZone);
      await tgSend(
        env,
        chatId,
        `⚠️ Cannot accept video: Queue schedule window full! This video would post on ${dateStr}, exceeding the 28-day storage life.`
      );
      return;
    }

    if (media.file_size && media.file_size > MAX_BYTES) {
      await tgSend(
        env,
        chatId,
        `⚠️ That file is ${(media.file_size / 1024 / 1024).toFixed(1)}MB — over the 20MB limit Telegram bots can download. Please compress it and resend.`
      );
      return; // rejected, nothing downloaded
    }

    const fileUrl = await tgGetFileUrl(env, media.file_id);
    let fileRes;
    try {
      fileRes = await fetchWithRetry(fileUrl, 2);
    } catch (err) {
      console.error("Video download failed after retries:", err.message);
      await tgSend(env, chatId, "⚠️ Couldn't download that video from Telegram after a few tries. Please resend it.");
      return;
    }
    const videoBytes = await fileRes.arrayBuffer();

    const videoKey = `videofile:${chatId}:${media.file_unique_id}`;
    await env.STATE.put(videoKey, videoBytes, { expirationTtl: 60 * 60 * 6 }); // auto-expires in 6 hours if never confirmed
    const caption = cleanCaption(message.caption || "");

if (caption) {
  await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
      step: "awaiting_title_confirmation",
      r2Key: videoKey,
      originalText: caption,
      fileSize: media.file_size || 0,
    })
  );

  await tgSend(
    env,
    chatId,
    `📝 I found this caption:\n\n<b>${escapeHtml(caption)}</b>\n\nUse this as the video title?\n\nYou can edit it before continuing.`,
    {
      inline_keyboard: [
        [
          {
            text: "✅ Use this title",
            callback_data: "use_caption_title",
          },
          {
            text: "✏️ Edit title",
            callback_data: "edit_caption_title",
          },
        ],
      ],
    }
  );
} else {
  await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
      step: "awaiting_caption",
      r2Key: videoKey,
      fileSize: media.file_size || 0,
    })
  );

  await tgSend(
    env,
    chatId,
    "🎬 Got the video ✅\n\nPlease send me the video title/caption."
  );
}

return;
  }

  if (message.text === "/help" || message.text === "/start") {
    const helpText = `🤖 <b>Reels → YouTube Bot</b>

<b>Uploading a video:</b>
Just send a video (under 20MB). I'll ask what it's about, generate a Persian title/description/hashtags with AI, and let you accept or use your own text as the title. It then goes into the upload queue.

<b>Queue commands:</b>
/queue — see all queued videos with their scheduled date & time
/postnow (position) — upload a specific queued video immediately, bypassing the schedule (e.g. /postnow 2)
/setschedule (position) YYYY-MM-DD HH:MM — set a custom date/time for a queued video (e.g. /setschedule 2 2026-08-05 18:30). If it's too close to another upload, I'll adjust it to respect the minimum gap and tell you the real time.
/remove (position) — delete one video from the queue (e.g. /remove 1)
/clearqueue — wipe the entire queue
/resumequeue — resume the queue after it's been auto-paused (e.g. YouTube quota exceeded)
/status — quick health check (queue, quota, last upload, YouTube token)
/preview (position) — see full title/description/hashtags for a queued video, with edit buttons

<b>History:</b>
/posted — see the last 10 videos actually posted to YouTube, with live view counts

<b>How scheduling works:</b>
Videos auto-post at most ${UPLOAD_SCHEDULE.uploadsPerDay} per day. They are randomly assigned an exact minute within specific configured windows (e.g. 14-15, 18-20, 21-23). This guarantees your Shorts hit high-traffic times without overlapping.

<b>Access:</b>
This bot only responds to your authorized Telegram accounts.

/help — show this message again`;

    await tgSend(env, chatId, helpText);
    return;
  }

  if (message.text === "/queue") {
    const paused = await env.STATE.get("queuePaused");
    const pausedNote = paused ? `⏸️ Queue is currently PAUSED (${paused}). Auto-resumes 24h after your last upload, or send /resumequeue now.\n\n` : "";
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgSend(env, chatId, `${pausedNote}📋 Queue is empty.`);
    } else {
      const timeZone = env.DISPLAY_TIMEZONE || "UTC";
      const scheduleTimes = await computeScheduleTimes(env, queue);
      const list = queue
        .map((q, i) => `${i + 1}. ${escapeHtml(q.title)}\n   🕒 ${formatReadable(scheduleTimes[i], timeZone)}`)
        .join("\n\n");
      await tgSend(
        env,
        chatId,
        `${pausedNote}📋 ${queue.length} video(s) queued:\n\n${list}\n\nTo remove one, send: /remove (position number)\nTo clear everything: /clearqueue`
      );
    }
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

    queue[index].manualScheduledAt = targetMs;
    await saveQueue(env, queue);

    const scheduleTimes = await computeScheduleTimes(env, queue);
    const actualTime = scheduleTimes[index];
    const adjustedNote =
      Math.abs(actualTime - targetMs) > 60000
        ? `\n\n⚠️ Adjusted automatically — it'll actually go out at ${formatReadable(actualTime, timeZone)}.`
        : "";

    await tgSend(
      env,
      chatId,
      `🗓️ Requested time for "${escapeHtml(queue[index].title)}": ${formatReadable(targetMs, timeZone)}.${adjustedNote}\n\nSend /queue to see the full updated schedule.`
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
    const videoBytes = await env.STATE.get(item.videoKey, "arrayBuffer");
    if (!videoBytes) {
      await tgSend(env, chatId, "⚠️ That video's data is missing from storage, can't post it.");
      return;
    }

    await tgSend(env, chatId, `⏫ Posting "${escapeHtml(item.title)}" now...`);

    try {
      const videoId = await uploadShort(env, videoBytes, {
        title: item.title,
        description: item.description,
        tags: item.hashtags,
      });

      queue.splice(index, 1);
      await saveQueue(env, queue);
      await env.STATE.delete(item.videoKey);

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
    await env.STATE.delete(removed.videoKey);
    await saveQueue(env, queue);

    await tgSend(env, chatId, `🗑️ Removed "${escapeHtml(removed.title)}" from the queue. ${queue.length} left.`);
    return;
  }

  if (message.text === "/clearqueue") {
    const queue = await getQueue(env);
    for (const item of queue) {
      await env.STATE.delete(item.videoKey);
    }
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
    const maxPerDay = UPLOAD_SCHEDULE.uploadsPerDay;
    const lastUploadAt = parseInt((await env.STATE.get("lastUploadAt")) || "0", 10);
    const timeZone = env.DISPLAY_TIMEZONE || "UTC";

    let tokenStatus = "✅ OK";
    try {
      await getAccessToken(env);
    } catch (err) {
      tokenStatus = `❌ ${err.message}`;
    }

    const statusText = `📊 <b>Bot Status</b>

📋 Queue: ${queue.length} video(s)
📅 Today's uploads: ${count}/${maxPerDay}
🕒 Last upload: ${lastUploadAt ? formatReadable(lastUploadAt, timeZone) : "never"}
⏸️ Paused: ${paused ? `yes (${paused})` : "no"}
🔑 YouTube token: ${tokenStatus}`;

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
          r2Key: pending.r2Key,
          originalText: message.text.trim(),
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
            r2Key: pending.r2Key,
            originalText: pending.originalText
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

    await env.STATE.put(`draft:${chatId}`, JSON.stringify({ ...meta, originalText: cleanedInput, r2Key: pending.r2Key }));
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

// async function handleCallback(cq, env) {
//   const chatId = cq.message.chat.id;
//   const userId = cq.from.id.toString();
//   if (userId !== env.MY_TELEGRAM_USER_ID) return;

//   await tgAnswerCallback(env, cq.id, "Processing...");

//   const draftRaw = await env.STATE.get(`draft:${chatId}`);
//   if (!draftRaw) {
//     await tgEditMessage(env, chatId, cq.message.message_id, "This request expired, please resend the video.");
//     return;
//   }
//   const draft = JSON.parse(draftRaw);

//   const today = new Date().toISOString().slice(0, 10);
//   const countKey = `ytcount:${today}`;
//   const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
//   if (count >= DAILY_UPLOAD_LIMIT) {
//     await tgEditMessage(env, chatId, cq.message.message_id, "🚫 Daily YouTube upload quota reached. Try again tomorrow.");
//     return;
//   }

//   let title, description, tags;
//   if (cq.data === "accept") {
//     ({ title, description, hashtags: tags } = draft);
//   } else {
//     title = draft.originalText.slice(0, 100);
//     description = "";
//     tags = [];
//   }

//   await tgEditMessage(env, chatId, cq.message.message_id, "⏫ Uploading to YouTube...");

//   const videoBytes = await env.STATE.get(draft.r2Key, "arrayBuffer");
//   if (!videoBytes) {
//     await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ Video expired from storage, please resend it.");
//     return;
//   }

//   try {
//     const videoId = await uploadShort(env, videoBytes, { title, description, tags });
//     await env.STATE.put(countKey, (count + 1).toString(), { expirationTtl: 60 * 60 * 26 });
//     await env.STATE.delete(draft.r2Key);
//     await env.STATE.delete(`draft:${chatId}`);
//     await env.STATE.delete(`pending:${chatId}`);
//     await tgEditMessage(env, chatId, cq.message.message_id, `✅ Uploaded! https://youtu.be/${videoId}`);
//   } catch (err) {
//     await tgEditMessage(env, chatId, cq.message.message_id, "❌ Upload failed: " + err.message);
//   }
// }


async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const userId = cq.from.id.toString();
  if (!isAuthorized(env, userId)) return;

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
      r2Key: pending.r2Key,
      originalText: pending.originalText,
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

//   await env.STATE.put(
//     `editpending:${chatId}`,
//     JSON.stringify({
//       type: "caption_title",
//     }),
//     {
//       expirationTtl: 1800,
//     }
//   );

const pendingRaw = await env.STATE.get(`pending:${chatId}`);
const pending = JSON.parse(pendingRaw);

await env.STATE.put(
    `pending:${chatId}`,
    JSON.stringify({
        step: "editing_caption_title",
        r2Key: pending.r2Key,
        originalText: pending.originalText
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
      r2Key: pending.r2Key,
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

  const videoBytes = await env.STATE.get(draft.r2Key, "arrayBuffer");
  if (!videoBytes) {
    await tgEditMessage(env, chatId, cq.message.message_id, "⚠️ Video expired from storage, please resend it.");
    return;
  }

  const queueId = `${chatId}-${Date.now()}`;
  const queueVideoKey = `queuevideo:${queueId}`;
  await env.STATE.put(queueVideoKey, videoBytes, { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
  await env.STATE.delete(draft.r2Key);
  await env.STATE.delete(`draft:${chatId}`);
  await env.STATE.delete(`pending:${chatId}`);

  const queue = await getQueue(env);
  queue.push({ id: queueId, videoKey: queueVideoKey, title, description, hashtags: tags, chatId, fileSize: draft.fileSize || 0 });
  await saveQueue(env, queue);

  await tgEditMessage(
    env,
    chatId,
    cq.message.message_id,
    `📋 Added to queue at position ${queue.length}. I'll space it out automatically and message you the link once it's live.`
  );
}
