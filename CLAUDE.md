# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Node.js service that monitors MLB games daily, polls for starting lineups, enriches data with betting odds, and posts updates to a Discord server ("MLB CAPTAIN LEAGUE"). It also writes structured JSON for a separate frontend site (`mlb-lineup-site`).

## Commands

- **Run locally**: `node watcher.js` or `npm start`
- **Production**: Runs as a systemd service (`baseball-watcher`) on gigantc.com at `/opt`
  - `sudo systemctl {start|stop|restart|status} baseball-watcher`
  - Logs: `journalctl -u baseball-watcher -f`

There are no tests or linting configured.

## Architecture

**Entry point**: `watcher.js` — initializes the app, then schedules two polling loops:
1. **Daily fetch** (4:30am APP_TIMEZONE) — `fetchMLBGames()` pulls today's slate from the MLB scoreboard API, writes `mlb-games.json`, builds site JSON, and enriches with odds.
2. **Lineup polling** (every 3 min) — `pollLineups()` checks each game's boxscore API for batting orders. When a lineup appears, it posts to Discord and updates both `mlb-games.json` and site JSON.

**Services** (`services/`):
- `mlbGames.js` — Core logic. Fetches games from `bdfed.stitch.mlbinfra.com`, polls lineups from `statsapi.mlb.com`, maintains two data files (`mlb-games.json` for internal tracking, `site-data/latest.json` for the frontend). Also writes to `../mlb-lineup-site/public/data/latest.json` in local dev.
- `gameAlerts.js` — Monitors a Bluesky account (`fantasymlbnews.bsky.social`) for game/injury/news alerts and forwards them to Discord. Currently disabled in `watcher.js` (commented out).
- `oddsFeed.js` — Fetches betting odds from RapidAPI (`odds-feed.p.rapidapi.com`), computes consensus moneylines and totals, enriches site game objects.
- `postToDiscord.js` — Sends messages via Discord webhook in production; logs to console when `ENVIRONMENT=local`.

**Utils** (`utils/`):
- `formatters.js` — Game time formatting (ET/PT), lineup building from boxscore data, pitcher stats formatting.
- `teamMap.js` — MLB team abbreviation-to-name mapping.
- `storage.js` — Persists seen Bluesky post CIDs to `seen-posts.json` (dedup, capped at 50).

## Key Data Files

- `mlb-games.json` — Internal state: today's games with lineup data and `homePosted`/`awayPosted` flags to avoid duplicate Discord posts.
- `site-data/latest.json` — Frontend-ready payload with game details, lineups, odds, pitcher stats.
- `seen-posts.json` — Bluesky alert dedup tracker.

## Environment Variables

Configured in `.env` (gitignored): `DISCORD_WEBHOOK_URL`, `BSKY_IDENTIFIER`, `BSKY_APP_PASSWORD`, `ENVIRONMENT` (local/production), `APP_TIMEZONE`, `ODDS_API_KEY`, `SITE_DATA_DIR` (optional, overrides site-data output path).

## Key Patterns

- **ES Modules** (`"type": "module"` in package.json) — use `import`/`export`, not `require`.
- **Luxon for dates** — all timezone handling uses `luxon` `DateTime`, not native `Date`. Default timezone is `America/Phoenix`.
- **Atomic file writes** — `writeJsonAtomic()` writes to `.tmp` then renames, preventing partial reads.
- **Discord gating** — `postToDiscord()` only sends to Discord when `ENVIRONMENT=production`; otherwise logs to console. Safe to run locally.
