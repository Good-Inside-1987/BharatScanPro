import { createHash } from "node:crypto";
import type {
  Bar,
  BrokerAdapter,
  BrokerCredentials,
  OptionChainData,
  Quote,
} from "./types.js";
import { FyersApiError, type BrokerErrorDetails } from "../errors/brokerErrors.js";

const FYERS_DATA_BASE = "https://api-t1.fyers.in/data";

// Fyers History API per-request date-range limits, in calendar days.
const MAX_DAYS_DAILY = 366;
const MAX_DAYS_INTRADAY = 100;
const MAX_DAYS_SECONDS = 30;

const INTRADAY_MINUTE_RESOLUTIONS = new Set([
  "1", "2", "3", "5", "10", "15", "20", "30", "45", "60", "120", "180", "240",
]);

function isDailyResolution(resolution: string): boolean {
  return resolution === "1D" || resolution === "D" || resolution === "D1";
}

function isSecondResolution(resolution: string): boolean {
  return /S$/i.test(resolution);
}

function maxDaysForResolution(resolution: string): number {
  if (isDailyResolution(resolution)) return MAX_DAYS_DAILY;
  if (isSecondResolution(resolution)) return MAX_DAYS_SECONDS;
  if (INTRADAY_MINUTE_RESOLUTIONS.has(resolution)) return MAX_DAYS_INTRADAY;
  // Unknown resolution: fall back to the most conservative window.
  return MAX_DAYS_SECONDS;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sanitizeResponseBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponseBody);
  if (!value || typeof value !== "object") return value;

  const sensitiveKeys = new Set([
    "access_token",
    "refresh_token",
    "token",
    "auth_code",
    "authorization",
    "client_secret",
    "secret",
  ]);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : sanitizeResponseBody(entry),
    ])
  );
}

function responsePreview(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return sanitizeResponseBody(JSON.parse(trimmed));
  } catch {
    return trimmed.slice(0, 2_000);
  }
}

/**
 * Splits [fromDate, toDate] into sequential chunks that each respect the
 * per-request day limit imposed by Fyers' History API for the given
 * resolution. Callers of getHistoricalData() never see this chunking.
 */
function chunkDateRange(
  fromDate: string,
  toDate: string,
  resolution: string
): Array<{ from: string; to: string }> {
  const maxDays = maxDaysForResolution(resolution);
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);

  const chunks: Array<{ from: string; to: string }> = [];
  let chunkStart = start;
  while (chunkStart <= end) {
    // maxDays is inclusive of both endpoints, so the last day of the chunk
    // is (maxDays - 1) days after chunkStart.
    const chunkEnd = addDays(chunkStart, maxDays - 1);
    const clampedEnd = chunkEnd < end ? chunkEnd : end;
    chunks.push({ from: toDateString(chunkStart), to: toDateString(clampedEnd) });
    chunkStart = addDays(clampedEnd, 1);
  }
  return chunks;
}

export class FyersAdapter implements BrokerAdapter {
  private appId?: string;
  private accessToken?: string;

  /**
   * Fyers' data APIs require both the App ID and access token on every
   * request (`Authorization: <appId>:<accessToken>`), but the shared
   * BrokerAdapter interface only carries those through login(). Callers
   * that want to use getHistoricalData/getQuotes/getOptionChain must call
   * this first with the values obtained from a prior login().
   */
  configureSession(appId: string, accessToken: string): void {
    this.appId = appId;
    this.accessToken = accessToken;
  }

  private authHeader(): string {
    if (!this.appId || !this.accessToken) {
      throw new Error(
        "FyersAdapter session not configured; call configureSession(appId, accessToken) before requesting market data"
      );
    }
    return `${this.appId}:${this.accessToken}`;
  }

  /**
   * Fetch a URL and parse the response as JSON.
   *
   * Fyers commonly returns HTTP 200 with {s:"error", message:"..."} for
   * rejected requests, so both transport-level and broker-level context are
   * captured here. Authentication headers and request bodies are deliberately
   * excluded from the diagnostic payload.
   */
  private async fetchJson<T>(
    url: string | URL,
    init?: RequestInit,
    context: Pick<BrokerErrorDetails, "operation" | "request"> = {}
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FyersApiError(
        {
          provider: "fyers",
          operation: context.operation,
          request: context.request,
        },
        `Fyers ${context.operation ?? "REST"} request failed: ${message}`
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const body = responsePreview(text);
    const baseDetails: BrokerErrorDetails = {
      provider: "fyers",
      operation: context.operation,
      httpStatus: response.status,
      request: context.request,
      responseBody: body,
    };

    if (contentType.includes("text/html") || text.trimStart().startsWith("<")) {
      throw new FyersApiError(
        {
          ...baseDetails,
          brokerMessage: response.status === 429
            ? "Rate limited by Fyers (received HTML instead of JSON)"
            : "Fyers returned an HTML response instead of JSON",
        },
        response.status === 429
          ? "Rate limited by Fyers (received HTML instead of JSON)"
          : `Fyers returned an HTML response instead of JSON (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const brokerMessage =
        body && typeof body === "object" && "message" in body
          ? String((body as { message?: unknown }).message ?? "")
          : undefined;
      const bodyPreview = typeof body === "string" ? body : JSON.stringify(body ?? {});
      throw new FyersApiError(
        { ...baseDetails, brokerMessage },
        `Fyers ${context.operation ?? "REST"} request failed (HTTP ${response.status}): ${brokerMessage || bodyPreview}`
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FyersApiError(
        {
          ...baseDetails,
          brokerMessage: "Fyers returned malformed JSON",
        },
        `Fyers returned malformed JSON (HTTP ${response.status})`
      );
    }
  }

  /**
   * For Fyers:
   *   credentials.apiKey     = App ID
   *   credentials.clientCode = Secret Key
   *   credentials.pin        = Redirect URI (unused in login)
   *   totpCode               = the auth code from Fyers redirect
   */
  async login(
    credentials: BrokerCredentials,
    totpCode: string
  ): Promise<string> {
    const appIdHash = createHash("sha256")
      .update(`${credentials.apiKey}:${credentials.clientCode}`)
      .digest("hex");

    const data = await this.fetchJson<{
      s: string;
      message?: string;
      access_token?: string;
    }>("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        appIdHash,
        code: totpCode,
      }),
    }, { operation: "login" });

    if (data.s !== "ok" || !data.access_token) {
      throw new FyersApiError({
        provider: "fyers",
        operation: "login",
        httpStatus: 200,
        brokerStatus: data.s,
        brokerMessage: data.message,
        responseBody: sanitizeResponseBody(data),
      });
    }

    return data.access_token;
  }

  async getHistoricalData(
    symbol: string,
    resolution: string,
    fromDate: string,
    toDate: string
  ): Promise<Bar[]> {
    const chunks = chunkDateRange(fromDate, toDate, resolution);
    const bars: Bar[] = [];

    for (const chunk of chunks) {
      const url = new URL(`${FYERS_DATA_BASE}/history`);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("resolution", resolution);
      url.searchParams.set("date_format", "1"); // yyyy-mm-dd
      url.searchParams.set("range_from", chunk.from);
      url.searchParams.set("range_to", chunk.to);
      url.searchParams.set("cont_flag", "1");

      const data = await this.fetchJson<{
        s: string;
        message?: string;
        candles?: number[][];
      }>(url.toString(), {
        headers: { Authorization: this.authHeader() },
      }, {
        operation: "history",
        request: {
          symbol,
          resolution,
          rangeFrom: chunk.from,
          rangeTo: chunk.to,
        },
      });

      if (data.s !== "ok") {
        throw new FyersApiError({
          provider: "fyers",
          operation: "history",
          httpStatus: 200,
          brokerStatus: data.s,
          brokerMessage: data.message,
          request: {
            symbol,
            resolution,
            rangeFrom: chunk.from,
            rangeTo: chunk.to,
          },
          responseBody: sanitizeResponseBody(data),
        });
      }

      for (const candle of data.candles ?? []) {
        // Fyers candles: [timestamp, open, high, low, close, volume] (6 values)
        // For options/futures, may also include OI as a 7th value.
        const [timestamp, open, high, low, close, volume, oi] = candle;
        const bar: Bar = {
          date: new Date(timestamp * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        };
        if (oi !== undefined) bar.oi = oi;
        bars.push(bar);
      }
    }

    return bars;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    const url = new URL(`${FYERS_DATA_BASE}/quotes`);
    url.searchParams.set("symbols", symbols.join(","));

    const data = await this.fetchJson<{
      s: string;
      message?: string;
      d?: Array<{
        n: string;
        v: {
          lp: number;
          open_price: number;
          high_price: number;
          low_price: number;
          prev_close_price: number;
          volume: number;
          tt?: number;
        };
      }>;
    }>(url.toString(), {
      headers: { Authorization: this.authHeader() },
    }, {
      operation: "quotes",
      request: { symbols },
    });

    if (data.s !== "ok") {
      throw new FyersApiError({
        provider: "fyers",
        operation: "quotes",
        httpStatus: 200,
        brokerStatus: data.s,
        brokerMessage: data.message,
        request: { symbols },
        responseBody: sanitizeResponseBody(data),
      });
    }

    return (data.d ?? []).map((entry) => ({
      symbol: entry.n,
      ltp: entry.v.lp,
      open: entry.v.open_price,
      high: entry.v.high_price,
      low: entry.v.low_price,
      close: entry.v.prev_close_price,
      volume: entry.v.volume,
      timestamp: entry.v.tt
        ? new Date(entry.v.tt * 1000).toISOString()
        : new Date().toISOString(),
    }));
  }

  async getOptionChain(
    underlying: string,
    expiry: string
  ): Promise<OptionChainData> {
    const url = new URL(`${FYERS_DATA_BASE}/options-chain-v3`);
    url.searchParams.set("symbol", underlying);
    // 50 covers both index (±30) and stock (±20) strike ranges defined in
    // optionsDataService.strikeRange(); the chain API requires this param.
    url.searchParams.set("strikecount", "50");
    // NOTE: The Fyers options-chain-v3 API uses `timestamp` to target a specific
    // expiry, but every confirmed-working community example sends it as "".
    // The correct non-empty format for future expiries is unconfirmed, so we
    // always send "" (returning the nearest expiry) and ignore the `expiry`
    // argument for URL construction. Callers pass `expiry` so the signature is
    // stable for when this is confirmed and can be wired up properly.
    url.searchParams.set("timestamp", "");

    const data = await this.fetchJson<{
      s: string;
      message?: string;
      data?: {
        optionsChain?: Array<Record<string, unknown>>;
        expiryData?: Array<string | number | Record<string, unknown>>;
        underlying_ltp?: number;
      };
    }>(url.toString(), {
      headers: { Authorization: this.authHeader() },
    }, {
      operation: "options-chain",
      request: { underlying, expiry },
    });

    if (data.s !== "ok") {
      throw new FyersApiError({
        provider: "fyers",
        operation: "options-chain",
        httpStatus: 200,
        brokerStatus: data.s,
        brokerMessage: data.message,
        request: { underlying, expiry },
        responseBody: sanitizeResponseBody(data),
      });
    }

    // Extract available expiry dates from the response meta
    const expiries: string[] = (data.data?.expiryData ?? []).map((entry) => {
      const raw = entry && typeof entry === "object"
        ? (entry as { expiry?: unknown; date?: unknown }).expiry ?? (entry as { date?: unknown }).date
        : entry;
      const ms = typeof raw === "number" ? raw * 1000 : Number(raw) * 1000;
      if (!Number.isFinite(ms)) return null;
      return new Date(ms).toISOString().slice(0, 10);
    }).filter((d): d is string => Boolean(d)).sort();

    const spotPrice = data.data?.underlying_ltp;

    const strikesByStrike = new Map<
      number,
      {
        strike: number;
        ceSymbol: string | null;
        peSymbol: string | null;
        ce: Record<string, unknown> | null;
        pe: Record<string, unknown> | null;
      }
    >();

    for (const row of data.data?.optionsChain ?? []) {
      const strike = row.strike_price as number | undefined;
      const optionType = row.option_type as string | undefined;
      if (strike === undefined || !optionType) continue;

      const sym = (row.symbol ?? row.sym_details ?? null) as string | null;

      const entry = strikesByStrike.get(strike) ?? {
        strike, ceSymbol: null, peSymbol: null, ce: null, pe: null,
      };
      if (optionType === "CE") { entry.ce = row; entry.ceSymbol = sym; }
      else if (optionType === "PE") { entry.pe = row; entry.peSymbol = sym; }
      strikesByStrike.set(strike, entry);
    }

    return {
      underlying,
      expiry,
      expiries,
      spotPrice,
      strikes: Array.from(strikesByStrike.values()).sort((a, b) => a.strike - b.strike),
    };
  }

  /**
   * Return available expiry dates for an underlying index/stock.
   * Calls the option chain API without a specific expiry so Fyers returns
   * the expiryData list in the response.
   */
  async getOptionExpiries(underlying: string): Promise<string[]> {
    const chain = await this.getOptionChain(underlying, "");
    return chain.expiries ?? [];
  }

  async refreshSession(_refreshToken: string): Promise<string> {
    throw new Error("FyersAdapter.refreshSession is not implemented");
  }
}
