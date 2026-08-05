// Symbol Master sync service.
// Downloads NSE Capital Market symbols from Fyers' public CSV (no auth required),
// builds F&O eligibility from the Fyers NSE_FO CSV, tags index membership from
// NSE's official index constituent lists, then upserts into the symbols table.
//
// SAFE: only ever INSERTs or UPDATEs symbols — never drops or truncates the table.

import { DatabaseSync } from "node:sqlite";
import { startSyncLog, finishSyncLog } from "./syncJobs.js";

// ── Source URLs ──────────────────────────────────────────────────────────────
const FYERS_CM_URL = "https://public.fyers.in/sym_details/NSE_CM.csv";
const FYERS_FO_URL = "https://public.fyers.in/sym_details/NSE_FO.csv";

// NSE archives and Fyers' public static-file host both enforce bot
// protection (403/503) against bare/non-browser requests — likely blocking
// cloud/datacenter IPs. A browser-like User-Agent + Referer avoids that. No
// longer NSE-specific, so used for both the NSE index fetches and the Fyers
// CM/FO CSV fetches below.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Referer: "https://www.nseindia.com",
};

interface NseIndexCfg {
  name: string;
  url: string;
}

// All major NSE index constituents.  New indices can be added here; a failed
// fetch for any one entry is logged as a warning and skipped — it will not
// abort the overall sync.  Names here become the token stored in the
// index_membership column (e.g. "NIFTY50,NIFTY100") and MUST match the
// DISPLAY_NAME keys in server/src/routes/universe.ts.
const NSE_INDICES: NseIndexCfg[] = [
  // ── Broad market ───────────────────────────────────────────────────────
  { name: "NIFTY50",       url: "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv" },
  { name: "NIFTYNEXT50",   url: "https://nsearchives.nseindia.com/content/indices/ind_niftynext50list.csv" },
  { name: "NIFTY100",      url: "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv" },
  { name: "NIFTY200",      url: "https://nsearchives.nseindia.com/content/indices/ind_nifty200list.csv" },
  { name: "NIFTY500",      url: "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv" },
  // ── Midcap ─────────────────────────────────────────────────────────────
  { name: "NIFTYMIDCAP50",  url: "https://nsearchives.nseindia.com/content/indices/ind_niftymidcap50list.csv" },
  { name: "NIFTYMIDCAP100", url: "https://nsearchives.nseindia.com/content/indices/ind_niftymidcap100list.csv" },
  { name: "NIFTYMIDCAP150", url: "https://nsearchives.nseindia.com/content/indices/ind_niftymidcap150list.csv" },
  // ── Smallcap ───────────────────────────────────────────────────────────
  { name: "NIFTYSMALLCAP50",  url: "https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap50list.csv" },
  { name: "NIFTYSMALLCAP100", url: "https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap100list.csv" },
  { name: "NIFTYSMALLCAP250", url: "https://nsearchives.nseindia.com/content/indices/ind_niftysmallcap250list.csv" },
  // ── Microcap ───────────────────────────────────────────────────────────
  { name: "NIFTYMICROCAP250", url: "https://nsearchives.nseindia.com/content/indices/ind_niftymicrocap250_list.csv" },
  // ── Sectoral / thematic ────────────────────────────────────────────────
  { name: "NIFTYBANK",       url: "https://nsearchives.nseindia.com/content/indices/ind_niftybanklist.csv" },
  { name: "NIFTYIT",         url: "https://nsearchives.nseindia.com/content/indices/ind_niftyitlist.csv" },
  { name: "NIFTYPHARMA",     url: "https://nsearchives.nseindia.com/content/indices/ind_niftypharmalist.csv" },
  { name: "NIFTYAUTO",       url: "https://nsearchives.nseindia.com/content/indices/ind_niftyautolist.csv" },
  { name: "NIFTYFMCG",       url: "https://nsearchives.nseindia.com/content/indices/ind_niftyfmcglist.csv" },
  { name: "NIFTYFINSERVICE",  url: "https://nsearchives.nseindia.com/content/indices/ind_niftyfinancelist.csv" },
  { name: "NIFTYMETAL",      url: "https://nsearchives.nseindia.com/content/indices/ind_niftymetallist.csv" },
  { name: "NIFTYREALTY",     url: "https://nsearchives.nseindia.com/content/indices/ind_niftyrealtylist.csv" },
  { name: "NIFTYOILGAS",     url: "https://nsearchives.nseindia.com/content/indices/ind_niftyoilgaslist.csv" },
  { name: "NIFTYMEDIA",      url: "https://nsearchives.nseindia.com/content/indices/ind_niftymedialist.csv" },
];

// ── Fyers CM CSV column indices (no header row) ───────────────────────────
// 0: full_token   1: company_name  2: instr_type_code  3: lot_size
// 4: tick_size    5: isin          6: trading_hours     7: last_updated
// 8: expiry       9: fyers_ticker  10: ?  11: segment_code  12: short_token
// 13: symbol      14...: other fields
const CM_COL_TOKEN        = 0;
const CM_COL_NAME         = 1;
const CM_COL_INSTR_TYPE   = 2;
const CM_COL_LOT_SIZE     = 3;
const CM_COL_TICK_SIZE    = 4;
const CM_COL_ISIN         = 5;
const CM_COL_FYERS_TICKER = 9;
const CM_COL_SYMBOL       = 13;

// Fyers instrument type code 0 = EQ (equity). Skip everything else from CM file.
const EQ_INSTR_TYPE = "0";

const INSTR_TYPE_LABEL: Record<string, string> = {
  "0": "EQ", "1": "PREFSHARES", "2": "DEBENTURES", "3": "WARRANTS", "4": "MISC",
  "10": "INDEX", "11": "FUTIDX", "12": "OPTIDX", "13": "FUTSTK", "14": "OPTSTK",
  "15": "FUTCUR", "16": "OPTCUR",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  // Fail fast on a hanging connection instead of blocking server startup
  // indefinitely inside bootstrapSymbolMasterIfEmpty().
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ── NSE index constituent fetcher ────────────────────────────────────────────
// Returns:
//   indexMap  — symbol → ["NIFTY50", "NIFTY100", ...]
//   sectorMap — symbol → sector string (from the "Industry" column in NSE CSVs)
async function fetchNseIndexData(): Promise<{
  indexMap: Map<string, string[]>;
  sectorMap: Map<string, string>;
}> {
  const indexMap  = new Map<string, string[]>();
  const sectorMap = new Map<string, string>();

  for (const idx of NSE_INDICES) {
    try {
      const text  = await fetchText(idx.url, BROWSER_HEADERS);
      const lines = text.trim().split("\n");
      // Header: Company Name,Industry,Symbol,Series,ISIN Code
      for (let i = 1; i < lines.length; i++) {
        const cols   = lines[i].split(",");
        const sector = cols[1]?.trim();
        const symbol = cols[2]?.trim();
        if (!symbol) continue;

        if (!indexMap.has(symbol)) indexMap.set(symbol, []);
        indexMap.get(symbol)!.push(idx.name);

        if (sector && !sectorMap.has(symbol)) {
          sectorMap.set(symbol, sector);
        }
      }
      console.log(`[symbol-master] ${idx.name}: ${indexMap.size} symbols so far`);
    } catch (err) {
      console.warn(
        `[symbol-master] Could not fetch ${idx.name} index: ` +
        `${err instanceof Error ? err.message : String(err)} — index_membership may be incomplete`,
      );
    }
  }

  return { indexMap, sectorMap };
}

// ── Main export ───────────────────────────────────────────────────────────────
export interface SymbolMasterResult {
  upserted: number;
  timestamp: string;
}

export async function syncSymbolMaster(
  marketDb: DatabaseSync,
): Promise<SymbolMasterResult> {
  console.log("[symbol-master] Starting sync …");

  // Record this run in sync_log so a failure (e.g. Fyers/NSE returning 403)
  // is visible in the Settings → Symbol Master card instead of only in
  // server logs — same "last run status" pattern the nightly sync jobs use.
  const logId = startSyncLog("symbol_master");

  try {
    const result = await runSync(marketDb);
    finishSyncLog(logId, "completed", { completed: result.upserted, skippedBudget: 0, failed: 0 });
    return result;
  } catch (err) {
    finishSyncLog(
      logId,
      "failed",
      { completed: 0, skippedBudget: 0, failed: 0 },
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

async function runSync(marketDb: DatabaseSync): Promise<SymbolMasterResult> {
  // 1. NSE index data (best-effort — won't abort if NSE is unreachable)
  const { indexMap, sectorMap } = await fetchNseIndexData();

  // 2. F&O underlyings — build a set of symbol names that have F&O contracts,
  //    and collect futures contract rows for upsert into futures_symbols.
  interface FuturesContractRow {
    underlying: string;
    expiry: string;       // YYYY-MM-DD, converted from the unix timestamp
    fyersSymbol: string;
    lotSize: number;
    tickSize: number;
  }
  const futuresContracts: FuturesContractRow[] = [];
  const foUnderlyings = new Set<string>();
  {
    const foText  = await fetchText(FYERS_FO_URL, BROWSER_HEADERS);
    const foLines = foText.trim().split("\n");
    for (const line of foLines) {
      const cols   = line.split(",");
      const symbol = cols[CM_COL_SYMBOL]?.trim();
      if (symbol) foUnderlyings.add(symbol);

      // Collect futures contracts (FUTIDX=11, FUTSTK=13) for futures_symbols.
      // Instrument type is at col 2 (same layout as CM file). Col 11 is the
      // NSE F&O segment code and is "11" for ALL F&O rows — using it would
      // incorrectly include options rows.
      const instrType = cols[2]?.trim();
      if (instrType === "11" || instrType === "13") {
        const expiryUnix  = Number(cols[8]);
        const fyersSymbol = cols[9]?.trim();
        const lotSize     = Number(cols[3]);
        const tickSize    = Number(cols[4]);
        if (symbol && fyersSymbol && Number.isFinite(expiryUnix) && expiryUnix > 0) {
          futuresContracts.push({
            underlying: symbol,
            expiry: new Date(expiryUnix * 1000).toISOString().slice(0, 10),
            fyersSymbol,
            lotSize: Number.isFinite(lotSize) ? lotSize : 0,
            tickSize: Number.isFinite(tickSize) ? tickSize : 0,
          });
        }
      }
    }
    console.log(`[symbol-master] F&O underlyings: ${foUnderlyings.size}`);
    console.log(`[symbol-master] Futures contracts found: ${futuresContracts.length}`);

    const futStmt = marketDb.prepare(`
      INSERT INTO futures_symbols (underlying, expiry, fyers_symbol, lot_size, tick_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(underlying, expiry) DO UPDATE SET
        fyers_symbol = excluded.fyers_symbol,
        lot_size     = excluded.lot_size,
        tick_size    = excluded.tick_size,
        updated_at   = excluded.updated_at
    `);
    const nowIso = new Date().toISOString();
    for (const fc of futuresContracts) {
      futStmt.run(fc.underlying, fc.expiry, fc.fyersSymbol, fc.lotSize, fc.tickSize, nowIso);
    }
  }

  // 3. CM symbol master — parse EQ instruments only
  const cmText  = await fetchText(FYERS_CM_URL, BROWSER_HEADERS);
  const cmLines = cmText.trim().split("\n");

  // Snapshot every currently-listed symbol before we touch anything.
  // After the upsert loop, whatever remains in this set was not present in
  // Fyers' current file — meaning Fyers considers it delisted/removed.
  const existingSymbols = new Set<string>(
    (marketDb.prepare(`SELECT symbol FROM symbols WHERE is_delisted = 0`)
      .all() as unknown as Array<{ symbol: string }>)
      .map((r) => r.symbol)
  );

  const now = new Date().toISOString();
  let upserted = 0;

  const stmt = marketDb.prepare(`
    INSERT INTO symbols (
      token, symbol, exchange, isin, name, sector, industry,
      lot_size, tick_size, instrument_type, is_fo_eligible,
      index_membership, listing_date, is_delisted, fyers_symbol, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(token) DO UPDATE SET
      symbol           = excluded.symbol,
      exchange         = excluded.exchange,
      isin             = excluded.isin,
      name             = excluded.name,
      sector           = excluded.sector,
      industry         = excluded.industry,
      lot_size         = excluded.lot_size,
      tick_size        = excluded.tick_size,
      instrument_type  = excluded.instrument_type,
      is_fo_eligible   = excluded.is_fo_eligible,
      index_membership = excluded.index_membership,
      fyers_symbol     = excluded.fyers_symbol,
      is_delisted      = 0,
      updated_at       = excluded.updated_at
  `);

  const markDelisted = marketDb.prepare(
    `UPDATE symbols SET is_delisted = 1, updated_at = ? WHERE symbol = ?`
  );

  marketDb.exec("BEGIN");
  try {
    for (const line of cmLines) {
      const cols = line.split(",");
      if (cols.length < CM_COL_SYMBOL + 1) continue;

      // Skip anything that isn't a plain equity
      if (cols[CM_COL_INSTR_TYPE]?.trim() !== EQ_INSTR_TYPE) continue;

      const token  = cols[CM_COL_TOKEN]?.trim();
      const symbol = cols[CM_COL_SYMBOL]?.trim();
      if (!token || !symbol) continue;

      const name      = cols[CM_COL_NAME]?.trim() ?? null;
      const isin      = cols[CM_COL_ISIN]?.trim() || null;
      const lotSize   = parseInt(cols[CM_COL_LOT_SIZE] ?? "1",  10) || 1;
      const tickSize  = parseFloat(cols[CM_COL_TICK_SIZE] ?? "0.05") || 0.05;

      // Column 9 holds Fyers' own ticker string (e.g. "NSE:RELIANCE-EQ").
      // Fall back to the conventional construction if the CSV omits it.
      const csvFyers    = cols[CM_COL_FYERS_TICKER]?.trim() || null;
      const fyersSymbol = csvFyers ?? `NSE:${symbol}-EQ`;

      const sector          = sectorMap.get(symbol) ?? null;
      const isFoEligible    = foUnderlyings.has(symbol) ? 1 : 0;
      const indexMembership = indexMap.get(symbol)?.join(",") ?? null;
      const instrLabel      = INSTR_TYPE_LABEL[EQ_INSTR_TYPE];

      stmt.run(
        token, symbol, "NSE", isin, name, sector, null,
        lotSize, tickSize, instrLabel, isFoEligible,
        indexMembership, null, fyersSymbol, now,
      );
      upserted++;

      // This symbol is confirmed present in Fyers' current file — remove it
      // from the snapshot so it won't be marked delisted below.
      existingSymbols.delete(symbol);
    }

    // Symbols still in existingSymbols were not in the current Fyers CSV —
    // Fyers has removed them, so we mark them delisted. A symbol that later
    // reappears in the file will have is_delisted reset to 0 by the upsert
    // above (ON CONFLICT sets is_delisted = 0 explicitly).
    for (const symbol of existingSymbols) {
      markDelisted.run(now, symbol);
    }
    if (existingSymbols.size > 0) {
      console.log(`[symbol-master] Marked ${existingSymbols.size} symbol(s) delisted (absent from Fyers' current file)`);
    }

    marketDb.exec("COMMIT");
  } catch (err) {
    marketDb.exec("ROLLBACK");
    throw err;
  }

  console.log(`[symbol-master] Done — ${upserted} rows upserted`);
  return { upserted, timestamp: now };
}
