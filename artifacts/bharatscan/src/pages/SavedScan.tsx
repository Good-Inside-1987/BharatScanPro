import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, Trash2, Star, FolderOpen, BookMarked, Loader2, AlertCircle,
  Download, FolderInput, Clock, Play, PenLine,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import {
  apiListScans, apiDeleteScan, apiToggleFavorite, apiDuplicateScan, apiCreateScan,
  type ApiScan,
} from "@/lib/api";
import { migrateSavedScan, type SavedScan } from "@/lib/savedScans";
import { toast } from "sonner";

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// Recursively count leaf conditions in a filterItems array
function countConditions(items: unknown[]): number {
  return items.reduce<number>((acc, item) => {
    const i = item as Record<string, unknown>;
    if (Array.isArray(i.items)) return acc + countConditions(i.items as unknown[]);
    return acc + 1;
  }, 0);
}

function parseScanConditionCount(scan_json: string): number {
  try {
    const parsed = JSON.parse(scan_json);
    const items = parsed.filterItems ?? parsed.conditions ?? [];
    return countConditions(items);
  } catch { return 0; }
}

function parseScanDirection(scan_json: string): "long" | "short" | null {
  try {
    const parsed = JSON.parse(scan_json);
    if (parsed.direction === "long" || parsed.direction === "short") return parsed.direction;
    return null;
  } catch { return null; }
}

export default function SavedScanPage() {
  const navigate = useNavigate();
  const [scans, setScans] = useState<ApiScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [dirFilter, setDirFilter] = useState<"all" | "long" | "short">("all");
  const [deleteTarget, setDeleteTarget] = useState<ApiScan | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPending, setImportPending] = useState<SavedScan[] | null>(null);
  const [importing, setImporting] = useState(false);

  const fetchScans = useCallback(async () => {
    try {
      setError(null);
      const data = await apiListScans();
      setScans(data);
    } catch {
      setError("Could not reach the backend server. Make sure it is running on port 3001.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchScans(); }, [fetchScans]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDeleteScan(deleteTarget.id);
      setScans(prev => prev.filter(s => s.id !== deleteTarget.id));
      toast.success(`Deleted "${deleteTarget.name}"`);
      setDeleteTarget(null);
    } catch { toast.error("Failed to delete scan"); }
    finally { setDeleting(false); }
  };

  const handleToggleFavorite = async (id: string) => {
    try {
      const updated = await apiToggleFavorite(id);
      setScans(prev => prev.map(s => s.id === id ? updated : s));
    } catch { toast.error("Failed to update favorite"); }
  };

  const handleDuplicate = async (id: string, name: string) => {
    try {
      const copy = await apiDuplicateScan(id);
      setScans(prev => [copy, ...prev]);
      toast.success(`Duplicated as "${copy.name}"`);
    } catch { toast.error(`Failed to duplicate "${name}"`); }
  };

  const handleExport = () => {
    if (!scans.length) { toast.error("No scans to export"); return; }
    const payload = scans.map(s => {
      let parsed = {};
      try { parsed = JSON.parse(s.scan_json); } catch {}
      return { ...parsed, name: s.name, folder: s.folder, is_favorite: s.is_favorite };
    });
    const blob = new Blob([JSON.stringify({ version: 1, scans: payload }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bharatscan-scans-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${scans.length} scan${scans.length !== 1 ? "s" : ""}`);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const json = JSON.parse(evt.target?.result as string);
        const rows: SavedScan[] = Array.isArray(json) ? json : (json.scans ?? []);
        if (!rows.length) { toast.error("No scans found in file"); return; }
        const valid = rows.filter(r => r.name && (r.filterItems || r.conditions));
        if (!valid.length) { toast.error("File contains no valid scans"); return; }
        setImportPending(valid);
      } catch { toast.error("Invalid JSON file"); }
    };
    reader.readAsText(file);
  };

  const executeImport = async (mode: "append" | "replace") => {
    if (!importPending?.length) return;
    setImporting(true);
    try {
      if (mode === "replace") {
        for (const s of scans) await apiDeleteScan(s.id);
      }
      for (const scan of importPending) {
        const { filterItems, topLogicMode } = migrateSavedScan(scan);
        const scan_json = JSON.stringify({ filterItems, topLogicMode, series: scan.series ?? "EQ" });
        const created = await apiCreateScan({ name: scan.name, scan_json, folder: scan.folder ?? undefined });
        if (scan.is_favorite) await apiToggleFavorite(created.id).catch(() => {});
      }
      await fetchScans();
      setImportPending(null);
      toast.success(mode === "replace"
        ? `Replaced all scans — imported ${importPending.length}`
        : `Appended ${importPending.length} scan${importPending.length !== 1 ? "s" : ""}`
      );
    } catch { toast.error("Import failed"); }
    finally { setImporting(false); }
  };

  const filtered = scans.filter(s => {
    if (!s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (favOnly && !s.is_favorite) return false;
    if (dirFilter !== "all") {
      const dir = parseScanDirection(s.scan_json);
      if (dirFilter === "long" && dir !== "long") return false;
      if (dirFilter === "short" && dir !== "short") return false;
    }
    return true;
  });

  return (
    <div className="bg-background">
      <main className="container py-2 space-y-2">
        {/* Page title bar */}
        <div className="flex items-center justify-between gap-3">
          <div className="shrink-0">
            <h1 className="text-base font-bold tracking-tight text-foreground">Saved Scans</h1>
            <p className="text-[10px] text-muted-foreground">Load or run your saved scan configurations</p>
          </div>
          {/* Search — inline with title to save vertical space */}
          <div className="relative w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input className="pl-8 h-7 text-xs bg-input" placeholder="Search scans…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleExport} disabled={!scans.length}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => fileInputRef.current?.click()}>
              <FolderInput className="h-3.5 w-3.5" /> Import
            </Button>
            <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
            <Button size="sm" className="h-7 text-xs bg-gradient-primary text-primary-foreground hover:opacity-90"
              onClick={() => navigate("/create-scan")}>
              + New Scan
            </Button>
          </div>
        </div>
        {error && (
          <Card className="p-4 border-destructive/50 bg-destructive/5 flex items-start gap-3">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">Backend unavailable</p>
              <p className="text-xs text-muted-foreground mt-0.5">{error}</p>
            </div>
          </Card>
        )}

        {/* Table */}
        <Card className="shadow-card overflow-hidden">
          <div className="px-4 py-1.5 border-b border-border bg-muted/20 flex items-center justify-between">
            <h3 className="text-xs font-bold tracking-wide text-muted-foreground uppercase">Scans</h3>
            <span className="text-[10px] text-muted-foreground">{scans.length} scan{scans.length !== 1 ? "s" : ""} saved</span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading…</span>
            </div>
          ) : scans.length === 0 ? (
            <div className="py-10 text-center">
              <FolderOpen className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground font-medium">No saved scans yet</p>
              <p className="text-xs text-muted-foreground/50 mt-1">Create and save a scan from the Create Scan page</p>
              <Button size="sm" className="mt-4 h-7 text-xs bg-gradient-primary text-primary-foreground"
                onClick={() => navigate("/create-scan")}>
                Go to Create Scan
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[9px] uppercase tracking-wide text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-1 w-6">
                      <button type="button" onClick={() => setFavOnly(v => !v)}
                        title={favOnly ? "Show all scans" : "Show favourites only"}>
                        <Star className={`h-3.5 w-3.5 transition-colors ${favOnly ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/40 hover:text-yellow-400"}`} />
                      </button>
                    </th>
                    {/* Direction column header with dropdown filter */}
                    <th className="px-2 py-1 w-14">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button type="button" className={`inline-flex items-center gap-0.5 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-wide transition-colors border ${
                            dirFilter === "long"  ? "bg-success/15 border-success/30 text-success" :
                            dirFilter === "short" ? "bg-destructive/15 border-destructive/30 text-destructive-bright" :
                            "border-border text-muted-foreground hover:text-foreground"
                          }`}>
                            {dirFilter === "all" ? "All" : dirFilter === "long" ? "Long" : "Short"}
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-[90px]">
                          <DropdownMenuItem onClick={() => setDirFilter("all")} className={`text-xs ${dirFilter === "all" ? "font-bold" : ""}`}>All</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDirFilter("long")} className={`text-xs text-success ${dirFilter === "long" ? "font-bold" : ""}`}>Long</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDirFilter("short")} className={`text-xs text-destructive-bright ${dirFilter === "short" ? "font-bold" : ""}`}>Short</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </th>
                    <th className="text-left px-3 py-1">Name</th>
                    <th className="text-left px-3 py-1">Modified</th>
                    <th className="text-left px-3 py-1">Saved On</th>
                    <th className="text-right px-3 py-1">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                        No {dirFilter !== "all" ? dirFilter : ""} scans match your filters
                      </td>
                    </tr>
                  )}
                  {filtered.map((s, i) => (
                    <tr key={s.id} className={`border-t border-border/50 hover:bg-primary/5 transition-colors ${i % 2 === 0 ? "bg-card" : "bg-muted/10"}`}>
                      {/* Favorite */}
                      <td className="px-3 py-1.5">
                        <button type="button" onClick={() => handleToggleFavorite(s.id)}
                          title={s.is_favorite ? "Remove favorite" : "Mark favorite"}>
                          <Star className={`h-3.5 w-3.5 transition-colors ${s.is_favorite ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30 hover:text-yellow-400"}`} />
                        </button>
                      </td>
                      {/* Direction badge */}
                      <td className="px-2 py-1.5 text-center">
                        {(() => {
                          const dir = parseScanDirection(s.scan_json);
                          return dir ? (
                            <span className={`inline-flex items-center rounded px-1.5 py-px text-[9px] font-bold leading-none ${
                              dir === "long"
                                ? "bg-success/15 border border-success/30 text-success"
                                : "bg-destructive/15 border border-destructive/30 text-destructive-bright"
                            }`}>
                              {dir === "long" ? "Long" : "Short"}
                            </span>
                          ) : <span className="text-muted-foreground/30">—</span>;
                        })()}
                      </td>
                      {/* Name — Load Scan button sits right before the name */}
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <Button size="sm"
                            className="h-5 text-[10px] px-2 shrink-0 bg-white/10 text-white/80 border border-white/20 hover:bg-primary hover:text-primary-foreground hover:border-primary active:scale-95 active:brightness-90 transition-all duration-150 shadow-none"
                            onClick={() => navigate("/create-scan", { state: { scanId: s.id, scanName: s.name } })}>
                            Load Scan
                          </Button>
                          <BookMarked className="h-3.5 w-3.5 text-primary/50 shrink-0" />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="font-semibold text-foreground">{s.name}</p>
                              {(() => {
                                const n = parseScanConditionCount(s.scan_json);
                                return n > 0 ? (
                                  <span className="inline-flex items-center rounded-full bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-[9px] font-medium text-primary/70 leading-none">
                                    {n} condition{n !== 1 ? "s" : ""}
                                  </span>
                                ) : null;
                              })()}
                            </div>
                            {s.folder && <p className="text-[10px] text-muted-foreground/60">{s.folder}</p>}
                          </div>
                        </div>
                      </td>
                      {/* Modified date */}
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <PenLine className="h-2.5 w-2.5 shrink-0" />
                          {fmtDate(s.updated_at)}
                        </div>
                      </td>
                      {/* Saved date */}
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Clock className="h-2.5 w-2.5 shrink-0" />
                          {fmtDate(s.created_at)}
                        </div>
                      </td>
                      {/* Actions — duplicate + delete only */}
                      <td className="px-3 py-1.5">
                        <div className="flex items-center justify-end gap-0.5">
                          <button type="button" onClick={() => handleDuplicate(s.id, s.name)}
                            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Duplicate scan">
                            <BookMarked className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={() => setDeleteTarget(s)}
                            className="p-1.5 rounded text-muted-foreground hover:text-destructive-bright hover:bg-destructive-bright/10 transition-colors"
                            title="Delete scan">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </main>

      {/* Import: Append or Replace */}
      <Dialog open={!!importPending} onOpenChange={o => { if (!o && !importing) setImportPending(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Import Scans</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground mt-1">
            Found <strong className="text-foreground">{importPending?.length ?? 0} scan{importPending?.length !== 1 ? "s" : ""}</strong> in the file.
            How would you like to import them?
          </p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <button type="button" disabled={importing} onClick={() => executeImport("append")}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50">
              <FolderInput className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs font-semibold text-foreground">Append</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">Add to existing scans</p>
              </div>
            </button>
            <button type="button" disabled={importing} onClick={() => executeImport("replace")}
              className="flex flex-col items-center gap-2 rounded-lg border border-destructive-bright/30 bg-card p-4 hover:border-destructive-bright/60 hover:bg-destructive-bright/5 transition-colors disabled:opacity-50">
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
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={importing}
              onClick={() => setImportPending(null)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={o => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Delete Scan</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground mt-1">
            Delete <strong className="text-foreground">"{deleteTarget?.name}"</strong>?
            This cannot be undone.
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
