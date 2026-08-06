import { useMemo, useState } from "react";
import { BarChart2, TrendingUp, TrendingDown, Activity, Database, Search, ArrowUpDown, ChevronUp, ChevronDown, LineChart as LineChartIcon, Sliders, CandlestickChart, Link2, Table2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useData } from "@/context/DataContext";
import type { OptionBar, OptionsDataset } from "@/lib/options";
import OptionsSimulator from "./OptionsSimulator";
import StockSimulator from "./StockSimulator";
import OptionChainTab from "./OptionChain";
import StockIntraday from "./StockIntraday";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtOI(n: number): string {
  if (!isFinite(n) || n === 0) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_00_00_000) return sign + (abs / 1_00_00_000).toFixed(2) + " Cr";
  if (abs >= 1_00_000)    return sign + (abs / 1_00_000).toFixed(2) + " L";
  if (abs >= 1_000)       return sign + (abs / 1_000).toFixed(1) + " K";
  return sign + abs.toFixed(0);
}

function fmtDelta(n: number): string {
  if (!isFinite(n) || n === 0) return "—";
  const prefix = n > 0 ? "+" : "";
  return prefix + fmtOI(n);
}

// ── computation ───────────────────────────────────────────────────────────────

interface OIStats {
  symbol: string;
  instrument: "OPTIDX" | "OPTSTK" | undefined;
  latestDate: string;
  frontExpiry: string;
  ceOI: number;
  peOI: number;
  ceDeltaOI: number;
  peDeltaOI: number;
  pcr: number;
  maxPain: number;
  spot: number;       // futures close if available, else 0
}

function computeMaxPain(
  bars: OptionBar[],
  symbol: string,
  date: string,
  expiry: string,
): number {
  const strikeMap = new Map<number, { ceOI: number; peOI: number }>();
  for (const b of bars) {
    if (b.symbol !== symbol || b.date !== date || b.expiry !== expiry) continue;
    const entry = strikeMap.get(b.strike) ?? { ceOI: 0, peOI: 0 };
    if (b.type === "CE") entry.ceOI += b.oi;
    else entry.peOI += b.oi;
    strikeMap.set(b.strike, entry);
  }
  const strikes = Array.from(strikeMap.keys()).sort((a, b) => a - b);
  if (!strikes.length) return 0;

  let minPain = Infinity;
  let maxPainStrike = strikes[0];
  for (const S of strikes) {
    let pain = 0;
    for (const [K, { ceOI, peOI }] of strikeMap) {
      if (K < S) pain += (S - K) * ceOI;   // ITM CE payout
      if (K > S) pain += (K - S) * peOI;   // ITM PE payout
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = S; }
  }
  return maxPainStrike;
}

function buildStats(ds: OptionsDataset | null, effectiveDate: string | null): OIStats[] {
  if (!ds || !ds.bars.length) return [];

  const latestDate = effectiveDate ?? ds.dates[ds.dates.length - 1];

  // Build front expiry per symbol (nearest expiry >= latestDate)
  const frontExpiries = new Map<string, string>();
  for (const [sym, expiries] of ds.expiriesBySymbol) {
    const front = expiries.find((e) => e >= latestDate) ?? expiries[expiries.length - 1];
    if (front) frontExpiries.set(sym, front);
  }

  // Aggregate OI stats per symbol (front expiry only, latest date)
  const agg = new Map<string, {
    ceOI: number; peOI: number; ceDeltaOI: number; peDeltaOI: number;
    instrument: "OPTIDX" | "OPTSTK" | undefined;
  }>();

  for (const b of ds.bars) {
    if (b.date !== latestDate) continue;
    const fe = frontExpiries.get(b.symbol);
    if (!fe || b.expiry !== fe) continue;

    const entry = agg.get(b.symbol) ?? {
      ceOI: 0, peOI: 0, ceDeltaOI: 0, peDeltaOI: 0,
      instrument: b.instrument,
    };
    if (b.type === "CE") { entry.ceOI += b.oi; entry.ceDeltaOI += b.changeInOI; }
    else { entry.peOI += b.oi; entry.peDeltaOI += b.changeInOI; }
    agg.set(b.symbol, entry);
  }

  // Build final stats
  const out: OIStats[] = [];
  for (const [symbol, { ceOI, peOI, ceDeltaOI, peDeltaOI, instrument }] of agg) {
    const frontExpiry = frontExpiries.get(symbol) ?? "";
    const pcr = ceOI > 0 ? peOI / ceOI : 0;
    const maxPain = computeMaxPain(ds.bars, symbol, latestDate, frontExpiry);
    const spot = ds.futuresCloseByKey.get(`${symbol}|${latestDate}`) ?? 0;
    out.push({ symbol, instrument, latestDate, frontExpiry, ceOI, peOI, ceDeltaOI, peDeltaOI, pcr, maxPain, spot });
  }
  return out;
}

// ── sentiment ────────────────────────────────────────────────────────────────

function sentiment(stat: OIStats): {
  label: string;
  className: string;
  dotClass: string;
  bold: boolean;
} {
  const { pcr, ceDeltaOI, peDeltaOI, spot, maxPain } = stat;
  const oiBias = peDeltaOI - ceDeltaOI;
  const aboveMaxPain = maxPain > 0 && spot > 0 && spot > maxPain;

  if (pcr > 1.3 && oiBias > 0) return { label: "Strong Bullish", className: "text-emerald-400 bg-emerald-400/15", dotClass: "bg-emerald-400", bold: true };
  if (pcr > 1.1 && !aboveMaxPain) return { label: "Bullish", className: "text-green-400 bg-green-400/10", dotClass: "bg-green-400", bold: false };
  if (pcr < 0.65 && oiBias < 0) return { label: "Strong Bearish", className: "text-red-500 bg-red-500/15", dotClass: "bg-red-500", bold: true };
  if (pcr < 0.85 || (aboveMaxPain && pcr < 1.0)) return { label: "Bearish", className: "text-red-400 bg-red-400/10", dotClass: "bg-red-400", bold: false };
  return { label: "Neutral", className: "text-amber-400 bg-amber-400/10", dotClass: "bg-amber-400", bold: false };
}

// ── sort type ─────────────────────────────────────────────────────────────────

type SortKey = "symbol" | "pcr" | "ceOI" | "peOI" | "ceDeltaOI" | "peDeltaOI" | "maxPain";

// ── known index order ─────────────────────────────────────────────────────────

const INDEX_ORDER = ["NIFTY", "BANKNIFTY", "FINNIFTY", "NIFTYNXT50", "MIDCPNIFTY", "SENSEX", "BANKEX"];

// ── components ────────────────────────────────────────────────────────────────

function SortHeader({
  label, sortKey, active, dir, onSort,
}: {
  label: string; sortKey: SortKey; active: SortKey; dir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  const isActive = active === sortKey;
  return (
    <th
      className="px-3 py-2 text-right cursor-pointer select-none hover:text-foreground transition-colors whitespace-nowrap"
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center justify-end gap-0.5 ${isActive ? "text-primary" : ""}`}>
        {label}
        {isActive
          ? (dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
          : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );
}

function OITable({
  rows,
  sortKey,
  sortDir,
  onSort,
  showSymbolLeft = false,
}: {
  rows: OIStats[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  showSymbolLeft?: boolean;
}) {
  if (!rows.length) {
    return (
      <div className="flex items-center justify-center h-32 text-xs text-muted-foreground">
        No data for this expiry
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[700px]">
        <thead>
          <tr className="text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border/60">
            <th
              className="px-3 py-2 text-left cursor-pointer select-none hover:text-foreground"
              onClick={() => onSort("symbol")}
            >
              <span className={`inline-flex items-center gap-0.5 ${sortKey === "symbol" ? "text-primary" : ""}`}>
                Symbol
                {sortKey === "symbol"
                  ? (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)
                  : <ArrowUpDown className="h-3 w-3 opacity-30" />}
              </span>
            </th>
            <SortHeader label="PCR" sortKey="pcr" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHeader label="CE OI" sortKey="ceOI" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHeader label="PE OI" sortKey="peOI" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHeader label="Δ CE OI" sortKey="ceDeltaOI" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHeader label="Δ PE OI" sortKey="peDeltaOI" active={sortKey} dir={sortDir} onSort={onSort} />
            <SortHeader label="Max Pain" sortKey="maxPain" active={sortKey} dir={sortDir} onSort={onSort} />
            <th className="px-3 py-2 text-right text-[9px] uppercase tracking-wide text-muted-foreground">Sentiment</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const sent = sentiment(row);
            const pcrColor = row.pcr > 1.2 ? "text-success" : row.pcr < 0.7 ? "text-destructive-bright" : "text-amber-400";
            const distPct = row.spot > 0 && row.maxPain > 0
              ? ((row.spot - row.maxPain) / row.spot) * 100
              : null;
            return (
              <tr
                key={row.symbol}
                className={`border-t border-border/40 transition-colors ${
                  i % 2 === 0 ? "bg-card hover:bg-primary/5" : "bg-muted/10 hover:bg-primary/5"
                }`}
              >
                <td className="px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold text-foreground tracking-wide">{row.symbol}</span>
                    <span className="text-[9px] text-muted-foreground/50">
                      Exp: {row.frontExpiry ? new Date(row.frontExpiry + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
                      {row.spot > 0 && (
                        <span className="ml-1">· Spot: {row.spot.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                      )}
                    </span>
                  </div>
                </td>
                <td className={`px-3 py-2 text-right tabular-nums text-xs font-bold ${pcrColor}`}>
                  {row.ceOI > 0 ? row.pcr.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground font-medium">
                  {fmtOI(row.ceOI)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs text-muted-foreground font-medium">
                  {fmtOI(row.peOI)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums text-xs font-semibold ${row.ceDeltaOI >= 0 ? "text-destructive-bright/70" : "text-success/70"}`}>
                  {fmtDelta(row.ceDeltaOI)}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums text-xs font-semibold ${row.peDeltaOI >= 0 ? "text-success/70" : "text-destructive-bright/70"}`}>
                  {fmtDelta(row.peDeltaOI)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-xs">
                  {row.maxPain > 0 ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="font-semibold text-foreground">
                        {row.maxPain.toLocaleString("en-IN")}
                      </span>
                      {distPct !== null && (
                        <span className={`text-[9px] ${Math.abs(distPct) < 1 ? "text-amber-400" : distPct > 0 ? "text-destructive-bright/60" : "text-success/60"}`}>
                          {distPct > 0 ? "+" : ""}{distPct.toFixed(1)}% from spot
                        </span>
                      )}
                    </div>
                  ) : "—"}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] ${sent.bold ? "font-bold" : "font-medium"} ${sent.className}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sent.dotClass}`} />
                    {sent.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

function OptionsAnalysisTab() {
  const { optionsData } = useData();
  const [tab, setTab] = useState<"indices" | "stocks">("indices");
  const [stockSort, setStockSort] = useState<SortKey>("ceOI");
  const [stockDir, setStockDir] = useState<"asc" | "desc">("desc");
  const [indexSort, setIndexSort] = useState<SortKey>("symbol");
  const [indexDir, setIndexDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");

  const { asOfOptionsDate } = useData();
  const allStats = useMemo(() => buildStats(optionsData, asOfOptionsDate), [optionsData, asOfOptionsDate]);

  const indexStats = useMemo(() => {
    const rows = allStats.filter((r) => r.instrument === "OPTIDX");
    // Sort by known index order first, then by selected sort
    if (indexSort === "symbol") {
      return [...rows].sort((a, b) => {
        const ai = INDEX_ORDER.indexOf(a.symbol);
        const bi = INDEX_ORDER.indexOf(b.symbol);
        const order = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return indexDir === "asc" ? order : -order;
      });
    }
    return [...rows].sort((a, b) => {
      const v = a[indexSort] - b[indexSort];
      return indexDir === "asc" ? v : -v;
    });
  }, [allStats, indexSort, indexDir]);

  const stockStats = useMemo(() => {
    const rows = allStats
      .filter((r) => r.instrument === "OPTSTK")
      .filter((r) => !search || r.symbol.toLowerCase().includes(search.toLowerCase()));
    return [...rows].sort((a, b) => {
      const v = stockSort === "symbol"
        ? a.symbol.localeCompare(b.symbol)
        : a[stockSort] - b[stockSort];
      return stockDir === "asc" ? v : -v;
    });
  }, [allStats, stockSort, stockDir, search]);

  const hasData = allStats.length > 0;
  const latestDate = hasData ? allStats[0].latestDate : null;
  const latestDateLabel = latestDate
    ? new Date(latestDate + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  function toggleSort(
    key: SortKey,
    current: SortKey,
    dir: "asc" | "desc",
    setKey: (k: SortKey) => void,
    setDir: (d: "asc" | "desc") => void,
  ) {
    if (current === key) setDir(dir === "asc" ? "desc" : "asc");
    else { setKey(key); setDir(key === "symbol" ? "asc" : "desc"); }
  }

  return (
    <div className="bg-background">
      {/* No data */}
      {!hasData && (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
          <div className="rounded-full bg-muted/30 p-5">
            <Database className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <div className="text-center max-w-sm">
            <p className="text-base font-semibold text-foreground mb-1">No options data loaded</p>
            <p className="text-xs text-muted-foreground">
              Upload an NSE FO bhavcopy CSV (contains OPTIDX / OPTSTK / FUTIDX rows) from the Create Scan page to see PCR, OI, Change in OI, and Max Pain.
            </p>
          </div>
        </div>
      )}

      {hasData && (
        <main className="container py-2 space-y-3">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-base font-bold text-foreground">Data Analysis</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                PCR · Open Interest · Change in OI · Max Pain · Sentiment
              </p>
            </div>
            {latestDateLabel && (
              <span className="text-[10px] text-muted-foreground/60 bg-muted/30 px-2 py-1 rounded">
                Data: {latestDateLabel}
              </span>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">PCR</span> = PE OI ÷ CE OI (front expiry)
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span>
              <span className="font-semibold text-success">Δ PE OI ↑</span> = puts building (Bullish signal)
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span>
              <span className="font-semibold text-destructive-bright">Δ CE OI ↑</span> = calls building (Bearish signal)
            </span>
            <span className="text-muted-foreground/40">·</span>
            <span>
              <span className="font-semibold text-foreground">Max Pain</span> = strike where max options expire worthless
            </span>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border">
            {[
              { key: "indices", label: "Index OI", icon: BarChart2, count: indexStats.length },
              { key: "stocks",  label: "Stocks F&O", icon: Activity, count: stockStats.length },
            ].map(({ key, label, icon: Icon, count }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key as "indices" | "stocks")}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold border-b-2 transition-colors -mb-px ${
                  tab === key
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                <span className={`text-[9px] px-1 rounded ${tab === key ? "bg-primary/20 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {/* Index tab */}
          {tab === "indices" && (
            <Card className="shadow-card overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
                <div className="flex items-center gap-1.5">
                  <BarChart2 className="h-3.5 w-3.5 text-primary" />
                  <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
                    Index Options — Front Expiry Summary
                  </h3>
                </div>
                <span className="text-[9px] text-muted-foreground/40">{indexStats.length} indices</span>
              </div>
              <OITable
                rows={indexStats}
                sortKey={indexSort}
                sortDir={indexDir}
                onSort={(k) => toggleSort(k, indexSort, indexDir, setIndexSort, setIndexDir)}
              />
            </Card>
          )}

          {/* Stocks tab */}
          {tab === "stocks" && (
            <div className="space-y-3">
              {/* Search */}
              <div className="relative max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                <input
                  type="text"
                  placeholder="Search symbol…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-muted/30 border border-border rounded-md text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>

              <Card className="shadow-card overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-3.5 w-3.5 text-cyan-400" />
                    <h3 className="text-[11px] font-bold tracking-wide text-muted-foreground uppercase">
                      Stock Options — Front Expiry OI Analysis
                    </h3>
                  </div>
                  <span className="text-[9px] text-muted-foreground/40">{stockStats.length} symbols</span>
                </div>
                <OITable
                  rows={stockStats}
                  sortKey={stockSort}
                  sortDir={stockDir}
                  onSort={(k) => toggleSort(k, stockSort, stockDir, setStockSort, setStockDir)}
                />
              </Card>
            </div>
          )}

          {/* Sentiment guide */}
          <Card className="px-4 py-3 shadow-card">
            <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wide mb-2">Sentiment Guide</p>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 text-[10px]">
              {[
                { label: "Strong Bullish", desc: "PCR > 1.3 + PE OI rising", color: "text-emerald-400", dot: "bg-emerald-400", bold: true },
                { label: "Bullish",        desc: "PCR 1.1–1.3 + spot ≤ Max Pain", color: "text-green-400", dot: "bg-green-400", bold: false },
                { label: "Neutral",        desc: "PCR 0.85–1.1", color: "text-amber-400", dot: "bg-amber-400", bold: false },
                { label: "Bearish",        desc: "PCR 0.65–0.85 or spot > Max Pain", color: "text-red-400", dot: "bg-red-400", bold: false },
                { label: "Strong Bearish", desc: "PCR < 0.65 + CE OI rising", color: "text-red-500", dot: "bg-red-500", bold: true },
              ].map(({ label, desc, color, dot, bold }) => (
                <div key={label} className="flex items-start gap-1.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 mt-0.5 ${dot}`} />
                  <div>
                    <p className={`${bold ? "font-bold" : "font-medium"} ${color}`}>{label}</p>
                    <p className="text-muted-foreground/60">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <p className="text-[10px] text-muted-foreground/40 text-center pb-4">
            All OI figures are in contracts · Front expiry only · Based on your uploaded NSE FO bhavcopy
          </p>
        </main>
      )}
    </div>
  );
}

// ── Top-level page with tabs ───────────────────────────────────────────────────

export default function OptionsPage() {
  const [pageTab, setPageTab] = useState<"chain" | "simulator" | "stock-simulator" | "analysis" | "stock-intraday">("simulator");

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      {/* Page-level tab bar */}
      <div className="flex items-center border-b border-border bg-card px-4 shrink-0">
        {[
          { key: "simulator",       label: "Option Simulator", icon: Sliders           },
          { key: "stock-simulator", label: "Stock Simulator",  icon: CandlestickChart  },
          { key: "chain",           label: "Option Chain",     icon: Link2             },
          { key: "analysis",        label: "Data Analysis", icon: BarChart2          },
          { key: "stock-intraday",  label: "Stock Intraday",   icon: Table2             },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setPageTab(key as "chain" | "simulator" | "stock-simulator" | "analysis" | "stock-intraday")}
            className={`flex items-center gap-1.5 px-4 py-1 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              pageTab === key
                ? key === "chain"
                  ? "border-cyan-500 text-cyan-400"
                  : key === "simulator"
                    ? "border-purple-500 text-purple-500"
                    : "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-3 w-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content — flex-1 + overflow-hidden keeps each simulator self-contained */}
      <div className="flex-1 overflow-hidden">
        {pageTab === "chain"           && <OptionChainTab />}
        {pageTab === "analysis"        && <OptionsAnalysisTab />}
        {pageTab === "stock-intraday"  && <StockIntraday />}
        {pageTab === "simulator"       && <OptionsSimulator />}
        {pageTab === "stock-simulator" && <StockSimulator />}
      </div>
    </div>
  );
}
