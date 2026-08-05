/**
 * optionsDataService.ts
 *
 * Orchestrates loading of options intraday history from a connected broker
 * into the options_intraday table.
 *
 * Designed to mirror the patterns in marketDataService.ts:
 *  - Uses the same authenticated adapter
 *  - Respects the shared daily request budget
 *  - Applies the same rate-limit throttle
 *  - Upserts with ON CONFLICT DO UPDATE
 */

import { marketDb } from "../db.js";
import { config } from "../config/environment.js";
import { getAuthenticatedAdapter, throttleCall, checkAndConsumeBudget, getServiceStats, classifyAdapterError } from "./marketDataService.js";
import { AuthenticationError, SessionExpiredError } from "../errors/brokerErrors.js";
import { startSyncLog, finishSyncLog, todayIST } from "./syncJobs.js";
import { isTradingDay } from "./tradingCalendar.js";
import type { Bar, BrokerAdapter } from "../adapters/types.js";

// ── Underlying → Fyers index symbol ──────────────────────────────────────────
// Used when calling getOptionChain / getOptionExpiries on the adapter.

const UNDERLYING_TO_FYERS: Record<string, string> = {
  NIFTY:       "NSE:NIFTY50-INDEX",
  BANKNIFTY:   "NSE:NIFTYBANK-INDEX",
  FINNIFTY:    "NSE:FINNIFTY-INDEX",
  SENSEX:      "BSE:SENSEX-INDEX",
  MIDCPNIFTY:  "NSE:MIDCPNIFTY-INDEX",
};

/** Returns true if the underlying is an index (wider strike range). */
function isIndex(underlying: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNDERLYING_TO_FYERS, underlying.toUpperCase());
}

/** ATM ± N strikes to load (matches config values set in environment.ts). */
function strikeRange(underlying: string): number {
  return isIndex(underlying)
    ? config.indexOptionsStrikeRange   // 30 for indices
    : config.stockOptionsStrikeRange;  // 20 for stocks
}

/**
 * Resolves an underlying name to the broker symbol used for option-chain /
 * expiry lookups. Indices use the fixed Fyers index-symbol map; F&O-eligible
 * stocks use the same "NSE:{SYMBOL}-EQ" convention used everywhere else for
 * equities (dataLoader.ts's toFyersSymbol / syncJobs.ts's toFyersSymbol).
 */
function underlyingFyersSymbol(underlying: string): string {
  const uName = underlying.toUpperCase();
  return UNDERLYING_TO_FYERS[uName] ?? `NSE:${uName}-EQ`;
}

// ── options_intraday upsert ───────────────────────────────────────────────────

function upsertOptionsBars(
  underlying: string,
  expiry: string,
  strike: number,
  optionType: "CE" | "PE",
  bars: Bar[]
): void {
  if (!bars.length) return;

  const stmt = marketDb.prepare(`
    INSERT INTO options_intraday
      (underlying, expiry, strike, option_type, timestamp, open, high, low, close, volume, oi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(underlying, expiry, strike, option_type, timestamp) DO UPDATE SET
      open   = excluded.open,
      high   = excluded.high,
      low    = excluded.low,
      close  = excluded.close,
      volume = excluded.volume,
      oi     = excluded.oi
  `);

  try {
    marketDb.exec("BEGIN");
    for (const b of bars) {
      stmt.run(
        underlying, expiry, strike, optionType,
        b.date,
        b.open, b.high, b.low, b.close, b.volume,
        b.oi ?? null,
      );
    }
    marketDb.exec("COMMIT");
  } catch (e) {
    marketDb.exec("ROLLBACK");
    throw e;
  }
}

// ── Progress callback type ────────────────────────────────────────────────────

export interface OptionsLoadProgress {
  loaded: number;
  total: number;
  current: string;      // symbol currently being fetched
  failed: string[];
}

export type ProgressCallback = (p: OptionsLoadProgress) => void;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return available expiry dates (YYYY-MM-DD) for an underlying from the
 * connected broker.  Relies on the broker's option chain API returning expiry
 * metadata when called without a specific expiry timestamp.
 */
export async function getOptionExpiriesFromBroker(
  underlying: string
): Promise<string[]> {
  const adapter = await getAuthenticatedAdapter();
  if (!adapter) throw new Error("No authenticated broker connected");

  const fyersSymbol = UNDERLYING_TO_FYERS[underlying.toUpperCase()];
  if (!fyersSymbol) throw new Error(`Unknown underlying: ${underlying}`);

  // Check the adapter supports getOptionExpiries (Fyers does, Angel throws)
  const anyAdapter = adapter as unknown as Record<string, unknown>;
  if (typeof anyAdapter.getOptionExpiries !== "function") {
    throw new Error("Connected broker does not support option expiry lookup");
  }
  const getExpiries = anyAdapter.getOptionExpiries as (s: string) => Promise<string[]>;
  return getExpiries.call(adapter, fyersSymbol);
}

export interface LoadOptionsParams {
  underlying: string;
  expiry: string;   // YYYY-MM-DD
  from: string;     // YYYY-MM-DD
  to: string;       // YYYY-MM-DD
}

export interface LoadOptionsResult {
  loaded: number;
  skippedBudget: number;
  failed: string[];
}

/**
 * Main entry point: fetch 1-min option candles for ATM ± N strikes for a
 * given underlying + expiry + date range, and upsert them into options_intraday.
 *
 * Steps:
 *   1. Get option chain for the expiry → spot price + strike symbols
 *   2. Identify ATM strike and select ATM ± range strikes
 *   3. For each (strike, CE/PE): budget-check → throttle → getHistoricalData → upsert
 */
export async function loadOptionsFromBroker(
  params: LoadOptionsParams,
  onProgress: ProgressCallback
): Promise<LoadOptionsResult> {
  const { underlying, expiry, from, to } = params;
  const uName = underlying.toUpperCase();
  const fyersSymbol = UNDERLYING_TO_FYERS[uName];
  if (!fyersSymbol) throw new Error(`Unknown underlying: ${underlying}`);

  const adapter = await getAuthenticatedAdapter();
  if (!adapter) throw new Error("No authenticated broker connected");

  // ── Step 1: Get option chain to find spot price and strike symbols ─────────
  let chain;
  try {
    chain = await adapter.getOptionChain(fyersSymbol, expiry);
  } catch (err) {
    throw new Error(
      `Failed to fetch option chain for ${underlying} expiry ${expiry}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const spot = chain.spotPrice;
  if (!spot || spot <= 0) {
    throw new Error(`Could not determine spot price for ${underlying}. Got: ${spot}`);
  }

  // ── Step 2: Filter to ATM ± N strikes ─────────────────────────────────────
  const range = strikeRange(uName);

  // Find ATM: strike in chain closest to spot
  let atmStrike = chain.strikes[0]?.strike ?? 0;
  let minDist = Infinity;
  for (const s of chain.strikes) {
    const d = Math.abs(s.strike - spot);
    if (d < minDist) { minDist = d; atmStrike = s.strike; }
  }

  const selected = chain.strikes.filter(
    (s) => s.strike >= atmStrike - range * Infinity && // will refine below
      Math.abs(s.strike - atmStrike) <= range * 200    // generous upper bound
  );

  // Select exactly ATM ± range strikes (by position in the sorted list)
  const atmIdx = chain.strikes.findIndex((s) => s.strike === atmStrike);
  const lo = Math.max(0, atmIdx - range);
  const hi = Math.min(chain.strikes.length - 1, atmIdx + range);
  const candidates = chain.strikes.slice(lo, hi + 1);
  void selected; // selected was a rough filter, use candidates instead

  // Build fetch list: (symbol, strike, type) pairs
  interface FetchItem {
    symbol: string;
    strike: number;
    type: "CE" | "PE";
  }
  const items: FetchItem[] = [];
  for (const s of candidates) {
    if (s.ceSymbol) items.push({ symbol: s.ceSymbol, strike: s.strike, type: "CE" });
    if (s.peSymbol) items.push({ symbol: s.peSymbol, strike: s.strike, type: "PE" });
  }

  if (items.length === 0) {
    throw new Error(
      `No option symbols found in chain for ${underlying} expiry ${expiry}. ` +
      `Chain returned ${chain.strikes.length} strikes but none had symbol names. ` +
      "Check that the broker's option chain response includes symbol fields."
    );
  }

  console.log(
    "[optionsDataService] Loading %d option contracts for %s %s ATM=%d spot=%.2f range=±%d",
    items.length, uName, expiry, atmStrike, spot, range
  );

  // ── Step 3: Fetch + upsert each contract ──────────────────────────────────
  const failed: string[] = [];
  let loaded = 0;
  let skippedBudget = 0;

  onProgress({ loaded: 0, total: items.length, current: "", failed: [] });

  for (const item of items) {
    // Budget check
    if (!checkAndConsumeBudget()) {
      console.warn(
        "[optionsDataService] Daily request budget exhausted — stopping options load (%d/%d done)",
        loaded, items.length
      );
      skippedBudget = items.length - loaded - failed.length;
      break;
    }

    onProgress({ loaded, total: items.length, current: item.symbol, failed: [...failed] });

    try {
      const bars = await throttleCall(() =>
        adapter.getHistoricalData(item.symbol, "1", from, to)
      );
      upsertOptionsBars(uName, expiry, item.strike, item.type, bars);
      loaded++;
      console.log(
        "[optionsDataService] ✓ %s %d%s %s→%s (%d bars)",
        item.symbol, item.strike, item.type, from, to, bars.length
      );
    } catch (err) {
      console.error(
        "[optionsDataService] ✗ %s: %s",
        item.symbol, err instanceof Error ? err.message : String(err)
      );
      failed.push(item.symbol);
    }
  }

  onProgress({ loaded, total: items.length, current: "", failed: [...failed] });

  console.log(
    "[optionsDataService] Done: %d loaded, %d failed, %d skipped (budget)",
    loaded, failed.length, skippedBudget
  );

  return { loaded, skippedBudget, failed };
}

// ── Nightly options sync job (5:00 PM IST) ───────────────────────────────────
//
// Draws from the SAME shared daily request budget as the EOD/intraday jobs
// (via checkAndConsumeBudget) — no separate counter. If the budget is already
// exhausted by the time this job runs, it skips gracefully and logs rather
// than erroring.

interface UnderlyingSyncResult {
  completed: number;
  noData: number;
  failed: number;
  budgetExhausted: boolean;
  /** True when Fyers signals its options-chain quota is exhausted for the day. */
  rateLimited?: boolean;
}

// ── Rate-limit helpers ────────────────────────────────────────────────────────

/**
 * "request limit reached" — Fyers' JSON-level response when the options-chain
 * API quota for the session/day is exhausted.  This is a hard stop: continuing
 * would waste all remaining budget calls and still get 0 data.
 */
const HARD_RATE_LIMIT_RE = /request limit reached/i;

/**
 * "Rate limited by Fyers (received HTML instead of JSON)" — the per-second
 * HTTP throttle Fyers applies when we exceed ~8–10 req/s.  This is transient;
 * a short backoff is usually enough.
 */
const SOFT_RATE_LIMIT_RE = /rate limited by fyers/i;

function isHardRateLimit(err: unknown): boolean {
  return HARD_RATE_LIMIT_RE.test(err instanceof Error ? err.message : String(err));
}

function isSoftRateLimit(err: unknown): boolean {
  return SOFT_RATE_LIMIT_RE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Like `throttleCall` but also retries on soft (per-second) rate limits with
 * exponential backoff, and immediately surfaces hard (daily quota) rate limits
 * so callers can stop the job cleanly instead of hammering a dead endpoint.
 *
 * Max two retries: 5 s then 10 s backoff before giving up.
 */
async function throttleWithRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      return await throttleCall(fn);
    } catch (err) {
      // Hard quota: bubble up immediately so the caller can stop the loop.
      if (isHardRateLimit(err)) throw err;
      // Not a soft rate-limit, or we've exhausted retries: rethrow.
      if (!isSoftRateLimit(err) || attempt === 2) throw err;
      const backoffMs = 5_000 * (attempt + 1); // 5 s, then 10 s
      console.warn(
        "[optionsDataService] Fyers soft rate limit on %s (attempt %d/3) — backing off %d ms",
        label, attempt + 1, backoffMs
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw new Error("unreachable");
}

/** Nearest expiry on/after `date` (YYYY-MM-DD); falls back to the last known expiry. */
function pickNearestExpiry(expiries: string[], date: string): string | null {
  if (expiries.length === 0) return null;
  const sorted = [...expiries].sort();
  return sorted.find((e) => e >= date) ?? sorted[sorted.length - 1];
}

/**
 * Fallback spot price lookup from the local SQLite databases.
 *
 * When the Fyers options-chain API returns underlying_ltp = 0 (market closed,
 * weekend catch-up, etc.), we look up the most recent closing price stored
 * in ohlcv_daily (populated by EOD sync) for the given date.  If the symbol
 * isn't in that table (e.g. index symbols which the EOD job doesn't cover),
 * we fall back to the last intraday bar on or before the target date from
 * ohlcv_intraday (populated by live feed / intraday sync).
 *
 * Returns the close price, or null if nothing is available.
 */
function lookupSpotPriceFromDb(fyersSymbol: string, date: string): number | null {
  // 1. Try EOD daily table — most reliable for equity underlyings.
  const eodRow = marketDb
    .prepare(
      `SELECT close FROM ohlcv_daily
        WHERE symbol = ? AND date <= ?
        ORDER BY date DESC LIMIT 1`
    )
    .get(fyersSymbol, date) as { close: number } | undefined;
  if (eodRow && eodRow.close > 0) return eodRow.close;

  // 2. Try intraday table — covers index symbols tracked by the live feed.
  const intradayRow = marketDb
    .prepare(
      `SELECT close FROM ohlcv_intraday
        WHERE symbol = ? AND date(timestamp) <= ?
        ORDER BY timestamp DESC LIMIT 1`
    )
    .get(fyersSymbol, date) as { close: number } | undefined;
  if (intradayRow && intradayRow.close > 0) return intradayRow.close;

  return null;
}

async function syncOptionsForUnderlying(
  adapter: BrokerAdapter,
  underlying: string,
  date: string
): Promise<UnderlyingSyncResult> {
  const uName = underlying.toUpperCase();
  const fyersSymbol = underlyingFyersSymbol(uName);

  const anyAdapter = adapter as unknown as Record<string, unknown>;
  if (typeof anyAdapter.getOptionExpiries !== "function") {
    console.warn("[optionsDataService] Connected broker has no option-expiry lookup — skipping %s", uName);
    return { completed: 0, noData: 0, failed: 0, budgetExhausted: false };
  }

  let expiries: string[];
  try {
    const getExpiries = anyAdapter.getOptionExpiries as (s: string) => Promise<string[]>;
    expiries = await throttleWithRetry(() => getExpiries.call(adapter, fyersSymbol), `${uName} expiries`);
  } catch (err) {
    // Hard quota exhausted — signal the outer loop to stop cleanly.
    if (isHardRateLimit(err)) {
      console.warn("[optionsDataService] Fyers options-chain daily quota reached at %s — stopping job", uName);
      return { completed: 0, noData: 0, failed: 0, budgetExhausted: false, rateLimited: true };
    }
    try { classifyAdapterError(err); } catch (classified) {
      if (classified instanceof AuthenticationError || classified instanceof SessionExpiredError) throw classified;
    }
    console.error("[optionsDataService] Failed to fetch expiries for %s: %s", uName, err instanceof Error ? err.message : String(err));
    return { completed: 0, noData: 0, failed: 1, budgetExhausted: false };
  }

  const expiry = pickNearestExpiry(expiries, date);
  if (!expiry) {
    console.warn("[optionsDataService] No expiries returned for %s — skipping", uName);
    return { completed: 0, noData: 0, failed: 0, budgetExhausted: false };
  }

  let chain;
  try {
    chain = await throttleWithRetry(() => adapter.getOptionChain(fyersSymbol, expiry), `${uName} chain`);
  } catch (err) {
    // Hard quota exhausted — signal the outer loop to stop cleanly.
    if (isHardRateLimit(err)) {
      console.warn("[optionsDataService] Fyers options-chain daily quota reached at %s — stopping job", uName);
      return { completed: 0, noData: 0, failed: 0, budgetExhausted: false, rateLimited: true };
    }
    try { classifyAdapterError(err); } catch (classified) {
      if (classified instanceof AuthenticationError || classified instanceof SessionExpiredError) throw classified;
    }
    console.error("[optionsDataService] Failed to fetch option chain for %s %s: %s", uName, expiry, err instanceof Error ? err.message : String(err));
    return { completed: 0, noData: 0, failed: 1, budgetExhausted: false };
  }

  // Resolve spot price: prefer the live value from the options chain API
  // (works during market hours).  When the market is closed — e.g. a
  // weekend catch-up for a past trading date — the API returns 0, so fall
  // back to the closing price stored in our local database for that date.
  let spot = chain.spotPrice && chain.spotPrice > 0 ? chain.spotPrice : null;
  if (!spot) {
    const dbPrice = lookupSpotPriceFromDb(fyersSymbol, date);
    if (dbPrice) {
      spot = dbPrice;
      console.log(
        "[optionsDataService] %s: API spot=0 (market closed?), using DB close=%.2f for %s",
        uName, spot, date
      );
    } else {
      console.warn(
        "[optionsDataService] No spot price for %s — API returned 0 and no close found in DB for %s. " +
        "Run EOD/intraday sync first so the closing price is available for options ATM selection.",
        uName, date
      );
      return { completed: 0, noData: 0, failed: 0, budgetExhausted: false };
    }
  }

  const range = strikeRange(uName);
  let atmIdx = 0;
  let minDist = Infinity;
  chain.strikes.forEach((s, idx) => {
    const d = Math.abs(s.strike - spot);
    if (d < minDist) { minDist = d; atmIdx = idx; }
  });

  const lo = Math.max(0, atmIdx - range);
  const hi = Math.min(chain.strikes.length - 1, atmIdx + range);
  const candidates = chain.strikes.slice(lo, hi + 1);

  const items: Array<{ symbol: string; strike: number; type: "CE" | "PE" }> = [];
  for (const s of candidates) {
    if (s.ceSymbol) items.push({ symbol: s.ceSymbol, strike: s.strike, type: "CE" });
    if (s.peSymbol) items.push({ symbol: s.peSymbol, strike: s.strike, type: "PE" });
  }

  if (items.length === 0) {
    console.warn("[optionsDataService] No option symbols in chain for %s %s — skipping", uName, expiry);
    return { completed: 0, noData: 0, failed: 0, budgetExhausted: false };
  }

  console.log(
    "[optionsDataService] Nightly sync: %d contracts for %s %s (ATM=%d spot=%.2f range=±%d)",
    items.length, uName, expiry, chain.strikes[atmIdx]?.strike ?? 0, spot, range
  );

  let completed = 0;
  let noData = 0;
  let failed = 0;
  let budgetExhausted = false;

  for (const item of items) {
    if (!checkAndConsumeBudget()) {
      budgetExhausted = true;
      break;
    }
    try {
      const bars = await throttleCall(() => adapter.getHistoricalData(item.symbol, "1", date, date));
      upsertOptionsBars(uName, expiry, item.strike, item.type, bars);
      if (bars.length > 0) {
        completed++;
      } else {
        // No candle for this date (e.g. contract didn't trade) — not a
        // failure, just nothing to report.
        noData++;
      }
    } catch (err) {
      failed++;
      console.error("[optionsDataService] ✗ %s: %s", item.symbol, err instanceof Error ? err.message : String(err));
    }
  }

  return { completed, noData, failed, budgetExhausted };
}

function monthsAgoIso(months: number): string {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.toISOString();
}

/**
 * Retention cleanup for options_intraday, split by index vs. stock
 * underlying since they have separate retention windows. A retention of 0
 * months means "don't keep any" — delete everything in that bucket.
 */
function cleanupOldOptionsRows(): void {
  const indexNames = Object.keys(UNDERLYING_TO_FYERS);
  const placeholders = indexNames.map(() => "?").join(",");

  if (config.indexOptionsRetentionMonths <= 0) {
    const result = marketDb
      .prepare(`DELETE FROM options_intraday WHERE underlying IN (${placeholders})`)
      .run(...indexNames);
    if (Number(result.changes) > 0) {
      console.log(`[optionsDataService] Index options cleanup: removed all ${result.changes} rows (0-month retention)`);
    }
  } else {
    const cutoff = monthsAgoIso(config.indexOptionsRetentionMonths);
    const result = marketDb
      .prepare(`DELETE FROM options_intraday WHERE underlying IN (${placeholders}) AND timestamp < ?`)
      .run(...indexNames, cutoff);
    if (Number(result.changes) > 0) {
      console.log(`[optionsDataService] Index options cleanup: removed ${result.changes} rows older than ${cutoff}`);
    }
  }

  if (config.stockOptionsRetentionMonths <= 0) {
    const result = marketDb
      .prepare(`DELETE FROM options_intraday WHERE underlying NOT IN (${placeholders})`)
      .run(...indexNames);
    if (Number(result.changes) > 0) {
      console.log(`[optionsDataService] Stock options cleanup: removed all ${result.changes} rows (0-month retention)`);
    }
  } else {
    const cutoff = monthsAgoIso(config.stockOptionsRetentionMonths);
    const result = marketDb
      .prepare(`DELETE FROM options_intraday WHERE underlying NOT IN (${placeholders}) AND timestamp < ?`)
      .run(...indexNames, cutoff);
    if (Number(result.changes) > 0) {
      console.log(`[optionsDataService] Stock options cleanup: removed ${result.changes} rows older than ${cutoff}`);
    }
  }
}

export interface OptionsSyncStats {
  completed: number;
  noData: number;
  failed: number;
  skippedBudget: number;
  skippedNoAdapter?: boolean;
}

/**
 * Nightly options sync — for each configured index (config.optionsIndices)
 * and, when config.includeStockOptions is true, every F&O-eligible stock:
 * fetches today's ATM ± range 1-min option candles (CE + PE) for the
 * nearest expiry and upserts into options_intraday. Applies retention
 * cleanup after the fetch loop. Shares the same daily request budget as the
 * EOD/intraday jobs — if it's already exhausted, skips gracefully.
 */
export async function runOptionsSyncJob(
  targetDate: string = todayIST()
): Promise<OptionsSyncStats> {
  const date = targetDate;
  const logId = startSyncLog("options_sync", date);

  try {
    const adapter = await getAuthenticatedAdapter();
    if (!adapter) {
      console.warn("[optionsDataService] Nightly options sync skipped — no broker connected");
      finishSyncLog(logId, "failed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 }, "No broker connected");
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0, skippedNoAdapter: true };
    }

    if (getServiceStats().remainingBudgetToday <= 0) {
      console.warn("[optionsDataService] Nightly options sync skipped — daily request budget already exhausted");
      finishSyncLog(logId, "completed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 }, "Daily request budget already exhausted");
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0 };
    }

    if (!isTradingDay(date)) {
      console.log("[optionsDataService] %s is not a trading day — skipping options sync, 0 budget spent", date);
      finishSyncLog(logId, "completed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 });
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0 };
    }

    const underlyings: string[] = [...config.optionsIndices];
    if (config.includeStockOptions) {
      const stockRows = marketDb
        .prepare(`SELECT symbol FROM symbols WHERE is_delisted = 0 AND is_fo_eligible = 1`)
        .all() as unknown as Array<{ symbol: string }>;
      underlyings.push(...stockRows.map((r) => r.symbol));
    }

    console.log(
      "[optionsDataService] Nightly options sync starting — %d underlyings for %s (stocks included: %s)",
      underlyings.length, date, config.includeStockOptions
    );

    let completed = 0;
    let noData = 0;
    let failed = 0;
    let skippedBudget = 0;
    let budgetExhausted = false;

    for (const underlying of underlyings) {
      if (budgetExhausted) {
        skippedBudget++;
        continue;
      }

      let result: UnderlyingSyncResult;
      try {
        result = await syncOptionsForUnderlying(adapter, underlying, date);
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof SessionExpiredError) {
          console.error(
            "[optionsDataService] Broker session unavailable mid-job (%s) — stopping cleanly",
            err.message
          );
          break;
        }
        throw err;
      }
      completed += result.completed;
      noData += result.noData;
      failed += result.failed;

      if (result.rateLimited) {
        // Fyers' options-chain daily quota is exhausted — count all remaining
        // underlyings as skipped and stop immediately to avoid wasting budget.
        skippedBudget += underlyings.length - underlyings.indexOf(underlying) - 1;
        console.warn(
          "[optionsDataService] Options-chain rate limit hit at %s — %d remaining underlyings skipped",
          underlying,
          underlyings.length - underlyings.indexOf(underlying) - 1
        );
        break;
      }

      if (result.budgetExhausted) {
        budgetExhausted = true;
        skippedBudget++;
        console.warn(
          "[optionsDataService] Daily request budget exhausted mid-job at %s — stopping cleanly",
          underlying
        );
      }

      // Pause between underlyings to stay well within Fyers' per-minute
      // options-chain rate limit.  The per-call throttle (125 ms) handles
      // individual requests; this inter-underlying delay prevents the burst
      // of 2+ calls per underlying from tripping the endpoint's quota.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Retention cleanup is handled centrally by cleanupJob.ts (6 PM IST).

    const stats = { completed, noData, skippedBudget, failed };
    if (completed === 0 && underlyings.length > 0) {
      finishSyncLog(logId, "failed", stats, "All underlyings failed — 0 of " + underlyings.length + " completed");
    } else {
      finishSyncLog(logId, "completed", stats);
    }
    console.log(
      "[optionsDataService] Nightly options sync done — completed=%d noData=%d skippedBudget=%d failed=%d",
      completed, noData, skippedBudget, failed
    );
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishSyncLog(logId, "failed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 }, message);
    console.error("[optionsDataService] Nightly options sync crashed:", message);
    throw err;
  }
}
