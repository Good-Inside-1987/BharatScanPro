import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { config } from "../config/environment.js";
import { connect, disconnect, autoSubscribeFoSymbols, clearProtectedSymbols, isConnected } from "./liveFeedService.js";
import { isTradingDay } from "./tradingCalendar.js";
import {
  initAtmOptionSubscriptions,
  startAtmRollTracking,
  stopAtmRollTracking,
  getAtmTrackerStatus,
  FO_STOCKS_BUDGET,
  OPTIONS_LIVE_BUDGET,
  ATM_WINDOW,
} from "./liveOptionsTracker.js";
import { marketDb } from "../db.js";
import { syncSymbolMaster } from "./symbolMasterService.js";
import { syncNseHolidayCalendar } from "./holidayCalendarService.js";
import { runEodSyncJob, runIntradaySyncJob, todayIST, cleanupOrphanedSyncLogs } from "./syncJobs.js";
import { runOptionsSyncJob } from "./optionsDataService.js";
import { runFuturesSyncJob } from "./futuresDataService.js";
import { runFoBanListJob } from "./foBanListService.js";
import { runSupplementaryJob, runMfHoldingsJob } from "./supplementaryJobs.js";
import { runCleanupJob } from "./cleanupJob.js";
import { runStartupCatchUp, startPeriodicCatchUpCheck, getCatchUpStatus } from "./catchUpScheduler.js";

let schedulerActive = false;

// One-time bootstrap: if the symbols table is completely empty (fresh
// deployment, or any day other than Monday morning before the weekly cron
// has ever fired), download the symbol master immediately instead of
// leaving every downstream job (EOD/intraday sync, F&O auto-subscribe, ATM
// option tracking) silently idle for up to 6 days. No-op once symbols has
// at least one row, so it never fights the Monday cron or duplicates work.
// syncSymbolMaster() hits only Fyers' public static files + NSE's public
// index pages — no authenticated broker session required — so this is safe
// to run unconditionally at every server start.
async function bootstrapSymbolMasterIfEmpty(): Promise<void> {
  const row = marketDb.prepare(`SELECT COUNT(*) as c FROM symbols`).get() as { c: number };
  if (row.c > 0) return;

  console.log(
    "[scheduler] symbols table is empty — running one-time bootstrap symbol master sync before registering cron jobs …"
  );
  try {
    const r = await syncSymbolMaster(marketDb);
    console.log(`[scheduler] Symbol master sync complete: ${r.upserted} rows upserted`);
  } catch (err) {
    console.error(
      "[scheduler] Bootstrap symbol master sync failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

// One-time bootstrap: if nse_holidays is completely empty (fresh deployment,
// or any day other than Monday morning before the weekly cron has ever
// fired), download the holiday calendar immediately instead of leaving
// isTradingDay() blind to real holidays for up to a week. No-op once
// nse_holidays has at least one row. syncNseHolidayCalendar() hits only
// NSE's public holiday-master API — no authenticated broker session
// required — so this is safe to run unconditionally at every server start.
async function bootstrapHolidayCalendarIfEmpty(): Promise<void> {
  const row = marketDb.prepare(`SELECT COUNT(*) as c FROM nse_holidays`).get() as { c: number };
  if (row.c > 0) return;

  console.log(
    "[scheduler] nse_holidays table is empty — running one-time bootstrap holiday calendar sync before registering cron jobs …"
  );
  try {
    const r = await syncNseHolidayCalendar();
    console.log(`[scheduler] Holiday calendar sync complete: ${r.upserted} rows upserted`);
  } catch (err) {
    console.error(
      "[scheduler] Bootstrap holiday calendar sync failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Parses a "minute hour * * days" cron expression (the only shape used by
 * config.syncSchedule) into its {hour, minute} fields, so bootstrap logic
 * can compare against the current IST clock without re-deriving the next
 * fire time via cron-parser (which answers "when next", not "is now inside
 * this window").
 */
function parseHourMinute(cronExpr: string): { hour: number; minute: number } {
  const [minute, hour] = cronExpr.trim().split(/\s+/);
  return { hour: Number(hour), minute: Number(minute) };
}

/** Current IST wall-clock time as minutes since midnight. */
function nowIstMinutes(): number {
  const parts = new Date().toLocaleTimeString("en-GB", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
  }); // "HH:MM"
  const [h, m] = parts.split(":").map(Number);
  return h * 60 + m;
}

/**
 * True only when the live feed *should* be running right now: today is a
 * trading day AND the current IST clock falls within
 * [config.syncSchedule.liveOpen, config.syncSchedule.liveClose]. Parses the
 * minute/hour fields directly out of those two cron expressions rather than
 * hardcoding 9:00/15:35 separately, so this stays in sync if the schedule
 * ever changes.
 */
export function isMarketOpenNow(): boolean {
  if (!isTradingDay(todayIST())) return false;

  const open = parseHourMinute(config.syncSchedule.liveOpen);
  const close = parseHourMinute(config.syncSchedule.liveClose);
  const nowMin = nowIstMinutes();
  const openMin = open.hour * 60 + open.minute;
  const closeMin = close.hour * 60 + close.minute;
  return nowMin >= openMin && nowMin <= closeMin;
}

/** Runs the exact sequence the old liveOpen cron handler ran: connect the
 *  feed, then auto-subscribe F&O stocks and ATM options. connect() is safe
 *  to call repeatedly, so this is a no-op if already connected. */
async function runLiveOpenSequence(): Promise<void> {
  console.log(
    "[scheduler] Market open — live feed budget: %d F&O stocks + %d options slots (ATM ±%d, %d indices)",
    FO_STOCKS_BUDGET, OPTIONS_LIVE_BUDGET, ATM_WINDOW, config.optionsIndices.length
  );
  await connect();

  // ── Step 1: F&O stock auto-subscribe (reduced limit to make room for options) ──
  try {
    autoSubscribeFoSymbols(FO_STOCKS_BUDGET);
  } catch (err) {
    console.error(
      "[scheduler] F&O auto-subscribe failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // ── Step 2: ATM option subscriptions (per configured index, ±ATM_WINDOW) ──
  try {
    await initAtmOptionSubscriptions();
    startAtmRollTracking();
  } catch (err) {
    console.error(
      "[scheduler] ATM option subscriptions failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Runs the exact sequence the old liveClose cron handler ran: stop ATM roll
 *  tracking (finalising each option contract's partial candle before the WS
 *  connection drops), disconnect, then clear protection flags so the next
 *  open rebuilds fresh. */
function runLiveCloseSequence(): void {
  stopAtmRollTracking();
  disconnect();
  clearProtectedSymbols();
}

/**
 * Reconciles the live feed's actual connection state against what it
 * *should* be right now, replacing the old fixed-time liveOpen/liveClose
 * cron triggers. Those cron jobs each fired once at one exact clock instant
 * — a process that wasn't running at that instant (late start, or a Replit
 * sleep/wake past 9 AM) got zero live data for the rest of the trading day
 * with no way to recover. Calling this on a short interval instead makes
 * "is the live feed's state correct for right now?" a continuously-true
 * condition rather than a one-shot trigger: it naturally starts the feed
 * once the clock crosses into market hours and stops it once the clock
 * crosses out, regardless of whether that aligns with the app already being
 * open at that exact moment or the app opening mid-session.
 */
export async function reconcileLiveFeedState(): Promise<void> {
  const shouldBeOpen = isMarketOpenNow();
  const connected = isConnected();

  if (shouldBeOpen && !connected) {
    console.log(
      "[scheduler] Market is open and live feed isn't connected — starting it now"
    );
    try {
      await runLiveOpenSequence();
    } catch (err) {
      console.error(
        "[scheduler] Live feed reconcile (open) failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return;
  }

  if (!shouldBeOpen && connected) {
    console.log(
      "[scheduler] Market is closed and live feed is still connected — stopping it now"
    );
    try {
      runLiveCloseSequence();
    } catch (err) {
      console.error(
        "[scheduler] Live feed reconcile (close) failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  // Otherwise: state already matches — nothing to do.
}

/** How often reconcileLiveFeedState() re-checks state, in minutes. */
export const LIVE_FEED_RECONCILE_INTERVAL_MINUTES = 2;

// Only runs the scheduler inside this process on environments where it's
// not handled by a separate PM2 process (see config.runSchedulerInProcess).
export function startScheduler(): void {
  if (!config.runSchedulerInProcess) return;
  void registerAllCronJobs();
}

// Registers the startup catch-up run and all cron.schedule(...) jobs.
// Called by startScheduler() (guarded by config.runSchedulerInProcess, for
// Replit/local/Electron) and unconditionally by the standalone Oracle
// scheduler process (server/src/scheduler/standalone.ts).
export async function registerAllCronJobs(): Promise<void> {
  // Bootstrap symbols if the table is completely empty — must happen before
  // catch-up and cron registration below so downstream jobs have data to
  // work with as soon as possible on a fresh deployment.
  await bootstrapSymbolMasterIfEmpty();
  // Must also run before catch-up/cron registration below: catch-up's
  // isTradingDay() checks depend on the holiday calendar being current as
  // early as possible in a fresh deployment.
  await bootstrapHolidayCalendarIfEmpty();

  // One-time idempotent migration: normalize any ohlcv_daily.date values that
  // were stored as full ISO timestamps (e.g. "2026-07-23T00:00:00.000Z") down
  // to plain YYYY-MM-DD strings. The Fyers adapter returned full timestamps
  // which broke BETWEEN queries and caused EOD stats.completed to stay 0.
  // Must run before catch-up so isEodCovered() and queryBars() see clean data.
  try {
    const migResult = marketDb
      .prepare(`UPDATE ohlcv_daily SET date = substr(date, 1, 10) WHERE date LIKE '%T%'`)
      .run();
    if (migResult.changes > 0) {
      console.log(
        "[scheduler] Migrated %d ohlcv_daily row(s): normalized full ISO timestamps to YYYY-MM-DD",
        migResult.changes
      );
    }
  } catch (err) {
    console.error("[scheduler] ohlcv_daily date migration failed:", err instanceof Error ? err.message : String(err));
  }

  // Clean up any sync_log rows left in status='running' from a previous process
  // that was killed mid-job. Must run before catch-up so the scheduler doesn't
  // treat those rows as successful completions and skip re-running them.
  cleanupOrphanedSyncLogs();

  // Catch up on any missed trading days (server was asleep/offline, or a job
  // silently failed) BEFORE the normal cron jobs are registered below, so a
  // startup catch-up run never overlaps one about to fire at its normal time.
  // Runs async — cron registration below does not wait on it.
  void runStartupCatchUp().catch((err) => {
    console.error("[scheduler] Startup catch-up failed:", err instanceof Error ? err.message : String(err));
  });
  startPeriodicCatchUpCheck();

  // Live feed reconciliation — replaces the old fixed-time liveOpen/liveClose
  // cron triggers. Runs once immediately (covers late starts / wake-from-sleep
  // mid-session) and then every LIVE_FEED_RECONCILE_INTERVAL_MINUTES, so the
  // feed connects/disconnects based on a continuously-true "should this be
  // running right now?" check rather than one exact clock instant.
  void reconcileLiveFeedState().catch((err) => {
    console.error("[scheduler] Live feed reconcile failed:", err instanceof Error ? err.message : String(err));
  });
  setInterval(() => {
    void reconcileLiveFeedState().catch((err) => {
      console.error("[scheduler] Live feed reconcile failed:", err instanceof Error ? err.message : String(err));
    });
  }, LIVE_FEED_RECONCILE_INTERVAL_MINUTES * 60 * 1000);

  // Symbol master refresh — every Monday at 7 AM IST
  cron.schedule(
    config.syncSchedule.symbolMaster,
    () => {
      console.log("[scheduler] Running scheduled symbol master sync …");
      void syncSymbolMaster(marketDb).then(r => {
        console.log(`[scheduler] Symbol master sync complete: ${r.upserted} rows upserted`);
      }).catch(err => {
        console.error("[scheduler] Symbol master sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Holiday calendar refresh — every Monday at 7:15 AM IST, right after symbolMaster.
  cron.schedule(
    config.syncSchedule.holidayCalendar,
    () => {
      console.log("[scheduler] Running scheduled holiday calendar sync …");
      void syncNseHolidayCalendar().then(r => {
        console.log(`[scheduler] Holiday calendar sync complete: ${r.upserted} rows upserted`);
      }).catch(err => {
        console.error("[scheduler] Holiday calendar sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Nightly EOD sync — 4:00 PM IST, full NSE universe, daily candles.
  cron.schedule(
    config.syncSchedule.eod,
    () => {
      console.log("[scheduler] Running scheduled EOD sync …");
      void runEodSyncJob().catch((err) => {
        console.error("[scheduler] EOD sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Nightly intraday sync — 4:30 PM IST, universe/candle-size per config.
  cron.schedule(
    config.syncSchedule.intraday,
    () => {
      console.log("[scheduler] Running scheduled intraday sync …");
      void runIntradaySyncJob().catch((err) => {
        console.error("[scheduler] Intraday sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Nightly options sync — 5:00 PM IST, ATM ± range CE/PE for configured
  // indices (and F&O stocks when config.includeStockOptions is true).
  cron.schedule(
    config.syncSchedule.options,
    () => {
      console.log("[scheduler] Running scheduled options sync …");
      void runOptionsSyncJob().catch((err) => {
        console.error("[scheduler] Options sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Nightly futures sync — 5:05 PM IST, front-month daily bar per F&O underlying.
  cron.schedule(
    config.syncSchedule.futures,
    () => {
      console.log("[scheduler] Running scheduled futures sync …");
      void runFuturesSyncJob().catch((err) => {
        console.error("[scheduler] Futures sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // F&O ban list — 8:30 AM IST (before market open). Fetches NSE's daily list
  // of securities banned from fresh F&O positions due to MWPL breach.
  cron.schedule(
    config.syncSchedule.foBanList,
    () => {
      console.log("[scheduler] Running scheduled F&O ban list fetch …");
      void runFoBanListJob().catch((err) => {
        console.error("[scheduler] F&O ban list failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Supplementary data — 5:30 PM IST. FII/DII daily activity + PE/PB/DivYield
  // for major indices, both from NSE.
  cron.schedule(
    config.syncSchedule.supplementary,
    () => {
      console.log("[scheduler] Running scheduled supplementary sync (FII/DII + PE) …");
      void runSupplementaryJob().catch((err) => {
        console.error("[scheduler] Supplementary sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // MF holdings — 5th of each month at 5:00 PM IST. Fetches AMFI's monthly
  // portfolio disclosure for the previous month (idempotent — safe to re-run).
  cron.schedule(
    config.syncSchedule.mfHoldings,
    () => {
      console.log("[scheduler] Running scheduled MF holdings sync …");
      void runMfHoldingsJob().catch((err) => {
        console.error("[scheduler] MF holdings sync failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  // Nightly cleanup — 6:00 PM IST. Single pass that enforces retention windows
  // across all tables. This is the only place retention deletes happen.
  cron.schedule(
    config.syncSchedule.cleanup,
    () => {
      console.log("[scheduler] Running scheduled nightly cleanup …");
      void runCleanupJob().catch((err) => {
        console.error("[scheduler] Cleanup failed:", err instanceof Error ? err.message : String(err));
      });
    },
    { timezone: config.timezone }
  );

  schedulerActive = true;
}

function nextFireTime(expression: string): string | null {
  try {
    const interval = CronExpressionParser.parse(expression, { tz: config.timezone });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export function getSchedulerStatus() {
  return {
    active: schedulerActive,
    runSchedulerInProcess: config.runSchedulerInProcess,
    // On Oracle, cron jobs are registered by a separate PM2 process
    // (server/src/scheduler/standalone.ts), not this one. `active` stays
    // false here by design — this flag tells the dashboard why, so it can
    // render "Running in separate scheduler process" instead of implying
    // jobs aren't running at all.
    runsInSeparateProcess: config.envLabel === "oracle",
    timezone: config.timezone,
    liveOptions: getAtmTrackerStatus(),
    catchUp: getCatchUpStatus(),
    // No more fixed liveOpen/liveClose cron times — the live feed's
    // connect/disconnect is driven by reconcileLiveFeedState() re-checking
    // this condition on an interval instead. Surface the live state of that
    // check so the dashboard can show "market open: X, feed connected: Y"
    // rather than a stale next-fire timestamp.
    liveFeed: {
      reconcileIntervalMinutes: LIVE_FEED_RECONCILE_INTERVAL_MINUTES,
      marketOpenNow: isMarketOpenNow(),
      connected: isConnected(),
      liveOpenExpression: config.syncSchedule.liveOpen,
      liveCloseExpression: config.syncSchedule.liveClose,
    },
    jobs: {
      symbolMaster: {
        expression: config.syncSchedule.symbolMaster,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.symbolMaster) : null,
      },
      holidayCalendar: {
        expression: config.syncSchedule.holidayCalendar,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.holidayCalendar) : null,
      },
      eod: {
        expression: config.syncSchedule.eod,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.eod) : null,
      },
      intraday: {
        expression: config.syncSchedule.intraday,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.intraday) : null,
      },
      options: {
        expression: config.syncSchedule.options,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.options) : null,
      },
      futures: {
        expression: config.syncSchedule.futures,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.futures) : null,
      },
      foBanList: {
        expression: config.syncSchedule.foBanList,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.foBanList) : null,
      },
      supplementary: {
        expression: config.syncSchedule.supplementary,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.supplementary) : null,
      },
      mfHoldings: {
        expression: config.syncSchedule.mfHoldings,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.mfHoldings) : null,
      },
      cleanup: {
        expression: config.syncSchedule.cleanup,
        nextRun: schedulerActive ? nextFireTime(config.syncSchedule.cleanup) : null,
      },
    },
  };
}
