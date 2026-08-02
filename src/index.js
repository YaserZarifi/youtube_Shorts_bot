import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl, escapeHtml } from "./telegram.js";
import { generateMetadata } from "./ai.js";
import { uploadShort, getVideoStats } from "./youtube.js";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download cap

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
  const maxPerDay = parseInt(env.MAX_UPLOADS_PER_DAY || "3", 10);
  const gapHours = parseFloat(env.MIN_HOURS_BETWEEN_UPLOADS || "6");
  const gapMs = gapHours * 60 * 60 * 1000;

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const usedTodayCount = parseInt((await env.STATE.get(`ytcount:${today}`)) || "0", 10);
  const lastUploadAt = parseInt((await env.STATE.get("lastUploadAt")) || "0", 10);

  let cursor = lastUploadAt ? lastUploadAt + gapMs : now;
  if (cursor < now) cursor = now;

  let usedToday = usedTodayCount;
  let currentDayKey = dateKey(cursor, timeZone);

  const times = [];
  for (const item of queueItems) {
    let candidate = item.manualScheduledAt ? Math.max(item.manualScheduledAt, cursor) : cursor;

    let candidateDayKey = dateKey(candidate, timeZone);
    if (candidateDayKey !== currentDayKey) {
      usedToday = 0;
      currentDayKey = candidateDayKey;
    }
    while (usedToday >= maxPerDay) {
      do {
        candidate += 60 * 60 * 1000;
      } while (dateKey(candidate, timeZone) === currentDayKey);
      currentDayKey = dateKey(candidate, timeZone);
      usedToday = 0;
    }

    times.push(candidate);
    usedToday++;
    cursor = candidate + gapMs;
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
    ctx.waitUntil(processQueueTick(env));
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

  const maxPerDay = parseInt(env.MAX_UPLOADS_PER_DAY || "3", 10);
  const minHoursGap = parseFloat(env.MIN_HOURS_BETWEEN_UPLOADS || "6");

  const today = new Date().toISOString().slice(0, 10);
  const countKey = `ytcount:${today}`;
  const count = parseInt((await env.STATE.get(countKey)) || "0", 10);
  if (count >= maxPerDay) {
    console.log("Daily upload cap reached, skipping this tick.");
    return;
  }

  const lastUploadAt = parseInt((await env.STATE.get("lastUploadAt")) || "0", 10);
  const hoursSinceLast = (Date.now() - lastUploadAt) / (1000 * 60 * 60);
  if (lastUploadAt && hoursSinceLast < minHoursGap) {
    console.log(`Only ${hoursSinceLast.toFixed(1)}h since last upload, need ${minHoursGap}h. Skipping.`);
    return;
  }

  const queue = await getQueue(env);
  if (queue.length === 0) {
    console.log("Queue empty, nothing to post.");
    return;
  }

  const item = queue[0];

  if (item.manualScheduledAt && Date.now() < item.manualScheduledAt) {
    console.log("Next queued item has a future manual schedule, waiting.");
    return;
  }

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
    // --- SIZE CHECK BEFORE DOWNLOADING ANYTHING ---
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
    await env.STATE.put(`pending:${chatId}`, JSON.stringify({ step: "awaiting_caption", r2Key: videoKey }));

    await tgSend(env, chatId, "Got the video ✅. In a short sentence, what is this about?");
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

<b>History:</b>
/posted — see the last 10 videos actually posted to YouTube, with live view counts

<b>How scheduling works:</b>
Videos auto-post at most ${env.MAX_UPLOADS_PER_DAY || "3"} per day, at least ${env.MIN_HOURS_BETWEEN_UPLOADS || "6"} hours apart, checked every hour. This spacing helps avoid your own Shorts competing with each other on the same day.

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
    const gapHours = parseFloat(env.MIN_HOURS_BETWEEN_UPLOADS || "6");
    const adjustedNote =
      Math.abs(actualTime - targetMs) > 60000
        ? `\n\n⚠️ Adjusted to keep the ${gapHours}h minimum gap — it'll actually go out at ${formatReadable(actualTime, timeZone)}.`
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

  if (message.text) {
    const pendingRaw = await env.STATE.get(`pending:${chatId}`);
    if (!pendingRaw) {
      await tgSend(env, chatId, "Send me a video first (under 20MB).");
      return;
    }
    const pending = JSON.parse(pendingRaw);
    if (pending.step !== "awaiting_caption") return;

    const meta = await generateMetadata(env, message.text);

    await env.STATE.put(`draft:${chatId}`, JSON.stringify({ ...meta, originalText: message.text, r2Key: pending.r2Key }));
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

  await tgAnswerCallback(env, cq.id, "Added to queue");

  const draftRaw = await env.STATE.get(`draft:${chatId}`);
  if (!draftRaw) {
    await tgEditMessage(env, chatId, cq.message.message_id, "This request expired, please resend the video.");
    return;
  }
  const draft = JSON.parse(draftRaw);

  let title, description, tags;
  if (cq.data === "accept") {
    ({ title, description, hashtags: tags } = draft);
  } else {
    title = draft.originalText.slice(0, 100);
    description = "";
    tags = [];
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
  queue.push({ id: queueId, videoKey: queueVideoKey, title, description, hashtags: tags, chatId });
  await saveQueue(env, queue);

  await tgEditMessage(
    env,
    chatId,
    cq.message.message_id,
    `📋 Added to queue at position ${queue.length}. I'll space it out automatically and message you the link once it's live.`
  );
}
