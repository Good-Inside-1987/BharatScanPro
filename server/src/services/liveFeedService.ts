/**
 * liveFeedService.ts
 *
 * WebSocket-based live tick streaming from Fyers' Data WebSocket
 * (wss://api.fyers.in/socket/v2/data/). This is intentionally separate
 * from marketDataService.ts, which owns historical-bar backfill and the
 * REST-based getQuotes() fallback — this file must never be used to
 * implement polling loops against the REST quotes endpoint.
 *
 * Responsibilities
 * ─────────────────
 * 1. Maintain a single WebSocket connection to the Fyers data feed, opened
 *    once a Fyers session (appId + accessToken) is available.
 * 2. SubscriptionManager — tracks the currently-subscribed symbol set,
 *    enforcing Fyers' hard cap of 200 symbols across all instrument types.
 *    Adding symbols beyond the cap unsubscribes the least-recently-added
 *    ("oldest") symbols first (simple FIFO rotation).
 * 3. Quote cache — every incoming tick updates an in-memory
 *    Map<symbol, Quote>. No per-tick database writes.
 * 4. getLiveQuote()/getLiveQuotes() — read-only accessors over the cache.
 * 5. Reconnect with exponential backoff on any disconnect/error; a feed
 *    failure must never crash the server process.
 *
 * NOTE on the Fyers wire protocol: Fyers' official client libraries speak
 * a specific binary/JSON hybrid protocol that changes between SDK versions.
 * This implementation targets the documented JSON subscribe/unsubscribe
 * envelope and the common `{ symbol, ltp, ... }` tick shape. If Fyers
 * changes their message format, only `buildSubscribeMessage`,
 * `buildUnsubscribeMessage`, and `parseTickMessage` need to change — the
 * subscription manager, cache, and reconnect logic are protocol-agnostic.
 */

import { spawn, type ChildProcess } from "child_process";
import readline from "readline";
import { appDb, marketDb } from "../db.js";
import { decrypt } from "../lib/encryption.js";
import type { Quote } from "../adapters/types.js";
export const MAX_SUBSCRIBED_SYMBOLS = 200;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

// How often we sweep in-progress candles for ones whose minute has elapsed
// without a fresh tick arriving to trigger the boundary naturally (e.g. a
// thinly-traded symbol going quiet near the close). Kept well under a
// minute so a stalled symbol's candle is still persisted promptly.
const CANDLE_FLUSH_INTERVAL_MS = 15_000;

// ── Session lookup ──────────────────────────────────────────────────────────

interface BrokerConnectionRow {
  id: string;
  broker_name: string;
  api_key: string;
  access_token: string | null;
  token_generated_at: string | null;
  status: string;
}

const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

/**
 * Reads the most-recently-connected Fyers session directly from
 * broker_connections and decrypts it. Kept independent of
 * marketDataService's adapter cache since the live feed needs the raw
 * appId/accessToken pair to build the WS auth token, not a BrokerAdapter
 * instance.
 */
function getFyersSession(): { appId: string; accessToken: string } | null {
  const row = appDb
    .prepare(
      `SELECT id, broker_name, api_key, access_token, token_generated_at, status
         FROM broker_connections
        WHERE broker_name = 'fyers' AND status = 'connected'
        ORDER BY token_generated_at DESC
        LIMIT 1`
    )
    .get() as unknown as BrokerConnectionRow | undefined;

  if (!row?.access_token || !row.token_generated_at) return null;

  const tokenAge = Date.now() - new Date(row.token_generated_at).getTime();
  if (tokenAge > TOKEN_TTL_MS) return null;

  try {
    return {
      appId: decrypt(row.api_key),
      accessToken: decrypt(row.access_token),
    };
  } catch (err) {
    console.warn(
      "[liveFeedService] Could not decrypt stored Fyers session: %s",
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

// ── Quote cache ──────────────────────────────────────────────────────────────

const quoteCache = new Map<string, Quote>();

export function getLiveQuote(symbol: string): Quote | undefined {
  return quoteCache.get(symbol);
}

export function getLiveQuotes(symbols: string[]): Quote[] {
  const results: Quote[] = [];
  for (const symbol of symbols) {
    const quote = quoteCache.get(symbol);
    if (quote) results.push(quote);
  }
  return results;
}

// ── Intraday candle persistence ─────────────────────────────────────────────
//
// The quote cache above is transient (lost on restart/disconnect). To keep a
// durable record of what the live feed saw, every tick also feeds an
// in-memory per-symbol 1-minute OHLCV aggregator. Completed minutes are
// upserted into ohlcv_intraday (equities/indices) or options_intraday
// (option contracts) using the same ON CONFLICT upsert pattern as
// marketDataService.ts / optionsDataService.ts. We deliberately never write
// on every tick — only once a minute boundary is confirmed complete, either
// because a tick arrived in the next minute or because the periodic flush
// timer noticed the minute has elapsed with no further ticks.

interface CandleState {
  minuteStartMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Cumulative day volume as reported by the first tick of this minute. */
  volumeAtOpen: number;
  /** Most recent cumulative day volume seen for this minute. */
  lastCumulativeVolume: number;
}

const candleState = new Map<string, CandleState>();

interface OptionSymbolMeta {
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
}

/**
 * Fyers option trading symbols (e.g. "NIFTY24DEC25000CE") pack underlying +
 * expiry + strike + option type into one token with no delimiters, and the
 * expiry portion uses a compact per-exchange encoding (monthly vs. weekly
 * codes look different and overlap in digit-only form). We can reliably
 * split off the option type and, in the common monthly-expiry case, the
 * strike and underlying — but we deliberately refuse to guess when the
 * remaining "expiry" fragment isn't a plausible-looking date code, rather
 * than upserting a candle under a wrong/garbled contract identity.
 */
function parseOptionSymbol(rawSymbol: string): OptionSymbolMeta | null {
  const bare = rawSymbol.includes(":") ? rawSymbol.split(":").slice(1).join(":") : rawSymbol;

  // Equity/index symbols always carry a "-EQ"/"-INDEX"/"-BE" style suffix on
  // Fyers; option symbols never contain a hyphen. This is the cheapest and
  // most reliable equity/option discriminator available without a symbol
  // master lookup.
  if (bare.includes("-")) return null;

  const optionType: "CE" | "PE" | null = bare.endsWith("CE") ? "CE" : bare.endsWith("PE") ? "PE" : null;
  if (!optionType) return null;

  const withoutType = bare.slice(0, -2);
  const strikeMatch = /(\d+(?:\.\d+)?)$/.exec(withoutType);
  if (!strikeMatch) return null;
  const strikeStr = strikeMatch[1];

  // NSE/BSE strikes are realistically 2-6 digits. A longer trailing digit
  // run means the expiry's day-of-month digits fused with the strike
  // (typical of compact weekly codes like "24D2825000CE") and we can't
  // safely tell where one ends and the other begins — skip rather than
  // risk storing the wrong strike/expiry.
  if (strikeStr.length > 6) return null;
  const strike = Number(strikeStr);

  const rest = withoutType.slice(0, withoutType.length - strikeStr.length);
  const underlyingMatch = /^([A-Z&]+)/.exec(rest);
  if (!underlyingMatch) return null;
  const underlying = underlyingMatch[1];
  const expiry = rest.slice(underlying.length);
  if (!expiry) return null;

  return { underlying, expiry, strike, optionType };
}

function floorToMinuteMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Math.floor(ms / 60_000) * 60_000;
}

function upsertOhlcvCandle(symbol: string, state: CandleState): void {
  const volume = Math.max(0, state.lastCumulativeVolume - state.volumeAtOpen);
  const timestamp = new Date(state.minuteStartMs).toISOString();
  try {
    marketDb
      .prepare(
        `INSERT INTO ohlcv_intraday (symbol, timestamp, open, high, low, close, volume)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, timestamp) DO UPDATE SET
           open = excluded.open, high = excluded.high,
           low  = excluded.low,  close = excluded.close,
           volume = excluded.volume`
      )
      .run(symbol, timestamp, state.open, state.high, state.low, state.close, volume);
  } catch (err) {
    console.warn(
      "[liveFeedService] Failed to persist candle for %s @ %s: %s",
      symbol, timestamp, err instanceof Error ? err.message : String(err)
    );
  }
}

function upsertOptionsCandle(meta: OptionSymbolMeta, state: CandleState): void {
  const volume = Math.max(0, state.lastCumulativeVolume - state.volumeAtOpen);
  const timestamp = new Date(state.minuteStartMs).toISOString();
  try {
    marketDb
      .prepare(
        `INSERT INTO options_intraday
           (underlying, expiry, strike, option_type, timestamp, open, high, low, close, volume, oi)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(underlying, expiry, strike, option_type, timestamp) DO UPDATE SET
           open   = excluded.open,
           high   = excluded.high,
           low    = excluded.low,
           close  = excluded.close,
           volume = excluded.volume`
      )
      .run(
        meta.underlying, meta.expiry, meta.strike, meta.optionType,
        timestamp, state.open, state.high, state.low, state.close, volume
      );
  } catch (err) {
    console.warn(
      "[liveFeedService] Failed to persist option candle for %s %s%s%s @ %s: %s",
      meta.underlying, meta.expiry, meta.strike, meta.optionType, timestamp,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * True if the symbol shape (no hyphen, ends in CE/PE) says "this is an
 * option contract" even when parseOptionSymbol() couldn't safely decompose
 * it. Used to avoid misfiling an unparseable option into ohlcv_intraday.
 */
function looksLikeOptionSymbol(rawSymbol: string): boolean {
  const bare = rawSymbol.includes(":") ? rawSymbol.split(":").slice(1).join(":") : rawSymbol;
  return !bare.includes("-") && (bare.endsWith("CE") || bare.endsWith("PE"));
}

/** Persists a completed candle to the correct table based on symbol shape. */
function finalizeCandle(symbol: string, state: CandleState): void {
  const optionMeta = parseOptionSymbol(symbol);
  if (optionMeta) {
    upsertOptionsCandle(optionMeta, state);
    return;
  }
  if (looksLikeOptionSymbol(symbol)) {
    // Shaped like an option contract but we couldn't safely split
    // underlying/expiry/strike (e.g. a compact weekly-expiry code) — skip
    // rather than misfile it into the equity table under a wrong identity.
    console.warn(
      "[liveFeedService] Could not classify option symbol %s for candle persistence — skipping",
      symbol
    );
    return;
  }
  upsertOhlcvCandle(symbol, state);
}

/**
 * Folds one tick into the in-memory 1-minute candle for its symbol. Never
 * writes to the database itself — it only finalizes (and persists) the
 * previous minute's candle once a tick confirms that minute has ended.
 * Called synchronously right after the quote cache is updated so it never
 * delays the tick from being reflected to readers of getLiveQuote(s)/any
 * broadcast that consumes the cache.
 */
function recordTick(quote: Quote): void {
  const minuteStartMs = floorToMinuteMs(quote.timestamp);
  const existing = candleState.get(quote.symbol);

  if (!existing) {
    candleState.set(quote.symbol, {
      minuteStartMs,
      open: quote.ltp,
      high: quote.ltp,
      low: quote.ltp,
      close: quote.ltp,
      volumeAtOpen: quote.volume,
      lastCumulativeVolume: quote.volume,
    });
    return;
  }

  if (minuteStartMs > existing.minuteStartMs) {
    // Minute boundary crossed — persist the just-completed candle, then
    // start a fresh one for the new minute.
    finalizeCandle(quote.symbol, existing);
    candleState.set(quote.symbol, {
      minuteStartMs,
      open: quote.ltp,
      high: quote.ltp,
      low: quote.ltp,
      close: quote.ltp,
      volumeAtOpen: existing.lastCumulativeVolume,
      lastCumulativeVolume: quote.volume,
    });
    return;
  }

  // Same minute — fold the tick into the running aggregate.
  existing.high = Math.max(existing.high, quote.ltp);
  existing.low = Math.min(existing.low, quote.ltp);
  existing.close = quote.ltp;
  existing.lastCumulativeVolume = quote.volume;
}

/**
 * Sweeps in-progress candles for any whose minute has fully elapsed without
 * a new tick arriving to trigger the boundary in recordTick() — e.g. a
 * thinly-traded symbol going quiet near the close. Runs on a periodic timer
 * rather than per-tick so a stalled symbol's last candle still lands in the
 * database promptly instead of being lost.
 */
function flushStaleCandles(): void {
  const currentMinuteStartMs = Math.floor(Date.now() / 60_000) * 60_000;
  for (const [symbol, state] of candleState) {
    if (state.minuteStartMs < currentMinuteStartMs) {
      finalizeCandle(symbol, state);
      candleState.delete(symbol);
    }
  }
}

setInterval(flushStaleCandles, CANDLE_FLUSH_INTERVAL_MS);

// ── Subscription manager ────────────────────────────────────────────────────
//
// `order` tracks insertion order for FIFO rotation: index 0 is the
// least-recently-added (and therefore first to be evicted) symbol.
// `subscribed` mirrors the same set for O(1) membership checks.
// `protectedSymbols` marks the auto-subscribed F&O set (see
// autoSubscribeFoSymbols() below) — FIFO eviction skips over these entirely,
// so an ad-hoc chart-view subscribe can never bump one out.

class SubscriptionManager {
  private order: string[] = [];
  private subscribed = new Set<string>();
  private protectedSymbols = new Set<string>();

  get size(): number {
    return this.subscribed.size;
  }

  has(symbol: string): boolean {
    return this.subscribed.has(symbol);
  }

  isProtected(symbol: string): boolean {
    return this.protectedSymbols.has(symbol);
  }

  list(): string[] {
    return [...this.order];
  }

  listProtected(): string[] {
    return [...this.protectedSymbols];
  }

  /** Drops the "protected" flag from every symbol without unsubscribing them. */
  clearProtected(): void {
    this.protectedSymbols.clear();
  }

  /**
   * Adds symbols to the subscribed set, evicting the oldest *unprotected*
   * symbols first (FIFO) if the addition would exceed
   * MAX_SUBSCRIBED_SYMBOLS. Protected symbols are never evicted — if there
   * isn't enough unprotected room to make space for everything requested,
   * the excess requested symbols are rejected instead (caller should log
   * this) rather than bumping out part of the protected set.
   *
   * Pass `protect: true` to mark the symbols actually added as protected
   * (used for the auto-subscribed F&O universe).
   */
  add(symbols: string[], options: { protect?: boolean } = {}): {
    added: string[];
    evicted: string[];
    rejected: string[];
  } {
    const { protect = false } = options;
    const toAdd = symbols.filter((s) => !this.subscribed.has(s));
    // De-dupe while preserving order, in case the caller passed duplicates.
    const uniqueToAdd = [...new Set(toAdd)];

    const evicted: string[] = [];
    const projectedSize = this.subscribed.size + uniqueToAdd.length;
    const overflow = projectedSize - MAX_SUBSCRIBED_SYMBOLS;
    if (overflow > 0) {
      // Evict the oldest currently-subscribed, UNPROTECTED symbols to make
      // room. Never evict a protected symbol, and never evict a symbol
      // we're about to (re-)add in the same call.
      for (let i = 0; i < this.order.length && evicted.length < overflow; i++) {
        const candidate = this.order[i];
        if (this.protectedSymbols.has(candidate)) continue;
        if (uniqueToAdd.includes(candidate)) continue;
        evicted.push(candidate);
      }
      for (const symbol of evicted) this.remove(symbol);
    }

    // Only accept as many new symbols as actually fit now. If eviction
    // couldn't free enough room (e.g. everything subscribed is protected),
    // the remainder is rejected rather than displacing a protected symbol.
    const availableRoom = Math.max(0, MAX_SUBSCRIBED_SYMBOLS - this.subscribed.size);
    const capped = uniqueToAdd.slice(0, availableRoom);
    const rejected = uniqueToAdd.slice(capped.length);

    for (const symbol of capped) {
      this.subscribed.add(symbol);
      this.order.push(symbol);
      if (protect) this.protectedSymbols.add(symbol);
    }

    return { added: capped, evicted, rejected };
  }

  remove(symbols: string[] | string): void {
    const list = Array.isArray(symbols) ? symbols : [symbols];
    for (const symbol of list) {
      if (!this.subscribed.delete(symbol)) continue;
      const idx = this.order.indexOf(symbol);
      if (idx !== -1) this.order.splice(idx, 1);
      this.protectedSymbols.delete(symbol);
      quoteCache.delete(symbol);

      // Persist whatever partial candle we had rather than silently
      // dropping it on unsubscribe/eviction.
      const pending = candleState.get(symbol);
      if (pending) {
        finalizeCandle(symbol, pending);
        candleState.delete(symbol);
      }
    }
  }

  clear(): void {
    this.order = [];
    this.subscribed.clear();
    this.protectedSymbols.clear();
  }
}

const subscriptions = new SubscriptionManager();

// ── Python sidecar connection lifecycle ─────────────────────────────────────
//
// The Fyers v3 data feed (wss://socket.fyers.in/hsm/v1-5/prod) uses a
// proprietary binary framing protocol implemented by the official Python SDK
// (fyers-apiv3). Rather than reimplementing the binary protocol in Node,
// we spawn fyers_ws_bridge.py as a child process and communicate with it
// over newline-delimited JSON on stdin/stdout.

let child: ChildProcess | null = null;
let isConnectedFlag = false;
let connecting = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionallyClosed = false;

/**
 * Normalises a symbol to the Fyers exchange-prefixed format.
 * Symbols that already contain ":" are returned unchanged (e.g. NSE:NIFTY50-INDEX,
 * NSE:RELIANCE-EQ, option contracts like NSE:NIFTY24DEC25000CE).
 * Bare tickers like "RELIANCE" become "NSE:RELIANCE-EQ".
 * This prevents bare tickers from reaching the Fyers WebSocket, which rejects them
 * with code -300 ("Please provide a valid symbol") and crashes the connection.
 */
function toFyersSymbol(symbol: string): string {
  return symbol.includes(":") ? symbol : `NSE:${symbol}-EQ`;
}

/** JSON control line sent to the Python bridge's stdin to subscribe. */
function buildSubscribeMessage(symbols: string[]): string {
  return JSON.stringify({ action: "subscribe", symbols, mode: "full" });
}

/** JSON control line sent to the Python bridge's stdin to unsubscribe. */
function buildUnsubscribeMessage(symbols: string[]): string {
  return JSON.stringify({ action: "unsubscribe", symbols });
}

/**
 * Normalizes a single tick payload from Fyers into our internal Quote
 * shape. Returns null for messages that aren't tick data (e.g. ack/heartbeat
 * frames) so callers can skip them silently.
 */
function parseTickMessage(raw: unknown): Quote | null {
  if (!raw || typeof raw !== "object") return null;
  const msg = raw as Record<string, unknown>;

  // Explicitly skip known control/ack frame types so the null return is
  // intentional rather than incidental (these lack `ltp` but are not errors).
  // Types confirmed from production logs: "cn" (connect ack), "ful" (full-mode
  // ack), "sub" (subscribe ack), "uns" (unsubscribe ack).
  if (typeof msg.type === "string" && ["cn", "ful", "sub", "uns"].includes(msg.type)) return null;

  // Fyers tick frames carry the symbol under `symbol` or `n`, and LTP under
  // `ltp` or `lp` depending on feed mode. Accept either.
  const symbol = (msg.symbol ?? msg.n) as string | undefined;
  const ltp = (msg.ltp ?? msg.lp) as number | undefined;
  if (!symbol || typeof ltp !== "number") return null;

  const open = (msg.open_price ?? msg.open ?? msg.o) as number | undefined;
  const high = (msg.high_price ?? msg.high ?? msg.h) as number | undefined;
  const low = (msg.low_price ?? msg.low ?? msg.l) as number | undefined;
  const close = (msg.prev_close_price ?? msg.close ?? msg.c) as number | undefined;
  const volume = (msg.volume ?? msg.vol_traded_today ?? msg.v) as number | undefined;
  // exch_feed_time confirmed on index ticks (unix seconds); tt / last_traded_time
  // kept as fallbacks for option/depth ticks not yet observed in production.
  const tt = (msg.exch_feed_time ?? msg.tt ?? msg.last_traded_time) as number | undefined;

  return {
    symbol,
    ltp,
    open: open ?? 0,
    high: high ?? 0,
    low: low ?? 0,
    close: close ?? 0,
    volume: volume ?? 0,
    timestamp: tt ? new Date(tt * 1000).toISOString() : new Date().toISOString(),
  };
}

function scheduleReconnect(): void {
  if (intentionallyClosed || reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempt++;
  console.warn(`[liveFeedService] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err) => {
      console.warn(
        "[liveFeedService] Reconnect attempt failed: %s",
        err instanceof Error ? err.message : String(err)
      );
    });
  }, delay);
}

/**
 * Spawns the Python bridge (fyers_ws_bridge.py) as a child process if a
 * Fyers session is available and no connection/attempt is already in flight.
 * Safe to call repeatedly — it's a no-op when already connected/connecting.
 * Never throws; failures are logged and trigger a backoff retry instead.
 *
 * The Python bridge implements the Fyers v3 binary WebSocket protocol via the
 * official fyers-apiv3 SDK. Communication with the bridge is via
 * newline-delimited JSON on stdin/stdout:
 *   stdout ← {"__control__":"connected"|"closed"|"error"} or raw tick dicts
 *   stdin  → {"action":"subscribe"|"unsubscribe","symbols":[...]}
 */
export async function connect(): Promise<void> {
  if (connecting || isConnectedFlag) return;

  const session = getFyersSession();
  if (!session) {
    // No active session yet — try again later rather than failing hard.
    scheduleReconnect();
    return;
  }

  connecting = true;
  intentionallyClosed = false;

  let spawnedChild: ChildProcess;
  try {
    spawnedChild = spawn(
      "python3",
      ["server/python/fyers_ws_bridge.py"],
      {
        env: {
          ...process.env,
          FYERS_APP_ID: session.appId,
          FYERS_ACCESS_TOKEN: session.accessToken,
        },
      }
    );
  } catch (err) {
    connecting = false;
    console.error(
      "[liveFeedService] Failed to spawn Python bridge — ensure python3 is on PATH and run `pip install -r server/python/requirements.txt`: %s",
      err instanceof Error ? err.message : String(err)
    );
    scheduleReconnect();
    return;
  }

  const handshakeTimer = setTimeout(() => {
    if (child !== spawnedChild) return;
    console.warn(
      "[liveFeedService] Handshake timed out after %dms — killing bridge and reconnecting",
      HANDSHAKE_TIMEOUT_MS
    );
    connecting = false;
    isConnectedFlag = false;
    child = null;
    spawnedChild.kill();
    scheduleReconnect();
  }, HANDSHAKE_TIMEOUT_MS);

  const rl = readline.createInterface({ input: spawnedChild.stdout! });

  rl.on("line", (line) => {
    if (child !== spawnedChild) return; // stale bridge superseded by a newer spawn
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // malformed line — skip
    }

    const msg = parsed as Record<string, unknown>;

    // ── Control frames ──────────────────────────────────────────────────────
    if (msg.__control__ === "connected") {
      clearTimeout(handshakeTimer);
      connecting = false;
      isConnectedFlag = true;
      reconnectAttempt = 0;
      console.log("[liveFeedService] Connected to Fyers data feed (Python bridge)");
      // Re-subscribe to everything we were tracking (e.g. after a reconnect).
      const symbols = subscriptions.list();
      if (symbols.length > 0) sendIfOpen(buildSubscribeMessage(symbols));
      return;
    }

    if (msg.__control__ === "error" || msg.__control__ === "closed") {
      clearTimeout(handshakeTimer);
      console.warn("[liveFeedService] Bridge control: %s", line);

      // If Fyers reported specific invalid symbols (code -300), remove them
      // from the subscription list NOW — before the reconnect — so the next
      // connect attempt doesn't re-subscribe the same bad symbols and loop
      // forever.  The detail field is a stringified Python dict, e.g.:
      //   "{'code': -300, ..., 'invalid_symbols': ['RELIANCE']}"
      if (msg.__control__ === "error" && typeof msg.detail === "string") {
        const invalidMatch = /invalid_symbols['":\s]+\[([^\]]+)\]/.exec(msg.detail);
        if (invalidMatch) {
          const invalidSymbols = (invalidMatch[1].match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
          if (invalidSymbols.length > 0) {
            console.warn(
              "[liveFeedService] Stripping %d invalid symbol(s) from subscription list to prevent reconnect loop: %s",
              invalidSymbols.length,
              invalidSymbols.join(", ")
            );
            subscriptions.remove(invalidSymbols);
          }
        }
      }

      connecting = false;
      isConnectedFlag = false;
      child = null;
      scheduleReconnect();
      return;
    }

    // ── Tick frame ──────────────────────────────────────────────────────────
    // Re-enable the line below temporarily if you need to verify field names
    // for a new instrument type (e.g. options ticks, depth ticks).
    // console.log("[liveFeedService][raw-tick-shape]", JSON.stringify(parsed));

    const quote = parseTickMessage(parsed);
    if (!quote) return;

    quoteCache.set(quote.symbol, quote);
    recordTick(quote);
  });

  spawnedChild.on("error", (err) => {
    clearTimeout(handshakeTimer);
    if (child !== spawnedChild) return;
    const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
    console.error(
      "[liveFeedService] Python bridge process error%s: %s",
      isNotFound ? " (python3 not found — ensure it is on PATH and run `pip install -r server/python/requirements.txt`)" : "",
      err.message
    );
    connecting = false;
    isConnectedFlag = false;
    child = null;
    scheduleReconnect();
  });

  spawnedChild.on("close", (code) => {
    clearTimeout(handshakeTimer);
    if (child !== spawnedChild) return;
    connecting = false;
    isConnectedFlag = false;
    child = null;
    console.warn("[liveFeedService] Python bridge exited (code=%s)", code);
    scheduleReconnect();
  });

  child = spawnedChild;
}

/** True when the Python bridge is running and has sent the "connected" handshake. */
export function isConnected(): boolean {
  return isConnectedFlag;
}

/** Kills the Python bridge and stops any pending reconnect attempts. */
export function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  isConnectedFlag = false;
  if (child) {
    child.kill();
    child = null;
  }
}

function sendIfOpen(message: string): void {
  if (child && isConnectedFlag && child.stdin) {
    child.stdin.write(message + "\n");
  }
  // If not open yet, the next "connected" control line re-subscribes from
  // subscriptions.list(), so pending adds are not lost.
}

// ── Public subscription API ─────────────────────────────────────────────────

/**
 * Subscribes to the given symbols, enforcing the 200-symbol cap via FIFO
 * eviction of the oldest *unprotected* subscriptions. Triggers a connection
 * attempt if one isn't already established. Symbols already subscribed are
 * no-ops. Pass `{ protect: true }` to mark the symbols added as protected
 * (see autoSubscribeFoSymbols()) so ad-hoc future subscribe calls can never
 * evict them. Returns what actually happened so callers that care (e.g. the
 * F&O auto-subscribe job) can report/log it.
 */
export function subscribeSymbols(
  symbols: string[],
  options: { protect?: boolean } = {}
): { added: string[]; evicted: string[]; rejected: string[] } {
  if (symbols.length === 0) return { added: [], evicted: [], rejected: [] };

  // Normalise every symbol to the Fyers exchange-prefixed format before it
  // touches the subscription manager.  Bare tickers (e.g. "RELIANCE") become
  // "NSE:RELIANCE-EQ".  Already-formatted symbols (e.g. "NSE:NIFTY50-INDEX",
  // option contracts) are passed through unchanged.
  const normalised = symbols.map(toFyersSymbol);

  const { added, evicted, rejected } = subscriptions.add(normalised, options);

  if (evicted.length > 0) {
    console.log(`[liveFeedService] Evicting ${evicted.length} oldest unprotected symbol(s) to stay under the 200 cap`);
    sendIfOpen(buildUnsubscribeMessage(evicted));
  }
  if (rejected.length > 0) {
    console.warn(
      "[liveFeedService] Rejected %d subscribe request(s) — at the 200-symbol cap with no unprotected symbol left to evict: %s",
      rejected.length,
      rejected.join(", ")
    );
  }
  if (added.length > 0) {
    sendIfOpen(buildSubscribeMessage(added));
  }

  void connect();

  return { added, evicted, rejected };
}

/** Unsubscribes the given symbols and drops their cached quotes. */
export function unsubscribeSymbols(symbols: string[]): void {
  if (symbols.length === 0) return;
  const stillTracked = symbols.filter((s) => subscriptions.has(s));
  if (stillTracked.length === 0) return;

  subscriptions.remove(stillTracked);
  sendIfOpen(buildUnsubscribeMessage(stillTracked));
}

/** Current subscribed symbols, for diagnostics/tests. */
export function getSubscribedSymbols(): string[] {
  return subscriptions.list();
}

/** Currently-protected (auto-subscribed F&O) symbols, for status/diagnostics. */
export function getProtectedSymbols(): string[] {
  return subscriptions.listProtected();
}

/**
 * Drops the "protected" flag from every symbol without unsubscribing them.
 * Called at market close alongside disconnect() so tomorrow's liveOpen job
 * rebuilds the F&O auto-subscribe list fresh (in case eligibility or prices
 * changed overnight) instead of treating yesterday's list as still pinned.
 */
export function clearProtectedSymbols(): void {
  subscriptions.clearProtected();
}

interface FoRankedSymbol {
  symbol: string;
  /** Fyers-format symbol ready to send to the WebSocket (e.g. "NSE:AAKAAR-SM").
   *  Sourced from the fyers_symbol column written by symbolMasterService when it
   *  parses Fyers' own NSE_CM.csv — falls back to the conventional "NSE:{symbol}-EQ"
   *  construction only for rows where that column is still null (i.e. symbol master
   *  has never been synced on this machine). */
  resolved_symbol: string;
  price: number;
}

/**
 * Ranks all F&O-eligible symbols by their most recent known daily close
 * price (ascending). Symbols with no ohlcv_daily row yet are excluded
 * entirely rather than guessed at.
 *
 * resolved_symbol uses the fyers_symbol column (populated by symbolMasterService
 * from Fyers' NSE_CM.csv) so that SME/BE/ST-series stocks get their correct
 * exchange suffix (e.g. -SM, -BE) instead of the naive -EQ fallback that the
 * Fyers WebSocket rejects with code -300.
 */
function rankFoSymbolsByPrice(): FoRankedSymbol[] {
  const rows = marketDb
    .prepare(
      `SELECT s.symbol AS symbol,
              COALESCE(s.fyers_symbol, 'NSE:' || s.symbol || '-EQ') AS resolved_symbol,
              latest.close AS price
         FROM symbols s
         JOIN (
           SELECT od.symbol, od.close
             FROM ohlcv_daily od
             JOIN (
               SELECT symbol, MAX(date) AS max_date
                 FROM ohlcv_daily
                GROUP BY symbol
             ) m ON m.symbol = od.symbol AND m.max_date = od.date
         ) latest ON latest.symbol = s.symbol
        WHERE s.is_fo_eligible = 1
          AND latest.close IS NOT NULL
        ORDER BY latest.close ASC`
    )
    .all() as unknown as FoRankedSymbol[];

  // Warn if any eligible symbols are falling back to the -EQ guess because
  // the symbol master hasn't been synced on this machine yet. Those rows will
  // likely produce -300 errors from the Fyers WebSocket for SME/BE stocks.
  const nullFyersCount = (marketDb
    .prepare(
      `SELECT COUNT(*) AS cnt FROM symbols s
         JOIN (SELECT DISTINCT symbol FROM ohlcv_daily) od ON od.symbol = s.symbol
        WHERE s.is_fo_eligible = 1 AND (s.fyers_symbol IS NULL OR s.fyers_symbol = '')`
    )
    .get() as { cnt: number }).cnt;
  if (nullFyersCount > 0) {
    console.warn(
      "[liveFeedService] %d F&O-eligible symbol(s) have no fyers_symbol in DB — " +
      "falling back to NSE:{symbol}-EQ which may be rejected by Fyers for SME/BE stocks. " +
      "Run /api/symbols/refresh to populate the correct Fyers tickers.",
      nullFyersCount
    );
  }

  return rows;
}

export interface FoAutoSubscribeResult {
  /** F&O-eligible symbols that had a known price to rank by. */
  eligibleCount: number;
  /** How many of the lowest-priced eligible symbols were requested (≤ limit). */
  requestedCount: number;
  /** How many actually got subscribed as protected (should equal requestedCount in the normal case). */
  subscribedCount: number;
  /** The resulting protected symbol list. */
  symbols: string[];
}

/**
 * Prioritizes the live feed toward F&O (futures-eligible) stocks instead of
 * leaving it purely reactive to what's being viewed in the app: ranks all
 * is_fo_eligible symbols by their latest known daily close price (cheapest
 * first) and subscribes to the lowest-priced `limit` of them as protected,
 * so ad-hoc chart-view subscribes can never evict them.
 *
 * Called by the liveOpen cron job right after connect() succeeds. Safe to
 * call again later (e.g. via a manual test route) — it recomputes the
 * ranking from current data each time.
 */
export function autoSubscribeFoSymbols(limit: number = MAX_SUBSCRIBED_SYMBOLS): FoAutoSubscribeResult {
  const ranked = rankFoSymbolsByPrice();
  // Use resolved_symbol (sourced from fyers_symbol in the DB) so SME/BE/ST
  // stocks get their correct Fyers suffix instead of the naive -EQ fallback.
  const chosen = ranked.slice(0, limit).map((r) => r.resolved_symbol);

  const result = subscribeSymbols(chosen, { protect: true });

  console.log(
    "[liveFeedService] F&O auto-subscribe: %d/%d lowest-priced symbols subscribed (%d eligible with a known price)",
    result.added.length,
    chosen.length,
    ranked.length
  );

  return {
    eligibleCount: ranked.length,
    requestedCount: chosen.length,
    subscribedCount: result.added.length,
    symbols: subscriptions.listProtected(),
  };
}
