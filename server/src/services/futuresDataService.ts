/**
 * futuresDataService.ts
 *
 * Nightly sync of front-month futures daily bars from a connected broker
 * into the futures_daily table.  Mirrors the structure and guard patterns
 * of optionsDataService.ts: same authenticated adapter, shared daily request
 * budget, rate-limit throttle, and upsert-on-conflict writes.
 */

import { marketDb } from "../db.js";
import {
  getAuthenticatedAdapter,
  throttleCall,
  checkAndConsumeBudget,
  getServiceStats,
} from "./marketDataService.js";
import { AuthenticationError, SessionExpiredError } from "../errors/brokerErrors.js";
import { startSyncLog, finishSyncLog, todayIST } from "./syncJobs.js";
import { isTradingDay } from "./tradingCalendar.js";

// ── futures_daily upsert ──────────────────────────────────────────────────────

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function upsertFuturesBar(
  underlying: string,
  expiry: string,
  date: string,
  bar: Bar,
): void {
  const stmt = marketDb.prepare(`
    INSERT INTO futures_daily (underlying, expiry, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(underlying, expiry, date) DO UPDATE SET
      open   = excluded.open,
      high   = excluded.high,
      low    = excluded.low,
      close  = excluded.close,
      volume = excluded.volume
  `);
  stmt.run(underlying, expiry, date, bar.open, bar.high, bar.low, bar.close, bar.volume);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface FuturesSyncStats {
  completed: number;
  noData: number;
  failed: number;
  skippedBudget: number;
  skippedNoAdapter?: boolean;
}

/**
 * Nightly futures sync — for each F&O underlying with a row in futures_symbols,
 * fetches the front-month contract's daily bar for `targetDate` and upserts
 * into futures_daily.  "Front-month" = nearest expiry >= targetDate.
 *
 * Mirrors runOptionsSyncJob's early-exit guards exactly:
 *   1. No broker → skip
 *   2. Budget exhausted → skip
 *   3. Not a trading day → skip
 */
export async function runFuturesSyncJob(
  targetDate: string = todayIST(),
): Promise<FuturesSyncStats> {
  const date = targetDate;
  const logId = startSyncLog("futures_sync", date);

  try {
    const adapter = await getAuthenticatedAdapter();
    if (!adapter) {
      console.warn("[futuresDataService] Nightly futures sync skipped — no broker connected");
      finishSyncLog(logId, "failed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 }, "No broker connected");
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0, skippedNoAdapter: true };
    }

    if (getServiceStats().remainingBudgetToday <= 0) {
      console.warn("[futuresDataService] Nightly futures sync skipped — daily request budget already exhausted");
      finishSyncLog(logId, "completed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 }, "Daily request budget already exhausted");
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0 };
    }

    if (!isTradingDay(date)) {
      console.log("[futuresDataService] %s is not a trading day — skipping futures sync, 0 budget spent", date);
      finishSyncLog(logId, "completed", { completed: 0, noData: 0, skippedBudget: 0, failed: 0 });
      return { completed: 0, noData: 0, failed: 0, skippedBudget: 0 };
    }

    // One front-month contract per underlying: nearest expiry >= date.
    const contracts = marketDb.prepare(`
      SELECT underlying, expiry, fyers_symbol
        FROM futures_symbols
       WHERE expiry >= ?
       GROUP BY underlying
      HAVING expiry = MIN(expiry)
    `).all(date) as Array<{ underlying: string; expiry: string; fyers_symbol: string }>;

    console.log(
      "[futuresDataService] Nightly futures sync starting — %d underlyings for %s",
      contracts.length,
      date,
    );

    let completed = 0;
    let noData = 0;
    let failed = 0;
    let skippedBudget = 0;

    for (const c of contracts) {
      if (!checkAndConsumeBudget()) {
        skippedBudget++;
        continue;
      }
      try {
        const bars = await throttleCall(() =>
          adapter.getHistoricalData(c.fyers_symbol, "1", date, date),
        );
        if (bars.length > 0) {
          const last = bars[bars.length - 1];
          upsertFuturesBar(c.underlying, c.expiry, date, {
            date: last.date,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volume: last.volume,
          });
          completed++;
        } else {
          noData++;
        }
      } catch (err) {
        if (err instanceof AuthenticationError || err instanceof SessionExpiredError) {
          console.error("[futuresDataService] Broker session unavailable mid-job — stopping cleanly");
          break;
        }
        failed++;
        console.error(
          "[futuresDataService] ✗ %s: %s",
          c.underlying,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.log(
      "[futuresDataService] Nightly futures sync done — completed=%d noData=%d skippedBudget=%d failed=%d",
      completed,
      noData,
      skippedBudget,
      failed,
    );

    finishSyncLog(logId, "completed", { completed, noData, skippedBudget, failed });
    return { completed, noData, failed, skippedBudget };
  } catch (err) {
    finishSyncLog(
      logId,
      "failed",
      { completed: 0, noData: 0, skippedBudget: 0, failed: 0 },
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}
