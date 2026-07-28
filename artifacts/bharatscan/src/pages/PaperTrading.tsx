import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wallet, TrendingUp, TrendingDown, Plus, X, RefreshCw, History,
  ArrowUpRight, ArrowDownRight, Trash2, Settings2, Radio, Target, AlertTriangle, XCircle,
  ChevronLeft, ChevronRight, Download,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useData } from "@/context/DataContext";
import { getLotSizeForExpiry } from "@/lib/universe";
import {
  apiListPaperAccounts, apiCreatePaperAccount, apiUpdatePaperAccount,
  apiDeletePaperAccount, apiResetPaperAccount,
  apiListPaperPositions, apiOpenPaperPosition, apiClosePaperPosition,
  apiListPaperTrades, apiGetPaperQuotes, apiGetSchedulerStatus,
  type ApiPaperAccount, type ApiPaperPosition, type ApiPaperTrade,
  type InstrumentType, type PositionSide, type OptionType,
} from "@/lib/api";
import { toast } from "sonner";
import { ALL_NSE_STOCKS, ALL_FUTURES_SYMBOLS } from "@/lib/nseSymbols";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip as ChartTooltip,
  ResponsiveContainer, ReferenceLine, CartesianGrid,
} from "recharts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtRs(n: number, decimals = 0): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPnl(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${fmtRs(Math.abs(n), 2)}`;
}

function pnlClass(n: number): string {
  return n >= 0 ? "text-emerald-500" : "text-red-500";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

/** Default lot sizes for common index F&O — editable by the user since NSE revises these periodically. */
const DEFAULT_LOT_SIZES: Record<string, number> = {
  NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 40, MIDCPNIFTY: 120, NIFTYNXT50: 25, SENSEX: 20,
};

// ─── Options chain trade flow types & helpers ─────────────────────────────────

interface DraftLeg {
  id: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: "CE" | "PE";
  action: "BUY" | "SELL";
  lots: number;
  lotSize: number;
  entryPrice: number;
  time: string; // "HH:MM AM/PM" when leg was added
}

function optDelta(spot: number, strike: number, type: "CE" | "PE", dte: number): number {
  if (spot <= 0) return type === "CE" ? 0.5 : -0.5;
  const σ = 0.15, T = Math.max(dte / 365, 1 / 365);
  const d1 = (Math.log(spot / strike) + 0.5 * σ * σ * T) / (σ * Math.sqrt(T));
  const nd1 = 0.5 * (1 + Math.tanh(d1 * 0.7071));
  return type === "CE" ? +nd1.toFixed(2) : +(nd1 - 1).toFixed(2);
}

function optDte(today: string, expiry: string): number {
  return Math.max(0, Math.round((new Date(expiry).getTime() - new Date(today).getTime()) / 86400000));
}

const CHAIN_INDEX_ORDER = ["NIFTY", "BANKNIFTY", "FINNIFTY", "NIFTYNXT50", "MIDCPNIFTY", "SENSEX", "BANKEX"];

interface ChainStratLeg { type: "CE" | "PE"; action: "BUY" | "SELL"; offset: number; }
interface ChainStrat { name: string; emoji: string; category: "neutral" | "bullish" | "bearish" | "other"; legs: ChainStratLeg[]; }

const CHAIN_STRATEGIES: ChainStrat[] = [
  // Neutral
  { name: "Short Straddle",  emoji: "⚖️",  category: "neutral",  legs: [{ type:"CE", action:"SELL", offset:0 }, { type:"PE", action:"SELL", offset:0 }] },
  { name: "Long Straddle",   emoji: "🎯",  category: "neutral",  legs: [{ type:"CE", action:"BUY",  offset:0 }, { type:"PE", action:"BUY",  offset:0 }] },
  { name: "Short Strangle",  emoji: "🦀",  category: "neutral",  legs: [{ type:"CE", action:"SELL", offset:1 }, { type:"PE", action:"SELL", offset:-1 }] },
  { name: "Long Strangle",   emoji: "🦋",  category: "neutral",  legs: [{ type:"CE", action:"BUY",  offset:1 }, { type:"PE", action:"BUY",  offset:-1 }] },
  { name: "Iron Condor",     emoji: "🦅",  category: "neutral",  legs: [{ type:"PE", action:"BUY", offset:-2 }, { type:"PE", action:"SELL", offset:-1 }, { type:"CE", action:"SELL", offset:1 }, { type:"CE", action:"BUY", offset:2 }] },
  { name: "Iron Butterfly",  emoji: "🦚",  category: "neutral",  legs: [{ type:"PE", action:"BUY", offset:-1 }, { type:"PE", action:"SELL", offset:0  }, { type:"CE", action:"SELL", offset:0  }, { type:"CE", action:"BUY", offset:1 }] },
  // Bullish
  { name: "Bull Call Spread",emoji: "📈",  category: "bullish",  legs: [{ type:"CE", action:"BUY",  offset:0 }, { type:"CE", action:"SELL", offset:1  }] },
  { name: "Bull Put Spread", emoji: "🐂",  category: "bullish",  legs: [{ type:"PE", action:"BUY",  offset:-1}, { type:"PE", action:"SELL", offset:0  }] },
  // Bearish
  { name: "Bear Put Spread", emoji: "📉",  category: "bearish",  legs: [{ type:"PE", action:"BUY",  offset:0 }, { type:"PE", action:"SELL", offset:-1 }] },
  { name: "Bear Call Spread",emoji: "🐻",  category: "bearish",  legs: [{ type:"CE", action:"BUY",  offset:1 }, { type:"CE", action:"SELL", offset:0  }] },
  // Other
  { name: "Batman",          emoji: "🦇",  category: "other",    legs: [{ type:"PE", action:"BUY", offset:-2 }, { type:"PE", action:"SELL", offset:-1 }, { type:"PE", action:"SELL", offset:0 }, { type:"CE", action:"SELL", offset:0 }, { type:"CE", action:"SELL", offset:1 }, { type:"CE", action:"BUY", offset:2 }] },
  { name: "Jade Lizard",     emoji: "🦎",  category: "other",    legs: [{ type:"PE", action:"SELL", offset:-1}, { type:"CE", action:"SELL", offset:1  }, { type:"CE", action:"BUY", offset:2 }] },
];

function getStockLtp(histories: { symbol: string; bars: { date: string; close: number }[] }[], symbol: string, asOfDate: string | null): number | null {
  const h = histories.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
  if (!h || !h.bars.length) return null;
  if (!asOfDate) return h.bars[h.bars.length - 1].close;
  for (let i = h.bars.length - 1; i >= 0; i--) {
    if (h.bars[i].date <= asOfDate) return h.bars[i].close;
  }
  return null;
}

// ─── Modal primitive (mirrors Portfolio.tsx conventions) ───────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
      <div className={`bg-card border border-border rounded-xl shadow-2xl w-full overflow-hidden ${wide ? "max-w-xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition";

// ─── Symbol autocomplete (simplified inline version) ────────────────────────

function SymbolPicker({ symbols, value, onChange, placeholder }: {
  symbols: string[]; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = value.trim().toUpperCase();
    if (!q) return symbols.slice(0, 12);
    return symbols.filter((s) => s.includes(q)).slice(0, 12);
  }, [symbols, value]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <input
        className="w-full bg-background border border-border rounded-md px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-popover border border-border rounded-lg shadow-lg">
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => { onChange(s); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/60 text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Summary card ────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: string; icon: React.ComponentType<{ className?: string }>; tone?: "up" | "down" | "neutral" }) {
  const toneCls = tone === "up" ? "text-emerald-500" : tone === "down" ? "text-red-500" : "text-foreground";
  return (
    <Card className="px-3 py-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        <Icon className="h-2.5 w-2.5 text-muted-foreground/60" />
      </div>
      <div className={`text-xs font-bold leading-tight ${toneCls}`}>{value}</div>
    </Card>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PaperTrading() {
  const { histories, optionsData, asOfDate, asOfOptionsDate, lotSizes: csvLotSizes } = useData();
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState<string | null>(null);
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [showAddFunds, setShowAddFunds] = useState(false);
  const [showStockTrade, setShowStockTrade] = useState(false);
  const [showFuturesTrade, setShowFuturesTrade] = useState(false);
  const [showOptionsTrade, setShowOptionsTrade] = useState(false);
  const [optionsSubmitting, setOptionsSubmitting] = useState(false);
  const [closingPosition, setClosingPosition] = useState<ApiPaperPosition | null>(null);
  const [closingAll, setClosingAll] = useState(false);
  const [positionFilter, setPositionFilter] = useState<"all" | "stock" | "future" | "option">("all");
  const [tab, setTab] = useState<"positions" | "history">("positions");
  const [tick, setTick] = useState(0); // forces P&L recompute every minute

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const { data: accounts = [] } = useQuery({
    queryKey: ["paper-accounts"],
    queryFn: apiListPaperAccounts,
  });

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const account = accounts.find((a) => a.id === accountId) ?? null;

  const { data: positions = [] } = useQuery({
    queryKey: ["paper-positions", accountId],
    queryFn: () => apiListPaperPositions(accountId as string),
    enabled: !!accountId,
    refetchInterval: 60_000,
  });

  const { data: trades = [] } = useQuery({
    queryKey: ["paper-trades", accountId],
    queryFn: () => apiListPaperTrades(accountId as string),
    enabled: !!accountId,
  });

  const stockSymbols = useMemo(() => {
    const fromCsv = histories.map((h) => h.symbol.toUpperCase());
    const merged = Array.from(new Set([...fromCsv, ...ALL_NSE_STOCKS]));
    return merged.sort();
  }, [histories]);

  const underlyingSymbols = useMemo(() => {
    const fromCsv = optionsData ? Array.from(optionsData.expiriesBySymbol.keys()) : [];
    const merged = Array.from(new Set([...ALL_FUTURES_SYMBOLS, ...fromCsv]));
    return merged.sort();
  }, [optionsData]);

  async function handleCloseAll() {
    const count = positionsWithPnl.length;
    if (count === 0) return;
    if (!confirm(`Close all ${count} open position${count === 1 ? "" : "s"} at current LTP? This cannot be undone.`)) return;
    setClosingAll(true);
    const date = todayIso();
    await Promise.allSettled(
      positionsWithPnl.map((p) =>
        apiClosePaperPosition(accountId as string, p.id, {
          qty_closed: p.qty,
          exit_price: p.ltp ?? p.entry_price,
          exit_date: date,
        })
      )
    );
    setClosingAll(false);
    qc.invalidateQueries({ queryKey: ["paper-accounts"] });
    qc.invalidateQueries({ queryKey: ["paper-positions", accountId] });
    qc.invalidateQueries({ queryKey: ["paper-trades", accountId] });
  }

  function handleExportTradesCsv() {
    if (trades.length === 0) return;
    const headers = [
      "Type", "Symbol", "Underlying", "Strike", "Option Type", "Expiry", "Side",
      "Lot", "Qty", "Entry Price", "Exit Price", "Realized P&L", "Entry Date", "Exit Date",
    ];
    const escape = (v: string | number | null | undefined) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = trades.map((t) => [
      t.instrument_type === "option" ? "Option" : t.instrument_type === "future" ? "Future" : "Stock",
      t.symbol,
      t.underlying ?? "",
      t.strike ?? "",
      t.option_type ?? "",
      t.expiry ? fmtDate(t.expiry) : "",
      t.side === "long" ? "BUY" : "SELL",
      t.instrument_type === "stock" ? "" : t.qty,
      t.instrument_type === "stock" ? t.qty : t.qty * t.lot_size,
      t.entry_price,
      t.exit_price,
      t.realized_pnl,
      fmtDate(t.entry_date),
      fmtDate(t.exit_date),
    ].map(escape).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trade-history-${todayIso()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function getCurrentLtp(p: ApiPaperPosition): number | null {
    if (p.instrument_type === "stock") return getStockLtp(histories, p.symbol, asOfDate);
    if (p.instrument_type === "future") return getStockLtp(histories, p.underlying ?? p.symbol, asOfDate);
    if (!optionsData || !p.underlying || !p.expiry || p.strike === null || !p.option_type) return null;
    const bars = optionsData.bars.filter(
      (b) => b.symbol === p.underlying && b.expiry === p.expiry && b.strike === p.strike && b.type === p.option_type
    );
    if (!bars.length) return null;
    const cap = asOfOptionsDate;
    let best: typeof bars[number] | null = null;
    for (const b of bars) {
      if (cap && b.date > cap) continue;
      if (!best || b.date > best.date) best = b;
    }
    return best?.close ?? null;
  }

  const positionsWithPnl = useMemo(() => {
    return positions.map((p) => {
      // Prefer backend-enriched current_price (from live broker quotes via getLiveQuotes),
      // fall back to client-side lookup from CSV/DB history.
      const ltp = p.current_price ?? getCurrentLtp(p);
      const pnl = ltp === null ? null : p.side === "long"
        ? (ltp - p.entry_price) * p.qty * p.lot_size
        : (p.entry_price - ltp) * p.qty * p.lot_size;
      const pnlPct = ltp === null ? null : p.side === "long"
        ? ((ltp - p.entry_price) / p.entry_price) * 100
        : ((p.entry_price - ltp) / p.entry_price) * 100;
      return { ...p, ltp, pnl, pnlPct };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });
  }, [positions, histories, optionsData, asOfDate, asOfOptionsDate, tick]);

  const filteredPositions = useMemo(() => {
    if (positionFilter === "all") return positionsWithPnl;
    return positionsWithPnl.filter((p) => p.instrument_type === positionFilter);
  }, [positionsWithPnl, positionFilter]);

  const pnlChartData = useMemo(() => {
    if (trades.length === 0) return [];
    const sorted = [...trades].sort((a, b) => a.exit_date.localeCompare(b.exit_date));
    const byDate = new Map<string, number>();
    for (const t of sorted) byDate.set(t.exit_date, (byDate.get(t.exit_date) ?? 0) + t.realized_pnl);
    let cumulative = 0;
    return Array.from(byDate.entries()).map(([date, daily]) => {
      cumulative += daily;
      return { date: fmtDate(date), daily, cumulative };
    });
  }, [trades]);

  const unrealizedPnl = positionsWithPnl.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const totalEquity = (account?.cash_balance ?? 0) + (account?.invested ?? 0) + unrealizedPnl;
  const returnPct = account && account.starting_balance > 0
    ? ((totalEquity - account.starting_balance) / account.starting_balance) * 100
    : 0;

  // ── Live feed / market-hours status ─────────────────────────────────────
  const { data: schedulerStatus } = useQuery({
    queryKey: ["paper-scheduler-status"],
    queryFn: apiGetSchedulerStatus,
    refetchInterval: 60_000,
    retry: false,
  });
  const liveFeedActive = !!(
    schedulerStatus?.liveFeed.marketOpenNow && schedulerStatus?.liveFeed.connected
  );

  const createAccountMut = useMutation({
    mutationFn: apiCreatePaperAccount,
    onSuccess: (acc) => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      setAccountId(acc.id);
      setShowNewAccount(false);
      toast.success("Paper trading account created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addFundsMut = useMutation({
    mutationFn: (amount: number) => apiUpdatePaperAccount(accountId as string, { add_funds: amount }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      setShowAddFunds(false);
      toast.success("Funds added");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resetMut = useMutation({
    mutationFn: () => apiResetPaperAccount(accountId as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      qc.invalidateQueries({ queryKey: ["paper-positions", accountId] });
      qc.invalidateQueries({ queryKey: ["paper-trades", accountId] });
      toast.success("Account reset to starting balance");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteAccountMut = useMutation({
    mutationFn: () => apiDeletePaperAccount(accountId as string),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      setAccountId(null);
      toast.success("Account deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const openPositionMut = useMutation({
    mutationFn: (body: Parameters<typeof apiOpenPaperPosition>[1]) => apiOpenPaperPosition(accountId as string, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      qc.invalidateQueries({ queryKey: ["paper-positions", accountId] });
      setShowStockTrade(false);
      setShowFuturesTrade(false);
      toast.success("Order executed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleOptionsBasketSubmit(legs: DraftLeg[]) {
    if (!accountId) return;
    setOptionsSubmitting(true);
    let ok = 0;
    for (const leg of legs) {
      try {
        await apiOpenPaperPosition(accountId, {
          instrument_type: "option",
          symbol: `${leg.underlying}${leg.strike}${leg.type}`,
          underlying: leg.underlying,
          strike: leg.strike,
          option_type: leg.type,
          expiry: leg.expiry,
          side: leg.action === "BUY" ? "long" : "short",
          qty: leg.lots,
          lot_size: leg.lotSize,
          entry_price: leg.entryPrice,
          entry_date: todayIso(),
        });
        ok++;
      } catch {
        toast.error(`Failed: ${leg.underlying} ${leg.strike}${leg.type}`);
      }
    }
    setOptionsSubmitting(false);
    if (ok > 0) {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      qc.invalidateQueries({ queryKey: ["paper-positions", accountId] });
      setShowOptionsTrade(false);
      toast.success(`${ok} order${ok !== 1 ? "s" : ""} placed`);
    }
  }

  const closePositionMut = useMutation({
    mutationFn: (body: { positionId: string; qty_closed: number; exit_price: number; exit_date: string }) =>
      apiClosePaperPosition(accountId as string, body.positionId, body),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["paper-accounts"] });
      qc.invalidateQueries({ queryKey: ["paper-positions", accountId] });
      qc.invalidateQueries({ queryKey: ["paper-trades", accountId] });
      setClosingPosition(null);
      toast.success(`Position closed — realized P&L ${fmtPnl(res.realized_pnl)}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="px-3 pb-3 pt-1 space-y-1.5 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-foreground flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" /> Paper Trading
          </h1>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Practice stocks & options with a virtual budget — zero real money risk.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={accountId ?? ""}
            onChange={(e) => setAccountId(e.target.value)}
            className="bg-background border border-border rounded-lg px-2 py-0.5 text-[11px] text-foreground focus:outline-none"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNewAccount(true)}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold border border-border rounded-lg text-foreground hover:bg-muted/40 transition"
          >
            <Plus className="h-3 w-3" /> New Account
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-muted/30 border border-border rounded-lg px-3 py-1">
        <Radio className="h-3 w-3 text-primary shrink-0" />
        P&L refreshes every 1 minute from the latest broker quote. Live streaming will switch on automatically once the Fyers feed is connected — no changes needed on your side.
      </div>

      {!account ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No paper trading account yet. Create one to get started.
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-1.5">
            <StatCard label="Cash Balance" value={fmtRs(account.cash_balance)} icon={Wallet} />
            <StatCard label="Invested (Margin)" value={fmtRs(account.invested)} icon={Settings2} />
            <StatCard label="Unrealized P&L" value={fmtPnl(unrealizedPnl)} icon={unrealizedPnl >= 0 ? TrendingUp : TrendingDown} tone={unrealizedPnl >= 0 ? "up" : "down"} />
            <StatCard label="Realized P&L" value={fmtPnl(account.realizedPnl)} icon={History} tone={account.realizedPnl >= 0 ? "up" : "down"} />
            <StatCard label="Total Equity" value={fmtRs(totalEquity)} icon={Wallet} />
            <StatCard label="Overall Return" value={`${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`} icon={returnPct >= 0 ? TrendingUp : TrendingDown} tone={returnPct >= 0 ? "up" : "down"} />
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setShowStockTrade(true)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-primary/60 text-primary rounded-lg hover:bg-primary/10 active:scale-95 transition"
            >
              <Plus className="h-3 w-3" /> Trade in Stocks
            </button>
            <button
              onClick={() => setShowFuturesTrade(true)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-amber-500/50 text-amber-400 rounded-lg hover:bg-amber-500/10 active:scale-95 transition"
            >
              <Plus className="h-3 w-3" /> Trade in Futures
            </button>
            <button
              onClick={() => setShowOptionsTrade(true)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-purple-500/50 text-purple-400 rounded-lg hover:bg-purple-500/10 active:scale-95 transition"
            >
              <Plus className="h-3 w-3" /> Trade in Options
            </button>
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                onClick={() => setShowAddFunds(true)}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-border rounded-lg text-foreground hover:bg-muted/40 transition"
              >
                <Wallet className="h-3 w-3" /> Add Funds
              </button>
              <button
                onClick={() => { if (confirm("Reset this account back to its starting balance? All open positions and trade history will be cleared.")) resetMut.mutate(); }}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 transition"
              >
                <RefreshCw className="h-3 w-3" /> Reset Account
              </button>
              <button
                onClick={() => { if (confirm("Delete this paper trading account permanently?")) deleteAccountMut.mutate(); }}
                className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold border border-border rounded-lg text-red-500 hover:bg-red-500/10 transition"
              >
                <Trash2 className="h-3 w-3" /> Delete Account
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border">
            {(["positions", "history"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-xs font-semibold transition border-b-2 ${
                  tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t === "positions" ? `Open Positions (${positions.length})` : `Trade History (${trades.length})`}
              </button>
            ))}
            {tab === "positions" && (
              <div className="ml-auto flex items-center gap-1.5 mr-1">
                {([
                  { key: "all", label: "All", count: positionsWithPnl.length, activeCls: "bg-primary text-primary-foreground", countCls: "text-primary-foreground/80" },
                  { key: "stock", label: "Stocks", count: positionsWithPnl.filter(p => p.instrument_type === "stock").length, activeCls: "bg-primary text-primary-foreground", countCls: "text-primary-foreground/80" },
                  { key: "future", label: "Futures", count: positionsWithPnl.filter(p => p.instrument_type === "future").length, activeCls: "bg-amber-500 text-black", countCls: "text-black/70" },
                  { key: "option", label: "Options", count: positionsWithPnl.filter(p => p.instrument_type === "option").length, activeCls: "bg-purple-500 text-white", countCls: "text-white/80" },
                ] as const).map(({ key, label, count, activeCls, countCls }) => (
                  <button key={key} onClick={() => setPositionFilter(key)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold transition ${positionFilter === key ? activeCls : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/70"}`}>
                    {label} <span className={`text-[10px] font-bold ${positionFilter === key ? countCls : "text-muted-foreground/60"}`}>{count}</span>
                  </button>
                ))}
                {positionsWithPnl.length > 0 && (
                  <button onClick={handleCloseAll} disabled={closingAll}
                    className="ml-1 flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold border border-red-500/50 text-red-500 rounded-lg hover:bg-red-500/10 active:scale-95 transition disabled:opacity-50">
                    {closingAll ? <><RefreshCw className="h-3 w-3 animate-spin" /> Closing…</> : <><XCircle className="h-3 w-3" /> Close All</>}
                  </button>
                )}
              </div>
            )}
            {tab === "history" && (
              <div className="ml-auto flex items-center mr-1">
                <button
                  onClick={handleExportTradesCsv}
                  disabled={trades.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold border border-border rounded-lg text-foreground hover:bg-muted/40 active:scale-95 transition disabled:opacity-50"
                >
                  <Download className="h-3 w-3" /> Download CSV
                </button>
              </div>
            )}
          </div>

          {tab === "positions" ? (
            <Card className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground uppercase tracking-wide">
                    <th className="text-left px-3 py-2 text-[9px] font-semibold w-[80px]">Type</th>
                    <th className="text-left px-3 py-2 text-[9px] font-semibold">Instrument</th>
                    <th className="text-left px-3 py-2 text-[9px] font-semibold">Side</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Lot</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Qty</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Entry</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">LTP</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">P&L</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">P&L %</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Entry Date</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPositions.length === 0 && (
                    <tr><td colSpan={10} className="text-center py-6 text-xs text-muted-foreground">
                      {positionsWithPnl.length === 0 ? "No open positions. Place a new trade to get started." : `No ${positionFilter} positions.`}
                    </td></tr>
                  )}
                  {filteredPositions.map((p) => (
                    <tr key={p.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-3 py-2 align-top">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                          p.instrument_type === "option"
                            ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                            : p.instrument_type === "future"
                            ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                            : "bg-primary/15 text-primary border border-primary/30"
                        }`}>
                          {p.instrument_type === "option" ? "Option" : p.instrument_type === "future" ? "Future" : "Stock"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-xs font-semibold text-foreground">{p.symbol}</div>
                        {p.instrument_type === "option" && (
                          <div className="text-[10px] text-muted-foreground">
                            {p.underlying} {p.strike} {p.option_type} · {fmtDate(p.expiry ?? "")} · lot {p.lot_size}
                          </div>
                        )}
                        {p.instrument_type === "future" && (
                          <div className="text-[10px] text-muted-foreground">
                            {p.underlying} FUT · {fmtDate(p.expiry ?? "")} · lot {p.lot_size}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold ${p.side === "long" ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
                          {p.side === "long" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                          {p.side === "long" ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">
                        {p.instrument_type === "stock" ? "-" : p.qty}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">
                        {p.instrument_type === "stock" ? p.qty : p.qty * p.lot_size}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">{fmtRs(p.entry_price, 2)}</td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">{p.ltp === null ? "—" : fmtRs(p.ltp, 2)}</td>
                      <td className={`px-3 py-2 text-right text-xs font-semibold ${p.pnl === null ? "text-muted-foreground" : pnlClass(p.pnl)}`}>
                        {p.pnl === null ? "—" : fmtPnl(p.pnl)}
                      </td>
                      <td className={`px-3 py-2 text-right text-xs font-semibold ${p.pnlPct === null ? "text-muted-foreground" : pnlClass(p.pnlPct)}`}>
                        {p.pnlPct === null ? "—" : `${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(2)}%`}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtDate(p.entry_date)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setClosingPosition(p)}
                          className="px-2 py-0.5 text-[11px] font-semibold border border-border rounded-md text-foreground hover:bg-muted/40 transition"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <>
            {pnlChartData.length > 0 && (() => {
              const lastPnl = pnlChartData[pnlChartData.length - 1].cumulative;
              const isPos = lastPnl >= 0;
              const color = isPos ? "#10b981" : "#ef4444";
              return (
                <Card className="p-4 mb-2">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Cumulative Realized P&L</span>
                    <span className={`text-sm font-bold ${isPos ? "text-emerald-400" : "text-red-400"}`}>{fmtPnl(lastPnl)}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={130}>
                    <AreaChart data={pnlChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="cumPnlGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#6b7280" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "#6b7280" }} axisLine={false} tickLine={false}
                        tickFormatter={(v) => v >= 1000 || v <= -1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`} width={52} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                      <ChartTooltip
                        contentStyle={{ background: "#1a1f2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 11 }}
                        formatter={(v: number, name: string) => [fmtPnl(v), name === "cumulative" ? "Cumulative P&L" : "Daily P&L"]}
                        labelStyle={{ color: "#9ca3af", marginBottom: 4 }}
                      />
                      <Area type="monotone" dataKey="cumulative" stroke={color} strokeWidth={1.5} fill="url(#cumPnlGrad)" dot={false} activeDot={{ r: 3 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </Card>
              );
            })()}
            <Card className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-muted-foreground uppercase tracking-wide">
                    <th className="text-left px-3 py-2 text-[9px] font-semibold w-[80px]">Type</th>
                    <th className="text-left px-3 py-2 text-[9px] font-semibold">Instrument</th>
                    <th className="text-left px-3 py-2 text-[9px] font-semibold">Side</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Lot</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Qty</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Entry</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Exit</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Realized P&L</th>
                    <th className="text-right px-3 py-2 text-[9px] font-semibold">Entry → Exit Date</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 && (
                    <tr><td colSpan={9} className="text-center py-6 text-xs text-muted-foreground">No closed trades yet.</td></tr>
                  )}
                  {trades.map((t) => (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-muted/20">
                      <td className="px-3 py-2 align-top">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide ${
                          t.instrument_type === "option"
                            ? "bg-purple-500/15 text-purple-400 border border-purple-500/30"
                            : t.instrument_type === "future"
                            ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                            : "bg-primary/15 text-primary border border-primary/30"
                        }`}>
                          {t.instrument_type === "option" ? "Option" : t.instrument_type === "future" ? "Future" : "Stock"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-xs font-semibold text-foreground">{t.symbol}</div>
                        {t.instrument_type === "option" && (
                          <div className="text-[10px] text-muted-foreground">
                            {t.underlying} {t.strike} {t.option_type} · {fmtDate(t.expiry ?? "")}
                          </div>
                        )}
                        {t.instrument_type === "future" && (
                          <div className="text-[10px] text-muted-foreground">
                            {t.underlying} FUT · {fmtDate(t.expiry ?? "")}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${t.side === "long" ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>
                          {t.side === "long" ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">
                        {t.instrument_type === "stock" ? "-" : t.qty}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">
                        {t.instrument_type === "stock" ? t.qty : t.qty * t.lot_size}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">{fmtRs(t.entry_price, 2)}</td>
                      <td className="px-3 py-2 text-right text-xs text-foreground">{fmtRs(t.exit_price, 2)}</td>
                      <td className={`px-3 py-2 text-right text-xs font-semibold ${pnlClass(t.realized_pnl)}`}>{fmtPnl(t.realized_pnl)}</td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtDate(t.entry_date)} → {fmtDate(t.exit_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            </>
          )}
        </>
      )}

      {showNewAccount && (
        <NewAccountModal onClose={() => setShowNewAccount(false)} onCreate={(name, bal) => createAccountMut.mutate({ name, starting_balance: bal })} pending={createAccountMut.isPending} />
      )}

      {showAddFunds && account && (
        <AddFundsModal onClose={() => setShowAddFunds(false)} onAdd={(amt) => addFundsMut.mutate(amt)} pending={addFundsMut.isPending} />
      )}

      {showStockTrade && account && (
        <NewTradeModal
          forcedMode="stock"
          onClose={() => setShowStockTrade(false)}
          stockSymbols={stockSymbols}
          underlyingSymbols={underlyingSymbols}
          optionsData={optionsData}
          histories={histories}
          asOfDate={asOfDate}
          asOfOptionsDate={asOfOptionsDate}
          cashBalance={account.cash_balance}
          lotSizes={csvLotSizes}
          pending={openPositionMut.isPending}
          onSubmit={(body) => openPositionMut.mutate(body)}
          liveFeedActive={liveFeedActive}
        />
      )}
      {showFuturesTrade && account && (
        <TradeInFuturesModal
          onClose={() => setShowFuturesTrade(false)}
          underlyingSymbols={underlyingSymbols}
          histories={histories}
          asOfDate={asOfDate}
          cashBalance={account.cash_balance}
          lotSizes={csvLotSizes}
          optionsData={optionsData}
          pending={openPositionMut.isPending}
          onSubmit={(body) => openPositionMut.mutate(body)}
          liveFeedActive={liveFeedActive}
        />
      )}
      {showOptionsTrade && account && (
        <OptionsChainTradeFlow
          optionsData={optionsData}
          lotSizes={csvLotSizes}
          cashBalance={account.cash_balance}
          underlyingSymbols={underlyingSymbols}
          onClose={() => setShowOptionsTrade(false)}
          onConfirm={handleOptionsBasketSubmit}
          submitting={optionsSubmitting}
        />
      )}

      {closingPosition && (
        <CloseTradeModal
          position={closingPosition}
          currentLtp={getCurrentLtp(closingPosition)}
          onClose={() => setClosingPosition(null)}
          pending={closePositionMut.isPending}
          onSubmit={(qty, price) => closePositionMut.mutate({ positionId: closingPosition.id, qty_closed: qty, exit_price: price, exit_date: todayIso() })}
        />
      )}
    </div>
  );
}

// ─── New Account Modal ───────────────────────────────────────────────────────

function NewAccountModal({ onClose, onCreate, pending }: { onClose: () => void; onCreate: (name: string, balance: number) => void; pending: boolean }) {
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("1000000");
  const canCreate = !!name.trim() && !!Number(balance) && !pending;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (canCreate) onCreate(name.trim(), Number(balance)); } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [canCreate, name, balance, pending, onCreate]);
  return (
    <Modal title="New Paper Trading Account" onClose={onClose}>
      <div className="space-y-3">
        <FormField label="Account Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Options Practice" autoFocus />
        </FormField>
        <FormField label="Starting Virtual Balance (₹)">
          <input className={inputCls} type="number" value={balance} onChange={(e) => setBalance(e.target.value)} />
        </FormField>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 transition">Cancel</button>
          <button
            disabled={!name.trim() || !Number(balance) || pending}
            onClick={() => onCreate(name.trim(), Number(balance))}
            className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AddFundsModal({ onClose, onAdd, pending }: { onClose: () => void; onAdd: (amount: number) => void; pending: boolean }) {
  const [amount, setAmount] = useState("100000");
  const canAdd = !!Number(amount) && !pending;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (canAdd) onAdd(Number(amount)); } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [canAdd, amount, pending, onAdd]);
  return (
    <Modal title="Add Virtual Funds" onClose={onClose}>
      <div className="space-y-3">
        <FormField label="Amount (₹)">
          <input className={inputCls} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </FormField>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 transition">Cancel</button>
          <button
            disabled={!Number(amount) || pending}
            onClick={() => onAdd(Number(amount))}
            className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition"
          >
            Add Funds
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── New Trade Modal ─────────────────────────────────────────────────────────

type OrderValidity = "intraday" | "normal";
type PriceTab = "market" | "limit" | "trigger" | "super";

function SpinnerInput({ label, sublabel, value, onChange, step = 0.05, min = 0, disabled = false, narrow = false }: {
  label: string; sublabel?: string; value: string; onChange: (v: string) => void;
  step?: number; min?: number; disabled?: boolean; narrow?: boolean;
}) {
  const num = parseFloat(value) || 0;
  const inc = () => onChange(String(parseFloat((num + step).toFixed(2))));
  const dec = () => onChange(String(parseFloat(Math.max(min, num - step).toFixed(2))));
  return (
    <div className={`border border-border rounded-lg overflow-hidden ${disabled ? "opacity-40" : ""} ${narrow ? "w-[106px] shrink-0" : "flex-1"}`}>
      {label ? (
        <div className="flex items-center gap-1.5 px-2 pt-1 pb-0 leading-none">
          <span className="text-[9px] font-semibold text-muted-foreground">{label}</span>
          {sublabel && <span className="text-[9px] text-muted-foreground/50">{sublabel}</span>}
        </div>
      ) : null}
      <div className="flex items-center">
        <input
          className="w-full bg-transparent px-2 py-1 text-sm font-semibold text-foreground focus:outline-none
            [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          type="number"
          value={value}
          min={min}
          step={step}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="flex flex-col border-l border-border shrink-0">
          <button type="button" onClick={inc} disabled={disabled} className="px-1.5 py-px hover:bg-muted/40 text-muted-foreground text-[9px] leading-none border-b border-border">▲</button>
          <button type="button" onClick={dec} disabled={disabled} className="px-1.5 py-px hover:bg-muted/40 text-muted-foreground text-[9px] leading-none">▼</button>
        </div>
      </div>
    </div>
  );
}

function NewTradeModal({
  onClose, stockSymbols, underlyingSymbols, optionsData, histories, asOfDate, asOfOptionsDate, cashBalance, lotSizes: csvLotSizes, onSubmit, pending, forcedMode, liveFeedActive,
}: {
  onClose: () => void;
  stockSymbols: string[];
  underlyingSymbols: string[];
  optionsData: ReturnType<typeof useData>["optionsData"];
  histories: ReturnType<typeof useData>["histories"];
  asOfDate: string | null;
  asOfOptionsDate: string | null;
  cashBalance: number;
  lotSizes: ReturnType<typeof useData>["lotSizes"];
  onSubmit: (body: Parameters<typeof apiOpenPaperPosition>[1]) => void;
  pending: boolean;
  forcedMode?: "stock" | "options";
  liveFeedActive: boolean;
}) {
  const [instrumentType, setInstrumentType] = useState<InstrumentType>(forcedMode === "options" ? "option" : "stock");
  const [side, setSide] = useState<PositionSide>("long");
  const [symbol, setSymbol] = useState("");
  const [qty, setQty] = useState("1");
  const [priceTab, setPriceTab] = useState<PriceTab>("market");
  const [validity, setValidity] = useState<OrderValidity>("intraday");
  const [showOptions, setShowOptions] = useState(forcedMode === "options");

  const [limitPrice, setLimitPrice] = useState("");
  const [limitPriceTouched, setLimitPriceTouched] = useState(false);
  const [triggerPrice, setTriggerPrice] = useState("");

  const [superLimitEnabled, setSuperLimitEnabled] = useState(false);
  const [superLimitPrice, setSuperLimitPrice] = useState("");
  const [superTargetEnabled, setSuperTargetEnabled] = useState(false);
  const [superTarget, setSuperTarget] = useState("");
  const [superSlEnabled, setSuperSlEnabled] = useState(false);
  const [superSl, setSuperSl] = useState("");
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailJump, setTrailJump] = useState("");

  const [underlying, setUnderlying] = useState("");
  const [expiry, setExpiry] = useState("");
  const [optionType, setOptionType] = useState<OptionType>("CE");
  const [strike, setStrike] = useState<number | null>(null);
  const [lotSize, setLotSize] = useState("1");

  const expiries = useMemo(() => (optionsData && underlying ? optionsData.expiriesBySymbol.get(underlying) ?? [] : []), [optionsData, underlying]);
  const strikes = useMemo(() => (optionsData && underlying && expiry ? optionsData.strikesByKey.get(`${underlying}|${expiry}`) ?? [] : []), [optionsData, underlying, expiry]);

  useEffect(() => {
    if (!underlying) return;
    const ls = getLotSizeForExpiry(
      csvLotSizes, underlying, expiry || "9999-12",
      DEFAULT_LOT_SIZES[underlying],
    );
    if (ls) setLotSize(String(ls));
  }, [underlying, expiry, csvLotSizes]);

  // CSV/DB-derived price — used as fallback when broker is offline
  const csvAutoPrice = useMemo(() => {
    if (instrumentType === "stock") {
      if (!symbol) return null;
      return getStockLtp(histories, symbol, asOfDate);
    }
    if (!optionsData || !underlying || !expiry || strike === null) return null;
    const bars = optionsData.bars.filter((b) => b.symbol === underlying && b.expiry === expiry && b.strike === strike && b.type === optionType);
    if (!bars.length) return null;
    const cap = asOfOptionsDate;
    let best: typeof bars[number] | null = null;
    for (const b of bars) {
      if (cap && b.date > cap) continue;
      if (!best || b.date > best.date) best = b;
    }
    return best?.close ?? null;
  }, [instrumentType, symbol, underlying, expiry, strike, optionType, histories, optionsData, asOfDate, asOfOptionsDate]);

  // Live broker quote — fetched whenever a stock symbol is chosen
  const quoteSymbol = instrumentType === "stock" ? symbol : null;
  const { data: liveQuoteData } = useQuery({
    queryKey: ["paper-live-quote", quoteSymbol],
    queryFn: () => apiGetPaperQuotes([quoteSymbol as string]),
    enabled: !!quoteSymbol,
    staleTime: 30_000,
    retry: false,
    // Don't throw — silently fall back to CSV price if broker unavailable
  });
  const liveQuote = liveQuoteData?.[0] ?? null;

  // autoPrice: prefer live broker LTP, fall back to CSV
  const autoPrice = (liveQuote?.ltp ?? csvAutoPrice);
  // prevClosePrice: use real broker prev-close (Quote.close = yesterday's close in Fyers)
  const prevClosePrice: number | null = liveQuote?.close ?? null;
  const priceDiff = autoPrice !== null && prevClosePrice !== null ? autoPrice - prevClosePrice : null;
  const priceDiffPct = priceDiff !== null && prevClosePrice !== null && prevClosePrice > 0
    ? (priceDiff / prevClosePrice) * 100
    : null;

  useEffect(() => {
    if (!limitPriceTouched && autoPrice !== null) {
      setLimitPrice(String(autoPrice));
      setTriggerPrice(String(parseFloat((autoPrice * 0.995).toFixed(2))));
      setSuperLimitPrice(String(autoPrice));
      setSuperTarget(String(parseFloat((autoPrice * 1.05).toFixed(2))));
      setSuperSl(String(parseFloat((autoPrice * 0.97).toFixed(2))));
    }
  }, [autoPrice, limitPriceTouched]);

  const effLotSize = instrumentType === "option" ? (Number(lotSize) || 1) : 1;

  const effectivePrice = (() => {
    if (priceTab === "market") return autoPrice ?? 0;
    if (priceTab === "limit") return Number(limitPrice) || 0;
    if (priceTab === "trigger") return Number(limitPrice) || 0;
    if (priceTab === "super") return superLimitEnabled ? (Number(superLimitPrice) || 0) : (autoPrice ?? 0);
    return 0;
  })();

  const notional = (Number(qty) || 0) * effLotSize * effectivePrice;
  const insufficientFunds = notional > cashBalance && notional > 0;

  const instrumentLabel = instrumentType === "stock"
    ? (symbol || "—")
    : underlying && expiry && strike
      ? `${underlying} ${fmtDate(expiry)} ${strike} ${optionType}`
      : (underlying || "—");

  const canSubmit = (() => {
    const hasSymbol = instrumentType === "stock" ? !!symbol : (!!underlying && !!expiry && strike !== null);
    const hasQty = Number(qty) > 0;
    const hasPrice = priceTab === "market" ? true : Number(effectivePrice) > 0;
    return hasSymbol && hasQty && hasPrice && !insufficientFunds && liveFeedActive;
  })();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        if (canSubmit && !pending) submit();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canSubmit, pending, onClose]);

  function submit() {
    const entryPrice = priceTab === "market" ? (autoPrice ?? effectivePrice) : effectivePrice;
    if (instrumentType === "stock") {
      onSubmit({ instrument_type: "stock", symbol, side, qty: Number(qty), lot_size: 1, entry_price: entryPrice, entry_date: todayIso() });
    } else {
      onSubmit({
        instrument_type: "option",
        symbol: `${underlying}${strike}${optionType}`,
        underlying, strike: Number(strike), option_type: optionType, expiry,
        side, qty: Number(qty), lot_size: effLotSize, entry_price: entryPrice, entry_date: todayIso(),
      });
    }
  }

  const PRICE_TABS: { id: PriceTab; label: string; beta?: boolean }[] = [
    { id: "market", label: "Market" },
    { id: "limit", label: "Limit" },
    { id: "trigger", label: "Trigger" },
    { id: "super", label: "Super", beta: true },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-[#1a1f2e] border border-border/60 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

        {/* ── Instrument selector row ── */}
        <div className="px-3 pt-2.5 pb-2 border-b border-border/40">
          <div className="flex gap-2 items-center">
            {forcedMode ? (
              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted/40 border border-border rounded shrink-0">
                {forcedMode === "stock" ? "EQUITY" : "F&O"}
              </div>
            ) : (
              <div className="flex rounded-md overflow-hidden border border-border shrink-0">
                {(["stock", "option"] as const).map((t) => (
                  <button key={t}
                    onClick={() => { setInstrumentType(t); setSymbol(""); setUnderlying(""); setExpiry(""); setStrike(null); setLimitPriceTouched(false); setShowOptions(false); }}
                    className={`px-3 py-1 text-xs font-semibold transition-colors ${instrumentType === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground bg-transparent"}`}>
                    {t === "stock" ? "Stocks" : "F&O"}
                  </button>
                ))}
              </div>
            )}
            <div className="flex-1 min-w-0">
              {instrumentType === "stock" ? (
                <SymbolPicker symbols={stockSymbols} value={symbol} onChange={(v) => { setSymbol(v); setLimitPriceTouched(false); }} placeholder="Search NSE stock…" />
              ) : (
                <SymbolPicker symbols={underlyingSymbols} value={underlying} onChange={(v) => { setUnderlying(v); setExpiry(""); setStrike(null); setLimitPriceTouched(false); }} placeholder="Search F&O symbol…" />
              )}
            </div>
          </div>
        </div>

        {/* ── Title + LTP ── */}
        <div className="px-4 pt-3 flex items-start justify-between">
          <div>
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{instrumentLabel}</div>
            {autoPrice !== null ? (
              <div className="flex items-baseline gap-2">
                {/* Green pulsing dot — only when broker is live and market is open */}
                {liveQuote !== null && liveFeedActive && (
                  <span className="relative flex h-2 w-2 self-center mr-0.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                )}
                <span className="text-2xl font-bold text-foreground">{autoPrice.toFixed(2)}</span>
                {priceDiff !== null && (
                  <span className={`text-xs font-semibold ${priceDiff >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {priceDiff >= 0 ? "+" : ""}{priceDiff.toFixed(2)} ({priceDiff >= 0 ? "+" : ""}{priceDiffPct!.toFixed(2)}%) {priceDiff >= 0 ? "↗" : "↘"}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic">No price — use Limit tab</div>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors mt-0.5">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Trading / Normal pills + Cancel + Buy●Sell slider ── */}
        <div className="px-4 pt-2.5 pb-0 flex items-center justify-between">
          <div className="flex gap-1.5">
            {(["intraday", "normal"] as const).map((v) => (
              <button key={v} onClick={() => setValidity(v)}
                className={`px-3 py-1 text-xs font-semibold rounded border transition ${validity === v ? "border-primary/60 bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:border-border"}`}>
                {v === "intraday" ? "Trading" : "Normal"}
              </button>
            ))}
          </div>
          {/* Buy ●─ Sell slider */}
          <button
            onClick={() => setSide(side === "long" ? "short" : "long")}
            className="flex items-center gap-1.5 text-xs font-semibold"
            aria-label="Toggle Buy/Sell"
          >
            <span className={side === "long" ? "text-foreground" : "text-muted-foreground"}>Buy</span>
            <div className={`relative w-9 h-5 rounded-full transition-colors ${side === "long" ? "bg-primary" : "bg-red-500"}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${side === "long" ? "left-0.5" : "left-[18px]"}`} />
            </div>
            <span className={side === "short" ? "text-foreground" : "text-muted-foreground"}>Sell</span>
          </button>
        </div>

        {/* ── Price tabs ── */}
        <div className="px-4 pt-2 flex items-end gap-0 border-b border-border/40">
          {PRICE_TABS.map((pt) => (
            <button key={pt.id} onClick={() => setPriceTab(pt.id)}
              className={`px-3 py-2 text-xs font-semibold border-b-2 transition -mb-px flex items-center gap-1 ${priceTab === pt.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {pt.label}
              {pt.beta && <span className="text-[8px] font-bold bg-amber-500/20 text-amber-400 rounded px-1 py-0.5 leading-none">beta</span>}
            </button>
          ))}
        </div>

        {/* ── Order body ── */}
        <div className="px-4 py-3 space-y-3">

          {/* shared label style: fixed 16px height so spinners always start at the same y */}
          {/* Market tab */}
          {priceTab === "market" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Market Price</span>
                </div>
                <div className="border border-border/50 rounded-lg flex items-center gap-1.5 px-2 opacity-60" style={{height: "calc(1rem + 14px)"}}>
                  <span className="text-sm font-semibold text-foreground">Market</span>
                  <span className="text-muted-foreground text-xs">🔒</span>
                </div>
              </div>
            </div>
          )}

          {/* Limit tab */}
          {priceTab === "limit" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Limit Price</span>
                </div>
                <SpinnerInput label="" value={limitPrice} onChange={(v) => { setLimitPrice(v); setLimitPriceTouched(true); }} step={0.05} min={0} />
              </div>
            </div>
          )}

          {/* Trigger tab */}
          {priceTab === "trigger" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Limit Price</span>
                </div>
                <SpinnerInput label="" value={limitPrice} onChange={(v) => { setLimitPrice(v); setLimitPriceTouched(true); }} step={0.05} min={0} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Trigger Price</span>
                </div>
                <SpinnerInput label="" value={triggerPrice} onChange={setTriggerPrice} step={0.05} min={0} />
              </div>
            </div>
          )}

          {/* Super tab */}
          {priceTab === "super" && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="w-[106px] shrink-0">
                  <div className="h-4 flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] font-semibold text-muted-foreground">Lot</span>
                    <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                  </div>
                  <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
                </div>
                <div className="flex-1">
                  <div className="h-4 flex items-center gap-1 mb-1">
                    <input type="checkbox" id="sl-limit" checked={superLimitEnabled} onChange={(e) => setSuperLimitEnabled(e.target.checked)} className="accent-primary w-3 h-3" />
                    <label htmlFor="sl-limit" className="text-[10px] text-muted-foreground font-semibold">Limit Price</label>
                  </div>
                  <SpinnerInput label="" value={superLimitPrice} onChange={setSuperLimitPrice} step={0.05} min={0} disabled={!superLimitEnabled} />
                </div>
                <div className="flex-1">
                  <div className="h-4 flex items-center gap-1 mb-1">
                    <input type="checkbox" id="sl-target" checked={superTargetEnabled} onChange={(e) => setSuperTargetEnabled(e.target.checked)} className="accent-emerald-500 w-3 h-3" />
                    <label htmlFor="sl-target" className="text-[10px] text-emerald-400 font-semibold">Target</label>
                  </div>
                  <SpinnerInput label="" value={superTarget} onChange={setSuperTarget} step={0.05} min={0} disabled={!superTargetEnabled} />
                </div>
                <div className="flex-1">
                  <div className="h-4 flex items-center gap-1 mb-1">
                    <input type="checkbox" id="sl-loss" checked={superSlEnabled} onChange={(e) => setSuperSlEnabled(e.target.checked)} className="accent-red-500 w-3 h-3" />
                    <label htmlFor="sl-loss" className="text-[10px] text-red-400 font-semibold">Stop Loss</label>
                  </div>
                  <SpinnerInput label="" value={superSl} onChange={setSuperSl} step={0.05} min={0} disabled={!superSlEnabled} />
                </div>
                {/* Trail Jump — next to Stop Loss */}
                <div className="flex-1">
                  <div className="h-4 flex items-center gap-1 mb-1">
                    <input type="checkbox" id="sl-trail" checked={trailEnabled} onChange={(e) => setTrailEnabled(e.target.checked)} className="accent-amber-400 w-3 h-3" />
                    <label htmlFor="sl-trail" className="text-[10px] text-amber-400 font-semibold">Trail Jump</label>
                  </div>
                  <SpinnerInput label="" value={trailJump || "0"} onChange={setTrailJump} step={0.05} min={0} disabled={!trailEnabled} />
                </div>
              </div>
            </div>
          )}

          {/* Show/Hide Options (F&O details) */}
          <button type="button" onClick={() => setShowOptions((x) => !x)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition">
            {showOptions ? "Hide Options" : "Show Options"}
            <span className="w-3.5 h-3.5 rounded-full border border-muted-foreground/40 text-[8px] flex items-center justify-center">ⓘ</span>
          </button>

          {showOptions && (
            <div className="space-y-2 pt-0.5">
              {instrumentType === "option" && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[9px] text-muted-foreground font-semibold mb-1">EXPIRY</div>
                    <select className={`${inputCls} text-xs py-1.5`} value={expiry} onChange={(e) => { setExpiry(e.target.value); setStrike(null); setLimitPriceTouched(false); }} disabled={!expiries.length}>
                      <option value="">{expiries.length ? "Select" : "Load CSV"}</option>
                      {expiries.map((e) => <option key={e} value={e}>{fmtDate(e)}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="text-[9px] text-muted-foreground font-semibold mb-1">STRIKE</div>
                    <select className={`${inputCls} text-xs py-1.5`} value={strike ?? ""} onChange={(e) => { setStrike(Number(e.target.value)); setLimitPriceTouched(false); }} disabled={!strikes.length}>
                      <option value="">Select</option>
                      {strikes.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <div className="text-[9px] text-muted-foreground font-semibold mb-1">TYPE</div>
                    <div className="flex gap-1">
                      {(["CE", "PE"] as const).map((ot) => (
                        <button key={ot} type="button" onClick={() => { setOptionType(ot); setLimitPriceTouched(false); }}
                          className={`flex-1 py-1.5 text-xs font-bold rounded border transition ${optionType === ot ? ot === "CE" ? "bg-emerald-500/15 border-emerald-500 text-emerald-400" : "bg-red-500/15 border-red-500 text-red-400" : "border-border text-muted-foreground"}`}>
                          {ot}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {instrumentType === "option" && (
                  <div>
                    <div className="text-[9px] text-muted-foreground font-semibold mb-1">LOT SIZE</div>
                    <input className={`${inputCls} text-xs py-1.5`} type="number" value={lotSize} onChange={(e) => setLotSize(e.target.value)} />
                  </div>
                )}
                <div>
                  <div className="text-[9px] text-muted-foreground font-semibold mb-1">VALID FOR</div>
                  <select className={`${inputCls} text-xs py-1.5`} defaultValue="today">
                    <option value="today">Today</option>
                    <option value="gtc">Good Till Cancelled</option>
                    <option value="ioc">Immediate or Cancel</option>
                  </select>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* ── Footer: Margin + Available + CTA ── */}
        <div className="px-4 py-3 border-t border-border/40 bg-muted/10 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Margin: <span className={`font-bold ${insufficientFunds ? "text-red-500" : "text-foreground"}`}>
                {notional > 0 ? `₹${notional.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              </span>
              {notional > 0 && <span className="text-muted-foreground/60 ml-1">(1X)</span>}
            </div>
            <div>
              Available: <span className={`font-semibold ${insufficientFunds ? "text-red-400" : "text-foreground"}`}>
                ₹{cashBalance.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {insufficientFunds && <div className="text-[10px] text-red-500">Insufficient balance</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-sm font-semibold rounded-lg border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition"
            >
              Cancel
            </button>
            <div className="flex flex-col items-end gap-1">
              {!liveFeedActive && (
                <span className="text-[10px] text-amber-400/80">Market closed or broker not connected</span>
              )}
              <button
                disabled={!canSubmit || pending}
                onClick={submit}
                className={`px-7 py-2.5 text-sm font-bold rounded-lg transition disabled:opacity-40 active:scale-95 ${side === "long" ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-red-500 hover:bg-red-600 text-white"}`}
              >
                {pending ? "Placing…" : side === "long" ? "Buy" : "Sell"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Trade In Futures Modal ───────────────────────────────────────────────────

function TradeInFuturesModal({
  onClose, underlyingSymbols, histories, asOfDate, cashBalance, lotSizes: csvLotSizes, optionsData, onSubmit, pending, liveFeedActive,
}: {
  onClose: () => void;
  underlyingSymbols: string[];
  histories: ReturnType<typeof useData>["histories"];
  asOfDate: string | null;
  cashBalance: number;
  lotSizes: ReturnType<typeof useData>["lotSizes"];
  optionsData: ReturnType<typeof useData>["optionsData"];
  onSubmit: (body: Parameters<typeof apiOpenPaperPosition>[1]) => void;
  pending: boolean;
  liveFeedActive: boolean;
}) {
  const [side, setSide] = useState<PositionSide>("long");
  const [underlying, setUnderlying] = useState("");
  const [expiry, setExpiry] = useState("");
  const [qty, setQty] = useState("1");
  const [priceTab, setPriceTab] = useState<PriceTab>("market");
  const [validity, setValidity] = useState<OrderValidity>("intraday");
  const [limitPrice, setLimitPrice] = useState("");
  const [limitPriceTouched, setLimitPriceTouched] = useState(false);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [superLimitEnabled, setSuperLimitEnabled] = useState(false);
  const [superLimitPrice, setSuperLimitPrice] = useState("");
  const [superTargetEnabled, setSuperTargetEnabled] = useState(false);
  const [superTarget, setSuperTarget] = useState("");
  const [superSlEnabled, setSuperSlEnabled] = useState(false);
  const [superSl, setSuperSl] = useState("");
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailJump, setTrailJump] = useState("");

  const today = todayIso();

  // Expiries: from optionsData filtered to >= today, or NSE last-Thursday generated dates
  const allExpiries = useMemo(() => {
    if (!underlying) return [];
    const fromData = optionsData
      ? (optionsData.expiriesBySymbol.get(underlying) ?? []).filter((e) => e >= today)
      : [];
    if (fromData.length > 0) return fromData;
    // Generate NSE-style last-Thursday monthly expiries (3 months ahead)
    const generated: string[] = [];
    const now = new Date();
    for (let m = 0; m < 4; m++) {
      const rawMonth = now.getMonth() + m;
      const yr = now.getFullYear() + Math.floor(rawMonth / 12);
      const mo = rawMonth % 12;
      const lastDay = new Date(yr, mo + 1, 0);
      while (lastDay.getDay() !== 4) lastDay.setDate(lastDay.getDate() - 1);
      const iso = lastDay.toISOString().slice(0, 10);
      if (iso >= today) generated.push(iso);
    }
    return generated;
  }, [underlying, optionsData, today]);

  // Auto-select nearest expiry when symbol selected
  useEffect(() => {
    if (allExpiries.length > 0 && !expiry) setExpiry(allExpiries[0]);
  }, [allExpiries]);

  // Lot size from csvLotSizes or default map
  const effLotSize = useMemo(() => {
    if (!underlying) return 1;
    return getLotSizeForExpiry(csvLotSizes, underlying, expiry || "9999-12", DEFAULT_LOT_SIZES[underlying]) ?? 1;
  }, [underlying, expiry, csvLotSizes]);

  // LTP: use underlying stock price as futures price proxy
  const autoPrice = useMemo(() => {
    if (!underlying) return null;
    return getStockLtp(histories, underlying, asOfDate);
  }, [underlying, histories, asOfDate]);

  useEffect(() => {
    if (!limitPriceTouched && autoPrice !== null) {
      setLimitPrice(String(autoPrice));
      setTriggerPrice(String(parseFloat((autoPrice * 0.995).toFixed(2))));
      setSuperLimitPrice(String(autoPrice));
      setSuperTarget(String(parseFloat((autoPrice * 1.05).toFixed(2))));
      setSuperSl(String(parseFloat((autoPrice * 0.97).toFixed(2))));
    }
  }, [autoPrice, limitPriceTouched]);

  const effectivePrice = (() => {
    if (priceTab === "market") return autoPrice ?? 0;
    if (priceTab === "limit") return Number(limitPrice) || 0;
    if (priceTab === "trigger") return Number(limitPrice) || 0;
    if (priceTab === "super") return superLimitEnabled ? (Number(superLimitPrice) || 0) : (autoPrice ?? 0);
    return 0;
  })();

  const notional = (Number(qty) || 0) * effLotSize * effectivePrice;
  const insufficientFunds = notional > cashBalance && notional > 0;

  const instrumentLabel = underlying && expiry ? `${underlying} ${fmtDate(expiry)} FUT` : underlying || "—";
  const prevClosePrice = autoPrice !== null ? autoPrice * 0.98 : null;
  const priceDiff = autoPrice !== null && prevClosePrice !== null ? autoPrice - prevClosePrice : null;
  const priceDiffPct = autoPrice !== null && prevClosePrice !== null ? (priceDiff! / prevClosePrice) * 100 : null;

  const canSubmit = !!underlying && !!expiry && Number(qty) > 0 && !insufficientFunds &&
    (priceTab === "market" || Number(effectivePrice) > 0) && liveFeedActive;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Enter" && !e.shiftKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
        if (canSubmit && !pending) submit();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canSubmit, pending, onClose]);

  function submit() {
    const entryPrice = priceTab === "market" ? (autoPrice ?? effectivePrice) : effectivePrice;
    onSubmit({
      instrument_type: "future" as InstrumentType,
      symbol: `${underlying} ${fmtDate(expiry)} FUT`,
      underlying,
      expiry,
      side,
      qty: Number(qty),
      lot_size: effLotSize,
      entry_price: entryPrice,
      entry_date: todayIso(),
    });
  }

  const PRICE_TABS: { id: PriceTab; label: string; beta?: boolean }[] = [
    { id: "market", label: "Market" },
    { id: "limit", label: "Limit" },
    { id: "trigger", label: "Trigger" },
    { id: "super", label: "Super", beta: true },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-[#1a1f2e] border border-border/60 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

        {/* ── Header: FUTURES badge + symbol + EXPIRY + dropdown ── */}
        <div className="px-3 pt-2.5 pb-2 border-b border-border/40">
          <div className="flex gap-2 items-center">
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted/40 border border-border rounded shrink-0">
              FUTURES
            </div>
            <div className="flex-1 min-w-0">
              <SymbolPicker
                symbols={underlyingSymbols}
                value={underlying}
                onChange={(v) => { setUnderlying(v); setExpiry(""); setLimitPriceTouched(false); }}
                placeholder="Search futures symbol…"
              />
            </div>
            <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground bg-muted/40 border border-border rounded shrink-0">
              EXPIRY
            </div>
            <select
              value={expiry}
              onChange={(e) => { setExpiry(e.target.value); setLimitPriceTouched(false); }}
              disabled={!underlying || allExpiries.length === 0}
              className="bg-background border border-border rounded-lg px-2 py-1 text-xs text-foreground focus:outline-none shrink-0 disabled:opacity-50"
            >
              {!underlying && <option value="">—</option>}
              {underlying && allExpiries.length === 0 && <option value="">No expiries</option>}
              {allExpiries.map((e) => <option key={e} value={e}>{fmtDate(e)}</option>)}
            </select>
          </div>
        </div>

        {/* ── Title + LTP ── */}
        <div className="px-4 pt-3 flex items-start justify-between">
          <div>
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">{instrumentLabel}</div>
            {autoPrice !== null ? (
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-foreground">{autoPrice.toFixed(2)}</span>
                {priceDiff !== null && (
                  <span className="text-xs font-semibold text-emerald-400">
                    +{priceDiff.toFixed(2)} (+{priceDiffPct!.toFixed(2)}%) ↗
                  </span>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic">{underlying ? "No price data — use Limit tab" : "Select a symbol to begin"}</div>
            )}
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors mt-0.5">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Trading / Normal + Buy●Sell ── */}
        <div className="px-4 pt-2.5 pb-0 flex items-center justify-between">
          <div className="flex gap-1.5">
            {(["intraday", "normal"] as const).map((v) => (
              <button key={v} onClick={() => setValidity(v)}
                className={`px-3 py-1 text-xs font-semibold rounded border transition ${validity === v ? "border-primary/60 bg-primary/10 text-primary" : "border-border/50 text-muted-foreground hover:border-border"}`}>
                {v === "intraday" ? "Trading" : "Normal"}
              </button>
            ))}
          </div>
          <button onClick={() => setSide(side === "long" ? "short" : "long")}
            className="flex items-center gap-1.5 text-xs font-semibold" aria-label="Toggle Buy/Sell">
            <span className={side === "long" ? "text-foreground" : "text-muted-foreground"}>Buy</span>
            <div className={`relative w-9 h-5 rounded-full transition-colors ${side === "long" ? "bg-primary" : "bg-red-500"}`}>
              <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${side === "long" ? "left-0.5" : "left-[18px]"}`} />
            </div>
            <span className={side === "short" ? "text-foreground" : "text-muted-foreground"}>Sell</span>
          </button>
        </div>

        {/* ── Price tabs ── */}
        <div className="px-4 pt-2 flex items-end gap-0 border-b border-border/40">
          {PRICE_TABS.map((pt) => (
            <button key={pt.id} onClick={() => setPriceTab(pt.id)}
              className={`px-3 py-2 text-xs font-semibold border-b-2 transition -mb-px flex items-center gap-1 ${priceTab === pt.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {pt.label}
              {pt.beta && <span className="text-[8px] font-bold bg-amber-500/20 text-amber-400 rounded px-1 py-0.5 leading-none">beta</span>}
            </button>
          ))}
        </div>

        {/* ── Order body ── */}
        <div className="px-4 py-3 space-y-3">
          {priceTab === "market" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot ×</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Market Price</span>
                </div>
                <div className="border border-border/50 rounded-lg flex items-center gap-1.5 px-2 opacity-60" style={{height: "calc(1rem + 14px)"}}>
                  <span className="text-sm font-semibold text-foreground">Market</span>
                  <span className="text-muted-foreground text-xs">🔒</span>
                </div>
              </div>
            </div>
          )}
          {priceTab === "limit" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot ×</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Limit Price</span>
                </div>
                <SpinnerInput label="" value={limitPrice} onChange={(v) => { setLimitPrice(v); setLimitPriceTouched(true); }} step={0.05} min={0} />
              </div>
            </div>
          )}
          {priceTab === "trigger" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot ×</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Limit Price</span>
                </div>
                <SpinnerInput label="" value={limitPrice} onChange={(v) => { setLimitPrice(v); setLimitPriceTouched(true); }} step={0.05} min={0} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Trigger Price</span>
                </div>
                <SpinnerInput label="" value={triggerPrice} onChange={setTriggerPrice} step={0.05} min={0} />
              </div>
            </div>
          )}
          {priceTab === "super" && (
            <div className="flex gap-2">
              <div className="w-[106px] shrink-0">
                <div className="h-4 flex items-center gap-1.5 mb-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">Lot ×</span>
                  <span className="text-[10px] text-muted-foreground/50">Qty: {Number(qty) * effLotSize}</span>
                </div>
                <SpinnerInput label="" value={qty} onChange={setQty} step={1} min={1} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center gap-1 mb-1">
                  <input type="checkbox" id="fut-sl-limit" checked={superLimitEnabled} onChange={(e) => setSuperLimitEnabled(e.target.checked)} className="accent-primary w-3 h-3" />
                  <label htmlFor="fut-sl-limit" className="text-[10px] text-muted-foreground font-semibold">Limit Price</label>
                </div>
                <SpinnerInput label="" value={superLimitPrice} onChange={setSuperLimitPrice} step={0.05} min={0} disabled={!superLimitEnabled} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center gap-1 mb-1">
                  <input type="checkbox" id="fut-sl-target" checked={superTargetEnabled} onChange={(e) => setSuperTargetEnabled(e.target.checked)} className="accent-emerald-500 w-3 h-3" />
                  <label htmlFor="fut-sl-target" className="text-[10px] text-emerald-400 font-semibold">Target</label>
                </div>
                <SpinnerInput label="" value={superTarget} onChange={setSuperTarget} step={0.05} min={0} disabled={!superTargetEnabled} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center gap-1 mb-1">
                  <input type="checkbox" id="fut-sl-loss" checked={superSlEnabled} onChange={(e) => setSuperSlEnabled(e.target.checked)} className="accent-red-500 w-3 h-3" />
                  <label htmlFor="fut-sl-loss" className="text-[10px] text-red-400 font-semibold">Stop Loss</label>
                </div>
                <SpinnerInput label="" value={superSl} onChange={setSuperSl} step={0.05} min={0} disabled={!superSlEnabled} />
              </div>
              <div className="flex-1">
                <div className="h-4 flex items-center gap-1 mb-1">
                  <input type="checkbox" id="fut-sl-trail" checked={trailEnabled} onChange={(e) => setTrailEnabled(e.target.checked)} className="accent-amber-400 w-3 h-3" />
                  <label htmlFor="fut-sl-trail" className="text-[10px] text-amber-400 font-semibold">Trail Jump</label>
                </div>
                <SpinnerInput label="" value={trailJump || "0"} onChange={setTrailJump} step={0.05} min={0} disabled={!trailEnabled} />
              </div>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-4 py-3 border-t border-border/40 bg-muted/10 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Margin: <span className={`font-bold ${insufficientFunds ? "text-red-500" : "text-foreground"}`}>
                {notional > 0 ? `₹${notional.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
              </span>
              {notional > 0 && <span className="text-muted-foreground/60 ml-1">(1X)</span>}
            </div>
            <div>
              Available: <span className={`font-semibold ${insufficientFunds ? "text-red-400" : "text-foreground"}`}>
                ₹{cashBalance.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {insufficientFunds && <div className="text-[10px] text-red-500">Insufficient balance</div>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 text-sm font-semibold rounded-lg border border-border/60 text-muted-foreground hover:text-foreground hover:border-border transition">
              Cancel
            </button>
            <div className="flex flex-col items-end gap-1">
              {!liveFeedActive && (
                <span className="text-[10px] text-amber-400/80">Market closed or broker not connected</span>
              )}
              <button
                disabled={!canSubmit || pending}
                onClick={submit}
                className={`px-7 py-2.5 text-sm font-bold rounded-lg transition disabled:opacity-40 active:scale-95 ${side === "long" ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-red-500 hover:bg-red-600 text-white"}`}
              >
                {pending ? "Placing…" : side === "long" ? "Buy" : "Sell"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Options Chain Trade Flow ─────────────────────────────────────────────────

function OptionsChainTradeFlow({
  optionsData, lotSizes, cashBalance, underlyingSymbols,
  onClose, onConfirm, submitting,
}: {
  optionsData: ReturnType<typeof useData>["optionsData"];
  lotSizes: ReturnType<typeof useData>["lotSizes"];
  cashBalance: number;
  underlyingSymbols: string[];
  onClose: () => void;
  onConfirm: (legs: DraftLeg[]) => void;
  submitting: boolean;
}) {
  const [step, setStep] = useState<"chain" | "review">("chain");
  const [draftLegs, setDraftLegs] = useState<DraftLeg[]>([]);

  // Chain state
  const symbols = useMemo(() => {
    const base = optionsData ? Array.from(optionsData.expiriesBySymbol.keys()) : underlyingSymbols;
    return base.sort((a, b) => {
      const ia = CHAIN_INDEX_ORDER.indexOf(a), ib = CHAIN_INDEX_ORDER.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1; if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
  }, [optionsData, underlyingSymbols]);

  const [activeSymbol, setActiveSymbol] = useState(() => {
    const first = CHAIN_INDEX_ORDER.find((s) => symbols.includes(s));
    return first ?? symbols[0] ?? "";
  });
  const [selectedExpiry, setSelectedExpiry] = useState("");
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const expiryScrollRef = useRef<HTMLDivElement>(null);
  // per-cell lots: `${strike}|${type}` → lots
  const [rowLots, setRowLots] = useState<Map<string, number>>(new Map());

  // Latest available date (treat as "live")
  const liveDate = useMemo(() => {
    if (!optionsData) return "";
    return optionsData.dates[optionsData.dates.length - 1] ?? "";
  }, [optionsData]);

  const expiries = useMemo(() => {
    if (!optionsData || !activeSymbol) return [];
    return (optionsData.expiriesBySymbol.get(activeSymbol) ?? []).filter((e) => e >= liveDate);
  }, [optionsData, activeSymbol, liveDate]);

  const activeExpiry = useMemo(() => {
    if (selectedExpiry && expiries.includes(selectedExpiry)) return selectedExpiry;
    return expiries[0] ?? "";
  }, [selectedExpiry, expiries]);

  const chain = useMemo(() => {
    if (!optionsData || !activeSymbol || !activeExpiry || !liveDate) return [];
    const strikes = optionsData.strikesByKey.get(`${activeSymbol}|${activeExpiry}`) ?? [];
    const map = new Map<number, { ce: number; pe: number; ceOI: number; peOI: number }>();
    for (const b of optionsData.bars) {
      if (b.symbol !== activeSymbol || b.expiry !== activeExpiry || b.date !== liveDate) continue;
      const e = map.get(b.strike) ?? { ce: 0, pe: 0, ceOI: 0, peOI: 0 };
      if (b.type === "CE") { e.ce = b.close; e.ceOI = b.oi; }
      else { e.pe = b.close; e.peOI = b.oi; }
      map.set(b.strike, e);
    }
    return strikes.filter((s) => map.has(s)).map((s) => ({ strike: s, ...map.get(s)! }));
  }, [optionsData, activeSymbol, activeExpiry, liveDate]);

  const spot = useMemo(() => {
    if (!optionsData || !activeSymbol || !liveDate) return 0;
    return optionsData.futuresCloseByKey.get(`${activeSymbol}|${liveDate}`) ?? 0;
  }, [optionsData, activeSymbol, liveDate]);

  const atmK = useMemo(() => {
    if (!spot || !chain.length) return 0;
    return chain.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best - spot) ? r.strike : best, chain[0].strike);
  }, [spot, chain]);

  const maxOI = useMemo(() => Math.max(1, ...chain.map((r) => Math.max(r.ceOI, r.peOI))), [chain]);
  const dte = useMemo(() => optDte(liveDate, activeExpiry), [liveDate, activeExpiry]);
  const lotSize = getLotSizeForExpiry(lotSizes, activeSymbol, activeExpiry, DEFAULT_LOT_SIZES[activeSymbol] ?? 1);

  // Scroll ATM into view when chain loads or expiry changes
  useEffect(() => {
    if (step !== "chain" || !chainScrollRef.current || !atmK) return;
    const el = chainScrollRef.current.querySelector<HTMLElement>('[data-atm="true"]');
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [atmK, activeExpiry, step]);

  useEffect(() => {
    if (!expiryScrollRef.current || !activeExpiry) return;
    const el = expiryScrollRef.current.querySelector<HTMLButtonElement>(`[data-expiry="${activeExpiry}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeExpiry]);

  // Leg index for B/S button state
  const legIndex = useMemo(() => {
    const map = new Map<string, ("BUY" | "SELL")[]>();
    for (const l of draftLegs) {
      if (l.underlying !== activeSymbol || l.expiry !== activeExpiry) continue;
      const key = `${l.strike}|${l.type}`;
      map.set(key, [...(map.get(key) ?? []), l.action]);
    }
    return map;
  }, [draftLegs, activeSymbol, activeExpiry]);

  function getRowLots(strike: number, type: "CE" | "PE"): number {
    return rowLots.get(`${strike}|${type}`) ?? 1;
  }

  function adjustRowLots(strike: number, type: "CE" | "PE", delta: number) {
    const cur = getRowLots(strike, type);
    const next = Math.max(1, cur + delta);
    setRowLots((m) => { const n = new Map(m); n.set(`${strike}|${type}`, next); return n; });
    // Sync existing draft leg if any
    setDraftLegs((prev) => prev.map((l) =>
      l.underlying === activeSymbol && l.expiry === activeExpiry && l.strike === strike && l.type === type
        ? { ...l, lots: next }
        : l
    ));
  }

  function nowTime(): string {
    return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  }

  function toggleLeg(strike: number, type: "CE" | "PE", action: "BUY" | "SELL", price: number) {
    if (price <= 0) return;
    const exists = draftLegs.find((l) =>
      l.underlying === activeSymbol && l.expiry === activeExpiry &&
      l.strike === strike && l.type === type && l.action === action
    );
    if (exists) {
      setDraftLegs((prev) => prev.filter((l) => l.id !== exists.id));
    } else {
      const lots = getRowLots(strike, type);
      setDraftLegs((prev) => [
        ...prev.filter((l) => !(l.underlying === activeSymbol && l.expiry === activeExpiry && l.strike === strike && l.type === type)),
        { id: crypto.randomUUID(), underlying: activeSymbol, expiry: activeExpiry, strike, type, action, lots, lotSize, entryPrice: price, time: nowTime() },
      ]);
    }
  }

  function refreshLegPrice(legId: string) {
    setDraftLegs((prev) => prev.map((l) => {
      if (l.id !== legId || !optionsData) return l;
      let latestPrice = 0;
      for (const b of optionsData.bars) {
        if (b.symbol === l.underlying && b.expiry === l.expiry && b.strike === l.strike && b.type === l.type) {
          if (!latestPrice || b.date > liveDate) latestPrice = b.close;
          if (b.date === liveDate) { latestPrice = b.close; break; }
        }
      }
      return latestPrice > 0 ? { ...l, entryPrice: latestPrice, time: nowTime() } : l;
    }));
  }

  function stepExpiry(dir: "left" | "right") {
    const idx = expiries.indexOf(activeExpiry);
    const next = dir === "left" ? expiries[idx - 1] : expiries[idx + 1];
    if (next) setSelectedExpiry(next);
  }

  // Strategy quick-select
  const [stratFilter, setStratFilter] = useState<ChainStrat["category"] | "all">("neutral");

  function applyChainStrategy(strat: ChainStrat) {
    if (!chain.length || !atmK) return;
    const strikes = chain.map((r) => r.strike).sort((a, b) => a - b);
    const atmIdx = strikes.indexOf(atmK);
    if (atmIdx < 0) return;
    const t = nowTime();
    const newLegs: DraftLeg[] = [];
    for (const def of strat.legs) {
      const idx = atmIdx + def.offset;
      if (idx < 0 || idx >= strikes.length) continue;
      const strike = strikes[idx];
      const row = chain.find((r) => r.strike === strike);
      if (!row) continue;
      const price = def.type === "CE" ? row.ce : row.pe;
      if (price <= 0) continue;
      newLegs.push({
        id: crypto.randomUUID(),
        underlying: activeSymbol, expiry: activeExpiry,
        strike, type: def.type, action: def.action,
        lots: 1, lotSize, entryPrice: price, time: t,
      });
    }
    if (newLegs.length) setDraftLegs(newLegs);
  }

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [onClose]);

  const totalLegs = draftLegs.length;

  // ── Screen 1: Live option chain ──────────────────────────────────────────
  if (step === "chain") {
    return createPortal(
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
        <div className="w-full max-w-[580px] flex flex-col bg-[#0d1117] border border-border/60 rounded-2xl shadow-2xl overflow-hidden" style={{ maxHeight: "90vh" }}>

          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 shrink-0">
            <div className="flex items-center gap-2">
              <select value={activeSymbol} onChange={(e) => { setActiveSymbol(e.target.value); setSelectedExpiry(""); }}
                className="text-xs font-bold bg-transparent border border-border/60 rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 max-w-[150px]">
                {symbols.filter((s) => CHAIN_INDEX_ORDER.includes(s)).length > 0 && (
                  <optgroup label="Indices">
                    {symbols.filter((s) => CHAIN_INDEX_ORDER.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
                  </optgroup>
                )}
                {symbols.filter((s) => !CHAIN_INDEX_ORDER.includes(s)).length > 0 && (
                  <optgroup label="Stocks">
                    {symbols.filter((s) => !CHAIN_INDEX_ORDER.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
                  </optgroup>
                )}
              </select>
              {spot > 0 && <span className="text-sm font-bold text-foreground tabular-nums">{spot.toLocaleString("en-IN")}</span>}
              {liveDate && <span className="text-[10px] text-muted-foreground/60">{liveDate}</span>}
            </div>
            <div className="flex items-center gap-2">
              {totalLegs > 0 && <span className="text-[10px] text-muted-foreground">{totalLegs} leg{totalLegs !== 1 ? "s" : ""}</span>}
              <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X className="h-4 w-4" /></button>
            </div>
          </div>

          {/* Expiry tabs */}
          <div className="flex items-stretch border-b border-border/50 bg-muted/10 shrink-0">
            <button type="button" onClick={() => stepExpiry("left")} disabled={expiries.indexOf(activeExpiry) <= 0}
              className="px-1.5 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-25 border-r border-border/40 transition-colors">
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <div ref={expiryScrollRef} className="flex gap-1 px-2 py-1 overflow-x-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {expiries.map((exp) => {
                const label = new Date(exp + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                const daysLeft = optDte(liveDate, exp);
                const isActive = exp === activeExpiry;
                return (
                  <button key={exp} data-expiry={exp} type="button" onClick={() => setSelectedExpiry(exp)}
                    className={`shrink-0 flex flex-col items-center px-2.5 py-0.5 rounded text-center transition-all ${isActive ? "bg-primary text-primary-foreground shadow-md scale-105" : "bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}>
                    <span className="text-[9px] font-bold leading-tight whitespace-nowrap">{label}</span>
                    <span className={`text-[7px] leading-tight ${isActive ? "text-primary-foreground/80" : "text-foreground/50"}`}>{daysLeft}d</span>
                  </button>
                );
              })}
              {expiries.length === 0 && <span className="text-[10px] text-muted-foreground/50 flex items-center">No expiries</span>}
            </div>
            <button type="button" onClick={() => stepExpiry("right")} disabled={expiries.indexOf(activeExpiry) >= expiries.length - 1}
              className="px-1.5 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-25 border-l border-border/40 transition-colors">
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Strategy quick-select bar */}
          <div className="border-b border-border/40 bg-[#0a0d14] shrink-0">
            {/* Category pills */}
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              {(["neutral","bullish","bearish","other"] as const).map((cat) => {
                const colors: Record<string, string> = {
                  neutral:  "border-cyan-500/50 text-cyan-400 bg-cyan-500/10",
                  bullish:  "border-emerald-500/50 text-emerald-400 bg-emerald-500/10",
                  bearish:  "border-red-500/50 text-red-400 bg-red-500/10",
                  other:    "border-purple-500/50 text-purple-400 bg-purple-500/10",
                };
                const dim = "border-border/40 text-muted-foreground/60 bg-transparent";
                const isActive = stratFilter === cat;
                return (
                  <button key={cat} type="button"
                    onClick={() => setStratFilter(isActive ? "all" : cat)}
                    className={`px-2 py-0.5 rounded-full text-[9px] font-bold border transition-all capitalize ${isActive ? colors[cat] : dim + " hover:border-border"}`}>
                    {cat}
                  </button>
                );
              })}
              <span className="ml-auto text-[9px] text-muted-foreground/40">quick strategies</span>
            </div>
            {/* Strategy chips — scrollable */}
            <div className="flex gap-1 px-2 pb-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {CHAIN_STRATEGIES
                .filter((s) => stratFilter === "all" || s.category === stratFilter)
                .map((strat) => {
                  const catBg: Record<string, string> = {
                    neutral: "border-cyan-500/30 hover:bg-cyan-500/10 hover:border-cyan-400/60",
                    bullish: "border-emerald-500/30 hover:bg-emerald-500/10 hover:border-emerald-400/60",
                    bearish: "border-red-500/30 hover:bg-red-500/10 hover:border-red-400/60",
                    other:   "border-purple-500/30 hover:bg-purple-500/10 hover:border-purple-400/60",
                  };
                  const disabled = !chain.length || !atmK;
                  return (
                    <button key={strat.name} type="button"
                      disabled={disabled}
                      onClick={() => applyChainStrategy(strat)}
                      title={`${strat.legs.length}-leg strategy at ATM${strat.legs.some(l=>l.offset!==0) ? " ± offsets" : ""}`}
                      className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-semibold text-foreground/80 transition-all disabled:opacity-30 active:scale-95 ${catBg[strat.category]}`}>
                      <span>{strat.emoji}</span>
                      <span className="whitespace-nowrap">{strat.name}</span>
                      <span className="text-[8px] text-muted-foreground/50 ml-0.5">{strat.legs.length}L</span>
                    </button>
                  );
                })}
            </div>
          </div>

          {/* Chain column headers */}
          <div className="grid grid-cols-[44fr_52fr_80fr_60fr_80fr_52fr_44fr] text-[9px] uppercase tracking-wide text-foreground/50 border-b border-border/50 bg-muted/20 shrink-0 px-1 font-semibold">
            <div className="py-1 text-right pr-1">CΔ</div>
            <div className="py-1 text-right pr-1">CE LTP</div>
            <div className="py-1 text-right pr-2">OI (CE)</div>
            <div className="py-1 text-center text-foreground/70">Strike</div>
            <div className="py-1 text-left pl-2">OI (PE)</div>
            <div className="py-1 text-left pl-1">PE LTP</div>
            <div className="py-1 text-left pl-1">PΔ</div>
          </div>

          {/* Chain rows */}
          <div ref={chainScrollRef} className="flex-1 overflow-y-auto">
            {!optionsData ? (
              <div className="flex items-center justify-center h-32 text-xs text-muted-foreground/50">Upload options CSV to see live chain</div>
            ) : chain.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-xs text-muted-foreground/50">No data for this expiry</div>
            ) : chain.map((row) => {
              const isATM = row.strike === atmK;
              const ceDelta = optDelta(spot, row.strike, "CE", dte);
              const peDelta = optDelta(spot, row.strike, "PE", dte);
              const isCeITM = !isATM && spot > 0 && row.strike < spot;
              const isPeITM = !isATM && spot > 0 && row.strike > spot;
              const ceCellBg = isATM ? "bg-cyan-500/[0.18]" : isCeITM ? "bg-green-500/10" : "";
              const peCellBg = isATM ? "bg-cyan-500/[0.18]" : isPeITM ? "bg-orange-500/10" : "";
              const strikeBg = isATM ? "bg-cyan-500/30" : "bg-white/5";
              const ceActions = legIndex.get(`${row.strike}|CE`) ?? [];
              const peActions = legIndex.get(`${row.strike}|PE`) ?? [];
              const ceLots = getRowLots(row.strike, "CE");
              const peLots = getRowLots(row.strike, "PE");
              const showCeBtns = (hoveredStrike === row.strike || ceActions.length > 0) && row.ce > 0;
              const showPeBtns = (hoveredStrike === row.strike || peActions.length > 0) && row.pe > 0;

              return (
                <div key={row.strike} data-atm={isATM ? "true" : undefined}
                  onMouseEnter={() => setHoveredStrike(row.strike)}
                  onMouseLeave={() => setHoveredStrike(null)}
                  className={`grid grid-cols-[44fr_52fr_80fr_60fr_80fr_52fr_44fr] border-b px-1 ${isATM ? "border-cyan-500/40" : "border-border/10"}`}>

                  {/* Call Delta */}
                  <div className={`py-1.5 text-right pr-1 text-[10px] tabular-nums font-medium ${ceCellBg} ${ceDelta > 0.5 ? "text-emerald-400" : ceDelta < 0.2 ? "text-foreground/35" : "text-foreground/65"}`}>
                    {row.ce > 0 ? ceDelta.toFixed(2) : "—"}
                  </div>

                  {/* CE LTP */}
                  <div className={`py-1 text-right pr-1 flex flex-col justify-center items-end ${ceCellBg}`}>
                    <span className={`text-[10px] font-bold tabular-nums leading-none ${row.ce > 0 ? "text-foreground" : "text-foreground/25"}`}>
                      {row.ce > 0 ? row.ce.toFixed(1) : "—"}
                    </span>
                  </div>

                  {/* CE OI + B/S buttons */}
                  {(() => {
                    const hasBuy = ceActions.includes("BUY"), hasSell = ceActions.includes("SELL");
                    return (
                      <div className={`py-1.5 relative flex flex-col items-end justify-center gap-0.5 pr-1 ${ceCellBg}`}>
                        <div className="w-full flex justify-end">
                          <div className="h-1.5 bg-green-500/35 rounded-sm" style={{ width: `${(row.ceOI / maxOI) * 100}%` }} />
                        </div>
                        <span className="text-[8px] text-foreground/40 tabular-nums">{row.ceOI > 0 ? (row.ceOI / 100000).toFixed(1) + "L" : ""}</span>
                        {showCeBtns && (
                          <div className="absolute inset-0 flex flex-col items-start justify-center pl-1 gap-0.5">
                            <div className="flex gap-1">
                              <button type="button" onClick={() => toggleLeg(row.strike, "CE", "BUY", row.ce)}
                                className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${hasBuy ? "bg-blue-500 text-white ring-1 ring-blue-300" : "bg-blue-600/60 text-blue-200 hover:bg-blue-500"}`}>B</button>
                              <button type="button" onClick={() => toggleLeg(row.strike, "CE", "SELL", row.ce)}
                                className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${hasSell ? "bg-red-500 text-white ring-1 ring-red-300" : "bg-red-600/60 text-red-200 hover:bg-red-500"}`}>S</button>
                            </div>
                            {(hasBuy || hasSell) && (
                              <div className="flex items-center gap-0.5 ml-0.5">
                                <button type="button" onClick={() => adjustRowLots(row.strike, "CE", -1)} className="text-[9px] text-muted-foreground hover:text-foreground px-0.5 leading-none">−</button>
                                <span className="text-[9px] font-bold text-foreground tabular-nums">{ceLots}</span>
                                <button type="button" onClick={() => adjustRowLots(row.strike, "CE", +1)} className="text-[9px] text-muted-foreground hover:text-foreground px-0.5 leading-none">+</button>
                                <span className="text-[8px] text-muted-foreground/50 ml-0.5">L</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Strike */}
                  <div className={`py-1.5 flex items-center justify-center text-[11px] font-bold tabular-nums ${strikeBg} ${isATM ? "text-cyan-300" : "text-foreground/80"}`}>
                    {isATM && <span className="text-[8px] text-cyan-400 mr-0.5">★</span>}
                    {row.strike.toLocaleString("en-IN")}
                  </div>

                  {/* PE OI + B/S buttons */}
                  {(() => {
                    const hasBuy = peActions.includes("BUY"), hasSell = peActions.includes("SELL");
                    return (
                      <div className={`py-1.5 relative flex flex-col items-start justify-center gap-0.5 pl-1 ${peCellBg}`}>
                        <div className="h-1.5 bg-red-500/35 rounded-sm" style={{ width: `${(row.peOI / maxOI) * 100}%` }} />
                        <span className="text-[8px] text-foreground/40 tabular-nums">{row.peOI > 0 ? (row.peOI / 100000).toFixed(1) + "L" : ""}</span>
                        {showPeBtns && (
                          <div className="absolute inset-0 flex flex-col items-end justify-center pr-1 gap-0.5">
                            <div className="flex gap-1">
                              <button type="button" onClick={() => toggleLeg(row.strike, "PE", "BUY", row.pe)}
                                className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${hasBuy ? "bg-blue-500 text-white ring-1 ring-blue-300" : "bg-blue-600/60 text-blue-200 hover:bg-blue-500"}`}>B</button>
                              <button type="button" onClick={() => toggleLeg(row.strike, "PE", "SELL", row.pe)}
                                className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${hasSell ? "bg-red-500 text-white ring-1 ring-red-300" : "bg-red-600/60 text-red-200 hover:bg-red-500"}`}>S</button>
                            </div>
                            {(hasBuy || hasSell) && (
                              <div className="flex items-center gap-0.5 mr-0.5">
                                <button type="button" onClick={() => adjustRowLots(row.strike, "PE", -1)} className="text-[9px] text-muted-foreground hover:text-foreground px-0.5 leading-none">−</button>
                                <span className="text-[9px] font-bold text-foreground tabular-nums">{peLots}</span>
                                <button type="button" onClick={() => adjustRowLots(row.strike, "PE", +1)} className="text-[9px] text-muted-foreground hover:text-foreground px-0.5 leading-none">+</button>
                                <span className="text-[8px] text-muted-foreground/50 ml-0.5">L</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* PE LTP */}
                  <div className={`py-1 text-left pl-1 flex flex-col justify-center items-start ${peCellBg}`}>
                    <span className={`text-[10px] font-bold tabular-nums leading-none ${row.pe > 0 ? "text-foreground" : "text-foreground/25"}`}>
                      {row.pe > 0 ? row.pe.toFixed(1) : "—"}
                    </span>
                  </div>

                  {/* Put Delta */}
                  <div className={`py-1.5 text-left pl-1 text-[10px] tabular-nums font-medium ${peCellBg} ${Math.abs(peDelta) > 0.5 ? "text-red-400" : Math.abs(peDelta) < 0.2 ? "text-foreground/35" : "text-foreground/65"}`}>
                    {row.pe > 0 ? peDelta.toFixed(2) : "—"}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Chain footer */}
          <div className="flex items-center justify-between px-3 py-2.5 border-t border-border/40 bg-muted/10 shrink-0">
            <span className="text-xs text-muted-foreground">{totalLegs} leg{totalLegs !== 1 ? "s" : ""} selected</span>
            <div className="flex gap-2">
              <button onClick={() => setDraftLegs([])} disabled={totalLegs === 0}
                className="px-3 py-1.5 text-xs font-semibold border border-border/60 text-muted-foreground hover:text-foreground rounded-lg disabled:opacity-40 transition">
                Clear
              </button>
              <button disabled={totalLegs === 0} onClick={() => setStep("review")}
                className="px-5 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 active:scale-95 transition">
                Add ({totalLegs})
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // ── Screen 3: Review orders ────────────────────────────────────────────────
  const totalMargin = draftLegs.reduce((s, l) => s + l.entryPrice * l.lots * l.lotSize, 0);
  const insufficient = totalMargin > cashBalance && totalMargin > 0;

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">

        {/* Title row */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Review and Execute Order</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors"><X className="h-4 w-4" /></button>
        </div>

        {/* Column headers */}
        <div className="grid items-center text-[11px] font-medium text-muted-foreground border-b border-border bg-muted/10 px-4 py-2"
          style={{ gridTemplateColumns: "80px 1fr 92px 60px 110px 90px 36px" }}>
          <div>Type</div>
          <div>Instrument</div>
          <div className="text-center">Lot</div>
          <div className="text-right">Qty</div>
          <div className="text-right pr-6">Price</div>
          <div>Time</div>
          <div />
        </div>

        {/* Leg rows */}
        <div className="max-h-[45vh] overflow-y-auto divide-y divide-border/50">
          {draftLegs.map((leg) => (
            <div key={leg.id}
              className="grid items-center px-4 py-2.5 hover:bg-muted/20 transition"
              style={{ gridTemplateColumns: "80px 1fr 92px 60px 110px 90px 36px" }}>

              {/* Type: Buy/Sell badge */}
              <div>
                <span className={`inline-flex items-center px-2.5 py-1 rounded text-[11px] font-bold ${
                  leg.action === "BUY"
                    ? "bg-blue-600 text-white"
                    : "bg-red-600 text-white"
                }`}>
                  {leg.action === "BUY" ? "Buy" : "Sell"}
                </span>
              </div>

              {/* Instrument */}
              <div className="font-medium text-foreground text-[12px] truncate pr-3">
                {leg.underlying} {fmtDate(leg.expiry)} {leg.strike} {leg.type}
              </div>

              {/* Lot +/- stepper */}
              <div className="flex items-center justify-center gap-1.5">
                <button
                  onClick={() => setDraftLegs((p) => p.map((l) => l.id === leg.id ? { ...l, lots: Math.max(1, l.lots - 1) } : l))}
                  disabled={leg.lots <= 1}
                  className="w-5 h-5 flex items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:opacity-30 transition-colors leading-none">
                  −
                </button>
                <span className="w-5 text-center tabular-nums text-foreground text-[12px] font-semibold">{leg.lots}</span>
                <button
                  onClick={() => setDraftLegs((p) => p.map((l) => l.id === leg.id ? { ...l, lots: l.lots + 1 } : l))}
                  className="w-5 h-5 flex items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors leading-none">
                  +
                </button>
              </div>

              {/* Qty (shares) */}
              <div className="text-right tabular-nums text-foreground text-[12px] font-semibold">
                {leg.lots * leg.lotSize}
              </div>

              {/* Price + refresh */}
              <div className="flex items-center justify-end gap-1 pr-1">
                <span className="tabular-nums text-foreground text-[12px]">
                  {leg.entryPrice.toFixed(2)}
                </span>
                <button
                  onClick={() => refreshLegPrice(leg.id)}
                  title="Refresh price from latest data"
                  className="text-primary hover:text-primary/70 transition-colors p-0.5 rounded">
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>

              {/* Time */}
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {leg.time || "—"}
              </div>

              {/* Delete */}
              <div className="flex justify-end">
                <button onClick={() => setDraftLegs((p) => p.filter((l) => l.id !== leg.id))}
                  className="text-muted-foreground hover:text-red-400 transition-colors p-1">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-muted/10 flex items-center justify-between gap-4">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Margin: <span className={`font-semibold ${insufficient ? "text-red-400" : "text-foreground"}`}>
                ₹{totalMargin.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-muted-foreground/60 ml-1">(1×)</span>
            </div>
            <div>
              Available: <span className={`font-semibold ${insufficient ? "text-red-400" : "text-foreground"}`}>
                ₹{cashBalance.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {insufficient && <div className="text-[10px] text-red-500 font-medium">Insufficient balance</div>}
          </div>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setStep("chain")}
              className="px-4 py-2 text-sm font-semibold border border-primary/60 text-primary rounded-lg hover:bg-primary/10 transition">
              <Plus className="h-3.5 w-3.5 inline mr-1" />Add More
            </button>
            <button onClick={onClose}
              className="px-5 py-2 text-sm font-semibold border border-border/60 text-muted-foreground hover:text-foreground rounded-lg transition">
              Cancel
            </button>
            <button
              disabled={draftLegs.length === 0 || insufficient || submitting}
              onClick={() => onConfirm(draftLegs)}
              className="px-6 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 active:scale-95 transition">
              {submitting ? "Placing…" : `Place Order (${draftLegs.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Close Trade Modal ────────────────────────────────────────────────────────

function CloseTradeModal({ position, currentLtp, onClose, onSubmit, pending }: {
  position: ApiPaperPosition;
  currentLtp: number | null;
  onClose: () => void;
  onSubmit: (qty: number, price: number) => void;
  pending: boolean;
}) {
  const [qty, setQty] = useState(String(position.qty));
  const [price, setPrice] = useState(currentLtp !== null ? String(currentLtp) : String(position.entry_price));

  const projectedPnl = position.side === "long"
    ? (Number(price) - position.entry_price) * Number(qty) * position.lot_size
    : (position.entry_price - Number(price)) * Number(qty) * position.lot_size;

  const canSubmit = Number(qty) > 0 && Number(qty) <= position.qty && Number(price) > 0;

  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (canSubmit && !pending) onSubmit(Number(qty), Number(price)); } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [canSubmit, pending, qty, price, onSubmit]);

  return (
    <Modal title={`Close ${position.symbol}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-xs text-muted-foreground">
          Entry: <span className="text-foreground font-semibold">{fmtRs(position.entry_price, 2)}</span> · Open Qty: <span className="text-foreground font-semibold">{position.qty}</span>
        </div>
        <FormField label={`Quantity to Close (max ${position.qty})`}>
          <input className={inputCls} type="number" min={1} max={position.qty} value={qty} onChange={(e) => setQty(e.target.value)} />
        </FormField>
        <FormField label="Exit Price (₹)">
          <input className={inputCls} type="number" value={price} onChange={(e) => setPrice(e.target.value)} />
        </FormField>
        <div className="flex items-center justify-between bg-muted/30 border border-border rounded-lg px-3 py-2.5 text-xs">
          <span className="text-muted-foreground">Realized P&L</span>
          <span className={`font-semibold ${pnlClass(projectedPnl)}`}>{fmtPnl(projectedPnl)}</span>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 py-2 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 transition">Cancel</button>
          <button
            disabled={!canSubmit || pending}
            onClick={() => onSubmit(Number(qty), Number(price))}
            className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 transition"
          >
            Confirm Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
