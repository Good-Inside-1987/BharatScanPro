/**
 * universe.test.ts
 *
 * Change #9 — tests for core universe utilities:
 *   categoryId, getLotSizeForExpiry, parseMasterCsv,
 *   getCategories / setCategories / clearCategories.
 *
 * CSV encoding note:
 *   parseCsvCells() follows RFC 4180: a field surrounded by double-quotes is
 *   unquoted, and "" inside quotes represents a literal ". To embed the text
 *   `"NSE Cash" List` inside a CSV field, the field must be written as:
 *     """NSE Cash"" List"
 *   which parseCsvCells decodes to the string:  "NSE Cash" List
 *   extractCategoryName() then finds the inner quoted segment → "NSE Cash".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  categoryId,
  getLotSizeForExpiry,
  parseMasterCsv,
  getCategories,
  setCategories,
  clearCategories,
  type UniverseCategory,
  type LotSizeMap,
} from "../lib/universe";

// ── categoryId ────────────────────────────────────────────────────────────────

describe("categoryId", () => {
  it("slugifies a simple name", () => {
    expect(categoryId("Nifty 50")).toBe("nifty-50");
  });

  it("handles special characters and multiple spaces", () => {
    expect(categoryId("NSE Cash (EQ)")).toBe("nse-cash-eq");
  });

  it("strips leading and trailing hyphens", () => {
    expect(categoryId("  -- My Holdings --  ")).toBe("my-holdings");
  });

  it("returns 'cat' for an empty string", () => {
    expect(categoryId("")).toBe("cat");
    expect(categoryId("   ")).toBe("cat");
  });

  it("preserves numbers", () => {
    expect(categoryId("Nifty500")).toBe("nifty500");
    expect(categoryId("Top 100 Stocks")).toBe("top-100-stocks");
  });
});

// ── getLotSizeForExpiry ───────────────────────────────────────────────────────

describe("getLotSizeForExpiry", () => {
  const lotSizes: LotSizeMap = {
    NIFTY:    { "2026-07": 75, "2026-08": 75, "2026-09": 75 },
    BANKNIFTY:{ "2026-07": 30, "2026-08": 30 },
    FINNIFTY: { "2026-07": 40 },
  };

  it("returns the lot size for an exact month match", () => {
    expect(getLotSizeForExpiry(lotSizes, "NIFTY",     "2026-07-28")).toBe(75);
    expect(getLotSizeForExpiry(lotSizes, "BANKNIFTY", "2026-07-30")).toBe(30);
  });

  it("is case-insensitive for the symbol key", () => {
    expect(getLotSizeForExpiry(lotSizes, "nifty", "2026-07-28")).toBe(75);
  });

  it("falls back to fallback when symbol is missing", () => {
    expect(getLotSizeForExpiry(lotSizes, "MIDCPNIFTY", "2026-07-28")).toBe(1);
    expect(getLotSizeForExpiry(lotSizes, "MIDCPNIFTY", "2026-07-28", 50)).toBe(50);
  });

  it("uses nearest-earlier month when exact month is missing (nearest-month fallback)", () => {
    // FINNIFTY only has 2026-07; requesting 2026-08 → picks 2026-07 (latest ≤ expiry)
    expect(getLotSizeForExpiry(lotSizes, "FINNIFTY", "2026-08-28")).toBe(40);
  });

  it("uses the earliest available month when no prior month exists", () => {
    // Requesting a month before the only known month → picks the earliest
    expect(getLotSizeForExpiry(lotSizes, "FINNIFTY", "2026-06-28")).toBe(40);
  });

  it("handles old flat-number format (backwards-compatible)", () => {
    const oldFormat = { NIFTY: 75 } as unknown as LotSizeMap;
    expect(getLotSizeForExpiry(oldFormat, "NIFTY", "2026-07-28")).toBe(75);
  });

  it("returns fallback when old-format value is zero", () => {
    const bad = { NIFTY: 0 } as unknown as LotSizeMap;
    expect(getLotSizeForExpiry(bad, "NIFTY", "2026-07-28")).toBe(1);
  });

  it("returns fallback for null entry", () => {
    const sparse = { NIFTY: null } as unknown as LotSizeMap;
    expect(getLotSizeForExpiry(sparse, "NIFTY", "2026-07-28")).toBe(1);
  });
});

// ── parseMasterCsv ────────────────────────────────────────────────────────────
//
// The CSV cells below use proper RFC 4180 quoting:
//   """NSE Cash"" Stocks List"  →  cell text: "NSE Cash" Stocks List
//   extractCategoryName()       →  name:       NSE Cash

describe("parseMasterCsv — empty / degenerate inputs", () => {
  it("returns empty results for an empty string", () => {
    const result = parseMasterCsv("");
    expect(result.categories).toHaveLength(0);
    expect(result.holidays).toHaveLength(0);
    expect(result.quotes).toHaveLength(0);
  });

  it("requires at least two rows — returns empty when only a title row is present", () => {
    // parseMasterCsv guards: if (rows.length < 2) return empty.
    // A CSV with only one row (title) cannot yield any categories.
    const csv = '"""NSE Cash"" Stocks List"';
    const { categories } = parseMasterCsv(csv);
    expect(categories).toHaveLength(0);
  });

  it("returns a named category with no symbols for a title row + one empty data row", () => {
    // Two rows satisfy the length guard; the data row is blank so no symbols.
    // Cell decoded by parseCsvCells: "NSE Cash" Stocks List
    const csv = '"""NSE Cash"" Stocks List"\n\n';
    const { categories } = parseMasterCsv(csv);
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("NSE Cash");
    expect(categories[0].id).toBe("nse-cash");
    expect(categories[0].symbols).toHaveLength(0);
  });
});

describe("parseMasterCsv — simple single-category format", () => {
  // Row 0: title with quoted name (RFC 4180 encoded)
  // Row 1+: plain symbol cells (no quoting needed for simple ticker strings)
  const csv = [
    '"""NSE Cash"" Stocks List"',
    "RELIANCE",
    "TCS",
    "INFY",
    "HDFCBANK",
    "RELIANCE",   // duplicate — must be deduplicated
  ].join("\n");

  it("parses the category name and id correctly", () => {
    const { categories } = parseMasterCsv(csv);
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("NSE Cash");
    expect(categories[0].id).toBe("nse-cash");
  });

  it("deduplicates symbols", () => {
    const { categories } = parseMasterCsv(csv);
    const syms = categories[0].symbols;
    expect(syms).toHaveLength(4);
    // Every symbol appears exactly once
    expect(new Set(syms).size).toBe(syms.length);
  });

  it("sorts symbols alphabetically", () => {
    const { categories } = parseMasterCsv(csv);
    const syms = categories[0].symbols;
    expect(syms).toEqual([...syms].sort());
  });

  it("includes all expected symbols", () => {
    const { categories } = parseMasterCsv(csv);
    expect(categories[0].symbols).toContain("RELIANCE");
    expect(categories[0].symbols).toContain("TCS");
    expect(categories[0].symbols).toContain("INFY");
    expect(categories[0].symbols).toContain("HDFCBANK");
  });
});

describe("parseMasterCsv — multi-category format (column-block layout)", () => {
  // Three categories in separate columns separated by commas.
  // Each title cell uses """Name"" Label" RFC 4180 quoting.
  const csv = [
    '"""Nifty 50"" Stocks List",,"""Futures"" List",,"""My Favourite"" Watchlist"',
    "RELIANCE,,RELIANCE,,WIPRO",
    "TCS,,INFY,,TCS",
    "INFY,,TCS,,",
  ].join("\n");

  it("creates one category per named column", () => {
    const { categories } = parseMasterCsv(csv);
    const names = categories.map((c) => c.name);
    expect(names).toContain("Nifty 50");
    expect(names).toContain("Futures");
    expect(names).toContain("My Favourite");
  });

  it("puts symbols in the correct category", () => {
    const { categories } = parseMasterCsv(csv);
    const nifty50 = categories.find((c) => c.name === "Nifty 50")!;
    expect(nifty50.symbols).toContain("RELIANCE");
    expect(nifty50.symbols).toContain("TCS");

    const myFav = categories.find((c) => c.name === "My Favourite")!;
    expect(myFav.symbols).toContain("WIPRO");
    expect(myFav.symbols).toContain("TCS");
  });

  it("does not cross-contaminate symbols between categories", () => {
    const { categories } = parseMasterCsv(csv);
    const nifty50 = categories.find((c) => c.name === "Nifty 50")!;
    expect(nifty50.symbols).not.toContain("WIPRO");
  });

  it("assigns stable ids via categoryId", () => {
    const { categories } = parseMasterCsv(csv);
    expect(categories.find((c) => c.name === "Nifty 50")?.id).toBe("nifty-50");
    expect(categories.find((c) => c.name === "Futures")?.id).toBe("futures");
    expect(categories.find((c) => c.name === "My Favourite")?.id).toBe("my-favourite");
  });
});

describe("parseMasterCsv — group-header (new Apr-2026 format)", () => {
  // Row 0: group-header row that triggers isGroupHeaderRow detection.
  //        Must have no quoted names and contain "Holiday Calender Data".
  // Row 1: real section titles (RFC 4180 quoted names) + holiday column headers.
  // Row 2+: data rows.
  //
  // Holiday dates use DD/MM/YYYY which normalizeHolidayDate() handles.
  const csv = [
    // Row 0 — group-header (triggers holiday boundary detection)
    "Watchlist,,,,,Holiday Calender Data 2026,,,",
    // Row 1 — title row: quoted category names + holiday column labels
    '"""NSE Cash"" List",,,"""Nifty 50"" List",,Status (2026),Date,Day,Occasion',
    // Row 2+ — data
    "RELIANCE,,,TCS,,Close,14/01/2026,Wednesday,Makar Sankranti",
    "HDFCBANK,,,INFY,,Close,26/01/2026,Monday,Republic Day",
    ",,,RELIANCE,,,,,",
  ].join("\n");

  it("parses categories correctly from title row (row 1)", () => {
    const { categories } = parseMasterCsv(csv);
    const names = categories.map((c) => c.name);
    expect(names).toContain("NSE Cash");
    expect(names).toContain("Nifty 50");
  });

  it("does not create a category for holiday column headers", () => {
    const { categories } = parseMasterCsv(csv);
    const names = categories.map((c) => c.name);
    expect(names).not.toContain("Status (2026)");
    expect(names).not.toContain("Date");
    expect(names).not.toContain("Day");
    expect(names).not.toContain("Occasion");
  });

  it("parses holiday dates correctly", () => {
    const { holidays } = parseMasterCsv(csv);
    expect(holidays.length).toBeGreaterThanOrEqual(2);
    const dates = holidays.map((h) => h.date);
    expect(dates).toContain("2026-01-14");
    expect(dates).toContain("2026-01-26");
  });

  it("holidays are sorted by date", () => {
    const { holidays } = parseMasterCsv(csv);
    for (let i = 1; i < holidays.length; i++) {
      expect(holidays[i].date >= holidays[i - 1].date).toBe(true);
    }
  });

  it("holiday occasion text is preserved", () => {
    const { holidays } = parseMasterCsv(csv);
    const sankranti = holidays.find((h) => h.date === "2026-01-14");
    expect(sankranti?.occasion).toBe("Makar Sankranti");
  });

  it("symbols are not polluted by holiday column content", () => {
    const { categories } = parseMasterCsv(csv);
    for (const cat of categories) {
      for (const sym of cat.symbols) {
        // No date-like strings
        expect(sym).not.toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
        // No occasion text
        expect(sym.toLowerCase()).not.toMatch(/sankranti|republic|close/);
      }
    }
  });
});

describe("parseMasterCsv — lot-size block", () => {
  // Mirrors the real NSE "All Watchlists" export layout:
  //   Row 0 group-header: "Watchlist" block | "Holiday Calender Data 2026"
  //          boundary (sets holidayStartCol=2, which also caps category
  //          scanning to cols 0-1) | "Lot Size" block further right.
  //   Row 1 title row: quoted category name | Date/Occasion holiday headers |
  //          Symbol + month headers for lot sizes.
  //   Row 2+: data rows spanning all blocks.
  //
  // The lot-size scanner looks for "Lot Size" in rows[0] to find its column
  // start, then scans the title row from that column onward for "Symbol" and
  // month labels (Jul-26 etc.). "Symbol" must sit at or after that column.
  const csv = [
    // Row 0 — group-header (no quoted names → isGroupHeaderRow = true)
    "Watchlist,,Holiday Calender Data 2026,,Lot Size",
    // Row 1 — title row
    '"""Futures"" List",,Date,Occasion,Symbol,Jul-26,Aug-26,Sep-26',
    // Row 2+ — data
    "RELIANCE,,14/01/2026,Makar Sankranti,NIFTY,75,75,75",
    "TCS,,26/01/2026,Republic Day,BANKNIFTY,30,30,30",
    "INFY,,,,FINNIFTY,40,40,",
  ].join("\n");

  it("extracts lot sizes with correct YYYY-MM month keys", () => {
    const { lotSizes } = parseMasterCsv(csv);
    expect(lotSizes["NIFTY"]?.["2026-07"]).toBe(75);
    expect(lotSizes["NIFTY"]?.["2026-08"]).toBe(75);
    expect(lotSizes["BANKNIFTY"]?.["2026-07"]).toBe(30);
  });

  it("ignores empty lot-size cells", () => {
    const { lotSizes } = parseMasterCsv(csv);
    expect(lotSizes["FINNIFTY"]?.["2026-09"]).toBeUndefined();
  });
});

// ── getCategories / setCategories / clearCategories ───────────────────────────

describe("getCategories / setCategories / clearCategories", () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem:    (key: string) => store[key] ?? null,
      setItem:    (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear:      () => { store = {}; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty array when localStorage is empty", () => {
    expect(getCategories()).toEqual([]);
  });

  it("round-trips a category list through localStorage", () => {
    const cats: UniverseCategory[] = [
      { id: "nifty-50", name: "Nifty 50", symbols: ["RELIANCE", "TCS"] },
      { id: "futures",  name: "Futures",  symbols: ["NIFTY"] },
    ];
    setCategories(cats);
    expect(getCategories()).toEqual(cats);
  });

  it("clearCategories removes the stored value", () => {
    setCategories([{ id: "nifty-50", name: "Nifty 50", symbols: ["RELIANCE"] }]);
    clearCategories();
    expect(getCategories()).toEqual([]);
  });

  it("getCategories tolerates malformed JSON gracefully", () => {
    store["bharatscan:universe-categories"] = "not-valid-json{{{";
    expect(() => getCategories()).not.toThrow();
    expect(getCategories()).toEqual([]);
  });

  it("getCategories filters out null entries", () => {
    const data = [
      { id: "ok", name: "OK", symbols: ["RELIANCE"] },
      null,
    ];
    store["bharatscan:universe-categories"] = JSON.stringify(data);
    const result = getCategories();
    expect(result.every((c) => c !== null)).toBe(true);
    expect(result.find((c) => c.id === "ok")).toBeDefined();
  });

  it("getCategories filters out entries missing the symbols array", () => {
    const data = [
      { id: "ok",  name: "OK",  symbols: ["RELIANCE"] },
      { id: "bad", name: "Bad" },   // no symbols field
    ];
    store["bharatscan:universe-categories"] = JSON.stringify(data);
    const result = getCategories();
    // The "bad" entry has no symbols array → filtered out
    expect(result.find((c) => c.id === "bad")).toBeUndefined();
    expect(result.find((c) => c.id === "ok")).toBeDefined();
  });
});
