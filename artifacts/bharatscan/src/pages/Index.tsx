import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue, SelectSeparator, SelectLabel } from "@/components/ui/select";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Plus, Play, Loader2, ArrowUpDown, ArrowUp, ArrowDown, Download, Save, History, Trash2, BarChart3, Minus, Copy, ClipboardPaste, FolderInput, X, AlertTriangle, Database, Search, Layers, ChevronUp, ChevronDown, Star, Check } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ConditionRow, newCondition, NameModeContext } from "@/components/ConditionRow";
import { FilterGroupBlock, type DragSrc } from "@/components/FilterGroupBlock";
import { LogicModeSelect } from "@/components/LogicModeSelect";
import { BacktestChart } from "@/components/BacktestChart";
import type { SymbolHistory } from "@/lib/csv";
import { supportsDirectoryPicker } from "@/lib/dataLoader";
import { runScan, runBacktest, normalizeCondition, requiredBarsForTf, isGroup, newGroup, flattenItems, type Condition, type ConditionGroup, type FilterItem, type LogicMode, type ScanResult } from "@/lib/screener";
import { SCAN_TEMPLATES, cloneTemplateItems } from "@/lib/scanTemplates";
import { useLocation, useNavigate } from "react-router-dom";
import { listScans, saveScan, deleteScan, getScan, migrateSavedScan, type SavedScan } from "@/lib/savedScans";
import { type UniverseCategory } from "@/lib/universe";
import { buildOptionHistories } from "@/lib/options";
import { toast } from "sonner";
import { useData } from "@/context/DataContext";

type SortKey = "symbol" | "close" | "changePct" | "volume";
type ScanMode = "stocks" | "options";

const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
/** Format a ScanResult's symbol for display.
 *  In options mode (when strike + expiry are present), converts "OIL CE" →
 *  "OIL 26 JUN 405 CE" so the user can identify the exact contract. */
function fmtOptionSymbol(r: Pick<ScanResult, "symbol" | "strike" | "expiry">): string {
  if (!r.strike || !r.expiry) return r.symbol;
  const lastSpace = r.symbol.lastIndexOf(" ");
  const underlying = lastSpace >= 0 ? r.symbol.slice(0, lastSpace) : r.symbol;
  const side = lastSpace >= 0 ? r.symbol.slice(lastSpace + 1) : "";
  const [, mm, dd] = r.expiry.split("-");
  const mon = MONTHS_SHORT[parseInt(mm, 10) - 1] ?? mm;
  const strike = Number.isInteger(r.strike) ? String(r.strike) : r.strike.toFixed(2).replace(/\.?0+$/, "");
  return `${underlying} ${parseInt(dd, 10)} ${mon} ${strike} ${side}`;
}
/** "ALL" = every loaded CSV stock; otherwise a UniverseCategory id. */
const ALL_UNIVERSE_ID = "ALL";

const FAV_UNIVERSE_KEY = "bharatscan:fav-universe-ids";

/** Universe dropdown item with a clickable star that toggles favourites
 *  without selecting the item or closing the dropdown. */
function UniverseItem({
  value,
  label,
  isFav,
  onToggleFav,
}: {
  value: string;
  label: string;
  isFav: boolean;
  onToggleFav: (id: string) => void;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      className="relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-xs outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
    >
      {/* checkmark for the currently selected item */}
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="h-3 w-3" />
        </SelectPrimitive.ItemIndicator>
      </span>

      {/* star button — stops propagation so the item is NOT selected on star click */}
      <button
        type="button"
        title={isFav ? "Remove from favourites" : "Add to favourites"}
        className="mr-1.5 flex-shrink-0 focus:outline-none"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleFav(value); }}
      >
        <Star
          className={`h-3 w-3 transition-colors ${
            isFav
              ? "fill-yellow-400 text-yellow-400"
              : "text-muted-foreground hover:text-yellow-400"
          }`}
        />
      </button>

      {/* only this text appears in the trigger when the item is selected */}
      <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** Find the latest trading date in `histories` that is ≤ `isoDate`.
 *  Used in Historical mode to find the last trading day on or before the
 *  selected date (handles weekends and NSE holidays naturally via data). */
function latestTradingDayOnOrBefore(histories: { bars: { date: string }[] }[], isoDate: string): string | undefined {
  const dates = new Set<string>();
  for (const h of histories) for (const b of h.bars) if (b.date <= isoDate) dates.add(b.date);
  if (!dates.size) return undefined;
  return Array.from(dates).sort().at(-1);
}

/**
 * Small typing-friendly input for the "Backtest N d" field. Uses local text
 * state so the user can fully clear it and retype without a synchronous
 * `parseInt() || 60` fallback hijacking each keystroke (which previously
 * made it impossible to backspace past the first remaining digit). Width
 * grows with the typed text so 3-digit values like 100 aren't truncated.
 * The 5–500 range is enforced only on commit / blur.
 */
function BacktestDaysInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState<string>(String(value));
  useEffect(() => {
    if (parseInt(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const charLen = Math.max(2, text.length);
  return (
    <Input
      type="text"
      inputMode="numeric"
      className="h-9 bg-input text-xs px-2 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      style={{ width: `calc(${charLen}ch + 1.5rem)` }}
      value={text}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        if (!/^\d+$/.test(v.trim())) return;
        const n = parseInt(v);
        if (!isNaN(n) && n >= 5 && n <= 500) onChange(n);
      }}
      onBlur={() => {
        const n = parseInt(text);
        if (isNaN(n) || n < 5 || n > 500) {
          const clamped = isNaN(n) ? 60 : Math.max(5, Math.min(500, n));
          setText(String(clamped));
          onChange(clamped);
        } else {
          setText(String(n));
        }
      }}
    />
  );
}

const Index = () => {
  const { histories, loading, categories, optionsData, dateMode, historicalDate } = useData();
  const location = useLocation();
  const navigate = useNavigate();
  const [filterItems, setFilterItems] = useState<FilterItem[]>([]);
  const [topLogicMode, setTopLogicMode] = useState<LogicMode>("all");
  const [activeDrag, setActiveDrag] = useState<DragSrc | null>(null);
  const [dragOverTopIdx, setDragOverTopIdx] = useState<number | null>(null);
  const [escapeZoneOver, setEscapeZoneOver] = useState(false);
  // Tracks which group's "drop after" zone the cursor is over during a top-level drag.
  const [afterGroupOver, setAfterGroupOver] = useState<number | null>(null);
  const [series, setSeries] = useState<string>("EQ");
  const [results, setResults] = useState<ScanResult[] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("changePct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Symbol of the most recently copied result row. Used to highlight that
  // row so the user can keep track of where they are in the list.
  const [lastCopied, setLastCopied] = useState<string | null>(null);
  const [savedScans, setSavedScans] = useState<SavedScan[]>([]);
  const [scanName, setScanName] = useState("");
  const importScanRef = useRef<HTMLInputElement>(null);
  const templateStripRef = useRef<HTMLDivElement>(null);
  const [nameMode, setNameMode] = useState<"full" | "short">("full");
  const [scanDirection, setScanDirection] = useState<"long" | "short">("long");
  // Tracks which saved scan (if any) is currently loaded so Save can update
  // it in place. Cleared on fresh "+" or paste, set on loadScan / Save As.
  const [loadedScanId, setLoadedScanId] = useState<string | undefined>(undefined);
  const [backtest, setBacktest] = useState<{ date: string; matches: number }[] | null>(null);
  const [backtestDays, setBacktestDays] = useState(60);
  // Per-day "Backtest Results" — driven by the user picking a pillar in the
  // Backtest History bar. Auto-set to the latest day after a backtest runs.
  const [backtestSelectedDate, setBacktestSelectedDate] = useState<string | null>(null);
  const [backtestResults, setBacktestResults] = useState<ScanResult[] | null>(null);
  // Tracks which action (Run Scan vs Backtest) most recently produced output,
  // so we can show the "Results" panel only for scans and the "Backtest
  // History" + "Backtest Results" panels only for backtests.
  const [lastAction, setLastAction] = useState<"scan" | "backtest" | null>(null);
  // Order in which the Backtest History CSV export lists days. "desc" puts the
  // most recent day first; "asc" puts the oldest day first.
  const [historyExportOrder, setHistoryExportOrder] = useState<"asc" | "desc">("desc");
  // Search queries for Results and Backtest Results tables
  const [resultsSearch, setResultsSearch] = useState("");
  const [backtestResultsSearch, setBacktestResultsSearch] = useState("");
  // Day offset for main scan: 0 = latest, -1 = yesterday, -2 = day before, ...
  const [dayOffset, setDayOffset] = useState(0);
  const [running, setRunning] = useState(false);
  const [scanClipboard, setScanClipboard] = useState<{ filterItems: FilterItem[]; topLogicMode: LogicMode; series: string; name: string } | null>(null);
  const [conditionClipboard, setConditionClipboard] = useState<Condition | null>(null);
  // Scan mode (Stocks vs Options) and universe selection.
  // The universe dropdown is dynamic — entries come from whatever the user
  // uploaded via the Master CSV (a flat list of categories).
  const [scanMode, setScanMode] = useState<ScanMode>("stocks");
  const [universeId, setUniverseId] = useState<string>(ALL_UNIVERSE_ID);

  // ── Favourite universes ──────────────────────────────────────────────────────
  const [favIds, setFavIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(FAV_UNIVERSE_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const toggleFavUniverse = useCallback((id: string) => {
    setFavIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(FAV_UNIVERSE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);
  const [optExpiry, setOptExpiry] = useState<string>("");
  const [optOffset, setOptOffset] = useState(0);
  const [optSide, setOptSide] = useState<"CE" | "PE">("CE");
  const [optPriceSource, setOptPriceSource] = useState<"futures" | "spot">("futures");

  // Load saved scans
  useEffect(() => { listScans().then(setSavedScans).catch(() => {}); }, []);

  // Auto-load scan when navigated from Saved Scans page
  // state shape: { scanId: string, scanName?: string }
  const locationStateRef = useRef(
    location.state as { scanId?: string; scanName?: string } | null
  );
  const hasAutoLoadedRef = useRef(false);
  useEffect(() => {
    const state = locationStateRef.current;
    if (!state?.scanId || hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;
    // Set name and ID immediately so Save works even before the fetch resolves
    if (state.scanName) setScanName(state.scanName);
    setLoadedScanId(state.scanId);
    // Fetch full conditions (and authoritative name) from the API
    getScan(state.scanId).then((s) => {
      if (s) loadScan(s);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Candle source is now per-leaf (Regular vs Heikin-Ashi); pass raw histories to scan.

  const seriesList = useMemo(() => {
    const s = new Set<string>();
    histories.forEach((h) => s.add(h.series));
    return Array.from(s).sort();
  }, [histories]);

  // Map UI series selection to actual series codes present in data.
  // EQ -> ["EQ"], ETF -> any series containing "ETF", BOND -> known NSE bond/debt series codes.
  function resolveSeriesFilter(sel: string): string[] | undefined {
    if (sel === "ALL") return undefined;
    if (sel === "EQ") return ["EQ"];
    if (sel === "ETF") return seriesList.filter((s) => /ETF/i.test(s));
    if (sel === "BOND") {
      const bondCodes = new Set(["GB", "GS", "SG", "TB", "Y1", "F1", "FB", "MF", "N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8", "N9", "NA", "NB", "NC", "ND", "NE"]);
      return seriesList.filter((s) => bondCodes.has(s) || /BOND|DEBT|GSEC|GILT/i.test(s));
    }
    return [sel];
  }

  // BUG FIX: In options mode, filteredHistories are already fully filtered by
  // buildOptionHistories (symbol universe + expiry + side). The series field on
  // those synthetic histories is "OPT", not "EQ". Passing resolveSeriesFilter(series)
  // (which returns ["EQ"]) to runScan filters out every option history and gives
  // 0 results even when matches exist. Return undefined in options mode so runScan
  // skips the series gate entirely.
  function activeSeriesFilter(): string[] | undefined {
    if (scanMode === "options") return undefined;
    return resolveSeriesFilter(series);
  }

  // In Options mode the universe dropdown is restricted to the three
  // underlying-style lists (Nifty Indices / Nifty50 / Futures). We match by
  // name (case-insensitive) so it works regardless of slight CSV-header
  // wording differences (e.g. "Nifty 50" vs "Nifty50").
  const OPTIONS_UNIVERSE_NAMES = ["nifty indices", "nifty50", "nifty 50", "futures"];
  const visibleCategories = useMemo<UniverseCategory[]>(() => {
    if (scanMode !== "options") return categories;
    return categories.filter((c) => OPTIONS_UNIVERSE_NAMES.includes(c.name.trim().toLowerCase()));
  }, [categories, scanMode]);

  // When the user switches scan mode, auto-pick the conventional universe for
  // that mode if it's available:
  //   Stocks  → "NSE Cash"
  //   Options → "Nifty50" (falls back to whatever is allowed for Options)
  // Comparison is case-insensitive and tolerates spacing differences
  // ("Nifty 50" vs "Nifty50").
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
    // Intentionally depends on scanMode (and category lists) so the snap
    // happens every time the user toggles between Stocks / Options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanMode, categories, visibleCategories]);

  // Resolve the currently-selected universe category (null = "All Loaded Stocks").
  const activeCategory = useMemo<UniverseCategory | null>(() => {
    if (universeId === ALL_UNIVERSE_ID) return null;
    return categories.find((c) => c.id === universeId) ?? null;
  }, [categories, universeId]);

  // Filter histories by selected mode + universe.
  // Stocks mode: filter spot histories by chosen category (or all loaded).
  // Options mode: synthesize option-leg histories (CE or PE @ chosen
  // expiry/strike) restricted to the chosen underlying category.
  const filteredHistories = useMemo(() => {
    if (scanMode === "options") {
      if (!optionsData || !optExpiry) return [];
      const allow = activeCategory ? new Set(activeCategory.symbols) : null;
      // Pass spot histories for SPOT mode ATM fallback; universe filter is applied
      // inside buildOptionHistories so FUT mode works even without equity data.
      const spotForOptions = allow ? histories.filter((h) => allow.has(h.symbol)) : histories;
      // optOffset is signed: positive = above ATM (OTM for CE, ITM for PE),
      // negative = below ATM (ITM for CE, OTM for PE). Passed directly.
      return buildOptionHistories(
        optionsData, spotForOptions, optExpiry, optSide,
        () => undefined,
        optOffset,
        optPriceSource === "spot",
        allow,
      );
    }
    if (!activeCategory) return histories;
    const allow = new Set(activeCategory.symbols);
    if (allow.size === 0) return [];
    return histories.filter((h) => allow.has(h.symbol));
  }, [histories, scanMode, activeCategory, optionsData, optExpiry, optSide, optOffset, optPriceSource]);

  // Diagnostic counts — shown in the UI when options mode returns 0 results.
  const optsDiag = useMemo(() => {
    if (scanMode !== "options" || !optionsData || !optExpiry) return null;
    const allow = activeCategory ? new Set(activeCategory.symbols) : null;
    const totalBars = optionsData.bars.length;
    const totalFutures = optionsData.futures.length;
    const futKeysSize = optionsData.futuresCloseByKey.size;
    // Count bars matching expiry + side (before universe filter)
    let matchExpirySide = 0;
    // Count distinct symbols after universe filter
    const symSet = new Set<string>();
    for (const b of optionsData.bars) {
      if (b.expiry !== optExpiry || b.type !== optSide) continue;
      matchExpirySide++;
      if (!allow || allow.has(b.symbol)) symSet.add(b.symbol);
    }
    // Sample: first symbol's first date futures/spot lookup
    const spotMap = new Map<string, number>();
    const spotForOpts = allow ? histories.filter(h => allow.has(h.symbol)) : histories;
    for (const h of spotForOpts) for (const b of h.bars) spotMap.set(`${h.symbol}|${b.date}`, b.close);

    let sampleSym = "", sampleDate = "", sampleFut: number | undefined, sampleSpot: number | undefined;
    for (const b of optionsData.bars) {
      if (b.expiry !== optExpiry || b.type !== optSide) continue;
      if (allow && !allow.has(b.symbol)) continue;
      sampleSym = b.symbol; sampleDate = b.date;
      sampleFut = optionsData.futuresCloseByKey.get(`${b.symbol}|${b.date}`);
      sampleSpot = spotMap.get(`${b.symbol}|${b.date}`);
      break;
    }
    return { totalBars, totalFutures, futKeysSize, matchExpirySide, symCount: symSet.size, sampleSym, sampleDate, sampleFut, sampleSpot, histories: filteredHistories.length };
  }, [scanMode, optionsData, optExpiry, optSide, activeCategory, histories, filteredHistories]);

  // Auto-select current (nearest upcoming) expiry when options loaded / mode switched
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

  function runScanNow() {
    if (!filteredHistories.length) {
      toast.error(histories.length ? "No symbols in the selected universe" : "Load CSV data first");
      return;
    }
    setRunning(true);
    setBacktest(null);
    setBacktestSelectedDate(null);
    setBacktestResults(null);
    setLastAction("scan");
    setTimeout(() => {
      try {
        const t0 = performance.now();
        // In Historical mode, cap scan to the last trading day on or before
        // the chosen date (so weekends/holidays roll back to prior Friday).
        const asOfDate = dateMode === "historical"
          ? latestTradingDayOnOrBefore(filteredHistories, historicalDate)
          : undefined;
        const r = runScan(filteredHistories, filterItems, {
          series: activeSeriesFilter(),
          atDailyIdxFromEnd: asOfDate ? 0 : Math.abs(dayOffset),
          asOfDate,
          logicMode: topLogicMode,
        });
        const t1 = performance.now();
        setResults(r);
        const dayLabel = asOfDate ? asOfDate : (dayOffset === 0 ? "latest day" : `day ${dayOffset}`);
        toast.success(`${r.length} matches (${dayLabel}) in ${(t1 - t0).toFixed(0)}ms`);
      } finally { setRunning(false); }
    }, 10);
  }

  function runBacktestNow() {
    if (!filteredHistories.length) {
      toast.error(histories.length ? "No symbols in the selected universe" : "Load CSV data first");
      return;
    }
    setRunning(true);
    setResults(null);
    setLastAction("backtest");
    setTimeout(() => {
      try {
        const t0 = performance.now();
        // Historical mode: cap the backtest window to the last trading day
        // on or before the selected date.
        const asOfDate = dateMode === "historical"
          ? latestTradingDayOnOrBefore(filteredHistories, historicalDate)
          : undefined;
        const r = runBacktest(filteredHistories, filterItems, backtestDays, {
          series: activeSeriesFilter(),
          asOfDate,
          logicMode: topLogicMode,
        });
        const t1 = performance.now();
        setBacktest(r);
        // Auto-select the latest day so the "Backtest Results" panel
        // populates immediately without a second click.
        if (r.length > 0) {
          const latest = r[r.length - 1];
          setBacktestSelectedDate(latest.date);
          const scanRes = runScan(filteredHistories, filterItems, {
            series: activeSeriesFilter(),
            asOfDate: latest.date,
            logicMode: topLogicMode,
          });
          setBacktestResults(scanRes);
        } else {
          setBacktestSelectedDate(null);
          setBacktestResults(null);
        }
        const label = asOfDate ? ` as of ${asOfDate}` : "";
        toast.success(`Backtest ${backtestDays}d${label} in ${(t1 - t0).toFixed(0)}ms`);
      } finally { setRunning(false); }
    }, 10);
  }

  // Pick a specific day from the backtest history bar — recompute the
  // per-symbol "Backtest Results" for that exact day.
  function selectBacktestDay(date: string, _idx: number) {
    if (!backtest) return;
    setBacktestSelectedDate(date);
    if (!filteredHistories.length) {
      setBacktestResults([]);
      return;
    }
    // Use the exact date from the backtest array rather than an offset,
    // so Historical mode always resolves to the correct bar.
    const r = runScan(filteredHistories, filterItems, {
      series: activeSeriesFilter(),
      asOfDate: date,
      logicMode: topLogicMode,
    });
    setBacktestResults(r);
  }

  async function handleSaveScan() {
    const name = scanName.trim();
    if (!name) { toast.error("Give the scan a name"); return; }
    // If a scan is loaded, update that record in place (preserving its id);
    // otherwise create a new one. Renames are allowed via the input field.
    const saved = await saveScan({ id: loadedScanId, name, filterItems, topLogicMode, series, direction: scanDirection });
    setLoadedScanId(saved.id);
    setSavedScans(await listScans());
    toast.success(loadedScanId ? `Updated "${name}"` : `Saved "${name}"`);
  }

  async function handleSaveAsScan() {
    const suggested = scanName.trim() ? `${scanName.trim()} copy` : "New scan";
    const name = window.prompt("Save scan as…", suggested)?.trim();
    if (!name) return;
    // Always create a new id — the originally loaded scan is left untouched.
    const saved = await saveScan({ name, filterItems, topLogicMode, series, direction: scanDirection });
    setLoadedScanId(saved.id);
    setScanName(name);
    setSavedScans(await listScans());
    toast.success(`Saved as "${name}"`);
  }

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

  function loadScan(s: SavedScan) {
    const { filterItems: fi, topLogicMode: lm } = migrateSavedScan(s);
    setFilterItems(fi.map(normalizeFilterItem));
    setTopLogicMode(lm);
    setSeries(s.series);
    setScanName(s.name);
    setLoadedScanId(s.id);
    setScanDirection(s.direction ?? "long");
    setResults(null);
    setBacktest(null);
    setBacktestSelectedDate(null);
    setBacktestResults(null);
    toast.success(`Loaded "${s.name}"`);
  }

  function newBlankScan() {
    setFilterItems([]);
    setTopLogicMode("all");
    setScanName("");
    setLoadedScanId(undefined);
    setResults(null);
    setBacktest(null);
    setBacktestSelectedDate(null);
    setBacktestResults(null);
  }

  async function removeScan(id: string) {
    await deleteScan(id);
    setSavedScans(await listScans());
  }

  function handleExportScan() {
    if (!filterItems.length) { toast.error("No filters to export"); return; }
    const payload: SavedScan = {
      id: loadedScanId ?? Math.random().toString(36).slice(2),
      name: scanName.trim() || "scan",
      filterItems,
      topLogicMode,
      series,
      savedAt: Date.now(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${payload.name}.bharatscan.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported "${payload.name}"`);
  }

  function handleImportScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string);
        // Handle bulk export format: { version: 1, scans: [...] } — take the first scan
        const parsed: SavedScan = (raw?.version === 1 && Array.isArray(raw?.scans) && raw.scans.length > 0)
          ? raw.scans[0]
          : raw;
        if (!parsed.filterItems && !Array.isArray(parsed.conditions)) throw new Error("Invalid scan file");
        const { filterItems: fi, topLogicMode: lm } = migrateSavedScan(parsed);
        const name = parsed.name?.trim() || file.name.replace(/\.(bharatscan\.)?json$/i, "").trim() || "Imported Scan";
        // Load into editor without saving to DB — user can Save explicitly if they want
        setFilterItems(fi.map(normalizeFilterItem));
        setTopLogicMode(lm);
        setSeries(parsed.series ?? "EQ");
        setScanName(name);
        setLoadedScanId(undefined);
        setResults(null);
        setBacktest(null);
        setBacktestSelectedDate(null);
        setBacktestResults(null);
        toast.success(`Imported "${name}" — click Save to keep it`);
      } catch {
        toast.error("Could not read scan file — make sure it's a valid BharatScan export.");
      }
    };
    reader.readAsText(file);
  }

  function exportCsv() {
    if (!results) return;
    const lines = ["Symbol,Date,Close,Change%,Volume,OI"];
    sortedResults.forEach((r) => lines.push([fmtOptionSymbol(r), r.date, r.close, r.changePct.toFixed(2), r.volume, r.oi ?? ""].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scan_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sortedResults = useMemo(() => {
    if (!results) return [];
    const sorted = [...results].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });
    return sorted;
  }, [results, sortKey, sortDir]);

  const filteredSortedResults = useMemo(() => {
    const q = resultsSearch.trim().toUpperCase();
    if (!q) return sortedResults;
    return sortedResults.filter((r) => r.symbol.toUpperCase().includes(q));
  }, [sortedResults, resultsSearch]);

  const filteredBacktestResults = useMemo(() => {
    const q = backtestResultsSearch.trim().toUpperCase();
    if (!q || !backtestResults) return backtestResults ?? [];
    return backtestResults.filter((r) => r.symbol.toUpperCase().includes(q));
  }, [backtestResults, backtestResultsSearch]);

  const requiredWeeklyBars = useMemo(
    () => requiredBarsForTf(filterItems, "weekly"),
    [filterItems]
  );

  // ── Stable drag/copy handlers ─────────────────────────────────────────
  // These don't close over per-item data so they stay stable across renders.
  // This is critical for React.memo on FilterGroupBlock to skip re-renders
  // during drag-state updates that only affect other groups.
  const handleInnerDragEnd = useCallback(() => {
    setActiveDrag(null);
    setDragOverTopIdx(null);
    setAfterGroupOver(null);
  }, []);

  // Non-passive wheel listener so we can redirect vertical scroll → horizontal
  // on the template strip (React synthetic onWheel is passive, can't preventDefault).
  useEffect(() => {
    const el = templateStripRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const handleCopyCondition = useCallback((c: Condition) => {
    setConditionClipboard({ ...c });
    toast.success("Filter copied");
  }, []);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "symbol" ? "asc" : "desc"); }
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="container py-1.5 space-y-2">
        {/* Filters */}
        <Card className="py-3 px-8 shadow-card">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Stock Screener</h2>
              <span className="text-[10px] text-muted-foreground/60">
                <span className="font-semibold text-accent/70">100% local.</span> Your CSVs never leave the browser. Built for years of NSE bhavcopy data.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Series</span>
              <Select value={series} onValueChange={setSeries}>
                <SelectTrigger className="w-auto h-6 bg-input text-xs px-2"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">ALL</SelectItem>
                  <SelectItem value="EQ">EQ</SelectItem>
                  <SelectItem value="ETF">ETF</SelectItem>
                  <SelectItem value="BOND">Bond</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Mode + Universe in a single row.
              Mode = Stocks | Options. Universe = dropdown of categories
              loaded from the All Watchlist CSV (plus an "All Loaded Stocks"
              entry that means "every loaded equity"). */}
          <div className="flex flex-wrap items-center gap-2 mb-2 py-0.5 pr-1 pl-3 rounded-lg border border-border bg-secondary/30">
            <span className="text-xs text-muted-foreground font-medium pr-1">Mode:</span>
            <div className="inline-flex rounded border border-border bg-input p-px">
              {([
                { v: "stocks", l: "Stocks" },
                { v: "options", l: "Options" },
              ] as { v: ScanMode; l: string }[]).map((m) => (
                <button
                  key={m.v}
                  type="button"
                  onClick={() => setScanMode(m.v)}
                  className={`px-2 py-px text-xs font-semibold rounded-sm transition-colors ${
                    scanMode === m.v
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  title={m.v === "stocks" ? "Scan equities" : "Scan option legs (CE / PE)"}
                >
                  {m.l}
                </button>
              ))}
            </div>

            <span className="mx-1 h-4 w-px bg-border" />

            <span className="text-xs text-muted-foreground font-medium pr-1">Universe:</span>
            <Select value={universeId} onValueChange={setUniverseId}>
              <SelectTrigger className="w-auto min-w-[100px] max-w-[320px] h-6 bg-input text-xs">
                <SelectValue placeholder="Pick a universe…" />
              </SelectTrigger>
              <SelectContent>
                {/* ── Favourites group — always at the top ── */}
                {visibleCategories.filter((c) => favIds.has(c.id)).length > 0 && (
                  <>
                    <SelectGroup>
                      <SelectLabel className="py-1 pl-8 pr-2 text-[10px] uppercase tracking-wider text-yellow-400 font-semibold">
                        ★ Favourites
                      </SelectLabel>
                      {visibleCategories
                        .filter((c) => favIds.has(c.id))
                        .map((c) => (
                          <UniverseItem
                            key={`fav-${c.id}`}
                            value={c.id}
                            label={`${c.name}${c.symbols.length ? ` (${c.symbols.length})` : ""}`}
                            isFav={true}
                            onToggleFav={toggleFavUniverse}
                          />
                        ))}
                    </SelectGroup>
                    <SelectSeparator />
                  </>
                )}

                {/* ── All Loaded Stocks (Stocks mode only) ── */}
                {scanMode === "stocks" && (
                  <SelectItem value={ALL_UNIVERSE_ID}>
                    All Loaded Stocks{histories.length ? ` (${histories.length})` : ""}
                  </SelectItem>
                )}

                {/* ── Remaining (non-favourite) categories ── */}
                {visibleCategories
                  .filter((c) => !favIds.has(c.id))
                  .map((c) => (
                    <UniverseItem
                      key={c.id}
                      value={c.id}
                      label={`${c.name}${c.symbols.length ? ` (${c.symbols.length})` : ""}`}
                      isFav={false}
                      onToggleFav={toggleFavUniverse}
                    />
                  ))}
              </SelectContent>
            </Select>

            {categories.length === 0 && (
              <span className="text-[11px] text-muted-foreground ml-1">
                Upload an All Watchlist CSV (in the Stocks Data Source card) to load named universes.
              </span>
            )}
            {scanMode === "options" && categories.length > 0 && visibleCategories.length === 0 && (
              <span className="text-[11px] text-destructive-bright ml-1">
                Your CSV doesn't contain Nifty Indices, Nifty50, or Futures lists.
              </span>
            )}

            {/* Options sub-controls — inline in the same row, same as Strategies Backtest */}
            {scanMode === "options" && optionsData && (
              <Fragment>
                <span className="mx-1 h-5 w-px bg-border" />
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Side</span>
                    <div className="inline-flex rounded-md border border-border bg-input p-0.5 h-8">
                      {(["CE", "PE"] as const).map((s) => (
                        <button key={s} type="button" onClick={() => setOptSide(s)}
                          className={`px-2.5 text-[11px] font-semibold rounded-sm transition-colors ${optSide === s ? (s === "CE" ? "bg-success text-background" : "bg-destructive-bright text-background") : "text-muted-foreground hover:text-foreground"}`}
                          title={s === "CE" ? "Call option" : "Put option"}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Expiry</span>
                    <Select value={optExpiry} onValueChange={setOptExpiry}>
                      <SelectTrigger className="w-[130px] h-8 bg-input text-xs"><SelectValue placeholder="Pick expiry" /></SelectTrigger>
                      <SelectContent>
                        {Array.from(new Set(Array.from(optionsData.expiriesBySymbol.values()).flat())).sort().map((e) => (
                          <SelectItem key={e} value={e}>{e}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Strike</span>
                    <div className="flex items-center gap-1.5">
                      <div className="flex flex-col gap-px">
                        <button type="button" onClick={() => setOptOffset((o) => o + 1)}
                          className="flex items-center justify-center w-5 h-[15px] rounded-t-sm border border-border bg-input hover:bg-accent transition-colors">
                          <ChevronUp className="h-2.5 w-2.5" />
                        </button>
                        <button type="button" onClick={() => setOptOffset((o) => o - 1)}
                          className="flex items-center justify-center w-5 h-[15px] rounded-b-sm border border-border bg-input hover:bg-accent transition-colors">
                          <ChevronDown className="h-2.5 w-2.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1 px-2.5 h-8 rounded-md border border-border bg-input min-w-[64px]">
                        <span className={`text-[11px] font-bold ${
                          optOffset === 0 ? "text-primary"
                            : (optSide === "CE" ? optOffset > 0 : optOffset < 0) ? "text-fuchsia-400"
                            : "text-success"
                        }`}>
                          {optOffset === 0 ? "ATM"
                            : optSide === "CE" ? (optOffset > 0 ? "OTM" : "ITM")
                            : (optOffset < 0 ? "OTM" : "ITM")}
                        </span>
                        {optOffset !== 0 && (
                          <span className="text-[10px] font-mono text-muted-foreground">
                            {optOffset > 0 ? `+${optOffset}` : optOffset}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">ATM Ref</span>
                    <div
                      className="inline-flex rounded-md border border-border bg-input p-0.5 h-8"
                      title={optPriceSource === "futures" ? "ATM determined by Futures close price from FO CSV" : "ATM determined by equity spot close price"}
                    >
                      {(["futures", "spot"] as const).map((src) => (
                        <button
                          key={src}
                          type="button"
                          onClick={() => setOptPriceSource(src)}
                          className={`px-2 text-[11px] font-semibold rounded-sm transition-colors ${
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
            {scanMode === "options" && !optionsData && (
              <Fragment>
                <span className="mx-1 h-5 w-px bg-border" />
                <span className="text-[11px] text-muted-foreground">
                  Upload options CSVs in the Options Data Source panel above to enable CE/PE scanning.
                </span>
              </Fragment>
            )}
          </div>

          {/* ── Options diagnostic strip ───────────────────────────────────── */}
          {scanMode === "options" && optionsData && optsDiag && (
            <div className="mt-1 mb-1 px-2 py-1 rounded bg-muted/30 border border-border/40 text-[10px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5">
              <span>Option bars: <b className="text-foreground">{optsDiag.totalBars.toLocaleString()}</b></span>
              <span>Futures rows: <b className="text-foreground">{optsDiag.totalFutures.toLocaleString()}</b></span>
              <span>Fut price keys: <b className="text-foreground">{optsDiag.futKeysSize.toLocaleString()}</b></span>
              <span>{optSide} bars for expiry: <b className="text-foreground">{optsDiag.matchExpirySide.toLocaleString()}</b></span>
              <span>Symbols in universe: <b className="text-foreground">{optsDiag.symCount}</b></span>
              <span>Histories built: <b className={optsDiag.histories > 0 ? "text-success" : "text-destructive-bright"}>{optsDiag.histories}</b></span>
              {optsDiag.sampleSym && (
                <span>
                  Sample [{optsDiag.sampleSym} {optsDiag.sampleDate}]:
                  fut=<b className={optsDiag.sampleFut !== undefined ? "text-success" : "text-destructive-bright"}>{optsDiag.sampleFut ?? "–"}</b>
                  {" "}spot=<b className={optsDiag.sampleSpot !== undefined ? "text-success" : "text-destructive-bright"}>{optsDiag.sampleSpot ?? "–"}</b>
                </span>
              )}
            </div>
          )}

          <div className="rounded-lg border border-border bg-secondary/20 p-2.5">
            {/* ── Template strip — always visible ────────────────────── */}
            <div className="flex items-center gap-1.5 mb-2">
              <span className="shrink-0 text-[10px] text-muted-foreground/50 select-none">Templates:</span>
              <div className="relative flex-1 min-w-0">
              <div
                ref={templateStripRef}
                className="overflow-x-auto"
                style={{ scrollbarWidth: "none", msOverflowStyle: "none" } as React.CSSProperties}
              >
                <div className="flex items-center gap-1 flex-nowrap min-w-max pb-0.5">
                  {SCAN_TEMPLATES.map(t => (
                    <button
                      key={t.name}
                      type="button"
                      title={`Add "${t.name}" conditions`}
                      className="flex items-center gap-0.5 h-5 px-1.5 rounded text-[10px] bg-white/5 hover:bg-white/[0.12] text-muted-foreground hover:text-white border border-white/[0.08] transition-colors whitespace-nowrap cursor-pointer"
                      onClick={() => {
                        setFilterItems(prev => [...prev, ...cloneTemplateItems(t.items)]);
                        toast.success(`Added "${t.name}"`);
                      }}
                    >
                      <span className="text-[9px] leading-none">{t.icon}</span>
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
              {/* right-edge fade — hints more content is scrollable */}
              <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-secondary/80 to-transparent" />
              </div>{/* end relative flex-1 */}
            </div>{/* end Templates row */}
            {filterItems.length > 0 && (
              <>
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Create Scanner
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setScanClipboard({ filterItems: cloneFilterItems(filterItems), topLogicMode, series, name: scanName });
                      toast.success(`Copied scan (${flattenItems(filterItems).length} filter${flattenItems(filterItems).length === 1 ? "" : "s"})`);
                    }}
                    title="Copy this entire scan"
                    className="inline-flex items-center px-1.5 py-0.5 text-xs font-bold rounded bg-success text-background hover:opacity-90 transition-opacity"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  <div className="ml-auto flex items-center gap-3">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Names</span>
                      <div className="inline-flex rounded-md border border-border bg-input p-[1px]">
                        {(["full", "short"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setNameMode(m)}
                            className={`px-1.5 py-px text-[9px] font-semibold rounded-sm transition-colors ${
                              nameMode === m
                                ? m === "full"
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:text-foreground"
                            }`}
                          >
                            {m === "full" ? "Full" : "Short"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setFilterItems([]);
                        setTopLogicMode("all");
                        setScanName("");
                        setLoadedScanId(undefined);
                        setScanDirection("long");
                        setResults(null);
                        setBacktest(null);
                        setBacktestSelectedDate(null);
                        setBacktestResults(null);
                        setLastAction(null);
                      }}
                      title="New scan — clear everything"
                      className="self-end flex items-center justify-center rounded-md text-orange-400 hover:text-orange-300 hover:bg-orange-400/10 transition-colors p-0.5"
                    >
                      <X className="h-4 w-4" strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-2">
                  <span>Stock passes</span>
                  <LogicModeSelect value={topLogicMode} onChange={setTopLogicMode} />
                  <span>of the below filters</span>
                  {/* Long / Short purpose tag — visual only, saved with scan */}
                  <div className="inline-flex rounded border border-border bg-input p-px ml-1">
                    {(["long", "short"] as const).map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setScanDirection(d)}
                        className={`px-1.5 py-px text-[9px] font-semibold rounded-sm transition-colors ${
                          scanDirection === d
                            ? d === "long"
                              ? "bg-success text-background"
                              : "bg-destructive text-destructive-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                        title={d === "long" ? "Buy / Long scan" : "Sell / Short scan"}
                      >
                        {d === "long" ? "Long" : "Short"}
                      </button>
                    ))}
                  </div>
                  {loadedScanId && scanName && (
                    <span className="ml-1 text-foreground">— editing <span className="font-medium">"{scanName}"</span></span>
                  )}
                </div>
                <NameModeContext.Provider value={nameMode}>
                <div className="space-y-1">
                  {filterItems.map((item, i) => {
                    if (isGroup(item)) {
                      const activeDragIsGroup = !!(activeDrag?.kind === "top" && isGroup(filterItems[activeDrag.idx]));
                      return (
                        <Fragment key={item.id}>
                        <FilterGroupBlock
                          group={item}
                          onChange={(updated) => setFilterItems(prev => prev.map(x => x.id === item.id ? updated : x))}
                          onDelete={() => setFilterItems(prev => prev.filter(x => x.id !== item.id))}
                          onToggle={() => setFilterItems(prev => prev.map(x => x.id === item.id ? { ...x, enabled: (x as ConditionGroup).enabled !== false ? false : true } : x))}
                          conditionClipboard={conditionClipboard}
                          onCopyCondition={handleCopyCondition}
                          isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                          isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                          topIdx={i}
                          activeDrag={activeDrag}
                          activeDragIsGroup={activeDragIsGroup}
                          onDropOnGroup={(src) => {
                            setFilterItems(prev => {
                              const next = [...prev];
                              const thisIdx = next.findIndex(x => x.id === item.id);
                              if (thisIdx < 0) return prev;
                              if (src.kind === "top") {
                                const sourceItem = prev[src.idx];
                                if (!isGroup(sourceItem)) {
                                  const [condition] = next.splice(src.idx, 1);
                                  const adjustedIdx = src.idx < thisIdx ? thisIdx - 1 : thisIdx;
                                  const grp = next[adjustedIdx] as ConditionGroup;
                                  next[adjustedIdx] = { ...grp, conditions: [...grp.conditions, condition as Condition] };
                                } else {
                                  if (src.idx === thisIdx) return prev;
                                  const [moved] = next.splice(src.idx, 1);
                                  next.splice(thisIdx, 0, moved);
                                }
                              } else if (src.kind === "inner" && src.topIdx !== thisIdx) {
                                const srcGrp = next[src.topIdx] as ConditionGroup;
                                const srcConds = [...srcGrp.conditions];
                                const [movedCond] = srcConds.splice(src.condIdx, 1);
                                next[src.topIdx] = { ...srcGrp, conditions: srcConds };
                                const tgtGrp = next[thisIdx] as ConditionGroup;
                                next[thisIdx] = { ...tgtGrp, conditions: [...tgtGrp.conditions, movedCond] };
                              }
                              return next;
                            });
                            setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null);
                          }}
                          onInnerDragStart={(condIdx) => setActiveDrag({ kind: "inner", topIdx: i, condIdx })}
                          onInnerDragEnd={handleInnerDragEnd}
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
                                // should bubble up to the FilterGroupBlock's outer onDrop
                                // which will add them inside the group.
                                setFilterItems(prev => {
                                  if (!isGroup(prev[src.idx])) return prev;
                                  const next = [...prev];
                                  const [moved] = next.splice(src.idx, 1);
                                  next.splice(i, 0, moved);
                                  return next;
                                });
                                e.stopPropagation();
                              } catch {}
                              setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null);
                            },
                            onDragEnd: handleInnerDragEnd,
                          }}
                        />
                        {/* Thin drop zone below the group — lets users position items AFTER the
                            group without accidentally dropping into it. Only visible during a
                            top-level drag so it doesn't clutter the normal layout. */}
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
                                // After removal the group is at i-1 if src was above, else i.
                                const insertAt = src.idx < i ? i : i + 1;
                                next.splice(insertAt, 0, moved);
                                setFilterItems(next);
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
                        onChange={(nc) => setFilterItems(filterItems.map((x, j) => (j === i ? nc : x)))}
                        onRemove={() => setFilterItems(filterItems.filter((_, j) => j !== i))}
                        onCopy={() => { setConditionClipboard({ ...c }); toast.success("Filter copied"); }}
                        onDuplicate={() => {
                          const clone = { ...c, id: Math.random().toString(36).slice(2) };
                          const next = [...filterItems];
                          next.splice(i + 1, 0, clone);
                          setFilterItems(next);
                        }}
                        onToggle={() => setFilterItems(filterItems.map((x, j) => j === i ? { ...x, enabled: (x as typeof c).enabled === false ? true : false } : x))}
                        isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                        isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                        dragPush={
                          activeDrag?.kind === "top" && activeDrag.idx !== i && dragOverTopIdx !== null
                            ? (activeDrag.idx < i && i <= dragOverTopIdx ? "up"
                              : activeDrag.idx > i && i >= dragOverTopIdx ? "down"
                              : undefined)
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
                            setFilterItems(next);
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
                        setFilterItems(next);
                      } catch {}
                      setActiveDrag(null); setDragOverTopIdx(null);
                    }}
                  >
                    {escapeZoneOver ? "↑ Release to move to main filter list" : "Drag here to move filter out of group"}
                  </div>
                )}
                </NameModeContext.Provider>
              </>
            )}
            <div className={`flex items-center gap-1.5${filterItems.length > 0 ? " mt-2 pt-2 border-t border-border/50" : ""}`}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className={`h-6 px-2 text-xs ${filterItems.length === 0 ? "text-green-500" : "text-white"}`}>
                    <Plus className="h-3 w-3" /> {filterItems.length === 0 ? "Create" : "Add"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="text-xs">
                  <DropdownMenuItem onClick={() => setFilterItems([...filterItems, newCondition()])}>
                    <Plus size={13} className="mr-2" /> Add Condition
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setFilterItems([...filterItems, newGroup()])}>
                    <Layers size={13} className="mr-2" /> Add Sub-Filter Group
                  </DropdownMenuItem>
                  {conditionClipboard && (
                    <DropdownMenuItem onClick={() => {
                      setFilterItems([...filterItems, { ...conditionClipboard, id: crypto.randomUUID() }]);
                      toast.success("Filter pasted");
                    }}>
                      <ClipboardPaste size={13} className="mr-2" /> Paste Filter
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={!scanClipboard && !conditionClipboard}
                title={
                  scanClipboard
                    ? "Paste copied scan (replaces current filters)"
                    : conditionClipboard
                    ? "Paste copied filter (appends to list)"
                    : "Nothing copied yet"
                }
                onClick={() => {
                  if (scanClipboard) {
                    setFilterItems(cloneFilterItems(scanClipboard.filterItems));
                    setTopLogicMode(scanClipboard.topLogicMode);
                    setSeries(scanClipboard.series);
                    if (scanClipboard.name) setScanName(scanClipboard.name);
                    toast.success("Pasted scan");
                  } else if (conditionClipboard) {
                    setFilterItems([...filterItems, { ...conditionClipboard, id: crypto.randomUUID() }]);
                    toast.success("Filter pasted");
                  }
                }}
              >
                <ClipboardPaste className="h-4 w-4" /> Paste
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-1 items-center">
            <div className="flex items-center gap-1">
              <Input
                placeholder="Scan name…"
                value={scanName}
                onChange={(e) => setScanName(e.target.value)}
                className="h-7 w-36 bg-input text-xs"
              />
              <Button variant="outline" size="sm" onClick={handleSaveScan} disabled={!scanName.trim()}
                className="h-7 px-2 text-xs"
                title={loadedScanId ? "Update the loaded scan in place" : "Save as a new scan"}>
                <Save className="h-3 w-3" /> Save
              </Button>
              <Button variant="outline" size="sm" onClick={handleSaveAsScan}
                className="h-7 px-2 text-xs"
                title="Save a copy under a new name (original untouched)">
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
              <Button variant="outline" size="sm" onClick={handleExportScan} disabled={!filterItems.length}
                className="h-7 px-2 text-xs"
                title="Download this scan as a .json file to your computer">
                <Download className="h-3 w-3" /> Export
              </Button>
              <Button variant="outline" size="sm" onClick={() => importScanRef.current?.click()}
                className="h-7 px-2 text-xs"
                title="Load a scan from a .json file on your computer">
                <FolderInput className="h-3 w-3" /> Import
              </Button>
              <input ref={importScanRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportScanFile} />
            </div>

            <div className="flex items-center gap-1 ml-auto">
              <span className="text-xs text-muted-foreground">Backtest</span>
              <BacktestDaysInput value={backtestDays} onChange={setBacktestDays} />
              <span className="text-xs text-muted-foreground">d</span>
              <Button
                variant="outline"
                size="sm"
                onClick={runBacktestNow}
                disabled={running}
                className={`h-7 px-2 text-xs ${backtest ? "bg-primary/15 text-primary border-primary/50 hover:bg-primary/25 hover:text-primary" : ""}`}
                title={backtest ? "Backtest active — click to re-run for the current settings" : "Run backtest over the last N days"}
              >
                {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <BarChart3 className="h-3 w-3" />} Backtest
              </Button>
              <Button onClick={runScanNow} disabled={running} className="h-7 px-3 text-xs bg-gradient-primary text-primary-foreground hover:opacity-90 shadow-glow">
                {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3 fill-green-400" stroke="black" strokeWidth={2} />} Run Scan
              </Button>
            </div>
          </div>

          {localStorage.getItem("bharatscan:show-saved-scans") === "true" && savedScans.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border">
              <div className="flex items-center gap-2 mb-2">
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

        {lastAction === "backtest" && backtest && (
          <Card className="p-5 shadow-card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Backtest History <span className="text-foreground">({backtest.length} days)</span>
              </h2>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  Total matches: <span className="text-foreground font-semibold">{backtest.reduce((s, d) => s + d.matches, 0)}</span>
                </span>
                <div className="flex items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!backtest.length || running}
                    className="rounded-r-none border-r-0"
                    onClick={() => {
                      if (!backtest.length) return;
                      // Re-run the scan for every day in the backtest window so the CSV
                      // contains every matching symbol per date (not just match counts).
                      // Column order mirrors the Backtest Results table:
                      //   Symbol, Date, Close, Change %, Volume.
                      const seriesFilter = activeSeriesFilter();
                      const indices = backtest.map((_, i) => i);
                      // "desc" => most recent day first; "asc" => oldest first.
                      const ordered = historyExportOrder === "desc" ? [...indices].reverse() : indices;
                      const lines: string[] = [];
                      lines.push(["Symbol", "Date", "Close", "Change %", "Volume", "OI"].join(","));
                      for (const i of ordered) {
                        const dayRows = runScan(filteredHistories, filterItems, {
                          series: seriesFilter,
                          asOfDate: backtest[i].date,
                          logicMode: topLogicMode,
                        });
                        for (const r of dayRows) {
                          lines.push([fmtOptionSymbol(r), r.date, r.close, r.changePct.toFixed(2), r.volume, r.oi ?? ""].join(","));
                        }
                      }
                      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = `backtest_history_${backtest[0].date}_to_${backtest[backtest.length - 1].date}.csv`;
                      a.click();
                      URL.revokeObjectURL(a.href);
                    }}
                  >
                    <Download className="h-4 w-4" /> Export CSV
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!backtest.length || running}
                        className="rounded-l-none px-2"
                        title={historyExportOrder === "desc" ? "Newest day first" : "Oldest day first"}
                        aria-label="Choose CSV row order"
                      >
                        {historyExportOrder === "desc" ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setHistoryExportOrder("asc")}>
                        <ArrowUp className="h-4 w-4 mr-2" /> Oldest first
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setHistoryExportOrder("desc")}>
                        <ArrowDown className="h-4 w-4 mr-2" /> Newest first
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
            <BacktestChart
              data={backtest}
              selectedDate={backtestSelectedDate}
              onSelect={selectBacktestDay}
            />
          </Card>
        )}

        {/* Backtest Results — driven by the selected pillar in the chart above. */}
        {lastAction === "backtest" && backtest && backtestResults && backtestSelectedDate && (
          <Card className="p-5 shadow-card">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Backtest Results <span className="text-foreground">({filteredBacktestResults.length}{backtestResultsSearch.trim() ? ` of ${backtestResults.length}` : ""})</span>
              </h2>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input
                    placeholder="Search symbol…"
                    value={backtestResultsSearch}
                    onChange={(e) => setBacktestResultsSearch(e.target.value)}
                    className="h-7 pl-6 pr-2 text-xs w-44 bg-input rounded-full"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!backtestResults.length}
                  onClick={() => {
                    if (!backtestResults.length) return;
                    const lines: string[] = [];
                    lines.push(["Symbol", "Date", "Close", "Change %", "Volume", "OI"].join(","));
                    backtestResults.forEach((r) =>
                      lines.push([fmtOptionSymbol(r), r.date, r.close, r.changePct.toFixed(2), r.volume, r.oi ?? ""].join(","))
                    );
                    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = `backtest_${backtestSelectedDate}.csv`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                  }}
                >
                  <Download className="h-4 w-4" /> Export CSV
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-4">{backtestSelectedDate}</p>

            {backtestResults.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No symbols matched on {backtestSelectedDate}.
              </p>
            ) : filteredBacktestResults.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No symbols match your search.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground sticky top-0 z-10 border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3">Symbol</th>
                      <th className="text-left px-4 py-3">Close</th>
                      <th className="text-left px-4 py-3">% Change</th>
                      <th className="text-left px-4 py-3">Volume</th>
                      <th className="text-left px-4 py-3">OI</th>
                      <th className="text-left px-4 py-3">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBacktestResults.slice(0, 500).map((r, idx) => {
                      const isLastCopied = r.symbol === lastCopied;
                      return (
                        <tr
                          key={r.symbol}
                          className={`border-t border-border/60 transition-colors ${
                            isLastCopied
                              ? "bg-primary/15 hover:bg-primary/25"
                              : idx % 2 === 0
                              ? "bg-card hover:bg-primary/8"
                              : "bg-muted/30 hover:bg-primary/8"
                          }`}
                        >
                          <td className="px-4 py-1.5 font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {fmtOptionSymbol(r)}
                              {r.dailyBars < 252 && (
                                <span
                                  title={`Only ~${r.dailyBars} days of CSV history (~${Math.round(r.dailyBars / 21)} months). Indicators may differ from platforms with longer history.`}
                                  className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30 leading-tight"
                                >
                                  ~{Math.round(r.dailyBars / 21)}mo
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const markCopied = () => setLastCopied(r.symbol);
                                  const displaySym = fmtOptionSymbol(r);
                                  try {
                                    await navigator.clipboard.writeText(displaySym);
                                    markCopied();
                                    toast.success(`Copied ${displaySym}`);
                                  } catch {
                                    const ta = document.createElement("textarea");
                                    ta.value = displaySym;
                                    ta.style.position = "fixed";
                                    ta.style.opacity = "0";
                                    document.body.appendChild(ta);
                                    ta.select();
                                    try { document.execCommand("copy"); markCopied(); toast.success(`Copied ${displaySym}`); }
                                    catch { toast.error("Copy failed"); }
                                    document.body.removeChild(ta);
                                  }
                                }}
                                title={`Copy "${fmtOptionSymbol(r)}" to clipboard`}
                                aria-label={`Copy ${fmtOptionSymbol(r)}`}
                                className={`transition-opacity p-0.5 rounded hover:text-primary ${
                                  isLastCopied ? "opacity-100 text-primary" : "text-success/50 hover:text-success"
                                }`}
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </span>
                          </td>
                          <td className="px-4 py-1.5 tabular-nums">{r.close.toFixed(2)}</td>
                          <td className={`px-4 py-1.5 tabular-nums font-medium ${r.changePct >= 0 ? "text-success" : "text-destructive-bright"}`}>
                            {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%
                          </td>
                          <td className="px-4 py-1.5 tabular-nums text-muted-foreground">{r.volume.toLocaleString()}</td>
                          <td className="px-4 py-1.5 tabular-nums text-muted-foreground">{r.oi != null ? r.oi.toLocaleString() : "—"}</td>
                          <td className="px-4 py-1.5 text-muted-foreground">{r.date}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredBacktestResults.length > 500 && (
                  <p className="text-xs text-muted-foreground p-3 text-center border-t border-border">
                    Showing top 500 of {filteredBacktestResults.length}. Export CSV for the full list.
                  </p>
                )}
              </div>
            )}
          </Card>
        )}

        {/* Results */}
        {lastAction === "scan" && results && (
          <Card className="py-3 px-8 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
                Results <span className="text-foreground">({filteredSortedResults.length}{resultsSearch.trim() ? ` of ${results.length}` : ""})</span>
              </h2>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input
                    placeholder="Search symbol…"
                    value={resultsSearch}
                    onChange={(e) => setResultsSearch(e.target.value)}
                    className="h-7 pl-6 pr-2 text-xs w-44 bg-input rounded-full"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={exportCsv} disabled={!results.length}>
                  <Download className="h-4 w-4" /> Export CSV
                </Button>
              </div>
            </div>

            {requiredWeeklyBars > 0 && results.some(r => r.weeklyBars < requiredWeeklyBars) && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-400 mb-3">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  Weekly conditions need at least <strong>{requiredWeeklyBars} weekly bars</strong> (~{Math.ceil(requiredWeeklyBars / 4.3)} months of data).{" "}
                  {results.filter(r => r.weeklyBars < requiredWeeklyBars).length} result(s) marked with ⚠ may be unreliable due to insufficient history.
                </span>
              </div>
            )}

            {results.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No symbols matched these filters.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground sticky top-0 z-10 border-b border-border">
                    <tr>
                      {([
                        { k: "symbol", l: "Symbol" },
                        { k: "close", l: "Close" },
                        { k: "changePct", l: "% Change" },
                        { k: "volume", l: "Volume" },
                      ] as { k: SortKey; l: string }[]).map((c) => (
                        <th key={c.k} className="text-left px-4 py-1.5 cursor-pointer hover:text-foreground" onClick={() => toggleSort(c.k)}>
                          <span className="inline-flex items-center gap-1">{c.l} <ArrowUpDown className="h-3 w-3 opacity-50" /></span>
                        </th>
                      ))}
                      <th className="text-left px-4 py-1.5">OI</th>
                      <th className="text-left px-4 py-1.5">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSortedResults.slice(0, 500).map((r, idx) => {
                      const isLastCopied = r.symbol === lastCopied;
                      return (
                      <tr
                        key={r.symbol}
                        className={`border-t border-border/60 transition-colors ${
                          isLastCopied
                            ? "bg-primary/15 hover:bg-primary/25"
                            : idx % 2 === 0
                            ? "bg-card hover:bg-primary/8"
                            : "bg-muted/30 hover:bg-primary/8"
                        }`}
                      >
                        <td className="px-4 py-1.5 font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {requiredWeeklyBars > 0 && r.weeklyBars < requiredWeeklyBars && (
                              <span title={`Only ~${r.weeklyBars} weekly bars — needs ${requiredWeeklyBars} for reliable results`}>
                                <AlertTriangle className="h-3 w-3 text-yellow-400 shrink-0" />
                              </span>
                            )}
                            {fmtOptionSymbol(r)}
                            {r.dailyBars < 252 && (
                              <span
                                title={`Only ~${r.dailyBars} days of CSV history (~${Math.round(r.dailyBars / 21)} months). Indicators may differ from platforms with longer history.`}
                                className="inline-flex items-center px-1 py-0 rounded text-[9px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30 leading-tight"
                              >
                                ~{Math.round(r.dailyBars / 21)}mo
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                const markCopied = () => setLastCopied(r.symbol);
                                const displaySym = fmtOptionSymbol(r);
                                try {
                                  await navigator.clipboard.writeText(displaySym);
                                  markCopied();
                                  toast.success(`Copied ${displaySym}`);
                                } catch {
                                  // Fallback for non-secure contexts where the Clipboard API is blocked.
                                  const ta = document.createElement("textarea");
                                  ta.value = displaySym;
                                  ta.style.position = "fixed";
                                  ta.style.opacity = "0";
                                  document.body.appendChild(ta);
                                  ta.select();
                                  try { document.execCommand("copy"); markCopied(); toast.success(`Copied ${displaySym}`); }
                                  catch { toast.error("Copy failed"); }
                                  document.body.removeChild(ta);
                                }
                              }}
                              title={`Copy "${fmtOptionSymbol(r)}" to clipboard (paste into TradingView)`}
                              aria-label={`Copy ${fmtOptionSymbol(r)}`}
                              className={`transition-opacity p-0.5 rounded hover:text-primary ${
                                isLastCopied ? "opacity-100 text-primary" : "text-success/50 hover:text-success"
                              }`}
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </span>
                        </td>
                        <td className="px-4 py-1.5 tabular-nums">{r.close.toFixed(2)}</td>
                        <td className={`px-4 py-1.5 tabular-nums font-medium ${r.changePct >= 0 ? "text-success" : "text-destructive-bright"}`}>
                          {r.changePct >= 0 ? "+" : ""}{r.changePct.toFixed(2)}%
                        </td>
                        <td className="px-4 py-1.5 tabular-nums text-muted-foreground">{r.volume.toLocaleString()}</td>
                        <td className="px-4 py-1.5 tabular-nums text-muted-foreground">{r.oi != null ? r.oi.toLocaleString() : "—"}</td>
                        <td className="px-4 py-1.5 text-muted-foreground">{r.date}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
                {filteredSortedResults.length > 500 && (
                  <p className="text-xs text-muted-foreground p-3 text-center border-t border-border">
                    Showing top 500 of {filteredSortedResults.length}. Export CSV for the full list.
                  </p>
                )}
              </div>
            )}
          </Card>
        )}

        {!histories.length && !loading && (
          <Card className="p-10 text-center shadow-card border-dashed">
            <Database className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <h3 className="font-semibold mb-1">No data loaded yet</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Go to <button onClick={() => navigate("/settings?tab=data")} className="text-primary font-medium underline-offset-2 hover:underline cursor-pointer bg-transparent border-none p-0">Settings → API / Data Source</button> to pick your NSE bhavcopy CSV folder. Multi-year history loads in seconds and stays entirely on your device.
            </p>
          </Card>
        )}
      </main>
    </div>
  );
};

export default Index;
