---
name: live-feed-symbol-resolution-fix
description: Root cause and fix plan for the Fyers WebSocket reconnect storm (invalid -EQ symbols); tracks which steps are done.
---

# Live Feed Symbol Resolution Fix

## Root Cause
liveFeedService.ts had its own local toFyersSymbol() that hardcodes NSE:{symbol}-EQ for all bare tickers.
rankFoSymbolsByPrice() queried bare s.symbol (not s.fyers_symbol), so every SME/BE stock in the
cheapest-first F&O ranking was sent with the wrong suffix → Fyers -300 rejection → reconnect storm.

**Why:** The Prompt 31 fix that corrected symbol resolution for EOD/options sync never touched liveFeedService.ts's
own copy of the naive conversion. It is a protocol-isolated module with its own local toFyersSymbol().

## Fix Plan Status

### Step 1 — DONE
File: server/src/services/liveFeedService.ts
- rankFoSymbolsByPrice() now selects COALESCE(s.fyers_symbol, 'NSE:'||s.symbol||'-EQ') AS resolved_symbol
- autoSubscribeFoSymbols() passes resolved_symbol (already Fyers-formatted) to subscribeSymbols()
- Added startup warning if any is_fo_eligible rows have null fyers_symbol

### Step 2 — DONE
Audit of all other subscribeSymbols() callers:
- liveOptionsTracker.ts:324 — UNDERLYING_TO_FYERS lookup table (hardcoded Fyers symbols) safe
- liveOptionsTracker.ts:218,393 — computeWindowSymbols() returns ceSymbol/peSymbol from broker API safe
- marketData.ts:188 (/subscribe route) — frontend sends Fyers-formatted symbols safe
- marketDataService.ts:835 — FIXED: bare tickers now batch-resolved through symbols.fyers_symbol before subscribeSymbols()

### Step 3 — PENDING
Add in-memory invalid-symbol blacklist (module-level Set<string> fyersInvalidSymbols) in liveFeedService.ts.
When -300 error arrives, add rejected symbols. Filter in subscribeSymbols() before SubscriptionManager.
Defense-in-depth for stocks suspended/delisted mid-session after symbol master refresh.
Use in-memory only (no new DB table needed).

### Step 4 — Covered by Step 1
Startup warning log already added for null fyers_symbol rows.

### Step 5 — PENDING
User verifies on Mac: no -300 errors, no reconnect storm, healthy autoSubscribeFoSymbols log.

## Key Files
- server/src/services/liveFeedService.ts — Step 1 fix; Step 3 pending
- server/src/services/marketDataService.ts — Step 2 fix at line ~835
- server/src/services/liveOptionsTracker.ts — audited, no changes needed
- server/src/routes/marketData.ts — audited, no changes needed
