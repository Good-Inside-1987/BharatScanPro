---
name: Broker sync roadmap status
description: Durable context for the agreed step-by-step Fyers data reliability roadmap and its Replit/Electron verification boundary.
---

The user prefers the broker/data roadmap to be handled one numbered step at a time, with an audit and report before starting the next step. The current roadmap is:

- Step 1: options sync falls back to the stored EOD/intraday close when the closed-market options API reports no spot.
- Step 2: options sync throttles between underlyings, retries soft rate limits, and stops cleanly on the hard options-chain quota.
- Step 3: intraday sync retries raw Fyers network failures with short backoff while still stopping for authentication/session errors.
- Step 4: historical EOD backfill is a user-started, resumable job from the Electron Settings dashboard.
- Step 5: verify the complete broker-to-database pipeline on the next trading run; this is verification, not another planned code change.

The current Replit audit confirms Steps 1–3 in the live branch and confirms the Step 4 backfill implementation and Settings/API wiring exist. It does not prove that Step 4 has run: Replit has no broker session and its local market database has no historical bars or backfill job. The Mac Electron runtime has a separate database and broker session, so Step 4 progress and Step 5 results must be checked there after the user pulls the code, connects the broker, starts/resumes backfill, and runs a trading-day sync.

**Why:** Treating the Replit preview as if it shared the Mac Electron broker session or SQLite files would produce false verification and could incorrectly mark the pipeline complete.

**How to apply:** Before advancing a numbered step, inspect the current source and the runtime that actually owns the broker/database evidence. Report “code ready” separately from “live data verified,” and do not claim Step 5 until logs show successful sync output and the target Electron database contains persisted rows.