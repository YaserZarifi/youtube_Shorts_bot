import { tgSend, tgEditMessage, tgAnswerCallback, tgGetFileUrl } from "./telegram.js";
import { generateMetadata } from "./ai.js";
import { uploadShort } from "./youtube.js";

const MAX_BYTES = 20 * 1024 * 1024; // Telegram bot download cap

async function getQueue(env) {
  const raw = await env.STATE.get("queue");
  return raw ? JSON.parse(raw) : [];
}

async function saveQueue(env, queue) {
  await env.STATE.put("queue", JSON.stringify(queue));
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

    await tgSend(env, item.chatId, `✅ Queued video is live: https://youtu.be/${videoId}\n📋 ${queue.length} left in queue.`);
  } catch (err) {
    console.error("Queued upload failed:", err.message);
    await tgSend(env, item.chatId, `❌ Scheduled upload failed for "${item.title}": ${err.message}`);
  }
}

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const userId = message.from.id.toString();

  if (userId !== env.MY_TELEGRAM_USER_ID) {
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
    const fileRes = await fetch(fileUrl);
    const videoBytes = await fileRes.arrayBuffer();

    const videoKey = `videofile:${chatId}:${media.file_unique_id}`;
    await env.STATE.put(videoKey, videoBytes, { expirationTtl: 60 * 60 * 6 }); // auto-expires in 6 hours if never confirmed
    await env.STATE.put(`pending:${chatId}`, JSON.stringify({ step: "awaiting_caption", r2Key: videoKey }));

    await tgSend(env, chatId, "Got the video ✅. In a short sentence, what is this about?");
    return;
  }

  if (message.text === "/queue") {
    const queue = await getQueue(env);
    if (queue.length === 0) {
      await tgSend(env, chatId, "📋 Queue is empty.");
    } else {
      const list = queue.map((q, i) => `${i + 1}. ${q.title}`).join("\n");
      await tgSend(env, chatId, `📋 ${queue.length} video(s) queued:\n${list}`);
    }
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
    const preview = `<b>Title:</b> ${meta.title}\n\n<b>Description:</b>\n${meta.description}\n\n<b>Hashtags:</b> ${hashtags}`;

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
  if (userId !== env.MY_TELEGRAM_USER_ID) return;

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
