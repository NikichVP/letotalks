# LetoTalks

A teacher feedback platform built for a school community: students sign in with their school email, rate teachers on four characteristics, leave anonymous reviews, like/dislike reviews and spend earned coins on display nicknames. Moderators work through an admin panel and a Telegram review chat.

## Features

- **Sign-in by email code** (Resend). Only allowed domains (`@student.letovo.ru` by default) can sign in; logged-out visitors see nothing but the login screen.
- **Teacher catalog**: home carousels (top by characteristic and by department), full list, department pages, search by name in any word order.
- **Ratings** are saved instantly per characteristic; each student has one rating per teacher and characteristic and can change it.
- **Reviews** are anonymous to other students (shown as the bought nickname or «Аноним»). Every review passes a local profanity filter (shared with the browser in `public/profanity.js`) and an LLM check; unclear cases go to the Telegram moderation chat. Swearing is rejected; the 3rd attempt within 30 days blocks the account.
- **Coins and shop**: +5 per review, +1 per rating, ±1 per like/dislike received; coins buy nicknames.
- **Admin panel**: recent reviews and reviews by author, bans, teacher CRUD with photo upload, admin management (root admin only).

## Stack

- Node.js 20+ / Express 5
- SQLite via `better-sqlite3` (schema and migrations are created in code)
- Helmet (CSP), rate limiting tuned for a school NAT (limits per user, not per IP)
- Telegram bot for moderation, OpenAI-compatible LLM moderation, Resend for email
- Vanilla HTML/CSS/JS single-page frontend (`public/`)

## Main components

- `server.js` — HTTP API: auth and sessions, catalog, reviews/ratings/votes, shop, admin, Telegram webhook
- `db_processing.js` — SQLite schema, migrations and data access
- `comment_moderation.js` — moderation pipeline (profanity filter + LLM)
- `public/profanity.js` — profanity filter shared by server and browser
- `outbound_proxy.js` — optional outbound HTTP(S) proxy for OpenAI/Telegram/Resend
- `migrate.js` — creates the database schema (`npm run migrate`)
- `tests/` — node:test suites (`npm test`)

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3001. Without `RESEND_API_KEY` the sign-in code is printed to the server console. All settings are documented in `.env.example`.

## Production notes

- Set `NODE_ENV=production` (Secure cookies; sign-in codes are never logged).
- Behind nginx set `TRUST_PROXY` (e.g. `loopback`) so rate limits see real client IPs, and consider `HOST=127.0.0.1`.
- Set `TELEGRAM_WEBHOOK_SECRET` and register it with Telegram (`setWebhook` with `secret_token`), otherwise moderation buttons don't work.
- The database is backed up daily to `data/backups` (7 rotating copies) — copy them off the machine.

Runtime databases, uploaded photos, environment files and installed dependencies are intentionally excluded from version control.

## Publication note

This repository originated as a live school-community project. Deployment credentials must be rotated before publishing, and any personally identifying production data should be reviewed separately from the source code.
