import { DatabaseSync } from "node:sqlite";

export function initMarketDb(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    -- ── Symbol master ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS symbols (
      token           TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      exchange        TEXT NOT NULL,
      isin            TEXT,
      name            TEXT,
      sector          TEXT,
      industry        TEXT,
      lot_size        INTEGER NOT NULL DEFAULT 1,
      tick_size       REAL NOT NULL DEFAULT 0.05,
      instrument_type TEXT,
      is_fo_eligible  INTEGER NOT NULL DEFAULT 0,
      index_membership TEXT,
      listing_date    TEXT,
      is_delisted     INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_lookup
      ON symbols(symbol, exchange);
    CREATE INDEX IF NOT EXISTS idx_symbols_fo
      ON symbols(is_fo_eligible);

    -- ── EOD prices ────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ohlcv_daily (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol  TEXT NOT NULL,
      date    TEXT NOT NULL,
      open    REAL,
      high    REAL,
      low     REAL,
      close   REAL,
      volume  INTEGER,
      UNIQUE(symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_ohlcv_daily
      ON ohlcv_daily(symbol, date);

    -- ── Intraday prices (5-min Replit / 1-min Oracle) ─────────────
    CREATE TABLE IF NOT EXISTS ohlcv_intraday (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol    TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      open      REAL,
      high      REAL,
      low       REAL,
      close     REAL,
      volume    INTEGER,
      UNIQUE(symbol, timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_ohlcv_intraday
      ON ohlcv_intraday(symbol, timestamp);

    -- ── Options intraday ──────────────────────────────────────────
    -- Index options: ATM ±30 strikes, both CE and PE
    -- Stock options: ATM ±20 strikes, both CE and PE
    CREATE TABLE IF NOT EXISTS options_intraday (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      underlying  TEXT NOT NULL,
      expiry      TEXT NOT NULL,
      strike      REAL NOT NULL,
      option_type TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      open        REAL,
      high        REAL,
      low         REAL,
      close       REAL,
      volume      INTEGER,
      oi          INTEGER,
      UNIQUE(underlying, expiry, strike, option_type, timestamp)
    );
    CREATE INDEX IF NOT EXISTS idx_options_intraday
      ON options_intraday(underlying, expiry, timestamp);

    -- ── FII / DII ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS fii_dii (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      date       TEXT NOT NULL,
      category   TEXT NOT NULL,
      segment    TEXT NOT NULL,
      buy_value  REAL,
      sell_value REAL,
      net_value  REAL,
      UNIQUE(date, category, segment)
    );
    CREATE INDEX IF NOT EXISTS idx_fii_dii ON fii_dii(date);

    -- ── PE ratios ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS pe_ratio (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol_or_index TEXT NOT NULL,
      date            TEXT NOT NULL,
      pe              REAL,
      pb              REAL,
      div_yield       REAL,
      UNIQUE(symbol_or_index, date)
    );
    CREATE INDEX IF NOT EXISTS idx_pe ON pe_ratio(symbol_or_index, date);

    -- ── Mutual fund holdings ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS mf_holdings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fund_name   TEXT NOT NULL,
      scheme_code TEXT,
      month_year  TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      isin        TEXT,
      shares_held INTEGER,
      percentage  REAL,
      UNIQUE(scheme_code, month_year, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_mf ON mf_holdings(symbol, month_year);

    -- ── F&O ban list (fetched daily at 8:30 AM IST) ───────────────
    CREATE TABLE IF NOT EXISTS fo_ban_list (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      date             TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      mwpl_percentage  REAL,
      UNIQUE(date, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_ban ON fo_ban_list(date);

    -- ── NSE holiday calendar ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS nse_holidays (
      date        TEXT PRIMARY KEY,
      description TEXT
    );

    -- ── Sync job log ──────────────────────────────────────────────
    -- target_date is the trading date (YYYY-MM-DD, IST) this run actually
    -- processed — distinct from started_at, which is a wall-clock timestamp.
    -- It lets the catch-up orchestrator (catchUpScheduler.ts) tell "ran but
    -- for an old date" apart from "ran today", and find gaps precisely.
    CREATE TABLE IF NOT EXISTS sync_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name       TEXT NOT NULL,
      started_at     TEXT NOT NULL,
      finished_at    TEXT,
      status         TEXT,
      rows_processed INTEGER NOT NULL DEFAULT 0,
      error_message  TEXT,
      target_date    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log
      ON sync_log(job_name, started_at);
    -- idx_sync_log_target_date is created in syncJobs.ts, AFTER the
    -- idempotent ALTER TABLE that adds target_date to pre-existing DBs —
    -- creating it here would fail on any DB from before this column existed.

    -- ── Backfill checkpoint (for resuming interrupted backfills) ───
    CREATE TABLE IF NOT EXISTS backfill_checkpoint (
      job_name    TEXT PRIMARY KEY,
      last_symbol TEXT,
      last_date   TEXT,
      updated_at  TEXT NOT NULL
    );

    -- ── Backfill progress (per-symbol coverage tracking) ──────────
    -- Tracks exactly which date ranges have been cached for every
    -- (symbol, resolution) pair as a JSON array of {from,to} objects.
    -- Using an interval list (rather than a single min/max window)
    -- means holes from failed chunks remain detectable after later
    -- chunks succeed.  Updated after every completed chunk so
    -- progress survives process restarts.
    CREATE TABLE IF NOT EXISTS backfill_progress (
      symbol         TEXT NOT NULL,
      resolution     TEXT NOT NULL,
      covered_ranges TEXT NOT NULL DEFAULT '[]',
      updated_at     TEXT NOT NULL,
      PRIMARY KEY (symbol, resolution)
    );

    -- ── Daily broker request budget (persisted so it survives restarts) ───
    -- Replit's free-tier compute cap means the process can sleep/wake many
    -- times within a single calendar day; an in-memory counter would reset
    -- on every restart and could blow past the broker's real rate limit
    -- even though the dashboard shows budget remaining. One row per IST
    -- calendar date — see consumeBudget() in marketDataService.ts.
    CREATE TABLE IF NOT EXISTS request_budget (
      date  TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

    -- One-row-per-day cache of the resolved nearest option expiry for each
    -- underlying. The correct expiry for a given underlying does not change
    -- within a trading day, so initAtmOptionSubscriptions() checks this
    -- before calling getOptionExpiries() again on every restart (Replit
    -- sleep/wake, redeploys, manual testing) — see liveOptionsTracker.ts.
    CREATE TABLE IF NOT EXISTS atm_expiry_cache (
      underlying TEXT NOT NULL,
      date       TEXT NOT NULL,
      expiry     TEXT NOT NULL,
      PRIMARY KEY (underlying, date)
    );
  `);

  // Migrate any older backfill_progress schema that used earliest/latest
  // columns instead of covered_ranges.  Silently ignore if already present.
  try {
    db.exec(`ALTER TABLE backfill_progress ADD COLUMN covered_ranges TEXT NOT NULL DEFAULT '[]'`);
  } catch { /* column already exists */ }

  // Add fyers_symbol column to symbols table (populated by symbol master sync).
  try {
    db.exec(`ALTER TABLE symbols ADD COLUMN fyers_symbol TEXT`);
  } catch { /* column already exists */ }

  // Flag symbols that Fyers permanently rejects for historical data so nightly
  // EOD sync skips them instead of burning request budget on every run.
  // Set via syncJobs when an InvalidSymbolError is returned by the broker.
  try {
    db.exec(
      `ALTER TABLE symbols ADD COLUMN fyers_eod_invalid INTEGER NOT NULL DEFAULT 0`
    );
  } catch { /* column already exists */ }
  try {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_symbols_fyers_eod_invalid
         ON symbols(fyers_eod_invalid) WHERE fyers_eod_invalid = 1`
    );
  } catch { /* index already exists */ }
}
