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
import { appDb } from "../db.js";

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

export default router;
