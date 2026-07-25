/**
 * universe-api.test.ts
 *
 * Change #9 — tests for the universe API helpers in api.ts:
 *   apiGetUniverseCategories, apiSaveUniverseCategories,
 *   apiClearUniverseCategories, apiGetDerivedCategories.
 *
 * Key behaviour notes (from the actual implementation):
 *   - apiGetUniverseCategories() unwraps .categories and catches errors → []
 *   - apiGetDerivedCategories()  unwraps .categories and catches errors → []
 *   - apiSaveUniverseCategories / apiClearUniverseCategories propagate errors
 *
 * All tests use a mocked global fetch so no network calls are made.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiGetUniverseCategories,
  apiSaveUniverseCategories,
  apiClearUniverseCategories,
  apiGetDerivedCategories,
} from "../lib/api";

// ── helpers ───────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    }),
  );
}

// Stub localStorage so the Bearer-token lookup inside getBearerToken() does
// not throw in a Node/jsdom-less vitest environment.
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── apiGetUniverseCategories ──────────────────────────────────────────────────
// Returns ApiUniverseCategory[] directly (not the envelope object).
// Catches any error and returns [] so the caller never needs to handle throws.

describe("apiGetUniverseCategories", () => {
  it("returns the unwrapped categories array on a 200 response", async () => {
    mockFetch(200, {
      categories: [
        { id: "nifty-50", name: "Nifty 50", symbols: ["RELIANCE", "TCS"] },
      ],
    });
    const result = await apiGetUniverseCategories();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("nifty-50");
    expect(result[0].symbols).toContain("RELIANCE");
  });

  it("returns an empty array when the server has no categories", async () => {
    mockFetch(200, { categories: [] });
    const result = await apiGetUniverseCategories();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a 500 server error", async () => {
    mockFetch(500, { error: "Internal Server Error" });
    const result = await apiGetUniverseCategories();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a 401 Unauthorized response", async () => {
    mockFetch(401, { error: "Unauthorized" });
    const result = await apiGetUniverseCategories();
    expect(result).toEqual([]);
  });

  it("returns [] when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const result = await apiGetUniverseCategories();
    expect(result).toEqual([]);
  });
});

// ── apiSaveUniverseCategories ─────────────────────────────────────────────────

describe("apiSaveUniverseCategories", () => {
  it("returns ok:true and count on success", async () => {
    mockFetch(200, { ok: true, count: 3 });
    const cats = [
      { id: "nifty-50", name: "Nifty 50", symbols: ["RELIANCE"] },
      { id: "futures",  name: "Futures",  symbols: ["NIFTY"] },
      { id: "my-fav",   name: "My Favourite", symbols: ["WIPRO"] },
    ];
    const result = await apiSaveUniverseCategories(cats);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
  });

  it("sends a PUT request with the categories payload", async () => {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ ok: true, count: 1 })),
      json: () => Promise.resolve({ ok: true, count: 1 }),
    });
    vi.stubGlobal("fetch", mockFn);

    const cats = [{ id: "nifty-50", name: "Nifty 50", symbols: ["RELIANCE"] }];
    await apiSaveUniverseCategories(cats);

    expect(mockFn).toHaveBeenCalledOnce();
    const [_url, init] = mockFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body as string) as { categories: unknown[] };
    expect(body.categories).toHaveLength(1);
    expect((body.categories[0] as { id: string }).id).toBe("nifty-50");
  });

  it("throws on a 400 Bad Request response", async () => {
    mockFetch(400, { error: "categories must be an array" });
    await expect(apiSaveUniverseCategories([])).rejects.toThrow();
  });

  it("throws on a 500 server error", async () => {
    mockFetch(500, { error: "Failed to save" });
    await expect(
      apiSaveUniverseCategories([{ id: "x", name: "X", symbols: [] }])
    ).rejects.toThrow();
  });
});

// ── apiClearUniverseCategories ────────────────────────────────────────────────

describe("apiClearUniverseCategories", () => {
  it("returns ok:true on success", async () => {
    mockFetch(200, { ok: true });
    const result = await apiClearUniverseCategories();
    expect(result.ok).toBe(true);
  });

  it("sends a DELETE request", async () => {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal("fetch", mockFn);

    await apiClearUniverseCategories();
    expect(mockFn).toHaveBeenCalledOnce();
    const [_url, init] = mockFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("DELETE");
  });

  it("throws on a 500 server error", async () => {
    mockFetch(500, { error: "Failed to clear" });
    await expect(apiClearUniverseCategories()).rejects.toThrow();
  });
});

// ── apiGetDerivedCategories ───────────────────────────────────────────────────
// Returns ApiUniverseCategory[] directly. Catches errors → [].

describe("apiGetDerivedCategories", () => {
  it("returns the unwrapped derived categories from the symbol master", async () => {
    mockFetch(200, {
      categories: [
        { id: "nifty-50",  name: "Nifty 50",  symbols: ["RELIANCE", "TCS"] },
        { id: "nifty-100", name: "Nifty 100", symbols: ["RELIANCE", "TCS", "INFY"] },
        { id: "futures",   name: "Futures",   symbols: ["NIFTY", "BANKNIFTY"] },
        { id: "nse-all",   name: "NSE All",   symbols: ["RELIANCE", "TCS", "INFY", "WIPRO"] },
      ],
    });
    const result = await apiGetDerivedCategories();
    expect(result).toHaveLength(4);
    expect(result.find((c) => c.name === "Nifty 50")?.symbols).toContain("RELIANCE");
    expect(result.find((c) => c.name === "Futures")?.symbols).toContain("NIFTY");
  });

  it("returns [] when the symbol master is not synced yet", async () => {
    mockFetch(200, { categories: [] });
    const result = await apiGetDerivedCategories();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a 503 server error", async () => {
    // The implementation catches errors → [] so the UI can fall back gracefully.
    mockFetch(503, { error: "Service Unavailable" });
    const result = await apiGetDerivedCategories();
    expect(result).toEqual([]);
  });

  it("returns [] (does not throw) on a 401 response", async () => {
    mockFetch(401, { error: "Unauthorized" });
    const result = await apiGetDerivedCategories();
    expect(result).toEqual([]);
  });

  it("returns [] when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const result = await apiGetDerivedCategories();
    expect(result).toEqual([]);
  });
});
