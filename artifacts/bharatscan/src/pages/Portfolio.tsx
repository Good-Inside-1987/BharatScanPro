import { useState, useMemo, useCallback, useRef, useEffect, Fragment } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus, RefreshCw, Trash2, ChevronDown, ChevronUp, X,
  Briefcase, Pencil, Download, Upload, ArrowLeft, LayoutGrid,
  Eye, EyeOff,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { useData } from "@/context/DataContext";
import {
  apiListDashboards,
  apiCreateDashboard,
  apiUpdateDashboard,
  apiDeleteDashboard,
  apiListPortfolios,
  apiCreatePortfolio,
  apiUpdatePortfolio,
  apiDeletePortfolio,
  apiListHoldings,
  apiAddHolding,
  apiUpdateHolding,
  apiDeleteHolding,
  apiSquareOff,
  apiListBookedTrades,
  apiListAllHoldings,
  apiListAllBookedTrades,
  apiImportPortfolios,
  apiGetMarketQuotes,
  apiGetSchedulerStatus,
  type ApiDashboard,
  type ApiPortfolio,
  type ApiHolding,
  type ApiAllHolding,
  type ApiAllBookedTrade,
  type ApiLiveQuote,
  type ImportPortfolioPayload,
} from "@/lib/api";
import type { SymbolHistory } from "@/lib/csv";
import { toast } from "sonner";

// ─── Dashboard accent colors ───────────────────────────────────────────────────

const DASHBOARD_COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444",
  "#3b82f6", "#8b5cf6", "#06b6d4", "#f97316",
  "#ec4899", "#84cc16",
];

// ─── Price helpers ────────────────────────────────────────────────────────────

type LiveQuoteMap = Record<string, ApiLiveQuote>;

function fyersSymbol(symbol: string): string {
  return symbol.includes(":") ? symbol : `NSE:${symbol}-EQ`;
}

function quoteTicker(quote: ApiLiveQuote): string {
  const base = quote.symbol.includes(":") ? quote.symbol.split(":").pop() ?? quote.symbol : quote.symbol;
  return base.replace(/-EQ$/i, "").toUpperCase();
}

function lookupPrice(
  histories: SymbolHistory[],
  symbol: string,
  liveQuotes: LiveQuoteMap = {},
  liveFeedActive = false,
): { ltp: number | null; prevClose: number | null; isLive: boolean } {
  const h = histories.find((s) => s.symbol.toUpperCase() === symbol.toUpperCase());
  const fallback = h?.bars.length
    ? { ltp: h.bars[h.bars.length - 1].close, prevClose: h.bars[h.bars.length - 1].prevClose }
    : { ltp: null, prevClose: null };
  const live = liveFeedActive
    ? liveQuotes[fyersSymbol(symbol)] ?? liveQuotes[symbol] ?? liveQuotes[symbol.toUpperCase()]
    : undefined;
  if (live && Number.isFinite(live.ltp) && live.ltp > 0) {
    return {
      ltp: live.ltp,
      prevClose: live.close > 0 ? live.close : fallback.prevClose,
      isLive: true,
    };
  }
  return { ...fallback, isLive: false };
}

const LIVE_QUOTE_REFRESH_MS = 15_000;
const LIVE_QUOTE_BATCH_SIZE = 50;

function LivePriceHeader({ live }: { live: boolean }) {
  return live ? (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.8)]"
      />
      LTP
    </span>
  ) : (
    "Close"
  );
}

function fmt(n: number | null, decimals = 2): string {
  if (n === null) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPnl(n: number | null): string {
  if (n === null) return "—";
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  return `${sign}₹${abs.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const pnlClass = (n: number | null) =>
  n === null ? "text-muted-foreground" : n >= 0 ? "text-emerald-500" : "text-red-500";

// ─── Modal primitive ──────────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className={`bg-card border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden ${wide ? "max-w-lg" : "max-w-md"}`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
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

function ModalActions({ onCancel, onConfirm, confirmLabel, disabled }: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-2 pt-1">
      <button onClick={onCancel} className="flex-1 py-2 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 active:scale-95 transition-all duration-150">Cancel</button>
      <button onClick={onConfirm} disabled={disabled} className="flex-1 py-2 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 active:scale-95 transition-all duration-150">{confirmLabel}</button>
    </div>
  );
}

// ─── Symbol Autocomplete ──────────────────────────────────────────────────────

function SymbolAutocomplete({ symbols, value, onChange, autoFocus }: {
  symbols: string[];
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toUpperCase();
    if (!q) return [];
    const startsWith = symbols.filter((s) => s.startsWith(q));
    const contains = symbols.filter((s) => !s.startsWith(q) && s.includes(q));
    return [...startsWith, ...contains].slice(0, 12);
  }, [symbols, value]);

  const select = (sym: string) => { onChange(sym); setOpen(false); setCursor(-1); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter" && cursor >= 0) { e.preventDefault(); select(filtered[cursor]); }
    else if (e.key === "Escape") { setOpen(false); setCursor(-1); }
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        className={inputCls}
        value={value}
        onChange={(e) => { onChange(e.target.value.toUpperCase()); setCursor(-1); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        placeholder="Type symbol e.g. RELIANCE"
        autoComplete="off"
        spellCheck={false}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-xl overflow-hidden max-h-52 overflow-y-auto">
          {filtered.map((sym, i) => (
            <button key={sym} type="button" onMouseDown={(e) => { e.preventDefault(); select(sym); }}
              className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors ${i === cursor ? "bg-primary/15 text-primary font-bold" : "text-foreground hover:bg-muted/50"}`}>
              {sym}
            </button>
          ))}
        </div>
      )}
      {symbols.length === 0 && value.length > 0 && (
        <p className="text-[10px] text-amber-500 mt-1">No CSV loaded — type any NSE symbol manually</p>
      )}
    </div>
  );
}

// ─── Dashboard Modals ─────────────────────────────────────────────────────────

function DashboardFormModal({
  title,
  initialName = "",
  initialColor = DASHBOARD_COLORS[0],
  onClose,
  onSave,
}: {
  title: string;
  initialName?: string;
  initialColor?: string;
  onClose: () => void;
  onSave: (name: string, color: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (name.trim()) { onSave(name.trim(), color); onClose(); } } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [name, color, onSave, onClose]);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Dashboard Name">
          <input className={inputCls} placeholder="e.g. Swing Trade Portfolio" value={name}
            onChange={(e) => setName(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Accent Color">
          <div className="flex gap-2 flex-wrap">
            {DASHBOARD_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="w-7 h-7 rounded-full border-2 transition-all"
                style={{
                  backgroundColor: c,
                  borderColor: color === c ? "white" : "transparent",
                  boxShadow: color === c ? `0 0 0 2px ${c}` : "none",
                }}
              />
            ))}
          </div>
        </FormField>
        <ModalActions
          onCancel={onClose}
          onConfirm={() => { if (name.trim()) { onSave(name.trim(), color); onClose(); } }}
          confirmLabel={initialName ? "Save Changes" : "Create Dashboard"}
          disabled={!name.trim()}
        />
      </div>
    </Modal>
  );
}

// ─── Import Confirm Modal ─────────────────────────────────────────────────────

function ImportConfirmModal({
  dashboardNames,
  onClose,
  onConfirm,
}: {
  dashboardNames: string[];
  onClose: () => void;
  onConfirm: (mode: "append" | "replace") => void;
}) {
  return (
    <Modal title="Import Dashboards" onClose={onClose}>
      <div className="space-y-4">
        <div className="bg-muted/30 border border-border/60 rounded-lg px-4 py-3 space-y-1.5">
          <p className="text-xs text-muted-foreground">
            Importing <span className="font-semibold text-foreground">{dashboardNames.length} dashboard{dashboardNames.length !== 1 ? "s" : ""}</span>:
          </p>
          <ul className="space-y-0.5">
            {dashboardNames.map((n) => (
              <li key={n} className="text-xs font-medium text-foreground pl-2 before:content-['·'] before:mr-1.5 before:text-muted-foreground">{n}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">How would you like to import these dashboards?</p>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onConfirm("append")}
            className="flex flex-col items-center gap-1.5 py-3 px-2 border border-border rounded-lg hover:border-primary/60 hover:bg-primary/5 active:scale-95 transition-all duration-150 text-left"
          >
            <span className="text-xs font-semibold text-foreground">Append</span>
            <span className="text-[10px] text-muted-foreground text-center leading-tight">Add alongside existing dashboards</span>
          </button>
          <button
            onClick={() => onConfirm("replace")}
            className="flex flex-col items-center gap-1.5 py-3 px-2 border border-destructive/40 rounded-lg hover:border-destructive hover:bg-destructive/5 active:scale-95 transition-all duration-150 text-left"
          >
            <span className="text-xs font-semibold text-destructive">Replace</span>
            <span className="text-[10px] text-muted-foreground text-center leading-tight">Delete all existing & import fresh</span>
          </button>
        </div>
        <div className="pt-1">
          <button onClick={onClose} className="w-full h-7 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 active:scale-95 transition-all duration-150">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Portfolio Modals ─────────────────────────────────────────────────────────

function AddPortfolioModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string, notes: string) => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (name.trim()) { onSave(name.trim(), notes.trim()); onClose(); } } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [name, notes, onSave, onClose]);
  return (
    <Modal title="New Portfolio" onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Portfolio Name">
          <input className={inputCls} placeholder="e.g. Mahesh's Portfolio" value={name}
            onChange={(e) => setName(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Notes (optional)">
          <textarea className={`${inputCls} resize-none`} placeholder="Any notes..." rows={2}
            value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        <ModalActions onCancel={onClose}
          onConfirm={() => { if (name.trim()) { onSave(name.trim(), notes.trim()); onClose(); } }}
          confirmLabel="Create Portfolio" disabled={!name.trim()} />
      </div>
    </Modal>
  );
}

function EditPortfolioModal({ portfolio, onClose, onSave }: {
  portfolio: ApiPortfolio; onClose: () => void; onSave: (name: string, notes: string) => void;
}) {
  const [name, setName] = useState(portfolio.name);
  const [notes, setNotes] = useState(portfolio.notes ?? "");
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (name.trim()) { onSave(name.trim(), notes.trim()); onClose(); } } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [name, notes, onSave, onClose]);
  return (
    <Modal title="Edit Portfolio" onClose={onClose}>
      <div className="space-y-4">
        <FormField label="Portfolio Name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormField>
        <FormField label="Notes (optional)">
          <textarea className={`${inputCls} resize-none`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
        <ModalActions onCancel={onClose}
          onConfirm={() => { if (name.trim()) { onSave(name.trim(), notes.trim()); onClose(); } }}
          confirmLabel="Save Changes" disabled={!name.trim()} />
      </div>
    </Modal>
  );
}

function AddStockModal({ portfolioName, symbols, onClose, onSave }: {
  portfolioName: string; symbols: string[]; onClose: () => void;
  onSave: (data: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string }) => void;
}) {
  const [symbol, setSymbol] = useState("");
  const [qty, setQty] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [buyDate, setBuyDate] = useState(todayIso());
  const [brokerAccount, setBrokerAccount] = useState("");
  const valid = symbol.trim() && Number(qty) > 0 && Number(buyPrice) > 0 && buyDate;
  return (
    <Modal title={`Add Stock — ${portfolioName}`} onClose={onClose}>
      <div className="space-y-4">
        <FormField label="NSE Symbol">
          <SymbolAutocomplete symbols={symbols} value={symbol} onChange={setSymbol} autoFocus />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Quantity">
            <input className={inputCls} type="text" inputMode="numeric" placeholder="100" value={qty}
              onChange={(e) => setQty(e.target.value)} />
          </FormField>
          <FormField label="Buy Price (₹)">
            <input className={inputCls} type="text" inputMode="decimal" placeholder="0.00" value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Buy Date">
          <input className={inputCls} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
        </FormField>
        <FormField label="Broker Account (optional)">
          <input className={inputCls} type="text" placeholder="e.g. Zerodha, Angel One…" value={brokerAccount}
            onChange={(e) => setBrokerAccount(e.target.value)} />
        </FormField>
        <ModalActions onCancel={onClose}
          onConfirm={() => { if (valid) { onSave({ symbol: symbol.trim(), qty: Number(qty), buy_price: Number(buyPrice), buy_date: buyDate, broker_account: brokerAccount.trim() || undefined }); onClose(); } }}
          confirmLabel="Add Stock" disabled={!valid} />
      </div>
    </Modal>
  );
}

function CopyToPortfoliosModal({
  symbol, qty, defaultBuyPrice, defaultBuyDate, defaultBrokerAccount, otherPortfolios, onClose, onConfirm,
}: {
  symbol: string; qty: number; defaultBuyPrice: number; defaultBuyDate: string; defaultBrokerAccount: string;
  otherPortfolios: ApiPortfolio[];
  onClose: () => void;
  onConfirm: (entries: Array<{ portfolioId: string; qty: number; buyPrice: number; buyDate: string; brokerAccount: string }>) => void;
}) {
  const [rows, setRows] = useState(() =>
    otherPortfolios.map((p) => ({
      portfolioId: p.id,
      name: p.name,
      selected: false,
      qty: String(qty),
      buyPrice: String(defaultBuyPrice),
      buyDate: defaultBuyDate,
      brokerAccount: defaultBrokerAccount,
    }))
  );
  const toggleAll = () => {
    const allSelected = rows.every((r) => r.selected);
    setRows((prev) => prev.map((r) => ({ ...r, selected: !allSelected })));
  };
  const selectedCount = rows.filter((r) => r.selected).length;
  const fieldCls = (disabled: boolean) =>
    `text-xs px-2 py-1 rounded border border-border bg-background text-foreground outline-none focus:ring-1 focus:ring-primary transition${disabled ? " opacity-40 pointer-events-none" : ""}`;
  return (
    <Modal title={`Copy ${symbol} to other portfolios?`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-muted/30 border border-border/60 rounded-lg px-3 py-2 flex items-center gap-2 text-xs">
          <span className="font-semibold text-foreground">{symbol}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{qty} qty</span>
          <span className="ml-auto text-[10px] text-muted-foreground">Qty, price, date &amp; account can differ per portfolio</span>
        </div>
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Select portfolios</span>
          <button onClick={toggleAll} className="text-[10px] text-primary hover:underline">
            {rows.every((r) => r.selected) ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
          {rows.map((row, i) => (
            <div key={row.portfolioId} className={`rounded-lg border px-3 py-2 transition-colors ${row.selected ? "border-primary/50 bg-primary/5" : "border-border bg-muted/10"}`}>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={row.selected}
                  onChange={(e) => setRows((prev) => prev.map((r, j) => j === i ? { ...r, selected: e.target.checked } : r))}
                  className="rounded accent-primary shrink-0"
                />
                <span className="text-xs font-semibold text-foreground flex-1 truncate">{row.name}</span>
              </label>
              {row.selected && (
                <div className="mt-2 grid grid-cols-4 gap-1.5">
                  <input
                    type="text" inputMode="numeric"
                    value={row.qty}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRows((prev) => prev.map((r, j) => j === i ? { ...r, qty: e.target.value } : r))}
                    className={`text-right ${fieldCls(false)}`}
                    placeholder="Qty"
                  />
                  <input
                    type="text" inputMode="decimal"
                    value={row.buyPrice}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRows((prev) => prev.map((r, j) => j === i ? { ...r, buyPrice: e.target.value } : r))}
                    className={`text-right ${fieldCls(false)}`}
                    placeholder="₹ Price"
                  />
                  <input
                    type="date"
                    value={row.buyDate}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRows((prev) => prev.map((r, j) => j === i ? { ...r, buyDate: e.target.value } : r))}
                    className={fieldCls(false)}
                  />
                  <input
                    type="text"
                    value={row.brokerAccount}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRows((prev) => prev.map((r, j) => j === i ? { ...r, brokerAccount: e.target.value } : r))}
                    className={fieldCls(false)}
                    placeholder="Broker"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 h-7 text-xs font-semibold border border-border rounded-lg text-muted-foreground hover:bg-muted/40 active:scale-95 transition-all duration-150">Skip</button>
          <button
            onClick={() => {
              const entries = rows
                .filter((r) => r.selected && Number(r.qty) > 0 && Number(r.buyPrice) > 0 && r.buyDate)
                .map((r) => ({ portfolioId: r.portfolioId, qty: Number(r.qty), buyPrice: Number(r.buyPrice), buyDate: r.buyDate, brokerAccount: r.brokerAccount.trim() }));
              if (entries.length > 0) onConfirm(entries);
            }}
            disabled={selectedCount === 0}
            className="flex-1 h-7 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 active:scale-95 transition-all duration-150"
          >
            {selectedCount > 0 ? `Copy to ${selectedCount} portfolio${selectedCount !== 1 ? "s" : ""}` : "Select portfolios"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditHoldingModal({ holding, symbols, onClose, onSave }: {
  holding: ApiHolding; symbols: string[]; onClose: () => void;
  onSave: (data: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string }) => void;
}) {
  const [symbol, setSymbol] = useState(holding.symbol);
  const [qty, setQty] = useState(String(holding.qty));
  const [buyPrice, setBuyPrice] = useState(String(holding.buy_price));
  const [buyDate, setBuyDate] = useState(holding.buy_date);
  const [brokerAccount, setBrokerAccount] = useState(holding.broker_account ?? "");
  const valid = symbol.trim() && Number(qty) > 0 && Number(buyPrice) > 0 && buyDate;
  return (
    <Modal title={`Edit Holding — ${holding.symbol}`} onClose={onClose}>
      <div className="space-y-4">
        <FormField label="NSE Symbol">
          <SymbolAutocomplete symbols={symbols} value={symbol} onChange={setSymbol} autoFocus />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Quantity">
            <input className={inputCls} type="text" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </FormField>
          <FormField label="Buy Price (₹)">
            <input className={inputCls} type="text" inputMode="decimal" value={buyPrice} onChange={(e) => setBuyPrice(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Buy Date">
          <input className={inputCls} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} />
        </FormField>
        <FormField label="Broker Account (optional)">
          <input className={inputCls} type="text" placeholder="e.g. Zerodha, Angel One…" value={brokerAccount}
            onChange={(e) => setBrokerAccount(e.target.value)} />
        </FormField>
        <ModalActions onCancel={onClose}
          onConfirm={() => { if (valid) { onSave({ symbol: symbol.trim(), qty: Number(qty), buy_price: Number(buyPrice), buy_date: buyDate, broker_account: brokerAccount.trim() || undefined }); onClose(); } }}
          confirmLabel="Save Changes" disabled={!valid} />
      </div>
    </Modal>
  );
}

function SquareOffModal({ holding, onClose, onSave }: {
  holding: ApiHolding; onClose: () => void;
  onSave: (data: { qty_sold: number; sell_price: number; sell_date: string }) => void;
}) {
  const [qtySold, setQtySold] = useState(String(holding.qty));
  const [sellPrice, setSellPrice] = useState("");
  const [sellDate, setSellDate] = useState(todayIso());
  const valid = Number(qtySold) > 0 && Number(qtySold) <= holding.qty && Number(sellPrice) > 0 && sellDate;
  const isFull = Number(qtySold) === holding.qty;
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); if (valid) { onSave({ qty_sold: Number(qtySold), sell_price: Number(sellPrice), sell_date: sellDate }); onClose(); } } };
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, [valid, qtySold, sellPrice, sellDate, onSave, onClose]);
  return (
    <Modal title={`Square Off — ${holding.symbol}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="bg-muted/30 border border-border/60 rounded-lg px-4 py-3 text-xs text-muted-foreground">
          Holding: <span className="font-semibold text-foreground">{holding.qty} qty</span> @ ₹{holding.buy_price} · bought {fmtDate(holding.buy_date)}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Quantity to Sell">
            <input className={inputCls} type="text" inputMode="numeric" value={qtySold}
              onChange={(e) => setQtySold(e.target.value)} autoFocus />
          </FormField>
          <FormField label="Sell Price (₹)">
            <input className={inputCls} type="text" inputMode="decimal" placeholder="0.00" value={sellPrice}
              onChange={(e) => setSellPrice(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Sell Date">
          <input className={inputCls} type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
        </FormField>
        {valid && (
          <div className={`text-xs rounded-lg px-3 py-2 ${isFull ? "bg-muted/30" : "bg-amber-500/10 border border-amber-500/20"}`}>
            {isFull
              ? <span className="text-muted-foreground">Full square off — stock will move to Booked Profit.</span>
              : <span className="text-amber-600 dark:text-amber-400">Partial — {holding.qty - Number(qtySold)} qty will remain in holdings.</span>}
          </div>
        )}
        <ModalActions onCancel={onClose}
          onConfirm={() => { if (valid) { onSave({ qty_sold: Number(qtySold), sell_price: Number(sellPrice), sell_date: sellDate }); onClose(); } }}
          confirmLabel="Confirm Square Off" disabled={!valid} />
      </div>
    </Modal>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  if (status === "partial") return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 whitespace-nowrap">Partial S/O</span>
  );
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">Holding</span>
  );
}

// ─── Account Inline Input ─────────────────────────────────────────────────────

function AccountInlineInput({ initialValue, onSave, onCancel }: {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const firedRef = useRef(false);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  const commit = (v: string) => {
    if (firedRef.current) return;
    firedRef.current = true;
    onSave(v);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => commit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget.value); }
        if (e.key === "Escape") { e.preventDefault(); firedRef.current = true; onCancel(); }
      }}
      placeholder="e.g. Zerodha"
      className="w-24 bg-background border border-primary/40 rounded px-1.5 py-0.5 text-[10px] text-foreground outline-none focus:ring-1 focus:ring-primary/40"
    />
  );
}

// ─── Individual Portfolio Card ────────────────────────────────────────────────

function PortfolioCard({
  portfolio, histories, liveQuotes, liveFeedActive, symbols, otherPortfolios = [], onDelete, onEdited,
}: {
  portfolio: ApiPortfolio; histories: SymbolHistory[]; liveQuotes: LiveQuoteMap; liveFeedActive: boolean; symbols: string[];
  otherPortfolios?: ApiPortfolio[];
  onDelete: () => void; onEdited: () => void;
}) {
  const qc = useQueryClient();
  const [showAddStock, setShowAddStock] = useState(false);
  const [squareOffHolding, setSquareOffHolding] = useState<ApiHolding | null>(null);
  const [editHolding, setEditHolding] = useState<ApiHolding | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [showEditPortfolio, setShowEditPortfolio] = useState(false);
  const [showBooked, setShowBooked] = useState(false);
  const [pendingCopy, setPendingCopy] = useState<{ symbol: string; qty: number; buy_price: number; buy_date: string; broker_account: string } | null>(null);

  const { data: holdings = [], refetch: refetchHoldings } = useQuery({
    queryKey: ["holdings", portfolio.id],
    queryFn: () => apiListHoldings(portfolio.id),
  });
  const { data: booked = [], refetch: refetchBooked } = useQuery({
    queryKey: ["booked", portfolio.id],
    queryFn: () => apiListBookedTrades(portfolio.id),
  });

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["holdings", portfolio.id] });
    qc.invalidateQueries({ queryKey: ["booked", portfolio.id] });
    qc.invalidateQueries({ queryKey: ["allHoldings"] });
    qc.invalidateQueries({ queryKey: ["allBooked"] });
  };

  const addStockMut = useMutation({
    mutationFn: (data: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string }) =>
      apiAddHolding(portfolio.id, data),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ["holdings", portfolio.id] });
      qc.invalidateQueries({ queryKey: ["allHoldings"] });
      if (otherPortfolios.length > 0) {
        setPendingCopy({ ...variables, broker_account: variables.broker_account ?? "" });
      } else {
        toast.success("Stock added");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleCopyToOthers = async (entries: Array<{ portfolioId: string; qty: number; buyPrice: number; buyDate: string; brokerAccount: string }>) => {
    if (!pendingCopy) return;
    const { symbol } = pendingCopy;
    setPendingCopy(null);
    toast.success("Stock added");
    let copied = 0;
    for (const e of entries) {
      try {
        await apiAddHolding(e.portfolioId, { symbol, qty: e.qty, buy_price: e.buyPrice, buy_date: e.buyDate, broker_account: e.brokerAccount || undefined });
        copied++;
      } catch { /* skip failed */ }
    }
    qc.invalidateQueries({ queryKey: ["allHoldings"] });
    if (copied > 0) toast.success(`Also copied ${symbol} to ${copied} portfolio${copied !== 1 ? "s" : ""}`);
  };
  const updateHoldingMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string } }) =>
      apiUpdateHolding(portfolio.id, id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["holdings", portfolio.id] }); qc.invalidateQueries({ queryKey: ["allHoldings"] }); toast.success("Holding updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const holdingsRef = useRef<ApiHolding[]>([]);
  holdingsRef.current = holdings;

  const saveAccountInline = useCallback((holdingId: string, value: string) => {
    setEditingAccountId(null);
    const h = holdingsRef.current.find((x) => x.id === holdingId);
    if (!h) return;
    const trimmed = value.trim();
    if (trimmed === (h.broker_account ?? "")) return;
    updateHoldingMut.mutate({
      id: h.id,
      data: { symbol: h.symbol, qty: h.qty, buy_price: h.buy_price, buy_date: h.buy_date, broker_account: trimmed || undefined },
    });
  }, [updateHoldingMut]);
  const deleteHoldingMut = useMutation({
    mutationFn: (holdingId: string) => apiDeleteHolding(portfolio.id, holdingId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["holdings", portfolio.id] }); qc.invalidateQueries({ queryKey: ["allHoldings"] }); toast.success("Holding removed"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const squareOffMut = useMutation({
    mutationFn: ({ holdingId, data }: { holdingId: string; data: { qty_sold: number; sell_price: number; sell_date: string } }) =>
      apiSquareOff(portfolio.id, holdingId, data),
    onSuccess: (result) => {
      invalidateAll();
      if (result.action === "squaredoff") toast.success("Position fully squared off");
      else toast.success(`Partial square off — ${result.remaining_qty} qty remaining`);
      setShowBooked(true);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const updatePortfolioMut = useMutation({
    mutationFn: (data: { name: string; notes?: string }) => apiUpdatePortfolio(portfolio.id, data),
    onSuccess: () => { onEdited(); toast.success("Portfolio updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const enriched = useMemo(() =>
    holdings.map((h) => {
      const { ltp, prevClose } = lookupPrice(histories, h.symbol, liveQuotes, liveFeedActive);
      const dayPnl = ltp !== null && prevClose !== null ? (ltp - prevClose) * h.qty : null;
      const totalPnl = ltp !== null ? (ltp - h.buy_price) * h.qty : null;
      return { ...h, ltp, prevClose, dayPnl, totalPnl };
    }), [holdings, histories, liveQuotes, liveFeedActive]);

  const todayPnl = enriched.reduce((s, h) => s + (h.dayPnl ?? 0), 0);
  const overallPnl = enriched.reduce((s, h) => s + (h.totalPnl ?? 0), 0);
  const totalBookedPnl = booked.reduce((s, b) => s + b.realized_pnl, 0);
  const refresh = useCallback(() => { refetchHoldings(); refetchBooked(); }, [refetchHoldings, refetchBooked]);

  return (
    <>
      <Card className="shadow-card overflow-hidden">
        <div className="px-3 py-1.5 border-b border-border bg-muted/20 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-sm font-bold text-foreground truncate">{portfolio.name}'s Portfolio</h3>
              <button onClick={() => setShowEditPortfolio(true)} title="Edit portfolio"
                className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0">
                <Pencil className="h-3 w-3" />
              </button>
            </div>
            {portfolio.notes && <p className="text-[10px] text-muted-foreground truncate">{portfolio.notes}</p>}
          </div>
          <div className="flex items-center gap-10 shrink-0">
            <div className="text-right">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Today P&L</div>
              <div className={`text-sm font-bold tabular-nums ${pnlClass(todayPnl)}`}>{fmtPnl(todayPnl)}</div>
            </div>
            <div className="text-right">
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Overall P&L</div>
              <div className={`text-sm font-bold tabular-nums ${pnlClass(overallPnl)}`}>{fmtPnl(overallPnl)}</div>
            </div>
            <div className="flex items-center gap-0.5">
              <button onClick={refresh} title="Refresh" className="text-muted-foreground hover:text-foreground transition-colors p-0.5">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => { if (window.confirm(`Delete "${portfolio.name}" and all its data?`)) onDelete(); }}
                className="text-muted-foreground hover:text-red-500 transition-colors p-0.5" title="Delete portfolio">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left px-3 py-1">Symbol</th>
                <th className="text-right px-3 py-1">Qty</th>
                <th className="text-right px-3 py-1">Buy Price</th>
                 <th className="text-right px-3 py-1"><LivePriceHeader live={liveFeedActive} /></th>
                <th className="text-right px-3 py-1">Day P&L</th>
                <th className="text-right px-3 py-1">Total P&L</th>
                <th className="text-center px-3 py-1">Status</th>
                <th className="text-center px-3 py-1">Account</th>
                <th className="text-center px-3 py-1">Action</th>
              </tr>
            </thead>
            <tbody>
              {enriched.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-3 text-center text-xs text-muted-foreground">No holdings yet. Add a stock to get started.</td></tr>
              )}
              {enriched.map((h, i) => (
                <tr key={h.id} className={`border-t border-border/40 hover:bg-primary/5 transition-colors ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                  <td className="px-3 py-1 font-semibold text-foreground">{h.symbol}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{h.qty}</td>
                  <td className="px-3 py-1 text-right tabular-nums text-muted-foreground">{fmt(h.buy_price)}</td>
                  <td className="px-3 py-1 text-right tabular-nums font-medium text-foreground">{fmt(h.ltp)}</td>
                  <td className={`px-3 py-1 text-right tabular-nums font-bold ${pnlClass(h.dayPnl)}`}>{fmtPnl(h.dayPnl)}</td>
                  <td className={`px-3 py-1 text-right tabular-nums font-bold ${pnlClass(h.totalPnl)}`}>{fmtPnl(h.totalPnl)}</td>
                  <td className="px-3 py-1 text-center"><StatusBadge status={h.status} /></td>
                  <td className="px-3 py-1 text-center text-[10px] text-muted-foreground whitespace-nowrap">
                    {editingAccountId === h.id ? (
                      <AccountInlineInput
                        initialValue={h.broker_account ?? ""}
                        onSave={(val) => saveAccountInline(h.id, val)}
                        onCancel={() => setEditingAccountId(null)}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-foreground rounded px-1 py-0.5 hover:bg-muted/40 transition-colors"
                        title="Click to set broker account"
                        onClick={() => setEditingAccountId(h.id)}
                      >
                        {h.broker_account || <span className="opacity-30">—</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1">
                    <div className="flex items-center justify-center gap-1.5">
                      <button onClick={() => setEditHolding(h)} title="Edit" className="text-muted-foreground hover:text-foreground transition-colors p-0.5"><Pencil className="h-3 w-3" /></button>
                      <button onClick={() => setSquareOffHolding(h)}
                        className="text-[10px] font-semibold px-1.5 py-0 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition whitespace-nowrap">S/O</button>
                      <button onClick={() => { if (window.confirm(`Remove ${h.symbol}?`)) deleteHoldingMut.mutate(h.id); }}
                        className="text-muted-foreground hover:text-red-500 transition-colors p-0.5" title="Delete"><Trash2 className="h-3 w-3" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-3 py-1 border-t border-border/40">
          <button onClick={() => setShowAddStock(true)}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground active:scale-95 transition-all duration-150">
            <Plus className="h-3.5 w-3.5" />Add Stock
          </button>
        </div>

        {booked.length > 0 && (
          <div className="border-t border-border">
            <button onClick={() => setShowBooked((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 bg-muted/20 hover:bg-muted/30 transition-colors">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Booked Profit — {portfolio.name}'s Portfolio</span>
                <span className={`text-xs font-bold tabular-nums ${pnlClass(totalBookedPnl)}`}>{fmtPnl(totalBookedPnl)}</span>
              </div>
              {showBooked ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
            {showBooked && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/20 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left px-3 py-1.5">Symbol</th>
                      <th className="text-right px-3 py-1.5">Qty</th>
                      <th className="text-right px-3 py-1.5">Buy Price</th>
                      <th className="text-right px-3 py-1.5">Sell Price</th>
                      <th className="text-right px-3 py-1.5">Buy Date</th>
                      <th className="text-right px-3 py-1.5">Sell Date</th>
                      <th className="text-right px-3 py-1.5">Days</th>
                      <th className="text-right px-3 py-1.5">Realized P&L</th>
                      <th className="text-right px-3 py-1.5">Return %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {booked.map((b, i) => {
                      const returnPct = ((b.sell_price - b.buy_price) / b.buy_price) * 100;
                      const holdingDays = Math.floor((new Date(b.sell_date).getTime() - new Date(b.buy_date).getTime()) / 86400000);
                      return (
                        <tr key={b.id} className={`border-t border-border/40 hover:bg-primary/5 ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                          <td className="px-3 py-1.5 font-semibold text-foreground">{b.symbol}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{b.qty}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmt(b.buy_price)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmt(b.sell_price)}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtDate(b.buy_date)}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtDate(b.sell_date)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{holdingDays}d</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${pnlClass(b.realized_pnl)}`}>{fmtPnl(b.realized_pnl)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${pnlClass(returnPct)}`}>
                            {returnPct >= 0 ? "+" : ""}{returnPct.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                    <tr className="border-t-2 border-border bg-muted/20">
                      <td colSpan={7} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Total Booked</td>
                      <td className={`px-3 py-1.5 text-right tabular-nums font-bold text-sm ${pnlClass(totalBookedPnl)}`}>{fmtPnl(totalBookedPnl)}</td>
                      <td className="px-3 py-1.5" />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {showAddStock && (
        <AddStockModal portfolioName={portfolio.name} symbols={symbols}
          onClose={() => setShowAddStock(false)} onSave={(data) => addStockMut.mutate(data)} />
      )}
      {editHolding && (
        <EditHoldingModal holding={editHolding} symbols={symbols}
          onClose={() => setEditHolding(null)}
          onSave={(data) => { updateHoldingMut.mutate({ id: editHolding.id, data }); setEditHolding(null); }} />
      )}

      {squareOffHolding && (
        <SquareOffModal holding={squareOffHolding}
          onClose={() => setSquareOffHolding(null)}
          onSave={(data) => { squareOffMut.mutate({ holdingId: squareOffHolding.id, data }); setSquareOffHolding(null); }} />
      )}
      {showEditPortfolio && (
        <EditPortfolioModal portfolio={portfolio}
          onClose={() => setShowEditPortfolio(false)}
          onSave={(name, notes) => { updatePortfolioMut.mutate({ name, notes: notes || undefined }); setShowEditPortfolio(false); }} />
      )}
      {pendingCopy && otherPortfolios.length > 0 && (
        <CopyToPortfoliosModal
          symbol={pendingCopy.symbol}
          qty={pendingCopy.qty}
          defaultBuyPrice={pendingCopy.buy_price}
          defaultBuyDate={pendingCopy.buy_date}
          defaultBrokerAccount={pendingCopy.broker_account}
          otherPortfolios={otherPortfolios}
          onClose={() => { setPendingCopy(null); toast.success("Stock added"); }}
          onConfirm={handleCopyToOthers}
        />
      )}
    </>
  );
}

// ─── All Accounts Panel ────────────────────────────────────────────────────────

function AllAccountsPanel({
  allHoldings,
  histories,
  liveQuotes,
  liveFeedActive,
}: {
  allHoldings: ApiAllHolding[];
  histories: SymbolHistory[];
  liveQuotes: LiveQuoteMap;
  liveFeedActive: boolean;
}) {
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
  const enriched = useMemo(() =>
    allHoldings.map((h) => {
      const { ltp, prevClose } = lookupPrice(histories, h.symbol, liveQuotes, liveFeedActive);
      const dayPnl = ltp !== null && prevClose !== null ? (ltp - prevClose) * h.qty : null;
      return { ...h, ltp, prevClose, dayPnl };
    }), [allHoldings, histories]);
  const totalDayPnl = enriched.reduce((s, h) => s + (h.dayPnl ?? 0), 0);
  return (
    <Card className="shadow-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-muted/20 flex items-center justify-between gap-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">All Account Stocks</h3>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Today's Full P&L</div>
          <div className={`text-sm font-bold tabular-nums ${pnlClass(totalDayPnl)}`}>{fmtPnl(totalDayPnl)}</div>
        </div>
      </div>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="text-[9px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2 sticky top-0 z-10 bg-muted border-b border-border">Symbol</th>
              <th className="text-left px-3 py-2 sticky top-0 z-10 bg-muted border-b border-border">Portfolio</th>
              <th className="text-right px-3 py-2 sticky top-0 z-10 bg-muted border-b border-border">Buy Date</th>
              <th className="text-right px-3 py-2 sticky top-0 z-10 bg-muted border-b border-border">Day P&L</th>
            </tr>
          </thead>
          <tbody>
            {enriched.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-xs text-muted-foreground">No holdings across any portfolio.</td></tr>
            )}
            {enriched.map((h, i) => (
              <tr key={h.id} className={`border-t border-border/40 hover:bg-primary/5 transition-colors ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                <td className="px-4 py-1.5 font-semibold text-foreground">{h.symbol}</td>
                <td className="px-3 py-1.5 text-muted-foreground text-[10px] truncate max-w-[100px]">{h.portfolio_name}</td>
                <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtDate(h.buy_date)}</td>
                <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${pnlClass(h.dayPnl)}`}>{fmtPnl(h.dayPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Total Booked Panel ────────────────────────────────────────────────────────

function TotalBookedPanel({ allBooked }: { allBooked: ApiAllBookedTrade[] }) {
  const total = allBooked.reduce((s, b) => s + b.realized_pnl, 0);
  return (
    <Card className="shadow-card overflow-hidden">
      <div className="px-4 py-3 border-b border-border bg-muted/20">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Total Booked Profit</h3>
        {allBooked.length === 0
          ? <div className="text-xs text-muted-foreground mt-2">No booked trades yet.</div>
          : <div className={`text-xl font-bold tabular-nums mt-1 ${pnlClass(total)}`}>{fmtPnl(total)}</div>}
      </div>
      {allBooked.length > 0 && (
        <div className="overflow-x-auto max-h-[440px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border sticky top-0">
              <tr>
                <th className="text-left px-4 py-2">Symbol</th>
                <th className="text-left px-3 py-2">Portfolio</th>
                <th className="text-right px-3 py-2">Buy</th>
                <th className="text-right px-3 py-2">Sell</th>
                <th className="text-right px-3 py-2">Days</th>
                <th className="text-right px-3 py-2">% P&L</th>
                <th className="text-right px-4 py-2">P&L</th>
              </tr>
            </thead>
            <tbody>
              {allBooked.map((b, i) => {
                const holdingDays = Math.floor((new Date(b.sell_date).getTime() - new Date(b.buy_date).getTime()) / 86400000);
                return (
                  <tr key={b.id} className={`border-t border-border/40 hover:bg-primary/5 ${i % 2 === 0 ? "" : "bg-muted/10"}`}>
                    <td className="px-4 py-1.5 font-semibold text-foreground">{b.symbol}</td>
                    <td className="px-3 py-1.5 text-muted-foreground text-[10px] truncate max-w-[80px]">{b.portfolio_name}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtDate(b.buy_date)}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtDate(b.sell_date)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{holdingDays}d</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${pnlClass(b.realized_pnl)}`}>
                      {b.buy_price > 0 ? `${((b.sell_price - b.buy_price) / b.buy_price * 100) >= 0 ? "+" : ""}${((b.sell_price - b.buy_price) / b.buy_price * 100).toFixed(2)}%` : "—"}
                    </td>
                    <td className={`px-4 py-1.5 text-right tabular-nums font-bold ${pnlClass(b.realized_pnl)}`}>{fmtPnl(b.realized_pnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Layout 2: Cross-Portfolio View ──────────────────────────────────────────

function CrossPortfolioLayout({
  portfolios, allHoldings, allBooked, histories, liveQuotes, liveFeedActive, allSymbols,
}: {
  portfolios: ApiPortfolio[]; allHoldings: ApiAllHolding[]; allBooked: ApiAllBookedTrade[];
  histories: SymbolHistory[]; liveQuotes: LiveQuoteMap; liveFeedActive: boolean; allSymbols: string[];
}) {
  const qc = useQueryClient();
  const [addingToPortfolio, setAddingToPortfolio] = useState<ApiPortfolio | null>(null);
  const [pendingCopy, setPendingCopy] = useState<{ symbol: string; qty: number; buy_price: number; buy_date: string; broker_account: string; fromPortfolioId: string } | null>(null);

  const addStockMut = useMutation({
    mutationFn: ({ portfolioId, data }: { portfolioId: string; data: { symbol: string; qty: number; buy_price: number; buy_date: string; broker_account?: string } }) =>
      apiAddHolding(portfolioId, data),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ["allHoldings"] });
      qc.invalidateQueries({ queryKey: ["holdings"] });
      const others = portfolios.filter((p) => p.id !== variables.portfolioId);
      if (others.length > 0) {
        setPendingCopy({ ...variables.data, broker_account: variables.data.broker_account ?? "", fromPortfolioId: variables.portfolioId });
      } else {
        toast.success("Stock added");
      }
      setAddingToPortfolio(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleCrossLayoutCopyToOthers = async (entries: Array<{ portfolioId: string; qty: number; buyPrice: number; buyDate: string; brokerAccount: string }>) => {
    if (!pendingCopy) return;
    const { symbol } = pendingCopy;
    setPendingCopy(null);
    toast.success("Stock added");
    let copied = 0;
    for (const e of entries) {
      try {
        await apiAddHolding(e.portfolioId, { symbol, qty: e.qty, buy_price: e.buyPrice, buy_date: e.buyDate, broker_account: e.brokerAccount || undefined });
        copied++;
      } catch { /* skip */ }
    }
    qc.invalidateQueries({ queryKey: ["allHoldings"] });
    if (copied > 0) toast.success(`Also copied ${symbol} to ${copied} portfolio${copied !== 1 ? "s" : ""}`);
  };
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });

  const enriched = useMemo(() =>
    allHoldings.map((h) => {
      const { ltp, prevClose } = lookupPrice(histories, h.symbol, liveQuotes, liveFeedActive);
      const dayPnl = ltp !== null && prevClose !== null ? (ltp - prevClose) * h.qty : null;
      const totalPnl = ltp !== null ? (ltp - h.buy_price) * h.qty : null;
      return { ...h, ltp, prevClose, dayPnl, totalPnl };
    }), [allHoldings, histories]);

  const symbols = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const h of enriched) { if (!seen.has(h.symbol)) { seen.add(h.symbol); out.push(h.symbol); } }
    return out;
  }, [enriched]);

  type AggHolding = { qty: number; buy_price: number; ltp: number | null; dayPnl: number | null; totalPnl: number | null; buy_date: string };
  const holdingMap = useMemo(() => {
    const map = new Map<string, Map<string, AggHolding>>();
    for (const h of enriched) {
      if (!map.has(h.symbol)) map.set(h.symbol, new Map());
      const pMap = map.get(h.symbol)!;
      const existing = pMap.get(h.portfolio_id);
      if (existing) {
        const newQty = existing.qty + h.qty;
        pMap.set(h.portfolio_id, { qty: newQty, buy_price: (existing.buy_price * existing.qty + h.buy_price * h.qty) / newQty, ltp: h.ltp, dayPnl: (existing.dayPnl ?? 0) + (h.dayPnl ?? 0), totalPnl: (existing.totalPnl ?? 0) + (h.totalPnl ?? 0), buy_date: existing.buy_date });
      } else {
        pMap.set(h.portfolio_id, { qty: h.qty, buy_price: h.buy_price, ltp: h.ltp, dayPnl: h.dayPnl, totalPnl: h.totalPnl, buy_date: h.buy_date });
      }
    }
    return map;
  }, [enriched]);

  const portfolioTotals = useMemo(() =>
    portfolios.map((p) => {
      let todayPnl = 0; let overallPnl = 0;
      for (const [, pMap] of holdingMap) { const h = pMap.get(p.id); if (h) { todayPnl += h.dayPnl ?? 0; overallPnl += h.totalPnl ?? 0; } }
      return { portfolio: p, todayPnl, overallPnl };
    }), [portfolios, holdingMap]);
  const totalDayPnl = portfolioTotals.reduce((s, p) => s + p.todayPnl, 0);

  type AggBooked = { pnl: number; qty: number; buy_price: number; sell_price: number };
  const bookedSymbols = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const b of allBooked) { if (!seen.has(b.symbol)) { seen.add(b.symbol); out.push(b.symbol); } }
    return out;
  }, [allBooked]);

  const bookedMap = useMemo(() => {
    const map = new Map<string, Map<string, AggBooked>>();
    for (const b of allBooked) {
      if (!map.has(b.symbol)) map.set(b.symbol, new Map());
      const pMap = map.get(b.symbol)!;
      const existing = pMap.get(b.portfolio_id);
      if (existing) {
        pMap.set(b.portfolio_id, { pnl: existing.pnl + b.realized_pnl, qty: existing.qty + b.qty, buy_price: existing.buy_price, sell_price: existing.sell_price });
      } else {
        pMap.set(b.portfolio_id, { pnl: b.realized_pnl, qty: b.qty, buy_price: b.buy_price, sell_price: b.sell_price });
      }
    }
    return map;
  }, [allBooked]);

  const portfolioBookedTotals = useMemo(() =>
    portfolios.map((p) => { let total = 0; for (const [, pMap] of bookedMap) { total += pMap.get(p.id)?.pnl ?? 0; } return { portfolio: p, total }; }),
    [portfolios, bookedMap]);
  const totalBooked = portfolioBookedTotals.reduce((s, p) => s + p.total, 0);

  type MonthTrade = { pnl: number; qty: number; buy_price: number; sell_price: number; buy_date: string; sell_date: string };
  type MonthGroup = { monthKey: string; monthLabel: string; symbols: string[]; tradeMap: Map<string, Map<string, MonthTrade>>; portfolioTotals: Map<string, number> };
  const monthlyGroups = useMemo((): MonthGroup[] => {
    const grouped = new Map<string, MonthGroup & { seenSymbols: Set<string> }>();
    for (const b of allBooked) {
      const d = new Date(b.sell_date);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthLabel = d.toLocaleDateString("en-IN", { month: "short", year: "numeric" }).toUpperCase().replace(" ", " ");
      if (!grouped.has(monthKey)) grouped.set(monthKey, { monthKey, monthLabel, symbols: [], seenSymbols: new Set(), tradeMap: new Map(), portfolioTotals: new Map() });
      const grp = grouped.get(monthKey)!;
      if (!grp.seenSymbols.has(b.symbol)) { grp.seenSymbols.add(b.symbol); grp.symbols.push(b.symbol); }
      if (!grp.tradeMap.has(b.symbol)) grp.tradeMap.set(b.symbol, new Map());
      const pMap = grp.tradeMap.get(b.symbol)!;
      const existing = pMap.get(b.portfolio_id);
      if (existing) {
        pMap.set(b.portfolio_id, { pnl: existing.pnl + b.realized_pnl, qty: existing.qty + b.qty, buy_price: existing.buy_price, sell_price: existing.sell_price, buy_date: existing.buy_date, sell_date: existing.sell_date });
      } else {
        pMap.set(b.portfolio_id, { pnl: b.realized_pnl, qty: b.qty, buy_price: b.buy_price, sell_price: b.sell_price, buy_date: b.buy_date, sell_date: b.sell_date });
      }
      grp.portfolioTotals.set(b.portfolio_id, (grp.portfolioTotals.get(b.portfolio_id) ?? 0) + b.realized_pnl);
    }
    return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([, grp]) => grp);
  }, [allBooked]);

  const totalOverallPnl = portfolioTotals.reduce((s, p) => s + p.overallPnl, 0);
  const fmtN = (n: number | null, d = 1) => n === null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPnlRaw = (n: number | null) => n === null ? "" : Math.round(n).toLocaleString("en-IN");
  const thSub = "text-right px-2 py-1.5 font-semibold text-[9px] uppercase tracking-wide text-muted-foreground whitespace-nowrap border-t border-border/40";
  const tdCell = "px-2 py-1.5 text-right tabular-nums text-[11px] border-t border-border/40";
  const freezeL = "sticky left-0 z-20";
  const freezeLH = "sticky left-0 z-20";

  if (symbols.length === 0 && bookedSymbols.length === 0) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-muted-foreground">
          <p className="text-sm font-medium text-foreground">No holdings yet across any portfolio.</p>
          <p className="text-xs">Use the + button next to each portfolio name to add stocks.</p>
          <div className="flex flex-wrap gap-2 justify-center">
            {portfolios.map((p) => (
              <button key={p.id} onClick={() => setAddingToPortfolio(p)}
                className="flex items-center gap-1.5 text-xs font-semibold border border-border px-3 py-1.5 rounded-lg hover:bg-muted/40 active:scale-95 transition-all duration-150 text-foreground">
                <Plus className="h-3.5 w-3.5" />Add to {p.name}
              </button>
            ))}
          </div>
        </div>
        {addingToPortfolio && (
          <AddStockModal portfolioName={addingToPortfolio.name} symbols={allSymbols}
            onClose={() => setAddingToPortfolio(null)}
            onSave={(data) => addStockMut.mutate({ portfolioId: addingToPortfolio.id, data })} />
        )}
      </>
    );
  }

  return (
    <>
      <Card className="overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <table className="text-xs border-separate border-spacing-0 w-max min-w-full table-fixed">
            <colgroup>
              <col style={{ width: "88px" }} />
              <col style={{ width: "70px" }} />
              <col style={{ width: "70px" }} />
              <col style={{ width: "40px" }} />
              {portfolios.flatMap((_, pi) =>
                [56, 64, 64, 60, 72].map((w, ci) => <col key={`${pi}-${ci}`} style={{ width: `${w}px` }} />)
              )}
            </colgroup>

            <tbody>
              <tr className="border-b border-border/30">
                <th colSpan={4} className="px-3 py-2.5 text-left align-top border-r border-border/60 border-b border-border/30 sticky left-0 z-20 bg-card">
                  <div className="font-bold uppercase tracking-widest text-muted-foreground mb-1.5 text-[14px]">All Accounts Holding</div>
                  <div className="flex gap-10">
                    <div>
                      <div className="text-[8px] uppercase tracking-wide text-[#97a3b4]">Today's P&amp;L</div>
                      <div className={`text-sm font-bold tabular-nums mt-0.5 ${pnlClass(totalDayPnl)}`}>{fmtPnl(totalDayPnl)}</div>
                    </div>
                    <div>
                      <div className="text-[8px] uppercase tracking-wide text-[#97a3b4]">Overall P&amp;L</div>
                      <div className={`text-sm font-bold tabular-nums mt-0.5 ${pnlClass(totalOverallPnl)}`}>{fmtPnl(totalOverallPnl)}</div>
                    </div>
                  </div>
                </th>
                {portfolioTotals.map(({ portfolio, todayPnl, overallPnl }) => (
                  <th key={portfolio.id} colSpan={5} className="px-3 py-2 text-left align-top border-b border-r border-border/50 bg-[#1fb4f91a]">
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <span className="text-sm font-bold text-[#f2f5f8]">{portfolio.name}'s Portfolio</span>
                      <button onClick={() => setAddingToPortfolio(portfolio)} title={`Add stock to ${portfolio.name}`}
                        className="text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded p-0.5 transition-colors shrink-0">
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div className="flex gap-10">
                      <div>
                        <div className="text-[8px] uppercase tracking-wide text-[#97a3b4]">Today's P&amp;L</div>
                        <div className="font-bold tabular-nums mt-0.5 text-emerald-500 text-[13px]">{fmtPnl(todayPnl)}</div>
                      </div>
                      <div>
                        <div className="text-[8px] uppercase tracking-wide text-[#97a3b4]">Overall P&amp;L</div>
                        <div className="font-bold tabular-nums mt-0.5 text-emerald-500 text-[13px]">{fmtPnl(overallPnl)}</div>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
              <tr className="bg-muted/20 border-b border-border">
                <th className={`text-left px-3 py-1.5 text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border ${freezeLH} bg-card whitespace-nowrap`}>Symbol NSE</th>
                <th className="px-2 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border whitespace-nowrap bg-card sticky left-[88px] z-20">Buy Date</th>
                <th className="px-2 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border whitespace-nowrap bg-card sticky left-[158px] z-20">Today</th>
                <th className="px-1.5 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/80 border-b border-border whitespace-nowrap bg-card sticky left-[228px] z-20">Days</th>
                {portfolios.map((p, i) => (
                  <Fragment key={p.id}>
                    <th className={thSub}>Qty</th>
                    <th className={thSub}>Buy</th>
                    <th className={thSub}><LivePriceHeader live={liveFeedActive} /></th>
                    <th className={thSub}>Day P&amp;L</th>
                    <th className={`${thSub} ${i < portfolios.length - 1 ? "border-r border-border/80" : ""}`}>Total P&amp;L</th>
                  </Fragment>
                ))}
              </tr>
            </tbody>
            <tbody>
              {symbols.map((symbol, i) => {
                const pMap = holdingMap.get(symbol);
                const allBuyDates = portfolios.map((p) => pMap?.get(p.id)?.buy_date).filter(Boolean) as string[];
                const earliestBuy = allBuyDates.length > 0 ? [...allBuyDates].sort()[0] : null;
                const rowBg = i % 2 === 0 ? "bg-card" : "bg-muted/10";
                return (
                  <tr key={symbol} className={`border-t border-border/40 hover:bg-primary/5 transition-colors ${i % 2 !== 0 ? "bg-muted/10" : ""}`}>
                    <td className={`px-3 py-1.5 font-semibold text-[11px] text-foreground border-r border-border/60 border-t border-border/40 ${freezeL} bg-card`}>{symbol}</td>
                    <td className="px-2 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/60 border-t border-border/40 whitespace-nowrap sticky left-[88px] z-20 bg-card">{earliestBuy ? fmtDate(earliestBuy) : "—"}</td>
                    <td className="px-2 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/60 border-t border-border/40 whitespace-nowrap sticky left-[158px] z-20 bg-card">{today}</td>
                    <td className="px-1.5 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/80 border-t border-border/40 whitespace-nowrap tabular-nums sticky left-[228px] z-20 bg-card">
                      {earliestBuy ? `${Math.floor((Date.now() - new Date(earliestBuy).getTime()) / 86400000)}d` : "—"}
                    </td>
                    {portfolios.map((p, pi) => {
                      const h = pMap?.get(p.id);
                      return (
                        <Fragment key={p.id}>
                          <td className={`${tdCell} text-muted-foreground`}>{h ? h.qty : ""}</td>
                          <td className={`${tdCell} text-muted-foreground`}>{h ? fmtN(h.buy_price) : ""}</td>
                          <td className={`${tdCell} text-foreground`}>{h ? fmtN(h.ltp) : ""}</td>
                          <td className={`${tdCell} font-semibold ${h ? pnlClass(h.dayPnl) : ""}`}>{h ? fmtPnlRaw(h.dayPnl) : ""}</td>
                          <td className={`${tdCell} font-semibold ${h ? pnlClass(h.totalPnl) : ""} ${pi < portfolios.length - 1 ? "border-r border-border/80" : ""}`}>{h ? fmtPnlRaw(h.totalPnl) : ""}</td>
                        </Fragment>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>

            {bookedSymbols.length > 0 && (
              <>
                <tbody>
                  <tr className="border-t-2 border-border border-b border-border/30">
                    <th colSpan={4} className="px-3 py-2.5 text-left align-top border-r border-border/60 border-t-2 border-border border-b border-border/30 sticky left-0 z-20 bg-card">
                      <div className="font-bold uppercase tracking-widest text-muted-foreground mb-1.5 text-[14px]">Total Booked Profit</div>
                      <div className={`text-sm font-bold tabular-nums ${pnlClass(totalBooked)}`}>{fmtPnl(totalBooked)}</div>
                    </th>
                    {portfolioBookedTotals.map(({ portfolio, total }) => (
                      <th key={portfolio.id} colSpan={5} className="px-3 py-2 text-left align-top border-b border-r border-border/50 bg-[#1fb4f91a]">
                        <div className="font-bold text-foreground mb-1 text-[14px]">{portfolio.name}</div>
                        <div className="font-bold tabular-nums text-emerald-500 text-[13px]">{fmtPnl(total)}</div>
                      </th>
                    ))}
                  </tr>
                  <tr className="bg-muted/20 border-b border-border">
                    <th className={`text-left px-3 py-1.5 text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border ${freezeLH} bg-card whitespace-nowrap`}>Symbol NSE</th>
                    <th className="px-2 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border whitespace-nowrap bg-card sticky left-[88px] z-20">Buy Date</th>
                    <th className="px-2 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/60 border-b border-border whitespace-nowrap bg-card sticky left-[158px] z-20">Sell Date</th>
                    <th className="px-1.5 py-1.5 text-center text-[9px] uppercase tracking-wide text-muted-foreground font-semibold border-r border-border/80 border-b border-border whitespace-nowrap bg-card sticky left-[228px] z-20">Days</th>
                    {portfolios.map((p, i) => (
                      <Fragment key={p.id}>
                        <th className={thSub}>Qty</th>
                        <th className={thSub}>Buy</th>
                        <th className={thSub}>Sell</th>
                        <th className={thSub}>% P&amp;L</th>
                        <th className={`${thSub} ${i < portfolios.length - 1 ? "border-r border-border/80" : ""}`}>P&amp;L</th>
                      </Fragment>
                    ))}
                  </tr>
                </tbody>
                {monthlyGroups.map((grp) => (
                  <tbody key={grp.monthKey}>
                    <tr className="border-t-2 border-border/60 bg-muted/40">
                      <td colSpan={4} className={`px-3 py-1 border-r border-border/60 border-t-2 border-border/60 ${freezeLH} bg-card`}>
                        <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Monthly Profit</span>
                      </td>
                      {portfolios.map((p, i) => {
                        const monthPnl = grp.portfolioTotals.get(p.id);
                        return (
                          <td key={p.id} colSpan={5} className={`px-3 py-1 border-t-2 border-border/60 ${i < portfolios.length - 1 ? "border-r border-border/50" : ""}`}>
                            {monthPnl !== undefined ? (
                              <div className="flex items-center gap-5">
                                <span className="text-[9px] font-bold uppercase tracking-wide text-[#97a3b4]">{grp.monthLabel}</span>
                                <span className="font-bold tabular-nums text-emerald-500 text-[13px]">{fmtPnl(monthPnl)}</span>
                              </div>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                    {grp.symbols.map((symbol, i) => {
                      const pMap = grp.tradeMap.get(symbol);
                      const sample = pMap ? [...pMap.values()][0] : null;
                      const holdingDays = sample ? Math.floor((new Date(sample.sell_date).getTime() - new Date(sample.buy_date).getTime()) / 86400000) : null;
                      const rowBg = i % 2 === 0 ? "bg-card" : "bg-muted/10";
                      return (
                        <tr key={symbol} className={`border-t border-border/40 hover:bg-primary/5 transition-colors ${i % 2 !== 0 ? "bg-muted/10" : ""}`}>
                          <td className={`px-3 py-1.5 font-semibold text-[11px] text-foreground border-r border-border/60 border-t border-border/40 ${freezeL} bg-card`}>{symbol}</td>
                          <td className="px-2 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/60 border-t border-border/40 whitespace-nowrap sticky left-[88px] z-20 bg-card">{sample ? fmtDate(sample.buy_date) : "—"}</td>
                          <td className="px-2 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/60 border-t border-border/40 whitespace-nowrap sticky left-[158px] z-20 bg-card">{sample ? fmtDate(sample.sell_date) : "—"}</td>
                          <td className="px-1.5 py-1.5 text-center text-[11px] text-muted-foreground border-r border-border/80 border-t border-border/40 whitespace-nowrap tabular-nums sticky left-[228px] z-20 bg-card">{holdingDays !== null ? `${holdingDays}d` : "—"}</td>
                          {portfolios.map((p, pi) => {
                            const b = pMap?.get(p.id);
                            return (
                              <Fragment key={p.id}>
                                <td className={`${tdCell} text-muted-foreground`}>{b ? b.qty : ""}</td>
                                <td className={`${tdCell} text-muted-foreground`}>{b ? fmtN(b.buy_price) : ""}</td>
                                <td className={`${tdCell} text-muted-foreground`}>{b ? fmtN(b.sell_price) : ""}</td>
                                <td className={`${tdCell} font-semibold ${b ? pnlClass(b.pnl) : ""}`}>
                                  {b ? `${b.pnl >= 0 ? "+" : ""}${(((b.sell_price - b.buy_price) / b.buy_price) * 100).toFixed(0)}%` : ""}
                                </td>
                                <td className={`${tdCell} font-semibold ${b ? pnlClass(b.pnl) : ""} ${pi < portfolios.length - 1 ? "border-r border-border/80" : ""}`}>
                                  {b ? Math.round(b.pnl).toLocaleString("en-IN") : ""}
                                </td>
                              </Fragment>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </>
            )}
          </table>
        </div>
      </Card>
      {addingToPortfolio && (
        <AddStockModal portfolioName={addingToPortfolio.name} symbols={allSymbols}
          onClose={() => setAddingToPortfolio(null)}
          onSave={(data) => addStockMut.mutate({ portfolioId: addingToPortfolio.id, data })} />
      )}
      {pendingCopy && (
        <CopyToPortfoliosModal
          symbol={pendingCopy.symbol}
          qty={pendingCopy.qty}
          defaultBuyPrice={pendingCopy.buy_price}
          defaultBuyDate={pendingCopy.buy_date}
          defaultBrokerAccount={pendingCopy.broker_account}
          otherPortfolios={portfolios.filter((p) => p.id !== pendingCopy.fromPortfolioId)}
          onClose={() => { setPendingCopy(null); toast.success("Stock added"); }}
          onConfirm={handleCrossLayoutCopyToOthers}
        />
      )}
    </>
  );
}

// ─── Dashboard Detail View (portfolio management inside a dashboard) ───────────

function DashboardDetailView({ dashboard, onBack }: { dashboard: ApiDashboard; onBack: () => void }) {
  const { histories, categories } = useData();
  const qc = useQueryClient();
  const [layout, setLayout] = useState<1 | 2>(2);
  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [liveQuotes, setLiveQuotes] = useState<LiveQuoteMap>({});
  const [liveFeedActive, setLiveFeedActive] = useState(false);

  const { data: portfolios = [], isLoading, refetch } = useQuery({
    queryKey: ["portfolios", dashboard.id],
    queryFn: () => apiListPortfolios(dashboard.id),
  });
  const { data: allHoldings = [] } = useQuery({
    queryKey: ["allHoldings", dashboard.id],
    queryFn: () => apiListAllHoldings(dashboard.id),
    refetchInterval: 60_000,
  });
  const { data: allBooked = [] } = useQuery({
    queryKey: ["allBooked", dashboard.id],
    queryFn: () => apiListAllBookedTrades(dashboard.id),
  });

  const holdingSymbols = useMemo(
    () => [...new Set(allHoldings.map((holding) => holding.symbol.toUpperCase()))],
    [allHoldings],
  );

  useEffect(() => {
    let cancelled = false;

    const refreshLivePrices = async () => {
      try {
        const status = await apiGetSchedulerStatus();
        const feedActive = status.liveFeed.marketOpenNow && status.liveFeed.connected;

        if (!feedActive || holdingSymbols.length === 0) {
          if (!cancelled) {
            setLiveFeedActive(false);
            setLiveQuotes({});
          }
          return;
        }

        const nextQuotes: LiveQuoteMap = {};
        for (let i = 0; i < holdingSymbols.length; i += LIVE_QUOTE_BATCH_SIZE) {
          const batch = holdingSymbols.slice(i, i + LIVE_QUOTE_BATCH_SIZE);
          const response = await apiGetMarketQuotes(batch.map(fyersSymbol));
          for (const quote of response.quotes) {
            nextQuotes[quote.symbol] = quote;
            nextQuotes[quote.symbol.toUpperCase()] = quote;
            nextQuotes[quoteTicker(quote)] = quote;
          }
        }

        if (!cancelled) {
          setLiveFeedActive(true);
          setLiveQuotes(nextQuotes);
        }
      } catch {
        // Unknown or unavailable live-feed state safely falls back to Close.
        if (!cancelled) {
          setLiveFeedActive(false);
          setLiveQuotes({});
        }
      }
    };

    void refreshLivePrices();
    const interval = window.setInterval(() => {
      void refreshLivePrices();
    }, LIVE_QUOTE_REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [holdingSymbols]);

  const symbols = useMemo(() => {
    if (histories.length > 0) return [...new Set(histories.map((h) => h.symbol.toUpperCase()))].sort();
    return [...new Set(categories.flatMap((c) => c.symbols.map((s) => s.toUpperCase())))].sort();
  }, [histories, categories]);

  const createPortfolioMut = useMutation({
    mutationFn: (data: { name: string; notes?: string }) =>
      apiCreatePortfolio({ ...data, dashboard_id: dashboard.id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolios", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Portfolio created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deletePortfolioMut = useMutation({
    mutationFn: (id: string) => apiDeletePortfolio(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolios", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["allHoldings", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["allBooked", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Portfolio deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hasData = histories.length > 0 || categories.length > 0;

  return (
    <div className="min-h-screen bg-background">
      <main className="container py-2 space-y-3">
        {/* Page title bar */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Dashboards</span>
            </button>
            <div className="w-px h-4 bg-border shrink-0" />
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: dashboard.color }} />
              <h1 className="text-base font-bold tracking-tight text-foreground truncate">{dashboard.name}</h1>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!hasData && (
              <span className="hidden sm:inline text-[10px] text-amber-500 bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-500/20">
                Load CSV for live prices
              </span>
            )}
            <div className="flex items-center border border-border rounded-lg overflow-hidden">
              <button onClick={() => setLayout(2)}
                className={`text-[10px] font-semibold px-2.5 py-1.5 transition-colors ${layout === 2 ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/40"}`}>
                Layout 1
              </button>
              <button onClick={() => setLayout(1)}
                className={`text-[10px] font-semibold px-2.5 py-1.5 border-l border-border transition-colors ${layout === 1 ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted/40"}`}>
                Layout 2
              </button>
            </div>
            <button onClick={() => refetch()} className="text-muted-foreground hover:text-foreground transition-colors p-1.5" title="Refresh">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowAddPortfolio(true)}
              className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground h-7 px-3 rounded-lg hover:bg-primary/90 active:scale-95 transition-all duration-150">
              <Plus className="h-3.5 w-3.5" />Add Portfolio
            </button>
          </div>
        </div>
        {isLoading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">Loading portfolios…</div>
        )}
        {!isLoading && portfolios.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 space-y-4">
            <Briefcase className="h-12 w-12 text-muted-foreground/30" />
            <div className="text-center">
              <p className="text-sm font-semibold text-foreground">No portfolios yet</p>
              <p className="text-xs text-muted-foreground mt-1">Create a portfolio to start tracking holdings in this dashboard.</p>
            </div>
            <button onClick={() => setShowAddPortfolio(true)}
              className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground h-7 px-3 rounded-lg hover:bg-primary/90 active:scale-95 transition-all duration-150">
              <Plus className="h-3.5 w-3.5" />Create Portfolio
            </button>
          </div>
        )}
        {!isLoading && portfolios.length > 0 && (
          <>
            {layout === 1 && (
              <>
                <div className="space-y-2">
                  {portfolios.map((p) => (
                      <PortfolioCard key={p.id} portfolio={p} histories={histories} liveQuotes={liveQuotes} liveFeedActive={liveFeedActive} symbols={symbols}
                      otherPortfolios={portfolios.filter((x) => x.id !== p.id)}
                      onDelete={() => deletePortfolioMut.mutate(p.id)}
                      onEdited={() => qc.invalidateQueries({ queryKey: ["portfolios", dashboard.id] })} />
                  ))}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                  <div><AllAccountsPanel allHoldings={allHoldings} histories={histories} liveQuotes={liveQuotes} liveFeedActive={liveFeedActive} /></div>
                  <div className="lg:col-span-2"><TotalBookedPanel allBooked={allBooked} /></div>
                </div>
              </>
            )}
            {layout === 2 && (
              <CrossPortfolioLayout portfolios={portfolios} allHoldings={allHoldings} allBooked={allBooked}
                histories={histories} liveQuotes={liveQuotes} liveFeedActive={liveFeedActive} allSymbols={symbols} />
            )}
          </>
        )}
      </main>

      {showAddPortfolio && (
        <AddPortfolioModal onClose={() => setShowAddPortfolio(false)}
          onSave={(name, notes) => createPortfolioMut.mutate({ name, notes: notes || undefined })} />
      )}
    </div>
  );
}

// ─── Dashboard List View (landing page) ──────────────────────────────────────

function DashboardListView({ onOpen }: { onOpen: (d: ApiDashboard) => void }) {
  const qc = useQueryClient();
  const { histories } = useData();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editDashboard, setEditDashboard] = useState<ApiDashboard | null>(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pendingImport, setPendingImport] = useState<{
    dashboards: Array<{ name: string; color: string; portfolios: ImportPortfolioPayload["portfolios"] }>;
    names: string[];
  } | null>(null);

  const { data: dashboards = [], isLoading } = useQuery({
    queryKey: ["dashboards"],
    queryFn: apiListDashboards,
  });

  const createMut = useMutation({
    mutationFn: apiCreateDashboard,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboards"] }); toast.success("Dashboard created"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; color?: string }) => apiUpdateDashboard(id, body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["dashboards"] }); toast.success("Dashboard updated"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: apiDeleteDashboard,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      qc.invalidateQueries({ queryKey: ["portfolios"] });
      toast.success("Dashboard deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleExport = async () => {
    if (dashboards.length === 0) { toast.error("No dashboards to export"); return; }
    setExporting(true);
    try {
      const exported = await Promise.all(
        dashboards.map(async (d) => {
          const portfolios = await apiListPortfolios(d.id);
          const portfolioData = await Promise.all(
            portfolios.map(async (p) => {
              const [holdings, bookedTrades] = await Promise.all([
                apiListHoldings(p.id).catch(() => []),
                apiListBookedTrades(p.id).catch(() => []),
              ]);
              return {
                name: p.name,
                notes: p.notes ?? undefined,
                holdings: holdings.map(({ symbol, qty, buy_price, buy_date, broker_account, status }) => ({ symbol, qty, buy_price, buy_date, broker_account, status })),
                booked_trades: bookedTrades.map(({ symbol, qty, buy_price, sell_price, buy_date, sell_date, realized_pnl }) => ({ symbol, qty, buy_price, sell_price, buy_date, sell_date, realized_pnl })),
              };
            })
          );
          return { name: d.name, color: d.color, portfolios: portfolioData };
        })
      );
      const payload = { version: 2, exported_at: new Date().toISOString(), dashboards: exported };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bharatscan-dashboards-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${exported.length} dashboard${exported.length !== 1 ? "s" : ""}`);
    } catch { toast.error("Export failed"); }
    finally { setExporting(false); }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        // Full app backup format (Settings → Backup/Restore): dashboards and
        // portfolios are separate top-level arrays, portfolios reference their
        // dashboard via dashboard_id rather than being nested inside it.
        if (
          json.version === 2 &&
          Array.isArray(json.dashboards) &&
          Array.isArray(json.portfolios) &&
          ("scans" in json || "settings" in json)
        ) {
          const portfoliosByDashboard = new Map<string, ImportPortfolioPayload["portfolios"]>();
          const unassigned: ImportPortfolioPayload["portfolios"] = [];
          for (const p of json.portfolios as Array<{
            dashboard_id?: string | null;
            name: string;
            notes?: string;
            holdings?: ImportPortfolioPayload["portfolios"][number]["holdings"];
            booked_trades?: ImportPortfolioPayload["portfolios"][number]["booked_trades"];
          }>) {
            const entry = { name: p.name, notes: p.notes, holdings: p.holdings ?? [], booked_trades: p.booked_trades ?? [] };
            if (p.dashboard_id) {
              if (!portfoliosByDashboard.has(p.dashboard_id)) portfoliosByDashboard.set(p.dashboard_id, []);
              portfoliosByDashboard.get(p.dashboard_id)!.push(entry);
            } else {
              unassigned.push(entry);
            }
          }
          const rebuiltDashboards = (json.dashboards as Array<{ id: string; name?: string; color?: string }>).map((d) => ({
            name: d.name ?? "Unnamed",
            color: d.color ?? DASHBOARD_COLORS[0],
            portfolios: portfoliosByDashboard.get(d.id) ?? [],
          }));
          if (unassigned.length > 0) {
            rebuiltDashboards.push({
              name: `Imported Portfolios ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}`,
              color: DASHBOARD_COLORS[2],
              portfolios: unassigned,
            });
          }
          if (rebuiltDashboards.length === 0 || rebuiltDashboards.every((d) => d.portfolios.length === 0)) {
            toast.error("No portfolios found in backup file");
            return;
          }
          setPendingImport({
            dashboards: rebuiltDashboards,
            names: rebuiltDashboards.map((d) => d.name),
          });
        } else if (json.version === 2 && Array.isArray(json.dashboards) && json.dashboards.length > 0) {
          setPendingImport({
            dashboards: json.dashboards,
            names: json.dashboards.map((d: { name?: string }) => d.name ?? "Unnamed"),
          });
        } else if (Array.isArray(json.portfolios) && json.portfolios.length > 0) {
          // v1 format: wrap in a single "Imported Portfolios" dashboard
          const name = `Imported Portfolios ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" })}`;
          setPendingImport({
            dashboards: [{ name, color: DASHBOARD_COLORS[2], portfolios: json.portfolios }],
            names: [name],
          });
        } else {
          toast.error("Invalid file — no dashboards or portfolios found");
        }
      } catch { toast.error("Invalid JSON file"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImportConfirm = async (mode: "append" | "replace") => {
    if (!pendingImport) return;
    setImporting(true);
    setPendingImport(null);
    try {
      if (mode === "replace") {
        for (const d of dashboards) {
          await apiDeleteDashboard(d.id);
        }
      }
      let totalImported = 0;
      for (const d of pendingImport.dashboards) {
        const created = await apiCreateDashboard({ name: d.name, color: d.color ?? DASHBOARD_COLORS[0] });
        if (d.portfolios?.length > 0) {
          const result = await apiImportPortfolios({ portfolios: d.portfolios, dashboard_id: created.id });
          totalImported += result.imported;
        }
      }
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      qc.invalidateQueries({ queryKey: ["portfolios"] });
      toast.success(`${mode === "replace" ? "Replaced" : "Imported"} ${pendingImport.dashboards.length} dashboard${pendingImport.dashboards.length !== 1 ? "s" : ""} with ${totalImported} portfolio${totalImported !== 1 ? "s" : ""}`);
    } catch (e: unknown) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="container py-6">
        {/* Page title bar */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-4 w-4 text-muted-foreground" />
            <div>
              <h1 className="text-base font-bold tracking-tight text-foreground">Portfolio Dashboards</h1>
              <p className="text-[10px] text-muted-foreground">
                {isLoading ? "Loading…" : `${dashboards.length} dashboard${dashboards.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleExport} disabled={exporting || dashboards.length === 0}
              className="flex items-center gap-1.5 text-xs font-semibold border border-border text-muted-foreground px-3 py-1.5 rounded-lg hover:bg-muted/40 disabled:opacity-40 active:scale-95 transition-all duration-150">
              <Download className="h-3.5 w-3.5" />
              {exporting ? "Exporting…" : "Export All"}
            </button>
            <button onClick={() => importInputRef.current?.click()} disabled={importing}
              className="flex items-center gap-1.5 text-xs font-semibold border border-border text-muted-foreground px-3 py-1.5 rounded-lg hover:bg-muted/40 disabled:opacity-40 active:scale-95 transition-all duration-150">
              <Upload className="h-3.5 w-3.5" />
              {importing ? "Importing…" : "Import"}
            </button>
            <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 active:scale-95 transition-all duration-150">
              <Plus className="h-3.5 w-3.5" />Create new Dashboard
            </button>
          </div>
        </div>
        {isLoading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">Loading dashboards…</div>
        )}

        {!isLoading && dashboards.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 space-y-4">
            <LayoutGrid className="h-14 w-14 text-muted-foreground/20" />
            <div className="text-center">
              <p className="text-sm font-semibold text-foreground">No dashboards yet</p>
              <p className="text-xs text-muted-foreground mt-1">Create a dashboard to start organising your portfolios.</p>
            </div>
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 active:scale-95 transition-all duration-150">
              <Plus className="h-3.5 w-3.5" />Create new Dashboard
            </button>
          </div>
        )}

        {!isLoading && dashboards.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {dashboards.map((d) => (
              <DashboardCard
                key={d.id}
                dashboard={d}
                histories={histories}
                onClick={() => onOpen(d)}
                onEdit={() => setEditDashboard(d)}
                onDelete={() => {
                  if (window.confirm(`Delete "${d.name}" and all its portfolios? This cannot be undone.`)) {
                    deleteMut.mutate(d.id);
                  }
                }}
              />
            ))}
            {/* Create new card */}
            <button
              onClick={() => setShowCreate(true)}
              className="rounded-xl border border-dashed border-border/60 bg-transparent p-5 text-left transition-all hover:border-primary/40 hover:bg-primary/5 active:scale-95 group flex flex-col items-center justify-center gap-2 min-h-[120px]"
            >
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Plus className="h-4 w-4 text-primary" />
              </div>
              <span className="text-xs font-semibold text-muted-foreground group-hover:text-foreground transition-colors">New Dashboard</span>
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <DashboardFormModal
          title="Create Dashboard"
          onClose={() => setShowCreate(false)}
          onSave={(name, color) => createMut.mutate({ name, color })}
        />
      )}
      {editDashboard && (
        <DashboardFormModal
          title="Edit Dashboard"
          initialName={editDashboard.name}
          initialColor={editDashboard.color}
          onClose={() => setEditDashboard(null)}
          onSave={(name, color) => { updateMut.mutate({ id: editDashboard.id, name, color }); setEditDashboard(null); }}
        />
      )}
      {pendingImport && (
        <ImportConfirmModal
          dashboardNames={pendingImport.names}
          onClose={() => setPendingImport(null)}
          onConfirm={handleImportConfirm}
        />
      )}
    </div>
  );
}

// ─── Dashboard Card ────────────────────────────────────────────────────────────

function DashboardCard({
  dashboard, histories, onClick, onEdit, onDelete,
}: {
  dashboard: ApiDashboard;
  histories: SymbolHistory[];
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [pnlVisible, setPnlVisible] = useState<boolean>(() => {
    try { return localStorage.getItem(`pnl_visible_${dashboard.id}`) !== "false"; }
    catch { return true; }
  });

  const togglePnl = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !pnlVisible;
    setPnlVisible(next);
    try { localStorage.setItem(`pnl_visible_${dashboard.id}`, String(next)); } catch {}
  };

  const { data: allHoldings = [] } = useQuery({
    queryKey: ["dashboardCardHoldings", dashboard.id],
    queryFn: () => apiListAllHoldings(dashboard.id),
    enabled: dashboard.holdings_count > 0,
    staleTime: 60_000,
  });

  const { todayPnl, overallPnl, hasData } = useMemo(() => {
    const safeHistories = histories ?? [];
    if (allHoldings.length === 0 || safeHistories.length === 0) return { todayPnl: 0, overallPnl: 0, hasData: false };
    let tpnl = 0; let opnl = 0; let anyPrice = false;
    for (const h of allHoldings) {
      const { ltp, prevClose } = lookupPrice(safeHistories, h.symbol);
      if (ltp !== null) {
        anyPrice = true;
        if (prevClose !== null) tpnl += (ltp - prevClose) * h.qty;
        opnl += (ltp - h.buy_price) * h.qty;
      }
    }
    return { todayPnl: tpnl, overallPnl: opnl, hasData: anyPrice };
  }, [allHoldings, histories]);

  return (
    <div
      onClick={onClick}
      className="relative cursor-pointer rounded-xl border border-border/60 bg-card/60 p-5 transition-all duration-150 hover:shadow-lg hover:bg-card/90 hover:border-border group select-none"
      style={{ borderLeftColor: dashboard.color, borderLeftWidth: "3px" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-foreground truncate leading-snug">{dashboard.name}</h3>
          <div className="flex items-center gap-3 mt-2">
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Briefcase className="h-3 w-3" />
              {dashboard.portfolio_count} portfolio{dashboard.portfolio_count !== 1 ? "s" : ""}
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <LayoutGrid className="h-3 w-3" />
              {dashboard.holdings_count} holding{dashboard.holdings_count !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            title="Edit dashboard"
          >
            <Pencil size={12} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
            title="Delete dashboard"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* P&L Summary Row */}
      <div className="mt-3 pt-2.5 border-t border-border/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-4 min-w-0">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold whitespace-nowrap">Today's P&L</div>
            {pnlVisible ? (
              <div className={`text-[11px] font-bold tabular-nums leading-tight ${hasData ? pnlClass(todayPnl) : "text-muted-foreground/40"}`}>
                {hasData ? fmtPnl(todayPnl) : "—"}
              </div>
            ) : (
              <div className="text-[11px] font-bold text-muted-foreground/30 leading-tight tracking-widest">••••••</div>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold whitespace-nowrap">Overall P&L</div>
            {pnlVisible ? (
              <div className={`text-[11px] font-bold tabular-nums leading-tight ${hasData ? pnlClass(overallPnl) : "text-muted-foreground/40"}`}>
                {hasData ? fmtPnl(overallPnl) : "—"}
              </div>
            ) : (
              <div className="text-[11px] font-bold text-muted-foreground/30 leading-tight tracking-widest">••••••</div>
            )}
          </div>
        </div>
        <button
          onClick={togglePnl}
          className={`p-1.5 rounded-md transition-colors shrink-0 ${
            pnlVisible
              ? "text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20"
              : "text-muted-foreground/40 bg-muted/20 hover:text-muted-foreground hover:bg-muted/40"
          }`}
          title={pnlVisible ? "Hide P&L" : "Show P&L"}
        >
          {pnlVisible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
    </div>
  );
}

// ─── Main Portfolio Page ──────────────────────────────────────────────────────

export default function Portfolio() {
  const [activeDashboard, setActiveDashboard] = useState<ApiDashboard | null>(null);

  if (activeDashboard) {
    return (
      <DashboardDetailView
        dashboard={activeDashboard}
        onBack={() => setActiveDashboard(null)}
      />
    );
  }

  return <DashboardListView onOpen={setActiveDashboard} />;
}
