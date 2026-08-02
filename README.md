# Reels → YouTube Shorts Bot

[![Repo](https://img.shields.io/badge/github-YaserZarifi%2Fyoutube__Shorts__bot-181717?logo=github)](https://github.com/YaserZarifi/youtube_Shorts_bot)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020?logo=cloudflare)](https://workers.cloudflare.com/)

A private Telegram bot that turns short video clips into scheduled, AI-captioned YouTube Shorts uploads — built as a [Cloudflare Worker](https://workers.cloudflare.com/), with no server to manage.

Send a video to the bot, tell it what it's about, and it writes a Persian title/description/hashtags with AI, queues the video, and posts it to YouTube on a controlled schedule — spaced out, capped per day, and restricted to a preferred posting window.

---

## ✨ Features

- **Telegram → YouTube pipeline** — send a video (under 20MB), get a scheduled YouTube Short.
- **AI-generated metadata** — Persian title, description, and hashtags via Workers AI (Llama 4 Scout), tuned for poetry/music/quote content, with a special passthrough rule for `#شعر` (poem) text.
- **Smart queue & scheduling**
  - Configurable max uploads per day and minimum gap between uploads.
  - Configurable daily **posting window** (e.g. only post between 13:00–01:00) so uploads land at the right hours even if the gap math would otherwise allow an off-hours post.
  - Manual per-item scheduling via `/setschedule`, which bypasses the window/gap rules when you explicitly set a time.
- **Resilience**
  - Automatic retry on flaky Telegram downloads.
  - Failed uploads get retried, and are pushed to the back of the queue after repeated failures instead of blocking everything behind them.
  - Automatic detection of YouTube quota exhaustion — pauses the whole queue and **auto-resumes 24h after your last successful upload** (or resume manually anytime).
- **In-place editing** — preview any queued item and edit its title, description, or hashtags via Telegram buttons + reply, no need to re-upload.
- **Visibility**
  - `/status` — live health check: queue size, today's upload count, pause state, YouTube token validity.
  - `/posted` — last 10 posted videos with live view counts.
  - Weekly digest (Friday mornings) — total views and a per-video breakdown for the past week.
- **Private by design** — only responds to a whitelisted set of Telegram user IDs.

---

## 🏗️ Architecture

```
Telegram (video + caption)
        │
        ▼
Cloudflare Worker  ──webhook──▶  index.js  (routing, queue, scheduling)
        │                            │
        │                            ├── telegram.js  (Telegram Bot API wrapper)
        │                            ├── ai.js         (Workers AI metadata generation)
        │                            └── youtube.js    (YouTube Data API v3 upload/stats)
        │
        ▼
Workers KV (env.STATE)  — queue, pending state, drafts, posted history, pause flag
        │
        ▼
Cron Triggers  — hourly queue tick + weekly Friday digest
        │
        ▼
YouTube Shorts (uploaded via YouTube Data API v3)
```

| File | Responsibility |
|---|---|
| `index.js` | Webhook entrypoint, command handling, queue/scheduling logic, cron dispatch |
| `telegram.js` | Thin wrapper around the Telegram Bot API (`sendMessage`, `editMessageText`, `getFile`, etc.) |
| `ai.js` | Builds the AI prompt and parses the model's JSON response into title/description/hashtags |
| `youtube.js` | OAuth token refresh, resumable-less multipart video upload, video statistics |

---

## 🤖 Commands

| Command | Description |
|---|---|
| *(send a video)* | Starts the upload flow — bot asks what the video is about |
| `/help`, `/start` | Show the help message |
| `/queue` | List all queued videos with their scheduled date & time |
| `/preview (position)` | Show full title/description/hashtags for a queued item, with edit buttons |
| `/setschedule (position) YYYY-MM-DD HH:MM` | Manually schedule a queued item (bypasses window/gap rules) |
| `/postnow (position)` | Upload a queued video immediately, bypassing the schedule |
| `/remove (position)` | Remove one video from the queue |
| `/clearqueue` | Wipe the entire queue |
| `/resumequeue` | Manually resume a paused queue (e.g. after quota exhaustion) |
| `/status` | Quick health check — queue, quota, last upload, YouTube token validity |
| `/posted` | Last 10 posted videos with live view counts |

---

## ⚙️ Setup & Deployment

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed:
  ```bash
  npm install -g wrangler
  wrangler login
  ```
- A Telegram bot created via [@BotFather](https://t.me/BotFather) — save the bot token.
- A Google Cloud project with the **YouTube Data API v3** enabled, and OAuth 2.0 credentials (Client ID + Client Secret) with the `https://www.googleapis.com/auth/youtube.upload` scope authorized, plus a refresh token for the channel you want to upload to.
- Access to **Workers AI** enabled on your Cloudflare account (used for metadata generation).

### 1. Clone and install

```bash
git clone https://github.com/YaserZarifi/youtube_Shorts_bot.git
cd youtube_Shorts_bot
```

This project has no external npm dependencies — it runs on the Workers runtime directly.

### 2. Create the KV namespace

```bash
wrangler kv namespace create "STATE"
```

Copy the returned `id` into `wrangler.jsonc` under the `kv_namespaces` binding for `STATE`.

### 3. Configure `wrangler.jsonc`

```jsonc
{
  "name": "reels-to-youtube-bot",
  "main": "index.js",
  "compatibility_date": "2026-08-01",
  "kv_namespaces": [
    { "binding": "STATE", "id": "<your-kv-namespace-id>" }
  ],
  "ai": {
    "binding": "AI"
  },
  "triggers": {
    "crons": ["0 * * * *", "30 4 * * 5"]
  },
  "vars": {
    "MAX_UPLOADS_PER_DAY": "3",
    "MIN_HOURS_BETWEEN_UPLOADS": "6",
    "DISPLAY_TIMEZONE": "Asia/Kabul",
    "POSTING_WINDOW_START_HOUR": "13",
    "POSTING_WINDOW_END_HOUR": "1",
    "YT_PRIVACY_STATUS": "public"
  }
}
```

- The hourly cron (`0 * * * *`) drives the upload queue.
- The Friday cron (`30 4 * * 5`) sends the weekly digest — this example fires at 09:00 Kabul time; adjust to your own timezone offset from UTC.
- `POSTING_WINDOW_START_HOUR` / `END_HOUR` support windows that wrap past midnight (e.g. `13` → `1` means 13:00–01:00).

### 4. Set secrets

Secrets are never committed — set them via Wrangler:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_SECRET
wrangler secret put MY_TELEGRAM_USER_ID
wrangler secret put YT_CLIENT_ID
wrangler secret put YT_CLIENT_SECRET
wrangler secret put YT_REFRESH_TOKEN
```

| Secret | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_SECRET` | A random string you choose — used to verify incoming webhook requests |
| `MY_TELEGRAM_USER_ID` | Comma-separated Telegram user ID(s) allowed to use the bot |
| `YT_CLIENT_ID` | Google OAuth client ID |
| `YT_CLIENT_SECRET` | Google OAuth client secret |
| `YT_REFRESH_TOKEN` | OAuth refresh token for the target YouTube channel |

### 5. Deploy

```bash
wrangler deploy
```

Note the deployed Worker URL (e.g. `https://reels-to-youtube-bot.<your-subdomain>.workers.dev`).

### 6. Register the Telegram webhook

```bash
curl -F "url=https://<your-worker-url>/webhook" \
     -F "secret_token=<same value as TELEGRAM_SECRET>" \
     "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook"
```

### 7. Test it

Message your bot `/help` — if it responds, you're live. Send a short video to try the full flow.

---

## 🔐 Security notes

- The webhook route checks `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_SECRET` on every request.
- Only Telegram user IDs listed in `MY_TELEGRAM_USER_ID` can interact with the bot — everyone else gets a static "this bot is private" reply.
- No video content or generated metadata is sent anywhere outside Telegram, Cloudflare Workers AI, and the YouTube Data API.

---

## 📄 License

Released under the [MIT License](./LICENSE).
