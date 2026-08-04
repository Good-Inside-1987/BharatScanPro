// Single source of truth for all environment-specific settings.
// Auto-detects Replit (via REPL_ID env var) vs Oracle vs local/Electron
// (via APP_ENV=local). Angel API sync jobs read all their settings from
// this object — nothing is hardcoded inside the sync jobs themselves.
//
// Data-volume settings only ever differ between "replit" (reduced
// footprint) and "full" (Oracle + local/Electron share the same full-scale
// settings). `envLabel` is a separate three-way label used purely for
// logging/display so we can still say "local" vs "oracle" in logs.

import path from "path";
import { fileURLToPath } from "url";

// Project root = one level up from server/src/config/ (server/src/config -> server/src -> server -> root)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const isReplit = !!process.env.REPL_ID;
const isLocal = process.env.APP_ENV === "local";

// Data-volume env: "replit" gets the reduced footprint, "full" (Oracle or
// local/Electron) gets the full-scale settings. Existing retention/volume
// logic below is unchanged — only the type name changed from "oracle" to
// "full".
const env: "replit" | "full" = isReplit ? "replit" : "full";

// Display-only three-way label for logging, independent of data-volume env.
// Explicit and bounded to exactly "replit" | "oracle" | "local" — never a
// pass-through of an arbitrary APP_ENV value.
const envLabel: "replit" | "oracle" | "local" = isLocal
  ? "local"
  : isReplit
  ? "replit"
  : "oracle";

export const config = {
  // Which environment we're running in (data-volume settings)
  env,
  isReplit,

  // Three-way label for logging/display only (e.g. "Running in local mode").
  // Does NOT affect any retention/data-volume logic above — "oracle" and
  // "local" both map to env: "full".
  envLabel,

  // Where database files are stored
  // In Replit: project root /data/
  // On Oracle: set DB_DIR env var in .env to wherever you want them
  // Resolved relative to the project root (not process.cwd()) so it
  // works regardless of which package directory the process is launched from.
  dbDir: process.env.DB_DIR
    ? (path.isAbsolute(process.env.DB_DIR)
        ? process.env.DB_DIR
        : path.resolve(projectRoot, process.env.DB_DIR))
    : path.join(projectRoot, "data"),

  // ── EOD stock data ──────────────────────────────────────────────
  // Universe is always all NSE stocks in both environments.
  // Only the retention depth differs.
  eodRetentionYears: isReplit ? 3 : 10,

  // ── EOD stock data universe ─────────────────────────────────────
  // Replit: restrict to F&O-eligible stocks (~211) to stay within the daily
  // API budget — syncing all ~2960 symbols exhausts the budget before
  // Intraday sync gets a chance to run.
  // Oracle: all NSE stocks (no budget concern).
  eodUniverse: isReplit ? "fo_stocks" : "all_nse" as const,

  // ── Intraday stock data ─────────────────────────────────────────
  // Replit: only F&O stocks (~211), 5-min candles, 3-month rolling window
  // Oracle: all NSE stocks, 1-min candles, kept forever
  intradayUniverse: isReplit ? "fo_stocks" : "all_nse" as const,
  intradayCandleSize: isReplit ? "5min" : "1min" as const,
  intradayRetentionMonths: isReplit ? 3 : null, // null = keep forever

  // ── Options data ────────────────────────────────────────────────
  // Strike ranges: indices get wider range (more liquid far OTM strikes)
  //                stocks get narrower range (far OTM stock options are useless)
  optionsIndices: isReplit
    ? ["NIFTY", "SENSEX"]
    : ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "MIDCPNIFTY"],
  includeStockOptions: !isReplit,     // stock options only on Oracle
  indexOptionsStrikeRange: 30,        // ATM ±30 for all indices — both environments
  stockOptionsStrikeRange: 20,        // ATM ±20 for F&O stocks — Oracle only
  indexOptionsRetentionMonths: isReplit ? 1 : 9,
  stockOptionsRetentionMonths: isReplit ? 0 : 6,

  // ── Supplementary data ──────────────────────────────────────────
  fiiDiiRetentionYears: isReplit ? 3 : 10,
  peRatioRetentionYears: isReplit ? 3 : 5,
  mfHoldingsRetentionYears: isReplit ? 2 : 5,

  // ── Scheduler ───────────────────────────────────────────────────
  // CRITICAL: always use Asia/Kolkata — Oracle server defaults to UTC.
  // Never use system timezone or a hardcoded UTC offset.
  timezone: "Asia/Kolkata" as const,

  // All times in IST (24-hour). Cron expressions use this timezone explicitly.
  syncSchedule: {
    foBanList:    "30 8 * * 1-5",   // 8:30 AM IST — fetch before market opens
    eod:          "0 16 * * 1-5",   // 4:00 PM IST — after market close
    intraday:     "30 16 * * 1-5",  // 4:30 PM IST
    options:      "0 17 * * 1-5",   // 5:00 PM IST
    supplementary:"30 17 * * 1-5",  // 5:30 PM IST — FII/DII, PE, MF
    cleanup:      "0 18 * * 1-5",   // 6:00 PM IST — delete old data
    liveOpen:     "0 9 * * 1-5",    // 9:00 AM IST — start WebSocket
    liveClose:    "35 15 * * 1-5",  // 3:35 PM IST — close WebSocket
    symbolMaster: "0 7 * * 1",      // 7:00 AM IST every Monday
    holidayCalendar: "15 7 * * 1",  // 7:15 AM IST every Monday — right after symbolMaster
    mfHoldings:   "0 17 5 * *",     // 5th of each month at 5 PM
  },

  // Whether the scheduler runs inside the Express process (Replit + local/
  // Electron) or as a completely separate PM2 process (real Oracle server
  // deployments only, via server/scheduler/standalone.js).
  // On Oracle, deploy only restarts bharatscan (web server),
  // never bharatscan-scheduler, so a 4 PM sync is never interrupted
  // by a routine code deploy. Local/Electron has no separate PM2 process,
  // so it must run scheduled jobs in-process like Replit does.
  runSchedulerInProcess: envLabel !== "oracle",

  // ── Market data backfill budget ──────────────────────────────────
  // Maximum broker API requests the backfill service may make per
  // calendar day (IST). Stays well below Fyers' 10 req/sec burst
  // limit while bounding total daily API consumption.
  // Replit: conservative — free-tier broker accounts have low caps.
  // Full: 20000 covers one full EOD + intraday cycle for all ~2960 NSE
  // symbols (≈5920 requests) with headroom for options sync, live-feed
  // quote polling, and multi-day catch-up backlog processing — raised
  // from the original 8000 after confirming Fyers' real per-account
  // daily cap is far higher (100,000/day per their v3 docs), and after
  // fixing the per-minute pacing gap that was the actual cause of
  // premature "request limit reached" 429s (see Prompt 32).
  // Override with BACKFILL_DAILY_REQUEST_BUDGET env var if needed.
  backfillDailyRequestBudget: process.env.BACKFILL_DAILY_REQUEST_BUDGET
    ? parseInt(process.env.BACKFILL_DAILY_REQUEST_BUDGET, 10)
    : isReplit ? 500 : 20000,
};

export type AppConfig = typeof config;
