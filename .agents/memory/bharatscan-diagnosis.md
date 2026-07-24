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
5. ⬜ Invalid-symbol persistence and skipping (exclude from future EOD runs)
6. ⬜ Resumable historical backfill job
7. ⬜ Database-backed universe categories (persist CSV import to SQLite)
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

**Why:** Keeping this so future sessions don't re-diagnose what's already proven.
