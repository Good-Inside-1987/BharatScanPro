/**
 * universe.ts
 *
 * REST surface for user-defined universe categories (parsed from the
 * "All Watchlist" master CSV upload).
 *
 * GET  /api/universe/categories
 *   Returns the stored category list ordered by sort_order.
 *   Response: { categories: UniverseCategory[] }
 *
 * PUT  /api/universe/categories
 *   Full-replace: atomically deletes all existing rows and inserts the
 *   new set. Body: { categories: UniverseCategory[] }
 *   Response: { ok: true; count: number }
 *
 * DELETE /api/universe/categories
 *   Removes all stored categories (e.g. "Clear watchlists" action).
 *   Response: { ok: true }
 */

import { Router, type Request, type Response } from "express";
import { appDb, marketDb } from "../db.js";

export interface UniverseCategory {
  id: string;
  name: string;
  symbols: string[];
}

const router = Router();

// ── GET /categories ──────────────────────────────────────────────────────────

router.get("/categories", (_req: Request, res: Response) => {
  try {
    const rows = appDb
      .prepare(
        `SELECT id, name, symbols FROM universe_categories ORDER BY sort_order, rowid`
      )
      .all() as unknown as Array<{ id: string; name: string; symbols: string }>;

    const categories: UniverseCategory[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      symbols: JSON.parse(r.symbols) as string[],
    }));

    res.json({ categories });
  } catch (err) {
    console.error("[universe] GET /categories error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to read universe categories" });
  }
});

// ── PUT /categories ──────────────────────────────────────────────────────────

router.put("/categories", (req: Request, res: Response) => {
  const body = req.body as { categories?: unknown };

  if (!Array.isArray(body?.categories)) {
    res.status(400).json({ error: "categories must be an array" });
    return;
  }

  const incoming = body.categories as unknown[];
  for (let i = 0; i < incoming.length; i++) {
    const c = incoming[i] as Record<string, unknown>;
    if (
      typeof c?.id !== "string" || !c.id.trim() ||
      typeof c?.name !== "string" || !c.name.trim() ||
      !Array.isArray(c?.symbols)
    ) {
      res.status(400).json({
        error: `categories[${i}] must have non-empty id, name, and a symbols array`,
      });
      return;
    }
  }

  const cats = incoming as Array<{ id: string; name: string; symbols: string[] }>;
  const now = new Date().toISOString();

  try {
    appDb.exec("BEGIN");
    appDb.prepare("DELETE FROM universe_categories").run();
    const insert = appDb.prepare(
      `INSERT INTO universe_categories (id, name, symbols, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < cats.length; i++) {
      insert.run(cats[i].id, cats[i].name, JSON.stringify(cats[i].symbols), i, now);
    }
    appDb.exec("COMMIT");
    console.log("[universe] Saved %d universe categories", cats.length);
    res.json({ ok: true, count: cats.length });
  } catch (err) {
    try { appDb.exec("ROLLBACK"); } catch { /* ignore */ }
    console.error("[universe] PUT /categories error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to save universe categories" });
  }
});

// ── DELETE /categories ───────────────────────────────────────────────────────

router.delete("/categories", (_req: Request, res: Response) => {
  try {
    appDb.prepare("DELETE FROM universe_categories").run();
    console.log("[universe] Cleared all universe categories");
    res.json({ ok: true });
  } catch (err) {
    console.error("[universe] DELETE /categories error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to clear universe categories" });
  }
});

// ── GET /derived ─────────────────────────────────────────────────────────────
// Generates universe categories directly from the symbol master (market.db)
// so the dropdown is populated out of the box, before any CSV is uploaded.
// Returns an empty array when the symbol master has never been synced.
//
// Order: Nifty 50 → Nifty 100 → Nifty 500 → Futures → NSE All.
// Names intentionally match OPTIONS_UNIVERSE_NAMES in Index.tsx /
// ScannerDashboard.tsx ("nifty 50", "futures") so the Options-mode filter
// keeps working without any changes to those pages.

router.get("/derived", (_req: Request, res: Response) => {
  try {
    const totalRow = marketDb
      .prepare("SELECT COUNT(*) AS n FROM symbols WHERE is_delisted = 0")
      .get() as { n: number };

    if (totalRow.n === 0) {
      // Symbol master not yet synced — caller falls back to localStorage.
      res.json({ categories: [] });
      return;
    }

    // Fetch an ordered list of tickers matching a WHERE fragment.
    function fetchSymbols(where: string): string[] {
      return (
        marketDb
          .prepare(
            `SELECT symbol FROM symbols WHERE is_delisted = 0 AND ${where} ORDER BY symbol`
          )
          .all() as unknown as Array<{ symbol: string }>
      ).map((r) => r.symbol);
    }

    // index_membership is a comma-separated string like "NIFTY50,NIFTY100,NIFTY500".
    // Bracket with commas to avoid "NIFTY500" matching a search for "NIFTY50".
    const nifty50  = fetchSymbols("',' || COALESCE(index_membership,'') || ',' LIKE '%,NIFTY50,%'");
    const nifty100 = fetchSymbols("',' || COALESCE(index_membership,'') || ',' LIKE '%,NIFTY100,%'");
    const nifty500 = fetchSymbols("',' || COALESCE(index_membership,'') || ',' LIKE '%,NIFTY500,%'");
    const futures  = fetchSymbols("is_fo_eligible = 1");
    const nseAll   = fetchSymbols("1=1");

    const categories: UniverseCategory[] = [
      { id: "nifty-50",  name: "Nifty 50",  symbols: nifty50  },
      { id: "nifty-100", name: "Nifty 100", symbols: nifty100 },
      { id: "nifty-500", name: "Nifty 500", symbols: nifty500 },
      { id: "futures",   name: "Futures",   symbols: futures   },
      { id: "nse-all",   name: "NSE All",   symbols: nseAll    },
    ].filter((c) => c.symbols.length > 0);

    res.json({ categories });
  } catch (err) {
    console.error("[universe] GET /derived error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to derive universe categories from symbol master" });
  }
});

export default router;
