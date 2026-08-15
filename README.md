# LetoTalks

A full-stack teacher feedback platform built for a school community. The application combines authenticated student access, teacher profiles and ratings, comments, moderation, administrative tools, and a small virtual rewards system.

## Stack

- Node.js / Express
- SQLite via `better-sqlite3`
- bcrypt-based authentication support
- Helmet and rate limiting
- Telegram integration for review workflows
- LLM-assisted comment moderation
- vanilla HTML/CSS/JavaScript frontend

## Main components

- `server.js` — HTTP API, authentication/session handling, administration, teacher requests, ratings/comments, shop/inventory flows, Telegram integration
- `db_processing.js` — SQLite schema and data-access layer
- `comment_moderation.js` — moderation pipeline
- `outbound_proxy.js` — optional outbound proxy support
- `public/` — browser client
- `tests/` — application tests

## Local setup

```bash
npm install
cp .env.example .env
npm start
```

Runtime databases, uploaded/requested photos, environment files, and installed dependencies are intentionally excluded from version control.

## Publication note

This repository originated as a live school-community project. Before making it public, deployment credentials must be rotated and any school-specific test authentication or personally identifying production data should be reviewed separately from the source code.
