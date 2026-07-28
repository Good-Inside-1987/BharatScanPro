/**
 * marketDataService.ts
 *
 * THE single gateway between the rest of the backend and any broker adapter.
 * Routes and scanner code must call this service; they must never import
 * adapter modules directly.
 *
 * Responsibilities
 * ─────────────────
 * 1. getHistoricalBars  — cache-first OHLCV access; fetches & upserts missing
 *                         ranges from the connected broker, chunk by chunk.
 * 2. getLiveQuotes      — thin proxy to the connected adapter's getQuotes().
 *                         (WebSocket-based live cache is wired in the next step.)
 * 3. Rate-limit pacing  — hard cap of MAX_RPS requests/second (stays safely
 *                         below Fyers' 10/sec ceiling).
 * 4. Daily budget       — configurable via config.backfillDailyRequestBudget;
 *                         resets at midnight IST; backfill pauses when exhausted.
 * 5. backfill_progress  — every completed chunk writes its coverage immediately
 *                         so progress survives process restarts.  Coverage is
 *                         stored as a JSON array of {from,to} intervals so that
 *                         holes left by failed chunks remain detectable after
 *                         later chunks succeed.
 */

import { marketDb, appDb } from "../db.js";
import { getAdapter } from "../adapters/index.js";
import type { BrokerAdapter, Bar, Quote } from "../adapters/types.js";
import { decrypt } from "../lib/encryption.js";
import { config } from "../config/environment.js";
import {
  AuthenticationError,
  FyersApiError,
  SessionExpiredError,
  RateLimitError,
  BrokerUnavailableError,
  InvalidSymbolError,
  type BrokerErrorDetails,
} from "../errors/brokerErrors.js";
import { getLiveQuote, subscribeSymbols } from "./liveFeedService.js";

// ── Internal row types ────────────────────────────────────────────────────────

interface BrokerConnectionRow {
  id: string;
  broker_name: string;
  api_key: string;
  access_token: string | null;
  token_generated_at: string | null;
  status: string;
}

// ── Interval helpers ──────────────────────────────────────────────────────────

type DateRange = { from: string; to: string };

/**
 * Merge a new interval into a sorted, non-overlapping list.
 * Both inputs and output are sorted by `from`.
 */
function mergeIntervals(ranges: DateRange[], newRange: DateRange): DateRange[] {
  const all = [...ranges, newRange].sort((a, b) => a.from.localeCompare(b.from));
  const merged: DateRange[] = [];
  for (const r of all) {
    if (!merged.length) {
      merged.push({ ...r });
      continue;
    }
    const last = merged[merged.length - 1];
    if (r.from <= last.to) {
      // Overlapping or touching — extend the current interval
      if (r.to > last.to) last.to = r.to;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * Return the sub-ranges of [from, to] NOT covered by any interval in the list.
 */
function computeGaps(covered: DateRange[], from: string, to: string): DateRange[] {
  if (!covered.length) return [{ from, to }];

  const gaps: DateRange[] = [];
  let cursor = from;

  for (const interval of covered) {
    if (cursor >= to) break;
    if (interval.to < cursor) continue;         // entirely before cursor — skip
    if (interval.from > cursor) {
      // Gap between cursor and the start of this covered interval
      const gapTo = interval.from < to ? interval.from : to;
      if (cursor < gapTo) gaps.push({ from: cursor, to: gapTo });
    }
    if (interval.to > cursor) cursor = interval.to;
  }

  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

// ── Rate-limit pacing ─────────────────────────────────────────────────────────

const MAX_RPS = 8;                                    // Fyers cap = 10; stay 20 % under
const MIN_INTERVAL_MS = Math.ceil(1000 / MAX_RPS);   // 125 ms between calls

let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  return fn();
}

/**
 * Exported for use by sibling services (e.g. optionsDataService).
 * Applies the same rate-limit pacing as the internal throttle function.
 */
export async function throttleCall<T>(fn: () => Promise<T>): Promise<T> {
  return throttle(fn);
}

/**
 * Exported for use by sibling services.
 * Increments the daily counter and returns true when budget is still available.
 */
export { consumeBudget as checkAndConsumeBudget };

/**
 * Exported for use by sibling services.
 * Returns the authenticated broker adapter, or null if none is available.
 */
export { getAuthenticatedAdapter };

// ── In-memory TTL cache for getHistoricalBars results ─────────────────────────
// Prevents redundant DB reads and broker calls when many scanner symbols
// request overlapping ranges in quick succession (e.g. a full-universe scan).

const BARS_CACHE_TTL_MS = 7_000; // 7 s — short enough to stay fresh, long enough to absorb burst

interface BarsCacheEntry { bars: Bar[]; expiresAt: number }
const barsCache = new Map<string, BarsCacheEntry>();

function barsCacheKey(symbol: string, resolution: string, from: string, to: string): string {
  return `${symbol}|${resolution}|${from}|${to}`;
}

function barsFromCache(key: string): Bar[] | null {
  const entry = barsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { barsCache.delete(key); return null; }
  return entry.bars;
}

function storeBarsInCache(key: string, bars: Bar[]): void {
  barsCache.set(key, { bars, expiresAt: Date.now() + BARS_CACHE_TTL_MS });
}

// ── Adapter error classifier ───────────────────────────────────────────────────
// Translates generic Error messages thrown by adapters into typed broker errors.

function markSessionExpired(): void {
  appDb.prepare(
    `UPDATE broker_connections SET status = 'session_expired', updated_at = ?
     WHERE status = 'connected'`
  ).run(new Date().toISOString());
}

export function classifyAdapterError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const details: BrokerErrorDetails | undefined =
    err instanceof FyersApiError ? err.details : undefined;

  const isNetwork =
    err instanceof TypeError ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network error/i.test(message);
  if (isNetwork) throw new BrokerUnavailableError(message, details);

  if (/rate.?limit|too.?many.?request|429/i.test(message)) {
    throw new RateLimitError(message, 60_000, details);
  }

  if (/not configured|session|expired|unauthori[sz]|invalid.?(token|key|credentials)|please provide valid|forbidden|could not authenticate/i.test(message)) {
    markSessionExpired();
    throw new SessionExpiredError(message, details);
  }

  // Permanent per-symbol rejection — not a transient broker outage.
  // Fyers returns {"s":"error","message":"Invalid symbol provided"} for unknown/delisted symbols.
  if (/invalid.?symbol|symbol.?not.?found|no.?data.?found.?for.?symbol|symbol.?does.?not.?exist/i.test(message)) {
    throw new InvalidSymbolError(message, details);
  }

  // Treat anything else as a generic broker unavailability (preserves old 503 behaviour)
  throw new BrokerUnavailableError(message, details);
}

// ── Auth state helper ──────────────────────────────────────────────────────────
// Inspects the DB to distinguish "never connected" from "token expired" so the
// public API functions can throw the most informative typed error.

interface ConnectedRow { token_generated_at: string | null }

function noAdapterReason(): AuthenticationError | SessionExpiredError {
  const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
  const row = appDb
    .prepare(
      `SELECT token_generated_at FROM broker_connections
        WHERE status IN ('connected','session_expired')
        ORDER BY token_generated_at DESC LIMIT 1`
    )
    .get() as unknown as ConnectedRow | undefined;

  if (row?.token_generated_at) {
    const age = Date.now() - new Date(row.token_generated_at).getTime();
    if (age > TOKEN_TTL_MS) return new SessionExpiredError();
  }
  return new AuthenticationError();
}

// ── Daily request budget ──────────────────────────────────────────────────────
// Persisted in market.db (request_budget table) rather than an in-memory
// variable — on Replit the process can sleep/wake (and thus restart) many
// times within a single calendar day, which would otherwise silently reset
// the counter and let backfill blow past the broker's real rate limit even
// though the dashboard shows budget remaining.

// ── Live quote cache-hit / REST-fallback diagnostics ───────────────────────────

const quoteStats = {
  totalRequests:        0,
  requestsFullyCached:  0,
  requestsWithFallback: 0,
  cacheHitSymbols:      0,
  restFallbackSymbols:  0,
  restCallsMade:        0,
};

/** Resets all live-quote cache-hit / REST-fallback counters to zero. */
export function resetQuoteCacheStats() {
  quoteStats.totalRequests = 0;
  quoteStats.requestsFullyCached = 0;
  quoteStats.requestsWithFallback = 0;
  quoteStats.cacheHitSymbols = 0;
  quoteStats.restFallbackSymbols = 0;
  quoteStats.restCallsMade = 0;
}

/** Snapshot of live-quote cache-hit vs REST-fallback counters since process start. */
export function getQuoteCacheStats() {
  const totalSymbols = quoteStats.cacheHitSymbols + quoteStats.restFallbackSymbols;
  return {
    ...quoteStats,
    cacheHitRate: totalSymbols > 0 ? quoteStats.cacheHitSymbols / totalSymbols : null,
  };
}

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

/** Ensures a request_budget row exists for the given IST date (starts at 0). */
function ensureBudgetRow(date: string): void {
  marketDb
    .prepare(`INSERT INTO request_budget (date, count) VALUES (?, 0) ON CONFLICT(date) DO NOTHING`)
    .run(date);
}

/** Current persisted count for the given IST date (creating the row if needed). */
function getBudgetCount(date: string): number {
  ensureBudgetRow(date);
  const row = marketDb
    .prepare(`SELECT count FROM request_budget WHERE date = ?`)
    .get(date) as { count: number };
  return row.count;
}

/**
 * Increments the persisted daily counter and returns true when budget is still available.
 *
 * The increment is a single atomic UPDATE (rather than a separate SELECT-then-UPDATE) so
 * two different OS processes sharing the same market.db file (the Oracle standalone
 * scheduler and the main web server) can't both read the same pre-increment count and
 * both proceed — SQLite serializes writes to the file at the engine level, so this
 * conditional increment is atomic regardless of which process issues it.
 */
function consumeBudget(): boolean {
  const today = todayIST();
  ensureBudgetRow(today);
  const result = marketDb
    .prepare(`UPDATE request_budget SET count = count + 1 WHERE date = ? AND count < ?`)
    .run(today, config.backfillDailyRequestBudget);
  return Number(result.changes) > 0;
}

// ── Authenticated adapter cache ───────────────────────────────────────────────
// Keyed by broker_connections.id.  Populated either via registerAdapter()
// (called immediately after a successful login in the broker-connections route)
// or reconstructed from the DB using configureSession() on next access.

const adapterCache = new Map<string, { adapter: BrokerAdapter; expiresAt: number }>();

/**
 * Register a pre-authenticated adapter so the service can use it immediately.
 * Call this right after adapter.login() succeeds in the broker-connections route
 * to avoid re-authentication on the first backfill request.
 */
export function registerAdapter(
  connectionId: string,
  adapter: BrokerAdapter,
  tokenGeneratedAt: string
): void {
  const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
  const expiresAt = new Date(tokenGeneratedAt).getTime() + TOKEN_TTL_MS;
  adapterCache.set(connectionId, { adapter, expiresAt });
  console.log("[marketDataService] Adapter registered for connection %s", connectionId);
}

/**
 * Looks up the most-recently-connected broker, decrypts its credentials,
 * and configures the adapter's internal session state using configureSession()
 * (both current adapters expose this for stored-token reuse without TOTP).
 * Returns null — without throwing — when no usable session exists.
 */
async function getAuthenticatedAdapter(): Promise<BrokerAdapter | null> {
  const row = appDb
    .prepare(
      `SELECT id, broker_name, api_key, access_token, token_generated_at, status
         FROM broker_connections
        WHERE status = 'connected'
        ORDER BY token_generated_at DESC
        LIMIT 1`
    )
    .get() as unknown as BrokerConnectionRow | undefined;

  if (!row?.access_token || !row.token_generated_at) return null;

  // Treat tokens older than 23 h as stale (broker TTL is 24 h)
  const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
  const tokenAge = Date.now() - new Date(row.token_generated_at).getTime();
  if (tokenAge > TOKEN_TTL_MS) {
    adapterCache.delete(row.id);
    return null;
  }

  // Return the cached instance if it has not expired
  const hit = adapterCache.get(row.id);
  if (hit && Date.now() < hit.expiresAt) return hit.adapter;

  // Build a fresh adapter and configure its session from the stored token.
  // Both current adapters (Fyers, Angel One) expose configureSession(apiKey, token)
  // for exactly this purpose — reusing a valid session without re-authentication.
  try {
    const adapter = getAdapter(row.broker_name);
    const apiKey      = decrypt(row.api_key);
    const accessToken = decrypt(row.access_token);

    // Duck-type check: prefer configureSession() over refreshSession()
    const anyAdapter = adapter as unknown as Record<string, unknown>;
    if (typeof anyAdapter.configureSession === "function") {
      (anyAdapter.configureSession as (k: string, t: string) => void)(apiKey, accessToken);
    } else {
      // Fallback for adapters with a token-refresh flow (e.g. OAuth refresh tokens)
      await adapter.refreshSession(accessToken);
    }

    const expiresAt = new Date(row.token_generated_at).getTime() + TOKEN_TTL_MS;
    adapterCache.set(row.id, { adapter, expiresAt });
    return adapter;
  } catch (err) {
    adapterCache.delete(row.id);
    console.warn(
      "[marketDataService] Could not configure adapter for %s: %s",
      row.broker_name,
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function isDaily(resolution: string): boolean {
  return resolution === "1D";
}

/** Upsert a batch of bars in a single transaction (daily or intraday). */
function upsertBars(symbol: string, resolution: string, bars: Bar[]): void {
  if (!bars.length) return;

  if (isDaily(resolution)) {
    const stmt = marketDb.prepare(`
      INSERT INTO ohlcv_daily (symbol, date, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, date) DO UPDATE SET
        open = excluded.open, high = excluded.high,
        low  = excluded.low,  close = excluded.close,
        volume = excluded.volume
    `);
    try {
      marketDb.exec("BEGIN");
      // Normalize to plain YYYY-MM-DD — the Fyers adapter returns full ISO
      // timestamps (e.g. "2026-07-23T00:00:00.000Z") for daily bars. Storing
      // the raw timestamp breaks BETWEEN queries that use plain date strings,
      // causing isEodCovered() to always return false and stats.completed to
      // stay 0. Only the daily table needs this; intraday legitimately uses
      // full timestamps.
      for (const b of bars) stmt.run(symbol, b.date.slice(0, 10), b.open, b.high, b.low, b.close, b.volume);
      marketDb.exec("COMMIT");
    } catch (e) { marketDb.exec("ROLLBACK"); throw e; }
  } else {
    const stmt = marketDb.prepare(`
      INSERT INTO ohlcv_intraday (symbol, timestamp, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, timestamp) DO UPDATE SET
        open = excluded.open, high = excluded.high,
        low  = excluded.low,  close = excluded.close,
        volume = excluded.volume
    `);
    try {
      marketDb.exec("BEGIN");
      for (const b of bars) stmt.run(symbol, b.date, b.open, b.high, b.low, b.close, b.volume);
      marketDb.exec("COMMIT");
    } catch (e) { marketDb.exec("ROLLBACK"); throw e; }
  }
}

/** Read cached bars for a date range. */
function queryBars(symbol: string, resolution: string, from: string, to: string): Bar[] {
  if (isDaily(resolution)) {
    return marketDb
      .prepare(
        `SELECT date, open, high, low, close, volume
           FROM ohlcv_daily
          WHERE symbol = ? AND date BETWEEN ? AND ?
          ORDER BY date`
      )
      .all(symbol, from, to) as unknown as Bar[];
  }
  return marketDb
    .prepare(
      `SELECT timestamp AS date, open, high, low, close, volume
         FROM ohlcv_intraday
        WHERE symbol = ? AND timestamp BETWEEN ? AND ?
        ORDER BY timestamp`
    )
    .all(symbol, from, to) as unknown as Bar[];
}

/**
 * Merge the newly covered [from, to] interval into the persistent coverage
 * list for (symbol, resolution).  Called immediately after every successful
 * chunk so progress is durable across restarts.
 */
function updateProgress(symbol: string, resolution: string, from: string, to: string): void {
  const now = new Date().toISOString();

  const row = marketDb
    .prepare(
      "SELECT covered_ranges FROM backfill_progress WHERE symbol = ? AND resolution = ?"
    )
    .get(symbol, resolution) as unknown as { covered_ranges: string } | undefined;

  const existing: DateRange[] = JSON.parse(row?.covered_ranges ?? "[]") as DateRange[];
  const merged = mergeIntervals(existing, { from, to });

  marketDb.prepare(`
    INSERT INTO backfill_progress (symbol, resolution, covered_ranges, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol, resolution) DO UPDATE SET
      covered_ranges = excluded.covered_ranges,
      updated_at     = excluded.updated_at
  `).run(symbol, resolution, JSON.stringify(merged), now);
}

/**
 * Return the sub-ranges of [from, to] not yet covered in backfill_progress
 * for this (symbol, resolution) pair.  Uses the full interval list — not just
 * a min/max window — so holes left by failed chunks remain visible.
 */
function gapsFor(
  symbol: string,
  resolution: string,
  from: string,
  to: string
): DateRange[] {
  const row = marketDb
    .prepare(
      "SELECT covered_ranges FROM backfill_progress WHERE symbol = ? AND resolution = ?"
    )
    .get(symbol, resolution) as unknown as { covered_ranges: string } | undefined;

  const covered: DateRange[] = JSON.parse(row?.covered_ranges ?? "[]") as DateRange[];
  return computeGaps(covered, from, to);
}

/**
 * Read-only coverage snapshot for durable jobs and diagnostics. This does not
 * contact the broker or consume the daily request budget.
 */
export function getHistoricalCoverage(
  symbol: string,
  resolution: string,
  from: string,
  to: string
): { covered: DateRange[]; gaps: DateRange[] } {
  const row = marketDb
    .prepare(
      "SELECT covered_ranges FROM backfill_progress WHERE symbol = ? AND resolution = ?"
    )
    .get(symbol, resolution) as unknown as { covered_ranges: string } | undefined;
  const covered = JSON.parse(row?.covered_ranges ?? "[]") as DateRange[];
  return { covered, gaps: computeGaps(covered, from, to) };
}

// ── Chunk sizing ──────────────────────────────────────────────────────────────
// Windows sized to match the adapter's own real per-request limits (see
// fyers.ts maxDaysForResolution), with a small safety margin. The adapter
// already chunks internally up to those limits, so there's no need for
// marketDataService to hand it smaller gaps than it can actually handle.

const INTRADAY_MINUTE_RESOLUTIONS = new Set([
  "1", "2", "3", "5", "10", "15", "20", "30", "45", "60", "120", "180", "240",
]);

function isSecondResolution(resolution: string): boolean {
  return /S$/i.test(resolution);
}

const CHUNK_DAYS: Record<string, number> = {
  "1D": 365,
};

function chunkDaysForResolution(resolution: string): number {
  if (resolution in CHUNK_DAYS) return CHUNK_DAYS[resolution];
  if (isSecondResolution(resolution)) return 28;
  if (INTRADAY_MINUTE_RESOLUTIONS.has(resolution)) return 95;
  return 28;
}

function chunkRange(from: string, to: string, resolution: string): DateRange[] {
  const days = chunkDaysForResolution(resolution);
  const chunks: DateRange[] = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    const tail = new Date(cur);
    tail.setDate(tail.getDate() + days - 1);
    if (tail > end) tail.setTime(end.getTime());
    chunks.push({ from: cur.toISOString().slice(0, 10), to: tail.toISOString().slice(0, 10) });
    cur = new Date(tail);
    cur.setDate(cur.getDate() + 1);
  }
  return chunks;
}

// ── Backfill queue ────────────────────────────────────────────────────────────

interface BackfillTask {
  symbol:     string;
  resolution: string;
  from:       string;
  to:         string;
}

const queue: BackfillTask[] = [];
let workerRunning = false;

async function runWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length) {
      // ── 1. Check adapter FIRST — do not burn budget if none is available ──
      const adapter = await getAuthenticatedAdapter();
      if (!adapter) {
        console.warn("[marketDataService] No authenticated adapter — halting backfill worker");
        break; // leave tasks in queue; next getHistoricalBars call will retry
      }

      // ── 2. Check daily budget ─────────────────────────────────────────────
      if (!consumeBudget()) {
        console.warn(
          "[marketDataService] Daily request budget (%d) exhausted — backfill paused until %s IST",
          config.backfillDailyRequestBudget,
          todayIST()
        );
        break; // tasks remain in queue; worker exits until budget resets
      }

      const task = queue.shift()!;

      try {
        await throttle(async () => {
          const bars = await adapter.getHistoricalData(
            task.symbol, task.resolution, task.from, task.to
          );
          upsertBars(task.symbol, task.resolution, bars);
          // Only mark covered when bars were actually received — same rule as
          // the inline fetch path. A 0-bar reply leaves the gap open so the
          // next request can retry rather than permanently serving empty data.
          if (bars.length > 0) {
            updateProgress(task.symbol, task.resolution, task.from, task.to);
          }
          console.log(
            "[marketDataService] ✓ backfill %s %s %s→%s  (%d bars)",
            task.symbol, task.resolution, task.from, task.to, bars.length
          );
        });
      } catch (err) {
        // Invalid symbol is a permanent per-symbol condition — log at warn and
        // skip. The gap is intentionally left uncovered so the symbol can be
        // excluded by higher-level logic (Change #5) rather than wasting budget
        // on permanent retries. All other errors are transient; log at error
        // level and leave the gap open for the next backfill attempt.
        if (err instanceof InvalidSymbolError) {
          console.warn(
            "[marketDataService] Invalid symbol — skipping backfill chunk %s %s %s→%s: %s",
            task.symbol, task.resolution, task.from, task.to, err.message
          );
        } else {
          console.error(
            "[marketDataService] Chunk failed %s %s %s→%s: %s",
            task.symbol, task.resolution, task.from, task.to,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }
  } finally {
    workerRunning = false;
  }
}

function enqueue(tasks: BackfillTask[]): void {
  queue.push(...tasks);
  void runWorker();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV bars for a symbol between fromDate and toDate (ISO date strings
 * "YYYY-MM-DD").  Returns cached data immediately; any uncovered sub-ranges are
 * fetched from the connected broker — first chunk inline for a fresh response,
 * remaining chunks queued for background processing.
 *
 * Results are held in a short in-memory TTL cache (7 s) so that burst calls
 * from scanner/backtest loops for the same symbol+range hit the DB only once.
 *
 * Throws typed broker errors (AuthenticationError, SessionExpiredError,
 * RateLimitError, BrokerUnavailableError) when an inline broker fetch is
 * needed but cannot be completed, so routes can return distinct HTTP codes.
 */
export async function getHistoricalBars(
  symbol: string,
  resolution: string,
  fromDate: string,
  toDate: string
): Promise<Bar[]> {
  // ── 1. TTL cache hit ──────────────────────────────────────────────────────
  const cacheKey = barsCacheKey(symbol, resolution, fromDate, toDate);
  const cached = barsFromCache(cacheKey);
  if (cached) return cached;

  // ── 2. Check for uncovered gaps ───────────────────────────────────────────
  const gaps = gapsFor(symbol, resolution, fromDate, toDate);

  if (gaps.length > 0) {
    const adapter = await getAuthenticatedAdapter();

    if (!adapter) {
      // Throw a typed error so the route can return 401 vs. generic 503
      throw noAdapterReason();
    }

    const allChunks = gaps.flatMap((g) => chunkRange(g.from, g.to, resolution));
    const [first, ...rest] = allChunks;

    // Fetch the first chunk synchronously so the caller gets fresh data now
    if (first && consumeBudget()) {
      // Let typed errors propagate to the caller (route maps → HTTP code).
      // The background worker has its own try/catch and continues regardless.
      await throttle(async () => {
        try {
          const bars = await adapter.getHistoricalData(
            symbol, resolution, first.from, first.to
          );
          upsertBars(symbol, resolution, bars);
          // Only mark the range as covered when the broker actually returned
          // bars. A 0-bar response means the data is genuinely absent for that
          // window (e.g. a mid-session request before market close, or a
          // transient empty reply). Marking it covered would prevent any future
          // retry, causing the API to permanently serve an empty DB result.
          if (bars.length > 0) {
            updateProgress(symbol, resolution, first.from, first.to);
          }
          console.log(
            "[marketDataService] ✓ inline fetch %s %s %s→%s  (%d bars)",
            symbol, resolution, first.from, first.to, bars.length
          );
        } catch (err) {
          // Already a typed error? Re-throw as-is.
          if (
            err instanceof AuthenticationError ||
            err instanceof SessionExpiredError ||
            err instanceof RateLimitError ||
            err instanceof BrokerUnavailableError ||
            err instanceof InvalidSymbolError
          ) throw err;
          // Generic adapter error → classify into a typed error and throw.
          classifyAdapterError(err);
        }
      });
    }

    // Enqueue remaining chunks for background processing
    if (rest.length) {
      enqueue(rest.map((c) => ({ symbol, resolution, from: c.from, to: c.to })));
    }
  }

  // ── 3. Read from DB and populate TTL cache ────────────────────────────────
  const bars = queryBars(symbol, resolution, fromDate, toDate);
  storeBarsInCache(cacheKey, bars);
  return bars;
}

/**
 * Fetch exactly one durable backfill chunk.
 *
 * Unlike getHistoricalBars(), this never enqueues additional work in the
 * process-local queue. Historical backfill owns its own persisted task ledger,
 * so one call maps to one persisted task and can be resumed safely after a
 * restart.
 */
export async function fetchHistoricalChunk(
  symbol: string,
  resolution: string,
  fromDate: string,
  toDate: string,
  onRequestConsumed?: () => void
): Promise<Bar[]> {
  const adapter = await getAuthenticatedAdapter();
  if (!adapter) throw noAdapterReason();
  if (!consumeBudget()) {
    throw new RateLimitError(
      "Daily request budget exhausted; historical backfill is paused until the next IST day.",
      60_000
    );
  }
  onRequestConsumed?.();

  return throttle(async () => {
    try {
      const bars = await adapter.getHistoricalData(symbol, resolution, fromDate, toDate);
      upsertBars(symbol, resolution, bars);
      if (bars.length > 0) {
        updateProgress(symbol, resolution, fromDate, toDate);
      }
      return bars;
    } catch (err) {
      if (
        err instanceof AuthenticationError ||
        err instanceof SessionExpiredError ||
        err instanceof RateLimitError ||
        err instanceof BrokerUnavailableError ||
        err instanceof InvalidSymbolError
      ) {
        throw err;
      }
      classifyAdapterError(err);
    }
  });
}

/**
 * Fetch live quotes, preferring the WebSocket tick cache (liveFeedService)
 * and falling back to a single REST call — for only the symbols missing
 * from the cache — via the connected broker adapter. Symbols fetched via
 * REST are subscribed to the live feed so subsequent calls hit the cache.
 * Throws typed broker errors (AuthenticationError, SessionExpiredError,
 * RateLimitError, BrokerUnavailableError) so routes can return distinct
 * HTTP status codes.
 */
export async function getLiveQuotes(symbols: string[]): Promise<Quote[]> {
  if (!symbols.length) return [];

  quoteStats.totalRequests++;

  // ── 1. Serve from the WebSocket tick cache wherever possible ──────────────
  const cacheHits = new Map<string, Quote>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const cached = getLiveQuote(symbol);
    if (cached) cacheHits.set(symbol, cached);
    else missing.push(symbol);
  }

  quoteStats.cacheHitSymbols += cacheHits.size;
  quoteStats.restFallbackSymbols += missing.length;
  if (missing.length > 0) quoteStats.requestsWithFallback++;
  else quoteStats.requestsFullyCached++;

  // ── 2. Fall back to a single REST call for only the missing symbols ───────
  // resolvedMissing is declared here so it's in scope for the merge step below.
  let restQuotes: Quote[] = [];
  let resolvedMissing: string[] = missing; // may stay equal when all are already prefixed
  if (missing.length > 0) {
    const adapter = await getAuthenticatedAdapter();
    if (!adapter) {
      // No cached data and no adapter available — nothing we can serve.
      if (cacheHits.size === 0) throw noAdapterReason();
    } else {
      // Resolve any bare tickers (e.g. "RELIANCE") to their correct Fyers
      // symbol (e.g. "NSE:RELIANCE-EQ" or "NSE:AAKAAR-SM") using the
      // fyers_symbol column populated by symbolMasterService.  Already-
      // prefixed symbols (containing ":") are passed through unchanged.
      const bareTickerMissing = missing.filter((s) => !s.includes(":"));
      if (bareTickerMissing.length > 0) {
        const placeholders = bareTickerMissing.map(() => "?").join(",");
        const rows = marketDb
          .prepare(
            `SELECT symbol, fyers_symbol FROM symbols WHERE symbol IN (${placeholders})`
          )
          .all(...bareTickerMissing) as { symbol: string; fyers_symbol: string | null }[];
        const fyersMap = new Map(rows.map((r) => [r.symbol, r.fyers_symbol]));
        resolvedMissing = missing.map((s) =>
          s.includes(":") ? s : fyersMap.get(s) ?? `NSE:${s}-EQ`
        );
      }

      try {
        quoteStats.restCallsMade++;
        // Use the resolved (Fyers-formatted) symbols so the broker can look
        // them up. Bare tickers like "CHAMBLFERT" are rejected by Fyers REST.
        restQuotes = await adapter.getQuotes(resolvedMissing);
      } catch (err) {
        if (
          err instanceof AuthenticationError ||
          err instanceof SessionExpiredError ||
          err instanceof RateLimitError ||
          err instanceof BrokerUnavailableError
        ) throw err;
        classifyAdapterError(err);
      }

      // Subscribe so future requests hit the WebSocket cache instead of REST.
      subscribeSymbols(resolvedMissing);
    }
  }

  // ── 3. Merge cache hits + REST fallback, preserving requested order ───────
  // restBySymbol is keyed by the broker's canonical Fyers symbol.
  // Also index by the *original* requested key so bare-ticker callers
  // (e.g. "CHAMBLFERT") can find the quote returned as "NSE:CHAMBLFERT-EQ".
  const restBySymbol = new Map<string, Quote>();
  for (const q of restQuotes) {
    restBySymbol.set(q.symbol, q);
  }
  for (let i = 0; i < missing.length; i++) {
    const orig = missing[i];
    const resolved = resolvedMissing[i];
    if (orig !== resolved) {
      const q = restBySymbol.get(resolved);
      if (q && !restBySymbol.has(orig)) restBySymbol.set(orig, q);
    }
  }

  const result: Quote[] = [];
  for (const symbol of symbols) {
    const quote = cacheHits.get(symbol) ?? restBySymbol.get(symbol);
    if (quote) result.push(quote);
  }
  return result;
}

/**
 * Diagnostic snapshot — daily budget usage, queue depth, adapter cache state.
 * Exposed through GET /api/market/status for operator monitoring.
 */
export function getServiceStats() {
  const today = todayIST();
  const dailyCount = getBudgetCount(today);
  const remainingBudgetToday = Math.max(0, config.backfillDailyRequestBudget - dailyCount);

  // Group queued chunks by (symbol, resolution) so the dashboard can show
  // per-symbol progress and a rough ETA based on today's remaining budget.
  const bySymbol = new Map<string, { symbol: string; resolution: string; chunksRemaining: number }>();
  for (const task of queue) {
    const key = `${task.symbol}::${task.resolution}`;
    const entry = bySymbol.get(key);
    if (entry) entry.chunksRemaining++;
    else bySymbol.set(key, { symbol: task.symbol, resolution: task.resolution, chunksRemaining: 1 });
  }

  const symbols = Array.from(bySymbol.values()).map((s) => ({
    ...s,
    estimatedDaysToComplete: remainingBudgetToday > 0
      ? Math.ceil(s.chunksRemaining / Math.max(1, config.backfillDailyRequestBudget))
      : Math.ceil(s.chunksRemaining / Math.max(1, config.backfillDailyRequestBudget)) + 1,
  }));

  return {
    dailyRequestsUsed:  dailyCount,
    dailyRequestBudget: config.backfillDailyRequestBudget,
    remainingBudgetToday,
    budgetResetDate:    today,
    queueDepth:         queue.length,
    workerRunning,
    adaptersCached:     adapterCache.size,
    symbols,
  };
}
