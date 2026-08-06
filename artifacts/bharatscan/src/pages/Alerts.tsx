import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Bell, BellOff, Plus, Trash2, Zap, Clock, CheckCircle2, XCircle,
  Loader2, Play, PlayCircle, AlertCircle, Edit2, TrendingUp, TrendingDown,
  ArrowUpDown, ArrowUp, ArrowDown, Download, FolderInput,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiListAlerts, apiCreateAlert, apiUpdateAlert, apiDeleteAlert,
  apiToggleAlert, apiListAlertHistory, apiRecordAlertTrigger, apiMarkAlertChecked,
  type ApiAlert, type ApiAlertTrigger, type AlertConditionType,
} from "@/lib/api";
import { useData } from "@/context/DataContext";
import { toast } from "sonner";

// ── Condition helpers ──────────────────────────────────────────────────────────

const CONDITIONS: { value: AlertConditionType; label: string; short: string; icon: typeof TrendingUp }[] = [
  { value: "crosses_above", label: "Price crosses above", short: "Crosses ↑", icon: TrendingUp },
  { value: "crosses_below", label: "Price crosses below", short: "Crosses ↓", icon: TrendingDown },
  { value: "greater_than",  label: "Price is above",     short: "Above",     icon: ArrowUp },
  { value: "less_than",     label: "Price is below",     short: "Below",     icon: ArrowDown },
];

function conditionLabel(type: AlertConditionType): string {
  return CONDITIONS.find(c => c.value === type)?.label ?? type;
}

function conditionCheck(
  type: AlertConditionType,
  lastClose: number,
  prevClose: number | null,
  target: number
): boolean {
  switch (type) {
    case "crosses_above":
      return lastClose > target && (prevClose === null || prevClose <= target);
    case "crosses_below":
      return lastClose < target && (prevClose === null || prevClose >= target);
    case "greater_than":
      return lastClose > target;
    case "less_than":
      return lastClose < target;
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function isToday(iso: string) {
  const d = new Date(iso); const n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

function pctAway(current: number, target: number): string {
  const pct = ((current - target) / target) * 100;
  return (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
}

function priorityBadge(p: string, side: "buy" | "sell" = "sell") {
  if (side === "buy") {
    if (p === "high")   return "bg-success/15 text-success border border-success/30";
    if (p === "medium") return "bg-primary/15 text-primary border border-primary/30";
    return "bg-muted text-muted-foreground border border-border/40";
  }
  if (p === "high")   return "bg-destructive-bright/15 text-destructive-bright border border-destructive-bright/30";
  if (p === "medium") return "bg-orange-400/15 text-orange-400 border border-orange-400/30";
  return "bg-muted text-muted-foreground border border-border/40";
}

// ── Form ───────────────────────────────────────────────────────────────────────

interface AlertForm {
  symbol: string;
  condition_type: AlertConditionType;
  target_price: string;
  priority: "high" | "medium" | "low";
  side: "buy" | "sell";
  note: string;
}

function emptyForm(): AlertForm {
  return { symbol: "", condition_type: "crosses_above", target_price: "", priority: "medium", side: "buy", note: "" };
}

function formFromAlert(a: ApiAlert): AlertForm {
  return {
    symbol: a.symbol,
    condition_type: a.condition_type,
    target_price: String(a.target_price),
    priority: a.priority,
    side: a.side ?? "buy",
    note: a.note,
  };
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Alerts() {
  const { histories } = useData();

  const [alerts, setAlerts]   = useState<ApiAlert[]>([]);
  const [history, setHistory] = useState<ApiAlertTrigger[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen]       = useState(false);
  const [editingAlert, setEditingAlert]   = useState<ApiAlert | null>(null);
  const [form, setForm]                   = useState<AlertForm>(emptyForm());
  const [saving, setSaving]               = useState(false);

  const [deleteTarget, setDeleteTarget]   = useState<ApiAlert | null>(null);
  const [deleting, setDeleting]           = useState(false);

  const [runningId, setRunningId]         = useState<string | null>(null);
  const [runningAll, setRunningAll]       = useState(false);
  const [liveResults, setLiveResults]     = useState<Record<string, { price: number; fired: boolean } | null>>({});

  // ── Import / Export ───────────────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  type ImportPayload = Pick<ApiAlert, "symbol" | "condition_type" | "target_price" | "note" | "priority" | "side" | "status">;
  const [importPending, setImportPending] = useState<ImportPayload[] | null>(null);
  const [importing, setImporting]         = useState(false);

  // ── Build a map: symbol → { last close, prev close } from loaded data ────────
  // Prefer EQ series over BE/BZ/SM etc. — NSE bhavcopy contains duplicate rows
  // for the same symbol in different series, and non-EQ prices can be wrong.
  const priceMap = useMemo(() => {
    const m = new Map<string, { last: number; prev: number | null; series: string; lastDate: string }>();
    for (const h of histories) {
      const bars = h.bars;
      if (!bars.length) continue;
      const series   = h.series ?? "EQ";
      const lastDate = bars[bars.length - 1].date;
      const existing = m.get(h.symbol);
      if (existing) {
        const existingIsEq = existing.series === "EQ";
        const thisIsEq     = series === "EQ";
        if (existingIsEq && !thisIsEq) continue;           // keep EQ, skip non-EQ
        if (!existingIsEq && !thisIsEq && existing.lastDate >= lastDate) continue; // keep newer non-EQ
        if (existingIsEq  && thisIsEq  && existing.lastDate >= lastDate) continue; // keep newer EQ
      }
      const last = bars[bars.length - 1].close;
      const prev = bars.length > 1 ? bars[bars.length - 2].close : null;
      m.set(h.symbol, { last, prev, series, lastDate });
    }
    return m;
  }, [histories]);

  // ── All known symbols for autocomplete ───────────────────────────────────────
  const allSymbols = useMemo(() => Array.from(priceMap.keys()).sort(), [priceMap]);

  // ── Load alerts + history ────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([apiListAlerts(), apiListAlertHistory()]);
      setAlerts(a);
      setHistory(h);
    } catch {
      toast.error("Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Evaluate a single alert ──────────────────────────────────────────────────
  const evaluateOne = useCallback(async (alert: ApiAlert): Promise<boolean> => {
    const prices = priceMap.get(alert.symbol);
    if (!prices) return false;
    const fired = conditionCheck(alert.condition_type, prices.last, prices.prev, alert.target_price);
    setLiveResults(r => ({ ...r, [alert.id]: { price: prices.last, fired } }));
    if (fired) {
      await apiRecordAlertTrigger(alert.id, prices.last);
    } else {
      await apiMarkAlertChecked(alert.id, prices.last);
    }
    return fired;
  }, [priceMap]);

  // ── Run single alert ─────────────────────────────────────────────────────────
  const runAlert = useCallback(async (alert: ApiAlert) => {
    if (!histories.length) { toast.error("No data loaded — upload a bhavcopy CSV first"); return; }
    const prices = priceMap.get(alert.symbol);
    if (!prices) { toast.error(`${alert.symbol} not found in loaded data`); return; }
    setRunningId(alert.id);
    try {
      const fired = await evaluateOne(alert);
      await refresh();
      if (fired) {
        toast.success(`🔔 ${alert.symbol} — ${conditionLabel(alert.condition_type)} ₹${fmt(alert.target_price)} (at ₹${fmt(prices.last)})`);
      } else {
        toast.info(`${alert.symbol} — no trigger. Current price: ₹${fmt(prices.last)}, target: ₹${fmt(alert.target_price)}`);
      }
    } catch {
      toast.error("Failed to run alert");
    } finally {
      setRunningId(null);
    }
  }, [priceMap, histories.length, evaluateOne, refresh]);

  // ── Run all active alerts ────────────────────────────────────────────────────
  const runAllAlerts = useCallback(async () => {
    if (!histories.length) { toast.error("No data loaded — upload a bhavcopy CSV first"); return; }
    const active = alerts.filter(a => a.status === "active");
    if (!active.length) { toast.info("No active alerts to run"); return; }
    setRunningAll(true);
    let fired = 0; let notFound = 0;
    for (const alert of active) {
      if (!priceMap.has(alert.symbol)) { notFound++; continue; }
      try {
        const f = await evaluateOne(alert);
        if (f) fired++;
      } catch { /* continue */ }
    }
    await refresh();
    setRunningAll(false);
    const msgs = [];
    if (fired) msgs.push(`${fired} alert${fired !== 1 ? "s" : ""} triggered`);
    if (notFound) msgs.push(`${notFound} symbol${notFound !== 1 ? "s" : ""} not in loaded data`);
    if (fired) toast.success("🔔 " + (msgs.join(", ") || "Done"));
    else toast.info("No alerts triggered — " + (msgs[0] ?? "no matches"));
  }, [alerts, priceMap, histories.length, evaluateOne, refresh]);

  // ── Toggle ───────────────────────────────────────────────────────────────────
  const toggleAlert = useCallback(async (a: ApiAlert) => {
    try {
      const updated = await apiToggleAlert(a.id);
      setAlerts(prev => prev.map(x => x.id === a.id ? updated : x));
    } catch { toast.error("Failed to update"); }
  }, []);

  // ── Delete ───────────────────────────────────────────────────────────────────
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteAlert(deleteTarget.id);
      setAlerts(prev => prev.filter(a => a.id !== deleteTarget.id));
      setLiveResults(r => { const n = { ...r }; delete n[deleteTarget.id]; return n; });
      toast.success(`Deleted alert for ${deleteTarget.symbol}`);
      setDeleteTarget(null);
    } catch { toast.error("Failed to delete"); }
    finally { setDeleting(false); }
  }, [deleteTarget]);

  // ── Save ─────────────────────────────────────────────────────────────────────
  const saveAlert = useCallback(async () => {
    if (!form.symbol.trim()) { toast.error("Stock symbol is required"); return; }
    const price = parseFloat(form.target_price);
    if (isNaN(price) || price <= 0) { toast.error("Enter a valid target price"); return; }
    setSaving(true);
    try {
      if (editingAlert) {
        const updated = await apiUpdateAlert(editingAlert.id, {
          symbol: form.symbol.trim().toUpperCase(),
          condition_type: form.condition_type,
          target_price: price,
          priority: form.priority,
          side: form.side,
          note: form.note.trim(),
        });
        setAlerts(prev => prev.map(a => a.id === updated.id ? updated : a));
        toast.success("Alert updated");
      } else {
        const created = await apiCreateAlert({
          symbol: form.symbol.trim().toUpperCase(),
          condition_type: form.condition_type,
          target_price: price,
          priority: form.priority,
          side: form.side,
          note: form.note.trim(),
        });
        setAlerts(prev => [created, ...prev]);
        toast.success(`Alert created for ${created.symbol}`);
      }
      setDialogOpen(false);
    } catch { toast.error("Failed to save alert"); }
    finally { setSaving(false); }
  }, [form, editingAlert]);

  // ── Export ────────────────────────────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!alerts.length) { toast.error("No alerts to export"); return; }
    const payload = alerts.map(a => ({
      symbol: a.symbol,
      condition_type: a.condition_type,
      target_price: a.target_price,
      note: a.note,
      priority: a.priority,
      side: a.side ?? "buy",
      status: a.status,
    }));
    const blob = new Blob([JSON.stringify({ version: 1, alerts: payload }, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `bharatscan-alerts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${alerts.length} alert${alerts.length !== 1 ? "s" : ""}`);
  }, [alerts]);

  // ── Import ─────────────────────────────────────────────────────────────────── 
  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const json = JSON.parse(evt.target?.result as string);
        const rows: ImportPayload[] = Array.isArray(json) ? json : (json.alerts ?? []);
        if (!rows.length) { toast.error("No alerts found in file"); return; }
        const valid = rows.filter(r =>
          r.symbol && r.condition_type && typeof r.target_price === "number"
        );
        if (!valid.length) { toast.error("File contains no valid alerts"); return; }
        setImportPending(valid);
      } catch {
        toast.error("Invalid JSON file");
      }
    };
    reader.readAsText(file);
  }, []);

  const executeImport = useCallback(async (mode: "append" | "replace") => {
    if (!importPending?.length) return;
    setImporting(true);
    try {
      if (mode === "replace") {
        for (const a of alerts) {
          await apiDeleteAlert(a.id);
        }
      }
      const created: ApiAlert[] = [];
      for (const row of importPending) {
        const a = await apiCreateAlert({
          symbol: row.symbol,
          condition_type: row.condition_type,
          target_price: row.target_price,
          note: row.note ?? "",
          priority: row.priority ?? "medium",
          side: row.side ?? "buy",
        });
        // restore paused status if exported as paused
        if (row.status === "paused") {
          const toggled = await apiToggleAlert(a.id);
          created.push(toggled);
        } else {
          created.push(a);
        }
      }
      await refresh();
      setImportPending(null);
      toast.success(
        mode === "replace"
          ? `Replaced all alerts — imported ${created.length}`
          : `Appended ${created.length} alert${created.length !== 1 ? "s" : ""}`
      );
    } catch {
      toast.error("Import failed");
    } finally {
      setImporting(false);
    }
  }, [importPending, alerts, refresh]);

  // ── Stats ────────────────────────────────────────────────────────────────────
  const activeCount  = alerts.filter(a => a.status === "active").length;
  const pausedCount  = alerts.filter(a => a.status === "paused").length;
  const todayCount   = history.filter(h => isToday(h.triggered_at)).length;

  return (
    <div className="bg-background">
      <main className="container py-2 space-y-3">
        {/* Page title bar */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-bold tracking-tight text-foreground">Price Alerts</h1>
            <p className="text-[10px] text-muted-foreground">
              Monitor stock prices against your targets — evaluated against loaded bhavcopy data
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={runAllAlerts} disabled={runningAll || !activeCount}>
              {runningAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
              Run All
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleExport} disabled={!alerts.length}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => fileInputRef.current?.click()}>
              <FolderInput className="h-3.5 w-3.5" /> Import
            </Button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
            <Button size="sm" className="h-7 text-xs bg-gradient-primary text-primary-foreground hover:opacity-90"
              onClick={() => { setEditingAlert(null); setForm(emptyForm()); setDialogOpen(true); }}>
              <Plus className="h-3.5 w-3.5" /> Add Alert
            </Button>
          </div>
        </div>
        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: "Active",          value: activeCount,  color: "text-success",          bg: "bg-success/10 border-success/20" },
            { label: "Paused",          value: pausedCount,  color: "text-muted-foreground", bg: "bg-muted/30 border-border" },
            { label: "Triggered Today", value: todayCount,   color: "text-primary",          bg: "bg-primary/10 border-primary/20" },
            { label: "Total Alerts",    value: alerts.length,color: "text-foreground",        bg: "bg-card border-border" },
          ].map(s => (
            <Card key={s.label} className={`px-4 py-2.5 shadow-card border ${s.bg}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
              <p className={`text-2xl font-bold tabular-nums mt-0.5 ${s.color}`}>{s.value}</p>
            </Card>
          ))}
        </div>

        {/* No data warning */}
        {!histories.length && (
          <Card className="p-3 border-orange-500/30 bg-orange-500/5 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-orange-400 shrink-0" />
            <p className="text-xs text-orange-300">
              No bhavcopy data loaded — upload a CSV from the Home page so alerts can check current prices.
            </p>
          </Card>
        )}

        {/* Alerts table */}
        <Card className="shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
            <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Alerts</h3>
            <span className="text-[10px] text-muted-foreground">{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : alerts.length === 0 ? (
            <div className="py-14 text-center">
              <Bell className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground font-medium">No alerts yet</p>
              <p className="text-xs text-muted-foreground/50 mt-1">
                Add an alert to track when a stock's price crosses your target
              </p>
              <Button size="sm" className="mt-4 h-7 text-xs bg-gradient-primary text-primary-foreground"
                onClick={() => { setEditingAlert(null); setForm(emptyForm()); setDialogOpen(true); }}>
                <Plus className="h-3.5 w-3.5" /> Add Alert
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-2">Symbol</th>
                    <th className="text-left px-4 py-2">Condition</th>
                    <th className="text-right px-3 py-2">Target ₹</th>
                    <th className="text-right px-3 py-2">Current ₹</th>
                    <th className="text-right px-3 py-2">% Away</th>
                    <th className="text-center px-3 py-2">Priority</th>
                    <th className="text-center px-3 py-2">Triggered</th>
                    <th className="text-left px-3 py-2">Last Trigger</th>
                    <th className="text-left px-3 py-2">Created</th>
                    <th className="text-center px-3 py-2">Status</th>
                    <th className="text-center px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((a, i) => {
                    const live      = liveResults[a.id];
                    const dataPrice = priceMap.get(a.symbol);
                    const currentPrice = live?.price ?? dataPrice?.last ?? a.last_checked_price ?? null;
                    const condInfo  = CONDITIONS.find(c => c.value === a.condition_type);
                    const CondIcon  = condInfo?.icon ?? ArrowUpDown;

                    return (
                      <tr key={a.id} className={`border-t border-border/50 hover:bg-primary/5 transition-colors ${i % 2 === 0 ? "bg-card" : "bg-muted/10"}`}>
                        {/* Symbol */}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-foreground">{a.symbol}</span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              (a.side ?? "buy") === "buy"
                                ? "bg-success/15 text-success"
                                : "bg-destructive-bright/15 text-destructive-bright"
                            }`}>
                              {(a.side ?? "buy").toUpperCase()}
                            </span>
                          </div>
                          {a.note && <div className="text-[10px] text-muted-foreground/60 truncate max-w-[120px]">{a.note}</div>}
                        </td>
                        {/* Condition */}
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <CondIcon className="h-3 w-3 shrink-0" />
                            <span>{condInfo?.label ?? a.condition_type}</span>
                          </div>
                          {live !== undefined && (
                            <div className={`text-[10px] mt-0.5 font-medium ${live?.fired ? "text-success" : "text-muted-foreground/50"}`}>
                              {live?.fired ? "🔔 Triggered" : "No trigger"}
                            </div>
                          )}
                        </td>
                        {/* Target */}
                        <td className="px-3 py-2.5 text-right tabular-nums font-mono font-semibold text-foreground">
                          ₹{fmt(a.target_price)}
                        </td>
                        {/* Current price */}
                        <td className="px-3 py-2.5 text-right tabular-nums font-mono">
                          {currentPrice != null ? (
                            <span className={currentPrice > a.target_price ? "text-success" : "text-destructive-bright"}>
                              ₹{fmt(currentPrice)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        {/* % away */}
                        <td className="px-3 py-2.5 text-right tabular-nums text-[10px]">
                          {currentPrice != null ? (
                            <span className={currentPrice >= a.target_price ? "text-success" : "text-destructive-bright"}>
                              {pctAway(currentPrice, a.target_price)}
                            </span>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        {/* Priority */}
                        <td className="px-3 py-2.5 text-center">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${priorityBadge(a.priority, a.side ?? "buy")}`}>
                            {a.priority}
                          </span>
                        </td>
                        {/* Triggered count */}
                        <td className="px-3 py-2.5 text-center tabular-nums text-muted-foreground">{a.trigger_count}×</td>
                        {/* Last trigger */}
                        <td className="px-3 py-2.5 text-[10px] text-muted-foreground/70">
                          {a.last_triggered_at ? fmtDate(a.last_triggered_at) : <span className="text-muted-foreground/30">—</span>}
                        </td>
                        {/* Created */}
                        <td className="px-3 py-2.5 text-[10px] text-muted-foreground/70">
                          {fmtDate(a.created_at)}
                        </td>
                        {/* Status */}
                        <td className="px-3 py-2.5 text-center">
                          <button type="button" onClick={() => toggleAlert(a)} title={a.status === "active" ? "Active — click to pause" : "Paused — click to activate"}>
                            {a.status === "active"
                              ? <CheckCircle2 className="h-4 w-4 text-success mx-auto" />
                              : <XCircle className="h-4 w-4 text-muted-foreground mx-auto" />}
                          </button>
                        </td>
                        {/* Actions */}
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button type="button" onClick={() => runAlert(a)} disabled={runningId === a.id || runningAll}
                              className="p-1 rounded text-muted-foreground hover:text-success hover:bg-success/10 transition-colors disabled:opacity-40"
                              title="Check this alert against current data">
                              {runningId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            </button>
                            <button type="button"
                              onClick={() => { setEditingAlert(a); setForm(formFromAlert(a)); setDialogOpen(true); }}
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title="Edit alert">
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" onClick={() => toggleAlert(a)}
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                              title={a.status === "active" ? "Pause" : "Activate"}>
                              {a.status === "active" ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                            </button>
                            <button type="button" onClick={() => setDeleteTarget(a)}
                              className="p-1 rounded text-muted-foreground hover:text-destructive-bright hover:bg-destructive-bright/10 transition-colors"
                              title="Delete alert">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Trigger history */}
        <Card className="shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center justify-between">
            <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Trigger History</h3>
            <span className="text-[10px] text-muted-foreground">{history.length} event{history.length !== 1 ? "s" : ""}</span>
          </div>
          {history.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground/50">
              <Zap className="h-6 w-6 mx-auto mb-2 opacity-30" />
              <p className="text-xs">No triggers yet — run an alert to see results here</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50 max-h-72 overflow-y-auto">
              {history.map(t => {
                const cond = CONDITIONS.find(c => c.value === t.condition_type);
                return (
                  <div key={t.id} className="px-4 py-3 flex items-center gap-4 hover:bg-muted/20 transition-colors">
                    <div className="h-7 w-7 rounded-full bg-success/15 flex items-center justify-center shrink-0">
                      <Zap className="h-3.5 w-3.5 text-success" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-foreground">
                        <span className="text-primary">{t.symbol}</span>
                        {" "}—{" "}
                        <span className="font-normal text-muted-foreground">{cond?.label ?? t.condition_type} ₹{fmt(t.target_price)}</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        Triggered at ₹{fmt(t.triggered_price)}
                        {" · "}
                        {((t.triggered_price - t.target_price) / t.target_price * 100).toFixed(2)}% from target
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1 justify-end">
                        <Clock className="h-2.5 w-2.5" /> {fmtDate(t.triggered_at)}
                      </p>
                      <span className="text-[10px] font-bold text-success">Triggered</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </main>

      {/* ── Add / Edit dialog ──────────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">{editingAlert ? "Edit Alert" : "Add Price Alert"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-1">
            {/* Buy / Sell toggle */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Alert For</span>
              <div className="flex items-center rounded-md border border-border bg-input p-0.5 gap-0.5">
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, side: "buy" }))}
                  className={`px-4 py-1 text-xs font-bold rounded transition-colors ${
                    form.side === "buy"
                      ? "bg-success text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  BUY
                </button>
                <button
                  type="button"
                  onClick={() => setForm(f => ({ ...f, side: "sell" }))}
                  className={`px-4 py-1 text-xs font-bold rounded transition-colors ${
                    form.side === "sell"
                      ? "bg-destructive-bright text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  SELL
                </button>
              </div>
            </div>

            {/* Symbol */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Stock Symbol</label>
              <div className="relative">
                <Input
                  list="alert-symbols"
                  value={form.symbol}
                  onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  placeholder="e.g. BPCL, RELIANCE, TATAMOTORS"
                  className="h-9 text-sm font-mono uppercase"
                  autoComplete="off"
                />
                {allSymbols.length > 0 && (
                  <datalist id="alert-symbols">
                    {allSymbols.map(s => <option key={s} value={s} />)}
                  </datalist>
                )}
              </div>
              {allSymbols.length > 0 && (
                <p className="text-[10px] text-muted-foreground/60 mt-1">{allSymbols.length} symbols available from loaded data</p>
              )}
            </div>

            {/* Condition */}
            <div>
              <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Condition</label>
              <Select value={form.condition_type} onValueChange={v => setForm(f => ({ ...f, condition_type: v as AlertConditionType }))}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map(c => (
                    <SelectItem key={c.value} value={c.value} className="text-xs">
                      <div className="flex items-center gap-2">
                        <c.icon className="h-3.5 w-3.5" />
                        {c.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                {form.condition_type === "crosses_above" && "Fires when price moves from below to above the target — bullish breakout"}
                {form.condition_type === "crosses_below" && "Fires when price moves from above to below the target — bearish breakdown"}
                {form.condition_type === "greater_than"  && "Fires whenever the latest close is above the target price"}
                {form.condition_type === "less_than"     && "Fires whenever the latest close is below the target price"}
              </p>
            </div>

            {/* Current Price + Target Price row */}
            <div className="grid grid-cols-2 gap-3">
              {/* Current Price — read-only, from CSV */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Current Price (₹)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₹</span>
                  <Input
                    readOnly
                    value={form.symbol && priceMap.has(form.symbol) ? fmt(priceMap.get(form.symbol)!.last) : ""}
                    placeholder="—"
                    className="h-9 text-sm pl-7 font-mono bg-muted/40 text-muted-foreground cursor-default select-none"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground/50 mt-1">From loaded CSV data</p>
              </div>
              {/* Target Price — editable */}
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Target Price (₹)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₹</span>
                  <Input
                    type="number"
                    step="0.05"
                    min="0"
                    value={form.target_price}
                    onChange={e => setForm(f => ({ ...f, target_price: e.target.value }))}
                    placeholder="0.00"
                    className="h-9 text-sm pl-7 font-mono"
                  />
                </div>
                {form.symbol && priceMap.has(form.symbol) && form.target_price && (
                  <p className="text-[10px] text-muted-foreground/50 mt-1">
                    {(() => {
                      const cur = priceMap.get(form.symbol)!.last;
                      const tgt = parseFloat(form.target_price);
                      if (!tgt) return null;
                      const pct = ((tgt - cur) / cur * 100).toFixed(2);
                      return `${Number(pct) >= 0 ? "+" : ""}${pct}% from current`;
                    })()}
                  </p>
                )}
              </div>
            </div>

            {/* Priority + Note row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Priority</label>
                <Select value={form.priority} onValueChange={v => setForm(f => ({ ...f, priority: v as AlertForm["priority"] }))}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high"   className="text-xs">High</SelectItem>
                    <SelectItem value="medium" className="text-xs">Medium</SelectItem>
                    <SelectItem value="low"    className="text-xs">Low</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block mb-1">Note (optional)</label>
                <Input
                  value={form.note}
                  onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="e.g. Resistance breakout"
                  className="h-8 text-xs"
                />
              </div>
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs bg-gradient-primary text-primary-foreground hover:opacity-90"
                onClick={saveAlert}
                disabled={saving || !form.symbol.trim() || !form.target_price}
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {editingAlert ? "Save Changes" : "Add Alert"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Import: Append or Replace dialog ─────────────────────────────────── */}
      <Dialog open={!!importPending} onOpenChange={o => { if (!o && !importing) setImportPending(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Import Alerts</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground mt-1">
            Found <strong className="text-foreground">{importPending?.length ?? 0} alert{importPending?.length !== 1 ? "s" : ""}</strong> in the file.
            How would you like to import them?
          </p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button
              type="button"
              disabled={importing}
              onClick={() => executeImport("append")}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-left hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50"
            >
              <FolderInput className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold text-foreground">Append</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Add to existing alerts</p>
              </div>
            </button>
            <button
              type="button"
              disabled={importing}
              onClick={() => executeImport("replace")}
              className="flex flex-col items-center gap-2 rounded-lg border border-destructive-bright/30 bg-card p-4 text-left hover:border-destructive-bright/60 hover:bg-destructive-bright/5 transition-colors disabled:opacity-50"
            >
              <Trash2 className="h-5 w-5 text-destructive-bright" />
              <div>
                <p className="text-xs font-semibold text-foreground">Replace</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Delete all, then import</p>
              </div>
            </button>
          </div>
          {importing && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-3">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Importing…
            </div>
          )}
          <div className="flex justify-end mt-3">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={importing} onClick={() => setImportPending(null)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ───────────────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Alert</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground mt-1">
            Delete the price alert for <strong className="text-foreground">{deleteTarget?.symbol}</strong> — {" "}
            {deleteTarget && conditionLabel(deleteTarget.condition_type)} ₹{deleteTarget && fmt(deleteTarget.target_price)}?
            <br />This cannot be undone.
          </p>
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
