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
// Generates universe categories directly from the symbol master (market.db).
// One category is emitted per NSE index found in index_membership, in a
// canonical order defined by ORDERED_INDICES below.  Futures and NSE All are
// appended at the end.  Returns [] when the symbol master has never been synced.
//
// The "nifty-50" and "futures" ids intentionally match OPTIONS_UNIVERSE_NAMES
// in Index.tsx / ScannerDashboard.tsx so the Options-mode filter keeps working.

// Canonical display names for every index key stored in index_membership.
// Order here defines the order they appear in the dropdown.
// Keys MUST match the `name` values in NSE_INDICES in symbolMasterService.ts.
const ORDERED_INDICES: Array<{ key: string; label: string }> = [
  // Broad market
  { key: "NIFTY50",          label: "Nifty 50"          },
  { key: "NIFTYNEXT50",      label: "Nifty Next 50"     },
  { key: "NIFTY100",         label: "Nifty 100"         },
  { key: "NIFTY200",         label: "Nifty 200"         },
  { key: "NIFTY500",         label: "Nifty 500"         },
  // Midcap
  { key: "NIFTYMIDCAP50",    label: "Nifty Midcap 50"   },
  { key: "NIFTYMIDCAP100",   label: "Nifty Midcap 100"  },
  { key: "NIFTYMIDCAP150",   label: "Nifty Midcap 150"  },
  // Smallcap
  { key: "NIFTYSMALLCAP50",  label: "Nifty Smallcap 50"  },
  { key: "NIFTYSMALLCAP100", label: "Nifty Smallcap 100" },
  { key: "NIFTYSMALLCAP250", label: "Nifty Smallcap 250" },
  // Microcap
  { key: "NIFTYMICROCAP250", label: "Nifty Microcap 250" },
  // Sectoral / thematic
  { key: "NIFTYBANK",        label: "Nifty Bank"         },
  { key: "NIFTYIT",          label: "Nifty IT"           },
  { key: "NIFTYPHARMA",      label: "Nifty Pharma"       },
  { key: "NIFTYAUTO",        label: "Nifty Auto"         },
  { key: "NIFTYFMCG",        label: "Nifty FMCG"         },
  { key: "NIFTYFINSERVICE",  label: "Nifty FinServ"      },
  { key: "NIFTYMETAL",       label: "Nifty Metal"        },
  { key: "NIFTYREALTY",      label: "Nifty Realty"       },
  { key: "NIFTYOILGAS",      label: "Nifty Oil & Gas"    },
  { key: "NIFTYMEDIA",       label: "Nifty Media"        },
];

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

    // Helper: fetch symbols matching a WHERE fragment, alphabetically sorted.
    function fetchSymbols(where: string): string[] {
      return (
        marketDb
          .prepare(
            `SELECT symbol FROM symbols WHERE is_delisted = 0 AND ${where} ORDER BY symbol`
          )
          .all() as unknown as Array<{ symbol: string }>
      ).map((r) => r.symbol);
    }

    // Determine which index keys are actually present in this DB so we skip
    // indices that weren't fetched yet (e.g. NSE returned 403 for that CSV).
    const presentKeys = new Set<string>(
      (
        marketDb
          .prepare(
            `SELECT DISTINCT index_membership FROM symbols
             WHERE is_delisted = 0 AND index_membership IS NOT NULL`
          )
          .all() as unknown as Array<{ index_membership: string }>
      ).flatMap((r) => r.index_membership.split(",").map((k) => k.trim()))
    );

    const categories: UniverseCategory[] = [];

    // One category per known index, in canonical order, only if data exists.
    for (const { key, label } of ORDERED_INDICES) {
      if (!presentKeys.has(key)) continue;
      // Bracket with commas to prevent "NIFTY500" matching "NIFTY50".
      const symbols = fetchSymbols(
        `',' || index_membership || ',' LIKE '%,${key},%'`
      );
      if (symbols.length > 0) {
        categories.push({ id: key.toLowerCase().replace(/_/g, "-"), name: label, symbols });
      }
    }

    // Futures (F&O eligible) — always append before NSE All.
    const futures = fetchSymbols("is_fo_eligible = 1");
    if (futures.length > 0) {
      categories.push({ id: "futures", name: "Futures", symbols: futures });
    }

    // NSE All — every non-delisted equity.
    const nseAll = fetchSymbols("1=1");
    if (nseAll.length > 0) {
      categories.push({ id: "nse-all", name: "NSE All", symbols: nseAll });
    }

    res.json({ categories });
  } catch (err) {
    console.error("[universe] GET /derived error:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Failed to derive universe categories from symbol master" });
  }
});

export default router;
