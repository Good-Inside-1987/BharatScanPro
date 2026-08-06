# BharatScan

Indian stock market scanning and analysis platform. Scan, filter, and analyse NSE equities with real-time data via a Fyers broker connection.

## Stack

- **Frontend** — React 19 + Vite, Tailwind CSS v4, Wouter routing (`artifacts/bharatscan/`)
- **Backend** — Node.js + Express, `node:sqlite` (requires Node 22+), `tsx` watch (`server/`)
- **Broker** — Fyers API (configured at runtime via the app's Settings page)
- **Package manager** — pnpm workspaces

## How to run

Two workflows run in parallel:

| Workflow | Command | Port |
|---|---|---|
| Frontend | `PORT=5000 pnpm --filter @workspace/bharatscan run dev` | 5000 |
| Backend API server | `pnpm --filter @workspace/server run dev` | 3001 |

The frontend proxies `/api/*` to the backend on port 3001.

## Environment variables

Set in Replit's shared environment:

| Key | Purpose |
|---|---|
| `SERVER_PORT` | Backend port (default 3001) |
| `NODE_ENV` | `development` / `production` |
| `DB_DIR` | SQLite database directory (default `./data`) |
| `PORT` | Frontend dev server port (default 5000) |
| `BASE_PATH` | URL base path (default `/`) |

Secrets (set via Replit Secrets):

| Key | Purpose |
|---|---|
| `SESSION_SECRET` | Express session signing key ✅ set |
| `API_KEY` | Optional — server auth key (skipped if unset) |
| `BROKER_ENCRYPTION_KEY` | 32-char key for encrypting stored Fyers tokens |

## Node.js version

Requires **Node 22+** — `node:sqlite` (used by the backend) is not available in Node 20.

## Broker setup

Connect Fyers by going to **Settings** inside the app. Credentials are stored encrypted in the local SQLite database.

## User preferences

- Keep the project's monorepo structure (artifacts/bharatscan, server, lib)
- Do not restructure or migrate to a different stack
