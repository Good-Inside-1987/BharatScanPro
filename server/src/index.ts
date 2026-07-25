// Must be the first import: loads .env (non-Replit only) before anything
// else reads process.env.
import "./loadEnv.js";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { statSync } from "fs";
import { timingSafeEqual, createHmac, randomBytes } from "crypto";
import cookieParser from "cookie-parser";
// IMPORTANT: db.ts must be imported first — it runs migration and
// initialises all three databases before any route handlers run.
import { db, appDb, marketDb, liveDb } from "./db.js";
import { config } from "./config/environment.js";
import scansRouter from "./routes/scans.js";
import settingsRouter from "./routes/settings.js";
import portfolioRouter from "./routes/portfolio.js";
import dashboardsRouter from "./routes/dashboards.js";
import scannerDashboardsRouter from "./routes/scannerDashboards.js";
import alertsRouter from "./routes/alerts.js";
import paperTradingRouter from "./routes/paperTrading.js";
import { getServiceStats } from "./services/marketDataService.js";
import { getNightlySyncStatus } from "./services/syncJobs.js";
import {
  getHistoricalBackfillStatus,
  pauseHistoricalBackfill,
  resumeHistoricalBackfillOnStartup,
  resumeHistoricalBackfill,
  startHistoricalBackfill,
} from "./services/historicalBackfill.js";
import brokerConnectionsRouter from "./routes/brokerConnections.js";
import marketDataRouter from "./routes/marketData.js";
import symbolsRouter from "./routes/symbols.js";
import universeRouter from "./routes/universe.js";
import { startScheduler } from "./services/scheduler.js";

void appDb;
void marketDb;
void liveDb;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function signSession(key: string): string {
  const nonce = randomBytes(16).toString("hex");
  const sig = createHmac("sha256", key).update(nonce).digest("hex");
  return `${nonce}.${sig}`;
}

function verifySession(token: string, key: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [nonce, sig] = parts;
  const expected = createHmac("sha256", key).update(nonce).digest("hex");
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

if (!process.env.BROKER_ENCRYPTION_KEY) {
  console.warn(
    "[WARN] BROKER_ENCRYPTION_KEY is not set. " +
    "Broker credential encryption will fail. " +
    "Add BROKER_ENCRYPTION_KEY to your .env file."
  );
}

// On Replit (and most cloud hosts) the app sits behind an HTTPS-terminating
// reverse proxy: Express sees a plain HTTP connection even though the
// browser is talking to it over HTTPS. Trusting the proxy lets req.ip and
// req.secure reflect the real client/protocol instead of the proxy's.
const isReplit = !!process.env.REPL_ID;

const app = express();
const port = Number(process.env.SERVER_PORT ?? 3001);

if (isReplit) app.set("trust proxy", 1);

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true; // allowed
  }
  if (entry.count >= 10) return false; // blocked
  entry.count++;
  return true; // allowed
}

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip ?? "unknown";
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    return;
  }
  const { key } = req.body as { key?: string };
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) {
    res.json({ ok: true }); return;
  }
  if (!key || key.length !== requiredKey.length) {
    res.status(401).json({ error: "Invalid key" }); return;
  }
  if (!timingSafeEqual(Buffer.from(key), Buffer.from(requiredKey))) {
    res.status(401).json({ error: "Invalid key" }); return;
  }
  // Return the signed token in the response body so the client can store it
  // in localStorage and send it as a Bearer token header on every subsequent
  // request. This completely avoids all browser cookie restrictions (third-
  // party cookie blocking, SameSite rules inside iframes, etc.) that would
  // otherwise silently drop the session cookie in Replit's preview pane.
  const token = signSession(requiredKey);
  // Also set the cookie as a fallback for environments where it works fine.
  // Only use SameSite=None + Secure for Replit's cross-site iframe context.
  // Do NOT key off NODE_ENV=production: packaged Electron explicitly sets
  // NODE_ENV=production but still serves over plain http://localhost, and
  // some Chromium builds inside Electron reject SameSite=None cookies on
  // non-HTTPS origins even with the localhost exception, silently dropping
  // the cookie and causing every post-login API call to return 401.
  const crossSiteSafe = isReplit;
  res.cookie("bs_session", token, {
    httpOnly: true,
    sameSite: crossSiteSafe ? "none" : "lax",
    secure: crossSiteSafe,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true, token });
});

app.use("/api", (req, res, next) => {
  // Skip auth check if no API_KEY is set in environment
  // (allows development without setting up a key)
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) { next(); return; }

  // Allow health check without auth
  if (req.path === "/health") { next(); return; }

  // Primary: Bearer token in Authorization header (works in all iframe/cookie
  // environments; the client stores this in localStorage after login).
  // Fallback: legacy bs_session cookie (kept for environments where cookies work).
  const authHeader = req.headers["authorization"];
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const cookieToken = req.cookies?.bs_session as string | undefined;
  const provided = bearerToken ?? cookieToken;

  if (!provided || !verifySession(provided, requiredKey)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.use("/api/scans", scansRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/portfolio", portfolioRouter);
app.use("/api/dashboards", dashboardsRouter);
app.use("/api/scanner-dashboards", scannerDashboardsRouter);
app.use("/api/alerts", alertsRouter);
app.use("/api/paper-trading", paperTradingRouter);
app.use("/api/broker-connections", brokerConnectionsRouter);
app.use("/api/market-data", marketDataRouter);
app.use("/api/symbols", symbolsRouter);
app.use("/api/universe", universeRouter);

// Protected endpoint — only reachable with a valid session token.
// Used by the frontend's checkAuth() to confirm a stored token is still good.
app.get("/api/auth/verify", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  const meta = db
    .prepare("SELECT value FROM app_meta WHERE key = ?")
    .get("db_version") as { value: string } | undefined;
  res.json({ status: "ok", db_version: meta?.value ?? "unknown" });
});

app.get("/api/market/status", (_req, res) => {
  function getDbSizeMb(name: string): number {
    try {
      const s = statSync(path.join(config.dbDir, name));
      return Math.round(s.size / 1024 / 1024 * 10) / 10;
    } catch {
      return 0;
    }
  }

  // ── Symbol-table counts ────────────────────────────────────────────────────
  // All three queries are cheap covering-index reads (no table scan on a cold
  // DB); ohlcv_daily uses the idx_ohlcv_daily index for the DISTINCT count.
  const totalSymbols = (marketDb
    .prepare(`SELECT COUNT(*) AS n FROM symbols WHERE is_delisted = 0`)
    .get() as { n: number }).n;

  const fyersInvalidSymbols = (marketDb
    .prepare(`SELECT COUNT(*) AS n FROM symbols WHERE is_delisted = 0 AND fyers_eod_invalid = 1`)
    .get() as { n: number }).n;

  const symbolsWithEodData = (marketDb
    .prepare(`SELECT COUNT(DISTINCT symbol) AS n FROM ohlcv_daily`)
    .get() as { n: number }).n;

  const nseHolidaysCount = (marketDb
    .prepare(`SELECT COUNT(*) AS n FROM nse_holidays`)
    .get() as { n: number }).n;

  res.json({
    environment: config.envLabel,
    databases: {
      app_db_mb: getDbSizeMb("app.db"),
      market_db_mb: getDbSizeMb("market.db"),
      live_db_mb: getDbSizeMb("live.db"),
    },
    angel_connected: false, // will be updated when Angel API is integrated
    last_sync: null,        // will be populated from sync_log once Angel is running
    backfill: getServiceStats(),
    historicalBackfill: getHistoricalBackfillStatus(),
    nightlySync: getNightlySyncStatus(),
    symbolStats: {
      total: totalSymbols,
      fyersInvalid: fyersInvalidSymbols,
      withEodData: symbolsWithEodData,
    },
    nseHolidaysCount,
  });
});

// Serve built frontend in production
if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "../../artifacts/bharatscan/dist/public");
  app.use(express.static(distPath));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "API route not found" });
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`BharatScan server running on http://localhost:${port}`);
  resumeHistoricalBackfillOnStartup();
  startScheduler();
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[SERVER ERROR]", new Date().toISOString(), err.message);
  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }
  if (res.headersSent) return;
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : err.message || "Internal server error";
  res.status(500).json({ error: message });
});
