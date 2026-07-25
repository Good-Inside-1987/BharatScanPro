import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Database,
  RefreshCw,
  Table2,
  Wifi,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

function SpreadsheetHeader({
  label,
  className = "",
}: {
  label: string;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`sticky top-0 z-[1] border-r border-slate-700/70 px-3 py-2 text-center text-[10px] font-bold uppercase tracking-wide text-slate-950 ${className}`}
    >
      <div className="flex items-center justify-center gap-1">
        {label}
        <span className="text-[8px] opacity-50">▾</span>
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
  const [quotes, setQuotes] = useState<Record<string, ApiLiveQuote>>({});
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stockUniverses = useMemo<UniverseCategory[]>(() => {
    const withoutFutures = categories.filter((category) => !/^futures?$/i.test(category.name.trim()));
    return withoutFutures.length ? withoutFutures : categories;
  }, [categories]);

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

  return (
    <div className="min-h-screen bg-background">
      <main className="container py-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Table2 className="h-4 w-4 text-primary" />
              <h1 className="text-base font-bold text-foreground">Stock Intraday</h1>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Live OHLCV snapshot with OPEN=LOW and OPEN=HIGH conditions
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-medium text-muted-foreground">Stock universe</span>
              <Select value={selectedUniverseId} onValueChange={setSelectedUniverseId}>
                <SelectTrigger className="h-8 min-w-[190px] bg-input text-xs">
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
              <div className="overflow-auto">
                <table className="min-w-[1060px] w-full border-collapse text-xs">
                  <thead>
                    <tr className="bg-sky-500">
                      <SpreadsheetHeader label="Ticker" className="w-[180px] bg-sky-500" />
                      <SpreadsheetHeader label="Prv. Close" className="bg-sky-500" />
                      <SpreadsheetHeader label="Open" className="bg-sky-500" />
                      <SpreadsheetHeader label="High" className="bg-sky-500" />
                      <SpreadsheetHeader label="Low" className="bg-sky-500" />
                      <SpreadsheetHeader label="LTP" className="bg-sky-500" />
                      <SpreadsheetHeader label="Volume" className="bg-yellow-300" />
                      <SpreadsheetHeader label="OPEN=LOW" className="bg-orange-400" />
                      <SpreadsheetHeader label="OPEN=HIGH" className="bg-orange-400" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ ticker, quote }, index) => {
                      const openLow = quote ? isSamePrice(quote.open, quote.low) : false;
                      const openHigh = quote ? isSamePrice(quote.open, quote.high) : false;
                      return (
                        <tr
                          key={ticker}
                          className={`border-b border-slate-300/80 ${index % 2 ? "bg-background" : "bg-muted/20"} hover:bg-primary/10`}
                        >
                          <td className="border-r border-slate-300/80 px-3 py-1.5 font-semibold tracking-wide text-foreground">
                            {ticker}
                          </td>
                          <td className="border-r border-slate-300/80 px-3 py-1.5 text-right tabular-nums">{formatPrice(quote?.close)}</td>
                          <td className="border-r border-slate-300/80 px-3 py-1.5 text-right tabular-nums">{formatPrice(quote?.open)}</td>
                          <td className="border-r border-slate-300/80 px-3 py-1.5 text-right tabular-nums">{formatPrice(quote?.high)}</td>
                          <td className="border-r border-slate-300/80 px-3 py-1.5 text-right tabular-nums">{formatPrice(quote?.low)}</td>
                          <td className="border-r border-slate-300/80 px-3 py-1.5 text-right tabular-nums font-semibold">{formatPrice(quote?.ltp)}</td>
                          <td className="border-r border-slate-300/80 bg-yellow-300/10 px-3 py-1.5 text-right tabular-nums">{formatVolume(quote?.volume)}</td>
                          <td className={`border-r border-slate-300/80 px-3 py-1.5 text-center text-[10px] font-bold ${openLow ? "bg-green-600 text-white" : ""}`}>
                            {quote ? (openLow ? "POSITIVE" : "") : "—"}
                          </td>
                          <td className={`px-3 py-1.5 text-center text-[10px] font-bold ${openHigh ? "bg-green-600 text-white" : ""}`}>
                            {quote ? (openHigh ? "POSITIVE" : "") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                    {!rows.length && (
                      <tr>
                        <td colSpan={9} className="px-4 py-12 text-center text-xs text-muted-foreground">
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