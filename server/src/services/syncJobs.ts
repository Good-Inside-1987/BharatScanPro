/**
 * syncJobs.ts
 *
 * Nightly EOD + intraday sync jobs, triggered by the scheduler at
 * config.syncSchedule.eod (4pm IST) and config.syncSchedule.intraday
 * (4:30pm IST).
 *
 * Both jobs draw from the SAME shared daily request budget enforced in
 * marketDataService.ts (no separate counter) by delegating the actual
 * broker fetch to getHistoricalBars(), which already applies rate-limit
 * pacing, budget consumption, and backfill_progress bookkeeping.
 *
 * Before spending a broker call, each job first checks whether the target
 * date is already present in the local table (ohlcv_daily / ohlcv_intraday)
 * — this is what lets the intraday job skip the ~200 F&O symbols the live
 * feed already captured in real time, backfilling only what's missing.
 */

import { marketDb } from "../db.js";
import { config } from "../config/environment.js";
import { getHistoricalBars, getAuthenticatedAdapter, getServiceStats } from "./marketDataService.js";
import { AuthenticationError, SessionExpiredError, InvalidSymbolError } from "../errors/brokerErrors.js";
import { isTradingDay } from "./tradingCalendar.js";

// ── Fyers symbol helper (same convention as dataLoader.ts's toFyersSymbol) ────
//
// fyersSymbolMap is rebuilt once at the start of each job run from
// `SELECT symbol, fyers_symbol FROM symbols` — one cheap query per job, not
// one per symbol in the hot loop.  It is null until the first job starts
// (e.g. on fresh DBs before the symbol master sync runs), in which case the
// fallback construction `NSE:{SYMBOL}-EQ` is used instead.
let fyersSymbolMap: Map<string, string> | null = null;

function refreshFyersSymbolMap(): void {
  try {
    const rows = marketDb
      .prepare(`SELECT symbol, fyers_symbol FROM symbols WHERE fyers_symbol IS NOT NULL`)
      .all() as unknown as Array<{ symbol: string; fyers_symbol: string }>;
    fyersSymbolMap = new Map(rows.map((r) => [r.symbol, r.fyers_symbol]));
  } catch {
    // symbols table may not exist yet on first boot — leave map as-is
  }
}

function toFyersSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.includes(":")) return s;
  // Prefer the stored Fyers ticker when available (populated by symbol master
  // sync); fall back to the conventional NSE:{SYMBOL}-EQ construction for
  // indices and any symbols pre-dating the fyers_symbol column.
  return fyersSymbolMap?.get(s) ?? `NSE:${s}-EQ`;
}

export function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

/**
 * On startup, any sync_log row still in status='running' is guaranteed stale —
 * this is a single-instance app, so no other process could be legitimately
 * running a job. Mark them all failed so the catch-up scheduler doesn't skip
 * them when computing missed dates.
 */
export function cleanupOrphanedSyncLogs(): void {
  const now = new Date().toISOString();
  const result = marketDb
    .prepare(
      `UPDATE sync_log
          SET status = 'failed',
              finished_at = ?,
              error_message = 'Orphaned — process restarted mid-job'
        WHERE status = 'running'`
    )
    .run(now);
  if (result.changes > 0) {
    console.log(
      "[syncJobs] Cleaned up %d orphaned 'running' sync_log row(s) from previous process",
      result.changes
    );
  }
}

// ── sync_log helpers ────────────────────────────────────────────────────────
// Extend the existing sync_log table (idempotent) with per-run symbol counts
// so the Backfill Dashboard can show completed vs. skipped-due-to-budget.
try {
  marketDb.exec(`ALTER TABLE sync_log ADD COLUMN symbols_completed INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }
try {
  marketDb.exec(`ALTER TABLE sync_log ADD COLUMN symbols_skipped_budget INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }
try {
  marketDb.exec(`ALTER TABLE sync_log ADD COLUMN symbols_failed INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }
try {
  marketDb.exec(`ALTER TABLE sync_log ADD COLUMN target_date TEXT`);
} catch { /* column already exists */ }
try {
  marketDb.exec(`CREATE INDEX IF NOT EXISTS idx_sync_log_target_date ON sync_log(job_name, target_date, status)`);
} catch { /* index already exists */ }

interface SyncLogRow {
  id: number;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  rows_processed: number;
  error_message: string | null;
  symbols_completed: number;
  symbols_skipped_budget: number;
  symbols_failed: number;
}

export function startSyncLog(jobName: string, targetDate: string = todayIST()): number {
  const startedAt = new Date().toISOString();
  const result = marketDb
    .prepare(
      `INSERT INTO sync_log (job_name, started_at, status, rows_processed, target_date)
       VALUES (?, ?, 'running', 0, ?)`
    )
    .run(jobName, startedAt, targetDate);
  return Number(result.lastInsertRowid);
}

/**
 * Most recent trading date (YYYY-MM-DD) this job successfully completed,
 * or null if it has never completed successfully. Used by the catch-up
 * orchestrator to find how far behind a job has fallen.
 */
export function getLastSuccessDate(jobName: string): string | null {
  const row = marketDb
    .prepare(
      `SELECT MAX(target_date) AS maxDate FROM sync_log
        WHERE job_name = ? AND status = 'completed' AND target_date IS NOT NULL`
    )
    .get(jobName) as unknown as { maxDate: string | null } | undefined;
  return row?.maxDate ?? null;
}

/** True if `jobName` has a logged successful completion for exactly `date`. */
export function hasSuccessfulRunForDate(jobName: string, date: string): boolean {
  const row = marketDb
    .prepare(
      `SELECT 1 FROM sync_log WHERE job_name = ? AND target_date = ? AND status = 'completed' LIMIT 1`
    )
    .get(jobName, date);
  return !!row;
}

export function finishSyncLog(
  id: number,
  status: "completed" | "failed",
  stats: JobStats | { completed: number; skippedBudget: number; failed: number },
  errorMessage?: string
): void {
  // Build a structured breakdown for error_message when there are non-fatal
  // categories (invalidSymbol / noData) — gives the DB record diagnostic value
  // without requiring a schema change for every new counter.
  const full = stats as JobStats;
  const parts: string[] = [];
  if (full.invalidSymbol) parts.push(`invalidSymbol=${full.invalidSymbol}`);
  if (full.noData)        parts.push(`noData=${full.noData}`);
  if (full.failed)        parts.push(`failed=${full.failed}`);

  let finalMessage: string | null;
  if (errorMessage) {
    finalMessage = parts.length ? `${errorMessage} | ${parts.join(" ")}` : errorMessage;
  } else if (parts.length) {
    finalMessage = parts.join(" ");
  } else {
    finalMessage = null;
  }

  marketDb
    .prepare(
      `UPDATE sync_log
          SET finished_at = ?, status = ?, rows_processed = ?,
              symbols_completed = ?, symbols_skipped_budget = ?, symbols_failed = ?,
              error_message = ?
        WHERE id = ?`
    )
    .run(
      new Date().toISOString(),
      status,
      stats.completed,
      stats.completed,
      stats.skippedBudget,
      // symbols_failed column stores all non-completed outcomes so the DB
      // total is still meaningful; the breakdown is in error_message.
      (full.failed ?? 0) + (full.invalidSymbol ?? 0) + (full.noData ?? 0),
      finalMessage,
      id
    );
}

/** Most recent run of a nightly sync job, for the Backfill Dashboard. */
export interface NightlySyncJobStatus {
  jobName: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  symbolsCompleted: number;
  symbolsSkippedBudget: number;
  symbolsFailed: number;
  errorMessage: string | null;
}

export function lastRun(jobName: string): NightlySyncJobStatus {
  const row = marketDb
    .prepare(
      `SELECT * FROM sync_log WHERE job_name = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(jobName) as unknown as SyncLogRow | undefined;

  if (!row) {
    return {
      jobName,
      startedAt: null,
      finishedAt: null,
      status: null,
      symbolsCompleted: 0,
      symbolsSkippedBudget: 0,
      symbolsFailed: 0,
      errorMessage: null,
    };
  }

  return {
    jobName,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    symbolsCompleted: row.symbols_completed,
    symbolsSkippedBudget: row.symbols_skipped_budget,
    symbolsFailed: row.symbols_failed,
    errorMessage: row.error_message,
  };
}

export function getNightlySyncStatus() {
  return {
    eod: lastRun("eod_sync"),
    intraday: lastRun("intraday_sync"),
    options: lastRun("options_sync"),
    symbolMaster: lastRun("symbol_master"),
  };
}

// ── Retention cleanup ─────────────────────────────────────────────────────────

function cleanupOldEodRows(): void {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - config.eodRetentionYears);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const result = marketDb.prepare(`DELETE FROM ohlcv_daily WHERE date < ?`).run(cutoffDate);
  if (Number(result.changes) > 0) {
    console.log(`[syncJobs] EOD cleanup: removed ${result.changes} rows older than ${cutoffDate}`);
  }
}

function cleanupOldIntradayRows(): void {
  if (config.intradayRetentionMonths === null) return; // keep forever
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - config.intradayRetentionMonths);
  const cutoffIso = cutoff.toISOString();
  const result = marketDb.prepare(`DELETE FROM ohlcv_intraday WHERE timestamp < ?`).run(cutoffIso);
  if (Number(result.changes) > 0) {
    console.log(`[syncJobs] Intraday cleanup: removed ${result.changes} rows older than ${cutoffIso}`);
  }
}

// ── Shared symbol loop ──────────────────────────────────────────────────────

interface SymbolRow { symbol: string }

interface JobStats {
  /** Symbols where the broker returned ≥1 bar and rows were saved. */
  completed: number;
  /** Valid symbol but broker returned 0 bars (non-trading day, mid-session gap). */
  noData: number;
  /** Permanently rejected by the broker — unknown/delisted symbol. */
  invalidSymbol: number;
  /** Not reached because the daily request budget was exhausted. */
  skippedBudget: number;
  /** Transient/unexpected broker errors (network, overload, etc.). */
  failed: number;
}

/** Up to MAX_SAMPLES representative examples collected per failure category. */
const MAX_SAMPLES = 5;
/** Log transient failures individually up to this limit; summarise the rest. */
const MAX_PER_SYMBOL_LOGS = 10;

interface FailureSample { symbol: string; message: string }

function collectSample(
  bucket: FailureSample[],
  symbol: string,
  message: string
): void {
  if (bucket.length < MAX_SAMPLES) bucket.push({ symbol, message });
}

// Fyers returns an HTML page instead of JSON when it's rate-limiting a
// request on an otherwise-valid session — already normalized by fyers.ts's
// fetchJson() into Error("Rate limited by Fyers (received HTML instead of
// JSON)"). This is genuinely transient and worth a short backoff + retry.
//
// NOTE: an earlier version of this list also treated Fyers' literal
// "Could not authenticate the user" message as transient, on the theory
// that Fyers uses that auth-sounding wording as a generic overload signal.
// Real-world logs disproved that — it corresponded to an actually-expired
// token (confirmed independently via the live feed bridge's raw error:
// {'code': -99, 'message': 'Token is expired'}). That message is now
// classified upstream in marketDataService.ts's classifyAdapterError() as
// a real SessionExpiredError, which this loop already handles correctly by
// stopping the whole job cleanly instead of burning retries/budget hammering
// a dead token across thousands of symbols.
const TRANSIENT_OVERLOAD_PATTERNS = [
  /rate limited by fyers/i,
];

function isTransientOverloadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_OVERLOAD_PATTERNS.some((re) => re.test(message));
}

async function fetchBarsWithRetry(
  symbol: string,
  resolution: string,
  date: string,
  maxRetries: number = 2
): Promise<Awaited<ReturnType<typeof getHistoricalBars>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await getHistoricalBars(toFyersSymbol(symbol), resolution, date, date);
    } catch (err) {
      lastErr = err;
      if (err instanceof AuthenticationError || err instanceof SessionExpiredError) throw err;
      if (!isTransientOverloadError(err) || attempt === maxRetries) throw err;
      const backoffMs = 1000 * (attempt + 1); // 1s, then 2s
      console.warn(
        "[syncJobs] Transient overload syncing %s @ %s (attempt %d/%d) — retrying in %dms: %s",
        symbol, date, attempt + 1, maxRetries + 1, backoffMs,
        err instanceof Error ? err.message : String(err)
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

/**
 * Runs the fetch loop for a list of symbols against a single target date,
 * skipping symbols already covered locally (free) and stopping the broker
 * calls cleanly once the shared daily request budget is exhausted (any
 * symbols not yet reached are counted as skippedBudget, not failed).
 */
async function runSymbolLoop(
  symbols: string[],
  resolution: string,
  date: string,
  alreadyCovered: (symbol: string) => boolean
): Promise<JobStats> {
  const stats: JobStats = {
    completed: 0, noData: 0, invalidSymbol: 0, skippedBudget: 0, failed: 0,
  };
  let budgetExhausted = false;

  // Per-category sample buckets — populated silently during the loop and
  // emitted once as a structured summary at the end. This avoids thousands
  // of per-symbol log lines when large numbers of symbols share the same
  // root cause (e.g. all being invalid Fyers symbols).
  const invalidSamples: FailureSample[] = [];
  const noDataSamples:  FailureSample[] = [];
  const failedSamples:  FailureSample[] = [];

  // Transient failures are also logged inline, but only up to a cap so the
  // output stays readable even when many symbols hit the same transient error.
  let inlineFailedLogged = 0;

  for (const symbol of symbols) {
    if (alreadyCovered(symbol)) {
      stats.completed++;
      continue;
    }

    if (budgetExhausted) {
      stats.skippedBudget++;
      continue;
    }

    if (getServiceStats().remainingBudgetToday <= 0) {
      budgetExhausted = true;
      stats.skippedBudget++;
      continue;
    }

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const bars = await fetchBarsWithRetry(symbol, resolution, date);
      if (bars.length > 0) {
        stats.completed++;
      } else {
        // Valid symbol; broker returned 0 bars for this date (non-trading
        // day, mid-session gap, or symbol temporarily absent). Not a failure.
        stats.noData++;
        collectSample(noDataSamples, symbol, "0 bars");
      }
    } catch (err) {
      if (err instanceof AuthenticationError || err instanceof SessionExpiredError) {
        console.error(
          "[syncJobs] Broker session unavailable mid-job (%s) — stopping cleanly",
          err.message
        );
        break;
      }
      if (err instanceof InvalidSymbolError) {
        // Permanent rejection — collect silently; summary logged after the loop.
        stats.invalidSymbol++;
        collectSample(invalidSamples, symbol, err.message);
        continue;
      }
      // Transient / unexpected broker error.
      stats.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      collectSample(failedSamples, symbol, msg);
      if (inlineFailedLogged < MAX_PER_SYMBOL_LOGS) {
        console.error("[syncJobs] Failed to sync %s @ %s: %s", symbol, date, msg);
        inlineFailedLogged++;
      } else if (inlineFailedLogged === MAX_PER_SYMBOL_LOGS) {
        console.error(
          "[syncJobs] … further per-symbol failure lines suppressed; see end-of-loop summary"
        );
        inlineFailedLogged++;
      }
    }
  }

  // ── End-of-loop structured summary ─────────────────────────────────────────
  // Always emit so operators have one canonical place to check after each job.
  console.log(
    "[syncJobs] Loop summary — completed=%d noData=%d invalidSymbol=%d failed=%d skippedBudget=%d",
    stats.completed, stats.noData, stats.invalidSymbol, stats.failed, stats.skippedBudget
  );

  function logSamples(label: string, count: number, samples: FailureSample[]): void {
    if (count === 0) return;
    const examples = samples
      .map((s) => `${s.symbol}(${s.message})`)
      .join(", ");
    const overflow = count > samples.length ? ` … +${count - samples.length} more` : "";
    console.log("[syncJobs]   %s: %d — e.g. %s%s", label, count, examples, overflow);
  }

  logSamples("invalidSymbol", stats.invalidSymbol, invalidSamples);
  logSamples("noData",        stats.noData,        noDataSamples);
  logSamples("failed",        stats.failed,        failedSamples);

  return stats;
}

// ── EOD job (4:00 PM IST) ────────────────────────────────────────────────────

function isEodCovered(symbol: string, date: string): boolean {
  const row = marketDb
    .prepare(`SELECT 1 FROM ohlcv_daily WHERE symbol = ? AND date = ?`)
    .get(toFyersSymbol(symbol), date);
  return !!row;
}

/**
 * Pulls today's daily close candle for every symbol in the "symbols" table
 * (full NSE universe), resolution "1D". Applies retention (delete rows older
 * than config.eodRetentionYears) after the fetch loop.
 */
export async function runEodSyncJob(
  targetDate: string = todayIST()
): Promise<JobStats & { skippedNoAdapter?: boolean }> {
  const date = targetDate;
  const logId = startSyncLog("eod_sync", date);

  try {
    if (!isTradingDay(date)) {
      console.log("[syncJobs] %s is not a trading day — skipping EOD sync, 0 budget spent", date);
      finishSyncLog(logId, "completed", { completed: 0, skippedBudget: 0, failed: 0 });
      return { completed: 0, noData: 0, invalidSymbol: 0, skippedBudget: 0, failed: 0 };
    }

    refreshFyersSymbolMap();

    const adapter = await getAuthenticatedAdapter();
    if (!adapter) {
      console.warn("[syncJobs] EOD sync skipped — no broker connected");
      finishSyncLog(logId, "failed", { completed: 0, skippedBudget: 0, failed: 0 }, "No broker connected");
      return { completed: 0, noData: 0, invalidSymbol: 0, skippedBudget: 0, failed: 0, skippedNoAdapter: true };
    }

    const sql =
      config.eodUniverse === "fo_stocks"
        ? `SELECT symbol FROM symbols WHERE is_delisted = 0 AND is_fo_eligible = 1`
        : `SELECT symbol FROM symbols WHERE is_delisted = 0`;
    const symbolRows = marketDb.prepare(sql).all() as unknown as SymbolRow[];
    const symbols = symbolRows.map((r) => r.symbol);

    console.log(`[syncJobs] EOD sync starting — ${symbols.length} symbols for ${date} (universe: ${config.eodUniverse})`);
    const stats = await runSymbolLoop(symbols, "1D", date, (s) => isEodCovered(s, date));

    // ── Index daily bars ─────────────────────────────────────────────────────
    // These 5 symbols mirror ALL_INDEX_DEFS[*].fyersIndexSymbol in
    // artifacts/bharatscan/src/pages/Home.tsx — keep them in sync if that
    // list changes. Indices are NOT in the `symbols` table (not tradable
    // equity instruments) so they are excluded from runSymbolLoop above;
    // we fetch them here as a fixed always-run step regardless of eodUniverse.
    const INDEX_FYERS_SYMBOLS = [
      "NSE:NIFTY50-INDEX",
      "NSE:NIFTYBANK-INDEX",
      "NSE:FINNIFTY-INDEX",
      "NSE:MIDCPNIFTY-INDEX",
      "BSE:SENSEX-INDEX",
    ];
    for (const idxSymbol of INDEX_FYERS_SYMBOLS) {
      try {
        await getHistoricalBars(idxSymbol, "1D", date, date);
        console.log("[syncJobs] EOD index bar fetched: %s %s", idxSymbol, date);
      } catch (err) {
        console.warn(
          "[syncJobs] EOD index bar failed for %s %s: %s",
          idxSymbol, date,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Retention cleanup is handled centrally by cleanupJob.ts (6 PM IST).

    // Only true transient broker errors count as a job failure — invalid
    // symbols and no-data days are expected and handled; they do not mean
    // the broker connection itself is broken.
    const runStatus: "completed" | "failed" = stats.failed === 0 ? "completed" : "failed";
    finishSyncLog(logId, runStatus, stats);
    console.log(
      "[syncJobs] EOD sync done — status=%s completed=%d noData=%d invalidSymbol=%d failed=%d skippedBudget=%d",
      runStatus, stats.completed, stats.noData, stats.invalidSymbol, stats.failed, stats.skippedBudget
    );
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishSyncLog(logId, "failed", { completed: 0, skippedBudget: 0, failed: 0 }, message);
    console.error("[syncJobs] EOD sync crashed:", message);
    throw err;
  }
}

// ── Intraday job (4:30 PM IST) ───────────────────────────────────────────────

function intradayResolutionCode(): string {
  return config.intradayCandleSize === "5min" ? "5" : "1";
}

function isIntradayCovered(symbol: string, date: string): boolean {
  const row = marketDb
    .prepare(
      `SELECT 1 FROM ohlcv_intraday WHERE symbol = ? AND timestamp >= ? AND timestamp < ? LIMIT 1`
    )
    .get(toFyersSymbol(symbol), `${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`);
  return !!row;
}

/**
 * Backfills/tops-up intraday candles for today. Universe and candle size
 * come from config.intradayUniverse / config.intradayCandleSize:
 *   - "fo_stocks" (Replit): only is_fo_eligible symbols, 5-min candles.
 *   - "all_nse" (Oracle/local): every symbol, 1-min candles.
 * Symbols already covered by the live feed's real-time capture (rows already
 * present in ohlcv_intraday for today) are skipped for free. Applies
 * retention (delete rows older than config.intradayRetentionMonths, or
 * never, when null) after the fetch loop.
 */
export async function runIntradaySyncJob(
  targetDate: string = todayIST()
): Promise<JobStats & { skippedNoAdapter?: boolean }> {
  const date = targetDate;
  const logId = startSyncLog("intraday_sync", date);

  try {
    if (!isTradingDay(date)) {
      console.log("[syncJobs] %s is not a trading day — skipping intraday sync, 0 budget spent", date);
      finishSyncLog(logId, "completed", { completed: 0, skippedBudget: 0, failed: 0 });
      return { completed: 0, noData: 0, invalidSymbol: 0, skippedBudget: 0, failed: 0 };
    }

    refreshFyersSymbolMap();

    const adapter = await getAuthenticatedAdapter();
    if (!adapter) {
      console.warn("[syncJobs] Intraday sync skipped — no broker connected");
      finishSyncLog(logId, "failed", { completed: 0, skippedBudget: 0, failed: 0 }, "No broker connected");
      return { completed: 0, noData: 0, invalidSymbol: 0, skippedBudget: 0, failed: 0, skippedNoAdapter: true };
    }

    const sql =
      config.intradayUniverse === "fo_stocks"
        ? `SELECT symbol FROM symbols WHERE is_delisted = 0 AND is_fo_eligible = 1`
        : `SELECT symbol FROM symbols WHERE is_delisted = 0`;
    const symbolRows = marketDb.prepare(sql).all() as unknown as SymbolRow[];
    const symbols = symbolRows.map((r) => r.symbol);
    const resolution = intradayResolutionCode();

    console.log(
      "[syncJobs] Intraday sync starting — %d symbols (%s universe, %s candles) for %s",
      symbols.length, config.intradayUniverse, config.intradayCandleSize, date
    );
    const stats = await runSymbolLoop(symbols, resolution, date, (s) => isIntradayCovered(s, date));

    // Retention cleanup is handled centrally by cleanupJob.ts (6 PM IST).

    const runStatus: "completed" | "failed" = stats.failed === 0 ? "completed" : "failed";
    finishSyncLog(logId, runStatus, stats);
    console.log(
      "[syncJobs] Intraday sync done — status=%s completed=%d noData=%d invalidSymbol=%d failed=%d skippedBudget=%d",
      runStatus, stats.completed, stats.noData, stats.invalidSymbol, stats.failed, stats.skippedBudget
    );
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishSyncLog(logId, "failed", { completed: 0, skippedBudget: 0, failed: 0 }, message);
    console.error("[syncJobs] Intraday sync crashed:", message);
    throw err;
  }
}
