import { Router, type Request, type Response } from "express";
import { db } from "../db.js";
import { getLiveQuotes } from "../services/marketDataService.js";

const router = Router();

interface PaperAccountRow {
  id: string;
  name: string;
  starting_balance: number;
  cash_balance: number;
  created_at: string;
  updated_at: string;
}

interface PaperPositionRow {
  id: string;
  account_id: string;
  instrument_type: "stock" | "option" | "future";
  symbol: string;
  underlying: string | null;
  strike: number | null;
  option_type: "CE" | "PE" | null;
  expiry: string | null;
  side: "long" | "short";
  qty: number;
  lot_size: number;
  entry_price: number;
  entry_date: string;
  margin_blocked: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PaperTradeRow {
  id: string;
  account_id: string;
  position_id: string | null;
  instrument_type: "stock" | "option" | "future";
  symbol: string;
  underlying: string | null;
  strike: number | null;
  option_type: "CE" | "PE" | null;
  expiry: string | null;
  side: "long" | "short";
  qty: number;
  lot_size: number;
  entry_price: number;
  exit_price: number;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  created_at: string;
}

async function computeAccountStats(accountId: string) {
  const positions = db
    .prepare("SELECT * FROM paper_positions WHERE account_id = ? AND status = 'open'")
    .all(accountId) as unknown as PaperPositionRow[];
  const invested = positions.reduce((sum, p) => sum + p.margin_blocked, 0);
  const trades = db
    .prepare("SELECT COALESCE(SUM(realized_pnl), 0) as total FROM paper_trades WHERE account_id = ?")
    .get(accountId) as unknown as { total: number };

  let totalUnrealizedPnl = 0;
  if (positions.length > 0) {
    const symbols = [...new Set(positions.map((p) => p.symbol))];
    try {
      const quotes = await getLiveQuotes(symbols);
      const quoteMap = new Map(quotes.map((q) => [q.symbol, q.ltp]));
      for (const p of positions) {
        const ltp = quoteMap.get(p.symbol);
        if (ltp != null) {
          totalUnrealizedPnl += p.side === "long"
            ? (ltp - p.entry_price) * p.qty * p.lot_size
            : (p.entry_price - ltp) * p.qty * p.lot_size;
        }
      }
    } catch {
      // quotes unavailable — leave totalUnrealizedPnl as 0
    }
  }

  return { invested, realizedPnl: trades.total, openPositions: positions.length, totalUnrealizedPnl };
}

// ── Live quotes for paper trading order dialog ───────────────────────────────

router.get("/quotes", async (req: Request, res: Response) => {
  const raw = req.query.symbols as string | undefined;
  if (!raw?.trim()) { res.status(400).json({ error: "symbols query param required" }); return; }
  const symbols = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) { res.status(400).json({ error: "symbols query param required" }); return; }
  try {
    const quotes = await getLiveQuotes(symbols);
    res.json(quotes);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Quote fetch failed";
    res.status(503).json({ error: msg });
  }
});

// ── Accounts ─────────────────────────────────────────────────────────────────

router.get("/accounts", async (_req: Request, res: Response) => {
  const rows = db.prepare("SELECT * FROM paper_accounts ORDER BY created_at ASC").all() as unknown as PaperAccountRow[];
  const withStats = await Promise.all(rows.map(async (a) => ({ ...a, ...(await computeAccountStats(a.id)) })));
  res.json(withStats);
});

router.post("/accounts", async (req: Request, res: Response) => {
  const { name, starting_balance } = req.body as { name?: string; starting_balance?: number };
  if (!name?.trim() || !starting_balance || starting_balance <= 0) {
    res.status(400).json({ error: "name and starting_balance are required" });
    return;
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO paper_accounts (id, name, starting_balance, cash_balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name.trim(), Number(starting_balance), Number(starting_balance), now, now);
  res.status(201).json({ ...(db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(id) as unknown as PaperAccountRow), ...(await computeAccountStats(id)) });
});

router.put("/accounts/:id", async (req: Request, res: Response) => {
  const existing = db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow | undefined;
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const { name, add_funds } = req.body as { name?: string; add_funds?: number };
  const now = new Date().toISOString();
  const newBalance = add_funds ? existing.cash_balance + Number(add_funds) : existing.cash_balance;
  const newStarting = add_funds ? existing.starting_balance + Number(add_funds) : existing.starting_balance;
  db.prepare(
    "UPDATE paper_accounts SET name = ?, starting_balance = ?, cash_balance = ?, updated_at = ? WHERE id = ?"
  ).run(name?.trim() || existing.name, newStarting, newBalance, now, req.params.id);
  res.json({ ...(db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow), ...(await computeAccountStats(req.params.id)) });
});

router.delete("/accounts/:id", (req: Request, res: Response) => {
  const result = db.prepare("DELETE FROM paper_accounts WHERE id = ?").run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: "Not found" }); return; }
  res.status(204).send();
});

router.post("/accounts/:id/reset", async (req: Request, res: Response) => {
  const existing = db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow | undefined;
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM paper_positions WHERE account_id = ?").run(req.params.id);
    db.prepare("DELETE FROM paper_trades WHERE account_id = ?").run(req.params.id);
    db.prepare("UPDATE paper_accounts SET cash_balance = starting_balance, updated_at = ? WHERE id = ?").run(now, req.params.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ ...(db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow), ...(await computeAccountStats(req.params.id)) });
});

// ── Positions ────────────────────────────────────────────────────────────────

router.get("/accounts/:id/positions", async (req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM paper_positions WHERE account_id = ? AND status = 'open' ORDER BY created_at DESC")
    .all(req.params.id) as unknown as PaperPositionRow[];

  if (rows.length === 0) {
    res.json([]);
    return;
  }

  // Fetch live quotes for all symbols in one batch call
  const symbols = [...new Set(rows.map((p) => p.symbol))];
  let quoteMap = new Map<string, number>();
  try {
    const quotes = await getLiveQuotes(symbols);
    quoteMap = new Map(quotes.map((q) => [q.symbol, q.ltp]));
  } catch {
    // broker not connected or quote fetch failed — return null prices rather than failing the whole request
  }

  const enriched = rows.map((p) => {
    const current_price = quoteMap.get(p.symbol) ?? null;
    const unrealized_pnl = current_price != null
      ? p.side === "long"
        ? (current_price - p.entry_price) * p.qty * p.lot_size
        : (p.entry_price - current_price) * p.qty * p.lot_size
      : null;
    return { ...p, current_price, unrealized_pnl };
  });

  res.json(enriched);
});

router.post("/accounts/:id/positions", (req: Request, res: Response) => {
  const account = db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow | undefined;
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const {
    instrument_type, symbol, underlying, strike, option_type, expiry,
    side, qty, lot_size, entry_price, entry_date,
  } = req.body as {
    instrument_type?: "stock" | "option" | "future";
    symbol?: string;
    underlying?: string;
    strike?: number;
    option_type?: "CE" | "PE";
    expiry?: string;
    side?: "long" | "short";
    qty?: number;
    lot_size?: number;
    entry_price?: number;
    entry_date?: string;
  };

  if (!instrument_type || !symbol?.trim() || !side || !qty || qty <= 0 || !entry_price || entry_price <= 0 || !entry_date) {
    res.status(400).json({ error: "instrument_type, symbol, side, qty, entry_price, entry_date are required" });
    return;
  }
  if (instrument_type === "option" && (!underlying?.trim() || !strike || !option_type || !expiry)) {
    res.status(400).json({ error: "underlying, strike, option_type, expiry are required for options" });
    return;
  }
  if (instrument_type === "future" && (!underlying?.trim() || !expiry)) {
    res.status(400).json({ error: "underlying and expiry are required for futures" });
    return;
  }

  const effectiveLotSize = Number(lot_size) > 0 ? Number(lot_size) : 1;
  const notional = Number(qty) * effectiveLotSize * Number(entry_price);
  if (notional > account.cash_balance) {
    res.status(400).json({ error: `Insufficient virtual balance. Required ₹${notional.toFixed(2)}, available ₹${account.cash_balance.toFixed(2)}` });
    return;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO paper_positions
        (id, account_id, instrument_type, symbol, underlying, strike, option_type, expiry, side, qty, lot_size, entry_price, entry_date, margin_blocked, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      id, req.params.id, instrument_type, symbol.trim().toUpperCase(),
      underlying?.trim().toUpperCase() || null, strike ?? null, option_type ?? null, expiry ?? null,
      side, Number(qty), effectiveLotSize, Number(entry_price), entry_date, notional, now, now
    );
    db.prepare("UPDATE paper_accounts SET cash_balance = cash_balance - ?, updated_at = ? WHERE id = ?").run(notional, now, req.params.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  res.status(201).json(db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id) as unknown as PaperPositionRow);
});

router.post("/accounts/:id/positions/:posId/close", (req: Request, res: Response) => {
  const account = db.prepare("SELECT * FROM paper_accounts WHERE id = ?").get(req.params.id) as unknown as PaperAccountRow | undefined;
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }
  const position = db.prepare("SELECT * FROM paper_positions WHERE id = ? AND account_id = ?").get(req.params.posId, req.params.id) as unknown as PaperPositionRow | undefined;
  if (!position) { res.status(404).json({ error: "Position not found" }); return; }

  const { qty_closed, exit_price, exit_date } = req.body as { qty_closed?: number; exit_price?: number; exit_date?: string };
  if (!qty_closed || qty_closed <= 0 || qty_closed > position.qty || !exit_price || exit_price <= 0 || !exit_date) {
    res.status(400).json({ error: `qty_closed (1-${position.qty}), exit_price, exit_date are required` });
    return;
  }

  const closedQty = Number(qty_closed);
  const marginReleased = closedQty * position.lot_size * position.entry_price;
  const realizedPnl = position.side === "long"
    ? (Number(exit_price) - position.entry_price) * closedQty * position.lot_size
    : (position.entry_price - Number(exit_price)) * closedQty * position.lot_size;

  const now = new Date().toISOString();
  const tradeId = crypto.randomUUID();
  const remainingQty = position.qty - closedQty;
  try {
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO paper_trades
        (id, account_id, position_id, instrument_type, symbol, underlying, strike, option_type, expiry, side, qty, lot_size, entry_price, exit_price, entry_date, exit_date, realized_pnl, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tradeId, position.account_id, position.id, position.instrument_type, position.symbol,
      position.underlying, position.strike, position.option_type, position.expiry,
      position.side, closedQty, position.lot_size, position.entry_price, Number(exit_price),
      position.entry_date, exit_date, realizedPnl, now
    );
    db.prepare("UPDATE paper_accounts SET cash_balance = cash_balance + ?, updated_at = ? WHERE id = ?")
      .run(marginReleased + realizedPnl, now, position.account_id);
    if (remainingQty <= 0) {
      db.prepare("DELETE FROM paper_positions WHERE id = ?").run(position.id);
    } else {
      const newMargin = position.margin_blocked - marginReleased;
      db.prepare("UPDATE paper_positions SET qty = ?, margin_blocked = ?, updated_at = ? WHERE id = ?")
        .run(remainingQty, newMargin, now, position.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  if (remainingQty <= 0) {
    res.json({ action: "closed", trade_id: tradeId, realized_pnl: realizedPnl });
  } else {
    res.json({
      action: "partial",
      trade_id: tradeId,
      realized_pnl: realizedPnl,
      remaining_qty: remainingQty,
      position: db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(position.id) as unknown as PaperPositionRow,
    });
  }
});

// ── Trades (history) ────────────────────────────────────────────────────────

router.get("/accounts/:id/trades", (req: Request, res: Response) => {
  const rows = db
    .prepare("SELECT * FROM paper_trades WHERE account_id = ? ORDER BY created_at DESC")
    .all(req.params.id) as unknown as PaperTradeRow[];
  res.json(rows);
});

// ── Bulk Export / Import (used by app-wide backup/restore) ───────────────────

router.get("/export", (_req: Request, res: Response) => {
  const accounts = db.prepare("SELECT * FROM paper_accounts ORDER BY created_at ASC").all() as unknown as PaperAccountRow[];
  const data = accounts.map((a) => ({
    ...a,
    positions: db.prepare("SELECT * FROM paper_positions WHERE account_id = ?").all(a.id) as unknown as PaperPositionRow[],
    trades: db.prepare("SELECT * FROM paper_trades WHERE account_id = ?").all(a.id) as unknown as PaperTradeRow[],
  }));
  res.json(data);
});

router.post("/import", (req: Request, res: Response) => {
  const { accounts } = req.body as {
    accounts?: Array<{
      name: string;
      starting_balance: number;
      cash_balance: number;
      positions?: Array<Omit<PaperPositionRow, "id" | "account_id">>;
      trades?: Array<Omit<PaperTradeRow, "id" | "account_id" | "position_id">>;
    }>;
  };
  if (!Array.isArray(accounts) || accounts.length === 0) {
    res.status(400).json({ error: "accounts array is required" });
    return;
  }
  const now = new Date().toISOString();
  const created: string[] = [];
  try {
    db.exec("BEGIN");
    db.prepare("DELETE FROM paper_accounts").run();
    for (const a of accounts) {
      if (!a.name?.trim()) continue;
      const accountId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO paper_accounts (id, name, starting_balance, cash_balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(accountId, a.name.trim(), Number(a.starting_balance) || 0, Number(a.cash_balance) || 0, now, now);
      for (const p of a.positions ?? []) {
        db.prepare(
          `INSERT INTO paper_positions
            (id, account_id, instrument_type, symbol, underlying, strike, option_type, expiry, side, qty, lot_size, entry_price, entry_date, margin_blocked, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(), accountId, p.instrument_type, p.symbol, p.underlying ?? null,
          p.strike ?? null, p.option_type ?? null, p.expiry ?? null, p.side, Number(p.qty),
          Number(p.lot_size) || 1, Number(p.entry_price), p.entry_date, Number(p.margin_blocked) || 0,
          p.status ?? "open", now, now
        );
      }
      for (const t of a.trades ?? []) {
        db.prepare(
          `INSERT INTO paper_trades
            (id, account_id, position_id, instrument_type, symbol, underlying, strike, option_type, expiry, side, qty, lot_size, entry_price, exit_price, entry_date, exit_date, realized_pnl, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          crypto.randomUUID(), accountId, null, t.instrument_type, t.symbol, t.underlying ?? null,
          t.strike ?? null, t.option_type ?? null, t.expiry ?? null, t.side, Number(t.qty),
          Number(t.lot_size) || 1, Number(t.entry_price), Number(t.exit_price), t.entry_date,
          t.exit_date, Number(t.realized_pnl) || 0, now
        );
      }
      created.push(accountId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.status(201).json({ imported: created.length, account_ids: created });
});

export default router;
