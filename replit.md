# BharatScan

A stock screener and backtesting tool for Indian markets (NSE).

## Stack

- **Monorepo**: pnpm workspaces
- **Frontend**: React 19, Vite 7, TypeScript, Tailwind CSS v4, TanStack Query
- **Backend**: Node.js 22 (required — uses `node:sqlite`), Express 4
- **Database**: `node:sqlite` (built-in Node.js SQLite, no native deps)
- **Python sidecar**: `fyers_ws_bridge.py` for live Fyers broker WebSocket data

## Running in Development

Two workflows run in parallel:

| Workflow | Command | Port |
|---|---|---|
| Backend API server | `pnpm --filter @workspace/server run dev` | 3001 |
| Frontend | `PORT=5000 pnpm --filter @workspace/bharatscan run dev` | 5000 |

The frontend (port 5000) is what the user sees. It proxies `/api/*` requests to the backend on port 3001.

The Replit runtime is configured to use Node.js 22 because the backend uses the built-in `node:sqlite` module. The imported project was verified with both workflows running: the backend health endpoint responds on port 3001 and the frontend responds on port 5000.

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `API_KEY` | Optional | Password-protects the app. If unset, login is open. |
| `BROKER_ENCRYPTION_KEY` | Optional | Encrypts stored broker credentials. If unset, broker auth will fail. |
| `SERVER_PORT` | Optional | Backend port (default: 3001) |
| `DB_DIR` | Optional | SQLite database directory (default: `./data`) |

## Key Notes

- **Node.js 22+ is required** — `node:sqlite` is a Node 22.5+ built-in. The project uses `nodejs-22` module.
- **Python**: `fyers-apiv3` must be installed (`pip install fyers-apiv3`) for live broker feeds.
- Broker connections (Fyers/Angel One) are needed for live data and options chains. Without a connected broker, market data syncs are skipped automatically.
- On first run the server bootstraps ~2981 NSE symbols and the 2026 holiday calendar automatically.

## User Preferences

_No preferences recorded yet._
