const API_BASE = "/api";

export interface ApiScan {
  id: string;
  name: string;
  scan_json: string;
  folder: string | null;
  is_favorite: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
}

export interface ApiSetting {
  key: string;
  value: string;
}

// Lazily import getStoredToken to avoid a circular dep — LoginGate exports it
// from the same bundle entry point. We read localStorage directly here instead.
function getBearerToken(): string | null {
  try { return localStorage.getItem("bs_auth_token"); } catch { return null; }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getBearerToken();
  const authHeader: Record<string, string> = token ? { "Authorization": `Bearer ${token}` } : {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader, ...init?.headers },
  });
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    }
    const body = await res.text().catch(() => "");
    throw new Error(
      `API ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const apiListScans = () => request<ApiScan[]>("/scans");
export const apiGetScan = (id: string) => request<ApiScan>(`/scans/${id}`);
export const apiCreateScan = (body: {
  name: string;
  scan_json: string;
  folder?: string;
}) => request<ApiScan>("/scans", { method: "POST", body: JSON.stringify(body) });
export const apiUpdateScan = (
  id: string,
  body: { name?: string; scan_json?: string; folder?: string }
) =>
  request<ApiScan>(`/scans/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const apiDeleteScan = (id: string) =>
  request<void>(`/scans/${id}`, { method: "DELETE" });
export const apiToggleFavorite = (id: string) =>
  request<ApiScan>(`/scans/${id}/favorite`, {
    method: "PATCH",
    body: "{}",
  });
export const apiDuplicateScan = (id: string) =>
  request<ApiScan>(`/scans/${id}/duplicate`, {
    method: "POST",
    body: "{}",
  });

export const apiGetSettings = () =>
  request<Record<string, string>>("/settings");
export const apiSaveSetting = (key: string, value: string) =>
  request<ApiSetting>("/settings", {
    method: "POST",
    body: JSON.stringify({ key, value }),
  });

export const apiHealth = () =>
  request<{ status: string; db_version: string }>("/health");

// ── Universe categories (persisted from All Watchlist CSV upload) ────────────

export interface ApiUniverseCategory {
  id: string;
  name: string;
  symbols: string[];
}

/** Fetch all persisted universe categories from the server. Returns an empty
 *  array when none have been uploaded yet (rather than throwing). */
export const apiGetUniverseCategories = () =>
  request<{ categories: ApiUniverseCategory[] }>("/universe/categories")
    .then((r) => r.categories)
    .catch((): ApiUniverseCategory[] => []);

/** Full-replace all stored universe categories. Call after every CSV upload. */
export const apiSaveUniverseCategories = (categories: ApiUniverseCategory[]) =>
  request<{ ok: boolean; count: number }>("/universe/categories", {
    method: "PUT",
    body: JSON.stringify({ categories }),
  });

/** Remove all stored universe categories (e.g. "Clear watchlists"). */
export const apiClearUniverseCategories = () =>
  request<{ ok: boolean }>("/universe/categories", { method: "DELETE" });

// ── Market data (broker-backed live/historical feed) ────────────────────────

export interface ApiHistoryBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ApiHistoryResponse {
  symbol: string;
  resolution: string;
  bars: ApiHistoryBar[];
}

export const apiGetMarketHistory = (
  symbol: string,
  resolution: string,
  from: string,
  to: string
) =>
  request<ApiHistoryResponse>(
    `/market-data/history?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&from=${from}&to=${to}`
  );

export interface ApiLiveQuote {
  symbol: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

export const apiGetMarketQuotes = (symbols: string[]) =>
  request<{ quotes: ApiLiveQuote[] }>(
    `/market-data/quotes?symbols=${encodeURIComponent(symbols.join(","))}`
  );

export interface ApiCatchUpStatus {
  active: boolean;
  jobName: string | null;
  currentDate: string | null;
  completedCount: number;
  totalCount: number;
  lastRunAt: string | null;
  lastRunReason: "startup" | "periodic" | null;
}

export interface ApiSchedulerStatus {
  active: boolean;
  runSchedulerInProcess: boolean;
  runsInSeparateProcess: boolean;
  timezone: string;
  // Live feed connect/disconnect is driven by a periodic reconciliation
  // check rather than fixed liveOpen/liveClose cron times — no single
  // "nextRun" timestamp exists anymore, so this reports the live state of
  // that check instead.
  liveFeed: {
    reconcileIntervalMinutes: number;
    marketOpenNow: boolean;
    connected: boolean;
    liveOpenExpression: string;
    liveCloseExpression: string;
  };
  jobs: {
    symbolMaster: { expression: string; nextRun: string | null };
    holidayCalendar: { expression: string; nextRun: string | null };
    eod: { expression: string; nextRun: string | null };
    intraday: { expression: string; nextRun: string | null };
    options: { expression: string; nextRun: string | null };
    foBanList: { expression: string; nextRun: string | null };
    supplementary: { expression: string; nextRun: string | null };
    mfHoldings: { expression: string; nextRun: string | null };
    cleanup: { expression: string; nextRun: string | null };
  };
  catchUp: ApiCatchUpStatus;
}

export const apiGetSchedulerStatus = () =>
  request<ApiSchedulerStatus>("/market-data/scheduler-status");

export interface ApiBackfillSymbolProgress {
  symbol: string;
  resolution: string;
  chunksRemaining: number;
  estimatedDaysToComplete: number;
}

export interface ApiNightlySyncJobStatus {
  jobName: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  symbolsCompleted: number;
  symbolsSkippedBudget: number;
  symbolsFailed: number;
  errorMessage: string | null;
}

export interface ApiMarketStatus {
  environment: string;
  databases: { app_db_mb: number; market_db_mb: number; live_db_mb: number };
  angel_connected: boolean;
  last_sync: string | null;
  backfill: {
    dailyRequestsUsed: number;
    dailyRequestBudget: number;
    remainingBudgetToday: number;
    budgetResetDate: string;
    queueDepth: number;
    workerRunning: boolean;
    adaptersCached: number;
    symbols: ApiBackfillSymbolProgress[];
  };
  historicalBackfill: ApiHistoricalBackfillStatus | null;
  nightlySync: {
    eod: ApiNightlySyncJobStatus;
    intraday: ApiNightlySyncJobStatus;
    options: ApiNightlySyncJobStatus;
    symbolMaster: ApiNightlySyncJobStatus;
  };
}

export interface ApiHistoricalBackfillStatus {
  id: number;
  status: "running" | "paused" | "completed";
  pauseReason: string | null;
  resolution: string;
  fromDate: string;
  toDate: string;
  universe: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  totalSymbols: number;
  completedSymbols: number;
  retryableSymbols: number;
  totalTasks: number;
  completedTasks: number;
  noDataTasks: number;
  invalidTasks: number;
  failedTasks: number;
  pendingTasks: number;
  retryableTasks: number;
  requestsUsed: number;
  requestsRemainingToday: number;
  earliestPersistedDate: string | null;
  latestPersistedDate: string | null;
  workerRunning: boolean;
}

export interface ApiQuoteCacheStats {
  totalRequests: number;
  requestsFullyCached: number;
  requestsWithFallback: number;
  cacheHitSymbols: number;
  restFallbackSymbols: number;
  restCallsMade: number;
  cacheHitRate: number | null;
}

export const apiGetQuoteCacheStats = () =>
  request<ApiQuoteCacheStats>("/market-data/quotes/status");

export const apiResetQuoteCacheStats = () =>
  request<ApiQuoteCacheStats>("/market-data/quotes/status/reset", { method: "POST" });

export const apiGetMarketStatus = () =>
  request<ApiMarketStatus>("/market/status");

export const apiStartHistoricalBackfill = () =>
  request<{ backfill: ApiHistoricalBackfillStatus | null }>("/market-data/backfill/historical/start", {
    method: "POST",
    body: "{}",
  });

export const apiPauseHistoricalBackfill = () =>
  request<{ backfill: ApiHistoricalBackfillStatus | null }>("/market-data/backfill/historical/pause", {
    method: "POST",
    body: "{}",
  });

export const apiResumeHistoricalBackfill = () =>
  request<{ backfill: ApiHistoricalBackfillStatus | null }>("/market-data/backfill/historical/resume", {
    method: "POST",
    body: "{}",
  });

// ── Options data (broker-backed) ──────────────────────────────────────────────

export const apiGetOptionExpiries = (underlying: string) =>
  request<{ underlying: string; expiries: string[] }>(
    `/market-data/options/expiries?underlying=${encodeURIComponent(underlying)}`
  );

export interface OptionsLoadEvent {
  type: "progress" | "done" | "error";
  loaded?: number;
  total?: number;
  current?: string;
  failed?: string[];
  skippedBudget?: number;
  error?: string;
}

/**
 * POST /api/market-data/options/load — starts an SSE stream.
 * Returns an async generator that yields OptionsLoadEvent objects.
 */
export async function* apiLoadOptionsFromBroker(
  underlying: string,
  expiry: string,
  from: string,
  to: string
): AsyncGenerator<OptionsLoadEvent> {
  const res = await fetch("/api/market-data/options/load", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ underlying, expiry, from, to }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API POST /market-data/options/load → ${res.status}: ${body}`);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            yield JSON.parse(line.slice(6)) as OptionsLoadEvent;
          } catch { /* skip malformed */ }
        }
      }
    }
    // Drain the buffer
    if (buf.startsWith("data: ")) {
      try { yield JSON.parse(buf.slice(6)) as OptionsLoadEvent; } catch { /* skip */ }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ── Symbol Master ─────────────────────────────────────────────────────────────

export interface ApiSymbol {
  token: string;
  symbol: string;
  exchange: string;
  isin: string | null;
  name: string | null;
  sector: string | null;
  industry: string | null;
  lot_size: number;
  tick_size: number;
  instrument_type: string | null;
  is_fo_eligible: number;
  index_membership: string | null;
  listing_date: string | null;
  is_delisted: number;
}

export interface ApiSymbolsResponse {
  symbols: ApiSymbol[];
  count: number;
}

export const apiGetSymbols = (params?: { index?: string; fo_only?: boolean; limit?: number }) => {
  const qs = new URLSearchParams();
  if (params?.index)    qs.set("index", params.index);
  if (params?.fo_only)  qs.set("fo_only", "true");
  if (params?.limit)    qs.set("limit", String(params.limit));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  return request<ApiSymbolsResponse>(`/symbols${query}`);
};

export const apiRefreshSymbolMaster = () =>
  request<{ ok: boolean; upserted: number; timestamp: string }>("/symbols/refresh", {
    method: "POST",
  });

export const apiSubscribeMarketSymbols = (symbols: string[]) =>
  request<{ ok: boolean; symbols: string[] }>("/market-data/subscribe", {
    method: "POST",
    body: JSON.stringify({ symbols }),
  });

export const apiUnsubscribeMarketSymbols = (symbols: string[]) =>
  request<{ ok: boolean; symbols: string[] }>("/market-data/unsubscribe", {
    method: "POST",
    body: JSON.stringify({ symbols }),
  });

// ── Dashboard types ────────────────────────────────────────────────────────────

export interface ApiDashboard {
  id: string;
  name: string;
  color: string;
  portfolio_count: number;
  holdings_count: number;
  created_at: string;
  updated_at: string;
}

// ── Dashboard CRUD ─────────────────────────────────────────────────────────────

export const apiListDashboards = () =>
  request<ApiDashboard[]>("/dashboards");

export const apiCreateDashboard = (body: { name: string; color: string }) =>
  request<ApiDashboard>("/dashboards", { method: "POST", body: JSON.stringify(body) });

export const apiUpdateDashboard = (id: string, body: { name?: string; color?: string }) =>
  request<ApiDashboard>(`/dashboards/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const apiDeleteDashboard = (id: string) =>
  request<void>(`/dashboards/${id}`, { method: "DELETE" });

// ── Portfolio types ────────────────────────────────────────────────────────────

export interface ApiPortfolio {
  id: string;
  name: string;
  notes: string | null;
  dashboard_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiHolding {
  id: string;
  portfolio_id: string;
  symbol: string;
  qty: number;
  buy_price: number;
  buy_date: string;
  broker_account: string | null;
  status: "holding" | "partial";
  created_at: string;
  updated_at: string;
}

export interface ApiAllHolding extends ApiHolding {
  portfolio_name: string;
}

export interface ApiBookedTrade {
  id: string;
  portfolio_id: string;
  holding_id: string | null;
  symbol: string;
  qty: number;
  buy_price: number;
  sell_price: number;
  buy_date: string;
  sell_date: string;
  realized_pnl: number;
  created_at: string;
}

// ── Portfolio CRUD ─────────────────────────────────────────────────────────────

export const apiListPortfolios = (dashboardId?: string) =>
  request<ApiPortfolio[]>(dashboardId ? `/portfolio?dashboard_id=${dashboardId}` : "/portfolio");

export const apiCreatePortfolio = (body: { name: string; notes?: string; dashboard_id?: string }) =>
  request<ApiPortfolio>("/portfolio", { method: "POST", body: JSON.stringify(body) });

export const apiUpdatePortfolio = (id: string, body: { name?: string; notes?: string }) =>
  request<ApiPortfolio>(`/portfolio/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const apiDeletePortfolio = (id: string) =>
  request<void>(`/portfolio/${id}`, { method: "DELETE" });

// ── Holdings ───────────────────────────────────────────────────────────────────

export const apiListHoldings = (portfolioId: string) =>
  request<ApiHolding[]>(`/portfolio/${portfolioId}/holdings`);

export const apiAddHolding = (
  portfolioId: string,
  body: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string }
) =>
  request<ApiHolding>(`/portfolio/${portfolioId}/holdings`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const apiUpdateHolding = (
  portfolioId: string,
  holdingId: string,
  body: { symbol?: string; qty?: number; buy_price?: number; buy_date?: string; broker_account?: string }
) =>
  request<ApiHolding>(`/portfolio/${portfolioId}/holdings/${holdingId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const apiDeleteHolding = (portfolioId: string, holdingId: string) =>
  request<void>(`/portfolio/${portfolioId}/holdings/${holdingId}`, {
    method: "DELETE",
  });

export const apiSquareOff = (
  portfolioId: string,
  holdingId: string,
  body: { qty_sold: number; sell_price: number; sell_date: string }
) =>
  request<{ action: string; booked_id: string; remaining_qty?: number }>(
    `/portfolio/${portfolioId}/holdings/${holdingId}/squareoff`,
    { method: "POST", body: JSON.stringify(body) }
  );

// ── Booked trades ──────────────────────────────────────────────────────────────

export const apiListBookedTrades = (portfolioId: string) =>
  request<ApiBookedTrade[]>(`/portfolio/${portfolioId}/booked`);

// ── All holdings / booked across portfolios (optionally scoped to a dashboard) ─

export const apiListAllHoldings = (dashboardId?: string) =>
  request<ApiAllHolding[]>(dashboardId ? `/portfolio/all/holdings?dashboard_id=${dashboardId}` : "/portfolio/all/holdings");

export interface ApiAllBookedTrade extends ApiBookedTrade {
  portfolio_name: string;
}

export const apiListAllBookedTrades = (dashboardId?: string) =>
  request<ApiAllBookedTrade[]>(dashboardId ? `/portfolio/all/booked?dashboard_id=${dashboardId}` : "/portfolio/all/booked");

// ── Import ─────────────────────────────────────────────────────────────────────

export interface ImportPortfolioPayload {
  replace?: boolean;
  dashboard_id?: string;
  portfolios: Array<{
    name: string;
    notes?: string;
    holdings?: Array<{ symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string; status?: string }>;
    booked_trades?: Array<{ symbol: string; qty: number; buy_price: number; sell_price: number; buy_date: string; sell_date: string; realized_pnl: number }>;
  }>;
}

export const apiImportPortfolios = (body: ImportPortfolioPayload) =>
  request<{ imported: number; portfolio_ids: string[] }>("/portfolio/import", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ── Scanner Dashboard types ────────────────────────────────────────────────────

export interface ApiScannerScan {
  id: string;
  dashboard_id: string;
  name: string;
  filter_json: string;
  series: string;
  order_idx: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiScannerDashboard {
  id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
  scans: ApiScannerScan[];
}

// ── Scanner Dashboard CRUD ─────────────────────────────────────────────────────

export const apiListScannerDashboards = () =>
  request<ApiScannerDashboard[]>("/scanner-dashboards");

export const apiCreateScannerDashboard = (body: { name: string; color?: string }) =>
  request<ApiScannerDashboard>("/scanner-dashboards", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const apiUpdateScannerDashboard = (id: string, body: { name?: string; color?: string }) =>
  request<ApiScannerDashboard>(`/scanner-dashboards/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const apiDeleteScannerDashboard = (id: string) =>
  request<void>(`/scanner-dashboards/${id}`, { method: "DELETE" });

export const apiCreateScannerScan = (
  dashboardId: string,
  body: { name: string; filter_json?: string; series?: string; order_idx?: number }
) =>
  request<ApiScannerScan>(`/scanner-dashboards/${dashboardId}/scans`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const apiUpdateScannerScan = (
  dashboardId: string,
  scanId: string,
  body: { name?: string; filter_json?: string; series?: string; order_idx?: number }
) =>
  request<ApiScannerScan>(`/scanner-dashboards/${dashboardId}/scans/${scanId}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });

export const apiDeleteScannerScan = (dashboardId: string, scanId: string) =>
  request<void>(`/scanner-dashboards/${dashboardId}/scans/${scanId}`, {
    method: "DELETE",
  });

export const apiMarkScannerScanRan = (dashboardId: string, scanId: string) =>
  request<ApiScannerScan>(`/scanner-dashboards/${dashboardId}/scans/${scanId}/ran`, {
    method: "PATCH",
    body: "{}",
  });

// ── Alerts ─────────────────────────────────────────────────────────────────────

export type AlertConditionType = "crosses_above" | "crosses_below" | "greater_than" | "less_than";

export interface ApiAlert {
  id: string;
  symbol: string;
  condition_type: AlertConditionType;
  target_price: number;
  note: string;
  status: "active" | "paused";
  priority: "high" | "medium" | "low";
  side: "buy" | "sell";
  trigger_count: number;
  last_checked_price: number | null;
  created_at: string;
  updated_at: string;
  last_triggered_at: string | null;
}

export interface ApiAlertTrigger {
  id: string;
  alert_id: string;
  symbol: string;
  condition_type: AlertConditionType;
  target_price: number;
  triggered_price: number;
  triggered_at: string;
}

export const apiListAlerts = () => request<ApiAlert[]>("/alerts");

export const apiCreateAlert = (body: {
  symbol: string;
  condition_type: AlertConditionType;
  target_price: number;
  note?: string;
  priority?: string;
  side?: string;
}) => request<ApiAlert>("/alerts", { method: "POST", body: JSON.stringify(body) });

export const apiUpdateAlert = (
  id: string,
  body: { symbol?: string; condition_type?: AlertConditionType; target_price?: number; note?: string; priority?: string; side?: string }
) => request<ApiAlert>(`/alerts/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const apiDeleteAlert = (id: string) =>
  request<void>(`/alerts/${id}`, { method: "DELETE" });

export const apiToggleAlert = (id: string) =>
  request<ApiAlert>(`/alerts/${id}/toggle`, { method: "PATCH", body: "{}" });

export const apiListAlertHistory = () =>
  request<ApiAlertTrigger[]>("/alerts/history/all");

export const apiRecordAlertTrigger = (id: string, triggered_price: number) =>
  request<ApiAlertTrigger>(`/alerts/${id}/trigger`, {
    method: "POST",
    body: JSON.stringify({ triggered_price }),
  });

export const apiMarkAlertChecked = (id: string, price: number) =>
  request<ApiAlert>(`/alerts/${id}/checked`, {
    method: "PATCH",
    body: JSON.stringify({ price }),
  });

// ── Paper Trading ────────────────────────────────────────────────────────────

export interface ApiPaperAccount {
  id: string;
  name: string;
  starting_balance: number;
  cash_balance: number;
  invested: number;
  realizedPnl: number;
  openPositions: number;
  created_at: string;
  updated_at: string;
}

export type InstrumentType = "stock" | "option" | "future";
export type PositionSide = "long" | "short";
export type OptionType = "CE" | "PE";

export interface ApiPaperPosition {
  id: string;
  account_id: string;
  instrument_type: InstrumentType;
  symbol: string;
  underlying: string | null;
  strike: number | null;
  option_type: OptionType | null;
  expiry: string | null;
  side: PositionSide;
  qty: number;
  lot_size: number;
  entry_price: number;
  entry_date: string;
  margin_blocked: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ApiPaperTrade {
  id: string;
  account_id: string;
  position_id: string | null;
  instrument_type: InstrumentType;
  symbol: string;
  underlying: string | null;
  strike: number | null;
  option_type: OptionType | null;
  expiry: string | null;
  side: PositionSide;
  qty: number;
  lot_size: number;
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  created_at: string;
}

export const apiListPaperAccounts = () =>
  request<ApiPaperAccount[]>("/paper-trading/accounts");

export const apiCreatePaperAccount = (body: { name: string; starting_balance: number }) =>
  request<ApiPaperAccount>("/paper-trading/accounts", { method: "POST", body: JSON.stringify(body) });

export const apiUpdatePaperAccount = (id: string, body: { name?: string; add_funds?: number }) =>
  request<ApiPaperAccount>(`/paper-trading/accounts/${id}`, { method: "PUT", body: JSON.stringify(body) });

export const apiDeletePaperAccount = (id: string) =>
  request<void>(`/paper-trading/accounts/${id}`, { method: "DELETE" });

export const apiResetPaperAccount = (id: string) =>
  request<ApiPaperAccount>(`/paper-trading/accounts/${id}/reset`, { method: "POST", body: "{}" });

export const apiListPaperPositions = (accountId: string) =>
  request<ApiPaperPosition[]>(`/paper-trading/accounts/${accountId}/positions`);

export const apiOpenPaperPosition = (
  accountId: string,
  body: {
    instrument_type: InstrumentType;
    symbol: string;
    underlying?: string;
    strike?: number;
    option_type?: OptionType;
    expiry?: string;
    side: PositionSide;
    qty: number;
    lot_size?: number;
    entry_price: number;
    entry_date: string;
  }
) =>
  request<ApiPaperPosition>(`/paper-trading/accounts/${accountId}/positions`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const apiClosePaperPosition = (
  accountId: string,
  positionId: string,
  body: { qty_closed: number; exit_price: number; exit_date: string }
) =>
  request<{ action: string; trade_id: string; realized_pnl: number; remaining_qty?: number; position?: ApiPaperPosition }>(
    `/paper-trading/accounts/${accountId}/positions/${positionId}/close`,
    { method: "POST", body: JSON.stringify(body) }
  );

export const apiListPaperTrades = (accountId: string) =>
  request<ApiPaperTrade[]>(`/paper-trading/accounts/${accountId}/trades`);

// ── Paper Trading: bulk export / import (used by app-wide backup/restore) ─────

export interface ApiPaperAccountExport extends ApiPaperAccount {
  positions: ApiPaperPosition[];
  trades: ApiPaperTrade[];
}

export const apiExportPaperAccounts = () =>
  request<ApiPaperAccountExport[]>("/paper-trading/export");

export interface ImportPaperAccountsPayload {
  accounts: Array<{
    name: string;
    starting_balance: number;
    cash_balance: number;
    positions?: Array<Omit<ApiPaperPosition, "id" | "account_id">>;
    trades?: Array<Omit<ApiPaperTrade, "id" | "account_id" | "position_id">>;
  }>;
}

export const apiImportPaperAccounts = (body: ImportPaperAccountsPayload) =>
  request<{ imported: number; account_ids: string[] }>("/paper-trading/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
