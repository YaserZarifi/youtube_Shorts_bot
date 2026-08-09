const TG_API = (token) => `https://api.telegram.org/bot${token}`;

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function tgSend(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("tgSend failed:", JSON.stringify(data), "for text:", text);
  }
  return data;
}

export async function tgEditMessage(env, chatId, messageId, text, replyMarkup) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function tgAnswerCallback(env, callbackQueryId, text) {
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function tgGetFileUrl(env, fileId) {
  const res = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error("getFile failed: " + JSON.stringify(data));
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

export async function tgSetCommands(env, commands) {
  const res = await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  });
  const data = await res.json();
  if (!data.ok) console.error("tgSetCommands failed:", JSON.stringify(data));
  return data;
}
