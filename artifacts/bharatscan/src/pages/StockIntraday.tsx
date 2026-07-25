import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Database,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Table2,
  Wifi,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useData } from "@/context/DataContext";
import { apiGetMarketQuotes, type ApiLiveQuote } from "@/lib/api";
import type { UniverseCategory } from "@/lib/universe";

const QUOTE_BATCH_SIZE = 50;
const REFRESH_INTERVAL_MS = 15_000;

interface StockIntradayRow {
  ticker: string;
  quote?: ApiLiveQuote;
}

function formatPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 2,
  });
}

function formatVolume(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 0) return "—";
  return Math.round(value).toLocaleString("en-IN");
}

function fyersSymbol(ticker: string): string {
  return ticker.includes(":") ? ticker : `NSE:${ticker}-EQ`;
}

function isSamePrice(a: number, b: number): boolean {
  return a > 0 && b > 0 && Math.abs(a - b) < 0.005;
}

type ConditionKey =
  | "open-low"
  | "open-high"
  | "open-close"
  | "ltp-open"
  | "ltp-low"
  | "ltp-high"
  | "ltp-close"
  | "high-open"
  | "low-open"
  | "high-close"
  | "low-close"
  | "high-low"
  | "volume-active";

type MetricKey = "open" | "high" | "low" | "close" | "ltp" | "volume";
type ComparisonOperator = "=" | ">" | "<" | ">=" | "<=" | "!=";

interface CustomCondition {
  left: MetricKey;
  operator: ComparisonOperator;
  right: MetricKey;
}

interface ConditionColumn {
  id: number;
  key: ConditionKey | "custom";
  custom?: CustomCondition;
  removable: boolean;
}

interface ConditionDefinition {
  key: ConditionKey;
  label: string;
  matches: (quote: ApiLiveQuote) => boolean;
}

const METRIC_LABELS: Record<MetricKey, string> = {
  open: "OPEN",
  high: "HIGH",
  low: "LOW",
  close: "PRV CLOSE",
  ltp: "LTP",
  volume: "VOLUME",
};

const METRIC_OPTIONS: MetricKey[] = ["open", "high", "low", "close", "ltp", "volume"];

const OPERATOR_LABELS: Record<ComparisonOperator, string> = {
  "=": "=",
  ">": ">",
  "<": "<",
  ">=": "≥",
  "<=": "≤",
  "!=": "≠",
};

const OPERATOR_OPTIONS: ComparisonOperator[] = ["=", ">", "<", ">=", "<=", "!="];

function metricValue(quote: ApiLiveQuote, metric: MetricKey): number {
  return metric === "close" ? quote.close : quote[metric];
}

function compareValues(left: number, operator: ComparisonOperator, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0 || right === 0) return false;
  switch (operator) {
    case "=": return isSamePrice(left, right);
    case ">": return left > right;
    case "<": return left < right;
    case ">=": return left >= right;
    case "<=": return left <= right;
    case "!=": return !isSamePrice(left, right);
  }
}

const CONDITION_OPTIONS: ConditionDefinition[] = [
  { key: "open-low", label: "OPEN=LOW", matches: (quote) => isSamePrice(quote.open, quote.low) },
  { key: "open-high", label: "OPEN=HIGH", matches: (quote) => isSamePrice(quote.open, quote.high) },
  { key: "open-close", label: "OPEN=PRV CLOSE", matches: (quote) => isSamePrice(quote.open, quote.close) },
  { key: "ltp-open", label: "LTP>OPEN", matches: (quote) => quote.ltp > quote.open && quote.ltp > 0 && quote.open > 0 },
  { key: "ltp-low", label: "LTP>LOW", matches: (quote) => quote.ltp > quote.low && quote.ltp > 0 && quote.low > 0 },
  { key: "ltp-high", label: "LTP>HIGH", matches: (quote) => quote.ltp > quote.high && quote.ltp > 0 && quote.high > 0 },
  { key: "ltp-close", label: "LTP>PRV CLOSE", matches: (quote) => quote.ltp > quote.close && quote.ltp > 0 && quote.close > 0 },
  { key: "high-open", label: "HIGH>OPEN", matches: (quote) => quote.high > quote.open && quote.high > 0 && quote.open > 0 },
  { key: "low-open", label: "LOW<OPEN", matches: (quote) => quote.low < quote.open && quote.low > 0 && quote.open > 0 },
  { key: "high-close", label: "HIGH>PRV CLOSE", matches: (quote) => quote.high > quote.close && quote.high > 0 && quote.close > 0 },
  { key: "low-close", label: "LOW<PRV CLOSE", matches: (quote) => quote.low < quote.close && quote.low > 0 && quote.close > 0 },
  { key: "high-low", label: "HIGH>LOW", matches: (quote) => quote.high > quote.low && quote.high > 0 && quote.low > 0 },
  { key: "volume-active", label: "VOLUME>0", matches: (quote) => quote.volume > 0 },
];

const DEFAULT_CUSTOM_CONDITION: CustomCondition = {
  left: "open",
  operator: ">",
  right: "close",
};

function conditionLabel(column: ConditionColumn): string {
  if (column.key === "custom") {
    const custom = column.custom ?? DEFAULT_CUSTOM_CONDITION;
    return `${METRIC_LABELS[custom.left]}${OPERATOR_LABELS[custom.operator]}${METRIC_LABELS[custom.right]}`;
  }
  return CONDITION_OPTIONS.find((condition) => condition.key === column.key)?.label ?? "Condition";
}

function conditionMatches(column: ConditionColumn, quote?: ApiLiveQuote): boolean | null {
  if (!quote) return null;
  if (column.key === "custom") {
    const custom = column.custom ?? DEFAULT_CUSTOM_CONDITION;
    return compareValues(metricValue(quote, custom.left), custom.operator, metricValue(quote, custom.right));
  }
  return CONDITION_OPTIONS.find((condition) => condition.key === column.key)?.matches(quote) ?? false;
}

function CellValue({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={children === "—" ? "text-muted-foreground/35" : className}>
      {children}
    </span>
  );
}

function TableHeader({
  label,
  align = "right",
  className = "",
}: {
  label: string;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  const alignment = {
    left: "justify-start text-left",
    center: "justify-center text-center",
    right: "justify-end text-right",
  }[align];

  return (
    <th
      scope="col"
      className={`sticky top-0 z-[1] border-b border-r border-border/60 px-2 py-1.5 text-[9px] font-bold uppercase tracking-wide text-muted-foreground last:border-r-0 ${className}`}
    >
      <div className={`flex items-center gap-1 whitespace-nowrap ${alignment}`}>{label}</div>
    </th>
  );
}

function ConditionHeader({
  column,
  onChange,
  onCustomChange,
  onRemove,
}: {
  column: ConditionColumn;
  onChange: (key: ConditionKey | "custom") => void;
  onCustomChange: (custom: CustomCondition) => void;
  onRemove: () => void;
}) {
  const custom = column.custom ?? DEFAULT_CUSTOM_CONDITION;

  return (
    <th className="sticky top-0 z-[1] w-[116px] border-b border-r border-border/60 px-1 py-1 last:border-r-0">
      <div className="flex items-center justify-center gap-0.5">
        <Select value={column.key} onValueChange={onChange}>
          <SelectTrigger className="h-5 min-w-0 flex-1 gap-0.5 border-0 bg-transparent px-1 text-[8px] font-bold uppercase tracking-wide text-muted-foreground shadow-none focus:ring-0">
            <SelectValue>{conditionLabel(column)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {CONDITION_OPTIONS.map((condition) => (
              <SelectItem key={condition.key} value={condition.key} className="text-xs">
                {condition.label}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value="custom" className="text-xs">Custom condition…</SelectItem>
          </SelectContent>
        </Select>

        {column.key === "custom" && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Edit custom condition"
                title="Edit custom condition"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              >
                <Settings2 className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="center" className="w-64 space-y-3 p-3">
              <div>
                <p className="text-xs font-semibold text-foreground">Custom condition</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Compare any two live fields.</p>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
                <Select
                  value={custom.left}
                  onValueChange={(value) => onCustomChange({ ...custom, left: value as MetricKey })}
                >
                  <SelectTrigger className="h-7 px-2 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_OPTIONS.map((metric) => (
                      <SelectItem key={metric} value={metric} className="text-xs">{METRIC_LABELS[metric]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={custom.operator}
                  onValueChange={(value) => onCustomChange({ ...custom, operator: value as ComparisonOperator })}
                >
                  <SelectTrigger className="h-7 w-12 px-2 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATOR_OPTIONS.map((operator) => (
                      <SelectItem key={operator} value={operator} className="text-xs">{OPERATOR_LABELS[operator]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={custom.right}
                  onValueChange={(value) => onCustomChange({ ...custom, right: value as MetricKey })}
                >
                  <SelectTrigger className="h-7 px-2 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRIC_OPTIONS.map((metric) => (
                      <SelectItem key={metric} value={metric} className="text-xs">{METRIC_LABELS[metric]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {column.removable && (
          <button
            type="button"
            aria-label={`Remove ${conditionLabel(column)} condition`}
            title="Remove condition"
            onClick={onRemove}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
          >
            <Minus className="h-3 w-3" />
          </button>
        )}
      </div>
    </th>
  );
}

function quoteTicker(quote: ApiLiveQuote): string {
  const base = quote.symbol.includes(":") ? quote.symbol.split(":").pop() ?? quote.symbol : quote.symbol;
  return base.replace(/-EQ$/i, "").toUpperCase();
}

export default function StockIntraday() {
  const { categories } = useData();
  const [selectedUniverseId, setSelectedUniverseId] = useState("");
  const [nextConditionId, setNextConditionId] = useState(3);
  const [conditionColumns, setConditionColumns] = useState<ConditionColumn[]>([
    { id: 1, key: "open-low", removable: false },
    { id: 2, key: "open-high", removable: false },
  ]);
  const [quotes, setQuotes] = useState<Record<string, ApiLiveQuote>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stockUniverses = useMemo<UniverseCategory[]>(() => categories, [categories]);

  useEffect(() => {
    if (!stockUniverses.length) {
      setSelectedUniverseId("");
      return;
    }
    if (!stockUniverses.some((category) => category.id === selectedUniverseId)) {
      setSelectedUniverseId(stockUniverses[0].id);
    }
  }, [selectedUniverseId, stockUniverses]);

  const selectedUniverse = useMemo(
    () => stockUniverses.find((category) => category.id === selectedUniverseId) ?? null,
    [selectedUniverseId, stockUniverses],
  );

  const rows = useMemo<StockIntradayRow[]>(
    () => (selectedUniverse?.symbols ?? []).map((ticker) => ({
      ticker,
      quote: quotes[fyersSymbol(ticker)] ?? quotes[ticker],
    })),
    [quotes, selectedUniverse],
  );

  async function loadQuotes() {
    if (!selectedUniverse?.symbols.length) return;
    setLoading(true);
    setError(null);

    const nextQuotes: Record<string, ApiLiveQuote> = {};
    try {
      for (let i = 0; i < selectedUniverse.symbols.length; i += QUOTE_BATCH_SIZE) {
        const batch = selectedUniverse.symbols.slice(i, i + QUOTE_BATCH_SIZE);
        const response = await apiGetMarketQuotes(batch.map(fyersSymbol));
        for (const quote of response.quotes) {
          nextQuotes[quote.symbol] = quote;
          nextQuotes[quoteTicker(quote)] = quote;
        }
      }
      setQuotes(nextQuotes);
      setLastUpdated(new Date());
    } catch (err) {
      setQuotes(nextQuotes);
      setError(
        err instanceof Error && /No broker connected/i.test(err.message)
          ? "Connect a broker to load live intraday quotes."
          : "Live quotes could not be loaded. Try refreshing again.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setQuotes({});
    setError(null);
    setLastUpdated(null);
    if (!selectedUniverse?.symbols.length) return;

    void loadQuotes();
    const interval = window.setInterval(() => {
      void loadQuotes();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // The selected universe is the only input that should restart the polling loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUniverseId]);

  const quoteCount = rows.filter((row) => row.quote).length;
  const addConditionColumn = () => {
    setConditionColumns((current) => [
      ...current,
      {
        id: nextConditionId,
        key: CONDITION_OPTIONS[current.length % CONDITION_OPTIONS.length].key,
        removable: true,
      },
    ]);
    setNextConditionId((current) => current + 1);
  };
  const updateCondition = (id: number, key: ConditionKey | "custom") => {
    setConditionColumns((current) => current.map((column) => (
      column.id === id
        ? { ...column, key, custom: key === "custom" ? (column.custom ?? DEFAULT_CUSTOM_CONDITION) : undefined }
        : column
    )));
  };
  const updateCustomCondition = (id: number, custom: CustomCondition) => {
    setConditionColumns((current) => current.map((column) => (
      column.id === id ? { ...column, key: "custom", custom } : column
    )));
  };
  const removeCondition = (id: number) => {
    setConditionColumns((current) => current.filter((column) => column.id !== id));
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="container space-y-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-bold text-foreground">Stock Intraday</h1>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Live OHLCV snapshot with OPEN=LOW and OPEN=HIGH conditions
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-muted-foreground">Stock universe</span>
              <Select value={selectedUniverseId} onValueChange={setSelectedUniverseId}>
              <SelectTrigger className="h-8 min-w-[190px] bg-muted/30 text-xs">
                  <SelectValue placeholder="Pick a universe…" />
                </SelectTrigger>
                <SelectContent>
                  {stockUniverses.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name} ({category.symbols.length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void loadQuotes()}
              disabled={loading || !selectedUniverse?.symbols.length}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {!stockUniverses.length && (
          <Card className="flex min-h-[260px] flex-col items-center justify-center gap-2 px-6 text-center shadow-card">
            <Database className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm font-semibold text-foreground">No stock universes available</p>
            <p className="max-w-md text-xs text-muted-foreground">
              Upload a watchlist CSV in Settings or wait for the server symbol master to load.
            </p>
          </Card>
        )}

        {selectedUniverse && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-foreground">{selectedUniverse.name}</span>
                <span>{rows.length.toLocaleString("en-IN")} stocks</span>
                <span>{quoteCount.toLocaleString("en-IN")} live quotes</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Wifi className={`h-3 w-3 ${quoteCount ? "text-emerald-400" : "text-muted-foreground/60"}`} />
                {lastUpdated
                  ? `Updated ${lastUpdated.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                  : "Waiting for live data"}
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

             <Card className="overflow-hidden shadow-card">
               <div className="flex items-center justify-between border-b border-border bg-muted/20 px-3 py-2">
                 <div className="flex items-center gap-1.5">
                   <Table2 className="h-3.5 w-3.5 text-cyan-400" />
                   <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                     Stock Intraday — Live OHLCV Snapshot
                   </h3>
                 </div>
                 <span className="text-[9px] text-muted-foreground/40">
                   {rows.length.toLocaleString("en-IN")} symbols
                 </span>
               </div>
              <div className="overflow-auto">
                  <table className="w-max min-w-[860px] table-fixed text-xs">
                  <thead>
                     <tr>
                       <TableHeader label="Ticker" align="left" className="w-[130px]" />
                       <TableHeader label="Prv. Close" className="w-[82px]" />
                       <TableHeader label="Open" className="w-[82px]" />
                       <TableHeader label="High" className="w-[82px]" />
                       <TableHeader label="Low" className="w-[82px]" />
                       <TableHeader label="LTP" className="w-[82px]" />
                       <TableHeader label="Volume" className="w-[92px]" />
                       {conditionColumns.map((column) => {
                         return (
                           <ConditionHeader
                             key={column.id}
                             column={column}
                             onChange={(key) => updateCondition(column.id, key)}
                             onCustomChange={(custom) => updateCustomCondition(column.id, custom)}
                             onRemove={() => removeCondition(column.id)}
                           />
                         );
                       })}
                       <th className="sticky top-0 z-[1] w-[34px] border-b border-border/60 px-1 py-1.5">
                         <button
                           type="button"
                           aria-label="Add condition column"
                           title="Add condition column"
                           onClick={addConditionColumn}
                           className="mx-auto flex h-5 w-5 items-center justify-center rounded text-base font-medium leading-none text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                         >
                           <Plus className="h-3.5 w-3.5" />
                         </button>
                       </th>
                    </tr>
                  </thead>
                  <tbody>
                     {rows.map(({ ticker, quote }, index) => {
                      return (
                        <tr
                          key={ticker}
                           className={`border-t border-border/40 transition-colors ${
                             index % 2 === 0 ? "bg-card hover:bg-primary/5" : "bg-muted/10 hover:bg-primary/5"
                           }`}
                        >
                           <td className="border-r border-border/35 px-2 py-1.5 text-left font-bold tracking-wide text-foreground last:border-r-0">
                            {ticker}
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground last:border-r-0">
                            <CellValue className="text-muted-foreground">{formatPrice(quote?.close)}</CellValue>
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground last:border-r-0">
                            <CellValue className="text-muted-foreground">{formatPrice(quote?.open)}</CellValue>
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground last:border-r-0">
                            <CellValue className="text-muted-foreground">{formatPrice(quote?.high)}</CellValue>
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground last:border-r-0">
                            <CellValue className="text-muted-foreground">{formatPrice(quote?.low)}</CellValue>
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-semibold tabular-nums text-foreground last:border-r-0">
                            <CellValue className="text-foreground">{formatPrice(quote?.ltp)}</CellValue>
                          </td>
                          <td className="border-r border-border/35 px-2 py-1.5 text-right text-xs font-medium tabular-nums text-muted-foreground last:border-r-0">
                            <CellValue className="text-muted-foreground">{formatVolume(quote?.volume)}</CellValue>
                          </td>
                          {conditionColumns.map((column) => {
                            const matches = conditionMatches(column, quote);
                            return (
                              <td
                                key={column.id}
                                className="border-r border-border/35 px-2 py-1.5 text-center text-[10px] font-bold last:border-r-0"
                              >
                                {matches === true ? (
                                  <span className="inline-flex rounded bg-emerald-400/15 px-1.5 py-0.5 text-emerald-400">POSITIVE</span>
                                ) : (
                                  <CellValue>—</CellValue>
                                )}
                              </td>
                            );
                          })}
                          <td className="border-r border-border/35 px-1 py-1.5 last:border-r-0" />
                        </tr>
                      );
                    })}
                    {!rows.length && (
                      <tr>
                        <td colSpan={conditionColumns.length + 8} className="px-4 py-12 text-center text-xs text-muted-foreground">
                          This universe has no symbols.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}