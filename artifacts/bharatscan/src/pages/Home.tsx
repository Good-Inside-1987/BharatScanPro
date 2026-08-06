import { useMemo, useState, useEffect, useSyncExternalStore, useCallback } from "react";
import { TrendingUp, TrendingDown, Activity, BarChart2, Clock, Upload, Database, Copy, ChevronDown, Check } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useData } from "@/context/DataContext";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { SymbolHistory } from "@/lib/csv";
import type { OptionsDataset } from "@/lib/options";
import { resampleBars, type Timeframe } from "@/lib/timeframe";
import { apiGetMarketQuotes, apiGetMarketHistory, apiGetSchedulerStatus, type ApiLiveQuote } from "@/lib/api";

// ---- master index definitions (all 7 available options) ---------------------

interface IndexCardDef {
  key: string;
  label: string;
  aliases: string[];
  futuresSymbol?: string;
  fyersIndexSymbol?: string;
}

const ALL_INDEX_DEFS: IndexCardDef[] = [
  {
    key: "NIFTY",
    label: "Nifty 50",
    aliases: ["NIFTY", "NIFTY50", "NIFTY 50", "NIFTY-50"],
    futuresSymbol: "NIFTY",
    fyersIndexSymbol: "NSE:NIFTY50-INDEX",
  },
  {
    key: "BANKNIFTY",
    label: "Bank Nifty",
    aliases: ["BANKNIFTY", "NIFTYBANK", "NIFTY BANK", "NIFTY-BANK"],
    futuresSymbol: "BANKNIFTY",
    fyersIndexSymbol: "NSE:NIFTYBANK-INDEX",
  },
  {
    key: "FINNIFTY",
    label: "Fin Nifty",
    aliases: ["FINNIFTY", "NIFTYFIN", "NIFTY FIN", "FINNIFTY50"],
    futuresSymbol: "FINNIFTY",
    fyersIndexSymbol: "NSE:FINNIFTY-INDEX",
  },
  {
    key: "NIFTYNXT50",
    label: "Nifty Next 50",
    aliases: ["NIFTYNXT50", "NIFTY NEXT 50", "NIFTYNEXT50", "NIFTYJR"],
    futuresSymbol: "NIFTYNXT50",
  },
  {
    key: "MIDCPNIFTY",
    label: "Midcap Nifty",
    aliases: ["MIDCPNIFTY", "NIFTYMIDCAP", "MIDCAP NIFTY", "NIFTY MIDCAP"],
    futuresSymbol: "MIDCPNIFTY",
    fyersIndexSymbol: "NSE:MIDCPNIFTY-INDEX",
  },
  {
    key: "SENSEX",
    label: "Sensex",
    aliases: ["SENSEX", "BSE SENSEX", "BSESENSEX", "S&P BSE SENSEX"],
    fyersIndexSymbol: "BSE:SENSEX-INDEX",
  },
  {
    key: "INDIAVIX",
    label: "India VIX",
    aliases: ["INDIAVIX", "INDIA VIX", "INDIA-VIX", "VIX"],
  },
];

const ALL_INDEX_BY_KEY = new Map(ALL_INDEX_DEFS.map((d) => [d.key, d]));

// ---- default 4 slots --------------------------------------------------------

const DEFAULT_SLOTS = ["NIFTY", "SENSEX", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "INDIAVIX"];
const LS_SLOTS_KEY = "bharatscan:home-index-slots";
const LS_HOME_INDEX_KEY = "bharatscan:home-index-source";

function readSlots(): string[] {
  try {
    const raw = localStorage.getItem(LS_SLOTS_KEY);
    if (!raw) return DEFAULT_SLOTS;
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 6 &&
      parsed.every((k) => ALL_INDEX_BY_KEY.has(k))
    ) {
      return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_SLOTS;
}

function useIndexSlots(): [string[], (slotIdx: number, key: string) => void] {
  const [slots, setSlots] = useState<string[]>(readSlots);

  const setSlot = useCallback((slotIdx: number, key: string) => {
    setSlots((prev) => {
      const next = [...prev];
      next[slotIdx] = key;
      localStorage.setItem(LS_SLOTS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return [slots, setSlot];
}

function useHomeIndexSource(): "futures" | "spot" {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("storage", cb);
      return () => window.removeEventListener("storage", cb);
    },
    () => (localStorage.getItem(LS_HOME_INDEX_KEY) ?? "futures") as "futures" | "spot",
  );
}

// ---- helpers ----------------------------------------------------------------

function findLatestDate(histories: SymbolHistory[]): string {
  let d = "";
  for (const h of histories) {
    if (h.bars.length) {
      const last = h.bars[h.bars.length - 1].date;
      if (last > d) d = last;
    }
  }
  return d;
}

function getFuturesDates(optionsData: OptionsDataset, symbol: string, cap: string | null): [string, string] {
  const prefix = `${symbol}|`;
  const dates: string[] = [];
  for (const key of optionsData.futuresCloseByKey.keys()) {
    if (key.startsWith(prefix)) {
      const d = key.slice(prefix.length);
      if (!cap || d <= cap) dates.push(d);
    }
  }
  dates.sort();
  return [dates[dates.length - 1] ?? "", dates[dates.length - 2] ?? ""];
}

function lookupFuturesIndex(
  optionsData: OptionsDataset | null,
  symbol: string,
  cap: string | null,
): { value: number; pct: number; pts: number; found: boolean } {
  if (!optionsData) return { value: 0, pct: 0, pts: 0, found: false };
  const [latestDate, prevDate] = getFuturesDates(optionsData, symbol, cap);
  if (!latestDate) return { value: 0, pct: 0, pts: 0, found: false };
  const close = optionsData.futuresCloseByKey.get(`${symbol}|${latestDate}`);
  if (!close || !isFinite(close) || close <= 0) return { value: 0, pct: 0, pts: 0, found: false };
  const prev = prevDate ? (optionsData.futuresCloseByKey.get(`${symbol}|${prevDate}`) ?? 0) : 0;
  const pct = prev > 0 ? ((close - prev) / prev) * 100 : 0;
  const pts = prev > 0 ? close - prev : 0;
  return { value: close, pct, pts, found: true };
}

const SERIES_PRIORITY: Record<string, number> = { EQ: 0, BE: 1, BZ: 2, SM: 3, MT: 4 };

function lookupIndex(histories: SymbolHistory[], aliases: string[], latestDate: string) {
  const aliasSet = new Set(aliases.map((a) => a.toUpperCase().replace(/\s+/g, "")));
  let bestH: SymbolHistory | null = null;
  let bestBarIdx = -1;
  for (const h of histories) {
    const key = h.symbol.toUpperCase().replace(/\s+/g, "");
    if (!aliasSet.has(key)) continue;
    for (let i = h.bars.length - 1; i >= 0; i--) {
      if (h.bars[i].date === latestDate) {
        if (!bestH) {
          bestH = h; bestBarIdx = i;
        } else {
          const newPri = SERIES_PRIORITY[h.series] ?? 99;
          const exPri  = SERIES_PRIORITY[bestH.series] ?? 99;
          if (newPri < exPri) { bestH = h; bestBarIdx = i; }
        }
        break;
      }
      if (h.bars[i].date < latestDate) break;
    }
  }
  if (!bestH || bestBarIdx < 0) return { value: 0, pct: 0, pts: 0, found: false };
  const bar = bestH.bars[bestBarIdx];
  const prevBarClose = bestBarIdx > 0 ? bestH.bars[bestBarIdx - 1].close : NaN;
  const prevClose = isFinite(prevBarClose) ? prevBarClose : bar.prevClose;
  const pct = prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0;
  const pts = prevClose > 0 ? bar.close - prevClose : 0;
  return { value: bar.close, pct, pts, found: true };
}

function fmtVolumeCr(value: number): string {
  if (!isFinite(value) || value <= 0) return "—";
  const cr = value / 1e7;
  if (cr >= 1000) return (cr / 1000).toFixed(1) + "kCr";
  if (cr >= 1) return cr.toFixed(1) + "Cr";
  return (value / 1e5).toFixed(1) + "L";
}

function fmtVolume(vol: number): string {
  if (!isFinite(vol) || vol <= 0) return "—";
  if (vol >= 1_00_00_000) return (vol / 1_00_00_000).toFixed(1) + "Cr";
  if (vol >= 1_00_000)    return (vol / 1_00_000).toFixed(1) + "L";
  if (vol >= 1_000)       return (vol / 1_000).toFixed(1) + "K";
  return String(vol);
}

function fmtNumber(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface StockRow {
  symbol: string;
  ltp: number;
  change: number;
  volume: string;
  turnover: string;
}

function computeRows(histories: SymbolHistory[], latestDate: string, symbolSet?: Set<string>): StockRow[] {
  if (!histories.length || !latestDate) return [];
  const best = new Map<string, { h: SymbolHistory; barIdx: number }>();
  for (const h of histories) {
    if (symbolSet && !symbolSet.has(h.symbol)) continue;
    let barIdx = -1;
    for (let i = h.bars.length - 1; i >= 0; i--) {
      if (h.bars[i].date === latestDate) { barIdx = i; break; }
      if (h.bars[i].date < latestDate) break;
    }
    if (barIdx < 0) continue;
    const existing = best.get(h.symbol);
    if (!existing) {
      best.set(h.symbol, { h, barIdx });
    } else {
      const newPri = SERIES_PRIORITY[h.series] ?? 99;
      const exPri  = SERIES_PRIORITY[existing.h.series] ?? 99;
      if (newPri < exPri) best.set(h.symbol, { h, barIdx });
    }
  }
  const rows: StockRow[] = [];
  for (const { h, barIdx } of best.values()) {
    const bar = h.bars[barIdx];
    const prevBarClose = barIdx > 0 ? h.bars[barIdx - 1].close : NaN;
    const prevClose = isFinite(prevBarClose) ? prevBarClose : bar.prevClose;
    const pct = prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0;
    rows.push({
      symbol: h.symbol,
      ltp: bar.close,
      change: pct,
      volume: fmtVolume(bar.volume ?? 0),
      turnover: fmtVolumeCr(bar.value ?? 0),
    });
  }
  return rows;
}

// ---- timeframe-aware row computation ----------------------------------------

const TF_LABELS: Record<string, string> = {
  daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly",
};
const TF_OPTIONS: Timeframe[] = ["daily", "weekly", "monthly", "quarterly"];

function computeRowsForTf(
  histories: SymbolHistory[],
  latestDate: string,
  tf: Timeframe,
  symbolSet?: Set<string>,
): StockRow[] {
  if (!histories.length || !latestDate) return [];
  if (tf === "daily") return computeRows(histories, latestDate, symbolSet);

  const best = new Map<string, { symbol: string; bar: { close: number; volume: number; value: number }; prevClose: number; series: string }>();
  for (const h of histories) {
    if (symbolSet && !symbolSet.has(h.symbol)) continue;

    // Only include stocks that actually traded on latestDate (same gate as daily)
    let endIdx = -1;
    for (let i = h.bars.length - 1; i >= 0; i--) {
      if (h.bars[i].date === latestDate) { endIdx = i; break; }
      if (h.bars[i].date < latestDate) break;
    }
    if (endIdx < 0) continue;

    // Resample all bars up to and including latestDate
    const { bars: resampled } = resampleBars(h.bars.slice(0, endIdx + 1), tf);
    if (!resampled.length) continue;

    const last = resampled[resampled.length - 1];
    const prev = resampled.length > 1 ? resampled[resampled.length - 2] : null;
    // prevClose: previous full period's close, falling back to the daily prevClose
    // from the first bar of the current period (which NSE bhavcopy carries)
    let prevClose = prev ? prev.close : last.prevClose;
    // Corporate-action guard: if the period's open diverges >30% from prevClose,
    // a bonus/split happened at the period boundary. Switch to the period's own
    // open as base so we show intra-period return, not the ex-date distortion.
    if (prevClose > 0 && Math.abs((last.open - prevClose) / prevClose) > 0.30) {
      prevClose = last.open;
    }

    const existing = best.get(h.symbol);
    if (!existing || (SERIES_PRIORITY[h.series] ?? 99) < (SERIES_PRIORITY[existing.series] ?? 99)) {
      best.set(h.symbol, { symbol: h.symbol, bar: last, prevClose, series: h.series });
    }
  }
  const rows: StockRow[] = [];
  for (const { symbol, bar, prevClose } of best.values()) {
    const pct = prevClose > 0 ? ((bar.close - prevClose) / prevClose) * 100 : 0;
    rows.push({
      symbol,
      ltp: bar.close,
      change: pct,
      volume: fmtVolume(bar.volume ?? 0),
      turnover: fmtVolumeCr(bar.value ?? 0),
    });
  }
  return rows;
}

// ---- PCR helper -------------------------------------------------------------

/**
 * Compute Put-Call Ratio for a given underlying symbol from the options CSV.
 * Uses front expiry on the effective date (respects Live/Past mode via asOfDate).
 *
 * PCR > 1.2 → Bullish (excess put buying = contrarian long signal)
 * PCR < 0.7 → Bearish (excess call buying = contrarian short signal)
 * 0.7–1.2  → Neutral
 */
function computePCR(
  optionsData: OptionsDataset | null,
  symbol: string,
  asOfDate: string | null,
): { pcr: number; sentiment: "bullish" | "bearish" | "neutral"; found: boolean } {
  if (!optionsData || !optionsData.bars.length)
    return { pcr: 0, sentiment: "neutral", found: false };

  // Find the latest trading date that has OPTIDX bars for this symbol,
  // capped at asOfDate when in historical mode.
  let latestDate = "";
  for (const b of optionsData.bars) {
    if (b.symbol === symbol && (!asOfDate || b.date <= asOfDate) && b.date > latestDate) latestDate = b.date;
  }
  if (!latestDate) return { pcr: 0, sentiment: "neutral", found: false };

  // Find the front (nearest) expiry >= latestDate — matches NSE option chain default
  // and all major platforms that show "current expiry" PCR.
  let frontExpiry = "";
  for (const b of optionsData.bars) {
    if (b.symbol !== symbol || b.date !== latestDate) continue;
    if (!frontExpiry || b.expiry < frontExpiry) {
      if (b.expiry >= latestDate) frontExpiry = b.expiry;
    }
  }
  // Fallback: if no expiry found >= date (shouldn't happen), use nearest overall
  if (!frontExpiry) {
    for (const b of optionsData.bars) {
      if (b.symbol !== symbol || b.date !== latestDate) continue;
      if (!frontExpiry || b.expiry < frontExpiry) frontExpiry = b.expiry;
    }
  }
  if (!frontExpiry) return { pcr: 0, sentiment: "neutral", found: false };

  // Sum CE and PE OI for the front expiry only — this matches NSE option chain PCR
  let callOI = 0;
  let putOI  = 0;
  for (const b of optionsData.bars) {
    if (b.symbol !== symbol || b.date !== latestDate || b.expiry !== frontExpiry) continue;
    if (b.type === "CE") callOI += b.oi;
    else if (b.type === "PE") putOI += b.oi;
  }
  if (callOI <= 0) return { pcr: 0, sentiment: "neutral", found: false };

  const pcr = putOI / callOI;
  const sentiment = pcr > 1.2 ? "bullish" : pcr < 0.7 ? "bearish" : "neutral";
  return { pcr, sentiment, found: true };
}

// ---- sub-components ---------------------------------------------------------

function IndexCard({
  def,
  slotIndex,
  histories,
  latestDate,
  optionsData,
  asOfOptionsDate,
  homeIndexSource,
  onChangeSlot,
  liveQuote,
  marketOpenNow,
  connected,
}: {
  def: IndexCardDef;
  slotIndex: number;
  histories: SymbolHistory[];
  latestDate: string;
  optionsData: OptionsDataset | null;
  asOfOptionsDate: string | null;
  homeIndexSource: "futures" | "spot";
  onChangeSlot: (slotIndex: number, key: string) => void;
  liveQuote?: ApiLiveQuote;
  marketOpenNow: boolean;
  connected: boolean;
}) {
  // ── Last Close fallback: fetch once on mount from market history API ──────
  const [lastCloseQuote, setLastCloseQuote] = useState<{ value: number; pct: number; pts: number } | null>(null);

  useEffect(() => {
    if (!def.fyersIndexSymbol) return;
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let cancelled = false;
    apiGetMarketHistory(def.fyersIndexSymbol, "1D", from, today)
      .then(({ bars }) => {
        if (cancelled || bars.length < 1) return;
        const last = bars[bars.length - 1];
        const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
        const ref = prev ? prev.close : 0;
        const pct = ref > 0 ? ((last.close - ref) / ref) * 100 : 0;
        const pts = ref > 0 ? last.close - ref : 0;
        setLastCloseQuote({ value: last.close, pct, pts });
      })
      .catch(() => { /* no cached data available */ });
    return () => { cancelled = true; };
  }, [def.fyersIndexSymbol]);

  const { data, sourceLabel } = useMemo(() => {
    if (liveQuote) {
      const pct = liveQuote.close > 0 ? ((liveQuote.ltp - liveQuote.close) / liveQuote.close) * 100 : 0;
      const pts = liveQuote.close > 0 ? liveQuote.ltp - liveQuote.close : 0;
      return { data: { value: liveQuote.ltp, pct, pts, found: true }, sourceLabel: "Live" };
    }
    if (def.futuresSymbol && homeIndexSource === "futures") {
      const fut = lookupFuturesIndex(optionsData, def.futuresSymbol, asOfOptionsDate);
      if (fut.found) return { data: fut, sourceLabel: "Futures" };
      // Futures is the user's preferred source, but no futures data was
      // available (nothing synced yet) — falling back to spot here is a
      // "no data" degradation, not the user's actual spot preference, so
      // label it distinctly rather than showing a plain "Spot" that would
      // be indistinguishable from someone who chose Spot mode on purpose.
      const spot = lookupIndex(histories, def.aliases, latestDate);
      return { data: spot, sourceLabel: "Futures (no data)" };
    }
    if (def.futuresSymbol) {
      return { data: lookupIndex(histories, def.aliases, latestDate), sourceLabel: "Spot" };
    }
    // No futuresSymbol — try spot CSV first
    const spotResult = lookupIndex(histories, def.aliases, latestDate);
    if (spotResult.found) return { data: spotResult, sourceLabel: null };
    // Tier 3 (new): Last Close from market history API
    if (def.fyersIndexSymbol && lastCloseQuote) {
      return { data: { ...lastCloseQuote, found: true as const }, sourceLabel: "Last Close" };
    }
    return { data: spotResult, sourceLabel: null };
  }, [liveQuote, histories, def.aliases, def.futuresSymbol, def.fyersIndexSymbol, latestDate, optionsData, asOfOptionsDate, homeIndexSource, lastCloseQuote]);

  const pcr = useMemo(
    () => def.futuresSymbol ? computePCR(optionsData, def.futuresSymbol, asOfOptionsDate) : null,
    [optionsData, def.futuresSymbol, asOfOptionsDate],
  );

  const positive = data.pct >= 0;

  const pcrColor =
    pcr?.sentiment === "bullish" ? "text-success" :
    pcr?.sentiment === "bearish" ? "text-destructive-bright" :
    "text-amber-400";

  return (
    <Card className="relative px-3 py-2 shadow-card hover:shadow-md transition-shadow flex items-center gap-2 group">
      {sourceLabel && (
        <span
          className={`absolute top-1.5 left-1.5 h-1.5 w-1.5 rounded-full ${
            liveQuote ? "bg-success animate-pulse" : "bg-amber-400"
          }`}
          title={liveQuote ? "Live feed active" : "Showing last close"}
        />
      )}
      {data.found ? (
        positive ? (
          <TrendingUp className="h-3.5 w-3.5 text-success shrink-0" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-destructive-bright shrink-0" />
        )
      ) : (
        <BarChart2 className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 leading-none">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground truncate leading-none">
            {def.label}
          </p>
          {sourceLabel && (
            <span className="text-[9px] font-normal tracking-normal text-muted-foreground/50 shrink-0">
              ({sourceLabel})
            </span>
          )}
        </div>

        {data.found ? (
          <div className="flex items-baseline gap-1.5 mt-0.5 flex-wrap">
            <span className="text-sm font-bold tabular-nums text-foreground leading-none">
              {fmtNumber(data.value)}
            </span>
            <span className={`text-[11px] font-bold leading-none ${positive ? "text-success" : "text-destructive-bright"}`}>
              {positive ? "+" : ""}{data.pct.toFixed(2)}%
            </span>
            <span className={`text-[10px] leading-none ${positive ? "text-success/60" : "text-destructive-bright/60"}`}>
              ({positive ? "+" : ""}{fmtNumber(data.pts)})
            </span>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground/40 mt-0.5 leading-none">Not in CSV</p>
        )}

        {/* PCR badge — only when options CSV is loaded and symbol has OI data */}
        {pcr?.found && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-[9px] text-muted-foreground/50 leading-none">PCR</span>
            <span className={`text-[9px] font-bold tabular-nums leading-none ${pcrColor}`}>
              {pcr.pcr.toFixed(2)}
            </span>
            <span className={`text-[8px] font-semibold leading-none uppercase tracking-wide ${pcrColor}`}>
              {pcr.sentiment === "bullish" ? "↑ Bull" : pcr.sentiment === "bearish" ? "↓ Bear" : "→ Neut"}
            </span>
          </div>
        )}
      </div>

      {/* Dropdown selector */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/40"
            title="Change index"
            aria-label="Change index"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold py-1">
            Select Index
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ALL_INDEX_DEFS.map((opt) => (
            <DropdownMenuItem
              key={opt.key}
              onClick={() => onChangeSlot(slotIndex, opt.key)}
              className="flex items-center justify-between text-xs cursor-pointer"
            >
              <span>{opt.label}</span>
              {def.key === opt.key && (
                <Check className="h-3 w-3 text-primary shrink-0 ml-2" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Card>
  );
}

function StockTable({
  rows,
  positive,
  lastCopied,
  setLastCopied,
}: {
  rows: StockRow[];
  positive: boolean;
  lastCopied: string | null;
  setLastCopied: (s: string) => void;
}) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-28 text-xs text-muted-foreground">
        No data
      </div>
    );
  }

  async function copySymbol(symbol: string) {
    const markCopied = () => setLastCopied(symbol);
    try {
      await navigator.clipboard.writeText(symbol);
      markCopied();
      toast.success(`Copied ${symbol}`);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = symbol;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); markCopied(); toast.success(`Copied ${symbol}`); }
      catch { toast.error("Copy failed"); }
      document.body.removeChild(ta);
    }
  }

  return (
    <div className="overflow-x-auto overflow-y-auto max-h-[160px]">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-card">
          <tr className="text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
            <th className="text-left px-3 py-1">Symbol</th>
            <th className="text-right px-3 py-1">LTP</th>
            <th className="text-right px-3 py-1">% Chg</th>
            <th className="text-right px-3 py-1">Volume</th>
            <th className="text-right px-3 py-1">Turnover</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isCopied = r.symbol === lastCopied;
            return (
              <tr
                key={r.symbol}
                className={`border-t border-border/40 transition-colors ${
                  isCopied
                    ? "bg-primary/15 hover:bg-primary/25"
                    : i % 2 === 0
                    ? "bg-card hover:bg-primary/8"
                    : "bg-muted/10 hover:bg-primary/8"
                }`}
              >
                <td className="px-3 py-1 font-semibold text-foreground text-xs tracking-wide">
                  <span className="inline-flex items-center gap-1.5">
                    {positive ? (
                      <TrendingUp className="h-3 w-3 text-success shrink-0" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-destructive-bright shrink-0" />
                    )}
                    {r.symbol}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); copySymbol(r.symbol); }}
                      title={`Copy "${r.symbol}" to clipboard`}
                      aria-label={`Copy ${r.symbol}`}
                      className={`transition-opacity p-0.5 rounded hover:text-primary ${
                        isCopied ? "opacity-100 text-primary" : "text-muted-foreground/40 hover:text-muted-foreground"
                      }`}
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </span>
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-xs text-foreground font-medium">
                  {fmtNumber(r.ltp)}
                </td>
                <td
                  className={`px-3 py-1 text-right tabular-nums text-xs font-bold ${
                    r.change >= 0 ? "text-success" : "text-destructive-bright"
                  }`}
                >
                  {r.change >= 0 ? "+" : ""}{r.change.toFixed(2)}%
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-xs text-muted-foreground">
                  {r.volume}
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-xs text-muted-foreground">
                  {r.turnover}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  iconClass,
  date,
  timeframe,
  onTimeframeChange,
  rows,
  children,
}: {
  title: string;
  icon: React.ElementType;
  iconClass: string;
  date?: string;
  timeframe?: Timeframe;
  onTimeframeChange?: (tf: Timeframe) => void;
  rows?: StockRow[];
  children: React.ReactNode;
}) {
  const dateLabel = date
    ? new Date(date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;

  const [allCopied, setAllCopied] = useState(false);

  async function copyAll() {
    if (!rows?.length) return;
    const text = rows.map((r) => r.symbol).join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { toast.error("Copy failed"); document.body.removeChild(ta); return; }
      document.body.removeChild(ta);
    }
    setAllCopied(true);
    toast.success(`Copied ${rows.length} symbols`);
    setTimeout(() => setAllCopied(false), 1800);
  }

  return (
    <Card className="shadow-card flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
        <div className="flex items-center gap-1.5">
          <Icon className={`h-3.5 w-3.5 ${iconClass}`} />
          <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {timeframe && onTimeframeChange && (
            <select
              value={timeframe}
              onChange={(e) => onTimeframeChange(e.target.value as Timeframe)}
              className="h-5 text-[10px] rounded border border-border/60 bg-background text-muted-foreground px-1 focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer"
            >
              {TF_OPTIONS.map((tf) => (
                <option key={tf} value={tf}>{TF_LABELS[tf]}</option>
              ))}
            </select>
          )}
          {rows && rows.length > 0 && (
            <button
              type="button"
              onClick={copyAll}
              title={`Copy all ${rows.length} symbols to clipboard`}
              className={`inline-flex items-center gap-1 h-5 px-1.5 rounded border text-[10px] transition-colors cursor-pointer ${
                allCopied
                  ? "border-success/60 bg-success/10 text-success"
                  : "border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-border"
              }`}
            >
              <Copy className="h-2.5 w-2.5" />
            </button>
          )}
          {dateLabel && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="h-2.5 w-2.5" />
              {dateLabel}
            </div>
          )}
        </div>
      </div>
      {children}
    </Card>
  );
}

// ---- main page --------------------------------------------------------------

export default function Home() {
  const { histories, categories, loading, optionsData, asOfDate, asOfOptionsDate } = useData();
  const navigate = useNavigate();
  const homeIndexSource = useHomeIndexSource();
  const [slots, setSlot] = useIndexSlots();

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  const [lastCopied, setLastCopied] = useState<string | null>(null);

  // ── Market status poll (30s) — drives the live/last-close status dot ────────
  const [marketStatus, setMarketStatus] = useState<{ marketOpenNow: boolean; connected: boolean }>({
    marketOpenNow: false,
    connected: false,
  });

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await apiGetSchedulerStatus();
        if (cancelled) return;
        setMarketStatus({
          marketOpenNow: status.liveFeed.marketOpenNow,
          connected: status.liveFeed.connected,
        });
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Live index quotes (Fyers real-time feed, when broker is connected) ──────
  const [liveIndexQuotes, setLiveIndexQuotes] = useState<Record<string, ApiLiveQuote>>({});

  useEffect(() => {
    const fyersSymbols = ALL_INDEX_DEFS
      .filter((d) => d.fyersIndexSymbol)
      .map((d) => d.fyersIndexSymbol!);
    if (!fyersSymbols.length) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const { quotes } = await apiGetMarketQuotes(fyersSymbols);
        if (cancelled) return;
        const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
        const byKey: Record<string, ApiLiveQuote> = {};
        for (const d of ALL_INDEX_DEFS) {
          if (d.fyersIndexSymbol && bySymbol.has(d.fyersIndexSymbol)) {
            byKey[d.key] = bySymbol.get(d.fyersIndexSymbol)!;
          }
        }
        setLiveIndexQuotes(byKey);
      } catch {
        // No broker connected, market closed, or a transient error —
        // leave existing state as-is so IndexCard falls back to
        // Futures/Spot below rather than showing a jarring blank.
      }
    };

    poll();
    const id = setInterval(poll, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Timeframe selector per universe pair ─────────────────────────────────────
  const [nseCashTf, setNseCashTf] = useState<Timeframe>("daily");
  const [niftyTf, setNiftyTf] = useState<Timeframe>("daily");
  const [secondTf, setSecondTf] = useState<Timeframe>("daily");
  const [futuresTf, setFuturesTf] = useState<Timeframe>("daily");

  // Use context-computed effective date (respects Live/Past mode + weekend fallback)
  const latestDate = asOfDate ?? "";

  const latestDateLabel = asOfDate
    ? new Date(asOfDate + "T00:00:00").toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : null;

  // Resolve the 4 active IndexCardDefs from the current slot keys
  const activeSlotDefs = useMemo(
    () => slots.map((key) => ALL_INDEX_BY_KEY.get(key) ?? ALL_INDEX_BY_KEY.get("NIFTY")!),
    [slots],
  );

  // ── Universe symbols from master watchlist ───────────────────────────────────

  const nseCashSymbols = useMemo<Set<string>>(() => {
    const cat = categories.find((c) => /nse.?cash/i.test(c.name));
    return cat ? new Set(cat.symbols) : new Set();
  }, [categories]);

  const nifty50Symbols = useMemo<Set<string>>(() => {
    const cat = categories.find(
      (c) => /nifty.?50/i.test(c.name) && !/midcap|small|next|bank|auto|it|fmcg|pharma/i.test(c.name)
    );
    return cat ? new Set(cat.symbols) : new Set();
  }, [categories]);

  const futuresSymbols = useMemo<Set<string>>(() => {
    const cat = categories.find((c) => /^futures?$/i.test(c.name.trim()));
    return cat ? new Set(cat.symbols) : new Set();
  }, [categories]);

  const secondCategory = useMemo(
    () =>
      categories.find(
        (c) =>
          !/nifty.?50/i.test(c.name) &&
          !/nse.?cash/i.test(c.name) &&
          !/^futures?$/i.test(c.name.trim()) &&
          c.symbols.length > 5
      ) ?? null,
    [categories]
  );
  const secondCatSymbols = useMemo<Set<string>>(
    () => (secondCategory ? new Set(secondCategory.symbols) : new Set()),
    [secondCategory]
  );

  // ── EQ-only pre-filtered history sets ────────────────────────────────────────

  const nseCashHistories = useMemo(
    () =>
      histories.filter((h) => {
        if (h.series !== "EQ") return false;
        if (nseCashSymbols.size > 0 && !nseCashSymbols.has(h.symbol)) return false;
        return true;
      }),
    [histories, nseCashSymbols]
  );

  const niftyHistories = useMemo(
    () =>
      nifty50Symbols.size > 0
        ? histories.filter((h) => h.series === "EQ" && nifty50Symbols.has(h.symbol))
        : [],
    [histories, nifty50Symbols]
  );

  const secondHistories = useMemo(
    () =>
      secondCatSymbols.size > 0
        ? histories.filter((h) => h.series === "EQ" && secondCatSymbols.has(h.symbol))
        : [],
    [histories, secondCatSymbols]
  );

  const futuresHistories = useMemo(
    () =>
      futuresSymbols.size > 0
        ? histories.filter((h) => h.series === "EQ" && futuresSymbols.has(h.symbol))
        : [],
    [histories, futuresSymbols]
  );

  // ── Row computation ───────────────────────────────────────────────────────────

  const allRows      = useMemo(() => computeRowsForTf(nseCashHistories, latestDate, nseCashTf), [nseCashHistories, latestDate, nseCashTf]);
  const nseGainers   = useMemo(() => [...allRows].sort((a, b) => b.change - a.change).slice(0, 10), [allRows]);
  const nseLosers    = useMemo(() => [...allRows].sort((a, b) => a.change - b.change).slice(0, 10), [allRows]);

  const niftyRows      = useMemo(() => computeRowsForTf(niftyHistories, latestDate, niftyTf), [niftyHistories, latestDate, niftyTf]);
  const nifty50Gainers = useMemo(() => [...niftyRows].sort((a, b) => b.change - a.change).slice(0, 10), [niftyRows]);
  const nifty50Losers  = useMemo(() => [...niftyRows].sort((a, b) => a.change - b.change).slice(0, 10), [niftyRows]);

  const secondRows    = useMemo(() => computeRowsForTf(secondHistories, latestDate, secondTf), [secondHistories, latestDate, secondTf]);
  const secondGainers = useMemo(() => [...secondRows].sort((a, b) => b.change - a.change).slice(0, 10), [secondRows]);
  const secondLosers  = useMemo(() => [...secondRows].sort((a, b) => a.change - b.change).slice(0, 10), [secondRows]);

  const futuresRows    = useMemo(() => computeRowsForTf(futuresHistories, latestDate, futuresTf), [futuresHistories, latestDate, futuresTf]);
  const futuresGainers = useMemo(() => [...futuresRows].sort((a, b) => b.change - a.change).slice(0, 10), [futuresRows]);
  const futuresLosers  = useMemo(() => [...futuresRows].sort((a, b) => a.change - b.change).slice(0, 10), [futuresRows]);

  const useNiftyPanel   = niftyRows.length > 0;
  const useSecondPanel  = !useNiftyPanel && secondRows.length > 0;
  const useFuturesPanel = futuresRows.length > 0;

  const hasData = histories.length > 0;

  return (
    <div className="bg-background">
      {/* No data state */}
      {!hasData && !loading && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
          <div className="rounded-full bg-muted/30 p-5">
            <Database className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <div className="text-center max-w-sm">
            <p className="text-base font-semibold text-foreground mb-1">No data loaded</p>
            <p className="text-xs text-muted-foreground">
              Upload your NSE bhavcopy CSV files to see live top gainers, losers, and market stats.
            </p>
          </div>
          <button
            onClick={() => navigate("/settings?tab=data")}
            className="inline-flex items-center gap-2 h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 active:scale-95 transition-all duration-150"
          >
            <Upload className="h-4 w-4" />
            Upload CSV Data
          </button>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-muted-foreground">Loading CSV data…</p>
        </div>
      )}

      {hasData && !loading && (
        <main className="container py-4 space-y-4">
          {/* 6 index cards — hover any card to reveal the dropdown for switching index */}
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
            {activeSlotDefs.map((def, i) => (
              <IndexCard
                key={i}
                def={def}
                slotIndex={i}
                histories={histories}
                latestDate={latestDate}
                optionsData={optionsData}
                asOfOptionsDate={asOfOptionsDate}
                homeIndexSource={homeIndexSource}
                onChangeSlot={setSlot}
                liveQuote={liveIndexQuotes[def.key]}
                marketOpenNow={marketStatus.marketOpenNow}
                connected={marketStatus.connected}
              />
            ))}
          </div>

          {/* Gainers / Losers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <SectionCard title="NSE Cash — Top Gainers" icon={TrendingUp} iconClass="text-success" date={latestDate || undefined} timeframe={nseCashTf} onTimeframeChange={setNseCashTf} rows={nseGainers}>
              <StockTable rows={nseGainers} positive={true} lastCopied={lastCopied} setLastCopied={setLastCopied} />
            </SectionCard>

            <SectionCard title="NSE Cash — Top Losers" icon={TrendingDown} iconClass="text-destructive-bright" date={latestDate || undefined} timeframe={nseCashTf} onTimeframeChange={setNseCashTf} rows={nseLosers}>
              <StockTable rows={nseLosers} positive={false} lastCopied={lastCopied} setLastCopied={setLastCopied} />
            </SectionCard>

            {useNiftyPanel && (
              <>
                <SectionCard title="Nifty 50 — Top Gainers" icon={BarChart2} iconClass="text-primary" date={latestDate || undefined} timeframe={niftyTf} onTimeframeChange={setNiftyTf} rows={nifty50Gainers}>
                  <StockTable rows={nifty50Gainers} positive={true} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
                <SectionCard title="Nifty 50 — Top Losers" icon={Activity} iconClass="text-orange-400" date={latestDate || undefined} timeframe={niftyTf} onTimeframeChange={setNiftyTf} rows={nifty50Losers}>
                  <StockTable rows={nifty50Losers} positive={false} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
              </>
            )}

            {useSecondPanel && (
              <>
                <SectionCard title={`${secondCategory!.name} — Top Gainers`} icon={BarChart2} iconClass="text-primary" date={latestDate || undefined} timeframe={secondTf} onTimeframeChange={setSecondTf} rows={secondGainers}>
                  <StockTable rows={secondGainers} positive={true} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
                <SectionCard title={`${secondCategory!.name} — Top Losers`} icon={Activity} iconClass="text-orange-400" date={latestDate || undefined} timeframe={secondTf} onTimeframeChange={setSecondTf} rows={secondLosers}>
                  <StockTable rows={secondLosers} positive={false} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
              </>
            )}

            {useFuturesPanel && (
              <>
                <SectionCard title="Futures — Top Gainers" icon={TrendingUp} iconClass="text-cyan-400" date={latestDate || undefined} timeframe={futuresTf} onTimeframeChange={setFuturesTf} rows={futuresGainers}>
                  <StockTable rows={futuresGainers} positive={true} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
                <SectionCard title="Futures — Top Losers" icon={TrendingDown} iconClass="text-orange-500" date={latestDate || undefined} timeframe={futuresTf} onTimeframeChange={setFuturesTf} rows={futuresLosers}>
                  <StockTable rows={futuresLosers} positive={false} lastCopied={lastCopied} setLastCopied={setLastCopied} />
                </SectionCard>
              </>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground/40 text-center pb-4">
            Based on your uploaded CSV data · {latestDateLabel ?? ""} · Hover a card to change index
          </p>
        </main>
      )}
    </div>
  );
}
