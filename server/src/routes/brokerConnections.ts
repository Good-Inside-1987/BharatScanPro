import { Router, type Request, type Response } from "express";
import { db } from "../db.js";
import { encrypt, decrypt } from "../lib/encryption.js";
import { getAdapter } from "../adapters/index.js";
import { registerAdapter, getServiceStats } from "../services/marketDataService.js";
import { onBrokerFirstConnected } from "../services/catchUpScheduler.js";
import {
  AuthenticationError,
  SessionExpiredError,
  RateLimitError,
  BrokerUnavailableError,
} from "../errors/brokerErrors.js";

const router = Router();

// ── Broker connection status ────────────────────────────────────────────────────
//
// Explicit connection states, replacing the old three-value status field.
// The underlying stored strings stay lowercase/legacy-compatible for
// 'connected' and 'disconnected' so marketDataService.ts's existing
// `WHERE status = 'connected'` gate (and any other previously-shipped
// consumer of this column) keeps working unmodified — only this routes
// file changes what it writes/reads on top of that shared column.
const BrokerStatus = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  WAITING_TOTP: "waiting_totp",
  SESSION_EXPIRED: "session_expired",
  INVALID_CREDENTIALS: "invalid_credentials",
  LOGIN_FAILED: "login_failed",
  BROKER_UNAVAILABLE: "broker_unavailable",
} as const;

type BrokerStatusValue = typeof BrokerStatus[keyof typeof BrokerStatus];

/**
 * Classifies a broker adapter error (thrown from login()) into one of the
 * explicit failure states. Network-level failures (broker unreachable) are
 * distinguished from credential problems (bad API key/secret/client code)
 * and from login-attempt failures (wrong TOTP / auth code / generic auth
 * rejection). Typed broker errors (from brokerErrors.ts) are checked first
 * so future adapter upgrades can throw them directly and get correct codes.
 * Never triggers an automatic retry or reconnect — callers must always
 * re-submit credentials/TOTP manually after any of these.
 */
function classifyBrokerError(err: unknown): {
  status: BrokerStatusValue;
  httpCode: number;
  message: string;
} {
  // ── Typed broker errors take priority ─────────────────────────────────────
  if (err instanceof RateLimitError) {
    return { status: BrokerStatus.BROKER_UNAVAILABLE, httpCode: 429, message: err.message };
  }
  if (err instanceof BrokerUnavailableError) {
    return { status: BrokerStatus.BROKER_UNAVAILABLE, httpCode: 503, message: err.message };
  }
  if (err instanceof SessionExpiredError) {
    // 503 not 401: a broker session expiry is an upstream service failure,
    // not a BharatScan auth failure. Returning 401 would make the client
    // fire auth:unauthorized, clear the localStorage token, and log the user
    // out of the app even though their BharatScan API key is perfectly valid.
    return { status: BrokerStatus.SESSION_EXPIRED, httpCode: 503, message: err.message };
  }
  if (err instanceof AuthenticationError) {
    // 422: the submitted broker credentials are semantically invalid.
    return { status: BrokerStatus.INVALID_CREDENTIALS, httpCode: 422, message: err.message };
  }

  // ── Generic Error message pattern matching (existing adapters) ────────────
  const message = err instanceof Error ? err.message : String(err);

  const isNetworkError =
    err instanceof TypeError ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network error/i.test(message);
  if (isNetworkError) {
    return {
      status: BrokerStatus.BROKER_UNAVAILABLE,
      httpCode: 503,
      message: "Broker service is unreachable. Please try again later.",
    };
  }

  if (/invalid.*(api.?key|app.?id|secret|client.?code|credentials)/i.test(message)) {
    // 422: bad broker credentials supplied by the user — not a BharatScan auth issue.
    return { status: BrokerStatus.INVALID_CREDENTIALS, httpCode: 422, message };
  }

  if (/totp|otp|auth.?code|authorization.?code/i.test(message)) {
    // 422: bad TOTP / auth code — user error on the broker side.
    return { status: BrokerStatus.LOGIN_FAILED, httpCode: 422, message };
  }

  return { status: BrokerStatus.LOGIN_FAILED, httpCode: 422, message };
}

// ── Connect rate limiter ───────────────────────────────────────────────────────

const connectAttempts = new Map<string,
  { count: number; resetAt: number }>();

function checkConnectLimit(ip: string): boolean {
  const now = Date.now();
  const entry = connectAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    connectAttempts.set(ip,
      { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface BrokerRow {
  id: string;
  broker_name: string;
  display_name: string;
  api_key: string;
  client_code: string;
  pin: string;
  access_token: string | null;
  token_generated_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Return public-safe fields only — never expose encrypted values. */
function publicRow(row: BrokerRow) {
  return {
    id: row.id,
    broker_name: row.broker_name,
    display_name: row.display_name,
    status: row.status,
    token_generated_at: row.token_generated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const allRows = () =>
  db
    .prepare("SELECT * FROM broker_connections ORDER BY created_at DESC")
    .all() as unknown as BrokerRow[];

const oneRow = (id: string) =>
  db
    .prepare("SELECT * FROM broker_connections WHERE id = ?")
    .get(id) as unknown as BrokerRow | undefined;

// ── GET /api/broker-connections ────────────────────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  res.json(allRows().map(publicRow));
});

// ── POST /api/broker-connections ───────────────────────────────────────────────

router.post("/", (req: Request, res: Response) => {
  const { broker_name, display_name, api_key, client_code, pin } = req.body as {
    broker_name?: string;
    display_name?: string;
    api_key?: string;
    client_code?: string;
    pin?: string;
  };

  if (!broker_name || !display_name || !api_key || !client_code || !pin) {
    res.status(400).json({ error: "broker_name, display_name, api_key, client_code and pin are required" });
    return;
  }

  const ALLOWED_BROKERS = [
    "angel_one", "fyers", "upstox", "shoonya", "dhan", "zerodha"
  ];
  if (!ALLOWED_BROKERS.includes(broker_name)) {
    res.status(400).json({
      error: `Unsupported broker. Allowed values: ${ALLOWED_BROKERS.join(", ")}`
    });
    return;
  }

  if (display_name && display_name.length > 100) {
    res.status(400).json({
      error: "display_name too long (max 100 characters)"
    });
    return;
  }

  let encKey: string, encCode: string, encPin: string;
  try {
    encKey  = encrypt(api_key);
    encCode = encrypt(client_code);
    encPin  = encrypt(pin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Encryption failed";
    res.status(500).json({ error: msg });
    return;
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO broker_connections
      (id, broker_name, display_name, api_key, client_code, pin, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, broker_name, display_name, encKey, encCode, encPin, BrokerStatus.WAITING_TOTP, now, now);

  res.status(201).json(publicRow(oneRow(id)!));
});

// ── PUT /api/broker-connections/:id ───────────────────────────────────────────

router.put("/:id", (req: Request, res: Response) => {
  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const { display_name, api_key, client_code, pin } = req.body as {
    display_name?: string;
    api_key?: string;
    client_code?: string;
    pin?: string;
  };

  const now = new Date().toISOString();

  try {
    db.prepare(`
      UPDATE broker_connections SET
        display_name = ?,
        api_key      = ?,
        client_code  = ?,
        pin          = ?,
        updated_at   = ?
      WHERE id = ?
    `).run(
      display_name  ?? row.display_name,
      api_key       ? encrypt(api_key)      : row.api_key,
      client_code   ? encrypt(client_code)  : row.client_code,
      pin           ? encrypt(pin)          : row.pin,
      now,
      row.id,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Encryption failed";
    res.status(500).json({ error: msg });
    return;
  }

  res.json(publicRow(oneRow(row.id)!));
});

// ── DELETE /api/broker-connections/:id ────────────────────────────────────────

router.delete("/:id", (req: Request, res: Response) => {
  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  db.prepare("DELETE FROM broker_connections WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// ── GET /api/broker-connections/:id/status ────────────────────────────────────

router.get("/:id/status", (req: Request, res: Response) => {
  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  let sessionValidUntil: string | null = null;
  if (row.token_generated_at) {
    const d = new Date(row.token_generated_at);
    d.setHours(d.getHours() + 24);
    sessionValidUntil = d.toISOString();
    // Auto-expire if the stored status is still CONNECTED but the token is
    // stale. This only marks the state — it never attempts to re-auth or
    // reconnect automatically; the user must manually re-enter TOTP/auth
    // code via /connect.
    if (row.status === BrokerStatus.CONNECTED && new Date() > d) {
      const now = new Date().toISOString();
      db.prepare("UPDATE broker_connections SET status = ?, updated_at = ? WHERE id = ?")
        .run(BrokerStatus.SESSION_EXPIRED, now, row.id);
      row.status = BrokerStatus.SESSION_EXPIRED;
    }
  }

  res.json({
    id: row.id,
    status: row.status,
    token_generated_at: row.token_generated_at,
    session_valid_until: sessionValidUntil,
  });
});

// ── GET /api/broker-connections/:id/auth-url (Fyers only) ────────────────────

router.get("/:id/auth-url", (req: Request, res: Response) => {
  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.broker_name !== "fyers") {
    res.status(400).json({ error: "auth-url is only available for Fyers connections" });
    return;
  }

  let appId: string, redirectUri: string;
  try {
    appId       = decrypt(row.api_key);   // api_key stores App ID for Fyers
    redirectUri = decrypt(row.pin);       // pin stores Redirect URI for Fyers
  } catch {
    res.status(500).json({ error: "Failed to decrypt credentials" });
    return;
  }

  const url =
    `https://api-t1.fyers.in/api/v3/generate-authcode` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=bharatscan`;

  res.json({ url });
});

// ── POST /api/broker-connections/:id/connect ──────────────────────────────────

router.post("/:id/connect", async (req: Request, res: Response) => {
  const ip = req.ip ?? "unknown";
  if (!checkConnectLimit(ip)) {
    res.status(429).json({
      error: "Too many connection attempts. Try again in 15 minutes."
    });
    return;
  }

  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const { totp_code } = req.body as { totp_code?: string };
  const isTotpBroker = row.broker_name === "angel_one";
  if (!totp_code || (isTotpBroker ? !/^\d{6}$/.test(totp_code.trim()) : !totp_code.trim())) {
    res.status(400).json({
      error: isTotpBroker ? "totp_code must be exactly 6 digits" : "totp_code is required"
    });
    return;
  }

  // Decrypt stored credentials
  let apiKey: string, clientCode: string, pin: string;
  try {
    apiKey     = decrypt(row.api_key);
    clientCode = decrypt(row.client_code);
    pin        = decrypt(row.pin);
  } catch (err) {
    res.status(500).json({ error: "Failed to decrypt credentials" });
    return;
  }

  let accessToken: string;
  const adapter = getAdapter(row.broker_name);
  try {
    accessToken = await adapter.login(
      { apiKey, clientCode, pin },
      totp_code.trim(),
      req.ip ?? "127.0.0.1"
    );
  } catch (err) {
    // Classify the failure into an explicit state and persist it so the
    // frontend (and any subsequent GET) reflects exactly why the connect
    // attempt failed. No automatic retry/reconnect is attempted here —
    // the user must manually re-submit TOTP/auth code.
    const { status, httpCode, message } = classifyBrokerError(err);
    const failedAt = new Date().toISOString();
    db.prepare("UPDATE broker_connections SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, failedAt, row.id);
    res.status(httpCode).json({ error: message, status });
    return;
  }

  // Store encrypted access token
  const now = new Date().toISOString();
  try {
    db.prepare(`
      UPDATE broker_connections SET
        access_token       = ?,
        token_generated_at = ?,
        status             = ?,
        updated_at         = ?
      WHERE id = ?
    `).run(encrypt(accessToken), now, BrokerStatus.CONNECTED, now, row.id);
  } catch (err) {
    res.status(500).json({ error: "Failed to store access token" });
    return;
  }

  const anyAdapter = adapter as unknown as Record<string, unknown>;
  if (typeof anyAdapter.configureSession === "function") {
    (anyAdapter.configureSession as (k: string, t: string) => void)(apiKey, accessToken);
  }

  registerAdapter(row.id, adapter, now);

  // Trigger startup catch-up retry for any jobs skipped at boot because no
  // broker was connected yet (e.g. EOD/intraday sync).
  onBrokerFirstConnected();

  // ── Post-login integration check ────────────────────────────────────────
  // Confirm the adapter cache was actually populated (not just that
  // registerAdapter() returned without throwing) before reporting success.
  const statsAfterLogin = getServiceStats();
  const adapterCachePopulated = statsAfterLogin.adaptersCached > 0;
  if (!adapterCachePopulated) {
    console.warn(
      "[brokerConnections] Login succeeded but adapter cache is empty after registerAdapter() — " +
      "GET /api/market/status will not reflect this connection until it is retried."
    );
  } else {
    console.log(
      "[brokerConnections] ✓ Post-login check: adapter cache populated (%d cached)",
      statsAfterLogin.adaptersCached
    );
  }

  res.json({
    ok: true,
    token_generated_at: now,
    status: BrokerStatus.CONNECTED,
    adapterCachePopulated,
  });
});

// ── POST /api/broker-connections/:id/disconnect ───────────────────────────────

router.post("/:id/disconnect", (req: Request, res: Response) => {
  const row = oneRow(req.params.id);
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE broker_connections SET
      access_token       = NULL,
      token_generated_at = NULL,
      status             = ?,
      updated_at         = ?
    WHERE id = ?
  `).run(BrokerStatus.DISCONNECTED, now, row.id);

  res.json({ ok: true, status: BrokerStatus.DISCONNECTED });
});

export default router;
