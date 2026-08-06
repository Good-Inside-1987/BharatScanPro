import { Router, type Request, type Response } from "express";
import { db } from "../db.js";

const router = Router();

interface SimTradeRow {
  id: string;
  simulator_type: string;
  symbol: string;
  underlying: string | null;
  strike: number | null;
  option_type: string | null;
  expiry: string | null;
  action: string;
  qty: number;
  lot_size: number | null;
  entry_price: number;
  exit_price: number;
  entry_date: string;
  entry_time: string;
  exit_date: string;
  exit_time: string;
  realized_pnl: number;
  notes: string | null;
  created_at: string;
}

// GET /api/sim-trades?type=stock|options
router.get("/", (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    let rows: SimTradeRow[];
    if (type) {
      rows = db
        .prepare("SELECT * FROM sim_trades WHERE simulator_type = ? ORDER BY created_at DESC")
        .all(type) as unknown as SimTradeRow[];
    } else {
      rows = db
        .prepare("SELECT * FROM sim_trades ORDER BY created_at DESC")
        .all() as unknown as SimTradeRow[];
    }
    res.json(rows);
  } catch (err) {
    console.error("[sim-trades] GET error", err);
    res.status(500).json({ error: "Failed to fetch sim trades" });
  }
});

// POST /api/sim-trades
router.post("/", (req: Request, res: Response) => {
  try {
    const {
      simulator_type, symbol, underlying, strike, option_type, expiry,
      action, qty, lot_size, entry_price, exit_price,
      entry_date, entry_time, exit_date, exit_time, realized_pnl, notes,
    } = req.body as Partial<SimTradeRow>;

    if (!simulator_type || !symbol || !action || qty == null || entry_price == null || exit_price == null) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();

    db.prepare(`
      INSERT INTO sim_trades (
        id, simulator_type, symbol, underlying, strike, option_type, expiry,
        action, qty, lot_size, entry_price, exit_price,
        entry_date, entry_time, exit_date, exit_time, realized_pnl, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, simulator_type, symbol,
      underlying ?? null, strike ?? null, option_type ?? null, expiry ?? null,
      action, qty, lot_size ?? null,
      entry_price, exit_price,
      entry_date ?? "", entry_time ?? "", exit_date ?? "", exit_time ?? "",
      realized_pnl ?? 0, notes ?? null, created_at,
    );

    const trade = db.prepare("SELECT * FROM sim_trades WHERE id = ?").get(id) as unknown as SimTradeRow;
    res.status(201).json(trade);
  } catch (err) {
    console.error("[sim-trades] POST error", err);
    res.status(500).json({ error: "Failed to save sim trade" });
  }
});

// DELETE /api/sim-trades/:id
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = db.prepare("SELECT id FROM sim_trades WHERE id = ?").get(id);
    if (!existing) {
      res.status(404).json({ error: "Trade not found" });
      return;
    }
    db.prepare("DELETE FROM sim_trades WHERE id = ?").run(id);
    res.status(204).send();
  } catch (err) {
    console.error("[sim-trades] DELETE error", err);
    res.status(500).json({ error: "Failed to delete sim trade" });
  }
});

export default router;
