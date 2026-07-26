/**
 * Durable historical EOD backfill.
 *
 * This job deliberately calls fetchHistoricalChunk() instead of a broker adapter
 * directly. That keeps Fyers error classification, pacing, daily budget, and
 * backfill_progress coverage in one place while this service owns the durable
 * job/task ledger and restart semantics.
 */

import { marketDb } from "../db.js";
import { config } from "../config/environment.js";
import {
  getAuthenticatedAdapter,
  fetchHistoricalChunk,
  getHistoricalCoverage,
  getServiceStats,
} from "./marketDataService.js";
import {
  AuthenticationError,
  InvalidSymbolError,
  RateLimitError,
  SessionExpiredError,
} from "../errors/brokerErrors.js";

const JOB_NAME = "historical_eod";
const RESOLUTION = "1D";
const TASK_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  NO_DATA: "no_data",
  FAILED: "failed",
  INVALID: "skipped_invalid",
} as const;

type JobStatus = "running" | "paused" | "completed";
type PauseReason =
  | "daily_budget"
  | "no_broker"
  | "session_expired"
  | "retryable_failures"
  | "process_restart"
  | "manual";

interface JobRow {
  id: number;
  job_name: string;
  resolution: string;
  from_date: string;
  to_date: string;
  universe: string;
  status: JobStatus;
  pause_reason: PauseReason | null;
  total_tasks: number;
  requests_used: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface TaskRow {
  id: number;
  job_id: number;
  symbol: string;
  fyers_symbol: string;
  resolution: string;
  from_date: string;
  to_date: string;
  status: string;
  attempts: number;
}

interface SymbolRow {
  symbol: string;
  fyers_symbol: string | null;
}

let workerJobId: number | null = null;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function todayIST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function yearsAgo(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return value.toISOString().slice(0, 10);
}

function fallbackFyersSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  return normalized.includes(":") ? normalized : `NSE:${normalized}-EQ`;
}

function chunkRange(from: string, to: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = from;
  while (cursor <= to) {
    const chunkTo = addDays(cursor, 364);
    const end = chunkTo < to ? chunkTo : to;
    chunks.push({ from: cursor, to: end });
    cursor = addDays(end, 1);
  }
  return chunks;
}

function latestJob(): JobRow | undefined {
  return marketDb
    .prepare(
      `SELECT * FROM historical_backfill_jobs
       WHERE job_name = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(JOB_NAME) as unknown as JobRow | undefined;
}

function getJob(jobId: number): JobRow | undefined {
  return marketDb
    .prepare("SELECT * FROM historical_backfill_jobs WHERE id = ?")
    .get(jobId) as unknown as JobRow | undefined;
}

function setJobStatus(
  jobId: number,
  status: JobStatus,
  pauseReason: PauseReason | null,
  finishedAt: string | null = null
): void {
  marketDb
    .prepare(
      `UPDATE historical_backfill_jobs
          SET status = ?, pause_reason = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(status, pauseReason, finishedAt, nowIso(), jobId);
}

function resetRetryableTasks(jobId: number): void {
  marketDb
    .prepare(
      `UPDATE historical_backfill_tasks
          SET status = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE job_id = ? AND status IN (?, ?)`
    )
    .run(TASK_STATUS.PENDING, nowIso(), jobId, TASK_STATUS.NO_DATA, TASK_STATUS.FAILED);
}

function markKnownInvalid(symbol: string): void {
  try {
    marketDb
      .prepare("UPDATE symbols SET fyers_eod_invalid = 1 WHERE symbol = ?")
      .run(symbol);
  } catch {
    // The task remains durably marked invalid even if an older database does
    // not yet have the optional symbol flag column.
  }
}

function claimNextTask(jobId: number): TaskRow | undefined {
  const task = marketDb
    .prepare(
      `SELECT * FROM historical_backfill_tasks
        WHERE job_id = ? AND status = ?
        ORDER BY id LIMIT 1`
    )
    .get(jobId, TASK_STATUS.PENDING) as unknown as TaskRow | undefined;

  if (!task) return undefined;

  const changed = marketDb
    .prepare(
      `UPDATE historical_backfill_tasks
          SET status = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status = ?`
    )
    .run(TASK_STATUS.RUNNING, nowIso(), task.id, TASK_STATUS.PENDING);

  return Number(changed.changes) === 1
    ? { ...task, status: TASK_STATUS.RUNNING, attempts: task.attempts + 1 }
    : undefined;
}

function updateTask(
  taskId: number,
  status: string,
  barsReceived: number,
  errorCode: string | null = null,
  errorMessage: string | null = null
): void {
  marketDb
    .prepare(
      `UPDATE historical_backfill_tasks
          SET status = ?, bars_received = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(status, barsReceived, errorCode, errorMessage, nowIso(), taskId);
}

function incrementJobRequests(jobId: number): void {
  marketDb
    .prepare(
      `UPDATE historical_backfill_jobs
          SET requests_used = requests_used + 1, updated_at = ?
        WHERE id = ?`
    )
    .run(nowIso(), jobId);
}

function taskCounts(jobId: number): Record<string, number> {
  const rows = marketDb
    .prepare(
      `SELECT status, COUNT(*) AS count
         FROM historical_backfill_tasks
        WHERE job_id = ?
        GROUP BY status`
    )
    .all(jobId) as unknown as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function scheduleBudgetWake(jobId: number): void {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    const job = getJob(jobId);
    if (!job || job.status !== "paused" || job.pause_reason !== "daily_budget") return;
    if (getServiceStats().remainingBudgetToday > 0) {
      setJobStatus(jobId, "running", null);
      void runWorker(jobId);
      return;
    }
    scheduleBudgetWake(jobId);
  }, 60_000);
  wakeTimer.unref?.();
}

async function runWorker(jobId: number): Promise<void> {
  if (workerJobId !== null) return;
  workerJobId = jobId;

  try {
    while (true) {
      const job = getJob(jobId);
      if (!job || job.status !== "running") return;

      const adapter = await getAuthenticatedAdapter();
      if (!adapter) {
        setJobStatus(jobId, "paused", "no_broker");
        return;
      }

      if (getServiceStats().remainingBudgetToday <= 0) {
        setJobStatus(jobId, "paused", "daily_budget");
        scheduleBudgetWake(jobId);
        return;
      }

      const task = claimNextTask(jobId);
      if (!task) {
        const counts = taskCounts(jobId);
        const retryable = (counts[TASK_STATUS.NO_DATA] ?? 0) + (counts[TASK_STATUS.FAILED] ?? 0);
        const pending = (counts[TASK_STATUS.PENDING] ?? 0) + (counts[TASK_STATUS.RUNNING] ?? 0);
        if (pending === 0 && retryable === 0) {
          setJobStatus(jobId, "completed", null, nowIso());
        } else if (pending === 0) {
          setJobStatus(jobId, "paused", "retryable_failures");
        }
        return;
      }

      const coverage = getHistoricalCoverage(
        task.fyers_symbol,
        task.resolution,
        task.from_date,
        task.to_date
      );

      if (coverage.gaps.length === 0) {
        updateTask(task.id, TASK_STATUS.COMPLETED, 0);
        continue;
      }

      try {
        const bars = await fetchHistoricalChunk(
          task.fyers_symbol,
          task.resolution,
          task.from_date,
          task.to_date,
          () => incrementJobRequests(jobId)
        );
        if (bars.length > 0) {
          updateTask(task.id, TASK_STATUS.COMPLETED, bars.length);
        } else {
          // Do not alter backfill_progress. This remains retryable rather than
          // falsely claiming that the whole task was loaded.
          updateTask(task.id, TASK_STATUS.NO_DATA, 0, "NO_DATA", "Broker returned zero candles");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof InvalidSymbolError) {
          markKnownInvalid(task.symbol);
          updateTask(task.id, TASK_STATUS.INVALID, 0, error.code, message);
          continue;
        }
        if (error instanceof AuthenticationError || error instanceof SessionExpiredError) {
          updateTask(task.id, TASK_STATUS.PENDING, 0, error.code, message);
          setJobStatus(
            jobId,
            "paused",
            error instanceof SessionExpiredError ? "session_expired" : "no_broker"
          );
          return;
        }
        if (error instanceof RateLimitError) {
          updateTask(task.id, TASK_STATUS.FAILED, 0, error.code, message);
          setJobStatus(jobId, "paused", "daily_budget");
          scheduleBudgetWake(jobId);
          return;
        }
        updateTask(task.id, TASK_STATUS.FAILED, 0, "BROKER_ERROR", message);
      }
    }
  } finally {
    workerJobId = null;
  }
}

function jobStatus(job: JobRow | undefined) {
  if (!job) return null;

  const counts = taskCounts(job.id);
  const symbolCounts = marketDb
    .prepare(
      `SELECT
         COUNT(DISTINCT symbol) AS total_symbols,
         COUNT(DISTINCT CASE WHEN NOT EXISTS (
           SELECT 1
             FROM historical_backfill_tasks remaining
            WHERE remaining.job_id = historical_backfill_tasks.job_id
              AND remaining.symbol = historical_backfill_tasks.symbol
              AND remaining.status NOT IN (?, ?)
         ) THEN symbol END) AS completed_symbols,
         COUNT(DISTINCT CASE WHEN status IN (?, ?) THEN symbol END) AS retryable_symbols
         FROM historical_backfill_tasks
        WHERE job_id = ?`
    )
    .get(
      TASK_STATUS.COMPLETED,
      TASK_STATUS.INVALID,
      TASK_STATUS.NO_DATA,
      TASK_STATUS.FAILED,
      job.id
    ) as unknown as {
      total_symbols: number;
      completed_symbols: number;
      retryable_symbols: number;
    };

  const persistedRange = marketDb
    .prepare(
      `SELECT MIN(o.date) AS earliest, MAX(o.date) AS latest
         FROM ohlcv_daily o
         JOIN (SELECT DISTINCT fyers_symbol FROM historical_backfill_tasks WHERE job_id = ?) t
           ON t.fyers_symbol = o.symbol`
    )
    .get(job.id) as unknown as { earliest: string | null; latest: string | null };

  const service = getServiceStats();
  const pendingTasks = (counts[TASK_STATUS.PENDING] ?? 0) + (counts[TASK_STATUS.RUNNING] ?? 0);
  const retryableTasks = (counts[TASK_STATUS.NO_DATA] ?? 0) + (counts[TASK_STATUS.FAILED] ?? 0);

  return {
    id: job.id,
    status: job.status,
    pauseReason: job.pause_reason,
    resolution: job.resolution,
    fromDate: job.from_date,
    toDate: job.to_date,
    universe: job.universe,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    updatedAt: job.updated_at,
    totalSymbols: Number(symbolCounts?.total_symbols ?? 0),
    completedSymbols: Number(symbolCounts?.completed_symbols ?? 0),
    retryableSymbols: Number(symbolCounts?.retryable_symbols ?? 0),
    totalTasks: job.total_tasks,
    completedTasks: counts[TASK_STATUS.COMPLETED] ?? 0,
    noDataTasks: counts[TASK_STATUS.NO_DATA] ?? 0,
    invalidTasks: counts[TASK_STATUS.INVALID] ?? 0,
    failedTasks: counts[TASK_STATUS.FAILED] ?? 0,
    pendingTasks,
    retryableTasks,
    requestsUsed: job.requests_used,
    requestsRemainingToday: service.remainingBudgetToday,
    earliestPersistedDate: persistedRange?.earliest ?? null,
    latestPersistedDate: persistedRange?.latest ?? null,
    workerRunning: workerJobId === job.id,
  };
}

export function getHistoricalBackfillStatus() {
  return jobStatus(latestJob());
}

export function startHistoricalBackfill(): ReturnType<typeof getHistoricalBackfillStatus> {
  const existing = latestJob();
  if (existing && (existing.status === "running" || existing.status === "paused")) {
    if (existing.status === "paused" && existing.pause_reason !== "manual") {
      resetRetryableTasks(existing.id);
      setJobStatus(existing.id, "running", null);
      void runWorker(existing.id);
    } else if (existing.status === "paused") {
      resetRetryableTasks(existing.id);
      setJobStatus(existing.id, "running", null);
      void runWorker(existing.id);
    }
    return jobStatus(getJob(existing.id));
  }

  const toDate = todayIST();
  const fromDate = yearsAgo(toDate, config.eodRetentionYears);
  const symbolQuery =
    config.eodUniverse === "fo_stocks"
      ? `SELECT symbol, fyers_symbol FROM symbols
           WHERE is_delisted = 0 AND is_fo_eligible = 1 AND fyers_eod_invalid = 0
           ORDER BY symbol`
      : `SELECT symbol, fyers_symbol FROM symbols
           WHERE is_delisted = 0 AND fyers_eod_invalid = 0
           ORDER BY symbol`;
  const symbols = marketDb.prepare(symbolQuery).all() as unknown as SymbolRow[];
  if (!symbols.length) throw new Error("No eligible symbols are available for historical backfill");

  const createdAt = nowIso();
  let jobId: number;
  const chunks = chunkRange(fromDate, toDate);

  marketDb.exec("BEGIN");
  try {
    const result = marketDb
      .prepare(
        `INSERT INTO historical_backfill_jobs
          (job_name, resolution, from_date, to_date, universe, status, created_at, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(JOB_NAME, RESOLUTION, fromDate, toDate, config.eodUniverse, createdAt, createdAt, createdAt);
    jobId = Number(result.lastInsertRowid);

    const insertTask = marketDb.prepare(
      `INSERT INTO historical_backfill_tasks
        (job_id, symbol, fyers_symbol, resolution, from_date, to_date, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of symbols) {
      const fyersSymbol = row.fyers_symbol ?? fallbackFyersSymbol(row.symbol);
      for (const chunk of chunks) {
        insertTask.run(
          jobId,
          row.symbol,
          fyersSymbol,
          RESOLUTION,
          chunk.from,
          chunk.to,
          TASK_STATUS.PENDING,
          createdAt
        );
      }
    }

    marketDb
      .prepare("UPDATE historical_backfill_jobs SET total_tasks = ?, updated_at = ? WHERE id = ?")
      .run(symbols.length * chunks.length, createdAt, jobId);
    marketDb.exec("COMMIT");
  } catch (error) {
    marketDb.exec("ROLLBACK");
    throw error;
  }

  void runWorker(jobId);
  return jobStatus(getJob(jobId));
}

export function pauseHistoricalBackfill(): ReturnType<typeof getHistoricalBackfillStatus> {
  const job = latestJob();
  if (!job || job.status === "completed") return jobStatus(job);
  setJobStatus(job.id, "paused", "manual");
  return jobStatus(getJob(job.id));
}

/**
 * Resume active work after a user action, a broker login, or a process
 * restart. Only the latest active job is resumed; completed history is never
 * silently rebuilt.
 */
export function resumeHistoricalBackfill(): ReturnType<typeof getHistoricalBackfillStatus> {
  const job = latestJob();
  if (!job || job.status === "completed") return jobStatus(job);
  resetRetryableTasks(job.id);
  setJobStatus(job.id, "running", null);
  void runWorker(job.id);
  return jobStatus(getJob(job.id));
}

export function resumeHistoricalBackfillOnStartup(): void {
  const job = latestJob();
  if (!job || job.status === "completed" || job.status === "paused" && job.pause_reason === "manual") return;

  // A running row can only be left by a process crash/restart because this
  // service is single-worker. Leased task rows must be made claimable again.
  marketDb
    .prepare(
      `UPDATE historical_backfill_tasks SET status = ?, updated_at = ?
        WHERE job_id = ? AND status = ?`
    )
    .run(TASK_STATUS.PENDING, nowIso(), job.id, TASK_STATUS.RUNNING);
  setJobStatus(job.id, "running", null);
  void runWorker(job.id);
}
