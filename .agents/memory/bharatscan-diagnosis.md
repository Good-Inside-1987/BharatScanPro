---
name: BharatScan diagnosis & fix roadmap
description: Findings from deep Electron/Fyers diagnosis session; what works, what's broken, and the ordered fix list.
---

# BharatScan Diagnosis & Fix Roadmap

## What was confirmed working (Mac Electron)
- Python `fyers_apiv3` installed into `/usr/bin/python3` (Python 3.9.6) — fixed by user
- Fyers WebSocket bridge connects: `[liveFeedService] Connected to Fyers data feed (Python bridge)`
- Fyers REST adapter reaches Fyers successfully for valid symbols
- `NSE:RELIANCE-EQ` returns correct EOD candles (e.g. 5 bars for 2026-07-20→2026-07-24)
- Authenticated in-app history requests distinguish valid and invalid symbols: RELIANCE returns candles; ABNINT returns Fyers's `Invalid symbol provided`.
- Terminal `curl` requests without the Electron session return BharatScan `Unauthorized`; they do not test Fyers.

## What is broken / root causes identified

### 1. EOD sync failures (2797/2964 symbols fail)
- Many symbols (ABNINT, AMBANIORGO, AMIABLE, etc.) are **invalid/stale Fyers symbols**
- Fyers returns `{"s":"error","message":"Invalid symbol provided"}` for these
- App currently: loses the Fyers message, logs blank `Failed to sync ABNINT @ 2026-07-23: `, classifies as `BROKER_UNAVAILABLE`
- These should be classified as `INVALID_SYMBOL` and permanently skipped

### 2. Empty-candle coverage bug
- After a fetch returning 0 bars, `updateProgress()` still marks the range as "covered"
- On the next request for that same range, app serves empty SQLite result instead of re-querying Fyers
- Fix: only mark covered when bars.length > 0, or record explicit `NO_DATA` state

### 3. Universe dropdown is localStorage-only
- The screenshot dropdown (NSE All Stock 2723, Nifty50 51, Futures 214, etc.) comes from the uploaded CSV parsed in `artifacts/bharatscan/src/lib/universe.ts`
- Stored in browser/Electron localStorage under `bharatscan:universe-categories`
- NOT stored in SQLite, NOT populated from backend symbol master
- Disappears in a different Electron profile or browser

### 4. No resumable historical backfill
- `eodRetentionYears: 10` means *retention*, not automatic download
- 10 years × 2964 symbols ≈ 29,640 requests; daily budget is ~4,000 — needs multi-day resumable job

## Fix order (agreed with user, do one at a time)
1. ✅ Fyers REST error preservation — DONE (previous session added structured `details` to error responses)
2. ✅ INVALID_SYMBOL classification — new `InvalidSymbolError` class (code: INVALID_SYMBOL, HTTP 422); `classifyAdapterError` detects "Invalid symbol provided" pattern; syncJobs logs at warn+continue instead of error; route returns 422
3. ✅ Fix empty-result / backfill coverage behavior — `updateProgress` now only called when `bars.length > 0` in both inline fetch and background worker; `InvalidSymbolError` added to re-throw list in inline path; background worker logs invalid-symbol chunks at warn+skip
4. ✅ Improve EOD sync summaries — JobStats expanded (noData/invalidSymbol/failed/skippedBudget); runSymbolLoop collects samples silently, emits one structured end-of-loop block; transient errors capped at 10 inline lines; finishSyncLog writes breakdown into error_message; done-logs show all 5 counters
5. ✅ Invalid-symbol persistence and skipping — `fyers_eod_invalid` column added to symbols table (safe ALTER TABLE migration); `markFyersInvalid()` helper updates it; `runSymbolLoop` accepts `onInvalidSymbol` callback; EOD query excludes flagged symbols; startup log shows how many were excluded
6. ✅ Resumable historical backfill job — DONE (committed d5851fa)
7. ✅ Database-backed universe categories — DONE (committed)
8. ⬜ Connect dropdown to backend universe API
9. ⬜ Add tests and verify build

## Key files
- `server/src/adapters/fyers.ts` — REST adapter, error wrapping
- `server/src/services/syncJobs.ts` — EOD sync loop, error handling
- `server/src/services/marketDataService.ts` — history fetch + coverage logic
- `server/src/db/market-schema.ts` — backfill_progress table
- `artifacts/bharatscan/src/lib/universe.ts` — CSV parser
- `artifacts/bharatscan/src/context/DataContext.tsx` — CSV upload handler, localStorage write

## Data directories
- Mac Electron: `~/Library/Application Support/BharatScan/bharatscan-data/` (app.db, market.db, live.db)
- Replit dev: `./data/` (same filenames)
- These are completely separate; code changes in Replit reach Mac only via `git pull`

## Environment boundary and working process
- Application code, schema migrations, tests, and Replit workflows are changed and verified in Replit.
- Mac commands are only for the Mac Electron runtime: installing its Python sidecar dependency, starting Electron, and checking its separate databases.
- After Replit changes are published to the shared Git remote, the Mac app must pull the code and restart; its existing database and broker session remain local.
- Test protected history endpoints from the authenticated Electron app (or provide its session explicitly without printing it), not from a fresh terminal `curl`.
- The user prefers the roadmap to be applied one numbered change at a time, with verification and a report before starting the next change.

**Why:** The Mac Electron process and Replit preview use separate runtimes, sessions, and SQLite files; mixing their logs or assuming shared state produces false diagnoses. Keeping changes incremental makes each Fyers/data fix independently verifiable.

**How to apply:** For future BharatScan work, first identify whether evidence comes from Replit or Mac Electron, preserve the existing fix order unless the user changes it, and never request or store secrets/tokens in diagnostics.

---

## Historical EOD Backfill — user guidance (saved from prior agent conversation)

**Key distinction the user must understand:**
- **Nightly EOD sync** — downloads only the current trading day's candle for each stock. Does NOT download historical years.
- **Historical EOD Backfill** — separate resumable job that downloads older history. Must be manually started from: *Settings → Broker Connect → Backfill Dashboard → Start*.

**Scale on local Electron (full budget):**
- ~2,900 stocks × 10 years × ~1 request/year = ~29,000–32,000 broker requests total
- Local Electron daily budget ≈ 4,000 requests/day → requires ~7–8 days of continuous running
- The job is resumable; data is saved per-chunk so partial progress is never lost

**As of last known Mac state:**
- Only 113,141 bars in `ohlcv_daily` (far less than 10-year full dataset)
- Log showed: `Daily request budget exhausted — stopping catch-up at 0/2` — job paused, not broken
- Backfill status dashboard had a `column index out of range` bug that made it appear "not started" even when a job existed — this bug is fixed in Replit source; Mac must `git pull` to get the fix

**Zero-scan-results checklist (in order of likelihood):**
1. Selected date is outside the saved data range
2. Indicator requires more history than currently exists
3. Selected universe doesn't match loaded symbols
4. Filter conditions genuinely match no stocks
5. Backfill is paused (budget exhausted — resume next day)
6. Database data not yet loaded into scanner
7. Old status bug made backfill appear inactive (fixed — needs `git pull`)

**To check exact Mac DB state (with Electron stopped):**
```
DB="$HOME/Library/Application Support/BharatScan/bharatscan-data/market.db"
sqlite3 "$DB" "SELECT COUNT(*) FROM ohlcv_daily; SELECT MIN(date), MAX(date) FROM ohlcv_daily; SELECT status, pause_reason, requests_used FROM historical_backfill_jobs ORDER BY id DESC LIMIT 1;"
```

**Mac workflow after code changes in Replit:**
```
git pull && pnpm install && pnpm run electron:dev
```
Then check Settings → Broker Connect → Historical EOD Backfill section.
