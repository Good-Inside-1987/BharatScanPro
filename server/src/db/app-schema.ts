import { DatabaseSync } from "node:sqlite";

export function initAppDb(db: DatabaseSync): void {
  db.exec(`
    -- ── Portfolios ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS portfolios (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      notes        TEXT,
      dashboard_id TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- ── Holdings (open positions in a portfolio) ──────────────────────
    CREATE TABLE IF NOT EXISTS holdings (
      id              TEXT PRIMARY KEY,
      portfolio_id    TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      symbol          TEXT NOT NULL,
      qty             REAL NOT NULL,
      buy_price       REAL NOT NULL,
      buy_date        TEXT NOT NULL,
      broker_account  TEXT,
      status          TEXT NOT NULL DEFAULT 'holding',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- ── Booked Trades (closed positions) ─────────────────────────────
    CREATE TABLE IF NOT EXISTS booked_trades (
      id           TEXT PRIMARY KEY,
      portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      holding_id   TEXT,
      symbol       TEXT NOT NULL,
      qty          REAL NOT NULL,
      buy_price    REAL NOT NULL,
      sell_price   REAL NOT NULL,
      buy_date     TEXT NOT NULL,
      sell_date    TEXT NOT NULL,
      realized_pnl REAL NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );

    -- ── Price Alerts ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS alerts (
      id                  TEXT PRIMARY KEY,
      symbol              TEXT NOT NULL,
      condition_type      TEXT NOT NULL,
      target_price        REAL NOT NULL,
      note                TEXT NOT NULL DEFAULT '',
      status              TEXT NOT NULL DEFAULT 'active',
      priority            TEXT NOT NULL DEFAULT 'medium',
      side                TEXT NOT NULL DEFAULT 'buy',
      trigger_count       INTEGER NOT NULL DEFAULT 0,
      last_triggered_at   TEXT,
      last_checked_price  REAL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    -- ── Alert Trigger History ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS alert_triggers (
      id              TEXT PRIMARY KEY,
      alert_id        TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      symbol          TEXT NOT NULL,
      condition_type  TEXT NOT NULL,
      target_price    REAL NOT NULL,
      triggered_price REAL NOT NULL,
      triggered_at    TEXT NOT NULL
    );

    -- ── Saved Scanner Presets ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS saved_scans (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      scan_json   TEXT NOT NULL,
      folder      TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      last_run_at TEXT
    );

    -- ── Paper Trading Accounts ────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS paper_accounts (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      starting_balance REAL NOT NULL,
      cash_balance     REAL NOT NULL,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );

    -- ── Paper Trading Positions ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS paper_positions (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
      instrument_type TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      underlying      TEXT,
      strike          REAL,
      option_type     TEXT,
      expiry          TEXT,
      side            TEXT NOT NULL,
      qty             REAL NOT NULL,
      lot_size        REAL NOT NULL DEFAULT 1,
      entry_price     REAL NOT NULL,
      entry_date      TEXT NOT NULL,
      margin_blocked  REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'open',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    -- ── Paper Trading Trade History ───────────────────────────────────
    CREATE TABLE IF NOT EXISTS paper_trades (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
      position_id     TEXT,
      instrument_type TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      underlying      TEXT,
      strike          REAL,
      option_type     TEXT,
      expiry          TEXT,
      side            TEXT NOT NULL,
      qty             REAL NOT NULL,
      lot_size        REAL NOT NULL DEFAULT 1,
      entry_price     REAL NOT NULL,
      exit_price      REAL NOT NULL,
      entry_date      TEXT NOT NULL,
      exit_date       TEXT NOT NULL,
      realized_pnl    REAL NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL
    );

    -- ── Scanner Dashboards ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS scanner_dashboards (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- ── Scanner Dashboard Scans ───────────────────────────────────────
    CREATE TABLE IF NOT EXISTS scanner_dashboard_scans (
      id           TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES scanner_dashboards(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      filter_json  TEXT NOT NULL DEFAULT '{}',
      series       TEXT NOT NULL DEFAULT 'EQ',
      order_idx    INTEGER NOT NULL DEFAULT 0,
      last_run_at  TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- ── App Settings (key-value store) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── App Metadata (db_version etc.) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS app_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ── Portfolio Dashboards (groups of portfolios) ───────────────────
    CREATE TABLE IF NOT EXISTS portfolio_dashboards (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL DEFAULT '#6366f1',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- ── Universe categories (persisted from "All Watchlist" CSV upload) ──
    -- Full-replace on every upload: upload handler DELETEs all rows then
    -- INSERTs fresh ones in a single transaction, so the set is always
    -- consistent. sort_order preserves the column order from the CSV.
    CREATE TABLE IF NOT EXISTS universe_categories (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      symbols    TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- ── Broker Connections ────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS broker_connections (
      id                 TEXT PRIMARY KEY,
      broker_name        TEXT NOT NULL,
      display_name       TEXT NOT NULL,
      api_key            TEXT NOT NULL,
      client_code        TEXT NOT NULL,
      pin                TEXT NOT NULL,
      access_token       TEXT,
      token_generated_at TEXT,
      status             TEXT NOT NULL DEFAULT 'disconnected',
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_broker_status
      ON broker_connections(broker_name, status);
  `);
}
