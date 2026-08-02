const TG_API = (token) => `https://api.telegram.org/bot${token}`;

export async function tgSend(env, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function tgEditMessage(env, chatId, messageId, text) {
  await fetch(`${TG_API(env.TELEGRAM_BOT_TOKEN)}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
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
