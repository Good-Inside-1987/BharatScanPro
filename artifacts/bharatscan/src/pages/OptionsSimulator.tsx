import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  Plus, Minus, Trash2, BarChart2, Layers, History,
  TrendingUp, TrendingDown, Zap, Database, ChevronLeft, ChevronRight,
  Clock, ChevronDown, LogOut, Check, X, RotateCcw,
} from "lucide-react";
import { apiListSimTrades, apiRecordSimTrade, apiDeleteSimTrade, type ApiSimTrade } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { useData } from "@/context/DataContext";
import { getLotSizeForExpiry } from "@/lib/universe";
import { atmStrike } from "@/lib/options";
import {
  XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
  Area, AreaChart, ComposedChart, Bar, Line,
} from "recharts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SimLeg {
  id: string;
  strike: number;
  type: "CE" | "PE";
  action: "BUY" | "SELL";
  lots: number;
  entryPrice: number;
  addedDate: string;
  addedTime: string;
  expiry: string;
  sl?: number;
  tgt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_ORDER = ["NIFTY", "BANKNIFTY", "FINNIFTY", "NIFTYNXT50", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const FALLBACK_LOT_SIZES: Record<string, number> = {
  NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 40, NIFTYNXT50: 25,
  MIDCPNIFTY: 120, SENSEX: 20, BANKEX: 15,
};

const TIME_STEPS = [
  { label: "-1d",  type: "date", delta: -1 },
  { label: "SOD",  type: "sod",  delta: 0  },
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
];

// ─────────────────────────────────────────────────────────────────────────────
// Payoff helpers
// ─────────────────────────────────────────────────────────────────────────────

function payoffAtExpiry(legs: SimLeg[], spot: number, lotSize: number): number {
  return legs.reduce((total, leg) => {
    const intrinsic = leg.type === "CE"
      ? Math.max(spot - leg.strike, 0)
      : Math.max(leg.strike - spot, 0);
    const pnl = leg.action === "BUY" ? intrinsic - leg.entryPrice : leg.entryPrice - intrinsic;
    return total + pnl * leg.lots * lotSize;
  }, 0);
}

function computeBreakevens(legs: SimLeg[], lotSize: number, spot: number): number[] {
  const lo = spot * 0.75; const hi = spot * 1.25;
  const step = (hi - lo) / 3000;
  const bvs: number[] = [];
  let prev = payoffAtExpiry(legs, lo, lotSize);
  for (let s = lo + step; s <= hi; s += step) {
    const cur = payoffAtExpiry(legs, s, lotSize);
    if (prev * cur < 0) bvs.push(+(s - step / 2).toFixed(0));
    prev = cur;
  }
  return bvs;
}

// Rough Black-Scholes delta approximation (no IV needed)
function approxDelta(spot: number, strike: number, type: "CE" | "PE", dte: number): number {
  if (spot <= 0) return type === "CE" ? 0.5 : -0.5;
  const σ = 0.15; // assumed annualised vol
  const T = Math.max(dte / 365, 1 / 365);
  const d1 = (Math.log(spot / strike) + 0.5 * σ * σ * T) / (σ * Math.sqrt(T));
  const nd1 = 0.5 * (1 + Math.tanh(d1 * 0.7071));
  return type === "CE" ? +nd1.toFixed(2) : +(nd1 - 1).toFixed(2);
}

function daysToExpiry(today: string, expiry: string): number {
  return Math.max(0, Math.round((new Date(expiry).getTime() - new Date(today).getTime()) / 86400000));
}

// ─── Black-Scholes pricer + implied-vol solver ────────────────────────────────
function normCDF(x: number): number {
  // A&S 7.1.26 erfc approximation: erfc(y) ≈ poly(t)*exp(-y²), t = 1/(1+0.3275911*y)
  // N(x) = 0.5*(1 + erf(x/√2)) = 0.5*(1 - erfc(|x|/√2))
  // So the erfc argument is |x|/√2 — divide by √2 in the t formula.
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2); // ← erfc argument is x/√2
  const y = 1 - (((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t) * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

function bsPrice(S: number, K: number, T: number, σ: number, type: "CE" | "PE", r = 0.065): number {
  if (T <= 0 || σ <= 0) return type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * σ * σ) * T) / (σ * sqrtT);
  const d2 = d1 - σ * sqrtT;
  return type === "CE"
    ? S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2)
    : K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function solveIV(mktPrice: number, S: number, K: number, T: number, type: "CE" | "PE"): number {
  if (T <= 0 || mktPrice <= 0 || S <= 0) return 0.20;
  const intrinsic = type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (mktPrice <= intrinsic + 0.01) return 0.001; // deep ITM — no extrinsic
  let lo = 0.001, hi = 6.0;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, type) > mktPrice) hi = mid; else lo = mid;
    if (hi - lo < 0.00005) break;
  }
  return (lo + hi) / 2;
}

function fmtOI(n: number): string {
  if (!isFinite(n) || n === 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_00_000) return (abs / 1_00_000).toFixed(1) + "L";
  if (abs >= 1_000)    return (abs / 1_000).toFixed(0) + "K";
  return abs.toFixed(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy definitions
// ─────────────────────────────────────────────────────────────────────────────

type StrategyLegDef = { type: "CE" | "PE"; action: "BUY" | "SELL"; offset: number };

interface StrategyDef {
  name: string;
  category: "bullish" | "bearish" | "neutral" | "other";
  legs: StrategyLegDef[];
  // Normalised x from -3..+3, y payoff value (positive = profit zone)
  shape: [number, number][];
}

const STRATEGIES: StrategyDef[] = [
  // ── Neutral ──────────────────────────────────────────────────────────────
  {
    name: "Short Straddle", category: "neutral",
    legs: [{ type: "CE", action: "SELL", offset: 0 }, { type: "PE", action: "SELL", offset: 0 }],
    shape: [[-3,-2],[-1.5,0],[0,2],[1.5,0],[3,-2]],
  },
  {
    name: "Short Strangle", category: "neutral",
    legs: [{ type: "CE", action: "SELL", offset: 1 }, { type: "PE", action: "SELL", offset: -1 }],
    shape: [[-3,-1.5],[-1.5,0],[-0.5,1.2],[0.5,1.2],[1.5,0],[3,-1.5]],
  },
  {
    name: "Iron Condor", category: "neutral",
    legs: [
      { type: "PE", action: "BUY", offset: -2 }, { type: "PE", action: "SELL", offset: -1 },
      { type: "CE", action: "SELL", offset: 1 },  { type: "CE", action: "BUY", offset: 2 },
    ],
    shape: [[-3,-1.5],[-2,-1.5],[-1,0],[0,1.2],[1,0],[2,-1.5],[3,-1.5]],
  },
  {
    name: "Iron Butterfly", category: "neutral",
    legs: [
      { type: "PE", action: "BUY", offset: -1 }, { type: "PE", action: "SELL", offset: 0 },
      { type: "CE", action: "SELL", offset: 0 },  { type: "CE", action: "BUY", offset: 1 },
    ],
    shape: [[-3,-1],[-1,-1],[0,1.5],[1,-1],[3,-1]],
  },
  {
    name: "Long Straddle", category: "neutral",
    legs: [{ type: "CE", action: "BUY", offset: 0 }, { type: "PE", action: "BUY", offset: 0 }],
    shape: [[-3,2],[-1.5,0],[0,-1.5],[1.5,0],[3,2]],
  },
  {
    name: "Long Strangle", category: "neutral",
    legs: [{ type: "CE", action: "BUY", offset: 1 }, { type: "PE", action: "BUY", offset: -1 }],
    shape: [[-3,2],[-1.5,0],[-0.5,-1.2],[0.5,-1.2],[1.5,0],[3,2]],
  },
  // ── Bullish ───────────────────────────────────────────────────────────────
  {
    name: "Bull Call Spread", category: "bullish",
    legs: [{ type: "CE", action: "BUY", offset: 0 }, { type: "CE", action: "SELL", offset: 1 }],
    shape: [[-3,-1],[-1,-1],[0,-0.3],[1,1.2],[3,1.2]],
  },
  {
    name: "Bull Put Spread", category: "bullish",
    legs: [{ type: "PE", action: "BUY", offset: -1 }, { type: "PE", action: "SELL", offset: 0 }],
    shape: [[-3,-1.2],[-1,-1.2],[0,0.3],[1,1],[3,1]],
  },
  {
    name: "Call Backspread", category: "bullish",
    legs: [
      { type: "CE", action: "SELL", offset: 0 },
      { type: "CE", action: "BUY", offset: 1 }, { type: "CE", action: "BUY", offset: 1 },
    ],
    shape: [[-3,0.5],[0,0.5],[1,-0.5],[2,1],[3,2.5]],
  },
  // ── Bearish ───────────────────────────────────────────────────────────────
  {
    name: "Bear Put Spread", category: "bearish",
    legs: [{ type: "PE", action: "BUY", offset: 0 }, { type: "PE", action: "SELL", offset: -1 }],
    shape: [[-3,1.2],[-1,1.2],[0,0.3],[1,-1],[3,-1]],
  },
  {
    name: "Bear Call Spread", category: "bearish",
    legs: [{ type: "CE", action: "BUY", offset: 1 }, { type: "CE", action: "SELL", offset: 0 }],
    shape: [[-3,1],[-1,1],[0,0],[1,-1.2],[3,-1.2]],
  },
  {
    name: "Put Backspread", category: "bearish",
    legs: [
      { type: "PE", action: "SELL", offset: 0 },
      { type: "PE", action: "BUY", offset: -1 }, { type: "PE", action: "BUY", offset: -1 },
    ],
    shape: [[-3,2.5],[-2,1],[-1,-0.5],[0,0.5],[3,0.5]],
  },
  // ── Other ─────────────────────────────────────────────────────────────────
  {
    name: "Batman", category: "other",
    legs: [
      { type: "PE", action: "BUY", offset: -2 }, { type: "PE", action: "SELL", offset: -1 },
      { type: "PE", action: "SELL", offset: 0 },  { type: "CE", action: "SELL", offset: 0 },
      { type: "CE", action: "SELL", offset: 1 },  { type: "CE", action: "BUY", offset: 2 },
    ],
    shape: [[-3,-1],[-2,-1],[-1,0.8],[0,1.5],[1,0.8],[2,-1],[3,-1]],
  },
  {
    name: "Jade Lizard", category: "other",
    legs: [
      { type: "PE", action: "SELL", offset: -1 },
      { type: "CE", action: "SELL", offset: 1 }, { type: "CE", action: "BUY", offset: 2 },
    ],
    shape: [[-3,-1],[-1.5,0],[0,1],[1,1],[2,0],[3,-0.5]],
  },
  {
    name: "Rev. Jade Lizard", category: "other",
    legs: [
      { type: "PE", action: "BUY", offset: -2 }, { type: "PE", action: "SELL", offset: -1 },
      { type: "CE", action: "SELL", offset: 1 },
    ],
    shape: [[-3,-0.5],[-2,0],[-1,1],[0,1],[1.5,0],[3,-1]],
  },
  {
    name: "Double Plateau", category: "other",
    legs: [
      { type: "PE", action: "BUY", offset: -3 }, { type: "PE", action: "SELL", offset: -2 },
      { type: "CE", action: "SELL", offset: 2 },  { type: "CE", action: "BUY", offset: 3 },
    ],
    shape: [[-3,-1.2],[-2,0],[-1,0.8],[0,0.8],[1,0.8],[2,0],[3,-1.2]],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Mini payoff SVG — filled green/red zones like StockMojo
// ─────────────────────────────────────────────────────────────────────────────

function MiniPayoff({ shape }: { shape: [number, number][] }) {
  const W = 130; const H = 70; const pad = 10;
  const xs = shape.map(([x]) => x);
  const ys = shape.map(([, y]) => y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = Math.max(maxY - minY, 0.5) * 1.15;
  const midY = (maxY + minY) / 2;

  const toX = (x: number) => pad + ((x - minX) / rangeX) * (W - 2 * pad);
  const toY = (y: number) => H - pad - ((y - (midY - rangeY / 2)) / rangeY) * (H - 2 * pad);
  const zeroY = toY(0);

  // Build interpolated points along the shape
  const pts: [number, number][] = shape.map(([x, y]) => [toX(x), toY(y)]);

  // Split path into above-zero and below-zero segments for filled areas
  const segments: { points: [number, number][]; positive: boolean }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const v1 = shape[i][1]; const v2 = shape[i + 1][1];
    const pos1 = v1 >= 0; const pos2 = v2 >= 0;
    if (pos1 === pos2) {
      const last = segments[segments.length - 1];
      if (last && last.positive === pos1) {
        last.points.push([x2, y2]);
      } else {
        segments.push({ points: [[x1, y1], [x2, y2]], positive: pos1 });
      }
    } else {
      // Interpolate crossing point
      const t = Math.abs(v1) / (Math.abs(v1) + Math.abs(v2));
      const cx = x1 + t * (x2 - x1);
      const cy = zeroY;
      const last = segments[segments.length - 1];
      if (last && last.positive === pos1) last.points.push([cx, cy]);
      else segments.push({ points: [[x1, y1], [cx, cy]], positive: pos1 });
      segments.push({ points: [[cx, cy], [x2, y2]], positive: pos2 });
    }
  }

  const polyPts = pts.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      {/* Background */}
      <rect x={pad} y={pad} width={W - 2 * pad} height={H - 2 * pad} rx={3} fill="#111827" />
      {/* Zero line */}
      <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke="#374151" strokeWidth="1" />
      {/* Filled segments */}
      {segments.map((seg, idx) => {
        if (seg.points.length < 2) return null;
        const first = seg.points[0];
        const last = seg.points[seg.points.length - 1];
        const segPts = seg.points.map(([x, y]) => `${x},${y}`).join(" ");
        const color = seg.positive ? "#16a34a" : "#dc2626";
        const fillColor = seg.positive ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.2)";
        const closePath = `${segPts} ${last[0]},${zeroY} ${first[0]},${zeroY}`;
        return (
          <polygon key={idx} points={closePath} fill={fillColor} stroke="none" />
        );
      })}
      {/* Main line */}
      <polyline
        points={polyPts}
        fill="none"
        stroke="#9ca3af"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Colored line segments */}
      {segments.map((seg, idx) => {
        if (seg.points.length < 2) return null;
        const segPts = seg.points.map(([x, y]) => `${x},${y}`).join(" ");
        const color = seg.positive ? "#4ade80" : "#f87171";
        return (
          <polyline
            key={`line-${idx}`}
            points={segPts}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy card
// ─────────────────────────────────────────────────────────────────────────────

function StrategyCard({ strategy, onSelect }: { strategy: StrategyDef; onSelect: () => void }) {
  const catColors = {
    bullish: "border-emerald-500/30 hover:border-emerald-400/60",
    bearish: "border-red-500/30 hover:border-red-400/60",
    neutral: "border-blue-500/30 hover:border-blue-400/60",
    other:   "border-violet-500/30 hover:border-violet-400/60",
  };
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-col items-center gap-2 p-3 rounded-xl bg-[#111827] border transition-all group hover:bg-[#1a2234] ${catColors[strategy.category]}`}
    >
      <MiniPayoff shape={strategy.shape} />
      <span className="text-[10px] font-semibold text-muted-foreground group-hover:text-foreground transition-colors">
        {strategy.name}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom tooltip for payoff chart
// ─────────────────────────────────────────────────────────────────────────────

function PayoffTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const expiry = payload.find((p: any) => p.dataKey === "pnlPos" || p.dataKey === "pnlNeg");
  const today = payload.find((p: any) => p.dataKey === "pnlToday");
  // Reconstruct full expiry P&L from the split pos/neg areas
  const expiryVal: number = expiry ? (expiry.dataKey === "pnlPos" ? expiry.value : expiry.value) : (payload[0]?.value ?? 0);
  const todayVal: number = today?.value ?? null;
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}₹${Math.round(v).toLocaleString("en-IN")}`;
  return (
    <div className="bg-card border border-border rounded px-2.5 py-1.5 text-xs shadow-lg space-y-0.5">
      <p className="text-muted-foreground">Spot: ₹{Number(label).toLocaleString("en-IN")}</p>
      <p className={`font-bold ${expiryVal >= 0 ? "text-emerald-400" : "text-red-400"}`}>
        At expiry: {fmt(expiryVal)}
      </p>
      {todayVal !== null && (
        <p className={`font-semibold ${todayVal >= 0 ? "text-sky-400" : "text-sky-400/70"}`}>
          Today (MtM): {fmt(todayVal)}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OI horizontal bar (styled like StockMojo)
// ─────────────────────────────────────────────────────────────────────────────

function OIHBar({ value, max, color, align }: { value: number; max: number; color: string; align: "left" | "right" }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className={`flex items-center w-full ${align === "right" ? "justify-end" : "justify-start"}`}>
      <div className="w-20 h-2 bg-muted/20 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{
            width: `${pct}%`,
            marginLeft: align === "right" ? "auto" : 0,
          }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Time navigator helpers
// ─────────────────────────────────────────────────────────────────────────────

// Returns true when the simulator clock is on or after the leg's entry timestamp.
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

function addMinutes(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + delta;
  total = Math.max(9 * 60 + 15, Math.min(15 * 60 + 30, total));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date + Time picker popover
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW_NAMES   = ["Su","Mo","Tu","We","Th","Fr","Sa"];

function DateTimePicker({
  value, time, expiries, minDate, maxDate, holidaySet, onConfirm, onClose,
}: {
  value: string;
  time: string;
  expiries: string[];
  minDate?: string;
  maxDate?: string;
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

  const expirySet = useMemo(() => new Set(expiries), [expiries]);

  // Calendar grid for current view month
  const calDays = useMemo(() => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const lastDate = new Date(viewYear, viewMonth + 1, 0).getDate();
    const cells: Array<string | null> = Array(firstDow).fill(null);
    for (let d = 1; d <= lastDate; d++) {
      cells.push(`${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewYear, viewMonth]);

  const prevMonth = () => { if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else { setViewMonth(m => m - 1); } };
  const nextMonth = () => { if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else { setViewMonth(m => m + 1); } };

  const hours   = useMemo(() => Array.from({ length: 7 }, (_, i) => i + 9), []);  // 9–15
  const minutes = useMemo(() => Array.from({ length: draftHour === 15 ? 30 : 60 }, (_, i) => i), [draftHour]);

  // Clamp minute to 29 when hour switches to 15 (market closes at 15:30, so last valid minute is 15:29)
  useEffect(() => {
    if (draftHour === 15 && draftMin > 29) setDraftMin(29);
  }, [draftHour, draftMin]);

  const hourRef = useRef<HTMLDivElement>(null);
  const minRef  = useRef<HTMLDivElement>(null);
  useEffect(() => {
    hourRef.current?.querySelector<HTMLElement>(`[data-h="${draftHour}"]`)?.scrollIntoView({ block: "center" });
  }, [draftHour]);
  useEffect(() => {
    minRef.current?.querySelector<HTMLElement>(`[data-m="${draftMin}"]`)?.scrollIntoView({ block: "center" });
  }, [draftMin]);

  // Close on outside click or Escape
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={wrapRef}
      className="absolute z-50 top-full left-1/2 -translate-x-1/2 mt-1 bg-[#0d1117] border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col"
      style={{ width: 420 }}
    >
      <div className="flex">
        {/* ── Calendar ──────────────────────────────────────────────────── */}
        <div className="flex-1 p-3">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={prevMonth}
              className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-bold text-foreground">
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button type="button" onClick={nextMonth}
              className="p-1 rounded hover:bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Day-of-week headers */}
          <div className="grid grid-cols-7 mb-1">
            {DOW_NAMES.map(d => (
              <div key={d} className="text-center text-[9px] text-muted-foreground/60 font-semibold py-0.5">{d}</div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-y-1">
            {calDays.map((dateStr, i) => {
              if (!dateStr) return <div key={i} />;
              const isExpiry   = expirySet.has(dateStr);
              const isSelected = dateStr === draftDate;
              const isDisabled = (maxDate && dateStr > maxDate) || (minDate && dateStr < minDate);
              const dow        = new Date(dateStr + "T00:00:00").getDay();
              const isMarketOff = dow === 0 || dow === 6 || (holidaySet?.has(dateStr) ?? false);
              const day = parseInt(dateStr.slice(8));
              return (
                <button
                  key={dateStr}
                  type="button"
                  disabled={!!isDisabled}
                  onClick={() => { setDraftDate(dateStr); setViewYear(parseInt(dateStr.slice(0,4))); setViewMonth(parseInt(dateStr.slice(5,7))-1); }}
                  title={isExpiry ? `Expiry: ${dateStr}` : isMarketOff ? "Market closed" : dateStr}
                  className={`h-7 w-7 mx-auto rounded-full flex items-center justify-center text-[11px] font-medium transition-all ${
                    isSelected
                      ? "bg-primary text-primary-foreground font-bold ring-2 ring-primary/50"
                      : isExpiry
                      ? "bg-emerald-500 text-white hover:bg-emerald-400 font-bold"
                      : isDisabled
                      ? "text-foreground/20 cursor-not-allowed"
                      : isMarketOff
                      ? "text-red-500/70 hover:bg-red-500/10 hover:text-red-400"
                      : "text-foreground/75 hover:bg-muted/40 hover:text-foreground"
                  }`}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mt-2.5 pt-2 border-t border-border/30">
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-emerald-500" />
              <span className="text-[9px] text-muted-foreground">Expiry Day</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-full bg-primary" />
              <span className="text-[9px] text-muted-foreground">Selected</span>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="w-px bg-border/30 my-3" />

        {/* ── Time picker ───────────────────────────────────────────────── */}
        <div className="flex items-start pt-3 px-3 gap-1">
          {/* Hours */}
          <div ref={hourRef} className="h-44 overflow-y-auto w-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {hours.map(h => (
              <button key={h} data-h={h} type="button" onClick={() => setDraftHour(h)}
                className={`w-full h-8 flex items-center justify-center text-[13px] font-semibold rounded transition-colors ${
                  h === draftHour ? "bg-primary text-primary-foreground" : "text-foreground/55 hover:bg-muted/30 hover:text-foreground"
                }`}>
                {String(h).padStart(2, "0")}
              </button>
            ))}
          </div>

          <div className="flex items-center h-8 text-foreground/40 font-bold text-base mt-1">:</div>

          {/* Minutes */}
          <div ref={minRef} className="h-44 overflow-y-auto w-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {minutes.map(m => (
              <button key={m} data-m={m} type="button" onClick={() => setDraftMin(m)}
                className={`w-full h-8 flex items-center justify-center text-[13px] font-semibold rounded transition-colors ${
                  m === draftMin ? "bg-primary text-primary-foreground" : "text-foreground/55 hover:bg-muted/30 hover:text-foreground"
                }`}>
                {String(m).padStart(2, "0")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* OK / Cancel */}
      <div className="flex justify-end gap-2 px-3 pb-3 pt-1 border-t border-border/30 mt-1">
        <button type="button" onClick={onClose}
          className="px-3 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors">
          Cancel
        </button>
        <button type="button"
          onClick={() => {
            const t = `${String(draftHour).padStart(2, "0")}:${String(draftMin).padStart(2, "0")}`;
            onConfirm(draftDate, t);
          }}
          className="px-5 py-1 rounded bg-primary text-primary-foreground text-xs font-bold hover:opacity-90 transition-opacity">
          OK
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main simulator
// ─────────────────────────────────────────────────────────────────────────────

export default function OptionsSimulator() {
  const { optionsData, asOfOptionsDate, lotSizes: csvLotSizes, histories, holidays } = useData();
  const holidaySet = useMemo(() => new Set(holidays.map((h) => h.date)), [holidays]);

  // Sort symbols: indices first (INDEX_ORDER), then alphabetical stocks
  const symbols = useMemo(() => {
    if (!optionsData) return [];
    const all = Array.from(optionsData.expiriesBySymbol.keys());
    const indices = INDEX_ORDER.filter((s) => all.includes(s));
    const stocks = all.filter((s) => !INDEX_ORDER.includes(s)).sort();
    return [...indices, ...stocks];
  }, [optionsData]);

  const [selectedSymbol, setSelectedSymbol] = useState<string>("");
  const activeSymbol = selectedSymbol || symbols[0] || "";

  const expiries = useMemo(() => {
    if (!optionsData || !activeSymbol) return [];
    return optionsData.expiriesBySymbol.get(activeSymbol) ?? [];
  }, [optionsData, activeSymbol]);

  const [selectedExpiry, setSelectedExpiry] = useState<string>("");

  // Available dates for the loaded dataset
  const availableDates = useMemo(() => optionsData?.dates ?? [], [optionsData]);

  const latestDate = useMemo(
    () => asOfOptionsDate ?? availableDates[availableDates.length - 1] ?? null,
    [asOfOptionsDate, availableDates],
  );

  // Simulated date + time
  const [simDate, setSimDate] = useState<string>(() => latestDate ?? "");
  const effectiveDate = simDate || latestDate || "";
  const [simTime, setSimTime] = useState("09:15");

  // Only show expiries that haven't already passed relative to the sim date
  const visibleExpiries = useMemo(
    () => expiries.filter((e) => e >= effectiveDate),
    [expiries, effectiveDate],
  );

  // Auto-select nearest visible expiry when no explicit manual selection
  // Must be declared AFTER effectiveDate
  const activeExpiry = useMemo(() => {
    if (selectedExpiry && visibleExpiries.includes(selectedExpiry)) return selectedExpiry;
    if (!visibleExpiries.length) return expiries[expiries.length - 1] ?? "";
    return visibleExpiries[0];
  }, [selectedExpiry, visibleExpiries, expiries]);

  // When latestDate changes (data loaded), update simDate
  useMemo(() => {
    if (latestDate && !simDate) setSimDate(latestDate);
  }, [latestDate]);

  // Spot (underlying) price — from equity bhavcopy / DB histories
  const spotPrice = useMemo(() => {
    if (!activeSymbol || !effectiveDate || !histories.length) return 0;
    const h = histories.find((h) => h.symbol === activeSymbol);
    if (!h) return 0;
    // Walk backwards to find the closest bar on or before effectiveDate
    for (let i = h.bars.length - 1; i >= 0; i--) {
      if (h.bars[i].date <= effectiveDate) return h.bars[i].close;
    }
    return 0;
  }, [activeSymbol, effectiveDate, histories]);

  // Futures price (front-month) — primary reference for ATM / payoff;
  // falls back to underlying close when no futures data is available
  // (the DB auto-load path never populates futuresCloseByKey).
  const spot = useMemo(() => {
    if (!optionsData || !activeSymbol || !effectiveDate) return 0;
    const key = `${activeSymbol}|${effectiveDate}`;
    const futuresClose = optionsData.futuresCloseByKey.get(key) ?? 0;
    if (futuresClose > 0) return futuresClose;
    return spotPrice; // fall back to underlying close when no futures data
  }, [optionsData, activeSymbol, effectiveDate, spotPrice]);

  // Build options chain for selected symbol + expiry + date
  const chain = useMemo(() => {
    if (!optionsData || !activeSymbol || !activeExpiry || !effectiveDate) return [];
    const strikeKey = `${activeSymbol}|${activeExpiry}`;
    const strikes = optionsData.strikesByKey.get(strikeKey) ?? [];
    const map = new Map<number, { ce: number; pe: number; ceOI: number; peOI: number }>();
    for (const b of optionsData.bars) {
      if (b.symbol !== activeSymbol || b.expiry !== activeExpiry || b.date !== effectiveDate) continue;
      const entry = map.get(b.strike) ?? { ce: 0, pe: 0, ceOI: 0, peOI: 0 };
      if (b.type === "CE") { entry.ce = b.close; entry.ceOI = b.oi; }
      else { entry.pe = b.close; entry.peOI = b.oi; }
      map.set(b.strike, entry);
    }
    return strikes
      .filter((s) => map.has(s))
      .map((s) => ({ strike: s, ...(map.get(s) ?? { ce: 0, pe: 0, ceOI: 0, peOI: 0 }) }));
  }, [optionsData, activeSymbol, activeExpiry, effectiveDate]);

  const maxOI = useMemo(() => Math.max(1, ...chain.map((r) => Math.max(r.ceOI, r.peOI))), [chain]);
  const atmK = useMemo(() => {
    if (!spot || !chain.length) return 0;
    return atmStrike(spot, undefined, chain.map((r) => r.strike)) ?? 0;
  }, [spot, chain]);
  const dte = useMemo(() => daysToExpiry(effectiveDate, activeExpiry), [effectiveDate, activeExpiry]);
  const lotSize = getLotSizeForExpiry(
    csvLotSizes, activeSymbol, activeExpiry,
    FALLBACK_LOT_SIZES[activeSymbol] ?? 1,
  );

  // Expiry scroll ref for left/right arrow navigation
  const expiryScrollRef = useRef<HTMLDivElement>(null);

  // Chain scroll ref — used to keep ATM row centered
  const chainScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chainScrollRef.current || !atmK) return;
    const el = chainScrollRef.current.querySelector<HTMLElement>('[data-atm="true"]');
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [atmK, activeExpiry]);

  // Step through VISIBLE expiries with left/right arrows
  const stepExpiry = (dir: "left" | "right") => {
    const idx = visibleExpiries.indexOf(activeExpiry);
    const base = idx < 0 ? 0 : idx;
    const next = dir === "left" ? visibleExpiries[base - 1] : visibleExpiries[base + 1];
    if (next) setSelectedExpiry(next);
  };

  // Scroll the active expiry tab into view whenever it changes
  useEffect(() => {
    if (!expiryScrollRef.current || !activeExpiry) return;
    const el = expiryScrollRef.current.querySelector<HTMLButtonElement>(
      `[data-expiry="${activeExpiry}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeExpiry]);

  // Legs state
  const [pickerOpen, setPickerOpen] = useState(false);

  const [legs, setLegs] = useState<SimLeg[]>([]);
  const [multiplier, setMultiplier] = useState(1);
  const [rightView, setRightView] = useState<"payoff" | "strategies" | "history">("strategies");
  const [stratFilter, setStratFilter] = useState<"bullish" | "bearish" | "neutral" | "other">("neutral");
  const [chartZoom, setChartZoom] = useState<"narrow" | "normal" | "wide">("narrow");
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);
  // Inline action state: squareoff (with lot picker) or delete (with confirm)
  const [legAction, setLegAction] = useState<{ type: "squareoff" | "delete"; id: string; lots: number } | null>(null);
  const [simHistory, setSimHistory] = useState<ApiSimTrade[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // "strike|type" → actions[] — drives position indicators in the chain table
  const legIndex = useMemo(() => {
    const map = new Map<string, ("BUY" | "SELL")[]>();
    for (const leg of legs) {
      const key = `${leg.strike}|${leg.type}`;
      map.set(key, [...(map.get(key) ?? []), leg.action]);
    }
    return map;
  }, [legs]);

  // Price map across ALL expiries that legs use (so LTP stays correct when activeExpiry differs)
  const legPriceMap = useMemo(() => {
    const map = new Map<string, { ce: number; pe: number }>();
    if (!optionsData || !activeSymbol || !effectiveDate) return map;
    const neededExpiries = new Set([activeExpiry, ...legs.map((l) => l.expiry).filter(Boolean)]);
    for (const b of optionsData.bars) {
      if (b.symbol !== activeSymbol || b.date !== effectiveDate || !neededExpiries.has(b.expiry)) continue;
      const key = `${b.expiry}|${b.strike}`;
      const entry = map.get(key) ?? { ce: 0, pe: 0 };
      if (b.type === "CE") entry.ce = b.close; else entry.pe = b.close;
      map.set(key, entry);
    }
    return map;
  }, [optionsData, activeSymbol, effectiveDate, activeExpiry, legs]);

  // Helper: get current LTP for any leg regardless of its expiry
  const getLegLTP = useCallback((leg: SimLeg): number => {
    const key = `${leg.expiry}|${leg.strike}`;
    const row = legPriceMap.get(key);
    if (!row) return leg.entryPrice;
    return leg.type === "CE" ? row.ce : row.pe;
  }, [legPriceMap]);

  // Auto-squareoff: expire legs whose expiry date has passed (or is today at/after 15:30)
  useEffect(() => {
    if (!effectiveDate || !legs.length) return;
    const expired = legs.filter((l) => {
      if (!l.expiry) return false;
      if (l.expiry < effectiveDate) return true;
      if (l.expiry === effectiveDate && simTime >= "15:30") return true;
      return false;
    });
    if (expired.length) {
      const expiredIds = new Set(expired.map((l) => l.id));
      setLegs((prev) => prev.filter((l) => !expiredIds.has(l.id)));
    }
  }, [effectiveDate, simTime, legs]);

  const addLeg = useCallback((strike: number, type: "CE" | "PE", action: "BUY" | "SELL", price: number) => {
    if (price <= 0) return;
    setLegs((prev) => [...prev, {
      id: crypto.randomUUID(),
      strike, type, action,
      lots: multiplier, entryPrice: price,
      addedDate: effectiveDate, addedTime: simTime,
      expiry: activeExpiry,
    }]);
    setRightView("payoff");
  }, [multiplier, effectiveDate, simTime, activeExpiry]);

  const removeLeg = useCallback((id: string) => {
    setLegs((prev) => prev.filter((l) => l.id !== id));
    setLegAction(null);
  }, []);

  // ── Trade history ──────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const trades = await apiListSimTrades("options");
      setSimHistory(trades);
    } catch { /* silent */ }
    finally { setHistoryLoading(false); }
  }, []);

  useEffect(() => { void fetchHistory(); }, [fetchHistory]);

  // Square off N lots: record to history, then remove/reduce
  const squareOffLeg = useCallback(async (id: string, lotsToSquareOff: number, legLotSize: number) => {
    const leg = legs.find(l => l.id === id);
    if (leg) {
      const exitPrice = getLegLTP(leg);
      const pnl = (leg.action === "BUY"
        ? exitPrice - leg.entryPrice
        : leg.entryPrice - exitPrice) * lotsToSquareOff * legLotSize;
      const exitDate = effectiveDate || new Date().toISOString().slice(0, 10);
      const exitTime = simTime || "15:30";
      const symbolLabel = `${activeSymbol} ${leg.strike} ${leg.type} ${leg.expiry}`;
      try {
        await apiRecordSimTrade({
          simulator_type: "options",
          symbol: symbolLabel,
          underlying: activeSymbol,
          strike: leg.strike,
          option_type: leg.type,
          expiry: leg.expiry,
          action: leg.action,
          qty: lotsToSquareOff,
          lot_size: legLotSize,
          entry_price: leg.entryPrice,
          exit_price: exitPrice,
          entry_date: leg.addedDate,
          entry_time: leg.addedTime,
          exit_date: exitDate,
          exit_time: exitTime,
          realized_pnl: pnl,
          notes: null,
        });
        toast.success(`Squared off ${leg.strike}${leg.type}: ${pnl >= 0 ? "+" : ""}₹${Math.round(Math.abs(pnl)).toLocaleString("en-IN")}`);
        void fetchHistory();
      } catch {
        toast.error("Failed to save to trade history");
      }
    }
    setLegs((prev) => prev.flatMap((l) => {
      if (l.id !== id) return [l];
      const remaining = l.lots - lotsToSquareOff;
      return remaining > 0 ? [{ ...l, lots: remaining }] : [];
    }));
    setLegAction(null);
  }, [legs, getLegLTP, effectiveDate, simTime, activeSymbol, fetchHistory]);
  const updateLots = useCallback((id: string, delta: number) =>
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, lots: Math.max(1, l.lots + delta) } : l)), []);

  const updateExpiry = useCallback((id: string, expiry: string) =>
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, expiry } : l)), []);

  const updateLegSL  = useCallback((id: string, val: number | undefined) =>
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, sl: val } : l)), []);
  const updateLegTgt = useCallback((id: string, val: number | undefined) =>
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, tgt: val } : l)), []);

  // Ref: true while user is actively typing in an SL or TGT input — pauses breach check
  const editingSlTgt = useRef(false);

  // Auto squareoff toggles: true = square off on breach, false = alert only
  const [autoSL,  setAutoSL]  = useState(false);
  const [autoTgt, setAutoTgt] = useState(false);

  // Auto-squareoff on SL / Target breach (only for active legs)
  useEffect(() => {
    if (!legs.length || editingSlTgt.current) return;
    const toSquareOff: string[] = [];
    for (const leg of legs) {
      if (!isLegActive(leg.addedDate ?? "", leg.addedTime ?? "00:00", effectiveDate, simTime)) continue;
      const ltp = getLegLTP(leg);
      if (ltp <= 0) continue;
      const isBuy = leg.action === "BUY";
      if (leg.sl !== undefined && leg.sl > 0) {
        const breached = isBuy ? ltp <= leg.sl : ltp >= leg.sl;
        if (breached) {
          toast.warning(`SL hit: ${leg.strike}${leg.type} @ ${ltp.toFixed(2)}`);
          if (autoSL) toSquareOff.push(leg.id);
        }
      }
      if (leg.tgt !== undefined && leg.tgt > 0) {
        const breached = isBuy ? ltp >= leg.tgt : ltp <= leg.tgt;
        if (breached) {
          toast.success(`Target hit: ${leg.strike}${leg.type} @ ${ltp.toFixed(2)}`);
          if (autoTgt) toSquareOff.push(leg.id);
        }
      }
    }
    if (toSquareOff.length) {
      setLegs((prev) => prev.filter((l) => !toSquareOff.includes(l.id)));
    }
  }, [legs, getLegLTP, autoSL, autoTgt]);

  const updateAction = useCallback((id: string) =>
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, action: l.action === "BUY" ? "SELL" : "BUY" } : l)), []);

  const updateType = useCallback((id: string) => {
    setLegs((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const newType: "CE" | "PE" = l.type === "CE" ? "PE" : "CE";
      const row = chain.find((r) => r.strike === l.strike);
      const newPrice = newType === "CE" ? (row?.ce ?? l.entryPrice) : (row?.pe ?? l.entryPrice);
      return { ...l, type: newType, entryPrice: newPrice > 0 ? newPrice : l.entryPrice };
    }));
  }, [chain]);

  const updateStrike = useCallback((id: string, delta: number) => {
    const strikes = chain.map((r) => r.strike).sort((a, b) => a - b);
    setLegs((prev) => prev.map((l) => {
      if (l.id !== id || !strikes.length) return l;
      const idx = strikes.indexOf(l.strike);
      const next = Math.max(0, Math.min(strikes.length - 1, (idx < 0 ? 0 : idx) + delta));
      const newStrike = strikes[next];
      const row = chain.find((r) => r.strike === newStrike);
      const newPrice = l.type === "CE" ? (row?.ce ?? l.entryPrice) : (row?.pe ?? l.entryPrice);
      return { ...l, strike: newStrike, entryPrice: newPrice > 0 ? newPrice : l.entryPrice };
    }));
  }, [chain]);

  const clearLegs = useCallback(() => {
    setLegs([]);
    setRightView("strategies");
    setSelectedExpiry("");
    setSimDate(latestDate ?? "");
    setSimTime("09:15");
    setMultiplier(1);
  }, [latestDate]);

  // Apply ready-made strategy
  const applyStrategy = useCallback((strat: StrategyDef) => {
    if (!chain.length || !atmK) return;
    const strikes = chain.map((r) => r.strike).sort((a, b) => a - b);
    const atmIdx = strikes.indexOf(atmK);
    if (atmIdx < 0) return;
    const newLegs: SimLeg[] = [];
    for (const def of strat.legs) {
      const idx = atmIdx + def.offset;
      if (idx < 0 || idx >= strikes.length) continue;
      const strike = strikes[idx];
      const row = chain.find((r) => r.strike === strike);
      if (!row) continue;
      const price = def.type === "CE" ? row.ce : row.pe;
      if (price <= 0) continue;
      newLegs.push({
        id: crypto.randomUUID(), strike, type: def.type, action: def.action,
        lots: multiplier, entryPrice: price,
        addedDate: effectiveDate, addedTime: simTime,
        expiry: activeExpiry,
      });
    }
    if (newLegs.length) { setLegs(newLegs); setRightView("payoff"); }
  }, [chain, atmK, multiplier, effectiveDate, simTime]);

  // Time navigation
  const handleTimeStep = useCallback((step: typeof TIME_STEPS[number]) => {
    if (step.type === "sod") { setSimTime("09:15"); return; }
    if (step.type === "eod") { setSimTime("15:30"); return; }
    if (step.type === "min") { setSimTime((t) => addMinutes(t, step.delta)); return; }
    if (step.type === "date") {
      setSimDate((cur) => {
        const idx = availableDates.indexOf(cur);
        if (idx < 0) return cur;
        const next = availableDates[idx + step.delta];
        return next ?? cur;
      });
    }
  }, [availableDates]);

  // Payoff chart data
  const payoffData = useMemo(() => {
    if (!legs.length || !spot) return [];
    // Only active legs contribute to payoff/stats
    const activeLegs = legs.filter(l => isLegActive(l.addedDate ?? "", l.addedTime ?? "00:00", effectiveDate, simTime));
    if (!activeLegs.length) return [];
    const lo = spot * 0.82; const hi = spot * 1.18;
    const steps = 150; const step = (hi - lo) / steps;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const s = lo + i * step;
      return { spot: +s.toFixed(0), pnl: +payoffAtExpiry(activeLegs, s, lotSize).toFixed(0) };
    });
  }, [legs, spot, lotSize, effectiveDate, simTime]);

  // Combined payoff + OI data for the chart — zoom-aware window, OI bars only ±8 strikes from ATM
  const payoffChartData = useMemo(() => {
    if (!legs.length || !spot) return [];
    // Only active legs in the chart
    const activeLegs = legs.filter(l => isLegActive(l.addedDate ?? "", l.addedTime ?? "00:00", effectiveDate, simTime));
    if (!activeLegs.length) return [];
    const pts = chartZoom === "narrow" ? 500 : chartZoom === "wide" ? 2000 : 1000;
    const lo = spot - pts; const hi = spot + pts;
    const steps = 300; const step = (hi - lo) / steps;

    // Pre-compute per-leg IV from current market price (once, at current spot)
    const T = Math.max(dte / 365, 1 / 365);
    const legIVs = activeLegs.map((leg) => {
      const row = chain.find((r) => r.strike === leg.strike);
      const mktPrice = row ? (leg.type === "CE" ? row.ce : row.pe) : leg.entryPrice;
      return mktPrice > 0 ? solveIV(mktPrice, spot, leg.strike, T, leg.type) : 0.20;
    });

    // Find ATM index and restrict OI bars to ±8 strikes from ATM
    const sortedStrikes = [...chain.map((r) => r.strike)].sort((a, b) => a - b);
    const atmIdx = sortedStrikes.length
      ? sortedStrikes.reduce((best, s, i) => Math.abs(s - spot) < Math.abs(sortedStrikes[best] - spot) ? i : best, 0)
      : -1;
    const nearbyOiStrikes = atmIdx >= 0
      ? new Set(sortedStrikes.slice(Math.max(0, atmIdx - 8), atmIdx + 9))
      : new Set<number>();

    const oiMap = new Map(chain.map((r) => [r.strike, { ceOI: r.ceOI, peOI: r.peOI }]));
    const raw = Array.from({ length: steps + 1 }, (_, i) => {
      const s = lo + i * step;
      const pnl = +payoffAtExpiry(activeLegs, s, lotSize).toFixed(0);

      // Today's mark-to-market P&L — re-price each active leg at hypothetical spot using its IV
      const pnlToday = +activeLegs.reduce((total, leg, li) => {
        const theorPrice = bsPrice(s, leg.strike, T, legIVs[li], leg.type);
        const legPnl = leg.action === "BUY"
          ? (theorPrice - leg.entryPrice) * leg.lots * lotSize
          : (leg.entryPrice - theorPrice) * leg.lots * lotSize;
        return total + legPnl;
      }, 0).toFixed(0);

      const closest = sortedStrikes.length
        ? sortedStrikes.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a)
        : null;
      const inNearby = closest !== null && nearbyOiStrikes.has(closest);
      const oi = inNearby && Math.abs(closest - s) < step * 0.6 ? oiMap.get(closest) : null;
      return { spot: +s.toFixed(0), pnl, pnlToday, pnlPos: Math.max(pnl, 0), pnlNeg: Math.min(pnl, 0), ceOI: oi?.ceOI ?? null, peOI: oi?.peOI ?? null };
    });

    // Normalize OI bars to fit within ≤20% of the visible P&L range so they
    // render as subtle background bars on the same pnl axis (no hidden axis needed)
    const maxOI = Math.max(...raw.map(d => Math.max(d.ceOI ?? 0, d.peOI ?? 0)), 1);
    const absMaxPnl = Math.max(...raw.map(d => Math.max(Math.abs(d.pnl), Math.abs(d.pnlToday))), 1);
    const oiScale = (absMaxPnl * 0.20) / maxOI;
    return raw.map(d => ({
      ...d,
      ceOINorm: d.ceOI !== null ? +(d.ceOI * oiScale).toFixed(0) : null,
      peOINorm: d.peOI !== null ? +(-d.peOI * oiScale).toFixed(0) : null,
    }));
  }, [legs, spot, lotSize, chain, chartZoom, dte, effectiveDate, simTime]);

  // 1SD implied move from ATM straddle price (≈ 0.68 × (CE + PE))
  const sdMove = useMemo(() => {
    if (!spot || !atmK || !chain.length) return 0;
    const atm = chain.find((r) => r.strike === atmK);
    if (!atm || atm.ce <= 0 || atm.pe <= 0) return 0;
    return 0.68 * (atm.ce + atm.pe);
  }, [spot, atmK, chain]);

  // Split payoff for green/red areas (kept for legacy yDomain calc)
  const payoffAbove = useMemo(() => payoffData.map((d) => ({ ...d, pnlPos: Math.max(d.pnl, 0), pnlNeg: Math.min(d.pnl, 0) })), [payoffData]);

  // Stats
  const stats = useMemo(() => {
    if (!legs.length || !payoffData.length || !spot) return null;
    const pnls = payoffData.map((d) => d.pnl);
    // Wide sweep: spot=1 (captures long-PE near-zero max) + 5% to 500% of spot
    const wideSteps = 400;
    const widePnls = [
      payoffAtExpiry(legs, 1, lotSize), // spot ≈ 0 — true max for long PE
      ...Array.from({ length: wideSteps + 1 }, (_, i) =>
        payoffAtExpiry(legs, spot * 0.05 + spot * 4.95 * (i / wideSteps), lotSize)
      ),
    ];
    const maxProfit = Math.max(...widePnls);
    const maxLoss   = Math.min(...widePnls);
    // Detect unlimited by slope at far upside:
    // If payoff is still RISING between 8× and 10× spot → net long CE exposure → profit is unlimited
    // If payoff is still FALLING between 8× and 10× spot → net short CE exposure → loss is unlimited
    // A long/short PE flattens out at high spot (payoff = ±premium), so slope ≈ 0 → not unlimited
    const payoffAt8x  = payoffAtExpiry(legs, spot * 8,  lotSize);
    const payoffAt10x = payoffAtExpiry(legs, spot * 10, lotSize);
    const slopeHigh = payoffAt10x - payoffAt8x;
    const maxProfitUnlimited = slopeHigh > 1;   // still rising  → long CE net exposure
    const maxLossUnlimited   = slopeHigh < -1;  // still falling → short CE net exposure
    // POP uses chart-range pnls (realistic window)
    const pop = +(pnls.filter((p) => p > 0).length / pnls.length * 100).toFixed(0);
    const bvs = computeBreakevens(legs, lotSize, spot);
    // MtM P&L: only active legs contribute to the current P&L shown in the stats bar
    const activeLegs = legs.filter(l => isLegActive(l.addedDate ?? "", l.addedTime ?? "00:00", effectiveDate, simTime));
    const currentPnl = activeLegs.reduce((total, leg) => {
      const mktPrice = getLegLTP(leg);
      if (mktPrice <= 0) return total;
      const diff = leg.action === "BUY" ? mktPrice - leg.entryPrice : leg.entryPrice - mktPrice;
      return total + diff * leg.lots * lotSize;
    }, 0);
    const margin = activeLegs.filter((l) => l.action === "SELL").reduce((s, l) => s + l.entryPrice * l.lots * lotSize * 5, 0)
      || activeLegs.reduce((s, l) => s + l.entryPrice * l.lots * lotSize, 0);
    return { maxProfit, maxLoss, maxProfitUnlimited, maxLossUnlimited, pop, bvs, currentPnl, margin };
  }, [legs, payoffData, lotSize, spot, chain, effectiveDate, simTime]);

  const yDomain = useMemo(() => {
    if (!payoffChartData.length) return [-10000, 50000];
    const allPnls = payoffChartData.flatMap((d) => [d.pnl, d.pnlToday]);
    const minPnl = Math.min(...allPnls);
    const maxPnl = Math.max(...allPnls);
    const tickMin = Math.floor(minPnl / 10000) * 10000;
    const tickMax = Math.ceil(maxPnl / 10000) * 10000;
    return [tickMin, tickMax];
  }, [payoffChartData]);

  const yTicks = useMemo(() => {
    const [lo, hi] = yDomain as [number, number];
    const result: number[] = [];
    for (let t = lo; t <= hi; t += 10000) result.push(t);
    return result;
  }, [yDomain]);

  const xTicks = useMemo(() => {
    const pts = chartZoom === "narrow" ? 500 : chartZoom === "wide" ? 2000 : 1000;
    const lo = spot - pts; const hi = spot + pts;
    const start = Math.ceil(lo / 200) * 200;
    const result: number[] = [];
    for (let t = start; t <= hi; t += 200) result.push(t);
    return result;
  }, [spot, chartZoom]);

  // ── Early return: no data ────────────────────────────────────────────────
  if (!optionsData || !symbols.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <div className="rounded-full bg-muted/30 p-5"><Database className="h-10 w-10 text-muted-foreground/50" /></div>
        <div className="text-center max-w-sm">
          <p className="text-base font-semibold text-foreground mb-1">No options data loaded</p>
          <p className="text-xs text-muted-foreground">
            Upload an NSE FO bhavcopy CSV (OPTIDX/OPTSTK rows) from the Create Scan page to use the simulator.
          </p>
        </div>
      </div>
    );
  }

  const stratCategories = [
    { key: "bullish" as const, label: "Bullish", icon: TrendingUp, active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/50", inactive: "bg-muted/20 text-muted-foreground border-border/40" },
    { key: "bearish" as const, label: "Bearish", icon: TrendingDown, active: "bg-red-500/20 text-red-400 border-red-500/50", inactive: "bg-muted/20 text-muted-foreground border-border/40" },
    { key: "neutral" as const, label: "Neutral", icon: BarChart2, active: "bg-blue-500/20 text-blue-400 border-blue-500/50", inactive: "bg-muted/20 text-muted-foreground border-border/40" },
    { key: "other"   as const, label: "Other",   icon: Zap,        active: "bg-violet-500/20 text-violet-400 border-violet-500/50", inactive: "bg-muted/20 text-muted-foreground border-border/40" },
  ];

  const filteredStrats = STRATEGIES.filter((s) => s.category === stratFilter);

  const simDateLabel = effectiveDate
    ? new Date(effectiveDate + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })
    : "—";

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-100px)] overflow-hidden bg-background">

      {/* ── Time navigation bar ──────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-0 border-b border-border bg-[#0d1117] px-2 py-0.5 shrink-0 flex-wrap">
        {TIME_STEPS.slice(0, 6).map((step) => (
          <button
            key={step.label}
            type="button"
            onClick={() => handleTimeStep(step)}
            className="px-3 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded transition-colors border-r border-border/30 last:border-r-0"
          >
            {step.label}
          </button>
        ))}

        {/* Date + time display — click to open picker */}
        <div className="relative mx-2">
          <button
            type="button"
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-2 px-3 py-0.5 bg-muted/20 border border-border/60 rounded text-xs font-semibold text-foreground min-w-[220px] justify-center hover:bg-muted/30 hover:border-border transition-colors"
          >
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span>{simDateLabel}</span>
            <span className="text-primary font-bold">{simTime}</span>
            <ChevronDown className={`h-3 w-3 text-muted-foreground/60 transition-transform ${pickerOpen ? "rotate-180" : ""}`} />
          </button>

          {pickerOpen && (
            <DateTimePicker
              value={effectiveDate}
              time={simTime}
              expiries={expiries}
              maxDate={availableDates[availableDates.length - 1] ?? undefined}
              holidaySet={holidaySet}
              onConfirm={(date, time) => {
                setSimDate(date);
                setSimTime(time);
                setSelectedExpiry("");
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>

        {TIME_STEPS.slice(6).map((step) => (
          <button
            key={step.label}
            type="button"
            onClick={() => handleTimeStep(step)}
            className="px-3 py-0.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded transition-colors border-l border-border/30 first:border-l-0"
          >
            {step.label}
          </button>
        ))}
      </div>

      {/* ── Spot / FUT bar ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 px-4 py-0.5 border-b border-border bg-[#0d1117] shrink-0 text-xs">
        <span className="text-muted-foreground font-medium">SPOT:</span>
        <span className={`font-bold tabular-nums ${spotPrice > 0 ? "text-emerald-400" : "text-muted-foreground/50"}`}>
          {spotPrice > 0 ? spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "—"}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="text-muted-foreground font-medium">FUT:</span>
        <span className="font-bold text-foreground tabular-nums">
          {spot > 0 ? spot.toLocaleString("en-IN", { maximumFractionDigits: 1 }) : "—"}
        </span>
        {spot > 0 && atmK > 0 && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground font-medium">ATM:</span>
            <span className="font-bold text-cyan-400 tabular-nums">{atmK.toLocaleString("en-IN")}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground font-medium">DTE:</span>
            <span className="font-semibold text-amber-400 tabular-nums">{dte}d</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground font-medium">Lot Size:</span>
            <span className="font-semibold text-foreground tabular-nums">{lotSize}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/70">Qty multiplier:</span>
          <button type="button" onClick={() => setMultiplier((m) => Math.max(1, m - 1))}
            className="p-0.5 hover:text-foreground text-muted-foreground"><Minus className="h-3 w-3" /></button>
          <span className="text-xs font-bold text-foreground w-5 text-center">{multiplier}</span>
          <button type="button" onClick={() => setMultiplier((m) => m + 1)}
            className="p-0.5 hover:text-foreground text-muted-foreground"><Plus className="h-3 w-3" /></button>
        </div>
      </div>

      {/* ── Main split ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left: Options chain ─────────────────────────────────────── */}
        <div className="w-[560px] shrink-0 flex flex-col border-r border-border bg-[#0d1117]">

          {/* Symbol selector */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 bg-muted/10">
            <select
              value={activeSymbol}
              onChange={(e) => { setSelectedSymbol(e.target.value); setSelectedExpiry(""); }}
              className="text-xs font-bold bg-transparent border border-border/60 rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[110px]"
            >
              {/* Indices group */}
              <optgroup label="── Indices ──">
                {symbols.filter((s) => INDEX_ORDER.includes(s)).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </optgroup>
              {symbols.some((s) => !INDEX_ORDER.includes(s)) && (
                <optgroup label="── Stocks ──">
                  {symbols.filter((s) => !INDEX_ORDER.includes(s)).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </optgroup>
              )}
            </select>

            <button
              type="button"
              onClick={clearLegs}
              disabled={!legs.length}
              title="Reset all positions"
              className={`ml-auto flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition-colors shrink-0 ${
                legs.length
                  ? "text-amber-400/80 hover:text-amber-400 bg-amber-400/10 hover:bg-amber-400/20 border-amber-400/20 hover:border-amber-400/40 cursor-pointer"
                  : "text-muted-foreground/40 bg-muted/10 border-border/30 cursor-not-allowed"
              }`}
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Reset
            </button>
          </div>

          {/* Expiry tabs with left/right arrows */}
          <div className="flex items-stretch border-b border-border/50 bg-muted/10 shrink-0">
            {/* Left arrow */}
            <button
              type="button"
              onClick={() => stepExpiry("left")}
              disabled={visibleExpiries.indexOf(activeExpiry) <= 0}
              className="px-1.5 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-25 disabled:cursor-not-allowed border-r border-border/40 transition-colors"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>

            {/* Scrollable expiry strip — only future/current expiries */}
            <div
              ref={expiryScrollRef}
              className="flex gap-1 px-2 py-0.5 overflow-x-auto flex-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden scroll-smooth"
            >
              {visibleExpiries.map((exp) => {
                const d = new Date(exp + "T00:00:00");
                const daysLeft = daysToExpiry(effectiveDate, exp);
                const label = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
                const isActive = exp === activeExpiry;
                return (
                  <button
                    key={exp}
                    data-expiry={exp}
                    type="button"
                    onClick={() => setSelectedExpiry(exp)}
                    className={`shrink-0 flex flex-col items-center px-2.5 py-0.5 rounded text-center transition-all ${
                      isActive
                        ? "bg-primary text-primary-foreground shadow-md scale-105"
                        : "bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    }`}
                  >
                    <span className="text-[9px] font-bold leading-tight whitespace-nowrap">{label}</span>
                    <span className={`text-[7px] leading-tight ${isActive ? "text-primary-foreground/80" : "text-foreground/50"}`}>
                      {daysLeft}d
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Right arrow */}
            <button
              type="button"
              onClick={() => stepExpiry("right")}
              disabled={visibleExpiries.indexOf(activeExpiry) >= visibleExpiries.length - 1}
              className="px-1.5 shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/30 disabled:opacity-25 disabled:cursor-not-allowed border-l border-border/40 transition-colors"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Chain header */}
          <div className="grid grid-cols-[52fr_60fr_80fr_68fr_80fr_60fr_52fr] text-[9px] uppercase tracking-wide text-foreground/60 border-b border-border/50 bg-muted/20 shrink-0 px-1 font-semibold">
            <div className="py-1 text-right pr-1">Call Δ</div>
            <div className="py-1 text-right pr-1">LTP</div>
            <div className="py-1 text-right pr-1">OI (CE)</div>
            <div className="py-1 text-center text-foreground/80">Strike</div>
            <div className="py-1 text-left pl-1">OI (PE)</div>
            <div className="py-1 text-left pl-1">LTP</div>
            <div className="py-1 text-left pl-1">Put Δ</div>
          </div>

          {/* Chain rows */}
          <div ref={chainScrollRef} className="flex-1 overflow-y-auto">
            {chain.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-xs text-muted-foreground/50">
                No chain data for selected date/expiry
              </div>
            ) : chain.map((row) => {
              const isATM = row.strike === atmK;
              const ceDelta = approxDelta(spot, row.strike, "CE", dte);
              const peDelta = approxDelta(spot, row.strike, "PE", dte);
              const isCeITM = !isATM && spot > 0 && row.strike < spot;  // CE ITM: strike below spot
              const isPeITM = !isATM && spot > 0 && row.strike > spot;  // PE ITM: strike above spot
              // Per-section cell backgrounds
              const ceCellBg = isATM ? "bg-cyan-500/[0.18]" : isCeITM ? "bg-green-500/10" : "";
              const peCellBg = isATM ? "bg-cyan-500/[0.18]" : isPeITM ? "bg-orange-500/10" : "";
              const strikeBg = isATM ? "bg-cyan-500/[0.28]" : "bg-white/10";
              return (
                <div
                  key={row.strike}
                  data-atm={isATM ? "true" : undefined}
                  onMouseEnter={() => setHoveredStrike(row.strike)}
                  onMouseLeave={() => setHoveredStrike(null)}
                  className={`grid grid-cols-[52fr_60fr_80fr_68fr_80fr_60fr_52fr] border-b px-1 ${
                    isATM ? "border-cyan-400/40" : "border-border/10"
                  }`}
                >
                  {/* Call Delta */}
                  <div className={`py-1.5 text-right pr-1 text-[10px] tabular-nums font-medium ${ceCellBg} ${
                    ceDelta > 0.5 ? "text-emerald-400" : ceDelta < 0.2 ? "text-foreground/40" : "text-foreground/70"
                  }`}>
                    {row.ce > 0 ? ceDelta.toFixed(2) : "—"}
                  </div>

                  {/* CE LTP */}
                  <div className={`py-1 text-right pr-1 flex flex-col justify-center items-end gap-0.5 ${ceCellBg}`}>
                    <span className={`text-[10px] font-bold tabular-nums leading-none ${
                      row.ce > 0 ? "text-foreground" : "text-foreground/30"
                    }`}>
                      {row.ce > 0 ? row.ce.toFixed(1) : "—"}
                    </span>
                  </div>

                  {/* CE OI bar — B/S buttons overlay on hover or when a position is active */}
                  {(() => {
                    const ceActions = legIndex.get(`${row.strike}|CE`) ?? [];
                    const hasBuy = ceActions.includes("BUY");
                    const hasSell = ceActions.includes("SELL");
                    const showButtons = (hoveredStrike === row.strike || ceActions.length > 0) && row.ce > 0;
                    return (
                      <div className={`py-1.5 relative flex flex-col items-end justify-center gap-0.5 pr-1 ${ceCellBg}`}>
                        <OIHBar value={row.ceOI} max={maxOI} color="bg-green-500/70" align="right" />
                        <span className="text-[8px] text-foreground/45 tabular-nums">{fmtOI(row.ceOI)}</span>
                        {showButtons && (
                          <div className="absolute inset-0 flex items-center justify-start pl-1 gap-1.5">
                            <button type="button" onClick={() => addLeg(row.strike, "CE", "BUY", row.ce)}
                              className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${
                                hasBuy
                                  ? "bg-blue-500 text-white ring-1 ring-blue-300"
                                  : hasSell
                                    ? "bg-blue-900/40 text-blue-400/40 hover:bg-blue-600/60 hover:text-blue-200"
                                    : "bg-blue-600/60 text-blue-200 hover:bg-blue-500"
                              }`}>
                              B
                            </button>
                            <button type="button" onClick={() => addLeg(row.strike, "CE", "SELL", row.ce)}
                              className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${
                                hasSell
                                  ? "bg-red-500 text-white ring-1 ring-red-300"
                                  : hasBuy
                                    ? "bg-red-900/40 text-red-400/40 hover:bg-red-600/60 hover:text-red-200"
                                    : "bg-red-600/60 text-red-200 hover:bg-red-500"
                              }`}>
                              S
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Strike */}
                  <div className={`py-1.5 flex items-center justify-center text-[11px] font-bold tabular-nums ${strikeBg} ${
                    isATM ? "text-cyan-300" : "text-foreground/80"
                  }`}>
                    {isATM && <span className="text-[8px] text-cyan-400 mr-0.5 font-black">★</span>}
                    {row.strike.toLocaleString("en-IN")}
                  </div>

                  {/* PE OI bar — B/S buttons overlay on hover or when a position is active */}
                  {(() => {
                    const peActions = legIndex.get(`${row.strike}|PE`) ?? [];
                    const hasBuy = peActions.includes("BUY");
                    const hasSell = peActions.includes("SELL");
                    const showButtons = (hoveredStrike === row.strike || peActions.length > 0) && row.pe > 0;
                    return (
                      <div className={`py-1.5 relative flex flex-col items-start justify-center gap-0.5 pl-1 ${peCellBg}`}>
                        <OIHBar value={row.peOI} max={maxOI} color="bg-red-500/70" align="left" />
                        <span className="text-[8px] text-foreground/45 tabular-nums">{fmtOI(row.peOI)}</span>
                        {showButtons && (
                          <div className="absolute inset-0 flex items-center justify-end pr-1 gap-1.5">
                            <button type="button" onClick={() => addLeg(row.strike, "PE", "BUY", row.pe)}
                              className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${
                                hasBuy
                                  ? "bg-blue-500 text-white ring-1 ring-blue-300"
                                  : hasSell
                                    ? "bg-blue-900/40 text-blue-400/40 hover:bg-blue-600/60 hover:text-blue-200"
                                    : "bg-blue-600/60 text-blue-200 hover:bg-blue-500"
                              }`}>
                              B
                            </button>
                            <button type="button" onClick={() => addLeg(row.strike, "PE", "SELL", row.pe)}
                              className={`text-[9px] font-bold px-2 py-0.5 rounded transition-colors shadow-md leading-tight ${
                                hasSell
                                  ? "bg-red-500 text-white ring-1 ring-red-300"
                                  : hasBuy
                                    ? "bg-red-900/40 text-red-400/40 hover:bg-red-600/60 hover:text-red-200"
                                    : "bg-red-600/60 text-red-200 hover:bg-red-500"
                              }`}>
                              S
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* PE LTP */}
                  <div className={`py-1 text-left pl-1 flex flex-col justify-center items-start gap-0.5 ${peCellBg}`}>
                    <span className={`text-[10px] font-bold tabular-nums leading-none ${
                      row.pe > 0 ? "text-foreground" : "text-foreground/30"
                    }`}>
                      {row.pe > 0 ? row.pe.toFixed(1) : "—"}
                    </span>
                  </div>

                  {/* Put Delta */}
                  <div className={`py-1.5 text-left pl-1 text-[10px] tabular-nums font-medium ${peCellBg} ${
                    Math.abs(peDelta) > 0.5 ? "text-red-400" : Math.abs(peDelta) < 0.2 ? "text-foreground/40" : "text-foreground/70"
                  }`}>
                    {row.pe > 0 ? peDelta.toFixed(2) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: Payoff / Strategies ───────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden bg-background">

          {/* Tab bar */}
          <div className="flex items-center border-b border-border bg-[#0d1117] px-4 shrink-0">
            {[
              { key: "payoff" as const, label: "Payoff", icon: BarChart2 },
              { key: "strategies" as const, label: "Strategies", icon: Layers },
              { key: "history" as const, label: "History", icon: History },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setRightView(key)}
                className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                  rightView === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />{label}
                {key === "history" && simHistory.length > 0 && (
                  <span className="ml-0.5 text-[9px] px-1.5 rounded-full bg-primary/20 text-primary font-bold">{simHistory.length}</span>
                )}
              </button>
            ))}
          </div>

          {/* ── Payoff ── */}
          {rightView === "payoff" && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {!legs.length ? (
                <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
                  <Layers className="h-10 w-10 opacity-30" />
                  <p className="text-sm font-medium">No positions yet</p>
                  <p className="text-xs opacity-60">Click CE/PE prices to add legs, or pick a strategy</p>
                  <button type="button" onClick={() => setRightView("strategies")} className="mt-1 text-xs text-primary hover:underline">
                    Browse strategies →
                  </button>
                </div>
              ) : (
                <>
                  {/* ── Chart row: left stats panel + chart ── */}
                  <div className="h-[260px] shrink-0 flex overflow-hidden">

                    {/* Left stats panel */}
                    {stats && (
                      <div className="w-36 shrink-0 border-r border-border/50 bg-[#080d11] p-2 flex flex-col gap-1.5 overflow-y-auto">
                        {/* P&L at Spot */}
                        <div className={`rounded p-2 ${stats.currentPnl >= 0 ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
                          <div className="text-[8px] text-muted-foreground uppercase tracking-wide mb-0.5">P&amp;L</div>
                          <div className={`text-sm font-bold tabular-nums ${stats.currentPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {stats.currentPnl >= 0 ? "+" : ""}₹{Math.abs(stats.currentPnl).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                          </div>
                          <div className={`text-[9px] font-semibold ${stats.currentPnl >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}>
                            ({stats.margin > 0 ? ((stats.currentPnl / stats.margin) * 100).toFixed(2) : "0.00"}%)
                          </div>
                        </div>
                        {[
                          { label: "Est. Margin", value: `₹${stats.margin.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-foreground" },
                          { label: "POP", value: `${stats.pop}%`, color: stats.pop >= 50 ? "text-emerald-400" : "text-red-400" },
                          { label: "Max Profit", value: stats.maxProfitUnlimited ? "Unlimited" : `₹${stats.maxProfit.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-emerald-400" },
                          { label: "Max Loss", value: stats.maxLossUnlimited ? "Unlimited" : `-₹${Math.abs(stats.maxLoss).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, color: "text-red-400" },
                        ].map(({ label, value, color }) => (
                          <div key={label}>
                            <div className="text-[8px] text-muted-foreground/60 uppercase tracking-wide">{label}</div>
                            <div className={`text-xs font-bold tabular-nums ${color}`}>{value}</div>
                          </div>
                        ))}
                        <div>
                          <div className="text-[8px] text-muted-foreground/60 uppercase tracking-wide mb-0.5">Breakevens</div>
                          {stats.bvs.length ? stats.bvs.map((b) => (
                            <div key={b} className="text-[10px] font-bold tabular-nums text-amber-400">
                              {b.toLocaleString("en-IN")}
                              <span className="text-[8px] text-amber-400/60 ml-1">({spot > 0 ? (((b - spot) / spot) * 100).toFixed(2) : "—"}%)</span>
                            </div>
                          )) : <div className="text-xs text-muted-foreground/40">—</div>}
                        </div>
                      </div>
                    )}

                    {/* Payoff + OI chart */}
                    <div className="flex-1 min-w-0 bg-[#0d1117] flex flex-col py-1.5 pr-1 pl-0">
                      {/* Zoom control + legend */}
                      <div className="flex items-center justify-between pr-1 mb-1 shrink-0">
                        <div className="flex items-center gap-3 pl-2">
                          <div className="flex items-center gap-1">
                            <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="#4ade80" strokeWidth="2"/></svg>
                            <span className="text-[9px] text-muted-foreground/70">At expiry</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="#60a5fa" strokeWidth="1.5" strokeDasharray="5 3"/></svg>
                            <span className="text-[9px] text-muted-foreground/70">Today (MtM)</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 bg-[#161b22] border border-border/40 rounded p-0.5">
                          {(["narrow","normal","wide"] as const).map((z, i) => (
                            <button
                              key={z}
                              type="button"
                              onClick={() => setChartZoom(z)}
                              className={`px-2 py-0.5 text-[9px] font-semibold rounded transition-colors ${
                                chartZoom === z
                                  ? "bg-primary/20 text-primary"
                                  : "text-muted-foreground/50 hover:text-muted-foreground"
                              }`}
                            >
                              {["±500","±1k","±2k"][i]}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex-1 min-h-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={payoffChartData} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
                          <defs>
                            <linearGradient id="gPos2" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#4ade80" stopOpacity={0.25} />
                              <stop offset="95%" stopColor="#4ade80" stopOpacity={0.02} />
                            </linearGradient>
                            <linearGradient id="gNeg2" x1="0" y1="1" x2="0" y2="0">
                              <stop offset="5%" stopColor="#f87171" stopOpacity={0.25} />
                              <stop offset="95%" stopColor="#f87171" stopOpacity={0.02} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1a2233" vertical={false} />
                          <XAxis dataKey="spot" type="number" domain={["dataMin", "dataMax"]}
                            tick={{ fontSize: 8, fill: "#6b7280" }}
                            ticks={xTicks}
                            tickFormatter={(v) => `${(Number(v) / 1000).toFixed(1)}k`}
                            axisLine={false} tickLine={false} />
                          <YAxis yAxisId="pnl" tick={{ fontSize: 8, fill: "#6b7280" }} width={46}
                            ticks={yTicks}
                            tickFormatter={(v) => Number(v) === 0 ? "0" : `${Number(v) > 0 ? "+" : ""}${Number(v) / 1000}k`}
                            domain={yDomain} axisLine={false} tickLine={false} />
                          <Tooltip content={<PayoffTooltip />} />

                          {/* OI background bars — normalized to pnl axis (≤20% of visible range) */}
                          <Bar yAxisId="pnl" dataKey="ceOINorm" fill="rgba(74,222,128,0.25)" radius={[1,1,0,0]} maxBarSize={4} isAnimationActive={false} />
                          <Bar yAxisId="pnl" dataKey="peOINorm" fill="rgba(248,113,113,0.25)" radius={[1,1,0,0]} maxBarSize={4} isAnimationActive={false} />

                          {/* Zero line */}
                          <ReferenceLine yAxisId="pnl" y={0} stroke="#ffffff" strokeWidth={0.5} />

                          {/* Spot line */}
                          {spot > 0 && (
                            <ReferenceLine yAxisId="pnl" x={Math.round(spot)} stroke="#60a5fa" strokeWidth={1.5}
                              label={{ value: `Spot: ${spot.toLocaleString("en-IN", { maximumFractionDigits: 1 })}`, position: "insideTopLeft", fontSize: 9, fill: "#60a5fa", fontWeight: 600 }} />
                          )}

                          {/* ±1SD / ±2SD markers */}
                          {sdMove > 0 && [
                            { x: Math.round(spot - 2 * sdMove), label: "-2SD" },
                            { x: Math.round(spot - sdMove),     label: "-1SD" },
                            { x: Math.round(spot + sdMove),     label: "+1SD" },
                            { x: Math.round(spot + 2 * sdMove), label: "+2SD" },
                          ].map(({ x, label }) => (
                            <ReferenceLine key={label} yAxisId="pnl" x={x} stroke="#4b5563" strokeWidth={1} strokeDasharray="4 3"
                              label={{ value: label, position: "insideTopRight", fontSize: 8, fill: "#6b7280" }} />
                          ))}

                          {/* Breakeven lines */}
                          {(stats?.bvs ?? []).map((bv) => (
                            <ReferenceLine key={bv} yAxisId="pnl" x={bv} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" />
                          ))}

                          {/* P&L areas — expiry */}
                          <Area yAxisId="pnl" type="monotone" dataKey="pnlPos" stroke="#4ade80" strokeWidth={2}
                            fill="url(#gPos2)" dot={false} activeDot={false} isAnimationActive={false} />
                          <Area yAxisId="pnl" type="monotone" dataKey="pnlNeg" stroke="#f87171" strokeWidth={2}
                            fill="url(#gNeg2)" dot={false} activeDot={false} isAnimationActive={false} />

                          {/* Today's mark-to-market curve — dashed blue */}
                          <Line yAxisId="pnl" type="monotone" dataKey="pnlToday" stroke="#60a5fa" strokeWidth={1.5}
                            strokeDasharray="6 3" dot={false} activeDot={false} isAnimationActive={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  </div>

                  {/* ── Positions table (bottom, full width) ── */}
                  <div className="border-t border-border/50 bg-[#080d11] shrink-0">
                    {/* Tab row */}
                    <div className="flex items-center border-b border-border/40 px-3">
                      <span className="py-1 px-3 text-[10px] font-bold text-primary border-b-2 border-primary -mb-px">Positions</span>
                      <span className="py-1 px-3 text-[10px] font-semibold text-muted-foreground/50">Greeks</span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs min-w-[620px]">
                        <thead>
                          <tr className="text-[8px] uppercase tracking-wide text-muted-foreground/60 border-b border-border/40">
                            <th className="px-2 py-1 text-center w-10">Lots</th>
                            <th className="px-2 py-1 text-center w-16">Date</th>
                            <th className="px-2 py-1 text-center">Expiry</th>
                            <th className="px-2 py-1 text-center">Strike</th>
                            <th className="px-2 py-1 text-center w-10">Type</th>
                            <th className="px-2 py-1 text-center tracking-normal">Entry</th>
                            <th className="px-2 py-1 text-center tracking-normal">Invested</th>
                            <th className="px-2 py-1 text-center tracking-normal">LTP</th>
                            <th className="px-2 py-1 text-center tracking-normal">P&amp;L</th>
                            <th className="px-2 py-1 text-center text-sky-400/70 w-12">Time</th>
                            <th className="px-1 py-1 text-center w-12">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-red-400/70 uppercase tracking-wide">SL</span>
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
                            </th>
                            <th className="px-1 py-1 text-center w-12">
                              <div className="flex flex-col items-center gap-0.5">
                                <span className="text-emerald-400/70 uppercase tracking-wide">Target</span>
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
                            </th>
                            <th className="px-2 py-1 text-center w-16"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {legs.map((leg) => {
                            const active = isLegActive(leg.addedDate ?? "", leg.addedTime ?? "00:00", effectiveDate, simTime);
                            const ltp = active ? getLegLTP(leg) : 0;
                            // MtM P&L: (current LTP - entry) × lots × lotSize — inactive legs show nothing
                            const pnlAtSpot = active && ltp > 0
                              ? +((leg.action === "BUY" ? ltp - leg.entryPrice : leg.entryPrice - ltp) * leg.lots * lotSize).toFixed(0)
                              : 0;
                            return (
                              <tr key={leg.id} className={`border-t border-border/20 hover:bg-muted/10 transition-colors ${!active ? "opacity-50" : ""}`}>
                                {/* Lots */}
                                <td className="px-2 py-1 text-center">
                                  <div className="flex items-center justify-center gap-0.5">
                                    <button type="button" onClick={() => updateLots(leg.id, -1)}
                                      className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
                                      <Minus className="h-2 w-2" />
                                    </button>
                                    <span className="tabular-nums font-bold w-5 text-center text-foreground text-[11px]">{leg.lots}</span>
                                    <button type="button" onClick={() => updateLots(leg.id, 1)}
                                      className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
                                      <Plus className="h-2 w-2" />
                                    </button>
                                  </div>
                                </td>
                                {/* Date added */}
                                <td className="px-2 py-1 text-center text-[10px] text-muted-foreground whitespace-nowrap">
                                  {leg.addedDate ? new Date(leg.addedDate + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
                                </td>
                                {/* Expiry — dropdown to change anytime */}
                                <td className="px-2 py-1 text-center whitespace-nowrap">
                                  <select
                                    value={leg.expiry}
                                    onChange={(e) => updateExpiry(leg.id, e.target.value)}
                                    className="text-[10px] tabular-nums text-primary font-semibold bg-transparent border border-border/30 rounded px-1 py-0.5 cursor-pointer hover:border-primary/50 focus:outline-none focus:border-primary/70 transition-colors"
                                  >
                                    {expiries.filter((exp) => !leg.addedDate || exp >= leg.addedDate).map((exp) => (
                                      <option key={exp} value={exp}>
                                        {new Date(exp + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                                      </option>
                                    ))}
                                    {/* keep current expiry selectable even if it somehow isn't in the filtered list */}
                                    {leg.expiry && !expiries.filter((exp) => !leg.addedDate || exp >= leg.addedDate).includes(leg.expiry) && (
                                      <option value={leg.expiry}>
                                        {new Date(leg.expiry + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                                      </option>
                                    )}
                                  </select>
                                </td>
                                {/* Strike with +/- */}
                                <td className="px-2 py-1 text-center">
                                  <div className="flex items-center justify-center gap-0.5">
                                    <button type="button" onClick={() => updateStrike(leg.id, -1)}
                                      className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
                                      <Minus className="h-2 w-2" />
                                    </button>
                                    <span className="tabular-nums font-bold text-foreground text-[11px] w-14 text-center">
                                      {leg.strike.toLocaleString("en-IN")}
                                    </span>
                                    <button type="button" onClick={() => updateStrike(leg.id, 1)}
                                      className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors">
                                      <Plus className="h-2 w-2" />
                                    </button>
                                  </div>
                                </td>
                                {/* Type + Action badge — clickable toggles */}
                                <td className="px-2 py-1 text-center">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      type="button"
                                      title="Toggle Buy / Sell"
                                      onClick={() => updateAction(leg.id)}
                                      className={`text-[8px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors hover:opacity-80 active:scale-95 ${leg.action === "BUY" ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/35" : "bg-red-500/20 text-red-400 hover:bg-red-500/35"}`}
                                    >
                                      {leg.action[0]}
                                    </button>
                                    <button
                                      type="button"
                                      title="Toggle CE / PE"
                                      onClick={() => updateType(leg.id)}
                                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors hover:opacity-80 active:scale-95 ${leg.type === "CE" ? "bg-sky-500/20 text-sky-400 hover:bg-sky-500/35" : "bg-violet-500/20 text-violet-400 hover:bg-violet-500/35"}`}
                                    >
                                      {leg.type}
                                    </button>
                                  </div>
                                </td>
                                {/* Entry */}
                                <td className="px-2 py-1 text-center tabular-nums text-muted-foreground text-[11px]">
                                  {leg.entryPrice.toFixed(2)}
                                </td>
                                {/* Invested */}
                                <td className="px-2 py-1 text-center tabular-nums text-[11px] font-semibold text-amber-400/90">
                                  ₹{Math.round(leg.lots * lotSize * leg.entryPrice).toLocaleString("en-IN")}
                                </td>
                                {/* LTP */}
                                <td className="px-2 py-1 text-center tabular-nums text-foreground text-[11px] font-medium">
                                  {active && ltp > 0 ? ltp.toFixed(2) : "—"}
                                </td>
                                {/* P&L */}
                                <td className="px-2 py-1 text-center tabular-nums font-bold text-[11px] whitespace-nowrap">
                                  {active ? (
                                    <span className={pnlAtSpot >= 0 ? "text-emerald-400" : "text-red-400"}>
                                      {pnlAtSpot >= 0 ? "+" : ""}₹{Math.abs(pnlAtSpot).toLocaleString("en-IN")}
                                    </span>
                                  ) : (
                                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/80 border border-amber-500/20">
                                      Pending
                                    </span>
                                  )}
                                </td>
                                {/* Time held / pending */}
                                <td className="px-2 py-1 text-center">
                                  {active ? (
                                    <span
                                      className="text-[10px] tabular-nums font-semibold text-sky-400/80"
                                      title={`Entered: ${leg.addedDate} ${leg.addedTime} → Now: ${effectiveDate} ${simTime}`}
                                    >
                                      {leg.addedDate ? tradeDuration(leg.addedDate, leg.addedTime, effectiveDate, simTime) : "—"}
                                    </span>
                                  ) : (
                                    <span
                                      className="text-[9px] tabular-nums text-muted-foreground/50"
                                      title={`Entry at: ${leg.addedDate} ${leg.addedTime}`}
                                    >
                                      {leg.addedTime ?? "—"}
                                    </span>
                                  )}
                                </td>
                                {/* SL */}
                                <td className="px-1 py-1 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.5}
                                    placeholder="—"
                                    value={leg.sl ?? ""}
                                    onFocus={() => { editingSlTgt.current = true; }}
                                    onBlur={() => { editingSlTgt.current = false; }}
                                    onChange={(e) => {
                                      const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                                      updateLegSL(leg.id, v);
                                    }}
                                    className="w-9 text-center text-[10px] tabular-nums bg-red-500/10 border border-red-500/25 rounded px-1 py-0.5 text-red-300 placeholder:text-red-500/30 focus:outline-none focus:border-red-400/60 focus:bg-red-500/15 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  />
                                </td>
                                {/* Target */}
                                <td className="px-1 py-1 text-center">
                                  <input
                                    type="number"
                                    min={0}
                                    step={0.5}
                                    placeholder="—"
                                    value={leg.tgt ?? ""}
                                    onFocus={() => { editingSlTgt.current = true; }}
                                    onBlur={() => { editingSlTgt.current = false; }}
                                    onChange={(e) => {
                                      const v = e.target.value === "" ? undefined : parseFloat(e.target.value);
                                      updateLegTgt(leg.id, v);
                                    }}
                                    className="w-9 text-center text-[10px] tabular-nums bg-emerald-500/10 border border-emerald-500/25 rounded px-1 py-0.5 text-emerald-300 placeholder:text-emerald-500/30 focus:outline-none focus:border-emerald-400/60 focus:bg-emerald-500/15 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  />
                                </td>
                                {/* Actions */}
                                <td className="px-1.5 py-1 text-center">
                                  {legAction?.id === leg.id && legAction.type === "squareoff" ? (
                                    /* ── Square-off lot picker ── */
                                    <div className="flex items-center justify-center gap-0.5">
                                      <button type="button"
                                        onClick={() => setLegAction((a) => a && { ...a, lots: Math.max(1, a.lots - 1) })}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/35 transition-colors">
                                        <Minus className="h-2 w-2" />
                                      </button>
                                      <span className="tabular-nums font-bold text-amber-400 text-[11px] w-5 text-center">{legAction.lots}</span>
                                      <button type="button"
                                        onClick={() => setLegAction((a) => a && { ...a, lots: Math.min(leg.lots, a.lots + 1) })}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/35 transition-colors">
                                        <Plus className="h-2 w-2" />
                                      </button>
                                      <button type="button" title="Confirm square off"
                                        onClick={() => void squareOffLeg(leg.id, legAction.lots, lotSize)}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/35 transition-colors ml-0.5">
                                        <Check className="h-2.5 w-2.5" />
                                      </button>
                                      <button type="button" title="Cancel"
                                        onClick={() => setLegAction(null)}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
                                        <X className="h-2.5 w-2.5" />
                                      </button>
                                    </div>
                                  ) : legAction?.id === leg.id && legAction.type === "delete" ? (
                                    /* ── Delete confirm ── */
                                    <div className="flex items-center justify-center gap-1">
                                      <span className="text-[9px] text-red-400 font-semibold">Delete?</span>
                                      <button type="button" title="Yes, delete"
                                        onClick={() => removeLeg(leg.id)}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-red-500/20 text-red-400 hover:bg-red-500/35 transition-colors">
                                        <Check className="h-2.5 w-2.5" />
                                      </button>
                                      <button type="button" title="Cancel"
                                        onClick={() => setLegAction(null)}
                                        className="w-4 h-4 flex items-center justify-center rounded bg-muted/30 text-muted-foreground hover:text-foreground transition-colors">
                                        <X className="h-2.5 w-2.5" />
                                      </button>
                                    </div>
                                  ) : (
                                    /* ── Default: Square-off + Delete buttons ── */
                                    <div className="flex items-center justify-center gap-1">
                                      <button type="button" title="Square off position"
                                        onClick={() => setLegAction({ type: "squareoff", id: leg.id, lots: leg.lots })}
                                        className="w-6 h-6 flex items-center justify-center rounded bg-amber-500/15 text-amber-400 hover:bg-amber-500/30 transition-colors">
                                        <LogOut className="h-3 w-3" />
                                      </button>
                                      <button type="button" title="Delete leg"
                                        onClick={() => setLegAction({ type: "delete", id: leg.id, lots: leg.lots })}
                                        className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Footer: multiplier + qty + total P&L */}
                    <div className="flex items-center gap-4 px-3 py-2 border-t border-border/30 bg-[#060a0e]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-muted-foreground/60 font-semibold uppercase tracking-wide">Multiplier:</span>
                        <button type="button" onClick={() => setMultiplier((m) => Math.max(1, m - 1))}
                          className="w-5 h-5 flex items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/20 transition-colors">
                          <Minus className="h-2.5 w-2.5" />
                        </button>
                        <span className="text-xs font-bold text-foreground w-5 text-center">{multiplier}</span>
                        <button type="button" onClick={() => setMultiplier((m) => m + 1)}
                          className="w-5 h-5 flex items-center justify-center rounded border border-border/60 text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/20 transition-colors">
                          <Plus className="h-2.5 w-2.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-muted-foreground/60 font-semibold uppercase tracking-wide">Qty:</span>
                        <span className="text-xs font-bold text-foreground tabular-nums">{multiplier * lotSize}</span>
                      </div>
                      <div className="ml-auto flex items-center gap-1.5">
                        <span className="text-[9px] text-muted-foreground/60 font-semibold uppercase tracking-wide">Total P&amp;L:</span>
                        <span className={`text-xs font-bold tabular-nums ${(stats?.currentPnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {(stats?.currentPnl ?? 0) >= 0 ? "+" : ""}₹{Math.abs(stats?.currentPnl ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                          <span className="ml-1 text-[9px] opacity-60">
                            ({stats && stats.margin > 0 ? ((stats.currentPnl / stats.margin) * 100).toFixed(2) : "0.00"}%)
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Strategies view ── */}
          {rightView === "strategies" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <h2 className="text-sm font-bold text-foreground mb-0.5">Ready-Made Strategies</h2>
                <p className="text-[10px] text-muted-foreground">
                  Click a card to auto-fill legs from the current ATM strike. Green = profit zone · Red = loss zone.
                </p>
              </div>

              {/* Category filter */}
              <div className="flex gap-2">
                {stratCategories.map(({ key, label, icon: Icon, active, inactive }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStratFilter(key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${stratFilter === key ? active : inactive}`}
                  >
                    <Icon className="h-3 w-3" />{label}
                  </button>
                ))}
              </div>

              {/* Strategy grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {filteredStrats.map((strat) => (
                  <StrategyCard key={strat.name} strategy={strat} onSelect={() => applyStrategy(strat)} />
                ))}
              </div>

              {!chain.length && (
                <p className="text-[10px] text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded px-3 py-2">
                  ⚠ Select a symbol and expiry with loaded data to apply strategies from the chain.
                </p>
              )}
            </div>
          )}

          {/* ── History tab ── */}
          {rightView === "history" && (
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
                          { label: "Exit Date",   cls: "text-left pl-3"  },
                          { label: "Instrument",  cls: "text-left"       },
                          { label: "B/S",         cls: "text-center"     },
                          { label: "Lots",        cls: "text-right"      },
                          { label: "Entry",       cls: "text-right"      },
                          { label: "Exit",        cls: "text-right"      },
                          { label: "P&L",         cls: "text-right"      },
                          { label: "",            cls: "text-center"     },
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
                          <td className="px-2 py-1.5 font-semibold text-foreground whitespace-nowrap">
                            <div>{t.underlying} {t.strike} {t.option_type}</div>
                            <div className="text-[9px] text-muted-foreground/60 font-normal">{t.expiry}</div>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`px-1 py-0.5 rounded text-[9px] font-bold ${t.action === "BUY" ? "bg-blue-500/20 text-blue-400" : "bg-red-500/20 text-red-400"}`}>
                              {t.action === "BUY" ? "B" : "S"}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-foreground">
                            {t.qty}
                            {t.lot_size && <span className="text-muted-foreground/50 ml-0.5">×{t.lot_size}</span>}
                          </td>
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
