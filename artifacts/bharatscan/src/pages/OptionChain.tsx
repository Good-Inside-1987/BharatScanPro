import { useMemo, useState, useRef, useEffect } from "react";
import { Settings, X, ChevronLeft, ChevronRight, Plus, Minus, Database } from "lucide-react";
import { useData } from "@/context/DataContext";
import { getLotSizeForExpiry } from "@/lib/universe";
import { atmStrike } from "@/lib/options";
import { toast } from "sonner";

// ── Constants ─────────────────────────────────────────────────────────────────
const INDEX_ORDER = ["NIFTY", "BANKNIFTY", "FINNIFTY", "NIFTYNXT50", "MIDCPNIFTY", "SENSEX", "BANKEX"];
const FALLBACK_LOT_SIZES: Record<string, number> = {
  NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 40, NIFTYNXT50: 25,
  MIDCPNIFTY: 120, SENSEX: 20, BANKEX: 15,
};

// ── Types ─────────────────────────────────────────────────────────────────────
type ViewMode = "ltp" | "greeks" | "all";

interface ToggleSettings {
  ltpChangePct: boolean; ltpChange: boolean;
  breakeven: boolean; breakevenPct: boolean;
  volume: boolean; oiChange: boolean; oiChangePct: boolean;
  iv: boolean; bidOffer: boolean;
  delta: boolean; gamma: boolean; theta: boolean; vega: boolean;
  ivChange: boolean; intrinsicSpot: boolean; intrinsicFut: boolean;
  timeValue: boolean; pcr: boolean; pop: boolean;
}

interface AllSettings { ltp: ToggleSettings; greeks: ToggleSettings; all: ToggleSettings; }

interface EnrichedRow {
  strike: number;
  ce: number; pe: number;
  ceOI: number; peOI: number;
  ceOILakh: number; peOILakh: number;
  ceChangeInOI: number; peChangeInOI: number;
  ceOIChgPct: number; peOIChgPct: number;
  ceVolume: number; peVolume: number;
  ceIV: number; peIV: number;
  ceDelta: number; peDelta: number;
  ceGamma: number; peGamma: number;
  ceTheta: number; peTheta: number;
  ceVega: number; peVega: number;
  ceIntrinsicSpot: number; peIntrinsicSpot: number;
  ceIntrinsicFut: number; peIntrinsicFut: number;
  ceTimeValue: number; peTimeValue: number;
  ceBreakeven: number; peBreakeven: number;
  ceBreakevenPct: number; peBreakevenPct: number;
  cePOP: number; pePOP: number;
  cePrevLTP: number; pePrevLTP: number;
  cePrevIV: number; pePrevIV: number;
  pcr: number;
}

// ── Settings ──────────────────────────────────────────────────────────────────
const LTP_DEFAULTS: ToggleSettings = {
  ltpChangePct: false, ltpChange: false, breakeven: false, breakevenPct: false,
  volume: false, oiChange: false, oiChangePct: true, iv: true, bidOffer: false,
  delta: false, gamma: false, theta: false, vega: false,
  ivChange: false, intrinsicSpot: false, intrinsicFut: false, timeValue: false, pcr: false, pop: false,
};
const GREEKS_DEFAULTS: ToggleSettings = {
  ltpChangePct: false, ltpChange: false, breakeven: false, breakevenPct: false,
  volume: false, oiChange: false, oiChangePct: false, iv: false, bidOffer: false,
  delta: true, gamma: true, theta: true, vega: true,
  ivChange: false, intrinsicSpot: false, intrinsicFut: false, timeValue: false, pcr: false, pop: false,
};
const ALL_DEFAULTS: ToggleSettings = {
  ltpChangePct: true, ltpChange: true, breakeven: true, breakevenPct: true,
  volume: true, oiChange: true, oiChangePct: true, iv: true, bidOffer: true,
  delta: true, gamma: true, theta: true, vega: true,
  ivChange: true, intrinsicSpot: true, intrinsicFut: true, timeValue: true, pcr: true, pop: true,
};

const SETTINGS_KEY = "bharatscan:option-chain-settings";

function loadSettings(): AllSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        ltp: { ...LTP_DEFAULTS, ...(p.ltp ?? {}) },
        greeks: { ...GREEKS_DEFAULTS, ...(p.greeks ?? {}) },
        all: { ...ALL_DEFAULTS, ...(p.all ?? {}) },
      };
    }
  } catch {}
  return { ltp: { ...LTP_DEFAULTS }, greeks: { ...GREEKS_DEFAULTS }, all: { ...ALL_DEFAULTS } };
}

function saveSettings(s: AllSettings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

// ── Math ──────────────────────────────────────────────────────────────────────
function normCDF(x: number): number {
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t) * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
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
  if (T <= 0 || mktPrice <= 0 || S <= 0) return 0;
  const intrinsic = type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  if (mktPrice <= intrinsic + 0.01) return 0.001;
  let lo = 0.001, hi = 6.0;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, type) > mktPrice) hi = mid; else lo = mid;
    if (hi - lo < 0.00005) break;
  }
  return (lo + hi) / 2;
}
interface Greeks { delta: number; gamma: number; theta: number; vega: number; }
function calcGreeks(S: number, K: number, T: number, σ: number, type: "CE" | "PE", r = 0.065): Greeks {
  if (S <= 0 || T <= 0 || σ <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * σ * σ) * T) / (σ * sqrtT);
  const d2 = d1 - σ * sqrtT;
  const nd1 = normPDF(d1);
  const delta = type === "CE" ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = nd1 / (S * σ * sqrtT);
  const theta = type === "CE"
    ? (-(S * σ * nd1) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365
    : (-(S * σ * nd1) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCDF(-d2)) / 365;
  const vega = S * sqrtT * nd1 / 100;
  return {
    delta: +delta.toFixed(4),
    gamma: +gamma.toFixed(6),
    theta: +theta.toFixed(2),
    vega: +vega.toFixed(2),
  };
}
function daysToExpiry(today: string, expiry: string): number {
  return Math.max(0, Math.round((new Date(expiry).getTime() - new Date(today).getTime()) / 86400000));
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtNum(n: number, dec = 2): string {
  return isFinite(n) && n !== 0 ? n.toFixed(dec) : "—";
}
function fmtLakh(n: number): string {
  if (!isFinite(n) || n === 0) return "—";
  return (n / 100000).toFixed(1);
}
function fmtPct(n: number): string {
  if (!isFinite(n) || !isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}
function fmtPCR(callOI: number, putOI: number): string {
  if (callOI === 0) return "∞";
  return (putOI / callOI).toFixed(2);
}

// ── OI Bar ────────────────────────────────────────────────────────────────────
function OIHBar({ value, max, color, align }: { value: number; max: number; color: string; align: "left" | "right" }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className={`flex items-center w-full ${align === "right" ? "justify-end" : "justify-start"}`}>
      <div className="w-14 h-1.5 bg-muted/20 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%`, marginLeft: align === "right" ? "auto" : 0 }} />
      </div>
    </div>
  );
}

// ── Toggle switch ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button type="button" onClick={onChange}
      className={`relative shrink-0 w-10 h-5 rounded-full overflow-hidden transition-colors ${checked ? "bg-primary" : "bg-muted/50 border border-border"}`}>
      <span className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────
interface SettingsPanelProps {
  settings: AllSettings;
  onClose: () => void;
  onChange: (view: ViewMode, key: keyof ToggleSettings) => void;
  onReset: (view: ViewMode) => void;
}
function SettingsPanel({ settings, onClose, onChange, onReset }: SettingsPanelProps) {
  const [activeView, setActiveView] = useState<ViewMode>("ltp");
  const s = settings[activeView];
  const viewLabel = activeView === "ltp" ? "LTP View" : activeView === "greeks" ? "Greeks View" : "All Column View";

  const mainToggles: { key: keyof ToggleSettings; label: string }[] = [
    { key: "ltpChangePct", label: "LTP Change %" },
    { key: "ltpChange",    label: "LTP Change" },
    { key: "breakeven",    label: "Breakeven" },
    { key: "breakevenPct", label: "Breakeven %" },
    { key: "volume",       label: "Volume" },
    { key: "oiChange",     label: "OI Change" },
    { key: "oiChangePct",  label: "OI Change %" },
    { key: "iv",           label: "IV" },
    { key: "bidOffer",     label: "Bid Offer" },
  ];
  const greekToggles: { key: keyof ToggleSettings; label: string }[] = [
    { key: "delta", label: "Delta" },
    { key: "gamma", label: "Gamma" },
    { key: "theta", label: "Theta" },
    { key: "vega",  label: "Vega" },
  ];
  const premiumToggles: { key: keyof ToggleSettings; label: string }[] = [
    { key: "pcr",          label: "Per Strike PCR" },
    { key: "ivChange",     label: "IV Change" },
    { key: "intrinsicSpot",label: "Intrinsic value(spot)" },
    { key: "intrinsicFut", label: "Intrinsic value(futures)" },
    { key: "timeValue",    label: "Time Value" },
    { key: "pop",          label: "Probability of Profit" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="w-[640px] bg-background border-l border-border flex overflow-hidden shadow-2xl">
        {/* Sidebar */}
        <div className="w-48 border-r border-border bg-muted/5 py-5 px-3 flex flex-col gap-1 shrink-0">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold px-2 mb-2">Settings</p>
          <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wide px-2 mb-1">Views</p>
          {(["ltp", "greeks", "all"] as ViewMode[]).map((v) => (
            <button key={v} type="button" onClick={() => setActiveView(v)}
              className={`text-left px-3 py-2 rounded text-sm font-medium transition-colors ${
                activeView === v
                  ? "bg-background border border-border text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/20"
              }`}>
              {v === "ltp" ? "LTP View" : v === "greeks" ? "Greeks View" : "All Columns View"}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="sticky top-0 bg-background border-b border-border px-6 py-4 flex items-center justify-between z-10">
            <h3 className="text-base font-semibold text-foreground">Customise {viewLabel}</h3>
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => onReset(activeView)}
                className="text-sm text-primary font-semibold hover:opacity-80 transition-opacity">
                Reset to default
              </button>
              <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="px-6 py-4">
            <div className="grid grid-cols-2 gap-x-10">
              {/* Left column */}
              <div className="space-y-1">
                {mainToggles.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-border/20">
                    <span className="text-sm text-foreground">{label}</span>
                    <Toggle checked={s[key]} onChange={() => onChange(activeView, key)} />
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold pt-3 pb-1">Greeks</p>
                {greekToggles.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-border/20">
                    <span className="text-sm text-foreground">{label}</span>
                    <Toggle checked={s[key]} onChange={() => onChange(activeView, key)} />
                  </div>
                ))}
              </div>

              {/* Right column */}
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold pb-1">Premium Features</p>
                {premiumToggles.map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-border/20">
                    <span className="text-sm text-foreground">{label}</span>
                    <Toggle checked={s[key]} onChange={() => onChange(activeView, key)} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Buy/Sell popup ────────────────────────────────────────────────────────────
interface PopupState { strike: number; optType: "CE" | "PE"; action: "BUY" | "SELL"; ltp: number; }
function BuySellPopup({
  popup, lots, onLotsChange, onConfirm, onClose, symbol, expiry, lotSize,
}: {
  popup: PopupState; lots: number; onLotsChange: (n: number) => void;
  onConfirm: () => void; onClose: () => void;
  symbol: string; expiry: string; lotSize: number;
}) {
  const label = `${symbol} ${popup.strike} ${popup.optType}`;
  const expiryLabel = expiry ? new Date(expiry + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";
  const value = +(popup.ltp * lots * lotSize).toFixed(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-2xl w-72 overflow-hidden">
        {/* Header */}
        <div className={`px-4 py-3 flex items-center justify-between ${
          popup.action === "BUY" ? "bg-blue-500/15 border-b border-blue-500/30" : "bg-red-500/15 border-b border-red-500/30"
        }`}>
          <div>
            <span className={`text-xs font-black uppercase mr-2 ${popup.action === "BUY" ? "text-blue-400" : "text-red-400"}`}>
              {popup.action}
            </span>
            <span className="text-sm font-bold text-foreground">{label}</span>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Expiry</span>
            <span className="font-semibold text-foreground">{expiryLabel}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">LTP</span>
            <span className="font-bold text-foreground tabular-nums">{popup.ltp > 0 ? popup.ltp.toFixed(2) : "—"}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Lot Size</span>
            <span className="font-semibold text-foreground tabular-nums">{lotSize}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Lots</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onLotsChange(Math.max(1, lots - 1))}
                className="p-1 rounded bg-muted/40 hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors">
                <Minus className="h-3 w-3" />
              </button>
              <span className="w-8 text-center text-sm font-bold text-foreground tabular-nums">{lots}</span>
              <button type="button" onClick={() => onLotsChange(lots + 1)}
                className="p-1 rounded bg-muted/40 hover:bg-muted/70 text-muted-foreground hover:text-foreground transition-colors">
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs border-t border-border/40 pt-2">
            <span className="text-muted-foreground">Value ({lots} lot{lots > 1 ? "s" : ""})</span>
            <span className="font-bold text-foreground tabular-nums">₹{value.toLocaleString("en-IN")}</span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 pb-4 flex gap-2">
          <button type="button" onClick={onClose}
            className="flex-1 py-2 rounded text-xs font-semibold text-muted-foreground bg-muted/30 hover:bg-muted/50 transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onConfirm}
            className={`flex-1 py-2 rounded text-xs font-bold transition-colors ${
              popup.action === "BUY"
                ? "bg-blue-600 hover:bg-blue-500 text-white"
                : "bg-red-600 hover:bg-red-500 text-white"
            }`}>
            Confirm {popup.action}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Muted cell helper ─────────────────────────────────────────────────────────
function M({ v, cls = "" }: { v: string; cls?: string }) {
  const isDash = v === "—";
  return <span className={`${isDash ? "text-muted-foreground/35" : ""} ${cls}`}>{v}</span>;
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OptionChainTab() {
  const { optionsData, asOfOptionsDate, lotSizes: csvLotSizes, histories } = useData();

  // ── State ──────────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<AllSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("ltp");
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [selectedExpiry, setSelectedExpiry] = useState("");
  const [perLot, setPerLot] = useState(false);
  const [hoveredStrike, setHoveredStrike] = useState<number | null>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [popupLots, setPopupLots] = useState(1);
  const chainScrollRef = useRef<HTMLDivElement>(null);
  const expiryScrollRef = useRef<HTMLDivElement>(null);

  // ── Derived data ───────────────────────────────────────────────────────────
  const symbols = useMemo(() => {
    if (!optionsData) return [];
    const all = Array.from(optionsData.expiriesBySymbol.keys());
    const indices = INDEX_ORDER.filter((s) => all.includes(s));
    const stocks = all.filter((s) => !INDEX_ORDER.includes(s)).sort();
    return [...indices, ...stocks];
  }, [optionsData]);

  const activeSymbol = selectedSymbol || symbols[0] || "";

  const expiries = useMemo(() => {
    if (!optionsData || !activeSymbol) return [];
    return optionsData.expiriesBySymbol.get(activeSymbol) ?? [];
  }, [optionsData, activeSymbol]);

  const effectiveDate = useMemo(
    () => asOfOptionsDate ?? optionsData?.dates[optionsData.dates.length - 1] ?? "",
    [asOfOptionsDate, optionsData],
  );

  const visibleExpiries = useMemo(() => expiries.filter((e) => e >= effectiveDate), [expiries, effectiveDate]);

  const activeExpiry = useMemo(() => {
    if (selectedExpiry && visibleExpiries.includes(selectedExpiry)) return selectedExpiry;
    return visibleExpiries[0] ?? expiries[expiries.length - 1] ?? "";
  }, [selectedExpiry, visibleExpiries, expiries]);

  // Underlying close — fallback when no futures data is available
  const spotPrice = useMemo(() => {
    if (!activeSymbol || !effectiveDate || !histories.length) return 0;
    const h = histories.find((h) => h.symbol === activeSymbol);
    if (!h) return 0;
    for (let i = h.bars.length - 1; i >= 0; i--) {
      if (h.bars[i].date <= effectiveDate) return h.bars[i].close;
    }
    return 0;
  }, [histories, activeSymbol, effectiveDate]);

  // Futures price — primary reference for ATM / Greeks;
  // falls back to underlying close when futuresCloseByKey is empty
  // (the DB auto-load path never populates it).
  const futuresPrice = useMemo(() => {
    if (!optionsData || !activeSymbol || !effectiveDate) return 0;
    const futuresClose = optionsData.futuresCloseByKey.get(`${activeSymbol}|${effectiveDate}`) ?? 0;
    if (futuresClose > 0) return futuresClose;
    return spotPrice;
  }, [optionsData, activeSymbol, effectiveDate, spotPrice]);

  const spot = futuresPrice;

  const lotSize = getLotSizeForExpiry(csvLotSizes, activeSymbol, activeExpiry, FALLBACK_LOT_SIZES[activeSymbol] ?? 1);
  const dte = useMemo(() => daysToExpiry(effectiveDate, activeExpiry), [effectiveDate, activeExpiry]);
  const T = Math.max(dte, 1) / 365;

  // Previous trading date (for change calculations)
  const prevDate = useMemo(() => {
    if (!optionsData || !effectiveDate) return "";
    const dates = optionsData.dates;
    const idx = dates.indexOf(effectiveDate);
    return idx > 0 ? dates[idx - 1] : "";
  }, [optionsData, effectiveDate]);

  // ── Build enriched chain ───────────────────────────────────────────────────
  const { enrichedChain, maxOI } = useMemo(() => {
    if (!optionsData || !activeSymbol || !activeExpiry || !effectiveDate || spot <= 0) {
      return { enrichedChain: [], maxOI: 1 };
    }

    const strikeKey = `${activeSymbol}|${activeExpiry}`;
    const strikes = optionsData.strikesByKey.get(strikeKey) ?? [];

    // Current bar map
    type RawEntry = { ce: number; pe: number; ceOI: number; peOI: number; ceChgOI: number; peChgOI: number; ceVol: number; peVol: number; };
    const cur = new Map<number, RawEntry>();

    for (const b of optionsData.bars) {
      if (b.symbol !== activeSymbol || b.expiry !== activeExpiry || b.date !== effectiveDate) continue;
      const e = cur.get(b.strike) ?? { ce: 0, pe: 0, ceOI: 0, peOI: 0, ceChgOI: 0, peChgOI: 0, ceVol: 0, peVol: 0 };
      if (b.type === "CE") { e.ce = b.close; e.ceOI = b.oi; e.ceChgOI = b.changeInOI; e.ceVol = b.volume; }
      else                 { e.pe = b.close; e.peOI = b.oi; e.peChgOI = b.changeInOI; e.peVol = b.volume; }
      cur.set(b.strike, e);
    }

    // Previous bar map (for LTP change + IV change)
    const prev = new Map<number, { ce: number; pe: number }>();
    if (prevDate) {
      for (const b of optionsData.bars) {
        if (b.symbol !== activeSymbol || b.expiry !== activeExpiry || b.date !== prevDate) continue;
        const e = prev.get(b.strike) ?? { ce: 0, pe: 0 };
        if (b.type === "CE") e.ce = b.close; else e.pe = b.close;
        prev.set(b.strike, e);
      }
    }

    const maxOI = Math.max(1, ...Array.from(cur.values()).flatMap((v) => [v.ceOI, v.peOI]));

    const enrichedChain: EnrichedRow[] = strikes
      .filter((s) => cur.has(s))
      .map((strike) => {
        const d = cur.get(strike)!;
        const p = prev.get(strike) ?? { ce: 0, pe: 0 };

        // IV
        const ceIVRaw = solveIV(d.ce, spot, strike, T, "CE");
        const peIVRaw = solveIV(d.pe, spot, strike, T, "PE");
        const ceIV = +(ceIVRaw * 100).toFixed(2);
        const peIV = +(peIVRaw * 100).toFixed(2);

        // Greeks
        const ceG = calcGreeks(spot, strike, T, ceIVRaw, "CE");
        const peG = calcGreeks(spot, strike, T, peIVRaw, "PE");

        // OI change %
        const cePrevOI = d.ceOI - d.ceChgOI;
        const pePrevOI = d.peOI - d.peChgOI;
        const ceOIChgPct = cePrevOI > 0 ? (d.ceChgOI / cePrevOI) * 100 : NaN;
        const peOIChgPct = pePrevOI > 0 ? (d.peChgOI / pePrevOI) * 100 : NaN;

        // Intrinsic values
        const ceIntrinsicSpot = Math.max(0, spot - strike);
        const peIntrinsicSpot = Math.max(0, strike - spot);
        const ceIntrinsicFut  = Math.max(0, spot - strike); // using futuresPrice (same as spot here)
        const peIntrinsicFut  = Math.max(0, strike - spot);

        // Time value
        const ceTimeValue = Math.max(0, d.ce - ceIntrinsicSpot);
        const peTimeValue = Math.max(0, d.pe - peIntrinsicSpot);

        // Breakeven
        const ceBreakeven = strike + d.ce;
        const peBreakeven = strike - d.pe;
        const ceBreakevenPct = spot > 0 ? ((ceBreakeven - spot) / spot) * 100 : NaN;
        const peBreakevenPct = spot > 0 ? ((spot - peBreakeven) / spot) * 100 : NaN;

        // POP: CE = (1 - Delta) * 100, PE = |Delta| * 100
        const cePOP = +((1 - ceG.delta) * 100).toFixed(0);
        const pePOP = +(Math.abs(peG.delta) * 100).toFixed(0);

        // PCR
        const pcr = d.ceOI > 0 ? d.peOI / d.ceOI : Infinity;

        // Prev IV — use T+1 day since previous bar was one day earlier
        const prevT = Math.max(dte + 1, 1) / 365;
        const cePrevIVRaw = p.ce > 0 ? solveIV(p.ce, spot, strike, prevT, "CE") : 0;
        const pePrevIVRaw = p.pe > 0 ? solveIV(p.pe, spot, strike, prevT, "PE") : 0;

        return {
          strike,
          ce: d.ce, pe: d.pe,
          ceOI: d.ceOI, peOI: d.peOI,
          ceOILakh: d.ceOI / 100000, peOILakh: d.peOI / 100000,
          ceChangeInOI: d.ceChgOI, peChangeInOI: d.peChgOI,
          ceOIChgPct, peOIChgPct,
          ceVolume: d.ceVol, peVolume: d.peVol,
          ceIV, peIV,
          ceDelta: ceG.delta, peDelta: peG.delta,
          ceGamma: ceG.gamma, peGamma: peG.gamma,
          ceTheta: ceG.theta, peTheta: peG.theta,
          ceVega: ceG.vega, peVega: peG.vega,
          ceIntrinsicSpot, peIntrinsicSpot,
          ceIntrinsicFut, peIntrinsicFut,
          ceTimeValue, peTimeValue,
          ceBreakeven, peBreakeven,
          ceBreakevenPct, peBreakevenPct,
          cePOP, pePOP,
          cePrevLTP: p.ce, pePrevLTP: p.pe,
          cePrevIV: +(cePrevIVRaw * 100).toFixed(2),
          pePrevIV: +(pePrevIVRaw * 100).toFixed(2),
          pcr,
        };
      });

    return { enrichedChain, maxOI };
  }, [optionsData, activeSymbol, activeExpiry, effectiveDate, spot, T, prevDate]);

  const atmK = useMemo(() => {
    if (!spot || !enrichedChain.length) return 0;
    return atmStrike(spot, undefined, enrichedChain.map((r) => r.strike)) ?? 0;
  }, [spot, enrichedChain]);

  // Scroll to ATM — center vertically within the chain scroll container
  useEffect(() => {
    if (!chainScrollRef.current || !atmK) return;
    const container = chainScrollRef.current;
    const id = requestAnimationFrame(() => {
      const el = container.querySelector<HTMLElement>('[data-atm="true"]');
      if (!el) return;
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      // Shift scrollTop so the ATM row's center aligns with the container's center
      container.scrollTop += eRect.top - cRect.top - (cRect.height / 2 - eRect.height / 2);
    });
    return () => cancelAnimationFrame(id);
  }, [atmK, activeExpiry]);

  // Scroll active expiry into view
  useEffect(() => {
    if (!expiryScrollRef.current || !activeExpiry) return;
    const el = expiryScrollRef.current.querySelector<HTMLButtonElement>(`[data-expiry="${activeExpiry}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeExpiry]);

  // ── Settings helpers ───────────────────────────────────────────────────────
  const updateSettings = (upd: Partial<AllSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...upd };
      saveSettings(next);
      return next;
    });
  };

  const handleToggle = (view: ViewMode, key: keyof ToggleSettings) => {
    updateSettings({ [view]: { ...settings[view], [key]: !settings[view][key] } });
  };

  const handleReset = (view: ViewMode) => {
    const d = view === "ltp" ? LTP_DEFAULTS : view === "greeks" ? GREEKS_DEFAULTS : ALL_DEFAULTS;
    updateSettings({ [view]: { ...d } });
  };

  // ── Column visibility ──────────────────────────────────────────────────────
  const s = settings[viewMode];

  // For LTP view, oiLakh and oiBar are always shown. OI Chg%, IV are settings-controlled (default ON).
  // For Greeks view, delta/gamma/theta/vega default ON.
  // "always" = oiLakh, oiBar, ltp, strike are never hidden.
  function vis(key: keyof ToggleSettings): boolean {
    return s[key];
  }

  // Column groups for LTP view (always shown even without settings toggle):
  // oiLakh, oiBar, ltp on CALLS side; same mirrored on PUTS side
  // Greeks view adds: gamma, vega, theta, delta (settings-controlled, default ON)

  function isGreekView() { return viewMode === "greeks"; }

  // ── Side width: sum of all visible column px widths (same formula header + rows) ──
  // centerWidth is always just the Strike column so it stays perfectly centred.
  // IV is placed as the innermost column on each side (CE IV → CALLS, PE IV → PUTS)
  // so both sides remain equal-width and the Strike is never displaced.
  const centerWidth = 60;
  const sideWidth = useMemo(() => {
    let w = 44 + 56 + 52; // OI-lakh(44) + OI-bar(56) + LTP(52) — always visible
    if (s.iv)            w += 36; // CE IV (CALLS innermost) / PE IV (PUTS innermost)
    if (s.ltpChangePct)  w += 44;
    if (s.ltpChange)     w += 44;
    if (s.breakeven)     w += 48;
    if (s.breakevenPct)  w += 48;
    if (s.timeValue)     w += 44;
    if (s.intrinsicSpot) w += 44;
    if (s.intrinsicFut)  w += 44;
    if (s.bidOffer)      w += 72; // bid(36) + offer(36)
    if (s.oiChangePct)   w += 44;
    if (s.oiChange)      w += 48;
    if (s.volume)        w += 48;
    if (s.pop)           w += 36;
    if (s.pcr)           w += 36;
    const sg = viewMode === "all" || viewMode === "greeks";
    if (sg && s.delta) w += 48;
    if (sg && s.theta) w += 40;
    if (sg && s.vega)  w += 40;
    if (sg && s.gamma) w += 48;
    return w;
  }, [s, viewMode]);

  // ── LTP value (per-lot adjusted) ────────────────────────────────────────
  function adjLTP(ltp: number) {
    return perLot ? ltp * lotSize : ltp;
  }

  // ── Step expiry ────────────────────────────────────────────────────────────
  const stepExpiry = (dir: "left" | "right") => {
    const idx = visibleExpiries.indexOf(activeExpiry);
    const base = idx < 0 ? 0 : idx;
    const next = dir === "left" ? visibleExpiries[base - 1] : visibleExpiries[base + 1];
    if (next) setSelectedExpiry(next);
  };

  // ── Buy/Sell confirm ────────────────────────────────────────────────────────
  const handleConfirm = () => {
    if (!popup) return;
    const lbl = `${activeSymbol} ${popup.strike} ${popup.optType} @ ₹${popup.ltp.toFixed(2)} × ${popupLots} lot${popupLots > 1 ? "s" : ""}`;
    if (popup.action === "BUY") toast.success(`BUY added: ${lbl}`);
    else toast.error(`SELL added: ${lbl}`);
    setPopup(null);
    setPopupLots(1);
  };

  // ── No data state ──────────────────────────────────────────────────────────
  if (!optionsData || !symbols.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-6">
        <div className="rounded-full bg-muted/30 p-5"><Database className="h-10 w-10 text-muted-foreground/50" /></div>
        <div className="text-center max-w-sm">
          <p className="text-base font-semibold text-foreground mb-1">No options data loaded</p>
          <p className="text-xs text-muted-foreground">
            Upload an NSE FO bhavcopy CSV from the Create Scan page to view the option chain.
          </p>
        </div>
      </div>
    );
  }

  const spotLabel = spot > 0 ? spot.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-100px)] overflow-hidden bg-background">

      {/* Settings panel overlay */}
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onChange={handleToggle}
          onReset={handleReset}
        />
      )}

      {/* Buy/Sell popup */}
      {popup && (
        <BuySellPopup
          popup={popup} lots={popupLots} onLotsChange={setPopupLots}
          onConfirm={handleConfirm} onClose={() => { setPopup(null); setPopupLots(1); }}
          symbol={activeSymbol} expiry={activeExpiry} lotSize={lotSize}
        />
      )}

      {/* ── Header bar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-[#0d1117] shrink-0 flex-wrap gap-y-1">
        {/* Symbol selector */}
        <select
          value={activeSymbol}
          onChange={(e) => { setSelectedSymbol(e.target.value); setSelectedExpiry(""); }}
          className="text-xs font-bold bg-transparent border border-border/60 rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 min-w-[110px]"
        >
          <optgroup label="── Indices ──">
            {symbols.filter((s) => INDEX_ORDER.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
          </optgroup>
          {symbols.some((s) => !INDEX_ORDER.includes(s)) && (
            <optgroup label="── Stocks ──">
              {symbols.filter((s) => !INDEX_ORDER.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
          )}
        </select>

        {/* Expiry with arrows */}
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => stepExpiry("left")}
            disabled={visibleExpiries.indexOf(activeExpiry) <= 0}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <div ref={expiryScrollRef} className="flex gap-1 max-w-[240px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {visibleExpiries.map((exp) => {
              const label = new Date(exp + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
              const isActive = exp === activeExpiry;
              return (
                <button key={exp} data-expiry={exp} type="button" onClick={() => setSelectedExpiry(exp)}
                  className={`shrink-0 px-2 py-0.5 rounded text-[9px] font-bold transition-all ${
                    isActive ? "bg-primary text-primary-foreground" : "bg-muted/30 text-muted-foreground hover:bg-muted/50"
                  }`}>
                  {label}
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => stepExpiry("right")}
            disabled={visibleExpiries.indexOf(activeExpiry) >= visibleExpiries.length - 1}
            className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Spot */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Spot</span>
          <span className={`font-bold tabular-nums ${spot > 0 ? "text-emerald-400" : "text-muted-foreground/50"}`}>{spotLabel}</span>
        </div>

        {/* Synth Fut */}
        {spot > 0 && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Synth Fut</span>
            <span className="font-bold text-foreground tabular-nums">{spotLabel}</span>
          </div>
        )}

        {/* Per Lot toggle */}
        <div className="flex items-center gap-1.5">
          <Toggle checked={perLot} onChange={() => setPerLot((v) => !v)} />
          <span className="text-[10px] text-muted-foreground font-medium">Per Lot</span>
        </div>

        {/* View switcher */}
        <div className="ml-auto flex items-center gap-0.5 bg-muted/20 border border-border/50 rounded p-0.5">
          {(["ltp", "greeks", "all"] as ViewMode[]).map((v) => (
            <button key={v} type="button" onClick={() => setViewMode(v)}
              className={`px-2.5 py-0.5 text-[10px] font-semibold rounded transition-colors ${
                viewMode === v ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground"
              }`}>
              {v === "ltp" ? "LTP View" : v === "greeks" ? "Greeks View" : "All Column View"}
            </button>
          ))}
        </div>

        {/* Settings gear */}
        <button type="button" onClick={() => setSettingsOpen(true)}
          className="p-1.5 rounded border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-colors">
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Chain table ─────────────────────────────────────────────────── */}
      {enrichedChain.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-xs text-muted-foreground/50">
          No chain data for selected date / expiry
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          {/* Single scroll container — header and rows share one scroll position */}
          <div ref={chainScrollRef} className="h-full overflow-auto">
            {/* Centering wrapper: w-fit + mx-auto centers the table when the viewport is wider;
                overflow-auto on the parent handles horizontal scroll when the table is wider */}
            <div className="w-fit mx-auto">
            {/* Sticky header — stays at top during vertical scroll, moves with horizontal scroll */}
            <div className="sticky top-0 z-10 bg-[#0d1117] border-b border-border">
              {/* Group header: CALLS | center | PUTS */}
              <div className="flex text-[9px] font-black uppercase tracking-widest">
                <div className="shrink-0 text-center py-1 text-red-400 bg-red-500/5 border-r border-border/30" style={{ width: sideWidth }}>CALLS</div>
                <div className="shrink-0 text-center py-1 text-foreground/60 border-r border-border/30" style={{ width: centerWidth }}>&nbsp;</div>
                <div className="shrink-0 text-center py-1 text-emerald-400 bg-emerald-500/5" style={{ width: sideWidth }}>PUTS</div>
              </div>

              {/* Column headers */}
              <div className="flex text-[8px] uppercase tracking-wide text-muted-foreground/60 font-semibold border-b border-border/30">
                {/* CALLS side — right-aligned, rightmost = LTP (closest to center) */}
                <div className="flex shrink-0 justify-end" style={{ width: sideWidth }}>
                  {(isGreekView() || viewMode === "all") && vis("gamma") && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">Gamma</div>}
                  {(isGreekView() || viewMode === "all") && vis("vega")  && <div className="px-1.5 py-1 text-right w-[40px] shrink-0">Vega</div>}
                  {(isGreekView() || viewMode === "all") && vis("theta") && <div className="px-1.5 py-1 text-right w-[40px] shrink-0">Theta</div>}
                  {(isGreekView() || viewMode === "all") && vis("delta") && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">Delta</div>}
                  {vis("pcr")          && <div className="px-1.5 py-1 text-right w-[36px] shrink-0">PCR</div>}
                  {vis("pop")          && <div className="px-1.5 py-1 text-right w-[36px] shrink-0">POP</div>}
                  {vis("volume")       && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">Vol</div>}
                  {vis("oiChange")     && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">OI Chg</div>}
                  {vis("oiChangePct")  && <div className="px-1.5 py-1 text-right w-[44px] shrink-0">OI Chg%</div>}
                                          <div className="px-1.5 py-1 text-right w-[44px] shrink-0">OI-lakh</div>
                                          <div className="px-1.5 py-1 text-right w-[56px] shrink-0">Call OI</div>
                  {vis("bidOffer")     && <div className="px-1.5 py-1 text-right w-[36px] shrink-0">Bid</div>}
                  {vis("bidOffer")     && <div className="px-1.5 py-1 text-right w-[36px] shrink-0">Offer</div>}
                  {vis("intrinsicFut") && <div className="px-1.5 py-1 text-right w-[44px] shrink-0">Int F</div>}
                  {vis("intrinsicSpot")&& <div className="px-1.5 py-1 text-right w-[44px] shrink-0">Int S</div>}
                  {vis("timeValue")    && <div className="px-1.5 py-1 text-right w-[44px] shrink-0">TV</div>}
                  {vis("breakevenPct") && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">BEP%</div>}
                  {vis("breakeven")    && <div className="px-1.5 py-1 text-right w-[48px] shrink-0">BE</div>}
                  {vis("ltpChange")    && <div className="px-1.5 py-1 text-right w-[44px] shrink-0">LTP Chg</div>}
                  {vis("ltpChangePct") && <div className="px-1.5 py-1 text-right w-[44px] shrink-0">LTP%</div>}
                                          <div className="px-2 py-1 text-right w-[52px] shrink-0">LTP</div>
                  {vis("iv")           && <div className="px-1.5 py-1 text-right w-[36px] shrink-0">IV</div>}
                </div>

                {/* Center — Strike only, always 60 px so it stays perfectly centred */}
                <div className="shrink-0 flex items-center border-x border-border/40" style={{ width: centerWidth }}>
                  <div className="text-center py-1 w-[60px] shrink-0">Strike</div>
                </div>

                {/* PUTS side — left-aligned, leftmost = IV (when on) then LTP */}
                <div className="flex shrink-0" style={{ width: sideWidth }}>
                  {vis("iv")           && <div className="px-1.5 py-1 text-left w-[36px] shrink-0">IV</div>}
                                          <div className="px-2 py-1 text-left w-[52px] shrink-0">LTP</div>
                  {vis("ltpChangePct") && <div className="px-1.5 py-1 text-left w-[44px] shrink-0">LTP%</div>}
                  {vis("ltpChange")    && <div className="px-1.5 py-1 text-left w-[44px] shrink-0">LTP Chg</div>}
                  {vis("breakeven")    && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">BE</div>}
                  {vis("breakevenPct") && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">BEP%</div>}
                  {vis("timeValue")    && <div className="px-1.5 py-1 text-left w-[44px] shrink-0">TV</div>}
                  {vis("intrinsicSpot")&& <div className="px-1.5 py-1 text-left w-[44px] shrink-0">Int S</div>}
                  {vis("intrinsicFut") && <div className="px-1.5 py-1 text-left w-[44px] shrink-0">Int F</div>}
                  {vis("bidOffer")     && <div className="px-1.5 py-1 text-left w-[36px] shrink-0">Offer</div>}
                  {vis("bidOffer")     && <div className="px-1.5 py-1 text-left w-[36px] shrink-0">Bid</div>}
                                          <div className="px-1.5 py-1 text-left w-[56px] shrink-0">Put OI</div>
                                          <div className="px-1.5 py-1 text-left w-[44px] shrink-0">OI-lakh</div>
                  {vis("oiChangePct")  && <div className="px-1.5 py-1 text-left w-[44px] shrink-0">OI Chg%</div>}
                  {vis("oiChange")     && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">OI Chg</div>}
                  {vis("volume")       && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">Vol</div>}
                  {vis("pop")          && <div className="px-1.5 py-1 text-left w-[36px] shrink-0">POP</div>}
                  {vis("pcr")          && <div className="px-1.5 py-1 text-left w-[36px] shrink-0">PCR</div>}
                  {(isGreekView() || viewMode === "all") && vis("delta") && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">Delta</div>}
                  {(isGreekView() || viewMode === "all") && vis("theta") && <div className="px-1.5 py-1 text-left w-[40px] shrink-0">Theta</div>}
                  {(isGreekView() || viewMode === "all") && vis("vega")  && <div className="px-1.5 py-1 text-left w-[40px] shrink-0">Vega</div>}
                  {(isGreekView() || viewMode === "all") && vis("gamma") && <div className="px-1.5 py-1 text-left w-[48px] shrink-0">Gamma</div>}
                </div>
              </div>
            </div>

            {/* Rows */}
            <div className="bg-[#0d1117] min-w-max">
              {enrichedChain.map((row) => {
                const isATM = row.strike === atmK;
                const isCeITM = !isATM && spot > 0 && row.strike < spot;
                const isPeITM = !isATM && spot > 0 && row.strike > spot;

                const ceBg = isATM ? "bg-blue-500/[0.15]" : isCeITM ? "bg-amber-500/[0.07]" : "";
                const peBg = isATM ? "bg-blue-500/[0.15]" : isPeITM ? "bg-green-500/[0.07]" : "";
                const strikeBg = isATM ? "bg-blue-500/[0.25]" : "bg-white/5";

                const ceLTP = adjLTP(row.ce);
                const peLTP = adjLTP(row.pe);
                const ceLTPChg = row.cePrevLTP > 0 ? row.ce - row.cePrevLTP : NaN;
                const peLTPChg = row.pePrevLTP > 0 ? row.pe - row.pePrevLTP : NaN;
                const ceLTPChgPct = row.cePrevLTP > 0 ? (ceLTPChg / row.cePrevLTP) * 100 : NaN;
                const peLTPChgPct = row.pePrevLTP > 0 ? (peLTPChg / row.pePrevLTP) * 100 : NaN;
                const ceIVChg = row.cePrevIV > 0 ? row.ceIV - row.cePrevIV : NaN;
                const peIVChg = row.pePrevIV > 0 ? row.peIV - row.pePrevIV : NaN;

                const showBuySell = hoveredStrike === row.strike;

                return (
                  <div
                    key={row.strike}
                    data-atm={isATM ? "true" : undefined}
                    onMouseEnter={() => setHoveredStrike(row.strike)}
                    onMouseLeave={() => setHoveredStrike(null)}
                    className={`flex text-[10px] tabular-nums border-b ${isATM ? "border-blue-400/30" : "border-border/15"}`}
                  >
                    {/* ── CALLS side ─────────────────────────────── */}
                    <div className={`flex shrink-0 justify-end items-center ${ceBg}`} style={{ width: sideWidth }}>
                      {(isGreekView() || viewMode === "all") && vis("gamma") && <div className="px-1.5 py-1.5 text-right w-[48px] shrink-0 text-muted-foreground/80">{fmtNum(row.ceGamma, 4)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("vega")  && <div className="px-1.5 py-1.5 text-right w-[40px] shrink-0 text-muted-foreground/80">{fmtNum(row.ceVega)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("theta") && <div className="px-1.5 py-1.5 text-right w-[40px] shrink-0 text-amber-400/80">{fmtNum(row.ceTheta)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("delta") && <div className={`px-1.5 py-1.5 text-right w-[48px] shrink-0 font-semibold ${row.ceDelta > 0.5 ? "text-emerald-400" : "text-foreground/70"}`}>{fmtNum(row.ceDelta, 4)}</div>}
                      {vis("pcr")          && <div className="px-1.5 py-1.5 text-right w-[36px] shrink-0 text-cyan-400/80">{fmtPCR(row.ceOI, row.peOI)}</div>}
                      {vis("pop")          && <div className="px-1.5 py-1.5 text-right w-[36px] shrink-0 text-violet-400/80">{row.cePOP > 0 ? `${row.cePOP}%` : "—"}</div>}
                      {vis("volume")       && <div className="px-1.5 py-1.5 text-right w-[48px] shrink-0 text-muted-foreground/60"><M v={row.ceVolume > 0 ? fmtLakh(row.ceVolume) : "—"} /></div>}
                      {vis("oiChange")     && <div className={`px-1.5 py-1.5 text-right w-[48px] shrink-0 ${row.ceChangeInOI >= 0 ? "text-red-400/70" : "text-emerald-400/70"}`}><M v={isFinite(row.ceChangeInOI) && row.ceChangeInOI !== 0 ? fmtLakh(row.ceChangeInOI) : "—"} /></div>}
                      {vis("oiChangePct")  && <div className={`px-1.5 py-1.5 text-right w-[44px] shrink-0 font-semibold ${isFinite(row.ceOIChgPct) ? (row.ceOIChgPct >= 0 ? "text-red-400" : "text-emerald-400") : ""}`}><M v={isFinite(row.ceOIChgPct) ? fmtPct(row.ceOIChgPct) : "—"} /></div>}
                      {/* OI-lakh always */}
                      <div className="px-1.5 py-1.5 text-right w-[44px] shrink-0 text-muted-foreground/60">{fmtLakh(row.ceOI)}</div>
                      {/* OI bar (+ B/S overlay) */}
                      <div className="relative px-1 py-1.5 w-[56px] shrink-0 flex flex-col justify-center gap-0.5">
                        <OIHBar value={row.ceOI} max={maxOI} color="bg-red-500/70" align="right" />
                        {showBuySell && row.ce > 0 && (
                          <div className="absolute inset-0 flex items-center justify-center gap-1">
                            <button type="button"
                              onClick={() => { setPopup({ strike: row.strike, optType: "CE", action: "BUY", ltp: row.ce }); setPopupLots(1); }}
                              className="text-[8px] font-black px-1.5 py-0.5 rounded bg-blue-600/70 text-blue-100 hover:bg-blue-500 transition-colors shadow-md leading-tight">B</button>
                            <button type="button"
                              onClick={() => { setPopup({ strike: row.strike, optType: "CE", action: "SELL", ltp: row.ce }); setPopupLots(1); }}
                              className="text-[8px] font-black px-1.5 py-0.5 rounded bg-red-600/70 text-red-100 hover:bg-red-500 transition-colors shadow-md leading-tight">S</button>
                          </div>
                        )}
                      </div>
                      {vis("bidOffer")     && <div className="px-1.5 py-1.5 text-right w-[36px] shrink-0 text-muted-foreground/50"><M v="—" /></div>}
                      {vis("bidOffer")     && <div className="px-1.5 py-1.5 text-right w-[36px] shrink-0 text-muted-foreground/50"><M v="—" /></div>}
                      {vis("intrinsicFut") && <div className="px-1.5 py-1.5 text-right w-[44px] shrink-0 text-muted-foreground/70"><M v={row.ceIntrinsicFut > 0 ? row.ceIntrinsicFut.toFixed(1) : "0.0"} /></div>}
                      {vis("intrinsicSpot")&& <div className="px-1.5 py-1.5 text-right w-[44px] shrink-0 text-muted-foreground/70"><M v={row.ceIntrinsicSpot > 0 ? row.ceIntrinsicSpot.toFixed(1) : "0.0"} /></div>}
                      {vis("timeValue")    && <div className="px-1.5 py-1.5 text-right w-[44px] shrink-0 text-sky-400/70"><M v={row.ceTimeValue > 0 ? row.ceTimeValue.toFixed(1) : "—"} /></div>}
                      {vis("breakevenPct") && <div className={`px-1.5 py-1.5 text-right w-[48px] shrink-0 ${isFinite(row.ceBreakevenPct) ? "text-amber-400/80" : ""}`}><M v={isFinite(row.ceBreakevenPct) ? fmtPct(row.ceBreakevenPct) : "—"} /></div>}
                      {vis("breakeven")    && <div className="px-1.5 py-1.5 text-right w-[48px] shrink-0 text-amber-400/80"><M v={row.ceBreakeven > 0 ? row.ceBreakeven.toFixed(0) : "—"} /></div>}
                      {vis("ltpChange")    && <div className={`px-1.5 py-1.5 text-right w-[44px] shrink-0 font-semibold ${isFinite(ceLTPChg) ? (ceLTPChg >= 0 ? "text-emerald-400/80" : "text-red-400/80") : ""}`}><M v={isFinite(ceLTPChg) ? (ceLTPChg >= 0 ? "+" : "") + ceLTPChg.toFixed(2) : "—"} /></div>}
                      {vis("ltpChangePct") && <div className={`px-1.5 py-1.5 text-right w-[44px] shrink-0 font-semibold ${isFinite(ceLTPChgPct) ? (ceLTPChgPct >= 0 ? "text-emerald-400/80" : "text-red-400/80") : ""}`}><M v={isFinite(ceLTPChgPct) ? fmtPct(ceLTPChgPct) : "—"} /></div>}
                      {/* LTP always */}
                      <div className={`px-2 py-1.5 text-right w-[52px] shrink-0 font-bold ${row.ce > 0 ? "text-foreground" : "text-foreground/30"}`}>
                        {row.ce > 0 ? ceLTP.toFixed(1) : "—"}
                      </div>
                      {/* CE IV — innermost CALLS column, mirrored by PE IV on PUTS side */}
                      {vis("iv") && (
                        <div className="px-1.5 py-1.5 w-[36px] shrink-0 flex flex-col items-center justify-center">
                          <span className="text-muted-foreground/70">{row.ceIV > 0 ? row.ceIV.toFixed(1) : "—"}</span>
                          {vis("ivChange") && isFinite(ceIVChg) && (
                            <div className={`text-[7px] leading-tight ${ceIVChg >= 0 ? "text-amber-400/70" : "text-sky-400/70"}`}>
                              {ceIVChg >= 0 ? "+" : ""}{ceIVChg.toFixed(1)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* ── Center — Strike only, always 60 px ─────── */}
                    <div className={`shrink-0 flex items-center border-x border-border/30 ${strikeBg}`} style={{ width: centerWidth }}>
                      <div className={`text-center py-1.5 font-bold w-[60px] shrink-0 ${isATM ? "text-blue-300" : "text-foreground/80"}`}>
                        {isATM && <span className="text-[7px] text-blue-400 mr-0.5 font-black">★</span>}
                        {row.strike.toLocaleString("en-IN")}
                      </div>
                    </div>

                    {/* ── PUTS side ──────────────────────────────── */}
                    <div className={`flex shrink-0 items-center ${peBg}`} style={{ width: sideWidth }}>
                      {/* PE IV — innermost PUTS column, mirrors CE IV on CALLS side */}
                      {vis("iv") && (
                        <div className="px-1.5 py-1.5 w-[36px] shrink-0 flex flex-col items-center justify-center">
                          <span className="text-muted-foreground/70">{row.peIV > 0 ? row.peIV.toFixed(1) : "—"}</span>
                          {vis("ivChange") && isFinite(peIVChg) && (
                            <div className={`text-[7px] leading-tight ${peIVChg >= 0 ? "text-amber-400/70" : "text-sky-400/70"}`}>
                              {peIVChg >= 0 ? "+" : ""}{peIVChg.toFixed(1)}
                            </div>
                          )}
                        </div>
                      )}
                      {/* LTP always */}
                      <div className={`px-2 py-1.5 text-left w-[52px] shrink-0 font-bold ${row.pe > 0 ? "text-foreground" : "text-foreground/30"}`}>
                        {row.pe > 0 ? peLTP.toFixed(1) : "—"}
                      </div>
                      {vis("ltpChangePct") && <div className={`px-1.5 py-1.5 text-left w-[44px] shrink-0 font-semibold ${isFinite(peLTPChgPct) ? (peLTPChgPct >= 0 ? "text-emerald-400/80" : "text-red-400/80") : ""}`}><M v={isFinite(peLTPChgPct) ? fmtPct(peLTPChgPct) : "—"} /></div>}
                      {vis("ltpChange")    && <div className={`px-1.5 py-1.5 text-left w-[44px] shrink-0 font-semibold ${isFinite(peLTPChg) ? (peLTPChg >= 0 ? "text-emerald-400/80" : "text-red-400/80") : ""}`}><M v={isFinite(peLTPChg) ? (peLTPChg >= 0 ? "+" : "") + peLTPChg.toFixed(2) : "—"} /></div>}
                      {vis("breakeven")    && <div className="px-1.5 py-1.5 text-left w-[48px] shrink-0 text-amber-400/80"><M v={row.peBreakeven > 0 ? row.peBreakeven.toFixed(0) : "—"} /></div>}
                      {vis("breakevenPct") && <div className={`px-1.5 py-1.5 text-left w-[48px] shrink-0 ${isFinite(row.peBreakevenPct) ? "text-amber-400/80" : ""}`}><M v={isFinite(row.peBreakevenPct) ? fmtPct(row.peBreakevenPct) : "—"} /></div>}
                      {vis("timeValue")    && <div className="px-1.5 py-1.5 text-left w-[44px] shrink-0 text-sky-400/70"><M v={row.peTimeValue > 0 ? row.peTimeValue.toFixed(1) : "—"} /></div>}
                      {vis("intrinsicSpot")&& <div className="px-1.5 py-1.5 text-left w-[44px] shrink-0 text-muted-foreground/70"><M v={row.peIntrinsicSpot > 0 ? row.peIntrinsicSpot.toFixed(1) : "0.0"} /></div>}
                      {vis("intrinsicFut") && <div className="px-1.5 py-1.5 text-left w-[44px] shrink-0 text-muted-foreground/70"><M v={row.peIntrinsicFut > 0 ? row.peIntrinsicFut.toFixed(1) : "0.0"} /></div>}
                      {vis("bidOffer")     && <div className="px-1.5 py-1.5 text-left w-[36px] shrink-0 text-muted-foreground/50"><M v="—" /></div>}
                      {vis("bidOffer")     && <div className="px-1.5 py-1.5 text-left w-[36px] shrink-0 text-muted-foreground/50"><M v="—" /></div>}
                      {/* Put OI bar (+ B/S overlay) */}
                      <div className="relative px-1 py-1.5 w-[56px] shrink-0 flex flex-col justify-center gap-0.5">
                        <OIHBar value={row.peOI} max={maxOI} color="bg-emerald-500/70" align="left" />
                        {showBuySell && row.pe > 0 && (
                          <div className="absolute inset-0 flex items-center justify-center gap-1">
                            <button type="button"
                              onClick={() => { setPopup({ strike: row.strike, optType: "PE", action: "BUY", ltp: row.pe }); setPopupLots(1); }}
                              className="text-[8px] font-black px-1.5 py-0.5 rounded bg-blue-600/70 text-blue-100 hover:bg-blue-500 transition-colors shadow-md leading-tight">B</button>
                            <button type="button"
                              onClick={() => { setPopup({ strike: row.strike, optType: "PE", action: "SELL", ltp: row.pe }); setPopupLots(1); }}
                              className="text-[8px] font-black px-1.5 py-0.5 rounded bg-red-600/70 text-red-100 hover:bg-red-500 transition-colors shadow-md leading-tight">S</button>
                          </div>
                        )}
                      </div>
                      {/* OI-lakh always */}
                      <div className="px-1.5 py-1.5 text-left w-[44px] shrink-0 text-muted-foreground/60">{fmtLakh(row.peOI)}</div>
                      {vis("oiChangePct")  && <div className={`px-1.5 py-1.5 text-left w-[44px] shrink-0 font-semibold ${isFinite(row.peOIChgPct) ? (row.peOIChgPct >= 0 ? "text-emerald-400" : "text-red-400") : ""}`}><M v={isFinite(row.peOIChgPct) ? fmtPct(row.peOIChgPct) : "—"} /></div>}
                      {vis("oiChange")     && <div className={`px-1.5 py-1.5 text-left w-[48px] shrink-0 ${row.peChangeInOI >= 0 ? "text-emerald-400/70" : "text-red-400/70"}`}><M v={isFinite(row.peChangeInOI) && row.peChangeInOI !== 0 ? fmtLakh(row.peChangeInOI) : "—"} /></div>}
                      {vis("volume")       && <div className="px-1.5 py-1.5 text-left w-[48px] shrink-0 text-muted-foreground/60"><M v={row.peVolume > 0 ? fmtLakh(row.peVolume) : "—"} /></div>}
                      {vis("pop")          && <div className="px-1.5 py-1.5 text-left w-[36px] shrink-0 text-violet-400/80">{row.pePOP > 0 ? `${row.pePOP}%` : "—"}</div>}
                      {vis("pcr")          && <div className="px-1.5 py-1.5 text-left w-[36px] shrink-0 text-cyan-400/80">{fmtPCR(row.ceOI, row.peOI)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("delta") && <div className={`px-1.5 py-1.5 text-left w-[48px] shrink-0 font-semibold ${Math.abs(row.peDelta) > 0.5 ? "text-red-400" : "text-foreground/70"}`}>{fmtNum(row.peDelta, 4)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("theta") && <div className="px-1.5 py-1.5 text-left w-[40px] shrink-0 text-amber-400/80">{fmtNum(row.peTheta)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("vega")  && <div className="px-1.5 py-1.5 text-left w-[40px] shrink-0 text-muted-foreground/80">{fmtNum(row.peVega)}</div>}
                      {(isGreekView() || viewMode === "all") && vis("gamma") && <div className="px-1.5 py-1.5 text-left w-[48px] shrink-0 text-muted-foreground/80">{fmtNum(row.peGamma, 4)}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>{/* /w-fit mx-auto centering wrapper */}
          </div>
        </div>
      )}
    </div>
  );
}
