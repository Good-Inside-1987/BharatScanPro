---
name: Electron legacy status endpoints
description: Aggregate operator-status endpoints must tolerate older per-user SQLite databases used by packaged Electron installs.
---

Aggregate dashboard endpoints can fail as a whole when a packaged Electron user's SQLite database predates one column or table, even though independent diagnostics routes still work.

**Why:** Electron stores databases in an OS-specific user-data directory and survives app upgrades; Replit usually starts from the current schema. A single legacy query failure can blank several otherwise unrelated status panels.

**How to apply:** Keep aggregate status responses backward-compatible: isolate optional database reads, log the missing piece, and return a valid partial/empty snapshot rather than a 500 response. Rebuild/restart the Electron app after shipping backend changes.