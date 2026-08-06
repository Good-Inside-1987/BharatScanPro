import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import {
  Plus, Minus, Trash2, Database, Clock, ChevronDown, History,
  ChevronLeft, ChevronRight, Search, TrendingUp, Layers, X, RotateCcw, Copy, LogOut, Check,
} from "lucide-react";
import { toast } from "sonner";
import { apiListSimTrades, apiRecordSimTrade, apiDeleteSimTrade, type ApiSimTrade } from "@/lib/api";
import { useData } from "@/context/DataContext";
import type { SymbolHistory } from "@/lib/csv";
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, ComposedChart, Area,
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StockLeg {
  id: string;
  symbol: string;
  action: "BUY" | "SELL";
  qty: number;
  entryPrice: number;
  entryDate: string;
  entryTime: string;
  sl?: number;
  tgt?: number;
}

interface StockRow {
  symbol: string;
  price: number;
  volume: number;
  change: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary search — last index where bars[i].date <= target
// ─────────────────────────────────────────────────────────────────────────────

function bsearchLastLE(bars: SymbolHistory["bars"], target: string): number {
  let lo = 0, hi = bars.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= target) { result = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time helpers — identical to OptionsSimulator
// ─────────────────────────────────────────────────────────────────────────────

const TIME_STEPS = [
  { label: "-1d",  type: "date", delta: -1  },
  { label: "SOD",  type: "sod",  delta: 0   },
  { label: "-1h",  type: "min",  delta: -60 },
  { label: "-15m", type: "min",  delta: -15 },
  { label: "-5m",  type: "min",  delta: -5  },
  { label: "-1m",  type: "min",  delta: -1  },
  { label: "+1m",  type: "min",  delta: 1   },
  { label: "+5m",  type: "min",  delta: 5   },
  { label: "+15m", type: "min",  delta: 15  },
  { label: "+1h",  type: "min",  delta: 60  },
  { label: "EOD",  type: "eod",  delta: 0   },
  { label: "+1d",  type: "date", delta: 1   },
] as const;

function addMinutes(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + delta;
  total = Math.max(9 * 60 + 15, Math.min(15 * 60 + 30, total));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Returns true when the simulator clock is on or after the leg's entry timestamp.
// Inactive ("pending") legs should not show P&L and are excluded from chart/stats.
function isLegActive(entryDate: string, entryTime: string, curDate: string, curTime: string): boolean {
  return `${curDate}T${curTime}` >= `${entryDate}T${entryTime}`;
}

function tradeDuration(entryDate: string, entryTime: string, curDate: string, curTime: string): string {
  const entryMs = new Date(`${entryDate}T${entryTime}:00`).getTime();
  const curMs   = new Date(`${curDate}T${curTime}:00`).getTime();
  const diffMs  = curMs - entryMs;
  if (diffMs <= 0) return "0m";
  const totalMins = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMins / 1440);
  if (days >= 1) {
    const remH = Math.floor((totalMins % 1440) / 60);
    return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
  }
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date + Time picker
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW_NAMES   = ["Su","Mo","Tu","We","Th","Fr","Sa"];

function DateTimePicker({
  value, time, holidaySet, onConfirm, onClose,
}: {
  value: string; time: string;
  holidaySet?: Set<string>;
  onConfirm: (date: string, time: string) => void;
  onClose: () => void;
}) {
  const initD = new Date((value || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const [draftDate, setDraftDate] = useState(value || new Date().toISOString().slice(0, 10));
  const [draftHour, setDraftHour] = useState(() => parseInt(time.split(":")[0]) || 9);
  const [draftMin,  setDraftMin]  = useState(() => parseInt(time.split(":")[1]) || 15);
  const [viewYear,  setViewYear]  = useState(() => initD.getFullYear());
  const [viewMonth, setViewMonth] = useState(() => initD.getMonth());

  const calDays = useMemo(() => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const lastDate = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells: Array<string | null> = Array(firstDow).fill(null);
    for (let d = 1; d <= lastDate; d++)
      cells.push(`${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewYear, viewMonth]);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); };

  const hours   = useMemo(() => Array.from({ length: 7 }, (_, i) => i + 9), []);
  const minutes = useMemo(() => Array.from({ length: draftHour === 15 ? 31 : 60 }, (_, i) => i), [draftHour]);

  const hourRef = useRef<HTMLDivElement>(null);
  const minRef  = useRef<HTMLDivElement>(null);
  useEffect(() => { hourRef.current?.querySelector<HTMLElement>(`[data-h="${draftHour}"]`)?.scrollIntoView({ block: "center" }); }, [draftHour]);
  useEffect(() => { minRef.current?.querySelector<HTMLElement>(`[data-m="${draftMin}"]`)?.scrollIntoView({ block: "center" }); }, [draftMin]);

  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={wrapRef} className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-1 bg-[#0d1117] border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col" style={{ width: 420 }}>
      <div className="flex">
        <div className="flex-1 p-3">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={prevMonth} className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"><ChevronLeft className="h-4 w-4" /></button>
            <span className="text-sm font-bold text-foreground">{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button type="button" onClick={nextMonth} className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {DOW_NAMES.map(d => <div key={d} className="text-center text-[9px] text-muted-foreground/60 font-semibold py-0.5">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-y-1">
            {calDays.map((dateStr, i) => {
              if (!dateStr) return <div key={i} />;
              const isSelected = dateStr === draftDate;
              const dow = new Date(dateStr + "T00:00:00").getDay();
              const isMarketOff = dow === 0 || dow === 6 || (holidaySet?.has(dateStr) ?? false);
              return (
                <button key={dateStr} type="button"
                  onClick={() => { setDraftDate(dateStr); setViewYear(parseInt(dateStr.slice(0,4))); setViewMonth(parseInt(dateStr.slice(5,7))-1); }}
                  title={isMarketOff ? "Market closed" : dateStr}
                  className={`h-7 w-7 mx-auto rounded-full flex items-center justify-center text-[11px] font-medium transition-all ${
                    isSelected
                      ? "bg-primary text-primary-foreground font-bold ring-2 ring-primary/50"
                      : isMarketOff
                      ? "text-red-500/70 hover:bg-red-500/10 hover:text-red-400"
                      : "text-foreground/75 hover:bg-muted/40 hover:text-foreground"
                  }`}>
                  {parseInt(dateStr.slice(8))}
                </button>
              );
            })}
          </div>
        </div>
        <div className="w-px bg-border/30 my-3" />
        <div className="flex items-start pt-3 px-3 gap-1">
          <div ref={hourRef} className="h-44 overflow-y-auto w-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {hours.map(h => (
              <button key={h} data-h={h} type="button" onClick={() => setDraftHour(h)}
                className={`w-full h-8 flex items-center justify-center text-[13px] font-semibold rounded transition-colors ${h === draftHour ? "bg-primary text-primary-foreground" : "text-foreground/55 hover:bg-muted/30 hover:text-foreground"}`}>
                {String(h).padStart(2,"0")}
              </button>
            ))}
          </div>
          <div className="flex items-center h-8 text-foreground/40 font-bold text-base mt-1">:</div>
          <div ref={minRef} className="h-44 overflow-y-auto w-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {minutes.map(m => (
              <button key={m} data-m={m} type="button" onClick={() => setDraftMin(m)}
                className={`w-full h-8 flex items-center justify-center text-[13px] font-semibold rounded transition-colors ${m === draftMin ? "bg-primary text-primary-foreground" : "text-foreground/55 hover:bg-muted/30 hover:text-foreground"}`}>
                {String(m).padStart(2,"0")}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 pb-3 pt-1 border-t border-border/30 mt-1">
        <button type="button" onClick={onClose} className="px-3 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors">Cancel</button>
        <button type="button"
          onClick={() => { onConfirm(draftDate, `${String(draftHour).padStart(2,"0")}:${String(draftMin).padStart(2,"0")}`); }}
          className="px-5 py-1 rounded bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity">OK</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payoff chart tooltip
// ─────────────────────────────────────────────────────────────────────────────

function PayoffTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const pnl = (payload.find((p: any) => p.dataKey === "pnlPos")?.value ?? 0)
            + (payload.find((p: any) => p.dataKey === "pnlNeg")?.value ?? 0);
  return (
    <div className="bg-card border border-border rounded px-2.5 py-1.5 text-xs shadow-lg space-y-0.5">
      <p className="text-muted-foreground">Price: ₹{Number(label).toLocaleString("en-IN",{maximumFractionDigits:2})}</p>
      <p className={`font-bold ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        P&L: {pnl >= 0 ? "+" : ""}₹{Math.round(pnl).toLocaleString("en-IN")}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Stock Simulator
// ─────────────────────────────────────────────────────────────────────────────

export default function StockSimulator() {
  const { histories, asOfDate, categories, holidays } = useData();
  const holidaySet = useMemo(() => new Set(holidays.map((h) => h.date)), [holidays]);

  // ── Step 1: Pre-build symbol index (runs once per histories change) ────────
  // Dedup: for identical trimmed symbols keep the history with the most bars.
  // This is O(H×B) but only runs when histories changes, not on every date step.
  const symbolIndex = useMemo(() => {
    const map = new Map<string, SymbolHistory>();
    for (const h of histories) {
      const sym = h.symbol.trim();
      const existing = map.get(sym);
      // Keep the one with more bars (usually the EQ/cash series)
      if (!existing || h.bars.length > existing.bars.length) {
        map.set(sym, h);
      }
    }
    return map;
  }, [histories]);

  // ── Step 2: Available dates — only from our deduped index ─────────────────
  // Use a sample of symbols to get equity-only dates (much faster than all bars)
  const availableDates = useMemo(() => {
    const set = new Set<string>();
    for (const h of symbolIndex.values()) {
      for (const b of h.bars) set.add(b.date);
    }
    return Array.from(set).sort();
  }, [symbolIndex]);

  const latestDate = useMemo(
    () => asOfDate ?? availableDates[availableDates.length - 1] ?? null,
    [asOfDate, availableDates],
  );

  const [simDate,    setSimDate]    = useState<string>("");
  const [simTime,    setSimTime]    = useState("09:15");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Sync simDate to latestDate once available
  useEffect(() => {
    if (latestDate && !simDate) setSimDate(latestDate);
  }, [latestDate]);

  const effectiveDate = simDate || latestDate || "";

  // ── Universe filter ───────────────────────────────────────────────────────
  const [universeId,   setUniverseId]   = useState("nse-cash");
  const [universeOpen, setUniverseOpen] = useState(false);
  const universeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (universeRef.current && !universeRef.current.contains(e.target as Node))
        setUniverseOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeUniverseSet = useMemo(() => {
    if (universeId === "ALL") return null;
    const cat = categories.find(c => c.id === universeId);
    return cat ? new Set(cat.symbols.map(s => s.trim())) : null;
  }, [universeId, categories]);

  const activeUniverseLabel = useMemo(() => {
    if (universeId === "ALL") return "All Stocks";
    return categories.find(c => c.id === universeId)?.name ?? "All Stocks";
  }, [universeId, categories]);

  // ── Step 3: stockRows — binary search per symbol (fast on date change) ────
  const [search,        setSearch]        = useState("");
  const [lastCopied,    setLastCopied]    = useState<string | null>(null);
  const [legs,          setLegs]          = useState<StockLeg[]>([]);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [sqOffAction, setSqOffAction] = useState<{ id: string; qty: number } | null>(null);
  const [rightTab, setRightTab] = useState<"positions" | "history">("positions");
  const [simHistory, setSimHistory] = useState<ApiSimTrade[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [focusSymbol,   setFocusSymbol]   = useState<string>("");
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  // ── QTY / Amount mode ─────────────────────────────────────────────────────
  const [qtyMode,      setQtyMode]      = useState<"qty" | "amount">("qty");
  const [globalQty,    setGlobalQty]    = useState(1);
  const [globalAmount, setGlobalAmount] = useState(50000);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showModeMenu) return;
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) setShowModeMenu(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModeMenu]);

  const isDirty = search !== "" || universeId !== "nse-cash" || simDate !== (latestDate ?? "") || simTime !== "09:15"
    || qtyMode !== "qty" || globalQty !== 1 || globalAmount !== 50000;
  function handleReset() {
    setSearch("");
    setUniverseId("nse-cash");
    setSimDate(latestDate ?? "");
    setSimTime("09:15");
    setQtyMode("qty");
    setGlobalQty(1);
    setGlobalAmount(50000);
  }

  const stockRows = useMemo((): StockRow[] => {
    if (!effectiveDate) return [];
    const result: StockRow[] = [];
    for (const [symbol, h] of symbolIndex) {
      const bars = h.bars;
      if (!bars.length) continue;
      // Binary search: last bar on or before effectiveDate
      const idx = bsearchLastLE(bars, effectiveDate);
      if (idx < 0) continue;
      const bar     = bars[idx];
      const prevBar = idx > 0 ? bars[idx - 1] : null;
      const price   = bar.close;
      const volume  = bar.volume ?? 0;
      // prevClose: use the bar's own prevClose field if valid, else previous bar's close
      const prevClose = (bar.prevClose > 0 && isFinite(bar.prevClose))
        ? bar.prevClose
        : (prevBar?.close ?? 0);
      const change = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      result.push({ symbol, price, volume, change });
    }
    return result.sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [symbolIndex, effectiveDate]);

  // O(1) price lookup map (rebuilt only when stockRows changes)
  const priceMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of stockRows) m.set(r.symbol, r.price);
    return m;
  }, [stockRows]);

  const filteredStocks = useMemo(() => {
    let rows = stockRows;
    if (activeUniverseSet) rows = rows.filter(r => activeUniverseSet.has(r.symbol));
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      rows = rows.filter(r => r.symbol.includes(q));
    }
    return rows;
  }, [stockRows, activeUniverseSet, search]);

  // Per-symbol leg index for B/S active-state colouring
  const legIndex = useMemo(() => {
    const map = new Map<string, ("BUY" | "SELL")[]>();
    for (const leg of legs)
      map.set(leg.symbol, [...(map.get(leg.symbol) ?? []), leg.action]);
    return map;
  }, [legs]);

  const getPriceForSymbol = useCallback(
    (symbol: string) => priceMap.get(symbol) ?? 0,
    [priceMap],
  );

  // Reference stock for the payoff chart x-axis
  const refSymbol = focusSymbol || legs[0]?.symbol || stockRows[0]?.symbol || "";
  const refPrice  = getPriceForSymbol(refSymbol);

  // ── Time navigation ───────────────────────────────────────────────────────
  const handleTimeStep = useCallback((step: typeof TIME_STEPS[number]) => {
    if (step.type === "sod")  { setSimTime("09:15"); return; }
    if (step.type === "eod")  { setSimTime("15:30"); return; }
    if (step.type === "min")  { setSimTime(t => addMinutes(t, step.delta)); return; }
    if (step.type === "date") {
      setSimDate(cur => {
        const idx = availableDates.indexOf(cur);
        if (idx < 0) {
          // snap to nearest
          const nearest = availableDates.findIndex(d => d >= cur);
          return nearest >= 0 ? availableDates[nearest] : (availableDates[availableDates.length - 1] ?? cur);
        }
        const next = idx + step.delta;
        return availableDates[Math.max(0, Math.min(availableDates.length - 1, next))] ?? cur;
      });
    }
  }, [availableDates]);

  // ── Leg management ────────────────────────────────────────────────────────
  const addLeg = useCallback((symbol: string, action: "BUY" | "SELL", price: number, qty: number) => {
    if (!price || price <= 0 || qty <= 0) return;
    setLegs(prev => [...prev, {
      id: crypto.randomUUID(),
      symbol, action, qty, entryPrice: price,
      entryDate: effectiveDate, entryTime: simTime,
    }]);
  }, [effectiveDate, simTime]);

  const removeLeg    = useCallback((id: string) => setLegs(prev => prev.filter(l => l.id !== id)), []);
  const updateLegQty = useCallback((id: string, delta: number) =>
    setLegs(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(1, l.qty + delta) } : l)), []);
  const updateLegSL  = useCallback((id: string, val: number | undefined) =>
    setLegs(prev => prev.map(l => l.id === id ? { ...l, sl: val } : l)), []);
  const updateLegTgt = useCallback((id: string, val: number | undefined) =>
    setLegs(prev => prev.map(l => l.id === id ? { ...l, tgt: val } : l)), []);

  // ── Trade history ──────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const trades = await apiListSimTrades("stock");
      setSimHistory(trades);
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => { void fetchHistory(); }, [fetchHistory]);

  const confirmSquareOff = useCallback(async (id: string, qtyToClose: number) => {
    const leg = legs.find(l => l.id === id);
    if (!leg) return;
    const exitPrice = getPriceForSymbol(leg.symbol);
    if (exitPrice <= 0) {
      toast.error("No price available — cannot square off");
      return;
    }
    const pnl = (leg.action === "BUY"
      ? exitPrice - leg.entryPrice
      : leg.entryPrice - exitPrice) * qtyToClose;
    const exitDate = effectiveDate || new Date().toISOString().slice(0, 10);
    const exitTime = simTime || "15:30";
    try {
      await apiRecordSimTrade({
        simulator_type: "stock",
        symbol: leg.symbol,
        underlying: null, strike: null, option_type: null, expiry: null,
        action: leg.action,
        qty: qtyToClose,
        lot_size: null,
        entry_price: leg.entryPrice,
        exit_price: exitPrice,
        entry_date: leg.entryDate,
        entry_time: leg.entryTime,
        exit_date: exitDate,
        exit_time: exitTime,
        realized_pnl: pnl,
        notes: null,
      });
      toast.success(`Squared off ${leg.symbol}: ${pnl >= 0 ? "+" : ""}₹${Math.round(Math.abs(pnl)).toLocaleString("en-IN")}`);
      void fetchHistory();
    } catch {
      toast.error("Failed to save to trade history");
    }
    setLegs(prev => prev.flatMap(l => {
      if (l.id !== id) return [l];
      const remaining = l.qty - qtyToClose;
      return remaining > 0 ? [{ ...l, qty: remaining }] : [];
    }));
    setSqOffAction(null);
  }, [legs, getPriceForSymbol, effectiveDate, simTime, fetchHistory]);

  // Ref: true while user is actively typing in an SL or TGT input — pauses breach check
  const editingSlTgt = useRef(false);

  // Auto squareoff toggles: true = square off on breach, false = alert only
  const [autoSL,  setAutoSL]  = useState(false);
  const [autoTgt, setAutoTgt] = useState(false);

  // Auto-squareoff on SL / Target breach (only for active legs)
  useEffect(() => {
    if (!legs.length || editingSlTgt.current) return;
    const toRemove: string[] = [];
    for (const leg of legs) {
      if (!isLegActive(leg.entryDate, leg.entryTime, effectiveDate, simTime)) continue;
      const cp = getPriceForSymbol(leg.symbol);
      if (cp <= 0) continue;
      const isBuy = leg.action === "BUY";
      if (leg.sl !== undefined && leg.sl > 0) {
        const breached = isBuy ? cp <= leg.sl : cp >= leg.sl;
        if (breached) {
          toast.warning(`SL hit: ${leg.symbol} @ ₹${cp.toFixed(2)}`);
          if (autoSL) toRemove.push(leg.id);
        }
      }
      if (leg.tgt !== undefined && leg.tgt > 0) {
        const breached = isBuy ? cp >= leg.tgt : cp <= leg.tgt;
        if (breached) {
          toast.success(`Target hit: ${leg.symbol} @ ₹${cp.toFixed(2)}`);
          if (autoTgt) toRemove.push(leg.id);
        }
      }
    }
    if (toRemove.length) setLegs(prev => prev.filter(l => !toRemove.includes(l.id)));
  }, [legs, getPriceForSymbol, autoSL, autoTgt]);

  // ── Payoff chart ──────────────────────────────────────────────────────────
  const payoffData = useMemo(() => {
    if (!legs.length || refPrice <= 0) return [];
    // Only active legs contribute to the payoff chart
    const activeLegs = legs.filter(l => isLegActive(l.entryDate, l.entryTime, effectiveDate, simTime));
    if (!activeLegs.length) return [];
    const lo   = refPrice * 0.70;
    const hi   = refPrice * 1.30;
    const step = (hi - lo) / 250;
    return Array.from({ length: 251 }, (_, i) => {
      const x     = lo + i * step;
      const ratio = x / refPrice;
      const pnl   = activeLegs.reduce((total, leg) => {
        const cp   = getPriceForSymbol(leg.symbol);
        const exit = cp > 0 ? cp * ratio : leg.entryPrice * ratio;
        return total + (leg.action === "BUY"
          ? (exit - leg.entryPrice) * leg.qty
          : (leg.entryPrice - exit) * leg.qty);
      }, 0);
      return {
        price:  +x.toFixed(2),
        pnl:    +pnl.toFixed(0),
        pnlPos: Math.max(+pnl.toFixed(0), 0),
        pnlNeg: Math.min(+pnl.toFixed(0), 0),
      };
    });
  }, [legs, refPrice, getPriceForSymbol, effectiveDate, simTime]);

  const stats = useMemo(() => {
    if (!legs.length) return null;
    // Only active legs contribute to aggregated P&L and invested capital
    const activeLegs = legs.filter(l => isLegActive(l.entryDate, l.entryTime, effectiveDate, simTime));
    const currentPnl = activeLegs.reduce((total, leg) => {
      const cp = getPriceForSymbol(leg.symbol);
      if (!cp) return total;
      return total + (leg.action === "BUY"
        ? (cp - leg.entryPrice) * leg.qty
        : (leg.entryPrice - cp) * leg.qty);
    }, 0);
    const invested = activeLegs.reduce((s, l) => s + l.entryPrice * l.qty, 0);
    const breakevens: number[] = [];
    for (let i = 1; i < payoffData.length; i++)
      if (payoffData[i-1].pnl * payoffData[i].pnl < 0)
        breakevens.push(+((payoffData[i-1].price + payoffData[i].price) / 2).toFixed(2));
    return { currentPnl, invested, breakevens };
  }, [legs, getPriceForSymbol, payoffData, effectiveDate, simTime]);

  const yDomain = useMemo(() => {
    if (!payoffData.length) return [-50000, 50000];
    const vals = payoffData.map(d => d.pnl);
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = Math.max(Math.abs(max - min) * 0.1, 1000);
    return [Math.floor((min - pad) / 1000) * 1000, Math.ceil((max + pad) / 1000) * 1000];
  }, [payoffData]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const simDateLabel = effectiveDate
    ? new Date(effectiveDate + "T00:00:00").toLocaleDateString("en-IN", {
        weekday: "short", day: "2-digit", month: "short", year: "numeric",
      })
    : "—";

  function fmtVol(v: number) {
    if (v >= 1e5) return (v / 1e5).toFixed(1) + "L";
    if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return v.toFixed(0);
  }
  function fmtPrice(v: number) {
    return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  }

  // ── No data ───────────────────────────────────────────────────────────────
  if (!histories.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <div className="rounded-full bg-muted/30 p-5">
          <Database className="h-10 w-10 text-muted-foreground/50" />
        </div>
        <div className="text-center max-w-sm">
          <p className="text-base font-semibold text-foreground mb-1">No stock data loaded</p>
          <p className="text-xs text-muted-foreground">
            Upload NSE bhavcopy CSVs from the Create Scan page to use the Stock Simulator.
          </p>
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-100px)] overflow-hidden bg-background">

      {/* ── Time nav bar ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-0 border-b border-border bg-[#0d1117] px-2 py-0.5 shrink-0 flex-wrap">
        {TIME_STEPS.slice(0, 6).map(step => (
          <button key={step.label} type="button" onClick={() => handleTimeStep(step)}
            className="px-3 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded transition-colors border-r border-border/30 last:border-r-0">
            {step.label}
          </button>
        ))}

        <div className="relative mx-2">
          <button type="button" onClick={() => setPickerOpen(o => !o)}
            className="flex items-center gap-2 px-3 py-0.5 bg-muted/20 border border-border/60 rounded text-xs font-semibold text-foreground min-w-[220px] justify-center hover:bg-muted/30 hover:border-border transition-colors">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span>{simDateLabel}</span>
            <span className="text-primary font-bold">{simTime}</span>
            <ChevronDown className={`h-3 w-3 text-muted-foreground/60 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
          </button>
          {pickerOpen && (
            <DateTimePicker
              value={effectiveDate} time={simTime}
              holidaySet={holidaySet}
              onConfirm={(date, time) => { setSimDate(date); setSimTime(time); setPickerOpen(false); }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        {TIME_STEPS.slice(6).map(step => (
          <button key={step.label} type="button" onClick={() => handleTimeStep(step)}
            className="px-3 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded transition-colors border-l border-border/30 first:border-l-0">
            {step.label}
          </button>
        ))}
      </div>

      {/* ── Main split ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: Stock list ─────────────────────────────────────────── */}
        <div className="w-[490px] shrink-0 flex flex-col border-r border-border bg-[#0d1117]">

          {/* Universe + Search toolbar */}
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/50 shrink-0">

            {/* Universe dropdown */}
            <div ref={universeRef} className="relative">
              <button type="button" onClick={() => setUniverseOpen(o => !o)}
                className="flex items-center gap-1.5 px-2 py-1 bg-muted/20 border border-border/60 rounded text-[11px] font-semibold text-foreground hover:bg-muted/30 hover:border-border transition-colors max-w-[130px]">
                <Layers className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                <span className="truncate">{activeUniverseLabel}</span>
                <ChevronDown className={`h-3 w-3 text-muted-foreground/60 shrink-0 transition-transform ${universeOpen ? "rotate-180" : ""}`} />
              </button>

              {universeOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 bg-[#0d1117] border border-border rounded-lg shadow-2xl py-1 min-w-[190px] max-h-72 overflow-y-auto">
                  <button type="button" onClick={() => { setUniverseId("ALL"); setUniverseOpen(false); }}
                    className={`w-full text-left px-3 py-1.5 text-[11px] font-semibold transition-colors flex items-center gap-2 ${universeId === "ALL" ? "bg-primary/20 text-primary" : "text-foreground/75 hover:bg-muted/30 hover:text-foreground"}`}>
                    <span className="h-1.5 w-1.5 rounded-full bg-current shrink-0" />
                    All Stocks
                    <span className="ml-auto text-[9px] text-muted-foreground/60 tabular-nums">{stockRows.length}</span>
                  </button>

                  {categories.length > 0 && (
                    <div className="border-t border-border/30 mt-1 pt-1">
                      {categories.map(cat => {
                        if (!cat.symbols.length) return null;
                        const isActive = universeId === cat.id;
                        return (
                          <button key={cat.id} type="button"
                            onClick={() => { setUniverseId(cat.id); setUniverseOpen(false); }}
                            className={`w-full text-left px-3 py-1.5 text-[11px] font-semibold transition-colors flex items-center gap-2 ${isActive ? "bg-primary/20 text-primary" : "text-foreground/75 hover:bg-muted/30 hover:text-foreground"}`}>
                            <span className="h-1.5 w-1.5 rounded-full bg-current shrink-0" />
                            {cat.name}
                            <span className="ml-auto text-[9px] text-muted-foreground/60 tabular-nums">{cat.symbols.length}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Search */}
            <div className="flex items-center gap-1.5 flex-1 px-2 py-1 bg-muted/20 border border-border/60 rounded">
              <Search className="h-3 w-3 text-muted-foreground/60 shrink-0" />
              <input type="text" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)}
                className="bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 flex-1 outline-none min-w-0" />
              {search && (
                <button type="button" onClick={() => setSearch("")} className="text-muted-foreground/50 hover:text-foreground text-xs leading-none">✕</button>
              )}
            </div>

            {/* Reset to defaults */}
            <button
              type="button"
              onClick={handleReset}
              disabled={!isDirty}
              title="Reset to defaults (NSE Cash · latest date · 09:15)"
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition-colors shrink-0 ${
                isDirty
                  ? "text-amber-400/80 hover:text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 border-amber-400/20 hover:border-amber-400/40 cursor-pointer"
                  : "text-muted-foreground/40 bg-muted/10 border-border/30 cursor-not-allowed"
              }`}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Reset
            </button>
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[1fr_96px_54px_72px_58px_52px] text-[9px] uppercase tracking-wide text-foreground/50 border-b border-border/50 bg-muted/20 px-2.5 py-1 font-semibold shrink-0">
            <div>Symbol</div>
            {/* QTY / Amount header with dropdown + global input */}
            <div className="flex items-center justify-center gap-1" onClick={e => e.stopPropagation()}>
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setShowModeMenu(m => !m)}
                  className="flex items-center gap-0.5 text-[9px] uppercase tracking-wide font-semibold text-primary/80 hover:text-primary transition-colors"
                >
                  {qtyMode === "qty" ? "Qty" : "Amt"}
                  <ChevronDown className={`h-2.5 w-2.5 transition-transform ${showModeMenu ? "rotate-180" : ""}`} />
                </button>
                {showModeMenu && (
                  <div className="absolute top-full left-0 mt-1 z-50 bg-[#0d1117] border border-border rounded-lg shadow-2xl overflow-hidden min-w-[90px]">
                    <button
                      type="button"
                      onClick={() => { setQtyMode("qty"); setShowModeMenu(false); }}
                      className={`w-full text-left px-3 py-2 text-[11px] font-semibold hover:bg-muted/30 transition-colors flex items-center gap-2 ${qtyMode === "qty" ? "text-primary" : "text-foreground/80"}`}
                    >
                      {qtyMode === "qty" && <span className="h-1.5 w-1.5 rounded-full bg-primary inline-block" />}
                      {qtyMode !== "qty" && <span className="h-1.5 w-1.5 rounded-full bg-transparent inline-block" />}
                      QTY
                    </button>
                    <button
                      type="button"
                      onClick={() => { setQtyMode("amount"); setShowModeMenu(false); }}
                      className={`w-full text-left px-3 py-2 text-[11px] font-semibold hover:bg-muted/30 transition-colors flex items-center gap-2 ${qtyMode === "amount" ? "text-primary" : "text-foreground/80"}`}
                    >
                      {qtyMode === "amount" && <span className="h-1.5 w-1.5 rounded-full bg-primary inline-block" />}
                      {qtyMode !== "amount" && <span className="h-1.5 w-1.5 rounded-full bg-transparent inline-block" />}
                      Amount
                    </button>
                  </div>
                )}
              </div>
              <input
                type="number"
                min={1}
                value={qtyMode === "qty" ? globalQty : globalAmount}
                onChange={e => {
                  const v = parseInt(e.target.value, 10);
                  if (qtyMode === "qty") { if (!isNaN(v) && v >= 1) setGlobalQty(v); }
                  else { if (!isNaN(v) && v >= 0) setGlobalAmount(v); }
                }}
                onClick={e => { e.stopPropagation(); (e.target as HTMLInputElement).select(); }}
                title={qtyMode === "qty" ? "Global quantity for all stocks" : "Amount to invest per stock (₹)"}
                className="w-12 text-[9px] tabular-nums font-bold text-foreground text-center bg-muted/20 border border-border/40 rounded focus:outline-none focus:border-primary/60 px-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
            </div>
            <div className="text-center">Act</div>
            <div className="text-center">Price</div>
            <div className="text-center">Volume</div>
            <div className="text-center">Chg%</div>
          </div>

          {/* Stock rows */}
          <div className="flex-1 overflow-y-auto">
            {filteredStocks.length === 0 ? (
              <div className="flex items-center justify-center h-20 text-xs text-muted-foreground/50">No stocks found</div>
            ) : filteredStocks.map(row => {
              const isFocused = row.symbol === refSymbol;
              const actions   = legIndex.get(row.symbol) ?? [];
              const hasBuy    = actions.includes("BUY");
              const hasSell   = actions.includes("SELL");
              const showBS    = hoveredSymbol === row.symbol || hasBuy || hasSell;
              const effectiveQty = qtyMode === "qty"
                ? globalQty
                : Math.floor(globalAmount / (row.price || 1));

              return (
                <div key={row.symbol}
                  onMouseEnter={() => setHoveredSymbol(row.symbol)}
                  onMouseLeave={() => setHoveredSymbol(null)}
                  onClick={() => setFocusSymbol(row.symbol)}
                  className={`group grid grid-cols-[1fr_96px_54px_72px_58px_52px] items-center px-2.5 h-10 border-b border-border/10 cursor-pointer ${
                    isFocused ? "bg-primary/10 border-l-2 border-l-primary" : "hover:bg-muted/10"
                  }`}
                >
                  {/* Symbol name only */}
                  <div className="flex items-center gap-1 min-w-0 pr-1">
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          await navigator.clipboard.writeText(row.symbol);
                          setLastCopied(row.symbol);
                          toast.success(`Copied ${row.symbol}`);
                        } catch {
                          const ta = document.createElement("textarea");
                          ta.value = row.symbol;
                          ta.style.position = "fixed";
                          ta.style.opacity = "0";
                          document.body.appendChild(ta);
                          ta.select();
                          try { document.execCommand("copy"); setLastCopied(row.symbol); toast.success(`Copied ${row.symbol}`); }
                          catch { toast.error("Copy failed"); }
                          document.body.removeChild(ta);
                        }
                      }}
                      title={`Copy "${row.symbol}" to clipboard`}
                      className={`shrink-0 p-0.5 rounded transition-colors ${
                        lastCopied === row.symbol
                          ? "text-primary opacity-100"
                          : "text-muted-foreground/40 hover:text-primary opacity-40 hover:opacity-100"
                      }`}
                    >
                      <Copy className="h-2.5 w-2.5" />
                    </button>
                    <span className={`text-[11px] font-bold truncate min-w-0 flex-1 ${isFocused ? "text-primary" : "text-foreground"}`}>
                      {row.symbol}
                    </span>
                  </div>

                  {/* QTY column — global qty stepper or amount-derived read-only */}
                  <div className="flex items-center gap-0.5 justify-center" onClick={e => e.stopPropagation()}>
                    {qtyMode === "qty" ? (
                      <>
                        <button type="button"
                          onClick={() => setGlobalQty(q => Math.max(1, q - 1))}
                          className="h-4 w-4 flex items-center justify-center rounded bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground shrink-0">
                          <Minus className="h-2 w-2" />
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={globalQty}
                          onChange={e => {
                            const v = parseInt(e.target.value, 10);
                            if (!isNaN(v) && v >= 1) setGlobalQty(v);
                          }}
                          onClick={e => { e.stopPropagation(); (e.target as HTMLInputElement).select(); }}
                          className="w-14 text-[10px] tabular-nums font-semibold text-foreground text-center bg-transparent border border-border/40 rounded focus:outline-none focus:border-primary/60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button type="button"
                          onClick={() => setGlobalQty(q => q + 1)}
                          className="h-4 w-4 flex items-center justify-center rounded bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground shrink-0">
                          <Plus className="h-2 w-2" />
                        </button>
                      </>
                    ) : (
                      <span
                        className={`text-[11px] tabular-nums font-semibold ${effectiveQty === 0 ? "text-foreground/25" : "text-amber-400"}`}
                        title={effectiveQty === 0 ? `₹${globalAmount.toLocaleString("en-IN")} is not enough to buy even 1 share at ₹${row.price.toFixed(2)}` : `₹${globalAmount.toLocaleString("en-IN")} ÷ ₹${row.price.toFixed(2)} = ${effectiveQty} shares`}
                      >
                        {effectiveQty === 0 ? "—" : effectiveQty.toLocaleString("en-IN")}
                      </span>
                    )}
                  </div>

                  {/* ACT column — B / S buttons, always reserved, fade in on hover */}
                  <div className="flex items-center justify-center gap-1" onClick={e => e.stopPropagation()}>
                    <button type="button"
                      disabled={effectiveQty === 0}
                      onClick={() => { addLeg(row.symbol, "BUY", row.price, effectiveQty); setFocusSymbol(row.symbol); }}
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded shadow-md leading-tight transition-opacity ${
                        effectiveQty === 0 ? "opacity-0 pointer-events-none" : showBS ? "opacity-100" : "opacity-0 pointer-events-none"
                      } ${
                        hasBuy
                          ? "bg-blue-500 text-white ring-1 ring-blue-300"
                          : hasSell
                            ? "bg-blue-900/40 text-blue-400/40 hover:bg-blue-600/60 hover:text-blue-200"
                            : "bg-blue-600/60 text-blue-200 hover:bg-blue-500"
                      }`}>B</button>
                    <button type="button"
                      disabled={effectiveQty === 0}
                      onClick={() => { addLeg(row.symbol, "SELL", row.price, effectiveQty); setFocusSymbol(row.symbol); }}
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded shadow-md leading-tight transition-opacity ${
                        effectiveQty === 0 ? "opacity-0 pointer-events-none" : showBS ? "opacity-100" : "opacity-0 pointer-events-none"
                      } ${
                        hasSell
                          ? "bg-red-500 text-white ring-1 ring-red-300"
                          : hasBuy
                            ? "bg-red-900/40 text-red-400/40 hover:bg-red-600/60 hover:text-red-200"
                            : "bg-red-600/60 text-red-200 hover:bg-red-500"
                      }`}>S</button>
                  </div>

                  {/* Price */}
                  <div className="text-right">
                    <span className="text-[11px] font-bold tabular-nums text-foreground">
                      {fmtPrice(row.price)}
                    </span>
                  </div>

                  {/* Volume */}
                  <div className="text-right">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{fmtVol(row.volume)}</span>
                  </div>

                  {/* Change % */}
                  <div className="text-right">
                    <span className={`text-[10px] tabular-nums font-semibold ${row.change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {row.change >= 0 ? "+" : ""}{row.change.toFixed(2)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Positions / History ────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Right panel tabs */}
          <div className="flex items-center border-b border-border bg-[#0d1117] px-4 shrink-0">
            {(["positions", "history"] as const).map((key) => {
              const Icon = key === "positions" ? TrendingUp : History;
              const label = key === "positions" ? "Positions" : "History";
              return (
                <button key={key} type="button" onClick={() => setRightTab(key)}
                  className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                    rightTab === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}>
                  <Icon className="h-3.5 w-3.5" />{label}
                  {key === "history" && simHistory.length > 0 && (
                    <span className="ml-0.5 text-[9px] px-1.5 rounded-full bg-primary/20 text-primary font-bold">{simHistory.length}</span>
                  )}
                </button>
              );
            })}
          </div>
          {rightTab === "positions" && (legs.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-8">
              <div className="rounded-full bg-muted/20 p-5">
                <TrendingUp className="h-9 w-9 text-muted-foreground/35" />
              </div>
              <p className="text-sm font-semibold text-foreground">No positions added yet</p>
              <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                Hover any stock row and click <span className="font-bold text-blue-400">B</span> to buy or <span className="font-bold text-red-400">S</span> to short.
              </p>
            </div>
          ) : (
            <>
              {/* Stats bar */}
              <div className="flex items-center gap-3 px-4 py-1 border-b border-border bg-[#0d1117] shrink-0 text-xs flex-wrap">
                <span className="text-muted-foreground">Ref:</span>
                <span className="font-bold text-primary">{refSymbol}</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground">LTP:</span>
                <span className="font-bold text-foreground tabular-nums">
                  {refPrice > 0 ? fmtPrice(refPrice) : "—"}
                </span>
                {stats && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="text-muted-foreground">P&amp;L:</span>
                    <span className={`font-bold tabular-nums ${stats.currentPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {stats.currentPnl >= 0 ? "+" : ""}₹{Math.round(stats.currentPnl).toLocaleString("en-IN")}
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="text-muted-foreground">Invested:</span>
                    <span className="font-semibold text-foreground tabular-nums">
                      ₹{Math.round(stats.invested).toLocaleString("en-IN")}
                    </span>
                    {stats.breakevens.length > 0 && (
                      <>
                        <span className="text-muted-foreground/40">·</span>
                        <span className="text-muted-foreground">Breakeven:</span>
                        <span className="font-semibold text-amber-400 tabular-nums">
                          {stats.breakevens.map(b => fmtPrice(b)).join(", ")}
                        </span>
                      </>
                    )}
                  </>
                )}
                {legs.length > 1 && (
                  <button type="button" onClick={() => setLegs([])}
                    className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-red-400 transition-colors">
                    <Trash2 className="h-3 w-3" /> Clear all
                  </button>
                )}
              </div>

              {/* Positions table */}
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {/* Header */}
                <div className="grid grid-cols-[32px_1fr_70px_80px_80px_80px_90px_50px_40px_40px_60px] gap-x-2 items-center text-[9px] uppercase tracking-wide text-muted-foreground/50 font-semibold px-2 pb-1 border-b border-border/30 mb-1">
                  <div className="text-center">Side</div>
                  <div className="text-center">Symbol</div>
                  <div className="text-center">Qty</div>
                  <div className="text-center">Entry</div>
                  <div className="text-center">Invested</div>
                  <div className="text-center">LTP</div>
                  <div className="text-center">P&amp;L</div>
                  <div className="text-center text-sky-400/60">Time</div>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-red-400/60">SL</span>
                    <button type="button" onClick={() => setAutoSL(v => !v)}
                      title={autoSL ? "Auto square-off ON — click for alert-only" : "Alert-only — click to enable auto square-off"}
                      className={`text-[7px] font-bold px-1.5 rounded-full leading-tight border transition-colors ${
                        autoSL
                          ? "bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30"
                          : "bg-muted/20 text-muted-foreground/40 border-border/30 hover:bg-muted/30"
                      }`}>
                      {autoSL ? "AUTO" : "ALRT"}
                    </button>
                  </div>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-emerald-400/60">Tgt</span>
                    <button type="button" onClick={() => setAutoTgt(v => !v)}
                      title={autoTgt ? "Auto square-off ON — click for alert-only" : "Alert-only — click to enable auto square-off"}
                      className={`text-[7px] font-bold px-1.5 rounded-full leading-tight border transition-colors ${
                        autoTgt
                          ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30"
                          : "bg-muted/20 text-muted-foreground/40 border-border/30 hover:bg-muted/30"
                      }`}>
                      {autoTgt ? "AUTO" : "ALRT"}
                    </button>
                  </div>
                  <div className="text-center" />
                </div>

                <div className="space-y-1">
                  {legs.map(leg => {
                    const active = isLegActive(leg.entryDate, leg.entryTime, effectiveDate, simTime);
                    const cp     = active ? getPriceForSymbol(leg.symbol) : 0;
                    const pnl    = active && cp > 0
                      ? (leg.action === "BUY"
                          ? (cp - leg.entryPrice) * leg.qty
                          : (leg.entryPrice - cp) * leg.qty)
                      : 0;
                    const pnlPct = active && leg.entryPrice > 0 && cp > 0
                      ? ((leg.action === "BUY"
                            ? (cp - leg.entryPrice) / leg.entryPrice
                            : (leg.entryPrice - cp) / leg.entryPrice) * 100)
                      : 0;
                    const pnlColor = pnl >= 0 ? "text-emerald-400" : "text-red-400";

                    return (
                      <div key={leg.id}
                        className={`grid grid-cols-[32px_1fr_70px_80px_80px_80px_90px_50px_40px_40px_60px] gap-x-2 items-center px-2 py-1.5 rounded-lg border transition-opacity ${
                          !active
                            ? "bg-muted/5 border-border/20 opacity-55"
                            : pnl >= 0 ? "bg-muted/10 border-emerald-500/20" : "bg-muted/10 border-red-500/20"
                        }`}
                      >
                        {/* Side badge */}
                        <span className={`text-center text-[9px] font-bold px-1 py-0.5 rounded ${
                          leg.action === "BUY" ? "bg-blue-500/20 text-blue-400" : "bg-red-500/20 text-red-400"
                        }`}>
                          {leg.action === "BUY" ? "B" : "S"}
                        </span>

                        {/* Symbol + entry date */}
                        <div className="min-w-0 text-center">
                          <p className="text-[11px] font-bold text-foreground truncate">{leg.symbol}</p>
                          <p className="text-[9px] text-muted-foreground/50">{leg.entryDate}</p>
                        </div>

                        {/* Qty stepper */}
                        <div className="flex items-center justify-center gap-0.5">
                          <button type="button" onClick={() => updateLegQty(leg.id, -1)}
                            className="h-4 w-4 flex items-center justify-center rounded bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground">
                            <Minus className="h-2.5 w-2.5" />
                          </button>
                          <span className="text-[11px] tabular-nums font-semibold text-foreground w-10 text-center">{leg.qty}</span>
                          <button type="button" onClick={() => updateLegQty(leg.id, 1)}
                            className="h-4 w-4 flex items-center justify-center rounded bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground">
                            <Plus className="h-2.5 w-2.5" />
                          </button>
                        </div>

                        {/* Entry */}
                        <div className="text-center">
                          <p className="text-[10px] tabular-nums text-muted-foreground">{fmtPrice(leg.entryPrice)}</p>
                        </div>

                        {/* Invested */}
                        <div className="text-center">
                          <p className="text-[10px] tabular-nums font-semibold text-amber-400/90">
                            ₹{Math.round(leg.qty * leg.entryPrice).toLocaleString("en-IN")}
                          </p>
                        </div>

                        {/* LTP */}
                        <div className="text-center">
                          <p className="text-[11px] tabular-nums font-semibold text-foreground">
                            {active && cp > 0 ? fmtPrice(cp) : "—"}
                          </p>
                        </div>

                        {/* P&L */}
                        <div className="text-center">
                          {active ? (
                            <>
                              <p className={`text-[11px] tabular-nums font-bold ${pnlColor}`}>
                                {pnl >= 0 ? "+" : ""}₹{Math.round(pnl).toLocaleString("en-IN")}
                              </p>
                              {cp > 0 && (
                                <p className={`text-[9px] tabular-nums ${pnlColor} opacity-70`}>
                                  {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                                </p>
                              )}
                            </>
                          ) : (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/80 border border-amber-500/20">
                              Pending
                            </span>
                          )}
                        </div>

                        {/* Time held / pending */}
                        <div className="text-center">
                          {active ? (
                            <span
                              className="text-[10px] tabular-nums font-semibold text-sky-400/80"
                              title={`Entered: ${leg.entryDate} ${leg.entryTime} → Now: ${effectiveDate} ${simTime}`}
                            >
                              {tradeDuration(leg.entryDate, leg.entryTime, effectiveDate, simTime)}
                            </span>
                          ) : (
                            <span
                              className="text-[9px] tabular-nums text-muted-foreground/50"
                              title={`Entry at: ${leg.entryDate} ${leg.entryTime}`}
                            >
                              {leg.entryTime}
                            </span>
                          )}
                        </div>

                        {/* SL */}
                        <input
                          type="number" min={0} step={0.5}
                          placeholder="—"
                          value={leg.sl ?? ""}
                          onClick={e => e.stopPropagation()}
                          onFocus={() => { editingSlTgt.current = true; }}
                          onBlur={() => { editingSlTgt.current = false; }}
                          onChange={(e) => updateLegSL(leg.id, e.target.value === "" ? undefined : parseFloat(e.target.value))}
                          className="w-full text-center text-[10px] tabular-nums bg-red-500/10 border border-red-500/25 rounded px-1 py-0.5 text-red-300 placeholder:text-red-500/30 focus:outline-none focus:border-red-400/60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />

                        {/* Target */}
                        <input
                          type="number" min={0} step={0.5}
                          placeholder="—"
                          value={leg.tgt ?? ""}
                          onClick={e => e.stopPropagation()}
                          onFocus={() => { editingSlTgt.current = true; }}
                          onBlur={() => { editingSlTgt.current = false; }}
                          onChange={(e) => updateLegTgt(leg.id, e.target.value === "" ? undefined : parseFloat(e.target.value))}
                          className="w-full text-center text-[10px] tabular-nums bg-emerald-500/10 border border-emerald-500/25 rounded px-1 py-0.5 text-emerald-300 placeholder:text-emerald-500/30 focus:outline-none focus:border-emerald-400/60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />

                        {/* Sq Off + Delete */}
                        {deleteConfirmId === leg.id ? (
                          <div className="flex items-center justify-center gap-1">
                            <span className="text-[9px] text-red-400 font-semibold">Delete?</span>
                            <button type="button" title="Yes, delete"
                              onClick={() => { removeLeg(leg.id); setDeleteConfirmId(null); }}
                              className="w-4 h-4 flex items-center justify-center rounded bg-red-500/20 text-red-400 hover:bg-red-500/35 transition-colors">
                              <Check className="h-2.5 w-2.5" />
                            </button>
                            <button type="button" title="Cancel"
                              onClick={() => setDeleteConfirmId(null)}
                              className="w-4 h-4 flex items-center justify-center rounded bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ) : sqOffAction?.id === leg.id ? (
                          <div className="flex items-center justify-center gap-0.5">
                            <button type="button"
                              onClick={() => setSqOffAction(a => a && { ...a, qty: Math.max(1, a.qty - 1) })}
                              className="w-4 h-4 flex items-center justify-center rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/35 transition-colors">
                              <Minus className="h-2 w-2" />
                            </button>
                            <span className="tabular-nums font-bold text-amber-400 text-[11px] w-5 text-center">{sqOffAction.qty}</span>
                            <button type="button"
                              onClick={() => setSqOffAction(a => a && { ...a, qty: Math.min(leg.qty, a.qty + 1) })}
                              className="w-4 h-4 flex items-center justify-center rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/35 transition-colors">
                              <Plus className="h-2 w-2" />
                            </button>
                            <button type="button" title="Confirm square off"
                              onClick={() => void confirmSquareOff(leg.id, sqOffAction.qty)}
                              className="w-4 h-4 flex items-center justify-center rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/35 transition-colors ml-0.5">
                              <Check className="h-2.5 w-2.5" />
                            </button>
                            <button type="button" title="Cancel"
                              onClick={() => setSqOffAction(null)}
                              className="w-4 h-4 flex items-center justify-center rounded bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <button type="button" onClick={() => setSqOffAction({ id: leg.id, qty: leg.qty })}
                              title="Square off at LTP"
                              className="w-6 h-6 flex items-center justify-center rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/40 transition-colors">
                              <LogOut className="h-3 w-3" />
                            </button>
                            <button type="button" onClick={() => setDeleteConfirmId(leg.id)}
                              title="Delete position"
                              className="p-1 rounded hover:bg-red-500/20 text-muted-foreground/40 hover:text-red-400 transition-colors">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ))}
          {rightTab === "history" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {historyLoading ? (
                <div className="flex items-center justify-center flex-1 text-muted-foreground text-xs">Loading history…</div>
              ) : simHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-8">
                  <div className="rounded-full bg-muted/20 p-5">
                    <History className="h-9 w-9 text-muted-foreground/35" />
                  </div>
                  <p className="text-sm font-semibold text-foreground">No trade history yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">Square off a position to record it here.</p>
                </div>
              ) : (
                <div className="overflow-y-auto flex-1">
                  <table className="w-full text-[10px] border-collapse">
                    <thead className="sticky top-0 bg-[#0d1117] z-10">
                      <tr className="border-b border-border/50">
                        {[
                          { label: "Exit Date",  cls: "text-left pl-3"   },
                          { label: "Symbol",     cls: "text-left"        },
                          { label: "B/S",        cls: "text-center"      },
                          { label: "Qty",        cls: "text-right"       },
                          { label: "Entry",      cls: "text-right"       },
                          { label: "Exit",       cls: "text-right"       },
                          { label: "P&L",        cls: "text-right"       },
                          { label: "",           cls: "text-center"      },
                        ].map(({ label, cls }) => (
                          <th key={label} className={`px-2 py-1.5 text-[9px] uppercase tracking-wide text-muted-foreground/60 font-semibold whitespace-nowrap ${cls}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {simHistory.map((t) => (
                        <tr key={t.id} className="border-b border-border/20 hover:bg-muted/10 transition-colors">
                          <td className="pl-3 pr-2 py-1.5 whitespace-nowrap">
                            <div className="text-muted-foreground font-medium">{t.exit_date}</div>
                            <div className="text-[9px] text-muted-foreground/50">{t.entry_time}→{t.exit_time}</div>
                          </td>
                          <td className="px-2 py-1.5 font-semibold text-foreground">{t.symbol}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${t.action === "BUY" ? "bg-blue-500/20 text-blue-400" : "bg-red-500/20 text-red-400"}`}>
                              {t.action === "BUY" ? "B" : "S"}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{t.qty}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">₹{t.entry_price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">₹{t.exit_price.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${t.realized_pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {t.realized_pnl >= 0 ? "+" : ""}₹{Math.round(Math.abs(t.realized_pnl)).toLocaleString("en-IN")}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button type="button"
                              onClick={async () => {
                                try { await apiDeleteSimTrade(t.id); void fetchHistory(); }
                                catch { toast.error("Failed to delete"); }
                              }}
                              className="p-0.5 rounded text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border/50 bg-[#080d11]">
                        <td colSpan={6} className="pl-3 pr-2 py-1.5 text-xs font-semibold text-muted-foreground">Total Realized P&amp;L</td>
                        <td className={`px-2 py-1.5 text-right text-xs font-bold tabular-nums ${
                          simHistory.reduce((s, t) => s + t.realized_pnl, 0) >= 0 ? "text-emerald-400" : "text-red-400"
                        }`}>
                          {simHistory.reduce((s, t) => s + t.realized_pnl, 0) >= 0 ? "+" : ""}
                          ₹{Math.round(Math.abs(simHistory.reduce((s, t) => s + t.realized_pnl, 0))).toLocaleString("en-IN")}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
