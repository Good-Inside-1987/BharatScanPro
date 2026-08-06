import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import {
  RefreshCw, Search, TrendingUp, TrendingDown, Plus, Download, FolderInput,
  Trash2, Settings2, Play, Clock, Loader2, CheckCircle2, AlertCircle, X,
  ClipboardPaste, Layers, GripVertical, Copy, ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  apiListScannerDashboards, apiCreateScannerDashboard, apiUpdateScannerDashboard,
  apiDeleteScannerDashboard, apiCreateScannerScan, apiUpdateScannerScan,
  apiDeleteScannerScan, apiMarkScannerScanRan,
  type ApiScannerDashboard, type ApiScannerScan,
} from "@/lib/api";
import { listScans, migrateSavedScan, type SavedScan } from "@/lib/savedScans";
import {
  runScan, normalizeCondition, isGroup, newGroup, flattenItems,
  type Condition, type ConditionGroup, type FilterItem, type LogicMode, type ScanResult,
} from "@/lib/screener";
import { ConditionRow, newCondition, NameModeContext } from "@/components/ConditionRow";
import { FilterGroupBlock, type DragSrc } from "@/components/FilterGroupBlock";
import { LogicModeSelect } from "@/components/LogicModeSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useData } from "@/context/DataContext";
import { type UniverseCategory } from "@/lib/universe";
import { toast } from "sonner";

type ScanMode = "stocks" | "options";
const ALL_UNIVERSE_ID = "ALL";

const PRESET_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#06b6d4",
  "#f59e0b", "#94a3b8", "#ffffff",
];
const OPTIONS_UNIVERSE_NAMES = ["nifty indices", "nifty50", "nifty 50", "futures"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtVol(v: number): string {
  if (v >= 1_00_00_000) return (v / 1_00_00_000).toFixed(1) + "Cr";
  if (v >= 1_00_000)    return (v / 1_00_000).toFixed(1) + "L";
  if (v >= 1_000)       return (v / 1_000).toFixed(1) + "K";
  return String(v);
}

type SortKey = "symbol" | "changePct" | "close" | "volume";

function sortResults(rows: ScanResult[], key: SortKey, dir: "asc" | "desc"): ScanResult[] {
  const cmp = (a: ScanResult, b: ScanResult) => {
    if (key === "symbol") return a.symbol.localeCompare(b.symbol);
    return (a[key] as number) - (b[key] as number);
  };
  return [...rows].sort((a, b) => dir === "asc" ? cmp(a, b) : cmp(b, a));
}

function exportCsv(name: string, rows: ScanResult[]) {
  const header = "Symbol,% Change,Price,Volume,Date";
  const lines = rows.map((r) =>
    `${r.symbol},${r.changePct.toFixed(2)},${r.close},${r.volume},${r.date}`
  );
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[^a-z0-9]/gi, "_")}_results.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

interface ScanConfig {
  filterItems: FilterItem[];
  topLogicMode: LogicMode;
  scanMode: ScanMode;
  universeId: string;
}

function parseScanConfig(filter_json: string): ScanConfig {
  try {
    const p = JSON.parse(filter_json) as Partial<ScanConfig>;
    return {
      filterItems: p.filterItems ?? [],
      topLogicMode: p.topLogicMode ?? "all",
      scanMode: p.scanMode ?? "stocks",
      universeId: p.universeId ?? ALL_UNIVERSE_ID,
    };
  } catch {
    return { filterItems: [], topLogicMode: "all", scanMode: "stocks", universeId: ALL_UNIVERSE_ID };
  }
}

function normItem(item: FilterItem): FilterItem {
  if (isGroup(item)) return { ...item, conditions: item.conditions.map(normItem) };
  return normalizeCondition(item);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  }
}

// ── Filter Editor (inside EditScanModal) ──────────────────────────────────────

function FilterEditor({
  filterItems, setFilterItems, topLogicMode, setTopLogicMode,
}: {
  filterItems: FilterItem[];
  setFilterItems: (items: FilterItem[]) => void;
  topLogicMode: LogicMode;
  setTopLogicMode: (m: LogicMode) => void;
}) {
  const [activeDrag, setActiveDrag] = useState<DragSrc | null>(null);
  const [dragOverTopIdx, setDragOverTopIdx] = useState<number | null>(null);
  const [escapeZoneOver, setEscapeZoneOver] = useState(false);
  const [afterGroupOver, setAfterGroupOver] = useState<number | null>(null);
  const [conditionClipboard, setConditionClipboard] = useState<Condition | null>(null);

  function resetDrag() { setActiveDrag(null); setDragOverTopIdx(null); setAfterGroupOver(null); }

  return (
    <NameModeContext.Provider value="full">
      <div className="rounded-lg border border-border bg-secondary/20 p-2.5">
        {filterItems.length > 0 && (
          <>
            <div className="flex items-center gap-2 mb-1 text-[10px] text-muted-foreground">
              <span>Stock passes</span>
              <LogicModeSelect value={topLogicMode} onChange={setTopLogicMode} />
              <span>of the below filters</span>
            </div>
            <div className="space-y-1">
              {filterItems.map((item, i) => {
                if (isGroup(item)) {
                  const activeDragIsGroup = !!(activeDrag?.kind === "top" && isGroup(filterItems[activeDrag.idx]));
                  return (
                    <Fragment key={item.id}>
                      <FilterGroupBlock
                        group={item}
                        onChange={(u) => setFilterItems(filterItems.map((x, j) => j === i ? u : x))}
                        onDelete={() => setFilterItems(filterItems.filter((_, j) => j !== i))}
                        conditionClipboard={conditionClipboard}
                        onCopyCondition={(c) => { setConditionClipboard({ ...c }); toast.success("Filter copied"); }}
                        isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                        isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                        topIdx={i} activeDrag={activeDrag} activeDragIsGroup={activeDragIsGroup}
                        onDropOnGroup={(src) => {
                          const next = [...filterItems];
                          if (src.kind === "top") {
                            const si = filterItems[src.idx];
                            if (!isGroup(si)) {
                              const [cond] = next.splice(src.idx, 1);
                              const ai = src.idx < i ? i - 1 : i;
                              const grp = next[ai] as ConditionGroup;
                              next[ai] = { ...grp, conditions: [...grp.conditions, cond as Condition] };
                            } else {
                              if (src.idx === i) return;
                              const [moved] = next.splice(src.idx, 1); next.splice(i, 0, moved);
                            }
                          } else if (src.kind === "inner" && src.topIdx !== i) {
                            const sg = next[src.topIdx] as ConditionGroup;
                            const sc = [...sg.conditions]; const [mc] = sc.splice(src.condIdx, 1);
                            next[src.topIdx] = { ...sg, conditions: sc };
                            const tg = next[i] as ConditionGroup;
                            next[i] = { ...tg, conditions: [...tg.conditions, mc] };
                          }
                          setFilterItems(next); resetDrag();
                        }}
                        onInnerDragStart={(ci) => setActiveDrag({ kind: "inner", topIdx: i, condIdx: ci })}
                        onInnerDragEnd={() => setActiveDrag(null)}
                        dragHandleProps={{
                          draggable: true,
                          onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "top", idx: i })); requestAnimationFrame(() => setActiveDrag({ kind: "top", idx: i })); },
                          onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTopIdx !== i) setDragOverTopIdx(i); },
                          onDrop: (e: React.DragEvent) => {
                            e.preventDefault();
                            try {
                              const src = JSON.parse(e.dataTransfer.getData("text/plain")) as DragSrc;
                              if (src.kind !== "top" || src.idx === i || !isGroup(filterItems[src.idx])) return;
                              e.stopPropagation();
                              const next = [...filterItems]; const [m] = next.splice(src.idx, 1); next.splice(i, 0, m); setFilterItems(next);
                            } catch {}
                            resetDrag();
                          },
                          onDragEnd: () => resetDrag(),
                        }}
                      />
                      {activeDrag?.kind === "top" && (
                        <div
                          className={`rounded transition-all duration-150 ${afterGroupOver === i ? "h-2 bg-primary/60 ring-1 ring-primary/40 my-0.5" : "h-1 bg-white/5 my-px"}`}
                          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; if (afterGroupOver !== i) setAfterGroupOver(i); }}
                          onDragLeave={() => { if (afterGroupOver === i) setAfterGroupOver(null); }}
                          onDrop={(e) => {
                            e.preventDefault(); e.stopPropagation();
                            try {
                              const src = JSON.parse(e.dataTransfer.getData("text/plain")) as DragSrc;
                              if (src.kind !== "top") return;
                              const next = [...filterItems]; const [m] = next.splice(src.idx, 1); next.splice(src.idx < i ? i : i + 1, 0, m); setFilterItems(next);
                            } catch {}
                            resetDrag();
                          }}
                        />
                      )}
                    </Fragment>
                  );
                }
                return (
                  <ConditionRow
                    key={item.id}
                    condition={item}
                    onChange={(nc) => setFilterItems(filterItems.map((x, j) => j === i ? nc : x))}
                    onRemove={() => setFilterItems(filterItems.filter((_, j) => j !== i))}
                    onCopy={() => { setConditionClipboard({ ...item }); toast.success("Filter copied"); }}
                    onDuplicate={() => { const cl = { ...item, id: crypto.randomUUID() }; const next = [...filterItems]; next.splice(i + 1, 0, cl); setFilterItems(next); }}
                    onToggle={() => setFilterItems(filterItems.map((x, j) => j === i ? { ...x, enabled: (x as Condition).enabled === false } : x))}
                    isDragging={activeDrag?.kind === "top" && activeDrag.idx === i}
                    isDragOver={dragOverTopIdx === i && !(activeDrag?.kind === "top" && activeDrag.idx === i)}
                    dragPush={activeDrag?.kind === "top" && activeDrag.idx !== i && dragOverTopIdx !== null ? (activeDrag.idx < i && i <= dragOverTopIdx ? "up" : activeDrag.idx > i && i >= dragOverTopIdx ? "down" : undefined) : undefined}
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", JSON.stringify({ kind: "top", idx: i })); requestAnimationFrame(() => setActiveDrag({ kind: "top", idx: i })); }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dragOverTopIdx !== i) setDragOverTopIdx(i); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      try {
                        const src = JSON.parse(e.dataTransfer.getData("text/plain")) as DragSrc;
                        const next = [...filterItems];
                        if (src.kind === "top") {
                          if (src.idx === i) return;
                          const [m] = next.splice(src.idx, 1); next.splice(i, 0, m);
                        } else if (src.kind === "inner") {
                          const grp = next[src.topIdx] as ConditionGroup; const nc = [...grp.conditions]; const [mc] = nc.splice(src.condIdx, 1);
                          next[src.topIdx] = { ...grp, conditions: nc }; next.splice(i, 0, mc);
                        }
                        setFilterItems(next);
                      } catch {}
                      resetDrag();
                    }}
                    onDragEnd={() => resetDrag()}
                  />
                );
              })}
            </div>
            {activeDrag?.kind === "inner" && (
              <div
                className={`mt-1 h-7 rounded border border-dashed transition-all duration-150 flex items-center justify-center text-[10px] ${escapeZoneOver ? "border-primary/60 bg-primary/5 text-primary" : "border-white/15 text-muted-foreground/40"}`}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setEscapeZoneOver(true); }}
                onDragLeave={() => setEscapeZoneOver(false)}
                onDrop={(e) => {
                  e.preventDefault(); setEscapeZoneOver(false);
                  try {
                    const src = JSON.parse(e.dataTransfer.getData("text/plain")) as DragSrc;
                    if (src.kind !== "inner") return;
                    const next = [...filterItems]; const sg = next[src.topIdx] as ConditionGroup; const sc = [...sg.conditions]; const [mc] = sc.splice(src.condIdx, 1);
                    next[src.topIdx] = { ...sg, conditions: sc }; next.push(mc); setFilterItems(next);
                  } catch {}
                  resetDrag();
                }}
              >
                {escapeZoneOver ? "↑ Release to move to main filter list" : "Drag here to move filter out of group"}
              </div>
            )}
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
                <DropdownMenuItem onClick={() => { setFilterItems([...filterItems, { ...conditionClipboard, id: crypto.randomUUID() }]); toast.success("Filter pasted"); }}>
                  <ClipboardPaste size={13} className="mr-2" /> Paste Filter
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {filterItems.length > 0 && (
            <span className="text-[10px] text-muted-foreground">{flattenItems(filterItems).length} filter{flattenItems(filterItems).length !== 1 ? "s" : ""}</span>
          )}
        </div>
      </div>
    </NameModeContext.Provider>
  );
}

// ── Edit Scan Modal ────────────────────────────────────────────────────────────

function EditScanModal({
  open, scan, dashboardId, onClose, onSaved,
}: {
  open: boolean;
  scan: ApiScannerScan | null;
  dashboardId: string;
  onClose: () => void;
  onSaved: (s: ApiScannerScan) => void;
}) {
  const { histories, categories } = useData();
  const [name, setName] = useState("");
  const [filterItems, setFilterItems] = useState<FilterItem[]>([]);
  const [topLogicMode, setTopLogicMode] = useState<LogicMode>("all");
  const [series, setSeries] = useState("EQ");
  const [scanMode, setScanMode] = useState<ScanMode>("stocks");
  const [universeId, setUniverseId] = useState<string>(ALL_UNIVERSE_ID);
  const [saving, setSaving] = useState(false);
  const [showSavedPicker, setShowSavedPicker] = useState(false);
  const [savedScans, setSavedScans] = useState<SavedScan[]>([]);
  const importRef = useRef<HTMLInputElement>(null);

  // Universe categories visible for current mode
  const visibleCategories = scanMode === "options"
    ? categories.filter((c: UniverseCategory) => OPTIONS_UNIVERSE_NAMES.includes(c.name.trim().toLowerCase()))
    : categories;

  // Auto-snap universe when mode changes (same logic as Create Scan page)
  useEffect(() => {
    if (!open) return;
    if (scanMode === "stocks") {
      const nseCash = categories.find((c: UniverseCategory) => c.name.trim().toLowerCase() === "nse cash");
      if (nseCash && universeId === ALL_UNIVERSE_ID) setUniverseId(nseCash.id);
    } else {
      if (visibleCategories.length === 0) return;
      const nifty50 = visibleCategories.find((c: UniverseCategory) => {
        const n = c.name.trim().toLowerCase();
        return n === "nifty50" || n === "nifty 50";
      });
      setUniverseId(nifty50?.id ?? visibleCategories[0]?.id ?? ALL_UNIVERSE_ID);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanMode, open]);

  useEffect(() => {
    if (!open) return;
    if (scan) {
      setName(scan.name);
      const cfg = parseScanConfig(scan.filter_json);
      setFilterItems(cfg.filterItems.map(normItem));
      setTopLogicMode(cfg.topLogicMode);
      setSeries(scan.series);
      setScanMode(cfg.scanMode);
      setUniverseId(cfg.universeId);
    } else {
      setName(""); setFilterItems([]); setTopLogicMode("all"); setSeries("EQ");
      setScanMode("stocks");
      const nseCash = categories.find((c: UniverseCategory) => c.name.trim().toLowerCase() === "nse cash");
      setUniverseId(nseCash?.id ?? ALL_UNIVERSE_ID);
    }
  }, [open, scan]);

  async function handleSave() {
    if (!name.trim()) { toast.error("Give the scan a name"); return; }
    setSaving(true);
    try {
      const filter_json = JSON.stringify({ filterItems, topLogicMode, scanMode, universeId });
      const saved = scan
        ? await apiUpdateScannerScan(dashboardId, scan.id, { name: name.trim(), filter_json, series })
        : await apiCreateScannerScan(dashboardId, { name: name.trim(), filter_json, series });
      toast.success(scan ? "Scan updated" : "Scan added");
      onSaved(saved);
    } catch { toast.error("Failed to save scan"); }
    finally { setSaving(false); }
  }

  async function openSavedPicker() {
    setSavedScans(await listScans());
    setShowSavedPicker(true);
  }

  function loadFromSaved(s: SavedScan) {
    const { filterItems: fi, topLogicMode: lm } = migrateSavedScan(s);
    setFilterItems(fi.map(normItem)); setTopLogicMode(lm);
    if (s.series) setSeries(s.series);
    setName(s.name);
    setShowSavedPicker(false);
    toast.success(`Loaded "${s.name}"`);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string) as Partial<SavedScan & ScanConfig & { conditions: FilterItem[] }>;
        setFilterItems((data.filterItems ?? data.conditions ?? []).map(normItem));
        setTopLogicMode(data.topLogicMode ?? "all");
        if (data.series) setSeries(data.series);
        if (data.scanMode) setScanMode(data.scanMode);
        if (data.universeId) setUniverseId(data.universeId);
        if (data.name) setName(data.name);
        toast.success("Scan imported");
      } catch { toast.error("Invalid scan file"); }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm">{scan ? "Edit Scan" : "Add Scan"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input placeholder="Scan name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }} className="h-8 text-xs flex-1" />
              <select value={series} onChange={(e) => setSeries(e.target.value)} className="h-8 text-xs rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring">
                {["EQ", "BE", "BZ", "SM", "ST"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            {/* Mode + Universe — same row as Create Scan page */}
            <div className="flex flex-wrap items-center gap-2 py-1.5 px-3 rounded-lg border border-border bg-secondary/30">
              <span className="text-xs text-muted-foreground font-medium">Mode:</span>
              {(["stocks", "options"] as ScanMode[]).map((m) => (
                <button
                  key={m} type="button" onClick={() => setScanMode(m)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md border transition-colors capitalize ${
                    scanMode === m ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "stocks" ? "Stocks" : "Options"}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-border" />
              <span className="text-xs text-muted-foreground font-medium">Universe:</span>
              <Select value={universeId} onValueChange={setUniverseId}>
                <SelectTrigger className="w-auto min-w-[110px] max-w-[280px] h-7 bg-input text-xs">
                  <SelectValue placeholder="Pick universe…" />
                </SelectTrigger>
                <SelectContent>
                  {scanMode === "stocks" && (
                    <SelectItem value={ALL_UNIVERSE_ID}>
                      All Loaded Stocks{histories.length ? ` (${histories.length})` : ""}
                    </SelectItem>
                  )}
                  {visibleCategories.map((c: UniverseCategory) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.symbols.length ? ` (${c.symbols.length})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {categories.length === 0 && (
                <span className="text-[10px] text-muted-foreground">Upload a Watchlist CSV in Settings to load named universes.</span>
              )}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={openSavedPicker}>
                <ClipboardPaste className="h-3.5 w-3.5" /> Load from Saved Scan
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => importRef.current?.click()}>
                <FolderInput className="h-3.5 w-3.5" /> Import from File
              </Button>
              <input ref={importRef} type="file" accept=".json,application/json" className="hidden" onChange={handleImportFile} />
            </div>
            <FilterEditor filterItems={filterItems} setFilterItems={setFilterItems} topLogicMode={topLogicMode} setTopLogicMode={setTopLogicMode} />
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose} className="h-7 px-3 text-xs">Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={saving || !name.trim()} className="h-7 px-3 text-xs bg-gradient-primary text-primary-foreground">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                {scan ? "Update" : "Add Scan"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showSavedPicker} onOpenChange={(o) => { if (!o) setShowSavedPicker(false); }}>
        <DialogContent className="max-w-md max-h-[70vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="text-sm">Load from Saved Scan</DialogTitle></DialogHeader>
          {savedScans.length === 0
            ? <p className="text-xs text-muted-foreground py-4 text-center">No saved scans found.</p>
            : <div className="space-y-1 mt-1">
                {savedScans.map((s) => (
                  <button key={s.id} onClick={() => loadFromSaved(s)} className="w-full text-left px-3 py-2 rounded-md hover:bg-primary/10 border border-transparent hover:border-primary/20 transition-colors">
                    <span className="text-xs font-medium text-foreground">{s.name}</span>
                    <span className="ml-2 text-[10px] text-muted-foreground">{flattenItems(migrateSavedScan(s).filterItems).length} filters</span>
                  </button>
                ))}
              </div>
          }
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Scan Widget ────────────────────────────────────────────────────────────────

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: "asc" | "desc" }) {
  if (col !== sortKey) return <ArrowUpDown className="h-2.5 w-2.5 opacity-30" />;
  return sortDir === "asc" ? <ArrowUp className="h-2.5 w-2.5 text-primary" /> : <ArrowDown className="h-2.5 w-2.5 text-primary" />;
}

function ScanWidget({
  scan, dashboardId, results, resultDate, running, onRun, onEdit, onDelete, onUpdated,
}: {
  scan: ApiScannerScan;
  dashboardId: string;
  results: ScanResult[] | undefined;
  resultDate: string | undefined;
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onUpdated: (s: ApiScannerScan) => void;
}) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("changePct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [lastCopied, setLastCopied] = useState<string | null>(null);

  const cfg = parseScanConfig(scan.filter_json);
  const filterCount = flattenItems(cfg.filterItems).length;

  function toggleSort(col: SortKey) {
    if (sortKey === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortKey(col); setSortDir(col === "symbol" ? "asc" : "desc"); }
  }

  const hasResults = results !== undefined;
  const allRows = results ?? [];
  const searchedRows = allRows.filter((r) => r.symbol.toLowerCase().includes(search.toLowerCase()));
  const displayRows = sortResults(searchedRows, sortKey, sortDir);

  function handleCopy(symbol: string) {
    copyToClipboard(symbol).then(() => {
      setLastCopied(symbol);
      toast.success(`Copied ${symbol}`);
      setTimeout(() => setLastCopied((p) => p === symbol ? null : p), 2000);
    }).catch(() => toast.error("Copy failed"));
  }

  function handleExportCsv() {
    if (!hasResults || allRows.length === 0) { toast.error("No results to export"); return; }
    exportCsv(scan.name, displayRows);
    toast.success(`Exported ${displayRows.length} rows`);
  }

  return (
    <Card className="shadow-card flex flex-col overflow-hidden border border-border hover:border-primary/30 transition-colors">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border bg-muted/20">
        <div className="flex items-start justify-between gap-1.5">
          <h3 className="text-xs font-bold text-foreground leading-tight line-clamp-2 flex-1">{scan.name}</h3>
          <div className="flex items-center gap-0.5 shrink-0">
            <button type="button" onClick={handleExportCsv} disabled={!hasResults || allRows.length === 0} className="p-1 text-muted-foreground/60 hover:text-success disabled:opacity-30 transition-colors" title="Export CSV">
              <Download className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={onEdit} className="p-1 text-muted-foreground/60 hover:text-primary transition-colors" title="Edit scan filters">
              <Settings2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={onDelete} className="p-1 text-muted-foreground/60 hover:text-destructive-bright transition-colors" title="Delete scan">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {hasResults && (
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${allRows.length > 0 ? "bg-success/15 text-success border border-success/30" : "bg-muted text-muted-foreground border border-border"}`}>
              {allRows.length > 0 ? <CheckCircle2 className="h-2.5 w-2.5" /> : <AlertCircle className="h-2.5 w-2.5" />}
              {allRows.length} stocks
            </span>
          )}
          {!hasResults && filterCount > 0 && (
            <span className="text-[10px] text-muted-foreground">{filterCount} filter{filterCount !== 1 ? "s" : ""}</span>
          )}
          {filterCount === 0 && (
            <span className="text-[10px] text-amber-400">No filters — click ✎ to add</span>
          )}
          <button
            type="button" onClick={onRun} disabled={running || filterCount === 0}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-primary/20 text-primary hover:bg-primary/30 disabled:opacity-40 transition-colors"
            title="Run scan"
          >
            {running ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Play className="h-2.5 w-2.5 fill-primary" />}
            {running ? "Running…" : "Run"}
          </button>
        </div>
        {resultDate && (
          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
            <Clock className="h-2.5 w-2.5" />
            {new Date(resultDate + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        )}
      </div>

      {hasResults && (
        <>
          {/* Search */}
          <div className="px-3 py-1.5 border-b border-border/50">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input className="h-6 pl-6 text-[10px] bg-input border-border/60 placeholder:text-muted-foreground/50" placeholder="Search symbol…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>

          {/* Results table */}
          <div className="overflow-y-auto max-h-52 flex-1">
            {displayRows.length === 0
              ? <p className="text-center text-muted-foreground text-xs py-4">{search ? "No results matching search" : "0 stocks matched this scan"}</p>
              : (
                <table className="w-full text-xs table-fixed">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border/50">
                    <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="text-left px-2 py-1.5 w-[38%]">
                        <button type="button" onClick={() => toggleSort("symbol")} className="flex items-center gap-0.5 hover:text-foreground transition-colors">
                          Symbol <SortIcon col="symbol" sortKey={sortKey} sortDir={sortDir} />
                        </button>
                      </th>
                      <th className="text-right px-1 py-1.5 w-[20%]">
                        <button type="button" onClick={() => toggleSort("changePct")} className="flex items-center gap-0.5 ml-auto hover:text-foreground transition-colors">
                          <SortIcon col="changePct" sortKey={sortKey} sortDir={sortDir} /> Chg&nbsp;%
                        </button>
                      </th>
                      <th className="text-right px-1 py-1.5 w-[22%]">
                        <button type="button" onClick={() => toggleSort("close")} className="flex items-center gap-0.5 ml-auto hover:text-foreground transition-colors">
                          <SortIcon col="close" sortKey={sortKey} sortDir={sortDir} /> Price
                        </button>
                      </th>
                      <th className="text-right px-2 py-1.5 w-[20%]">
                        <button type="button" onClick={() => toggleSort("volume")} className="flex items-center gap-0.5 ml-auto hover:text-foreground transition-colors">
                          <SortIcon col="volume" sortKey={sortKey} sortDir={sortDir} /> Vol
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r, i) => {
                      const up = (r.changePct ?? 0) >= 0;
                      const isLastCopied = r.symbol === lastCopied;
                      return (
                        <tr key={r.symbol} className={`border-t border-border/30 hover:bg-primary/5 transition-colors ${i % 2 === 0 ? "bg-card" : "bg-muted/10"}`}>
                          <td className="px-2 py-1 w-[38%]">
                            <span className="flex items-center gap-0.5 min-w-0">
                              {up ? <TrendingUp className="h-2.5 w-2.5 text-success shrink-0" /> : <TrendingDown className="h-2.5 w-2.5 text-destructive-bright shrink-0" />}
                              <span className="font-semibold text-foreground truncate text-xs leading-none">{r.symbol}</span>
                              <button
                                type="button"
                                onClick={() => handleCopy(r.symbol)}
                                className={`ml-0.5 shrink-0 rounded p-px transition-colors ${isLastCopied ? "text-success" : "text-muted-foreground/40 hover:text-primary"}`}
                                title={`Copy ${r.symbol}`}
                              >
                                <Copy className="h-2.5 w-2.5" />
                              </button>
                            </span>
                          </td>
                          <td className={`px-1 py-1.5 text-right tabular-nums font-bold text-xs w-[20%] ${up ? "text-success" : "text-destructive-bright"}`}>
                            {up ? "+" : ""}{(r.changePct ?? 0).toFixed(2)}%
                          </td>
                          <td className="px-1 py-1.5 text-right tabular-nums text-foreground/80 text-xs w-[22%]">
                            {(r.close ?? 0).toLocaleString("en-IN")}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground text-xs w-[20%]">
                            {fmtVol(r.volume ?? 0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )
            }
          </div>
        </>
      )}

      {!hasResults && (
        <div className="flex-1 flex items-center justify-center py-6 text-muted-foreground/40 text-xs">
          Click Run to see results
        </div>
      )}
    </Card>
  );
}

// ── Create / Rename Dashboard Modal ───────────────────────────────────────────

function CreateDashboardModal({
  open, initial, onClose, onCreated,
}: {
  open: boolean;
  initial?: ApiScannerDashboard | null;
  onClose: () => void;
  onCreated: (d: ApiScannerDashboard) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setColor(initial?.color ?? "#6366f1");
    }
  }, [open, initial]);

  async function handleSubmit() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const d = initial
        ? await apiUpdateScannerDashboard(initial.id, { name: name.trim(), color })
        : await apiCreateScannerDashboard({ name: name.trim(), color });
      onCreated(d); onClose();
    } catch { toast.error("Failed to save dashboard"); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="text-sm">{initial ? "Rename Dashboard" : "New Scanner Dashboard"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input placeholder="Dashboard name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }} className="h-8 text-xs" autoFocus />
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5">Dashboard color</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c} type="button" onClick={() => setColor(c)}
                  style={{ background: c, boxShadow: color === c ? `0 0 0 2px var(--background), 0 0 0 4px ${c}` : undefined }}
                  className={`h-5 w-5 rounded-full border transition-all ${c === "#ffffff" ? "border-border" : "border-transparent"} ${color === c ? "scale-110" : "hover:scale-105"}`}
                  title={c}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="text-xs">Cancel</Button>
            <Button size="sm" onClick={handleSubmit} disabled={saving || !name.trim()} className="text-xs">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              {initial ? "Rename" : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Auto-refresh interval options ─────────────────────────────────────────────

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "10 s", value: 10 },
  { label: "30 s", value: 30 },
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "10 min", value: 600 },
];

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ScannerDashboard() {
  const { histories, categories, asOfDate } = useData();
  const [dashboards, setDashboards] = useState<ApiScannerDashboard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // results and running lifted to parent so auto-run/refresh can drive everything
  const [results, setResults] = useState<Record<string, ScanResult[]>>({});
  const [resultDates, setResultDates] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<Set<string>>(new Set());

  // Auto-refresh
  const [refreshSec, setRefreshSec] = useState(0);
  const [customRefreshInput, setCustomRefreshInput] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [nextRefreshIn, setNextRefreshIn] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [renaming, setRenaming] = useState<ApiScannerDashboard | null>(null);
  const [deleteConfirmDash, setDeleteConfirmDash] = useState<string | null>(null);

  const [editingScan, setEditingScan] = useState<ApiScannerScan | null>(null);
  const [addingScan, setAddingScan] = useState(false);
  const [deleteConfirmScan, setDeleteConfirmScan] = useState<{ dashboardId: string; scanId: string } | null>(null);

  const importRef = useRef<HTMLInputElement>(null);

  type ImportPayload = { dashboards: Array<{ name: string; color?: string; scans?: Array<{ name: string; series?: string; filter_json?: string; order_idx?: number }> }> };
  const [importPayload, setImportPayload] = useState<ImportPayload | null>(null);
  const [importing, setImporting] = useState(false);

  const selected = dashboards.find((d) => d.id === selectedId) ?? null;

  // ── Load dashboards on mount ────────────────────────────────────────────────

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await apiListScannerDashboards();
      setDashboards(data);
      if (data.length > 0) setSelectedId((prev) => prev ?? data[0].id);
    } catch { toast.error("Failed to load scanner dashboards"); }
    finally { setLoading(false); }
  }

  // ── Scan execution ──────────────────────────────────────────────────────────

  const runScanById = useCallback(async (scan: ApiScannerScan) => {
    if (!histories.length) return;
    setRunning((prev) => new Set(prev).add(scan.id));
    try {
      const cfg = parseScanConfig(scan.filter_json);
      if (flattenItems(cfg.filterItems).length === 0) return;
      // Filter histories by universe (same logic as Create Scan page)
      let h = histories;
      if (cfg.universeId !== ALL_UNIVERSE_ID) {
        const cat = categories.find((c: UniverseCategory) => c.id === cfg.universeId);
        if (cat && cat.symbols.length > 0) {
          const allow = new Set(cat.symbols);
          h = histories.filter((x) => allow.has(x.symbol));
        }
      }
      const r = runScan(h, cfg.filterItems, {
        series: [scan.series],
        logicMode: cfg.topLogicMode,
        asOfDate: asOfDate ?? undefined,
      });
      setResults((prev) => ({ ...prev, [scan.id]: r }));
      const dataDate = r.length > 0
        ? r[0].date
        : histories.reduce((latest, h) => {
            const last = h.bars[h.bars.length - 1]?.date ?? "";
            return last > latest ? last : latest;
          }, "");
      if (dataDate) setResultDates((prev) => ({ ...prev, [scan.id]: dataDate }));
      await apiMarkScannerScanRan(scan.dashboard_id, scan.id).catch(() => {});
      setDashboards((prev) =>
        prev.map((d) => d.id === scan.dashboard_id
          ? { ...d, scans: d.scans.map((s) => s.id === scan.id ? { ...s, last_run_at: new Date().toISOString() } : s) }
          : d)
      );
    } catch { toast.error(`Scan "${scan.name}" failed`); }
    finally { setRunning((prev) => { const n = new Set(prev); n.delete(scan.id); return n; }); }
  }, [histories, categories, asOfDate]);

  const runAllForDashboard = useCallback(async (dash: ApiScannerDashboard) => {
    if (!histories.length) return;
    const scans = dash.scans.filter((s) => flattenItems(parseScanConfig(s.filter_json).filterItems).length > 0);
    await Promise.all(scans.map((s) => runScanById(s)));
  }, [runScanById, histories]);

  // Auto-run on mount when dashboard loads (or when histories become available)
  const didAutoRun = useRef(false);
  useEffect(() => {
    if (didAutoRun.current) return;
    if (!loading && selected && histories.length > 0) {
      didAutoRun.current = true;
      runAllForDashboard(selected);
    }
  }, [loading, selected, histories, runAllForDashboard]);

  // Re-auto-run when selected dashboard changes (but not on initial mount — handled above)
  const prevSelectedId = useRef<string | null>(null);
  useEffect(() => {
    if (prevSelectedId.current === null) { prevSelectedId.current = selectedId; return; }
    if (selectedId !== prevSelectedId.current) {
      prevSelectedId.current = selectedId;
      if (selected && histories.length > 0) runAllForDashboard(selected);
    }
  }, [selectedId, selected, histories, runAllForDashboard]);

  // Re-run all scans whenever Live/Past mode or historical date changes
  const prevAsOfDate = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevAsOfDate.current === undefined) { prevAsOfDate.current = asOfDate; return; }
    if (asOfDate !== prevAsOfDate.current) {
      prevAsOfDate.current = asOfDate;
      if (selected && histories.length > 0) runAllForDashboard(selected);
    }
  }, [asOfDate, selected, histories, runAllForDashboard]);

  // ── Auto-refresh interval ───────────────────────────────────────────────────

  useEffect(() => {
    if (refreshTimer.current) clearInterval(refreshTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    if (refreshSec <= 0 || !selected) { setNextRefreshIn(0); return; }

    setNextRefreshIn(refreshSec);
    refreshTimer.current = setInterval(() => {
      if (selected) runAllForDashboard(selected);
      setNextRefreshIn(refreshSec);
    }, refreshSec * 1000);

    countdownTimer.current = setInterval(() => {
      setNextRefreshIn((p) => Math.max(0, p - 1));
    }, 1000);

    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      if (countdownTimer.current) clearInterval(countdownTimer.current);
    };
  }, [refreshSec, selected, runAllForDashboard]);

  // ── Dashboard mutations ─────────────────────────────────────────────────────

  async function deleteDashboard(id: string) {
    try {
      await apiDeleteScannerDashboard(id);
      const remaining = dashboards.filter((d) => d.id !== id);
      setDashboards(remaining);
      if (selectedId === id) setSelectedId(remaining[0]?.id ?? null);
      toast.success("Dashboard deleted");
    } catch { toast.error("Failed to delete dashboard"); }
    setDeleteConfirmDash(null);
  }

  function handleScanSaved(scan: ApiScannerScan) {
    setDashboards((prev) => prev.map((d) => {
      if (d.id !== scan.dashboard_id) return d;
      const exists = d.scans.find((s) => s.id === scan.id);
      return { ...d, scans: exists ? d.scans.map((s) => s.id === scan.id ? scan : s) : [...d.scans, scan] };
    }));
    setEditingScan(null); setAddingScan(false);
    // auto-run the newly saved scan
    setTimeout(() => runScanById(scan), 100);
  }

  async function deleteScan(dashboardId: string, scanId: string) {
    try {
      await apiDeleteScannerScan(dashboardId, scanId);
      setDashboards((prev) => prev.map((d) => d.id === dashboardId ? { ...d, scans: d.scans.filter((s) => s.id !== scanId) } : d));
      setResults((prev) => { const n = { ...prev }; delete n[scanId]; return n; });
      toast.success("Scan deleted");
    } catch { toast.error("Failed to delete scan"); }
    setDeleteConfirmScan(null);
  }

  // ── Export / Import dashboards ──────────────────────────────────────────────

  function handleExport() {
    const payload = {
      exportedAt: new Date().toISOString(),
      dashboards: dashboards.map((d) => ({
        name: d.name,
        scans: d.scans.map((s) => ({ name: s.name, series: s.series, filter_json: s.filter_json, order_idx: s.order_idx })),
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `bharatscan-scanner-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported dashboards");
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return; e.target.value = "";
    const text = await file.text().catch(() => null);
    if (!text) { toast.error("Could not read file"); return; }
    try {
      const payload = JSON.parse(text) as ImportPayload & { dashboards?: unknown };
      if (!Array.isArray(payload.dashboards)) { toast.error("Invalid export file"); return; }
      setImportPayload(payload as ImportPayload);
    } catch { toast.error("Failed to import — invalid file format"); }
  }

  async function executeImport(mode: "append" | "replace") {
    if (!importPayload) return;
    setImporting(true);
    try {
      if (mode === "replace") {
        for (const d of dashboards) await apiDeleteScannerDashboard(d.id).catch(() => {});
      }
      let created = 0;
      for (const d of importPayload.dashboards) {
        const newDash = await apiCreateScannerDashboard({ name: d.name, color: d.color });
        for (const s of d.scans ?? []) await apiCreateScannerScan(newDash.id, { name: s.name, filter_json: s.filter_json ?? "{}", series: s.series ?? "EQ", order_idx: s.order_idx ?? 0 });
        created++;
      }
      await load();
      toast.success(`Imported ${created} dashboard${created !== 1 ? "s" : ""}`);
    } catch { toast.error("Failed to import"); }
    finally { setImporting(false); setImportPayload(null); }
  }

  function setCustomRefresh() {
    const val = parseInt(customRefreshInput, 10);
    if (!isNaN(val) && val > 0) { setRefreshSec(val); setShowCustomInput(false); setCustomRefreshInput(""); }
    else toast.error("Enter a valid number of seconds");
  }

  return (
    <div className="bg-background">

      {/* Dashboard tabs */}
      {dashboards.length > 0 && (
        <div className="bg-card/20">
          <div className="container flex items-center gap-0.5 overflow-x-auto scrollbar-none py-1">
            {dashboards.map((d) => {
              const isSelected = d.id === selectedId;
              return (
                <div
                  key={d.id}
                  className={`group shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer select-none ${
                    isSelected
                      ? "bg-primary/10 text-primary ring-1 ring-primary/40"
                      : "bg-muted/30 text-muted-foreground border border-border/50 hover:text-foreground hover:bg-muted/50"
                  }`}
                  onClick={() => setSelectedId(d.id)}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full shrink-0 border border-white/20"
                    style={{ background: d.color ?? "#6366f1" }}
                  />
                  <span>{d.name}</span>
                  <span className="text-[10px] opacity-60">({d.scans.length})</span>
                  {isSelected && (
                    <>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setRenaming(d); }}
                        className="p-0.5 text-primary/50 hover:text-primary opacity-0 group-hover:opacity-100 transition-all"
                        title="Rename"
                      >
                        <Settings2 className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmDash(d.id); }}
                        className="p-0.5 text-primary/50 hover:text-destructive-bright opacity-0 group-hover:opacity-100 transition-all"
                        title="Delete dashboard"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => setShowCreate(true)} className="ml-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 rounded-md transition-colors" title="New dashboard">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Body */}
      <main className="container py-4">
        {loading && <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}

        {!loading && dashboards.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
            <div className="rounded-full bg-muted/30 p-5"><GripVertical className="h-10 w-10 text-muted-foreground/40" /></div>
            <div>
              <p className="text-sm font-semibold text-foreground">No scanner dashboards yet</p>
              <p className="text-xs text-muted-foreground mt-1">Create a dashboard to run multiple scans side by side.</p>
            </div>
            <Button size="sm" onClick={() => setShowCreate(true)} className="h-7 px-3 text-xs bg-gradient-primary text-primary-foreground gap-1.5">
              <Plus className="h-3 w-3" /> Create First Dashboard
            </Button>
          </div>
        )}

        {!loading && selected && (
          <>
            {/* Hidden import file input */}
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={handleImportFile}
            />

            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">{selected.name}</h2>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={handleExport}
                  title="Export all dashboards to JSON"
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => importRef.current?.click()}
                  title="Import dashboards from JSON"
                >
                  <FolderInput className="h-3.5 w-3.5" /> Import
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => setAddingScan(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add Scan
                </Button>
              </div>
            </div>

            {selected.scans.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-center border border-dashed border-border rounded-xl">
                <p className="text-xs text-muted-foreground">No scans in this dashboard yet.</p>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setAddingScan(true)}>
                  <Plus className="h-3.5 w-3.5" /> Add First Scan
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {selected.scans.map((scan) => (
                  <ScanWidget
                    key={scan.id}
                    scan={scan}
                    dashboardId={selected.id}
                    results={results[scan.id]}
                    resultDate={resultDates[scan.id]}
                    running={running.has(scan.id)}
                    onRun={() => runScanById(scan)}
                    onEdit={() => setEditingScan(scan)}
                    onDelete={() => setDeleteConfirmScan({ dashboardId: selected.id, scanId: scan.id })}
                    onUpdated={(s) => setDashboards((prev) => prev.map((d) => d.id === s.dashboard_id ? { ...d, scans: d.scans.map((x) => x.id === s.id ? s : x) } : d))}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* Modals */}
      <CreateDashboardModal
        open={showCreate || renaming !== null} initial={renaming}
        onClose={() => { setShowCreate(false); setRenaming(null); }}
        onCreated={(d) => {
          if (renaming) setDashboards((prev) => prev.map((x) => x.id === d.id ? { ...x, ...d } : x));
          else { setDashboards((prev) => [...prev, d]); setSelectedId(d.id); }
          setRenaming(null); setShowCreate(false);
        }}
      />

      <EditScanModal
        open={editingScan !== null || addingScan} scan={editingScan} dashboardId={selectedId ?? ""}
        onClose={() => { setEditingScan(null); setAddingScan(false); }}
        onSaved={handleScanSaved}
      />

      {/* Import Append / Replace dialog */}
      <Dialog open={importPayload !== null} onOpenChange={(o) => { if (!o && !importing) setImportPayload(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">Import Dashboards</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Found <span className="font-medium text-foreground">{importPayload?.dashboards.length ?? 0} dashboard{(importPayload?.dashboards.length ?? 0) !== 1 ? "s" : ""}</span> in the file. How would you like to import?
          </p>
          <div className="space-y-2 mt-1">
            <button
              type="button"
              onClick={() => executeImport("append")}
              disabled={importing}
              className="w-full flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border border-border hover:border-primary/50 hover:bg-primary/5 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-xs font-semibold text-foreground">Append</span>
              <span className="text-[10px] text-muted-foreground">Add imported dashboards alongside existing ones</span>
            </button>
            <button
              type="button"
              onClick={() => executeImport("replace")}
              disabled={importing}
              className="w-full flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-lg border border-border hover:border-destructive/50 hover:bg-destructive/5 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-xs font-semibold text-foreground">Replace All</span>
              <span className="text-[10px] text-muted-foreground">Delete all existing dashboards first, then import</span>
            </button>
          </div>
          <div className="flex justify-end mt-1">
            <Button variant="outline" size="sm" onClick={() => setImportPayload(null)} disabled={importing} className="text-xs">
              {importing && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmDash !== null} onOpenChange={(o) => { if (!o) setDeleteConfirmDash(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">Delete Dashboard</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">This will permanently delete the dashboard and all its scans. This cannot be undone.</p>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmDash(null)} className="text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteDashboard(deleteConfirmDash!)} className="text-xs">Delete</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmScan !== null} onOpenChange={(o) => { if (!o) setDeleteConfirmScan(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="text-sm">Delete Scan</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">Remove this scan from the dashboard? This cannot be undone.</p>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirmScan(null)} className="text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteScan(deleteConfirmScan!.dashboardId, deleteConfirmScan!.scanId)} className="text-xs">Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
