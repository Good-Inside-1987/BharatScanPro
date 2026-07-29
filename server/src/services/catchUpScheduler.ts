/**
 * catchUpScheduler.ts
 *
 * Recovers missed nightly sync jobs (eod, intraday, options, foBanList,
 * supplementary) — deliberately excludes mfHoldings, which is already
 * monthly and idempotent and manages its own "current month" logic.
 *
 * Two triggers:
 *   A) On startup (runStartupCatchUp) — walks forward from each job's last
 *      logged successful date to yesterday (IST), skipping weekends and any
 *      populated nse_holidays date, running the job for every missed trading
 *      day. Deliberately stops at yesterday, not today: today is left to the
 *      normal cron schedule (or trigger B below) so an early catch-up run
 *      right after a restart can never race a same-day scheduled fire, and
 *      can never mark "today" complete before the job's real scheduled time
 *      (e.g. running EOD before market close would just find no new close
 *      bar yet).
 *   B) Periodically while the process stays up (runPeriodicCatchUpCheck,
 *      every CHECK_INTERVAL_MS) — for each job whose scheduled time has
 *      already passed today with no logged successful completion for today,
 *      retries it. Covers silent same-day failures (network blip, broker
 *      timeout) without needing a restart.
 *
 * Both triggers share the same daily request budget as normal runs. If the
 * budget runs out partway through a backlog, the loop stops cleanly —
 * sync_log already reflects exactly which dates succeeded, so the next
 * startup or periodic check simply recomputes the remaining gap and picks
 * up where it left off; no separate "remaining backlog" state is persisted.
 */

import { config } from "../config/environment.js";
import {
  runEodSyncJob,
  runIntradaySyncJob,
  getLastSuccessDate,
  hasSuccessfulRunForDate,
  todayIST,
} from "./syncJobs.js";
import { runOptionsSyncJob } from "./optionsDataService.js";
import { runFoBanListJob } from "./foBanListService.js";
import { runSupplementaryJob } from "./supplementaryJobs.js";
import { getServiceStats } from "./marketDataService.js";
import { addDays, isTradingDay, mostRecentTradingDay } from "./tradingCalendar.js";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Set to true when startup catch-up exits with jobs still pending (skipped
// because no broker was connected yet).  Cleared once the broker-connect
// retry completes so it doesn't re-fire on every subsequent login.
let startupSkippedNoBroker = false;

// ── Job registry ──────────────────────────────────────────────────────────────
// scheduleKey indexes into config.syncSchedule to know each job's normal
// cron time, for the "has today's scheduled time already passed" check.

interface CatchUpJob {
  jobName: string;
  scheduleKey: keyof typeof config.syncSchedule;
  run: (targetDate: string) => Promise<unknown>;
}

const JOBS: CatchUpJob[] = [
  { jobName: "eod_sync",     scheduleKey: "eod",           run: runEodSyncJob },
  { jobName: "intraday_sync",scheduleKey: "intraday",      run: runIntradaySyncJob },
  { jobName: "options_sync", scheduleKey: "options",       run: runOptionsSyncJob },
  { jobName: "fo_ban_list",  scheduleKey: "foBanList",     run: runFoBanListJob },
  { jobName: "supplementary",scheduleKey: "supplementary", run: runSupplementaryJob },
];

// ── Date helpers (IST, string-based to avoid UTC day-shift bugs) ─────────────
// isWeekend/isHoliday/isTradingDay/mostRecentTradingDay/addDays now live in
// tradingCalendar.ts, shared with syncJobs.ts and marketData.ts routes.

/** All trading days strictly between `fromExclusive` and `toInclusive`. */
function listMissedWeekdays(fromExclusive: string, toInclusive: string): string[] {
  const days: string[] = [];
  let cursor = addDays(fromExclusive, 1);
  while (cursor <= toInclusive) {
    if (isTradingDay(cursor)) days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

// ── Scheduled-time-passed check (for trigger B) ──────────────────────────────
// Our cron expressions are all plain "M H * * D" (fixed minute/hour), so a
// direct regex extraction is simpler and more transparent here than pulling
// in full cron-parser semantics.

function scheduledHourMinuteToday(cronExpr: string): { hour: number; minute: number } | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isFinite(minute) || !Number.isFinite(hour)) return null;
  return { hour, minute };
}

function hasScheduledTimePassedToday(cronExpr: string): boolean {
  const hm = scheduledHourMinuteToday(cronExpr);
  if (!hm) return false;
  const nowIstStr = new Date().toLocaleTimeString("en-GB", { timeZone: config.timezone, hour12: false });
  const [nowH, nowM] = nowIstStr.split(":").map(Number);
  return nowH > hm.hour || (nowH === hm.hour && nowM >= hm.minute);
}

// ── Status, for the Backfill/Nightly Sync dashboard ──────────────────────────

export interface CatchUpStatus {
  active: boolean;
  jobName: string | null;
  currentDate: string | null;
  completedCount: number;
  totalCount: number;
  lastRunAt: string | null;
  lastRunReason: "startup" | "periodic" | null;
}

const status: CatchUpStatus = {
  active: false,
  jobName: null,
  currentDate: null,
  completedCount: 0,
  totalCount: 0,
  lastRunAt: null,
  lastRunReason: null,
};

export function getCatchUpStatus(): CatchUpStatus {
  return { ...status };
}

function budgetExhausted(): boolean {
  return getServiceStats().remainingBudgetToday <= 0;
}

// ── Trigger A: startup catch-up ───────────────────────────────────────────────

let catchUpInFlight = false;

export async function runStartupCatchUp(): Promise<void> {
  if (catchUpInFlight) return;
  catchUpInFlight = true;
  startupSkippedNoBroker = false;
  status.active = true;
  status.lastRunReason = "startup";

  try {
    const yesterday = addDays(todayIST(), -1);

    // Build the full backlog across all jobs up front so the dashboard can
    // show accurate "X of Y" progress instead of resetting per-job.
    const backlog: Array<{ job: CatchUpJob; date: string }> = [];
    for (const job of JOBS) {
      const lastSuccess = getLastSuccessDate(job.jobName);
      if (!lastSuccess) {
        // Never run before — walking forward from a last-success date that
        // doesn't exist means there's nothing to walk forward from. Bootstrap
        // with at least one real day of data (the most recent trading day)
        // instead of skipping forever; deep multi-year backfill stays the
        // deliberate manual "Load from connected broker" flow.
        const bootstrapDate = mostRecentTradingDay(yesterday);
        if (!hasSuccessfulRunForDate(job.jobName, bootstrapDate)) {
          backlog.push({ job, date: bootstrapDate });
        }
        continue;
      }
      const missed = listMissedWeekdays(lastSuccess, yesterday)
        .filter((d) => !hasSuccessfulRunForDate(job.jobName, d));
      for (const date of missed) backlog.push({ job, date });
    }

    status.totalCount = backlog.length;
    status.completedCount = 0;

    if (backlog.length === 0) {
      console.log("[catchUpScheduler] No missed trading days found on startup — nothing to catch up");
      return;
    }

    console.log(
      "[catchUpScheduler] Startup catch-up: %d missed job/day runs to process",
      backlog.length
    );

    for (const { job, date } of backlog) {
      if (budgetExhausted()) {
        console.warn(
          "[catchUpScheduler] Daily request budget exhausted — stopping catch-up at %d/%d " +
          "(resumes on next startup or periodic check)",
          status.completedCount, status.totalCount
        );
        break;
      }

      status.jobName = job.jobName;
      status.currentDate = date;
      console.log("[catchUpScheduler] Catching up %s for %s …", job.jobName, date);

      try {
        const result = await job.run(date) as { skippedNoAdapter?: boolean } | undefined;
        if (result?.skippedNoAdapter) {
          // Broker wasn't connected — flag so onBrokerFirstConnected() can retry.
          startupSkippedNoBroker = true;
        }
      } catch (err) {
        console.error(
          "[catchUpScheduler] Catch-up run failed for %s @ %s: %s",
          job.jobName, date, err instanceof Error ? err.message : String(err)
        );
        // Keep going — sync_log already records the failure; next check retries it.
      }

      status.completedCount++;
      status.lastRunAt = new Date().toISOString();
    }
  } finally {
    status.active = false;
    status.jobName = null;
    status.currentDate = null;
    catchUpInFlight = false;
  }
}

/**
 * Call this once after a broker successfully authenticates.  If the startup
 * catch-up previously exited early because no broker was connected, this
 * re-triggers it so EOD/intraday jobs that were skipped can now run.
 * Safe to call multiple times — only acts when there is actually work to do.
 */
export function onBrokerFirstConnected(): void {
  if (!startupSkippedNoBroker) return;
  startupSkippedNoBroker = false; // clear immediately so concurrent logins don't double-fire
  console.log("[catchUpScheduler] Broker just connected — re-running startup catch-up for previously-skipped jobs …");
  void runStartupCatchUp().catch((err) => {
    console.error(
      "[catchUpScheduler] Broker-connect catch-up failed:",
      err instanceof Error ? err.message : String(err)
    );
  });
}

// ── Trigger B: periodic same-day retry ───────────────────────────────────────

export async function runPeriodicCatchUpCheck(): Promise<void> {
  if (catchUpInFlight) return;
  catchUpInFlight = true;
  status.active = true;
  status.lastRunReason = "periodic";

  try {
    const today = todayIST();
    if (!isTradingDay(today)) return;

    const due = JOBS.filter(
      (job) =>
        hasScheduledTimePassedToday(config.syncSchedule[job.scheduleKey]) &&
        !hasSuccessfulRunForDate(job.jobName, today)
    );

    status.totalCount = due.length;
    status.completedCount = 0;
    if (due.length === 0) return;

    console.log(
      "[catchUpScheduler] Periodic check: %d job(s) due today with no successful run yet — retrying",
      due.length
    );

    for (const job of due) {
      // No outer budget gate here — the sync jobs use an "already-covered"
      // fast path (free, no broker calls) for symbols already in the DB.
      // Budget exhaustion is handled per-symbol inside runSymbolLoop, so the
      // job can still complete and log a sync_log "completed" row even when
      // budget is zero (all symbols covered by the live feed or prior runs).

      status.jobName = job.jobName;
      status.currentDate = today;
      console.log("[catchUpScheduler] Retrying %s for %s (no successful run logged yet) …", job.jobName, today);

      try {
        await job.run(today);
      } catch (err) {
        console.error(
          "[catchUpScheduler] Periodic retry failed for %s @ %s: %s",
          job.jobName, today, err instanceof Error ? err.message : String(err)
        );
      }

      status.completedCount++;
      status.lastRunAt = new Date().toISOString();
    }
  } finally {
    status.active = false;
    status.jobName = null;
    status.currentDate = null;
    catchUpInFlight = false;
  }
}

let periodicTimer: NodeJS.Timeout | null = null;

/** Starts the 30-minute periodic same-day retry check. Runs one check
 *  immediately on registration (covers restarting/opening the app any
 *  time after a job's scheduled time has already passed, without
 *  waiting up to a full CHECK_INTERVAL_MS for the first interval tick),
 *  then continues on the regular interval. Idempotent. */
export function startPeriodicCatchUpCheck(): void {
  if (periodicTimer) return;

  void runPeriodicCatchUpCheck().catch((err) => {
    console.error(
      "[catchUpScheduler] Initial periodic check crashed:",
      err instanceof Error ? err.message : String(err)
    );
  });

  periodicTimer = setInterval(() => {
    void runPeriodicCatchUpCheck().catch((err) => {
      console.error(
        "[catchUpScheduler] Periodic check crashed:",
        err instanceof Error ? err.message : String(err)
      );
    });
  }, CHECK_INTERVAL_MS);
}

/** For tests/shutdown — stops the periodic timer. */
export function stopPeriodicCatchUpCheck(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}
