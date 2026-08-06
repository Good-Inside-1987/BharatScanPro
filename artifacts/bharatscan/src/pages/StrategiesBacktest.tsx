import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import {
  Play, Plus, ClipboardPaste, TrendingUp, TrendingDown, BarChart3, Percent,
  IndianRupee, Save, History, Trash2, Download, FolderInput, Loader2, Copy, X,
  ChevronDown, ChevronUp, Settings2, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown,
  Search, Minus, Layers,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConditionRow, newCondition, NameModeContext } from "@/components/ConditionRow";
import { FilterGroupBlock, type DragSrc } from "@/components/FilterGroupBlock";
import { LogicModeSelect } from "@/components/LogicModeSelect";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { runScan, normalizeCondition, isGroup, newGroup, flattenItems, type Condition, type ConditionGroup, type FilterItem, type LogicMode, type ScanResult } from "@/lib/screener";
import { listScans, saveScan, deleteScan, migrateSavedScan, type SavedScan } from "@/lib/savedScans";
import { useData } from "@/context/DataContext";
import type { SymbolHistory } from "@/lib/csv";
import { buildOptionHistories } from "@/lib/options";
import { type UniverseCategory } from "@/lib/universe";
import { toast } from "sonner";
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScanMode = "stocks" | "options";
const ALL_UNIVERSE_ID = "ALL";

interface Trade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  qty: number;
  pnl: number;
  returnPct: number;
  holdingDays: number;
  exitReason: string;
}

interface StrategySettings {
  capital: number;
  useQty: boolean;
  qty: number;
  entryExecution: "next_open" | "this_close"
    | "cross_above_prev_high" | "cross_above_prev_close" | "cross_above_prev_low"
    | "cross_below_prev_high" | "cross_below_prev_close" | "cross_below_prev_low";
  stopLoss: number;
  target: number;
  maxHoldingDays: number;
  maxPositions: number;
  brokerage: number;
  slippage: number;
}

interface BacktestSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  netPnl: number;
  totalReturn: number;
  cagr: number;
  cagrIsAnnualised: boolean;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  sharpe: number;
  maxDrawdown: number;
  equityCurve: { date: string; equity: number; drawdown: number }[];
  monthlyReturns: { key: string; label: string; pct: number }[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveSeriesFilter(sel: string, seriesList: string[]): string[] | undefined {
  if (sel === "ALL") return undefined;
  if (sel === "EQ") return ["EQ"];
  if (sel === "ETF") return seriesList.filter((s) => /ETF/i.test(s));
  if (sel === "BOND") {
    const bondCodes = new Set(["GB", "GS", "SG", "TB", "Y1", "F1", "FB", "MF", "N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "NA", "NB", "NC", "ND", "NE"]);
    return seriesList.filter((s) => bondCodes.has(s) || /BOND|DEBT|GSEC|GILT/i.test(s));
  }
  return [sel];
}

function findBarIdx(h: SymbolHistory, date: string): number {
  let lo = 0, hi = h.bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const md = h.bars[mid].date;
    if (md === date) return mid;
    if (md < date) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

function runStrategyBacktest(
  histories: SymbolHistory[],
  entryItems: FilterItem[],
  entryLogicMode: LogicMode,
  exitItems: FilterItem[],
  exitLogicMode: LogicMode,
  settings: StrategySettings,
  direction: "long" | "short",
  lookbackDays: number,
  seriesFilter?: string[],
): { trades: Trade[]; dailyEquity: { date: string; equity: number }[] } {
  const enabledEntry = flattenItems(entryItems).filter(c => c.enabled !== false);
  if (!enabledEntry.length) return { trades: [], dailyEquity: [] };

  const allDatesSet = new Set<string>();
  for (const h of histories) for (const b of h.bars) allDatesSet.add(b.date);
  const allDates = Array.from(allDatesSet).sort();
  const startIdx = Math.max(0, allDates.length - lookbackDays);
  const tradingDates = allDates.slice(startIdx);
  if (tradingDates.length < 2) return { trades: [], dailyEquity: [] };

  const symMap = new Map<string, SymbolHistory>();
  for (const h of histories) symMap.set(h.symbol, h);

  const hasExitItems = flattenItems(exitItems).filter(c => c.enabled !== false).length > 0;

  const trades: Trade[] = [];
  const openPositions = new Map<string, { entryDate: string; entryPrice: number; dateIdx: number }>();
  const dailyEquity: { date: string; equity: number }[] = [];
  let closedPnl = 0;

  for (let di = 0; di < tradingDates.length; di++) {
    const date = tradingDates[di];

    // — Process exits —
    for (const [symbol, pos] of [...openPositions.entries()]) {
      const h = symMap.get(symbol);
      if (!h) { openPositions.delete(symbol); continue; }

      const barIdx = findBarIdx(h, date);
      if (barIdx < 0) continue;
      const bar = h.bars[barIdx];
      const holdingDays = di - pos.dateIdx;
      if (holdingDays === 0) continue;

      let exitPrice: number | null = null;
      let exitReason = "";

      if (direction === "long") {
        const slPrice = settings.stopLoss > 0 ? pos.entryPrice * (1 - settings.stopLoss / 100) : -Infinity;
        const tpPrice = settings.target > 0 ? pos.entryPrice * (1 + settings.target / 100) : Infinity;
        if (settings.stopLoss > 0 && bar.low <= slPrice) {
          exitPrice = Math.max(slPrice, bar.open * 0.999);
          exitReason = "Stop Loss";
        } else if (settings.target > 0 && bar.high >= tpPrice) {
          exitPrice = tpPrice;
          exitReason = "Target";
        }
      } else {
        const slPrice = settings.stopLoss > 0 ? pos.entryPrice * (1 + settings.stopLoss / 100) : Infinity;
        const tpPrice = settings.target > 0 ? pos.entryPrice * (1 - settings.target / 100) : -Infinity;
        if (settings.stopLoss > 0 && bar.high >= slPrice) {
          exitPrice = Math.min(slPrice, bar.open * 1.001);
          exitReason = "Stop Loss";
        } else if (settings.target > 0 && bar.low <= tpPrice) {
          exitPrice = tpPrice;
          exitReason = "Target";
        }
      }

      if (exitPrice === null && settings.maxHoldingDays > 0 && holdingDays >= settings.maxHoldingDays) {
        exitPrice = bar.close;
        exitReason = "Max Holding";
      }

      if (exitPrice === null && hasExitItems) {
        try {
          const exitRes = runScan([h], exitItems, { asOfDate: date, logicMode: exitLogicMode });
          if (exitRes.length > 0) { exitPrice = bar.close; exitReason = "Exit Signal"; }
        } catch (err) {
          console.warn(`[BharatScan] Exit scan error for ${symbol} on ${date}:`, err);
        }
      }

      if (exitPrice !== null) {
        const qty = settings.useQty ? settings.qty : Math.max(1, Math.floor(settings.capital / pos.entryPrice));
        const rawPnl = direction === "long"
          ? (exitPrice - pos.entryPrice) * qty
          : (pos.entryPrice - exitPrice) * qty;
        const costs = (pos.entryPrice + exitPrice) * qty * (settings.brokerage + settings.slippage) / 100;
        const pnl = rawPnl - costs;
        const returnPct = direction === "long"
          ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
        trades.push({ symbol, entryDate: pos.entryDate, entryPrice: pos.entryPrice, exitDate: date, exitPrice, qty, pnl, returnPct, holdingDays, exitReason });
        closedPnl += pnl;
        openPositions.delete(symbol);
      }
    }

    // — Process entries —
    if (di < tradingDates.length - 1) {
      try {
        const entryRes = runScan(histories, entryItems, { series: seriesFilter, asOfDate: date, logicMode: entryLogicMode });
        // Sort by volume descending so maxPositions picks the most liquid stocks,
        // not alphabetically first stocks (which creates a permanent selection bias).
        entryRes.sort((a, b) => b.volume - a.volume);
        for (const r of entryRes) {
          if (openPositions.has(r.symbol)) continue;
          if (settings.maxPositions > 0 && openPositions.size >= settings.maxPositions) break;
          const h = symMap.get(r.symbol);
          if (!h) continue;
          const sigBarIdx = findBarIdx(h, date);
          if (sigBarIdx < 0) continue;
          const sigBar = h.bars[sigBarIdx];
          const nextDate = tradingDates[di + 1];
          const nextBarIdx = findBarIdx(h, nextDate);
          if (nextBarIdx < 0) continue;
          const nextBar = h.bars[nextBarIdx];
          // Compute candidate entry price based on execution rule.
          // cross_above_* = next day's high must reach/exceed the ref level → enter at ref (buy-stop breakout).
          // cross_below_* = next day's low must reach/breach the ref level → enter at ref (sell-stop breakdown).
          // sigBar is the actual signal-day bar from history (has .high/.low); r.close comes from ScanResult directly.
          let entryPrice: number;
          if (settings.entryExecution === "next_open") {
            entryPrice = nextBar.open;
          } else if (settings.entryExecution === "this_close") {
            entryPrice = r.close;
          } else if (settings.entryExecution === "cross_above_prev_high") {
            entryPrice = nextBar.high >= sigBar.high ? sigBar.high : 0;
          } else if (settings.entryExecution === "cross_above_prev_close") {
            entryPrice = nextBar.high >= r.close ? r.close : 0;
          } else if (settings.entryExecution === "cross_above_prev_low") {
            entryPrice = nextBar.high >= sigBar.low ? sigBar.low : 0;
          } else if (settings.entryExecution === "cross_below_prev_high") {
            entryPrice = nextBar.low <= sigBar.high ? sigBar.high : 0;
          } else if (settings.entryExecution === "cross_below_prev_close") {
            entryPrice = nextBar.low <= r.close ? r.close : 0;
          } else if (settings.entryExecution === "cross_below_prev_low") {
            entryPrice = nextBar.low <= sigBar.low ? sigBar.low : 0;
          } else {
            entryPrice = nextBar.open;
          }
          if (!entryPrice || entryPrice <= 0) continue;
          openPositions.set(r.symbol, { entryDate: nextBar.date, entryPrice, dateIdx: di + 1 });
        }
      } catch (err) {
        console.warn(`[BharatScan] Entry scan error on ${date}:`, err);
      }
    }

    // Daily mark-to-market equity: closed P&L + unrealized P&L of open positions.
    // This captures intra-trade drawdowns that a trade-exit-only curve misses entirely.
    let unrealizedPnl = 0;
    for (const [symbol, pos] of openPositions) {
      const h = symMap.get(symbol);
      if (!h) continue;
      const barIdx = findBarIdx(h, date);
      if (barIdx < 0) continue;
      const currentPrice = h.bars[barIdx].close;
      const qty = settings.useQty
        ? settings.qty
        : Math.max(1, Math.floor(settings.capital / pos.entryPrice));
      const rawUnreal = direction === "long"
        ? (currentPrice - pos.entryPrice) * qty
        : (pos.entryPrice - currentPrice) * qty;
      unrealizedPnl += rawUnreal;
    }
    dailyEquity.push({ date, equity: settings.capital + closedPnl + unrealizedPnl });
  }

  // Close remaining open positions at last bar
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const [symbol, pos] of openPositions) {
    const h = symMap.get(symbol);
    if (!h || !h.bars.length) continue;
    const barIdx = findBarIdx(h, lastDate);
    const bar = barIdx >= 0 ? h.bars[barIdx] : h.bars[h.bars.length - 1];
    const qty = settings.useQty ? settings.qty : Math.max(1, Math.floor(settings.capital / pos.entryPrice));
    const rawPnl = direction === "long"
      ? (bar.close - pos.entryPrice) * qty
      : (pos.entryPrice - bar.close) * qty;
    const costs = (pos.entryPrice + bar.close) * qty * (settings.brokerage + settings.slippage) / 100;
    const pnl = rawPnl - costs;
    const returnPct = direction === "long"
      ? ((bar.close - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - bar.close) / pos.entryPrice) * 100;
    const holdingDays = tradingDates.length - 1 - pos.dateIdx;
    trades.push({ symbol, entryDate: pos.entryDate, entryPrice: pos.entryPrice, exitDate: bar.date, exitPrice: bar.close, qty, pnl, returnPct, holdingDays, exitReason: "End of Period" });
    closedPnl += pnl;
  }

  return {
    trades: trades.sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
    dailyEquity,
  };
}

function computeSummary(
  trades: Trade[],
  initialCapital: number,
  dailyEquity: { date: string; equity: number }[],
): BacktestSummary {
  if (!trades.length) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      netPnl: 0, totalReturn: 0, cagr: 0, cagrIsAnnualised: false,
      avgProfit: 0, avgLoss: 0, profitFactor: 0, sharpe: 0,
      maxDrawdown: 0, equityCurve: [], monthlyReturns: [],
    };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  // Equity curve and Max Drawdown from daily mark-to-market equity.
  // This captures intra-trade drawdowns, not just losses at exit points.
  let maxDD = 0;
  let peak = initialCapital;
  const equityCurve: { date: string; equity: number; drawdown: number }[] = [];
  for (const { date, equity } of dailyEquity) {
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({
      date,
      equity: Math.round(equity * 100) / 100,
      drawdown: -Math.round(dd * 100) / 100,
    });
  }

  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const firstDate = new Date(sorted[0].entryDate);
  const lastDate = new Date(sorted[sorted.length - 1].exitDate);
  const years = (lastDate.getTime() - firstDate.getTime()) / (365.25 * 86400000);
  const finalEquity = initialCapital + netPnl;
  const cagr = years < 1
    ? initialCapital > 0 ? (netPnl / initialCapital) * (1 / Math.max(years, 0.01)) * 100 : 0
    : initialCapital > 0
      ? (Math.pow(Math.max(0.001, finalEquity / initialCapital), 1 / years) - 1) * 100
      : 0;
  const cagrIsAnnualised = years < 1;

  const monthMap = new Map<string, number>();
  for (const t of trades) {
    const key = t.exitDate.slice(0, 7);
    monthMap.set(key, (monthMap.get(key) ?? 0) + t.pnl);
  }
  const monthStartEquity = new Map<string, number>();
  let runningEquity = initialCapital;
  const sortedForMonthly = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  const tradesByMonth = new Map<string, typeof trades>();
  for (const t of sortedForMonthly) {
    const key = t.exitDate.slice(0, 7);
    if (!tradesByMonth.has(key)) tradesByMonth.set(key, []);
    tradesByMonth.get(key)!.push(t);
  }
  const sortedMonthKeys = Array.from(tradesByMonth.keys()).sort();
  for (const key of sortedMonthKeys) {
    monthStartEquity.set(key, runningEquity);
    const monthPnl = tradesByMonth.get(key)!.reduce((s, t) => s + t.pnl, 0);
    runningEquity += monthPnl;
  }
  const monthlyReturns = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pnl]) => {
      const [y, m] = key.split("-");
      const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(
        "en-IN", { month: "short", year: "2-digit" }
      );
      const startEq = monthStartEquity.get(key) ?? initialCapital;
      const pct = startEq > 0 ? (pnl / startEq) * 100 : 0;
      return { key, label, pct };
    });

  // Sharpe Ratio using daily equity returns — the standard method.
  // Formula: sqrt(252) x (mean_daily_return - rf_daily) / std_daily_return
  // rf_daily = 6% annual / 252 trading days
  // The old per-trade method ignored time: a 6-month loss and 1-day gain
  // each counted as one equal period, producing a meaningless number.
  let sharpe = 0;
  if (dailyEquity.length >= 20) {
    const dailyReturns: number[] = [];
    for (let i = 1; i < dailyEquity.length; i++) {
      const prev = dailyEquity[i - 1].equity;
      if (prev > 0) dailyReturns.push((dailyEquity[i].equity - prev) / prev);
    }
    if (dailyReturns.length >= 10) {
      const meanR = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
      const rfDaily = 0.06 / 252;
      const variance = dailyReturns.reduce((s, r) => s + (r - meanR) ** 2, 0) / dailyReturns.length;
      const stdR = Math.sqrt(variance);
      if (stdR > 0) sharpe = ((meanR - rfDaily) / stdR) * Math.sqrt(252);
    }
  }

  return {
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: (wins.length / trades.length) * 100,
    netPnl,
    totalReturn: initialCapital > 0 ? (netPnl / initialCapital) * 100 : 0,
    cagr,
    cagrIsAnnualised,
    avgProfit: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    profitFactor,
    sharpe,
    maxDrawdown: maxDD,
    equityCurve,
    monthlyReturns,
  };
}

// ─── ScanBuilderPanel ────────────────────────────────────────────────────────

interface ScanBuilderPanelProps {
  title: string;
  filterLabel: string;
  series: string;
  onChange: (items: FilterItem[], logicMode: LogicMode) => void;
  conditionClipboard: Condition | null;
  onConditionCopy: (c: Condition) => void;
  scanClipboard: { filterItems: FilterItem[]; topLogicMode: LogicMode; series: string } | null;
  onScanCopy: (sc: { filterItems: FilterItem[]; topLogicMode: LogicMode; series: string }) => void;
  defaultLogicMode?: LogicMode;
}

function ScanBuilderPanel({ title, filterLabel, series, onChange, conditionClipboard, onConditionCopy, scanClipboard, onScanCopy, defaultLogicMode = "all" }: ScanBuilderPanelProps) {
  const [filterItems, setFilterItems] = useState<FilterItem[]>([]);
  const [topLogicMode, setTopLogicModeState] = useState<LogicMode>(defaultLogicMode);
  const [activeDrag, setActiveDrag] = useState<DragSrc | null>(null);
  const [dragOverTopIdx, setDragOverTopIdx] = useState<number | null>(null);
  const [escapeZoneOver, setEscapeZoneOver] = useState(false);
  const [afterGroupOver, setAfterGroupOver] = useState<number | null>(null);
  const [nameMode, setNameMode] = useState<"full" | "short">("full");
  const [scanName, setScanName] = useState("");
  const [loadedScanId, setLoadedScanId] = useState<string | undefined>();
  const [savedScans, setSavedScans] = useState<SavedScan[]>([]);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listScans().then(setSavedScans).catch(() => {}); }, []);

  const updateItems = (next: FilterItem[], lm?: LogicMode) => {
    setFilterItems(next);
    onChange(next, lm ?? topLogicMode);
  };

  const setTopLogicMode = (lm: LogicMode) => {
    setTopLogicModeState(lm);
    onChange(filterItems, lm);
  };

  function normalizeFilterItem(item: FilterItem): FilterItem {
    if (isGroup(item)) return { ...item, conditions: item.conditions.map(normalizeFilterItem) };
    return normalizeCondition(item);
  }

  function cloneFilterItems(items: FilterItem[]): FilterItem[] {
    return items.map(item => {
      if (isGroup(item)) return { ...item, id: Math.random().toString(36).slice(2), conditions: cloneFilterItems(item.conditions) };
      return { ...item, id: Math.random().toString(36).slice(2) };
    });
  }

  async function handleSave() {
    const name = scanName.trim();
    if (!name) { toast.error("Give the scan a name"); return; }
    const saved = await saveScan({ id: loadedScanId, name, filterItems, topLogicMode, series });
    setLoadedScanId(saved.id);
    setSavedScans(await listScans());
    toast.success(loadedScanId ? `Updated "${name}"` : `Saved "${name}"`);
  }

  async function handleSaveAs() {
    const suggested = scanName.trim() ? `${scanName.trim()} copy` : "New scan";
    const name = window.prompt("Save scan as…", suggested)?.trim();
    if (!name) return;
    const saved = await saveScan({ name, filterItems, topLogicMode, series });
    setLoadedScanId(saved.id);
    setScanName(name);
    setSavedScans(await listScans());
    toast.success(`Saved as "${name}"`);
  }

  function loadScan(s: SavedScan) {
    const { filterItems: fi, topLogicMode: lm } = migrateSavedScan(s);
    const normalized = fi.map(normalizeFilterItem);
    setFilterItems(normalized);
    setTopLogicModeState(lm);
    onChange(normalized, lm);
    setScanName(s.name);
    setLoadedScanId(s.id);
    toast.success(`Loaded "${s.name}"`);
  }

  async function removeScan(id: string) {
    await deleteScan(id);
    setSavedScans(await listScans());
  }

  function handleExport() {
    if (!filterItems.length) { toast.error("No filters to export"); return; }
    const payload: SavedScan = { id: loadedScanId ?? Math.random().toString(36).slice(2), name: scanName.trim() || "scan", filterItems, topLogicMode, series, savedAt: Date.now() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `${payload.name}.bharatscan.json`; a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported "${payload.name}"`);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as SavedScan;
        if (!parsed.filterItems && !Array.isArray(parsed.conditions)) throw new Error("Invalid");
        const { filterItems: fi, topLogicMode: lm } = migrateSavedScan(parsed);
        const name = parsed.name?.trim() || file.name.replace(/\.bharatscan\.json$/i, "");
        const saved = await saveScan({ name, filterItems: fi.map(normalizeFilterItem), topLogicMode: lm, series: parsed.series ?? "EQ" });
        setSavedScans(await listScans());
        loadScan(saved);
        toast.success(`Imported "${name}"`);
      } catch { toast.error("Could not read scan file — make sure it's a valid BharatScan export."); }
    };
    reader.readAsText(file);
  }

  return (
    <Card className="shadow-card py-2 px-4">
      <div className="flex items-center justify-between mb-1.5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold tracking-wide text-muted-foreground uppercase">{title}</h2>
            {filterItems.length > 0 && (
              <button type="button"
                onClick={() => { onScanCopy({ filterItems: cloneFilterItems(filterItems), topLogicMode, series }); toast.success(`Copied scan (${flattenItems(filterItems).length} filter${flattenItems(filterItems).length === 1 ? "" : "s"})`); }}
                className="inline-flex items-center px-2 py-1 text-xs font-bold rounded-md bg-success text-background hover:opacity-90 transition-opacity" title="Copy this scan">
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
            <span>Stock passes</span>
            <LogicModeSelect value={topLogicMode} onChange={setTopLogicMode} />
            <span>of the below {filterLabel} filters</span>
          </div>
        </div>
        {filterItems.length > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Names</span>
              <div className="inline-flex rounded-md border border-border bg-input p-[1px]">
                {(["full", "short"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setNameMode(m)}
                    className={`px-2 py-0.5 text-[10px] font-semibold rounded-sm transition-colors ${nameMode === m ? (m === "full" ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground") : "text-muted-foreground hover:text-foreground"}`}>
                    {m === "full" ? "Full" : "Short"}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" onClick={() => updateItems([])} className="flex items-center justify-center rounded-md text-orange-400 hover:text-orange-300 hover:bg-orange-400/10 transition-colors p-0.5" title="Clear all filters">
              <X className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border bg-secondary/20 p-2">
        {filterItems.length > 0 && (
          <NameModeContext.Provider value={nameMode}>
            <div className="space-y-1 mb-2">
              {filterItems.map((item, i) => {
                if (isGroup(item)) {
                  const activeDragIsGroup = !!(activeDrag?.kind === "top" && isGroup(filterItems[activeDrag.idx]));
                  return (
                    <Fragment key={item.id}>
                    <FilterGroupBlock
                      group={item}
                      onChange={(updated) => updateItems(filterItems.map((x, j) => j === i ? updated : x))}
                      onDelete={() => updateItems(filterItems.filter((_, j) => j !== i))}
                      onToggle={() => updateItems(filterItems.map((x, j) => j === i ? { ...x, enabled: item.enabled !== false ? false : true } : x))}
                      conditionClipboard={conditionClipboard}
                      onCopyCondition={(c) => { onConditionCopy({ ...c }); toast.success("Filter copied"); }}
                      isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                      isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                      topIdx={i}
                      activeDrag={activeDrag}
                      activeDragIsGroup={activeDragIsGroup}
                      onDropOnGroup={(src) => {
                        const next = [...filterItems];
                        if (src.kind === "top") {
                          const sourceItem = filterItems[src.idx];
                          if (!isGroup(sourceItem)) {
                            const [condition] = next.splice(src.idx, 1);
                            const adjustedIdx = src.idx < i ? i - 1 : i;
                            const grp = next[adjustedIdx] as ConditionGroup;
                            next[adjustedIdx] = { ...grp, conditions: [...grp.conditions, condition as Condition] };
                          } else {
                            if (src.idx === i) return;
                            const [moved] = next.splice(src.idx, 1);
                            next.splice(i, 0, moved);
                          }
                        } else if (src.kind === "inner" && src.topIdx !== i) {
                          const srcGrp = next[src.topIdx] as ConditionGroup;
                          const srcConds = [...srcGrp.conditions];
                          const [movedCond] = srcConds.splice(src.condIdx, 1);
                          next[src.topIdx] = { ...srcGrp, conditions: srcConds };
                          const tgtGrp = next[i] as ConditionGroup;
                          next[i] = { ...tgtGrp, conditions: [...tgtGrp.conditions, movedCond] };
                        }
                        updateItems(next);
                        setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null);
                      }}
                      onInnerDragStart={(condIdx) => setActiveDrag({ kind: "inner", topIdx: i, condIdx })}
                      onInnerDragEnd={() => setActiveDrag(null)}
                      dragHandleProps={{
                        draggable: true,
                        onDragStart: (e: React.DragEvent) => {
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "top", idx: i }));
                          requestAnimationFrame(() => setActiveDrag({ kind: "top", idx: i }));
                        },
                        onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTopIdx !== i) setDragOverTopIdx(i); },
                        onDrop: (e: React.DragEvent) => {
                          e.preventDefault();
                          const raw = e.dataTransfer.getData("text/plain");
                          if (!raw) return;
                          try {
                            const src = JSON.parse(raw) as DragSrc;
                            if (src.kind !== "top" || src.idx === i) return;
                            // Only handle group→group reorders here; condition drops
                            // should bubble up to the FilterGroupBlock's outer onDrop.
                            if (!isGroup(filterItems[src.idx])) return;
                            e.stopPropagation();
                            const next = [...filterItems];
                            const [moved] = next.splice(src.idx, 1);
                            next.splice(i, 0, moved);
                            updateItems(next);
                          } catch {}
                          setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null);
                        },
                        onDragEnd: () => { setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null); },
                      }}
                    />
                    {activeDrag?.kind === "top" && (
                      <div
                        className={`rounded transition-all duration-150 ${
                          afterGroupOver === i
                            ? "h-2 bg-primary/60 ring-1 ring-primary/40 my-0.5"
                            : "h-1 bg-white/5 my-px"
                        }`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = "move";
                          if (afterGroupOver !== i) setAfterGroupOver(i);
                        }}
                        onDragLeave={() => { if (afterGroupOver === i) setAfterGroupOver(null); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const raw = e.dataTransfer.getData("text/plain");
                          if (!raw) return;
                          try {
                            const src = JSON.parse(raw) as DragSrc;
                            if (src.kind !== "top") return;
                            const next = [...filterItems];
                            const [moved] = next.splice(src.idx, 1);
                            const insertAt = src.idx < i ? i : i + 1;
                            next.splice(insertAt, 0, moved);
                            updateItems(next);
                          } catch {}
                          setAfterGroupOver(null);
                          setActiveDrag(null); setDragOverTopIdx(null);
                        }}
                      />
                    )}
                    </Fragment>
                  );
                }
                const c = item;
                return (
                  <ConditionRow
                    key={c.id}
                    condition={c}
                    onChange={(nc) => updateItems(filterItems.map((x, j) => j === i ? nc : x))}
                    onRemove={() => updateItems(filterItems.filter((_, j) => j !== i))}
                    onCopy={() => { onConditionCopy({ ...c }); toast.success("Filter copied"); }}
                    onDuplicate={() => {
                      const clone = { ...c, id: Math.random().toString(36).slice(2) };
                      const next = [...filterItems]; next.splice(i + 1, 0, clone); updateItems(next);
                    }}
                    onToggle={() => updateItems(filterItems.map((x, j) => j === i ? { ...x, enabled: (x as typeof c).enabled === false ? true : false } : x))}
                    isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                    isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                    dragPush={
                      activeDrag?.kind === "top" && activeDrag.idx !== i && dragOverTopIdx !== null
                        ? (activeDrag.idx < i && i <= dragOverTopIdx ? "up" : activeDrag.idx > i && i >= dragOverTopIdx ? "down" : undefined)
                        : undefined
                    }
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "top", idx: i }));
                      requestAnimationFrame(() => setActiveDrag({ kind: "top", idx: i }));
                    }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTopIdx !== i) setDragOverTopIdx(i); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const raw = e.dataTransfer.getData("text/plain");
                      if (!raw) return;
                      try {
                        const src = JSON.parse(raw) as DragSrc;
                        const next = [...filterItems];
                        if (src.kind === "top") {
                          if (src.idx === i) return;
                          const [moved] = next.splice(src.idx, 1);
                          next.splice(i, 0, moved);
                        } else if (src.kind === "inner") {
                          const grp = next[src.topIdx] as ConditionGroup;
                          const newConds = [...grp.conditions];
                          const [movedCond] = newConds.splice(src.condIdx, 1);
                          next[src.topIdx] = { ...grp, conditions: newConds };
                          next.splice(i, 0, movedCond);
                        }
                        updateItems(next);
                      } catch {}
                      setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null);
                    }}
                    onDragEnd={() => { setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null); }}
                  />
                );
              })}
            </div>
            {activeDrag?.kind === "inner" && (
              <div
                className={`mt-1 h-7 rounded border border-dashed transition-all duration-150 flex items-center justify-center text-[10px] ${
                  escapeZoneOver ? "border-primary/60 bg-primary/5 text-primary" : "border-white/15 text-muted-foreground/40"
                }`}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setEscapeZoneOver(true); }}
                onDragLeave={() => setEscapeZoneOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setEscapeZoneOver(false);
                  const raw = e.dataTransfer.getData("text/plain");
                  if (!raw) return;
                  try {
                    const src = JSON.parse(raw) as DragSrc;
                    if (src.kind !== "inner") return;
                    const next = [...filterItems];
                    const srcGrp = next[src.topIdx] as ConditionGroup;
                    const srcConds = [...srcGrp.conditions];
                    const [movedCond] = srcConds.splice(src.condIdx, 1);
                    next[src.topIdx] = { ...srcGrp, conditions: srcConds };
                    next.push(movedCond);
                    updateItems(next);
                  } catch {}
                  setActiveDrag(null); setDragOverTopIdx(null);
                }}
              >
                {escapeZoneOver ? "↑ Release to move to main filter list" : "Drag here to move filter out of group"}
              </div>
            )}
          </NameModeContext.Provider>
        )}
        <div className={`flex items-center gap-1.5${filterItems.length > 0 ? " pt-2 border-t border-border/50" : ""}`}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className={`h-6 px-2 text-xs ${filterItems.length === 0 ? "text-green-500" : "text-white"}`}>
                <Plus className="h-3 w-3" /> {filterItems.length === 0 ? "Create" : "Add"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="text-xs">
              <DropdownMenuItem onClick={() => updateItems([...filterItems, newCondition()])}>
                <Plus size={13} className="mr-2" /> Add Condition
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => updateItems([...filterItems, newGroup()])}>
                <Layers size={13} className="mr-2" /> Add Sub-Filter Group
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={!scanClipboard}
            onClick={() => { if (!scanClipboard) return; updateItems(cloneFilterItems(scanClipboard.filterItems), scanClipboard.topLogicMode); setTopLogicModeState(scanClipboard.topLogicMode); toast.success("Pasted scan"); }}>
            <ClipboardPaste className="h-4 w-4" /> Paste
          </Button>
          {conditionClipboard && (
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
              onClick={() => { updateItems([...filterItems, { ...conditionClipboard, id: Math.random().toString(36).slice(2) }]); toast.success("Filter pasted"); }}>
              <ClipboardPaste className="h-3 w-3" /> Paste Filter
            </Button>
          )}
        </div>
      </div>

      {/* Save / Load / Import / Export row */}
      <div className="flex flex-wrap items-center gap-1 mt-1">
        <Input placeholder="Scan name…" value={scanName} onChange={(e) => setScanName(e.target.value)} className="h-7 w-36 bg-input text-xs" />
        <Button variant="outline" size="sm" onClick={handleSave} disabled={!scanName.trim()} className="h-7 px-2 text-xs" title="Save this scan">
          <Save className="h-3 w-3" /> Save
        </Button>
        <Button variant="outline" size="sm" onClick={handleSaveAs} className="h-7 px-2 text-xs" title="Save as new name">
          <Save className="h-3 w-3" /> Save As
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" title="Load a saved scan">
              <History className="h-3 w-3" /> Load
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="text-xs max-h-64 overflow-y-auto min-w-[200px]">
            {savedScans.length === 0 ? (
              <div className="px-3 py-3 text-center text-muted-foreground text-xs">No saved scans yet</div>
            ) : savedScans.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => loadScan(s)} className="flex items-center justify-between gap-3">
                <span className="truncate">{s.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{flattenItems(migrateSavedScan(s).filterItems).length}f</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="sm" onClick={handleExport} disabled={!filterItems.length} className="h-7 px-2 text-xs" title="Export to .json">
          <Download className="h-3 w-3" /> Export
        </Button>
        <Button variant="outline" size="sm" onClick={() => importRef.current?.click()} className="h-7 px-2 text-xs" title="Import .json">
          <FolderInput className="h-3 w-3" /> Import
        </Button>
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImport} />
      </div>

      {localStorage.getItem("bharatscan:show-saved-scans") === "true" && savedScans.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border">
          <div className="flex items-center gap-2 mb-1.5">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Saved Scans</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {savedScans.map((s) => (
              <div key={s.id} className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/40 pl-2.5 pr-1 py-1 text-xs">
                <button onClick={() => loadScan(s)} className="font-medium hover:text-primary">{s.name}</button>
                <span className="text-[10px] text-muted-foreground">·{flattenItems(migrateSavedScan(s).filterItems).length}f</span>
                <button onClick={() => removeScan(s.id)} className="ml-1 text-muted-foreground hover:text-destructive-bright">
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Number settings input ────────────────────────────────────────────────────

function NumInput({ value, onChange, min = 0, max = 1e9, step = 1, className = "" }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { if (parseFloat(text) !== value) setText(String(value)); }, [value]);
  return (
    <Input type="text" inputMode="decimal" value={text}
      className={`h-7 bg-input text-xs ${className}`}
      onChange={(e) => { setText(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n) && n >= min && n <= max) onChange(n); }}
      onBlur={() => { const n = parseFloat(text); if (isNaN(n)) { setText(String(value)); } else { const c = Math.max(min, Math.min(max, n)); setText(String(c)); onChange(c); } }}
    />
  );
}

// ─── Custom tooltip for equity chart ─────────────────────────────────────────

function EquityTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 px-3 py-2 text-xs shadow-lg">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-foreground">₹{payload[0]?.value?.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</p>
    </div>
  );
}

function DrawdownTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 px-3 py-2 text-xs shadow-lg">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-semibold text-destructive-bright">{payload[0]?.value?.toFixed(2)}%</p>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function StrategiesBacktest() {
  const { histories, loading, categories, optionsData } = useData();

  // Shared controls
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [scanMode, setScanMode] = useState<ScanMode>("stocks");
  const [series, setSeries] = useState("EQ");
  const [universeId, setUniverseId] = useState(ALL_UNIVERSE_ID);
  const [optExpiry, setOptExpiry] = useState("");
  const [optOffset, setOptOffset] = useState(0);
  const [optSide, setOptSide] = useState<"CE" | "PE">("CE");
  const [optPriceSource, setOptPriceSource] = useState<"futures" | "spot">("futures");

  // Condition state (controlled from panels via callbacks)
  const [entryItems, setEntryItems] = useState<FilterItem[]>([]);
  const [entryLogicMode, setEntryLogicMode] = useState<LogicMode>("all");
  const [exitItems, setExitItems] = useState<FilterItem[]>([]);
  const [exitLogicMode, setExitLogicMode] = useState<LogicMode>("all");
  const [conditionClipboard, setConditionClipboard] = useState<Condition | null>(null);
  const [scanClipboard, setScanClipboard] = useState<{ filterItems: FilterItem[]; topLogicMode: LogicMode; series: string } | null>(null);

  // Strategy settings
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [settings, setSettings] = useState<StrategySettings>({
    capital: 50000, useQty: false, qty: 1,
    entryExecution: "cross_above_prev_close",
    stopLoss: 3, target: 10, maxHoldingDays: 20, maxPositions: 0,
    brokerage: 0.03, slippage: 0.05,
  });

  // Backtest state
  const [lookbackDays, setLookbackDays] = useState(252);
  const [running, setRunning] = useState(false);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [summary, setSummary] = useState<BacktestSummary | null>(null);

  // Trade table
  const [tradeSearch, setTradeSearch] = useState("");
  const [tradeSortKey, setTradeSortKey] = useState<keyof Trade>("entryDate");
  const [tradeSortDir, setTradeSortDir] = useState<"asc" | "desc">("asc");
  const [tradePage, setTradePage] = useState(1);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null); // "YYYY-MM" or null = all
  const [lastCopied, setLastCopied] = useState<string | null>(null); // symbol key of most-recently copied row
  const TRADES_PER_PAGE = 25;

  const seriesList = useMemo(() => { const s = new Set<string>(); histories.forEach(h => s.add(h.series)); return Array.from(s).sort(); }, [histories]);

  const OPTIONS_UNIVERSE_NAMES = ["nifty indices", "nifty50", "nifty 50", "futures"];
  const visibleCategories = useMemo<UniverseCategory[]>(() => {
    if (scanMode !== "options") return categories;
    return categories.filter(c => OPTIONS_UNIVERSE_NAMES.includes(c.name.trim().toLowerCase()));
  }, [categories, scanMode]);

  const activeCategory = useMemo<UniverseCategory | null>(() => {
    if (universeId === ALL_UNIVERSE_ID) return null;
    return categories.find(c => c.id === universeId) ?? null;
  }, [categories, universeId]);

  const filteredHistories = useMemo((): SymbolHistory[] => {
    if (scanMode === "options") {
      if (!optionsData || !optExpiry) return [];
      const allow = activeCategory ? new Set(activeCategory.symbols) : null;
      // Universe filter applied inside buildOptionHistories — FUT mode works without equity data
      const spotForOptions = allow ? histories.filter(h => allow.has(h.symbol)) : histories;
      return buildOptionHistories(optionsData, spotForOptions, optExpiry, optSide, () => undefined, optOffset, optPriceSource === "spot", allow);
    }
    if (!activeCategory) return histories;
    const allow = new Set(activeCategory.symbols);
    return histories.filter(h => allow.has(h.symbol));
  }, [histories, scanMode, activeCategory, optionsData, optExpiry, optSide, optOffset, optPriceSource]);

  useEffect(() => {
    if (scanMode !== "options" || !optionsData) return;
    const allExpiries = new Set<string>();
    for (const list of optionsData.expiriesBySymbol.values()) for (const e of list) allExpiries.add(e);
    const sorted = Array.from(allExpiries).sort();
    if (!sorted.length) return;
    if (optExpiry && sorted.includes(optExpiry)) return;
    // Pick the nearest expiry that is >= today; fall back to last if all are past
    const today = new Date().toISOString().slice(0, 10);
    const current = sorted.find((e) => e >= today) ?? sorted[sorted.length - 1];
    setOptExpiry(current);
  }, [scanMode, optionsData, optExpiry]);

  // Auto-select "NSE Cash" when categories load (stocks mode) or
  // the appropriate options universe when switching to options mode.
  useEffect(() => {
    if (scanMode === "stocks") {
      const nseCash = categories.find((c) => c.name.trim().toLowerCase() === "nse cash");
      if (nseCash && universeId !== nseCash.id) setUniverseId(nseCash.id);
      return;
    }
    if (scanMode === "options") {
      if (visibleCategories.length === 0) return;
      const nifty50 = visibleCategories.find((c) => {
        const n = c.name.trim().toLowerCase();
        return n === "nifty50" || n === "nifty 50";
      });
      const target = nifty50?.id ?? visibleCategories[0].id;
      if (universeId !== target) setUniverseId(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanMode, categories, visibleCategories]);

  const sfilt = useMemo(() => resolveSeriesFilter(series, seriesList), [series, seriesList]);

  function handleRunBacktest() {
    if (!filteredHistories.length) {
      toast.error(histories.length ? "No symbols in the selected universe" : "Load CSV data first");
      return;
    }
    if (!flattenItems(entryItems).filter(c => c.enabled !== false).length) {
      toast.error("Add at least one entry condition");
      return;
    }
    setRunning(true);
    setTrades(null);
    setSummary(null);
    setTradePage(1);
    setSelectedMonth(null);
    setLastCopied(null);
    setTimeout(() => {
      try {
        const t0 = performance.now();
        const { trades: result, dailyEquity } = runStrategyBacktest(filteredHistories, entryItems, entryLogicMode, exitItems, exitLogicMode, settings, direction, lookbackDays, sfilt);
        const t1 = performance.now();
        const sum = computeSummary(result, settings.capital, dailyEquity);
        setTrades(result);
        setSummary(sum);
        toast.success(`${result.length} trades in ${(t1 - t0).toFixed(0)}ms`);
      } catch (err) {
        toast.error("Backtest error: " + String(err));
      } finally {
        setRunning(false);
      }
    }, 10);
  }

  function toggleTradeSort(k: keyof Trade) {
    if (tradeSortKey === k) setTradeSortDir(d => d === "asc" ? "desc" : "asc");
    else { setTradeSortKey(k); setTradeSortDir("asc"); }
  }

  const filteredTrades = useMemo(() => {
    if (!trades) return [];
    const q = tradeSearch.trim().toUpperCase();
    let filtered = q ? trades.filter(t => t.symbol.includes(q) || t.exitReason.toUpperCase().includes(q)) : trades;
    if (selectedMonth) filtered = filtered.filter(t => t.exitDate.startsWith(selectedMonth));
    return [...filtered].sort((a, b) => {
      const av = a[tradeSortKey], bv = b[tradeSortKey];
      if (typeof av === "number" && typeof bv === "number") return tradeSortDir === "asc" ? av - bv : bv - av;
      return tradeSortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
  }, [trades, tradeSearch, selectedMonth, tradeSortKey, tradeSortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredTrades.length / TRADES_PER_PAGE));
  const pagedTrades = filteredTrades.slice((tradePage - 1) * TRADES_PER_PAGE, tradePage * TRADES_PER_PAGE);

  async function copyTradeSymbol(symbol: string) {
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
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      markCopied();
      toast.success(`Copied ${symbol}`);
    }
  }

  function exportTrades() {
    if (!trades?.length) return;
    const lines = ["Symbol,Entry Date,Entry Price,Exit Date,Exit Price,Qty,P&L,Return%,Holding Days,Exit Reason"];
    filteredTrades.forEach(t => lines.push([t.symbol, t.entryDate, t.entryPrice.toFixed(2), t.exitDate, t.exitPrice.toFixed(2), t.qty, t.pnl.toFixed(2), t.returnPct.toFixed(2), t.holdingDays, `"${t.exitReason}"`].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `backtest_trades_${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  function SortIcon({ k }: { k: keyof Trade }) {
    if (tradeSortKey !== k) return <ArrowUpDown className="h-3 w-3 opacity-40 ml-0.5 inline" />;
    return tradeSortDir === "asc"
      ? <ArrowUp className="h-3 w-3 ml-0.5 inline text-primary" />
      : <ArrowDown className="h-3 w-3 ml-0.5 inline text-primary" />;
  }

  const directionLabel = direction === "long"
    ? { entry: "Buy Conditions", exit: "Sell Conditions" }
    : { entry: "Short Conditions", exit: "Cover Conditions" };

  return (
    <div className="bg-background">
      <main className="container py-2 space-y-2">

        {/* ─── Direction + Global Controls ─── */}
        <Card className="py-1 px-4 shadow-card">
          <div className="flex flex-wrap items-center gap-2">

            {/* Long / Short toggle */}
            <div className="flex flex-col gap-px">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Direction</span>
              <div className="inline-flex rounded-md border border-border bg-input p-px">
                {(["long", "short"] as const).map(d => (
                  <button key={d} type="button" onClick={() => {
                    setDirection(d);
                    setSettings(s => {
                      const ex = s.entryExecution;
                      if (d === "short" && ex.startsWith("cross_above_"))
                        return { ...s, entryExecution: ex.replace("cross_above_", "cross_below_") as StrategySettings["entryExecution"] };
                      if (d === "long" && ex.startsWith("cross_below_"))
                        return { ...s, entryExecution: ex.replace("cross_below_", "cross_above_") as StrategySettings["entryExecution"] };
                      return s;
                    });
                  }}
                    className={`px-2 py-px text-[10px] font-semibold rounded-sm transition-colors capitalize ${
                      direction === d
                        ? d === "long" ? "bg-success text-background" : "bg-destructive-bright text-background"
                        : "text-muted-foreground hover:text-foreground"
                    }`}>
                    {d === "long" ? "↑ Long" : "↓ Short"}
                  </button>
                ))}
              </div>
            </div>

            <span className="h-5 w-px bg-border" />

            {/* Mode */}
            <div className="flex flex-col gap-px">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Mode</span>
              <div className="inline-flex rounded-md border border-border bg-input p-px">
                {([{ v: "stocks", l: "Stocks" }, { v: "options", l: "Options" }] as { v: ScanMode; l: string }[]).map(m => (
                  <button key={m.v} type="button" onClick={() => setScanMode(m.v)}
                    className={`px-2 py-px text-[10px] font-semibold rounded-sm transition-colors ${
                      scanMode === m.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    }`}>
                    {m.l}
                  </button>
                ))}
              </div>
            </div>

            <span className="h-5 w-px bg-border" />

            {/* Universe */}
            <div className="flex flex-col gap-px">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Universe</span>
              <Select value={universeId} onValueChange={setUniverseId}>
                <SelectTrigger className="w-auto min-w-[130px] max-w-[280px] h-6 bg-input text-xs">
                  <SelectValue placeholder="Pick universe…" />
                </SelectTrigger>
                <SelectContent>
                  {scanMode === "stocks" && (
                    <SelectItem value={ALL_UNIVERSE_ID}>All Loaded Stocks{histories.length ? ` (${histories.length})` : ""}</SelectItem>
                  )}
                  {visibleCategories.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}{c.symbols.length ? ` (${c.symbols.length})` : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Series */}
            <div className="flex flex-col gap-px">
              <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Series</span>
              <Select value={series} onValueChange={setSeries}>
                <SelectTrigger className="w-16 h-6 bg-input text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">ALL</SelectItem>
                  <SelectItem value="EQ">EQ</SelectItem>
                  <SelectItem value="ETF">ETF</SelectItem>
                  <SelectItem value="BOND">Bond</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Options sub-controls */}
            {scanMode === "options" && optionsData && (
              <Fragment>
                <span className="h-5 w-px bg-border" />
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-px">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Side</span>
                    <div className="inline-flex rounded-md border border-border bg-input p-px h-6">
                      {(["CE", "PE"] as const).map(s => (
                        <button key={s} type="button" onClick={() => setOptSide(s)}
                          className={`px-2 text-[10px] font-semibold rounded-sm transition-colors ${optSide === s ? (s === "CE" ? "bg-success text-background" : "bg-destructive-bright text-background") : "text-muted-foreground hover:text-foreground"}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-px">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Expiry</span>
                    <Select value={optExpiry} onValueChange={setOptExpiry}>
                      <SelectTrigger className="w-[130px] h-6 bg-input text-xs"><SelectValue placeholder="Pick expiry" /></SelectTrigger>
                      <SelectContent>
                        {Array.from(new Set(Array.from(optionsData.expiriesBySymbol.values()).flat())).sort().map(e => (
                          <SelectItem key={e} value={e}>{e}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-px">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">Strike</span>
                    <div className="flex items-center gap-1.5">
                      <div className="flex flex-col gap-px">
                        <button type="button" onClick={() => setOptOffset(o => o + 1)}
                          className="flex items-center justify-center w-4 h-[11px] rounded-t-sm border border-border bg-input hover:bg-accent transition-colors">
                          <ChevronUp className="h-2 w-2" />
                        </button>
                        <button type="button" onClick={() => setOptOffset(o => o - 1)}
                          className="flex items-center justify-center w-4 h-[11px] rounded-b-sm border border-border bg-input hover:bg-accent transition-colors">
                          <ChevronDown className="h-2 w-2" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1 px-2 h-6 rounded-md border border-border bg-input min-w-[56px]">
                        <span className={`text-[10px] font-bold ${
                          optOffset === 0 ? "text-primary"
                            : (optSide === "CE" ? optOffset > 0 : optOffset < 0) ? "text-fuchsia-400"
                            : "text-success"
                        }`}>
                          {optOffset === 0 ? "ATM"
                            : optSide === "CE" ? (optOffset > 0 ? "OTM" : "ITM")
                            : (optOffset < 0 ? "OTM" : "ITM")}
                        </span>
                        {optOffset !== 0 && (
                          <span className="text-[9px] font-mono text-muted-foreground">
                            {optOffset > 0 ? `+${optOffset}` : optOffset}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-px">
                    <span className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">ATM Ref</span>
                    <div
                      className="inline-flex rounded-md border border-border bg-input p-px h-6"
                      title={optPriceSource === "futures" ? "ATM determined by Futures close price from FO CSV" : "ATM determined by equity spot close price"}
                    >
                      {(["futures", "spot"] as const).map(src => (
                        <button
                          key={src}
                          type="button"
                          onClick={() => setOptPriceSource(src)}
                          className={`px-2 text-[10px] font-semibold rounded-sm transition-colors ${
                            optPriceSource === src
                              ? src === "futures" ? "bg-amber-500/80 text-background" : "bg-sky-500/80 text-background"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {src === "futures" ? "FUT" : "SPOT"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </Fragment>
            )}

            {!histories.length && !loading && (
              <p className="text-[11px] text-muted-foreground ml-2">Load NSE bhavcopy CSVs on the Create Scan page first.</p>
            )}
            {histories.length > 0 && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                {filteredHistories.length} symbol{filteredHistories.length !== 1 ? "s" : ""} in scope
              </span>
            )}
          </div>
        </Card>

        {/* ─── Entry Screener ─── */}
        <ScanBuilderPanel
          title={`Entry Screener — ${directionLabel.entry}`}
          filterLabel={directionLabel.entry}
          series={series}
          onChange={(items, lm) => { setEntryItems(items); setEntryLogicMode(lm); }}
          conditionClipboard={conditionClipboard}
          onConditionCopy={setConditionClipboard}
          scanClipboard={scanClipboard}
          onScanCopy={setScanClipboard}
        />

        {/* ─── Strategy Settings ─── */}
        <Card className="shadow-card overflow-hidden">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-muted/10 transition-colors"
            onClick={() => setSettingsOpen(o => !o)}
          >
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-bold tracking-wide text-muted-foreground uppercase">Strategy Settings</span>
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              {settings.stopLoss > 0 && <span>SL {settings.stopLoss}%</span>}
              {settings.target > 0 && <span>TP {settings.target}%</span>}
              {settings.maxHoldingDays > 0 && <span>Max {settings.maxHoldingDays}d</span>}
              {settingsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </span>
          </button>

          {settingsOpen && (
            <div className="px-4 pb-2 border-t border-border grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-1.5 pt-2">
              {/* Capital / Qty */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Capital Mode</label>
                </div>
                <div className="inline-flex rounded-md border border-border bg-input p-0.5">
                  <button type="button" onClick={() => setSettings(s => ({ ...s, useQty: false }))}
                    className={`px-2.5 py-0.5 text-[10px] font-semibold rounded-sm transition-colors ${!settings.useQty ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                    ₹ Capital
                  </button>
                  <button type="button" onClick={() => setSettings(s => ({ ...s, useQty: true }))}
                    className={`px-2.5 py-0.5 text-[10px] font-semibold rounded-sm transition-colors ${settings.useQty ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                    Qty
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  {settings.useQty ? "Qty per Trade" : "Capital per Trade (₹)"}
                </label>
                <NumInput value={settings.useQty ? settings.qty : settings.capital} min={1} max={settings.useQty ? 10000 : 10000000}
                  onChange={n => setSettings(s => settings.useQty ? { ...s, qty: Math.round(n) } : { ...s, capital: n })} className="w-full" />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Entry At</label>
                <Select value={settings.entryExecution} onValueChange={(v) => setSettings(s => ({ ...s, entryExecution: v as StrategySettings["entryExecution"] }))}>
                  <SelectTrigger className="h-7 bg-input text-xs w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="next_open">Next Day Open</SelectItem>
                    <SelectItem value="this_close">Signal Day Close</SelectItem>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel className="text-[10px] text-muted-foreground px-2 py-0.5">↑ Next Day Cross Above (Breakout)</SelectLabel>
                      <SelectItem value="cross_above_prev_high">↑ Cross Above Prev High</SelectItem>
                      <SelectItem value="cross_above_prev_close">↑ Cross Above Prev Close</SelectItem>
                      <SelectItem value="cross_above_prev_low">↑ Cross Above Prev Low</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel className="text-[10px] text-muted-foreground px-2 py-0.5">↓ Next Day Cross Below (Breakdown)</SelectLabel>
                      <SelectItem value="cross_below_prev_high">↓ Cross Below Prev High</SelectItem>
                      <SelectItem value="cross_below_prev_close">↓ Cross Below Prev Close</SelectItem>
                      <SelectItem value="cross_below_prev_low">↓ Cross Below Prev Low</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Stop Loss %</label>
                <NumInput value={settings.stopLoss} min={0} max={100} step={0.1}
                  onChange={n => setSettings(s => ({ ...s, stopLoss: n }))} className="w-full" />
                <p className="text-[9px] text-muted-foreground">0 = disabled</p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Target %</label>
                <NumInput value={settings.target} min={0} max={500} step={0.1}
                  onChange={n => setSettings(s => ({ ...s, target: n }))} className="w-full" />
                <p className="text-[9px] text-muted-foreground">0 = disabled</p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Max Holding (days)</label>
                <NumInput value={settings.maxHoldingDays} min={0} max={365}
                  onChange={n => setSettings(s => ({ ...s, maxHoldingDays: Math.round(n) }))} className="w-full" />
                <p className="text-[9px] text-muted-foreground">0 = unlimited</p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                  Max Concurrent Positions
                </label>
                <NumInput
                  value={settings.maxPositions}
                  min={0}
                  max={500}
                  onChange={n => setSettings(s => ({ ...s, maxPositions: Math.round(n) }))}
                  className="w-full"
                />
                <p className="text-[9px] text-muted-foreground">0 = unlimited</p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Brokerage % (per side)</label>
                <NumInput value={settings.brokerage} min={0} max={5} step={0.01}
                  onChange={n => setSettings(s => ({ ...s, brokerage: n }))} className="w-full" />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Slippage % (per side)</label>
                <NumInput value={settings.slippage} min={0} max={5} step={0.01}
                  onChange={n => setSettings(s => ({ ...s, slippage: n }))} className="w-full" />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Lookback Period (days)</label>
                <NumInput value={lookbackDays} min={10} max={3000}
                  onChange={n => setLookbackDays(Math.round(n))} className="w-full" />
              </div>
            </div>
          )}
        </Card>

        {/* ─── Exit Screener ─── */}
        <ScanBuilderPanel
          title={`Exit Screener — ${directionLabel.exit}`}
          filterLabel={directionLabel.exit}
          series={series}
          defaultLogicMode="all"
          onChange={(items, lm) => { setExitItems(items); setExitLogicMode(lm); }}
          conditionClipboard={conditionClipboard}
          onConditionCopy={setConditionClipboard}
          scanClipboard={scanClipboard}
          onScanCopy={setScanClipboard}
        />

        {/* Exit empty-state hint */}
        {flattenItems(exitItems).filter(c => c.enabled !== false).length === 0 && (
          <p className="text-[11px] text-muted-foreground px-1">
            <AlertTriangle className="h-3 w-3 inline mr-1 text-orange-400" />
            No exit conditions defined — trades will only exit via Stop Loss, Target, Max Holding, or at end of backtest period.
          </p>
        )}

        {/* ─── Run Backtest ─── */}
        <div className="flex justify-end">
          <Button
            onClick={handleRunBacktest}
            disabled={running}
            className="bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-glow h-7 px-3 text-xs"
          >
            {running
              ? <><Loader2 className="h-3 w-3 animate-spin" />Running…</>
              : <><Play className="h-3 w-3 fill-green-400" stroke="black" strokeWidth={2} />Run Backtest</>
            }
          </Button>
        </div>

        {/* ─── Results ─── */}
        {summary && trades && (
          <>
            {/* Summary Metric Cards */}
            <div>
              <h2 className="text-xs font-bold tracking-widest text-muted-foreground uppercase mb-3">
                Backtest Results — {trades.length} Trades over {lookbackDays} Trading Days
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {[
                  { label: "Total Trades", value: String(summary.totalTrades), sub: `${summary.winningTrades}W / ${summary.losingTrades}L`, icon: BarChart3, color: "text-primary" },
                  { label: "Win Rate", value: `${summary.winRate.toFixed(1)}%`, sub: `${summary.winningTrades} winning trades`, icon: Percent, color: summary.winRate >= 50 ? "text-success" : "text-yellow-400" },
                  { label: "Net P&L", value: `₹${summary.netPnl.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, sub: `${summary.totalReturn >= 0 ? "+" : ""}${summary.totalReturn.toFixed(2)}% total return`, icon: IndianRupee, color: summary.netPnl >= 0 ? "text-success" : "text-destructive-bright" },
                  { label: "CAGR", value: `${summary.cagr >= 0 ? "+" : ""}${summary.cagr.toFixed(1)}%`, sub: summary.cagrIsAnnualised ? "Annualised (backtest < 1yr)" : "CAGR (compounded)", icon: TrendingUp, color: summary.cagr >= 0 ? "text-success" : "text-destructive-bright" },
                  { label: "Max Drawdown", value: `-${summary.maxDrawdown.toFixed(1)}%`, sub: "Peak to trough", icon: TrendingDown, color: "text-destructive-bright" },
                  { label: "Profit Factor", value: summary.profitFactor >= 99 ? "∞" : summary.profitFactor.toFixed(2), sub: "Gross profit / gross loss", icon: BarChart3, color: summary.profitFactor >= 1.5 ? "text-success" : summary.profitFactor >= 1 ? "text-primary" : "text-destructive-bright" },
                  { label: "Sharpe Ratio", value: summary.sharpe.toFixed(2), sub: summary.sharpe >= 1 ? "Good risk-adjusted" : summary.sharpe >= 0 ? "Below average" : "Poor", icon: BarChart3, color: summary.sharpe >= 1 ? "text-success" : summary.sharpe >= 0 ? "text-yellow-400" : "text-destructive-bright" },
                  { label: "Avg Profit", value: `₹${summary.avgProfit.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, sub: "Per winning trade", icon: TrendingUp, color: "text-success" },
                  { label: "Avg Loss", value: `₹${summary.avgLoss.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, sub: "Per losing trade", icon: TrendingDown, color: "text-destructive-bright" },
                  { label: "Expectancy", value: `₹${(summary.winRate / 100 * summary.avgProfit - (1 - summary.winRate / 100) * summary.avgLoss).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, sub: "Per trade expected P&L", icon: IndianRupee, color: "text-primary" },
                  { label: "Capital", value: `₹${settings.capital.toLocaleString("en-IN")}`, sub: settings.useQty ? `${settings.qty} shares/trade` : "Per trade", icon: IndianRupee, color: "text-muted-foreground" },
                ].map((c) => (
                  <Card key={c.label} className="p-3 shadow-card text-center hover:shadow-md transition-shadow">
                    <c.icon className={`h-4 w-4 mx-auto mb-1 ${c.color}`} />
                    <p className={`text-base font-bold tabular-nums ${c.color}`}>{c.value}</p>
                    <p className="text-[10px] font-semibold text-foreground mt-0.5">{c.label}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">{c.sub}</p>
                  </Card>
                ))}
              </div>
            </div>

            {/* Equity Curve + Drawdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="p-4 shadow-card">
                <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase mb-3">Equity Curve</h3>
                {summary.equityCurve.length > 1 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={summary.equityCurve} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                      <defs>
                        <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-primary, #3b82f6)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="var(--color-primary, #3b82f6)" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }} tickLine={false} width={70}
                        tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                      <Tooltip content={<EquityTooltip />} />
                      <ReferenceLine y={settings.capital} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 2" />
                      <Area type="monotone" dataKey="equity" stroke="#3b82f6" strokeWidth={2} fill="url(#eqGrad)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-44 flex items-center justify-center text-xs text-muted-foreground">Not enough trades to plot</div>
                )}
              </Card>

              <Card className="p-4 shadow-card">
                <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase mb-3">Drawdown</h3>
                {summary.equityCurve.length > 1 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={summary.equityCurve} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                      <defs>
                        <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#ef4444" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 9, fill: "var(--color-muted-foreground, #888)" }} tickLine={false} width={40}
                        tickFormatter={v => `${v.toFixed(0)}%`} />
                      <Tooltip content={<DrawdownTooltip />} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                      <Area type="monotone" dataKey="drawdown" stroke="#ef4444" strokeWidth={1.5} fill="url(#ddGrad)" dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-44 flex items-center justify-center text-xs text-muted-foreground">Not enough trades to plot</div>
                )}
              </Card>
            </div>

            {/* Monthly Returns Heatmap */}
            {summary.monthlyReturns.length > 0 && (
              <Card className="p-4 shadow-card">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Monthly Returns</h3>
                  <span className="text-[10px] text-muted-foreground">Click a month to filter trades below</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* All Months chip */}
                  <div className="text-center min-w-[52px]">
                    <button
                      type="button"
                      onClick={() => { setSelectedMonth(null); setTradePage(1); }}
                      className={`h-10 w-full rounded-md flex items-center justify-center text-[10px] font-bold transition-all px-2 border-2 ${
                        selectedMonth === null
                          ? "border-primary bg-primary/20 text-primary ring-1 ring-primary"
                          : "border-border bg-muted/30 text-muted-foreground hover:border-primary/50 hover:text-foreground"
                      }`}
                      title="Show all months"
                    >
                      All
                    </button>
                    <p className="text-[9px] text-muted-foreground mt-0.5">All Months</p>
                  </div>

                  {summary.monthlyReturns.map((m) => {
                    const isSelected = selectedMonth === m.key;
                    return (
                      <div key={m.key} className="text-center min-w-[52px]">
                        <button
                          type="button"
                          onClick={() => { setSelectedMonth(isSelected ? null : m.key); setTradePage(1); }}
                          className={`h-10 w-full rounded-md flex items-center justify-center text-[10px] font-bold transition-all px-1 border-2 ${
                            isSelected
                              ? "border-white ring-1 ring-white scale-105 shadow-lg " + (
                                  m.pct > 5 ? "bg-success text-background"
                                  : m.pct > 2 ? "bg-success/70 text-success"
                                  : m.pct > 0 ? "bg-success/40 text-success"
                                  : m.pct > -2 ? "bg-destructive-bright/30 text-destructive-bright"
                                  : m.pct > -5 ? "bg-destructive-bright/60 text-destructive-bright"
                                  : "bg-destructive-bright text-background"
                                )
                              : "border-transparent hover:border-border/60 hover:scale-105 " + (
                                  m.pct > 5 ? "bg-success text-background"
                                  : m.pct > 2 ? "bg-success/60 text-success"
                                  : m.pct > 0 ? "bg-success/25 text-success"
                                  : m.pct > -2 ? "bg-destructive-bright/20 text-destructive-bright"
                                  : m.pct > -5 ? "bg-destructive-bright/50 text-destructive-bright"
                                  : "bg-destructive-bright text-background"
                                )
                          }`}
                          title={`${m.key}: ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(2)}% — click to filter trades`}
                        >
                          {m.pct >= 0 ? "+" : ""}{m.pct.toFixed(1)}%
                        </button>
                        <p className={`text-[9px] mt-0.5 ${isSelected ? "text-foreground font-semibold" : "text-muted-foreground"}`}>{m.label}</p>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* Trade Table */}
            <Card className="shadow-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-muted/20 flex flex-wrap items-center gap-3">
                <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Trade History</h3>
                {selectedMonth && (
                  <button
                    type="button"
                    onClick={() => { setSelectedMonth(null); setTradePage(1); }}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/20 text-primary border border-primary/40 text-[10px] font-semibold hover:bg-primary/30 transition-colors"
                    title="Clear month filter"
                  >
                    {summary?.monthlyReturns.find(m => m.key === selectedMonth)?.label ?? selectedMonth}
                    <X className="h-2.5 w-2.5" />
                  </button>
                )}
                <span className="text-xs text-muted-foreground">
                  {filteredTrades.length} trade{filteredTrades.length !== 1 ? "s" : ""}
                  {tradeSearch && ` matching "${tradeSearch}"`}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                    <Input
                      placeholder="Search symbol or reason…"
                      value={tradeSearch}
                      onChange={(e) => { setTradeSearch(e.target.value); setTradePage(1); }}
                      className="h-7 pl-6 pr-2 text-xs w-44 bg-input"
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={exportTrades} disabled={!trades.length} className="h-7 text-xs px-2">
                    <Download className="h-3 w-3 mr-1" /> CSV
                  </Button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border sticky top-0">
                    <tr>
                      {([
                        ["symbol", "Symbol"], ["entryDate", "Entry Date"], ["exitDate", "Exit Date"],
                        ["entryPrice", "Entry ₹"], ["exitPrice", "Exit ₹"],
                        ["qty", "Qty"], ["pnl", "P&L ₹"], ["returnPct", "Return%"],
                        ["holdingDays", "Days"], ["exitReason", "Exit Reason"],
                      ] as [keyof Trade, string][]).map(([k, lbl]) => (
                        <th key={k} className={`px-3 py-2 cursor-pointer hover:text-foreground select-none ${["entryPrice", "exitPrice", "qty", "pnl", "returnPct", "holdingDays"].includes(k) ? "text-right" : "text-left"}`}
                          onClick={() => toggleTradeSort(k)}>
                          {lbl}<SortIcon k={k} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedTrades.length === 0 ? (
                      <tr><td colSpan={10} className="px-4 py-8 text-center text-xs text-muted-foreground">No trades found</td></tr>
                    ) : pagedTrades.map((t, i) => {
                      const isCopied = t.symbol === lastCopied;
                      return (
                      <tr key={`${t.symbol}-${t.entryDate}-${t.exitDate}-${i}`}
                        className={`border-t border-border/60 transition-colors ${
                          isCopied
                            ? "bg-primary/15 hover:bg-primary/25"
                            : i % 2 === 0 ? "bg-card hover:bg-primary/8" : "bg-muted/30 hover:bg-primary/8"
                        }`}>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="font-semibold text-xs text-foreground">{t.symbol}</span>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); copyTradeSymbol(t.symbol); }}
                              className={`transition-opacity p-0.5 rounded hover:text-primary ${
                                isCopied ? "opacity-100 text-primary" : "text-success/50 hover:text-success"
                              }`}
                              title={`Copy ${t.symbol}`}
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{t.entryDate}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">{t.exitDate}</td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-foreground">{t.entryPrice.toFixed(2)}</td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-foreground">{t.exitPrice.toFixed(2)}</td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-muted-foreground">{t.qty}</td>
                        <td className={`px-3 py-2 text-xs text-right tabular-nums font-semibold ${t.pnl >= 0 ? "text-success" : "text-destructive-bright"}`}>
                          {t.pnl >= 0 ? "+" : ""}₹{Math.abs(t.pnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`px-3 py-2 text-xs text-right tabular-nums font-bold ${t.returnPct >= 0 ? "text-success" : "text-destructive-bright"}`}>
                          {t.returnPct >= 0 ? "+" : ""}{t.returnPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums text-muted-foreground">{t.holdingDays}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                            t.exitReason === "Stop Loss" ? "bg-destructive-bright/15 text-destructive-bright border border-destructive-bright/30"
                            : t.exitReason === "Target" ? "bg-success/15 text-success border border-success/30"
                            : t.exitReason === "Exit Signal" ? "bg-primary/15 text-primary border border-primary/30"
                            : "bg-muted/40 text-muted-foreground border border-border"
                          }`}>{t.exitReason}</span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/10">
                  <span className="text-[11px] text-muted-foreground">
                    Showing {(tradePage - 1) * TRADES_PER_PAGE + 1}–{Math.min(tradePage * TRADES_PER_PAGE, filteredTrades.length)} of {filteredTrades.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={tradePage === 1} onClick={() => setTradePage(1)}>«</Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={tradePage === 1} onClick={() => setTradePage(p => p - 1)}>‹</Button>
                    <span className="text-xs px-2">{tradePage} / {totalPages}</span>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={tradePage === totalPages} onClick={() => setTradePage(p => p + 1)}>›</Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={tradePage === totalPages} onClick={() => setTradePage(totalPages)}>»</Button>
                  </div>
                </div>
              )}
            </Card>

            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 pb-2">
              <AlertTriangle className="h-3 w-3" />
              Past performance does not guarantee future results. Brokerage: {settings.brokerage}% | Slippage: {settings.slippage}% (per side, both applied at entry and exit).
            </div>
          </>
        )}

        {!summary && !running && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            <BarChart3 className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p>Define entry conditions and click <strong>Run Backtest</strong> to see strategy performance.</p>
            <p className="text-xs mt-1 opacity-70">Exit conditions, Stop Loss, Target, and Max Holding Days are all optional.</p>
          </div>
        )}
      </main>
    </div>
  );
}
