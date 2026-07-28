import { useRef, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { User, Palette, Bell, ScanSearch, Database, FileInput, Shield, HardDrive, ChevronRight, Moon, Sun, Monitor, Check, Download, Upload, Loader2, Trash2, Plug, PlugZap, RefreshCw, LogOut, Plus, ExternalLink, Clock, Camera, X } from "lucide-react";
import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme, type AccentColor } from "@/hooks/useTheme";
import { DataSourcePanels } from "@/components/DataSourcePanels";
import { MarketApiPanel } from "@/components/MarketApiPanel";
import { createBackup, restoreBackup, getLastBackupTime, parseBackupFile, summarizeBackup, summarizeCurrentData, type BackupSummary, type CurrentDataSummary } from "@/lib/backup";
import {
  apiGetSettings, apiSaveSetting,
  apiListScans, apiCreateScan, apiDeleteScan, apiToggleFavorite,
  apiListAlerts, apiCreateAlert, apiDeleteAlert, apiToggleAlert,
  apiListDashboards, apiDeleteDashboard,
  apiListPortfolios, apiDeletePortfolio,
  apiListScannerDashboards, apiDeleteScannerDashboard,
  apiGetSchedulerStatus, apiGetMarketStatus, apiGetQuoteCacheStats, apiResetQuoteCacheStats,
  apiStartHistoricalBackfill, apiPauseHistoricalBackfill, apiResumeHistoricalBackfill,
  apiRefreshSymbolMaster,
  type ApiScan, type ApiSchedulerStatus, type ApiMarketStatus, type ApiQuoteCacheStats,
} from "@/lib/api";
import { toast } from "sonner";
import { notifyProfileUpdated } from "@/hooks/useProfile";

/** Downscale + compress an uploaded image client-side so the resulting base64 data URL
 * comfortably fits the /settings API's per-value size cap. */
async function resizeImageToDataUrl(file: File, maxSize = 160, quality = 0.82): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not load image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

const SECTIONS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "theme", label: "Theme", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "scanner", label: "Scanner Preferences", icon: ScanSearch },
  { id: "data", label: "API / Data Source", icon: Database },
  { id: "import", label: "Import / Export", icon: FileInput },
  { id: "security", label: "Security", icon: Shield },
  { id: "backup", label: "Backup / Restore", icon: HardDrive },
  { id: "broker", label: "Broker Connect", icon: Plug },
];

const ACCENT_OPTIONS: { id: AccentColor; label: string; cls: string }[] = [
  { id: "sky",     label: "Sky Blue",  cls: "bg-sky-500" },
  { id: "violet",  label: "Violet",    cls: "bg-violet-500" },
  { id: "emerald", label: "Emerald",   cls: "bg-emerald-500" },
  { id: "orange",  label: "Orange",    cls: "bg-orange-500" },
];

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
        checked ? "bg-primary" : "bg-muted"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="min-w-0 pr-4">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SectionCard({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <Card className="shadow-card overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-muted/20 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-primary" />
        <h3 className="text-[10px] font-bold tracking-wide text-muted-foreground uppercase">{title}</h3>
      </div>
      <div className="px-4">{children}</div>
    </Card>
  );
}

// ── Broker Connection types & helpers ─────────────────────────────────────────

type BrokerStatus =
  | "connected"
  | "disconnected"
  | "waiting_totp"
  | "session_expired"
  | "invalid_credentials"
  | "login_failed"
  | "broker_unavailable";

interface BrokerConnection {
  id: string;
  broker_name: string;
  display_name: string;
  status: BrokerStatus;
  token_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

const BROKER_STATUS_META: Record<BrokerStatus, { label: string; dotCls: string; textCls: string }> = {
  connected:            { label: "Connected",          dotCls: "bg-emerald-400",  textCls: "text-emerald-400" },
  disconnected:         { label: "Disconnected",       dotCls: "bg-muted-foreground/30", textCls: "text-muted-foreground" },
  waiting_totp:         { label: "Waiting for Auth",   dotCls: "bg-sky-400",      textCls: "text-sky-400" },
  session_expired:      { label: "Session Expired",    dotCls: "bg-amber-400",    textCls: "text-amber-400" },
  invalid_credentials:  { label: "Invalid Credentials",dotCls: "bg-destructive",  textCls: "text-destructive-bright" },
  login_failed:         { label: "Login Failed",       dotCls: "bg-destructive",  textCls: "text-destructive-bright" },
  broker_unavailable:   { label: "Broker Unavailable", dotCls: "bg-orange-400",   textCls: "text-orange-400" },
};

async function brokerFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "include",
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
  return json as T;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Formats a "minute hour * * days" cron expression's hour/minute fields as
 *  "HH:MM", zero-padded — used to show the reconciliation window without a
 *  fixed next-run timestamp (see liveFeed status). */
function formatCronHourMinute(cronExpr: string): string {
  const [minute, hour] = cronExpr.trim().split(/\s+/);
  const h = Number(hour);
  const m = Number(minute);
  if (Number.isNaN(h) || Number.isNaN(m)) return cronExpr;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export default function Settings() {
  const { themeMode, setTheme, compactMode, setCompactMode, accentColor, setAccentColor } = useTheme();
  const [searchParams] = useSearchParams();
  const [activeSection, setActiveSection] = useState(() => {
    const tab = searchParams.get("tab");
    return SECTIONS.some(s => s.id === tab) ? tab! : "profile";
  });

  // ── Profile ────────────────────────────────────────────────────────────────
  const [profileName, setProfileName] = useState("Trader");
  const [profileEmail, setProfileEmail] = useState("trader@example.com");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // ── Notifications ──────────────────────────────────────────────────────────
  const [notifs, setNotifs] = useState({
    email: true, push: false, sms: true, scanComplete: true, alertTrigger: true, weeklyReport: false,
  });

  // ── Scanner prefs ──────────────────────────────────────────────────────────
  const [scanner, setScanner] = useState({
    defaultSeries: "EQ", defaultBacktest: "60", autoRefresh: false, showVolume: true,
    showSavedScans: localStorage.getItem("bharatscan:show-saved-scans") === "true",
    homeIndexSource: (localStorage.getItem("bharatscan:home-index-source") ?? "futures") as "futures" | "spot",
  });

  // ── Clear all state ────────────────────────────────────────────────────────
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  // ── Export all scans ───────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);

  // ── Import scans pack ──────────────────────────────────────────────────────
  const importScansRef = useRef<HTMLInputElement>(null);
  const [importingScans, setImportingScans] = useState(false);

  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreLog, setRestoreLog] = useState<string[]>([]);
  const [lastBackup, setLastBackup] = useState<string | null>(getLastBackupTime);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [pendingRestore, setPendingRestore] = useState<{ file: File; summary: BackupSummary } | null>(null);
  const [restorePreviewError, setRestorePreviewError] = useState<string | null>(null);
  const [currentDataSummary, setCurrentDataSummary] = useState<CurrentDataSummary | null>(null);
  const [currentDataLoading, setCurrentDataLoading] = useState(false);

  // ── Broker connections ─────────────────────────────────────────────────────
  const [brokers, setBrokers] = useState<BrokerConnection[]>([]);
  const [brokersLoading, setBrokersLoading] = useState(false);
  const [showAddBroker, setShowAddBroker] = useState(false);
  const [addBrokerType, setAddBrokerType] = useState<"angel_one" | "fyers">("angel_one");
  const [addBrokerForm, setAddBrokerForm] = useState({ display_name: "Angel One", api_key: "", client_code: "", pin: "" });
  const [addBrokerSaving, setAddBrokerSaving] = useState(false);
  const [brokerTotps, setBrokerTotps] = useState<Record<string, string>>({});
  const [brokerBusy, setBrokerBusy] = useState<Record<string, boolean>>({});

  // ── Live feed scheduler status ─────────────────────────────────────────────
  const [schedulerStatus, setSchedulerStatus] = useState<ApiSchedulerStatus | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(false);

  // ── Backfill dashboard ─────────────────────────────────────────────────────
  const [marketStatus, setMarketStatus] = useState<ApiMarketStatus | null>(null);
  const [marketStatusLoading, setMarketStatusLoading] = useState(false);
  const [historicalBackfillBusy, setHistoricalBackfillBusy] = useState(false);

  // ── Live quote cache diagnostics ────────────────────────────────────────────
  const [quoteCacheStats, setQuoteCacheStats] = useState<ApiQuoteCacheStats | null>(null);
  const [quoteCacheLoading, setQuoteCacheLoading] = useState(false);
  const [quoteCacheHistory, setQuoteCacheHistory] = useState<{ t: number; rate: number }[]>([]);
  const [quoteCacheResetting, setQuoteCacheResetting] = useState(false);

  // ── Symbol master refresh ──────────────────────────────────────────────────
  const [symbolRefreshing, setSymbolRefreshing] = useState(false);

  // ── Load all settings from backend on mount ────────────────────────────────
  useEffect(() => {
    apiGetSettings().then((s) => {
      if (s["profile:name"])          setProfileName(s["profile:name"]);
      if (s["profile:email"])         setProfileEmail(s["profile:email"]);
      if (s["profile:photo"])         setProfilePhoto(s["profile:photo"]);
      if (s["scanner:defaultSeries"]) setScanner(p => ({ ...p, defaultSeries: s["scanner:defaultSeries"] }));
      if (s["scanner:defaultBacktest"]) setScanner(p => ({ ...p, defaultBacktest: s["scanner:defaultBacktest"] }));
      if (s["scanner:autoRefresh"])   setScanner(p => ({ ...p, autoRefresh: s["scanner:autoRefresh"] === "true" }));
      if (s["scanner:showVolume"])    setScanner(p => ({ ...p, showVolume: s["scanner:showVolume"] !== "false" }));
      if (s["notif:email"])           setNotifs(p => ({ ...p, email: s["notif:email"] !== "false" }));
      if (s["notif:push"])            setNotifs(p => ({ ...p, push: s["notif:push"] === "true" }));
      if (s["notif:sms"])             setNotifs(p => ({ ...p, sms: s["notif:sms"] !== "false" }));
      if (s["notif:scanComplete"])    setNotifs(p => ({ ...p, scanComplete: s["notif:scanComplete"] !== "false" }));
      if (s["notif:alertTrigger"])    setNotifs(p => ({ ...p, alertTrigger: s["notif:alertTrigger"] !== "false" }));
      if (s["notif:weeklyReport"])    setNotifs(p => ({ ...p, weeklyReport: s["notif:weeklyReport"] === "true" }));
    }).catch(() => {});
  }, []);

  // ── Save profile ──────────────────────────────────────────────────────────
  const saveProfile = useCallback(async () => {
    setProfileSaving(true);
    try {
      await Promise.all([
        apiSaveSetting("profile:name", profileName.trim() || "Trader"),
        apiSaveSetting("profile:email", profileEmail.trim()),
      ]);
      notifyProfileUpdated();
      toast.success("Profile saved");
    } catch {
      toast.error("Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }, [profileName, profileEmail]);

  // ── Upload / remove profile photo (auto-saves, shown live in the sidebar) ──
  const handlePhotoSelected = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    setPhotoUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      await apiSaveSetting("profile:photo", dataUrl);
      setProfilePhoto(dataUrl);
      notifyProfileUpdated();
      toast.success("Profile photo updated");
    } catch {
      toast.error("Failed to update profile photo");
    } finally {
      setPhotoUploading(false);
    }
  }, []);

  const removePhoto = useCallback(async () => {
    setPhotoUploading(true);
    try {
      await apiSaveSetting("profile:photo", "");
      setProfilePhoto(null);
      notifyProfileUpdated();
      toast.success("Profile photo removed");
    } catch {
      toast.error("Failed to remove profile photo");
    } finally {
      setPhotoUploading(false);
    }
  }, []);

  // ── Toggle notification (auto-saves) ──────────────────────────────────────
  const toggleNotif = useCallback((key: keyof typeof notifs) => {
    setNotifs((p) => {
      const next = { ...p, [key]: !p[key] };
      apiSaveSetting(`notif:${key}`, String(next[key])).catch(() => {});
      return next;
    });
  }, []);

  // ── Update scanner pref (auto-saves) ─────────────────────────────────────
  const updateScanner = useCallback(<K extends keyof typeof scanner>(key: K, value: typeof scanner[K]) => {
    setScanner(p => {
      const next = { ...p, [key]: value };
      if (key !== "showSavedScans") {
        apiSaveSetting(`scanner:${key}`, String(value)).catch(() => {});
      }
      return next;
    });
  }, []);

  // ── Export all saved scans ─────────────────────────────────────────────────
  const handleExportAllScans = useCallback(async () => {
    setExporting(true);
    try {
      const scans = await apiListScans();
      if (!scans.length) { toast.error("No saved scans to export"); return; }
      const blob = new Blob([JSON.stringify({ version: 1, scans }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `bharatscan-scans-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${scans.length} scan${scans.length !== 1 ? "s" : ""}`);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  }, []);

  // ── Import scan pack ──────────────────────────────────────────────────────
  const handleImportScansFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportingScans(true);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const scans: ApiScan[] = Array.isArray(json) ? json : (json.scans ?? []);
      if (!scans.length) { toast.error("No scans found in file"); return; }
      let imported = 0;
      for (const scan of scans) {
        if (!scan.name || !scan.scan_json) continue;
        const created = await apiCreateScan({ name: scan.name, scan_json: scan.scan_json, folder: scan.folder ?? undefined });
        if (scan.is_favorite) await apiToggleFavorite(created.id).catch(() => {});
        imported++;
      }
      toast.success(`Imported ${imported} scan${imported !== 1 ? "s" : ""}`);
    } catch {
      toast.error("Import failed — invalid JSON file");
    } finally {
      setImportingScans(false);
    }
  }, []);

  // ── Clear all data ────────────────────────────────────────────────────────
  const handleClearAll = useCallback(async () => {
    setClearing(true);
    try {
      const [scans, alerts, dashboards, portfolios, scannerDashboards] = await Promise.all([
        apiListScans(),
        apiListAlerts(),
        apiListDashboards(),
        apiListPortfolios(),
        apiListScannerDashboards(),
      ]);
      await Promise.all([
        ...scans.map(s => apiDeleteScan(s.id).catch(() => {})),
        ...alerts.map(a => apiDeleteAlert(a.id).catch(() => {})),
        ...dashboards.map(d => apiDeleteDashboard(d.id).catch(() => {})),
        ...portfolios.map(p => apiDeletePortfolio(p.id).catch(() => {})),
        ...scannerDashboards.map(sd => apiDeleteScannerDashboard(sd.id).catch(() => {})),
      ]);
      const lsKeys = Object.keys(localStorage).filter(k => k.startsWith("bharatscan") || k.startsWith("bs:"));
      lsKeys.forEach(k => { try { localStorage.removeItem(k); } catch {} });
      toast.success("All data cleared");
      setClearDialogOpen(false);
    } catch {
      toast.error("Failed to clear all data");
    } finally {
      setClearing(false);
    }
  }, []);

  // ── Broker: load when section becomes active ──────────────────────────────
  useEffect(() => {
    if (activeSection !== "broker") return;
    setBrokersLoading(true);
    brokerFetch<BrokerConnection[]>("/api/broker-connections")
      .then(setBrokers)
      .catch(() => {})
      .finally(() => setBrokersLoading(false));
  }, [activeSection]);

  // ── Scheduler status: load when broker section becomes active, refresh every minute ──
  useEffect(() => {
    if (activeSection !== "broker") return;
    const load = () => {
      setSchedulerLoading(true);
      apiGetSchedulerStatus()
        .then(setSchedulerStatus)
        .catch(() => setSchedulerStatus(null))
        .finally(() => setSchedulerLoading(false));
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [activeSection]);

  // ── Backfill dashboard + Symbol Master status: load when broker or data
  // section becomes active (Symbol Master card lives in "data") ─────────────
  useEffect(() => {
    if (activeSection !== "broker" && activeSection !== "data") return;
    const load = () => {
      setMarketStatusLoading(true);
      apiGetMarketStatus()
        .then(setMarketStatus)
        .catch(() => setMarketStatus(null))
        .finally(() => setMarketStatusLoading(false));
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [activeSection]);

  // ── Quote cache diagnostics: load when broker section becomes active ──────
  useEffect(() => {
    if (activeSection !== "broker") return;
    const load = () => {
      setQuoteCacheLoading(true);
      apiGetQuoteCacheStats()
        .then((stats) => {
          setQuoteCacheStats(stats);
          if (stats.cacheHitRate !== null) {
            setQuoteCacheHistory((prev) =>
              [...prev, { t: Date.now(), rate: stats.cacheHitRate! * 100 }].slice(-30)
            );
          }
        })
        .catch(() => setQuoteCacheStats(null))
        .finally(() => setQuoteCacheLoading(false));
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [activeSection]);

  const handleResetQuoteCacheStats = useCallback(async () => {
    setQuoteCacheResetting(true);
    try {
      const stats = await apiResetQuoteCacheStats();
      setQuoteCacheStats(stats);
      setQuoteCacheHistory([]);
      toast.success("Quote cache stats reset");
    } catch {
      toast.error("Failed to reset quote cache stats");
    } finally {
      setQuoteCacheResetting(false);
    }
  }, []);

  const handleRefreshSymbolMaster = useCallback(async () => {
    setSymbolRefreshing(true);
    try {
      const result = await apiRefreshSymbolMaster();
      toast.success(`Symbol master updated — ${result.upserted.toLocaleString()} symbols imported/updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Symbol master refresh failed");
    } finally {
      setSymbolRefreshing(false);
    }
  }, []);

  const updateHistoricalBackfill = useCallback(
    async (action: "start" | "pause" | "resume") => {
      setHistoricalBackfillBusy(true);
      try {
        const result =
          action === "start"
            ? await apiStartHistoricalBackfill()
            : action === "pause"
            ? await apiPauseHistoricalBackfill()
            : await apiResumeHistoricalBackfill();
        setMarketStatus((previous) =>
          previous ? { ...previous, historicalBackfill: result.backfill } : previous
        );
        toast.success(
          action === "start"
            ? "Historical backfill started"
            : action === "pause"
            ? "Historical backfill paused"
            : "Historical backfill resumed"
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Historical backfill action failed");
      } finally {
        setHistoricalBackfillBusy(false);
      }
    },
    []
  );

  // ── Broker: add ───────────────────────────────────────────────────────────
  const handleAddBroker = useCallback(async () => {
    setAddBrokerSaving(true);
    const defaultName = addBrokerType === "fyers" ? "Fyers" : "Angel One";
    try {
      const created = await brokerFetch<BrokerConnection>("/api/broker-connections", {
        method: "POST",
        body: JSON.stringify({
          broker_name: addBrokerType,
          display_name: addBrokerForm.display_name || defaultName,
          api_key: addBrokerForm.api_key,
          client_code: addBrokerForm.client_code,
          pin: addBrokerForm.pin,
        }),
      });
      setBrokers(prev => [created, ...prev]);
      setAddBrokerForm({ display_name: defaultName, api_key: "", client_code: "", pin: "" });
      setShowAddBroker(false);
      const hint = addBrokerType === "fyers"
        ? "Fyers saved. Click 'Open Auth Page' to generate an auth code, then connect."
        : "Broker saved. Enter a TOTP to connect.";
      toast.success(hint);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save broker");
    } finally {
      setAddBrokerSaving(false);
    }
  }, [addBrokerForm, addBrokerType]);

  // ── Broker: connect ───────────────────────────────────────────────────────
  const handleBrokerConnect = useCallback(async (id: string) => {
    const totp = brokerTotps[id] ?? "";
    const isFyers = brokers.find(b => b.id === id)?.broker_name === "fyers";
    if (isFyers ? !totp : totp.length < 6) return;
    setBrokerBusy(prev => ({ ...prev, [`connect:${id}`]: true }));
    try {
      await brokerFetch(`/api/broker-connections/${id}/connect`, {
        method: "POST",
        body: JSON.stringify({ totp_code: totp }),
      });
      setBrokerTotps(prev => { const n = { ...prev }; delete n[id]; return n; });
      const list = await brokerFetch<BrokerConnection[]>("/api/broker-connections");
      setBrokers(list);
      toast.success("Connected successfully.");
    } catch (err) {
      // The connect endpoint persists the explicit failure state (invalid
      // credentials / login failed / broker unavailable) server-side even
      // on error — refresh the list so the row reflects it immediately.
      try {
        const list = await brokerFetch<BrokerConnection[]>("/api/broker-connections");
        setBrokers(list);
      } catch { /* ignore — fall through to toast below */ }
      toast.error(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setBrokerBusy(prev => { const n = { ...prev }; delete n[`connect:${id}`]; return n; });
    }
  }, [brokerTotps]);

  // ── Broker: disconnect ────────────────────────────────────────────────────
  const handleBrokerDisconnect = useCallback(async (id: string) => {
    setBrokerBusy(prev => ({ ...prev, [`disconnect:${id}`]: true }));
    try {
      await brokerFetch(`/api/broker-connections/${id}/disconnect`, { method: "POST" });
      setBrokers(prev => prev.map(b =>
        b.id === id ? { ...b, status: "disconnected" as const, token_generated_at: null } : b
      ));
      toast.info("Broker disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBrokerBusy(prev => { const n = { ...prev }; delete n[`disconnect:${id}`]; return n; });
    }
  }, []);

  // ── Broker: open Fyers auth page ─────────────────────────────────────────
  const handleGetFyersAuthUrl = useCallback(async (id: string) => {
    setBrokerBusy(prev => ({ ...prev, [`authurl:${id}`]: true }));
    try {
      const { url } = await brokerFetch<{ url: string }>(`/api/broker-connections/${id}/auth-url`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate auth URL");
    } finally {
      setBrokerBusy(prev => { const n = { ...prev }; delete n[`authurl:${id}`]; return n; });
    }
  }, []);

  // ── Broker: delete ────────────────────────────────────────────────────────
  const handleBrokerDelete = useCallback(async (id: string) => {
    setBrokerBusy(prev => ({ ...prev, [`delete:${id}`]: true }));
    try {
      await brokerFetch(`/api/broker-connections/${id}`, { method: "DELETE" });
      setBrokers(prev => prev.filter(b => b.id !== id));
      toast.success("Broker removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove broker");
    } finally {
      setBrokerBusy(prev => { const n = { ...prev }; delete n[`delete:${id}`]; return n; });
    }
  }, []);

  async function handleBackup() {
    setBackupBusy(true);
    try {
      await createBackup();
      const now = new Date().toISOString();
      setLastBackup(now);
      toast.success("Backup downloaded successfully!");
    } catch (e) {
      toast.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setRestorePreviewError(null);
    setCurrentDataSummary(null);
    try {
      const backup = await parseBackupFile(file);
      setPendingRestore({ file, summary: summarizeBackup(backup) });
      setCurrentDataLoading(true);
      summarizeCurrentData()
        .then(setCurrentDataSummary)
        .catch(() => setCurrentDataSummary(null))
        .finally(() => setCurrentDataLoading(false));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRestorePreviewError(msg);
      toast.error(`Could not read backup file: ${msg}`);
    }
  }

  async function handleConfirmRestore() {
    if (!pendingRestore) return;
    const { file } = pendingRestore;
    setPendingRestore(null);
    setCurrentDataSummary(null);
    setRestoreBusy(true);
    setRestoreLog([]);
    try {
      await restoreBackup(file, (msg) => setRestoreLog((prev) => [...prev, msg]));
      setLastBackup(new Date().toISOString());
      toast.success("Restore complete! Refresh the page to see all changes.");
    } catch (err) {
      toast.error(`Restore failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRestoreBusy(false);
    }
  }

  return (
    <div className="bg-background">
      <main className="container py-2 flex gap-3 items-start">
        {/* Sidebar nav */}
        <Card className="shadow-card w-48 shrink-0 overflow-hidden">
          <div className="py-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveSection(s.id)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors ${
                  activeSection === s.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                }`}
              >
                <span className="flex items-center gap-2.5 text-xs font-medium">
                  <s.icon className="h-3.5 w-3.5 shrink-0" />
                  {s.label}
                </span>
                <ChevronRight className={`h-3 w-3 transition-transform ${activeSection === s.id ? "text-primary" : "opacity-40"}`} />
              </button>
            ))}
          </div>
        </Card>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Profile */}
          {activeSection === "profile" && (
            <SectionCard title="Profile Settings" icon={User}>
              <SettingRow label="Profile Photo" description="Shown in the sidebar; falls back to your name's first letter">
                <div className="flex items-center gap-3">
                  {profilePhoto ? (
                    <img src={profilePhoto} alt="Profile" className="h-12 w-12 rounded-full object-cover ring-1 ring-border" />
                  ) : (
                    <div className="h-12 w-12 rounded-full bg-gradient-primary text-primary-foreground flex items-center justify-center text-lg font-semibold ring-1 ring-border">
                      {(profileName.trim().charAt(0) || "T").toUpperCase()}
                    </div>
                  )}
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePhotoSelected(e.target.files?.[0] ?? null);
                      e.target.value = "";
                    }}
                  />
                  <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" disabled={photoUploading}
                    onClick={() => photoInputRef.current?.click()}>
                    {photoUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                    Upload
                  </Button>
                  {profilePhoto && (
                    <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs text-muted-foreground" disabled={photoUploading}
                      onClick={removePhoto}>
                      <X className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  )}
                </div>
              </SettingRow>
              <SettingRow label="Display Name" description="Name shown across the app">
                <Input className="h-8 w-48 text-xs bg-input" value={profileName}
                  onChange={(e) => setProfileName(e.target.value)} />
              </SettingRow>
              <SettingRow label="Email Address" description="Used for alert notifications">
                <Input className="h-8 w-48 text-xs bg-input" value={profileEmail}
                  onChange={(e) => setProfileEmail(e.target.value)} />
              </SettingRow>
              <SettingRow label="Timezone" description="For market status display">
                <span className="text-xs text-foreground bg-muted px-2 py-1 rounded">IST (UTC+5:30)</span>
              </SettingRow>
              <div className="py-2">
                <Button size="sm" className="bg-gradient-primary text-primary-foreground hover:opacity-90 text-xs h-7 px-3"
                  onClick={saveProfile} disabled={profileSaving}>
                  {profileSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  Save Changes
                </Button>
              </div>
            </SectionCard>
          )}

          {/* Theme */}
          {activeSection === "theme" && (
            <SectionCard title="Theme Settings" icon={Palette}>
              <SettingRow label="App Theme" description="Switch between dark, light, or follow your OS setting">
                <div className="flex items-center gap-1 p-0.5 rounded-lg border border-border bg-input">
                  {([
                    { mode: "dark" as const,   icon: Moon,    label: "Dark" },
                    { mode: "light" as const,  icon: Sun,     label: "Light" },
                    { mode: "system" as const, icon: Monitor, label: "System" },
                  ]).map((t) => (
                    <button
                      key={t.mode}
                      type="button"
                      onClick={() => setTheme(t.mode)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors ${
                        themeMode === t.mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <t.icon className="h-3 w-3" />
                      {t.label}
                    </button>
                  ))}
                </div>
              </SettingRow>

              <SettingRow label="Compact Mode" description="Reduce padding for denser data display">
                <ToggleSwitch checked={compactMode} onChange={() => setCompactMode(!compactMode)} />
              </SettingRow>

              <SettingRow label="Colour Scheme" description="Accent colour for the interface">
                <div className="flex items-center gap-2">
                  {ACCENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      title={opt.label}
                      onClick={() => setAccentColor(opt.id)}
                      className={`h-5 w-5 rounded-full ${opt.cls} ring-offset-background transition-all ${
                        accentColor === opt.id
                          ? "ring-2 ring-foreground ring-offset-1 scale-110"
                          : "ring-2 ring-transparent hover:scale-110"
                      }`}
                    />
                  ))}
                </div>
              </SettingRow>
            </SectionCard>
          )}

          {/* Notifications */}
          {activeSection === "notifications" && (
            <SectionCard title="Notification Settings" icon={Bell}>
              <SettingRow label="Email Notifications" description="Receive alerts via email">
                <ToggleSwitch checked={notifs.email} onChange={() => toggleNotif("email")} />
              </SettingRow>
              <SettingRow label="Push Notifications" description="Browser push notifications">
                <ToggleSwitch checked={notifs.push} onChange={() => toggleNotif("push")} />
              </SettingRow>
              <SettingRow label="SMS Alerts" description="Critical price alerts via SMS">
                <ToggleSwitch checked={notifs.sms} onChange={() => toggleNotif("sms")} />
              </SettingRow>
              <SettingRow label="Scan Complete" description="Notify when a scan finishes">
                <ToggleSwitch checked={notifs.scanComplete} onChange={() => toggleNotif("scanComplete")} />
              </SettingRow>
              <SettingRow label="Alert Triggered" description="Notify when a price alert fires">
                <ToggleSwitch checked={notifs.alertTrigger} onChange={() => toggleNotif("alertTrigger")} />
              </SettingRow>
              <SettingRow label="Weekly Report" description="Weekly portfolio and scan summary">
                <ToggleSwitch checked={notifs.weeklyReport} onChange={() => toggleNotif("weeklyReport")} />
              </SettingRow>
            </SectionCard>
          )}

          {/* Scanner Preferences */}
          {activeSection === "scanner" && (
            <SectionCard title="Scanner Preferences" icon={ScanSearch}>
              <SettingRow label="Default Series" description="Default equity series for scans">
                <div className="flex items-center gap-1 p-0.5 rounded-md border border-border bg-input">
                  {["EQ", "ETF", "ALL"].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => updateScanner("defaultSeries", s)}
                      className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors ${
                        scanner.defaultSeries === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </SettingRow>
              <SettingRow label="Default Backtest Days" description="Default lookback period for backtests">
                <Input className="h-8 w-20 text-xs bg-input text-center" value={scanner.defaultBacktest}
                  onChange={(e) => updateScanner("defaultBacktest", e.target.value)}
                  onBlur={(e) => apiSaveSetting("scanner:defaultBacktest", e.target.value).catch(() => {})} />
              </SettingRow>
              <SettingRow label="Auto-Refresh Folder" description="Automatically reload CSV folder on launch">
                <ToggleSwitch checked={scanner.autoRefresh} onChange={() => updateScanner("autoRefresh", !scanner.autoRefresh)} />
              </SettingRow>
              <SettingRow label="Show Volume Column" description="Display volume in scan results">
                <ToggleSwitch checked={scanner.showVolume} onChange={() => updateScanner("showVolume", !scanner.showVolume)} />
              </SettingRow>
              <SettingRow label="Show Saved Scans Bar" description="Display the quick-access saved scans strip in Create Scan and Strategies Backtest pages">
                <ToggleSwitch
                  checked={scanner.showSavedScans}
                  onChange={() => {
                    const next = !scanner.showSavedScans;
                    localStorage.setItem("bharatscan:show-saved-scans", String(next));
                    setScanner(p => ({ ...p, showSavedScans: next }));
                  }}
                />
              </SettingRow>
              <SettingRow label="Home Index Price Source" description="Choose whether Nifty 50, Bank Nifty & Fin Nifty cards show Futures or Spot prices">
                <div className="flex items-center gap-1 p-0.5 rounded-md border border-border bg-input">
                  {(["Futures", "Spot"] as const).map((opt) => {
                    const val = opt.toLowerCase() as "futures" | "spot";
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          localStorage.setItem("bharatscan:home-index-source", val);
                          setScanner(p => ({ ...p, homeIndexSource: val }));
                        }}
                        className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors ${
                          scanner.homeIndexSource === val
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </SettingRow>
            </SectionCard>
          )}

          {/* API / Data Source */}
          {activeSection === "data" && (
            <div className="space-y-4">
              <MarketApiPanel />
              <DataSourcePanels />
              <SectionCard title="Symbol Master" icon={Database}>
                <SettingRow
                  label="Refresh Symbol Master"
                  description="Downloads the full NSE symbol list from Fyers (≈2,000 equities) and tags Nifty 50 / 100 / 500 membership. Runs automatically every Monday at 7 AM IST."
                >
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-xs h-7 px-3"
                    onClick={handleRefreshSymbolMaster}
                    disabled={symbolRefreshing}
                  >
                    {symbolRefreshing
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />
                    }
                    {symbolRefreshing ? "Refreshing…" : "Refresh Now"}
                  </Button>
                </SettingRow>
                {marketStatus && (() => {
                  const job = marketStatus.nightlySync.symbolMaster;
                  return (
                    <div className="flex items-center justify-between text-[10px] pt-1">
                      <span className="text-muted-foreground">Last sync attempt</span>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={
                            job.status === "completed"
                              ? "text-emerald-400"
                              : job.status === "failed"
                              ? "text-red-400"
                              : "text-muted-foreground"
                          }
                        >
                          {job.status === "completed"
                            ? `Succeeded — ${job.symbolsCompleted} upserted`
                            : job.status === "failed"
                            ? "Failed"
                            : "Never run"}
                        </span>
                        {(job.finishedAt ?? job.startedAt) && (
                          <span className="font-mono text-muted-foreground/70">
                            {formatDate(job.finishedAt ?? job.startedAt)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {marketStatus?.nightlySync.symbolMaster.status === "failed" &&
                  marketStatus.nightlySync.symbolMaster.errorMessage && (
                    <p className="text-[10px] text-red-400 pt-1">
                      {marketStatus.nightlySync.symbolMaster.errorMessage}
                    </p>
                  )}
              </SectionCard>

              {/* ── Database Status ─────────────────────────────────────── */}
              <SectionCard title="Database Status" icon={HardDrive}>
                <div className="py-3 space-y-3">
                  {marketStatusLoading && !marketStatus && (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}

                  {!marketStatusLoading && !marketStatus && (
                    <p className="text-[10px] text-muted-foreground py-2">
                      Could not load database status.
                    </p>
                  )}

                  {marketStatus && (
                    <>
                      {/* Symbol counts */}
                      {marketStatus.symbolStats && (
                        <div className="space-y-1.5">
                          <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50">
                            Symbol Universe
                          </span>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-center">
                              <p className="text-sm font-bold text-foreground leading-none">
                                {marketStatus.symbolStats.total.toLocaleString()}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Total</p>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-center">
                              <p className={`text-sm font-bold leading-none ${marketStatus.symbolStats.withEodData > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                                {marketStatus.symbolStats.withEodData.toLocaleString()}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">With EOD data</p>
                            </div>
                            <div className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-center">
                              <p className={`text-sm font-bold leading-none ${marketStatus.symbolStats.fyersInvalid > 0 ? "text-amber-400" : "text-muted-foreground"}`}>
                                {marketStatus.symbolStats.fyersInvalid.toLocaleString()}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Fyers invalid</p>
                            </div>
                          </div>
                          {marketStatus.symbolStats.fyersInvalid > 0 && (
                            <p className="text-[10px] text-muted-foreground">
                              Invalid symbols are permanently excluded from nightly EOD sync.
                            </p>
                          )}
                        </div>
                      )}

                      {/* DB file sizes */}
                      <div className="space-y-1.5 pt-1 border-t border-border/30">
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50">
                          Storage
                        </span>
                        <div className="grid grid-cols-2 gap-2 text-[10px]">
                          {[
                            { label: "app.db", size: marketStatus.databases.app_db_mb, note: "Accounts & settings" },
                            { label: "market.db", size: marketStatus.databases.market_db_mb, note: "OHLCV · intraday · symbols" },
                          ].map(({ label, size, note }) => (
                            <div key={label} className="rounded-md border border-border bg-muted/20 px-2.5 py-2 text-center">
                              <p className="text-sm font-bold text-foreground leading-none font-mono">
                                {size} <span className="text-[9px] font-normal text-muted-foreground">MB</span>
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{label}</p>
                              <p className="text-[9px] text-muted-foreground/50 mt-0.5">{note}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* NSE holidays */}
                      {marketStatus.nseHolidaysCount !== undefined && (
                        <div className="flex items-center justify-between text-[10px] pt-1 border-t border-border/30">
                          <span className="text-muted-foreground">NSE holidays loaded</span>
                          <span className={`font-mono ${marketStatus.nseHolidaysCount === 0 ? "text-amber-400" : "text-foreground"}`}>
                            {marketStatus.nseHolidaysCount === 0
                              ? "None — trading-day checks may be incorrect"
                              : `${marketStatus.nseHolidaysCount} days`}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </SectionCard>

              <SectionCard title="CSV Format Settings" icon={Database}>
                <SettingRow label="CSV Date Format" description="Date format in your NSE CSV files">
                  <span className="text-xs text-foreground bg-muted px-2 py-1 rounded font-mono">YYYY-MM-DD</span>
                </SettingRow>
                <SettingRow label="Symbol Column" description="Column name for stock ticker">
                  <span className="text-xs text-foreground bg-muted px-2 py-1 rounded font-mono">SYMBOL</span>
                </SettingRow>
                <SettingRow label="Volume Column" description="Column name for trade volume">
                  <span className="text-xs text-foreground bg-muted px-2 py-1 rounded font-mono">TOTTRDQTY</span>
                </SettingRow>
                <SettingRow label="Max Symbols to Load" description="Cap on number of symbols loaded from CSV">
                  <span className="text-xs text-foreground bg-muted px-2 py-1 rounded font-mono">5000</span>
                </SettingRow>
                <div className="py-2">
                  <p className="text-[10px] text-muted-foreground">
                    BharatScan processes all data locally — no API keys required. Your CSV files never leave your device.
                  </p>
                </div>
              </SectionCard>
            </div>
          )}

          {/* Import / Export */}
          {activeSection === "import" && (
            <SectionCard title="Import / Export Settings" icon={FileInput}>
              <SettingRow label="Export All Saved Scans" description="Download all scan configurations as a JSON file">
                <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={handleExportAllScans} disabled={exporting}>
                  {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  Export All
                </Button>
              </SettingRow>
              <SettingRow label="Import Scan Pack" description="Load multiple scan configurations from a JSON file">
                <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={() => importScansRef.current?.click()} disabled={importingScans}>
                  {importingScans ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                  Import Pack
                </Button>
                <input ref={importScansRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportScansFile} />
              </SettingRow>
              <SettingRow label="Export Results as CSV" description="Default format for scan result exports">
                <span className="text-xs text-foreground bg-muted px-2 py-1 rounded">CSV (comma-separated)</span>
              </SettingRow>
              <SettingRow label="Clear All Data" description="Wipe all saved scans, alerts, portfolios and localStorage">
                <Button size="sm" variant="outline" className="text-xs h-7 px-3 text-destructive-bright border-destructive-bright/40 hover:bg-destructive-bright/10"
                  onClick={() => setClearDialogOpen(true)}>
                  <Trash2 className="h-3 w-3" /> Clear All
                </Button>
              </SettingRow>
            </SectionCard>
          )}

          {/* Clear All confirmation dialog */}
          {clearDialogOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <Card className="w-96 p-4 space-y-3 shadow-xl border-destructive/30">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
                    <Trash2 className="h-5 w-5 text-destructive-bright" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">Clear All Data</h3>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      This will permanently delete all saved scans, alerts, portfolios, holdings, scanner dashboards, and local preferences. This action cannot be undone.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={() => setClearDialogOpen(false)} disabled={clearing}>
                    Cancel
                  </Button>
                  <Button size="sm" className="text-xs h-7 px-3 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={handleClearAll} disabled={clearing}>
                    {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    Yes, Clear Everything
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {/* Security */}
          {activeSection === "security" && (
            <SectionCard title="Security Settings" icon={Shield}>
              <SettingRow label="Data Privacy" description="All computation runs 100% in your browser">
                <span className="text-[10px] font-bold text-success bg-success/10 px-2 py-0.5 rounded border border-success/20">Fully Local</span>
              </SettingRow>
              <SettingRow label="Network Requests" description="BharatScan never makes external API calls">
                <span className="text-[10px] font-bold text-success bg-success/10 px-2 py-0.5 rounded border border-success/20">Offline Ready</span>
              </SettingRow>
              <SettingRow label="Session Timeout" description="Automatically clear state after inactivity">
                <ToggleSwitch checked={false} onChange={() => {}} />
              </SettingRow>
              <div className="py-2 text-[10px] text-muted-foreground">
                Your bhavcopy data, scan configurations, and portfolio details are stored only in your browser's localStorage and local SQLite database. Nothing is transmitted to any external server.
              </div>
            </SectionCard>
          )}

          {/* Backup / Restore */}
          {activeSection === "backup" && (
            <div className="space-y-4">
              {/* Backup */}
              <SectionCard title="Create Backup" icon={Download}>
                <div className="py-3 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Downloads a complete <span className="text-foreground font-medium">.json</span> file containing all your saved scans, portfolios, dashboards, alerts, scanner dashboards, paper trading accounts, app settings, and local preferences. Keep it safe — you can restore everything from this file.
                  </p>

                  <div className="grid grid-cols-2 gap-3 text-[11px]">
                    {[
                      "Saved scans", "Portfolio dashboards", "Holdings & trades",
                      "Price alerts", "Scanner dashboards", "Paper trading accounts",
                      "App settings & preferences",
                    ].map((item) => (
                      <div key={item} className="flex items-center gap-1.5 text-muted-foreground">
                        <Check className="h-3 w-3 text-success shrink-0" />
                        {item}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-border/50">
                    <div>
                      <p className="text-[11px] text-muted-foreground">Last backup</p>
                      <p className="text-xs font-medium text-foreground">{formatDate(lastBackup)}</p>
                    </div>
                    <Button
                      size="sm"
                      className="bg-gradient-primary text-primary-foreground hover:opacity-90 text-xs gap-1.5 h-7 px-3"
                      onClick={handleBackup}
                      disabled={backupBusy}
                    >
                      {backupBusy
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Backing up…</>
                        : <><Download className="h-3.5 w-3.5" /> Download Backup</>
                      }
                    </Button>
                  </div>
                </div>
              </SectionCard>

              {/* Restore */}
              <SectionCard title="Restore from Backup" icon={Upload}>
                <div className="py-3 space-y-3">
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Select a previously downloaded <span className="text-foreground font-medium">bharatscan-backup-*.json</span> file to restore. This will <span className="text-destructive font-medium">replace all existing data</span> — scans, portfolios, alerts, and settings — with the backup contents.
                  </p>

                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-2.5 text-[11px] text-destructive flex items-start gap-2">
                    <span className="shrink-0 mt-0.5">⚠️</span>
                    <span>All current data will be cleared before restoring. Create a fresh backup first if you want to keep your current data.</span>
                  </div>

                  {restoreLog.length > 0 && (
                    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1 max-h-40 overflow-y-auto">
                      {restoreLog.map((msg, i) => (
                        <p key={i} className="text-[11px] text-muted-foreground font-mono">
                          {i === restoreLog.length - 1 && restoreBusy
                            ? <><Loader2 className="inline h-2.5 w-2.5 animate-spin mr-1" />{msg}</>
                            : <><Check className="inline h-2.5 w-2.5 text-success mr-1" />{msg}</>
                          }
                        </p>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end">
                    <input
                      ref={restoreInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={handleRestoreFile}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-xs gap-1.5 h-7 px-3 border-destructive/40 text-destructive hover:bg-destructive/10"
                      onClick={() => restoreInputRef.current?.click()}
                      disabled={restoreBusy}
                    >
                      {restoreBusy
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Restoring…</>
                        : <><Upload className="h-3.5 w-3.5" /> Choose Backup File</>
                      }
                    </Button>
                  </div>
                </div>
              </SectionCard>
            </div>
          )}

          {/* Restore preview / confirmation dialog */}
          {pendingRestore && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
              <Card className="w-[30rem] p-4 space-y-3 shadow-xl border-destructive/30 max-h-[85vh] overflow-y-auto">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-destructive/10 shrink-0">
                    <Upload className="h-5 w-5 text-destructive-bright" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground">Restore This Backup?</h3>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Created {formatDate(pendingRestore.summary.createdAt)} · format v{pendingRestore.summary.version}
                    </p>
                  </div>
                </div>

                <div className="space-y-1 py-1">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground/70 px-0.5">
                    <span>Item</span>
                    <span className="flex items-center gap-3">
                      <span className="w-14 text-right">Current</span>
                      <span className="w-14 text-right">Backup</span>
                    </span>
                  </div>
                  {[
                    { label: "Saved scans", value: pendingRestore.summary.scans, current: currentDataSummary?.scans, hint: pendingRestore.summary.favoriteScans ? `${pendingRestore.summary.favoriteScans} favorited` : undefined },
                    { label: "Portfolio dashboards", value: pendingRestore.summary.dashboards, current: currentDataSummary?.dashboards },
                    { label: "Portfolios", value: pendingRestore.summary.portfolios, current: currentDataSummary?.portfolios },
                    { label: "Holdings", value: pendingRestore.summary.holdings, current: currentDataSummary?.holdings },
                    { label: "Booked trades", value: pendingRestore.summary.bookedTrades, current: currentDataSummary?.bookedTrades },
                    { label: "Price alerts", value: pendingRestore.summary.alerts, current: currentDataSummary?.alerts },
                    { label: "Scanner dashboards", value: pendingRestore.summary.scannerDashboards, current: currentDataSummary?.scannerDashboards },
                    { label: "Scanner scans", value: pendingRestore.summary.scannerScans, current: currentDataSummary?.scannerScans },
                    { label: "Paper trading accounts", value: pendingRestore.summary.paperAccounts, current: currentDataSummary?.paperAccounts },
                    { label: "Paper positions & trades", value: pendingRestore.summary.paperPositions + pendingRestore.summary.paperTrades, current: currentDataSummary ? currentDataSummary.paperPositions + currentDataSummary.paperTrades : undefined },
                    { label: "Settings", value: pendingRestore.summary.settings, current: currentDataSummary?.settings },
                    { label: "Local preferences", value: pendingRestore.summary.localPreferences, current: currentDataSummary?.localPreferences },
                  ].map((row) => {
                    const willLose = (row.current ?? 0) > 0;
                    return (
                      <div key={row.label} className="flex items-center justify-between border-b border-border/40 py-1 text-[11px]">
                        <span className="text-muted-foreground">
                          {row.label}
                          {row.hint ? <span className="text-muted-foreground/70"> ({row.hint})</span> : null}
                        </span>
                        <span className="flex items-center gap-3">
                          <span className={`w-14 text-right ${willLose ? "text-destructive" : "text-muted-foreground"}`}>
                            {currentDataLoading ? <Loader2 className="inline h-2.5 w-2.5 animate-spin" /> : row.current ?? "—"}
                          </span>
                          <span className="w-14 text-right text-foreground font-medium">{row.value}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive flex items-start gap-2">
                  <span className="shrink-0 mt-0.5">⚠️</span>
                  <span>
                    {currentDataLoading
                      ? "Checking your current data…"
                      : "The Current column above will be permanently deleted and replaced with the Backup column. This cannot be undone."}
                  </span>
                </div>

                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="outline" className="text-xs h-7 px-3" onClick={() => setPendingRestore(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" className="text-xs h-7 px-3 bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={handleConfirmRestore}>
                    <Upload className="h-3 w-3" /> Yes, Restore
                  </Button>
                </div>
              </Card>
            </div>
          )}

          {/* Broker Connect */}
          {activeSection === "broker" && (
            <SectionCard title="Broker Connections" icon={Plug}>
              <div className="py-3 space-y-3">

                {/* Loading */}
                {brokersLoading && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {/* Broker rows */}
                {!brokersLoading && brokers.map(broker => {
                  const totp = brokerTotps[broker.id] ?? "";
                  const connecting    = brokerBusy[`connect:${broker.id}`]    ?? false;
                  const disconnecting = brokerBusy[`disconnect:${broker.id}`] ?? false;
                  const deleting      = brokerBusy[`delete:${broker.id}`]     ?? false;
                  const needsTotp     = broker.status !== "connected";
                  const meta          = BROKER_STATUS_META[broker.status] ?? BROKER_STATUS_META.disconnected;
                  const isRetryable   =
                    broker.status === "session_expired" ||
                    broker.status === "invalid_credentials" ||
                    broker.status === "login_failed" ||
                    broker.status === "broker_unavailable";

                  return (
                    <div key={broker.id} className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
                      {/* Header row */}
                      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${meta.dotCls}`} />
                          <span className="text-xs font-semibold truncate">{broker.display_name}</span>
                          <span className={`text-[10px] shrink-0 font-medium ${meta.textCls}`}>{meta.label}</span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          {broker.status === "connected" && (
                            <Button variant="ghost" size="icon" className="h-6 w-6" title="Disconnect" disabled={disconnecting}
                              onClick={() => handleBrokerDisconnect(broker.id)}>
                              {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" className="h-6 w-6 hover:text-destructive" title="Remove" disabled={deleting}
                            onClick={() => handleBrokerDelete(broker.id)}>
                            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </div>
                      </div>

                      {/* Details + TOTP */}
                      <div className="px-3 py-2 space-y-2">
                        {broker.token_generated_at && (
                          <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Last Connected</span>
                              {formatDate(broker.token_generated_at)}
                            </div>
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Estimated Valid Until</span>
                              {(() => {
                                const d = new Date(broker.token_generated_at);
                                d.setHours(d.getHours() + 24);
                                return formatDate(d.toISOString());
                              })()}
                              <p className="mt-1 text-[9px] text-muted-foreground/60 leading-snug">Fyers token lifetime can vary — if live data stops working, re-connect regardless of this estimate.</p>
                            </div>
                          </div>
                        )}
                        {needsTotp && broker.broker_name === "fyers" && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="bg-muted rounded-full h-4 w-4 flex items-center justify-center text-[9px] font-bold shrink-0">1</span>
                              Open the Fyers auth page and log in, then copy the auth code from the redirect URL.
                            </div>
                            <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 px-3 w-full"
                              disabled={brokerBusy[`authurl:${broker.id}`] ?? false}
                              onClick={() => handleGetFyersAuthUrl(broker.id)}>
                              {brokerBusy[`authurl:${broker.id}`]
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <ExternalLink className="h-3 w-3" />}
                              Open Fyers Auth Page
                            </Button>
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-0.5">
                              <span className="bg-muted rounded-full h-4 w-4 flex items-center justify-center text-[9px] font-bold shrink-0">2</span>
                              Paste the <code className="font-mono">auth_code</code> from the redirect URL below.
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                value={totp}
                                onChange={e => setBrokerTotps(prev => ({ ...prev, [broker.id]: e.target.value.trim() }))}
                                placeholder="Paste auth_code here"
                                className="h-7 text-xs font-mono bg-input flex-1 min-w-0"
                              />
                              <Button size="sm" className="h-7 text-xs gap-1 px-3 shrink-0"
                                disabled={!totp || connecting}
                                onClick={() => handleBrokerConnect(broker.id)}>
                                {connecting
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : isRetryable
                                  ? <><RefreshCw className="h-3 w-3" />Retry</>
                                  : <><PlugZap className="h-3 w-3" />Connect</>}
                              </Button>
                            </div>
                          </div>
                        )}
                        {needsTotp && broker.broker_name !== "fyers" && (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <Input
                                value={totp}
                                onChange={e => setBrokerTotps(prev => ({ ...prev, [broker.id]: e.target.value.replace(/\D/g, "").slice(0, 6) }))}
                                placeholder="6-digit TOTP"
                                maxLength={6}
                                className="h-7 text-xs font-mono w-28 shrink-0 bg-input"
                              />
                              <Button size="sm" className="h-7 text-xs gap-1 px-3" disabled={totp.length < 6 || connecting}
                                onClick={() => handleBrokerConnect(broker.id)}>
                                {connecting
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : isRetryable
                                  ? <><RefreshCw className="h-3 w-3" />Retry</>
                                  : <><PlugZap className="h-3 w-3" />Connect</>}
                              </Button>
                            </div>
                            {broker.status === "invalid_credentials" && (
                              <p className="text-[10px] text-destructive-bright">
                                Saved API key / client code / PIN were rejected. Double-check them (edit via Delete + re-add), then enter a fresh TOTP.
                              </p>
                            )}
                            {broker.status === "login_failed" && (
                              <p className="text-[10px] text-destructive-bright">
                                Login rejected — the TOTP was likely wrong or expired. Enter a fresh 6-digit code and retry.
                              </p>
                            )}
                            {broker.status === "broker_unavailable" && (
                              <p className="text-[10px] text-orange-400">
                                Could not reach the broker's servers. Try again in a few minutes.
                              </p>
                            )}
                          </div>
                        )}
                        {broker.status === "session_expired" && (
                          <p className="text-[10px] text-amber-400">
                            Your session expired and was not renewed automatically — re-authenticate above to reconnect.
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Empty state */}
                {!brokersLoading && brokers.length === 0 && !showAddBroker && (
                  <p className="py-3 text-center text-xs text-muted-foreground/60">No brokers added yet.</p>
                )}

                {/* Add broker form */}
                {showAddBroker && (
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-3">
                    {/* Broker type selector */}
                    <div className="flex gap-1 p-0.5 rounded-md bg-muted/50 border border-border/50">
                      {([["angel_one", "Angel One"], ["fyers", "Fyers"]] as const).map(([val, label]) => (
                        <button key={val} type="button"
                          className={`flex-1 text-[10px] font-semibold py-1 rounded transition-colors ${addBrokerType === val ? "bg-background shadow text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                          onClick={() => {
                            setAddBrokerType(val);
                            setAddBrokerForm({ display_name: val === "fyers" ? "Fyers" : "Angel One", api_key: "", client_code: "", pin: "" });
                          }}>
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* Angel One fields */}
                    {addBrokerType === "angel_one" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">Display Name</p>
                          <Input value={addBrokerForm.display_name}
                            onChange={e => setAddBrokerForm(f => ({ ...f, display_name: e.target.value }))}
                            placeholder="Angel One" className="h-7 text-xs bg-input" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">Client Code</p>
                          <Input value={addBrokerForm.client_code}
                            onChange={e => setAddBrokerForm(f => ({ ...f, client_code: e.target.value }))}
                            placeholder="e.g. A123456" autoComplete="off" className="h-7 text-xs font-mono bg-input" />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <p className="text-[10px] text-muted-foreground">API Key (SmartAPI)</p>
                          <Input value={addBrokerForm.api_key}
                            onChange={e => setAddBrokerForm(f => ({ ...f, api_key: e.target.value }))}
                            placeholder="SmartAPI key" autoComplete="off" className="h-7 text-xs font-mono bg-input" />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <p className="text-[10px] text-muted-foreground">PIN</p>
                          <Input type="password" value={addBrokerForm.pin}
                            onChange={e => setAddBrokerForm(f => ({ ...f, pin: e.target.value }))}
                            placeholder="4-digit login PIN" autoComplete="new-password" className="h-7 text-xs bg-input" />
                        </div>
                      </div>
                    )}

                    {/* Fyers fields */}
                    {addBrokerType === "fyers" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">Display Name</p>
                          <Input value={addBrokerForm.display_name}
                            onChange={e => setAddBrokerForm(f => ({ ...f, display_name: e.target.value }))}
                            placeholder="Fyers" className="h-7 text-xs bg-input" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">App ID</p>
                          <Input value={addBrokerForm.api_key}
                            onChange={e => setAddBrokerForm(f => ({ ...f, api_key: e.target.value }))}
                            placeholder="e.g. XY1234-100" autoComplete="off" className="h-7 text-xs font-mono bg-input" />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <p className="text-[10px] text-muted-foreground">Secret Key</p>
                          <Input type="password" value={addBrokerForm.client_code}
                            onChange={e => setAddBrokerForm(f => ({ ...f, client_code: e.target.value }))}
                            placeholder="App secret from Fyers API dashboard" autoComplete="new-password" className="h-7 text-xs font-mono bg-input" />
                        </div>
                        <div className="col-span-2 space-y-1">
                          <p className="text-[10px] text-muted-foreground">Redirect URI</p>
                          <Input value={addBrokerForm.pin}
                            onChange={e => setAddBrokerForm(f => ({ ...f, pin: e.target.value }))}
                            placeholder="https://your-redirect-uri" autoComplete="off" className="h-7 text-xs font-mono bg-input" />
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] text-muted-foreground/60">Credentials are encrypted with AES-256-GCM before storage and never leave the server.</p>
                    <div className="flex justify-end gap-2 pt-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs px-3"
                        onClick={() => setShowAddBroker(false)}>Cancel</Button>
                      <Button size="sm" className="h-7 text-xs gap-1 px-3"
                        disabled={!addBrokerForm.api_key || !addBrokerForm.client_code || !addBrokerForm.pin || addBrokerSaving}
                        onClick={handleAddBroker}>
                        {addBrokerSaving && <Loader2 className="h-3 w-3 animate-spin" />}
                        Save Credentials
                      </Button>
                    </div>
                  </div>
                )}

                {/* Add button */}
                {!showAddBroker && (
                  <div className="pt-1 flex justify-end border-t border-border/30">
                    <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5 px-3 mt-2"
                      onClick={() => setShowAddBroker(true)}>
                      <Plus className="h-3 w-3" /> Add Broker
                    </Button>
                  </div>
                )}
              </div>
            </SectionCard>
          )}

          {activeSection === "broker" && schedulerStatus?.catchUp?.active && (
            <div className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400 shrink-0" />
              <p className="text-[11px] text-amber-300">
                Catching up {schedulerStatus.catchUp.jobName ?? "sync job"}
                {schedulerStatus.catchUp.currentDate ? ` (${schedulerStatus.catchUp.currentDate})` : ""}:{" "}
                {schedulerStatus.catchUp.completedCount} of {schedulerStatus.catchUp.totalCount} missed trading day
                {schedulerStatus.catchUp.totalCount === 1 ? "" : "s"}
              </p>
            </div>
          )}

          {activeSection === "broker" && (
            <SectionCard title="Live Feed Schedule" icon={Clock}>
              <div className="py-3 space-y-2">
                {schedulerLoading && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!schedulerLoading && !schedulerStatus && (
                  <p className="text-[10px] text-muted-foreground py-2">Could not load scheduler status.</p>
                )}

                {!schedulerLoading && schedulerStatus && (
                  <>
                    <div className="flex items-center gap-2 pb-1">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${schedulerStatus.active || schedulerStatus.runsInSeparateProcess ? "bg-emerald-400" : "bg-muted-foreground/30"}`} />
                      <span className={`text-[10px] font-medium ${schedulerStatus.active || schedulerStatus.runsInSeparateProcess ? "text-emerald-400" : "text-muted-foreground"}`}>
                        {schedulerStatus.active
                          ? "Scheduler active in this process"
                          : schedulerStatus.runsInSeparateProcess
                          ? "Running in separate scheduler process"
                          : "Not running in this process"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Market Open Now</span>
                        <span className={`inline-flex items-center gap-1 font-medium ${schedulerStatus.liveFeed.marketOpenNow ? "text-emerald-400" : "text-muted-foreground"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${schedulerStatus.liveFeed.marketOpenNow ? "bg-emerald-400" : "bg-muted-foreground/30"}`} />
                          {schedulerStatus.liveFeed.marketOpenNow ? "Yes" : "No"}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Feed Connected</span>
                        <span className={`inline-flex items-center gap-1 font-medium ${schedulerStatus.liveFeed.connected ? "text-emerald-400" : "text-muted-foreground"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${schedulerStatus.liveFeed.connected ? "bg-emerald-400" : "bg-muted-foreground/30"}`} />
                          {schedulerStatus.liveFeed.connected ? "Yes" : "No"}
                        </span>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 pt-1">
                      Reconciled every {schedulerStatus.liveFeed.reconcileIntervalMinutes} min · window {formatCronHourMinute(schedulerStatus.liveFeed.liveOpenExpression)}–{formatCronHourMinute(schedulerStatus.liveFeed.liveCloseExpression)} IST
                    </p>
                    <p className="text-[10px] text-muted-foreground/60">Timezone: {schedulerStatus.timezone}</p>
                  </>
                )}
              </div>
            </SectionCard>
          )}

          {activeSection === "broker" && (
            <SectionCard title="Backfill Dashboard" icon={Database}>
              <div className="py-3 space-y-3">
                {marketStatusLoading && !marketStatus && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!marketStatusLoading && !marketStatus && (
                  <p className="text-[10px] text-muted-foreground py-2">Could not load backfill status.</p>
                )}

                {marketStatus && (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>Requests used today</span>
                        <span className="font-mono text-foreground">
                          {marketStatus.backfill.dailyRequestsUsed} / {marketStatus.backfill.dailyRequestBudget}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            marketStatus.backfill.remainingBudgetToday === 0 ? "bg-red-400" : "bg-emerald-400"
                          }`}
                          style={{
                            width: `${Math.min(
                              100,
                              (marketStatus.backfill.dailyRequestsUsed /
                                Math.max(1, marketStatus.backfill.dailyRequestBudget)) *
                                100
                            )}%`,
                          }}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Queue Depth</span>
                        <span className="text-foreground font-mono">{marketStatus.backfill.queueDepth}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Worker</span>
                        <span className={marketStatus.backfill.workerRunning ? "text-emerald-400" : "text-muted-foreground"}>
                          {marketStatus.backfill.workerRunning ? "Running" : "Idle"}
                        </span>
                      </div>
                    </div>

                    {(() => {
                      const backfill = marketStatus.historicalBackfill;
                      const statusLabel = !backfill
                        ? "Not started"
                        : backfill.status === "running"
                        ? "Running"
                        : backfill.status === "completed"
                        ? "Completed"
                        : backfill.pauseReason === "daily_budget"
                        ? "Paused — daily budget exhausted"
                        : backfill.pauseReason === "session_expired"
                        ? "Paused — reconnect broker"
                        : backfill.pauseReason === "no_broker"
                        ? "Paused — no broker connected"
                        : backfill.pauseReason === "retryable_failures"
                        ? "Paused — retryable failures"
                        : "Paused";
                      const progress =
                        backfill && backfill.totalTasks > 0
                          ? Math.min(
                              100,
                              ((backfill.completedTasks + backfill.invalidTasks) /
                                backfill.totalTasks) *
                                100
                            )
                          : 0;
                      return (
                        <div className="pt-2 border-t border-border/30 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">
                                Historical EOD Backfill
                              </span>
                              <span
                                className={`text-[10px] font-medium ${
                                  !backfill || backfill.status === "paused"
                                    ? "text-amber-400"
                                    : backfill.status === "completed"
                                    ? "text-emerald-400"
                                    : "text-sky-400"
                                }`}
                              >
                                {statusLabel}
                              </span>
                            </div>
                            {!backfill || backfill.status === "completed" ? (
                              <Button
                                size="sm"
                                className="h-6 text-[10px] px-2"
                                onClick={() => updateHistoricalBackfill("start")}
                                disabled={historicalBackfillBusy}
                              >
                                {historicalBackfillBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  "Start"
                                )}
                              </Button>
                            ) : backfill.status === "running" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 text-[10px] px-2"
                                onClick={() => updateHistoricalBackfill("pause")}
                                disabled={historicalBackfillBusy}
                              >
                                Pause
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                className="h-6 text-[10px] px-2"
                                onClick={() => updateHistoricalBackfill("resume")}
                                disabled={historicalBackfillBusy}
                              >
                                {historicalBackfillBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  "Resume"
                                )}
                              </Button>
                            )}
                          </div>
                          {backfill && (
                            <>
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>
                                  {backfill.fromDate} → {backfill.toDate} · {backfill.universe}
                                </span>
                                <span className="font-mono text-foreground">
                                  {Math.round(progress)}%
                                </span>
                              </div>
                              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-sky-400 transition-all"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                                <div>
                                  <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">
                                    Symbols
                                  </span>
                                  <span className="text-foreground font-mono">
                                    {backfill.completedSymbols} / {backfill.totalSymbols}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">
                                    Requests
                                  </span>
                                  <span className="text-foreground font-mono">
                                    {backfill.requestsUsed}
                                  </span>
                                </div>
                                <div>
                                  <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">
                                    Retryable
                                  </span>
                                  <span
                                    className={
                                      backfill.retryableTasks > 0
                                        ? "text-amber-400 font-mono"
                                        : "text-foreground font-mono"
                                    }
                                  >
                                    {backfill.retryableTasks}
                                  </span>
                                </div>
                              </div>
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>Persisted range</span>
                                <span className="font-mono text-foreground">
                                  {backfill.earliestPersistedDate ?? "—"} →{" "}
                                  {backfill.latestPersistedDate ?? "—"}
                                </span>
                              </div>
                              {backfill.pauseReason && (
                                <p className="text-[10px] text-amber-400">
                                  {backfill.pauseReason === "daily_budget"
                                    ? "Available again after the daily budget resets."
                                    : backfill.pauseReason === "retryable_failures"
                                    ? "Resume to retry chunks with no data or temporary errors."
                                    : "Resume after reconnecting or correcting the broker session."}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })()}

                    <div className="pt-1 border-t border-border/30">
                      <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-1">
                        Per-Symbol Progress
                      </span>
                      {marketStatus.backfill.symbols.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground py-1">No pending backfill work.</p>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {marketStatus.backfill.symbols.map((s) => (
                            <div
                              key={`${s.symbol}-${s.resolution}`}
                              className="flex items-center justify-between text-[10px] py-1 border-b border-border/20 last:border-0"
                            >
                              <span className="font-mono text-foreground">{s.symbol}</span>
                              <span className="text-muted-foreground">{s.resolution}</span>
                              <span className="text-muted-foreground">{s.chunksRemaining} chunks left</span>
                              <span className="text-muted-foreground">
                                ~{s.estimatedDaysToComplete} day{s.estimatedDaysToComplete === 1 ? "" : "s"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </SectionCard>
          )}

          {activeSection === "broker" && (
            <SectionCard title="Nightly Sync Jobs" icon={Clock}>
              <div className="py-3 space-y-3">
                {marketStatusLoading && !marketStatus && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!marketStatusLoading && !marketStatus && (
                  <p className="text-[10px] text-muted-foreground py-2">Could not load nightly sync status.</p>
                )}

                {marketStatus && (
                  <>
                    {(() => {
                      const brokerCurrentlyConnected = brokers.some((b) => b.status === "connected");
                      return [
                      { label: "EOD Sync (4:00 PM IST)", job: marketStatus.nightlySync.eod },
                      { label: "Intraday Sync (4:30 PM IST)", job: marketStatus.nightlySync.intraday },
                      { label: "Options Sync (5:00 PM IST)", job: marketStatus.nightlySync.options },
                    ].map(({ label, job }) => {
                      const isStaleNoBrokerFailure =
                        job.status === "failed" &&
                        job.errorMessage?.toLowerCase().includes("no broker connected") &&
                        brokerCurrentlyConnected;
                      return (
                      <div key={job.jobName} className="pb-2 border-b border-border/20 last:border-0 last:pb-0 space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <span className="text-foreground font-medium">{label}</span>
                          <span
                            className={
                              job.status === "completed"
                                ? "text-emerald-400"
                                : job.status === "failed"
                                ? "text-red-400"
                                : "text-muted-foreground"
                            }
                          >
                            {job.status ?? "never run"}
                          </span>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>Last run</span>
                          <span className="font-mono text-foreground">{formatDate(job.finishedAt ?? job.startedAt)}</span>
                        </div>
                        {job.status === "failed" && job.errorMessage && (
                          <p className="text-[10px] text-red-400">{job.errorMessage}</p>
                        )}
                        {isStaleNoBrokerFailure && (
                          <p className="text-[10px] text-amber-400">
                            Failed before this login — broker is connected now, will retry at next scheduled run.
                          </p>
                        )}
                        {job.status !== "failed" && (
                          <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Completed</span>
                              <span className="text-emerald-400 font-mono">{job.symbolsCompleted}</span>
                            </div>
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Skipped (budget)</span>
                              <span className="text-amber-400 font-mono">{job.symbolsSkippedBudget}</span>
                            </div>
                            <div>
                              <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Failed</span>
                              <span className="text-red-400 font-mono">{job.symbolsFailed}</span>
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                    )()}
                  </>
                )}
              </div>
            </SectionCard>
          )}

          {activeSection === "broker" && (
            <SectionCard title="Quote Cache Diagnostics" icon={Database}>
              <div className="py-3 space-y-3">
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[10px] gap-1 px-2"
                    onClick={handleResetQuoteCacheStats}
                    disabled={quoteCacheResetting}
                  >
                    {quoteCacheResetting ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Reset Stats
                  </Button>
                </div>

                {quoteCacheLoading && !quoteCacheStats && (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                )}

                {!quoteCacheLoading && !quoteCacheStats && (
                  <p className="text-[10px] text-muted-foreground py-2">Could not load quote cache stats.</p>
                )}

                {quoteCacheStats && (
                  <>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>Cache hit rate (symbols)</span>
                        <span className="font-mono text-foreground">
                          {quoteCacheStats.cacheHitRate === null
                            ? "—"
                            : `${(quoteCacheStats.cacheHitRate * 100).toFixed(1)}%`}
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-400"
                          style={{ width: `${(quoteCacheStats.cacheHitRate ?? 0) * 100}%` }}
                        />
                      </div>
                    </div>

                    {quoteCacheHistory.length > 1 && (
                      <div className="space-y-1">
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50">
                          Cache-Hit Rate Trend (last {quoteCacheHistory.length} samples)
                        </span>
                        <div className="h-16 w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={quoteCacheHistory}>
                              <YAxis domain={[0, 100]} hide />
                              <Line
                                type="monotone"
                                dataKey="rate"
                                stroke="hsl(var(--primary))"
                                strokeWidth={1.5}
                                dot={false}
                                isAnimationActive={false}
                              />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground">
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Total Requests</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.totalRequests}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">REST Calls Made</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.restCallsMade}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Fully Cached Requests</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.requestsFullyCached}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Requests w/ Fallback</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.requestsWithFallback}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">Cache-Hit Symbols</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.cacheHitSymbols}</span>
                      </div>
                      <div>
                        <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/50 mb-0.5">REST-Fallback Symbols</span>
                        <span className="text-foreground font-mono">{quoteCacheStats.restFallbackSymbols}</span>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 pt-1">Counters reset on server restart.</p>
                  </>
                )}
              </div>
            </SectionCard>
          )}
        </div>
      </main>
    </div>
  );
}
