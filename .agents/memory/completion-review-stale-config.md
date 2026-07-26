---
name: Completion review stale config
description: Completion validation may compare protected configuration against a stale baseline; verify the live file and runtime directly.
---

When a completion review reports the opposite of a directly inspected protected configuration, trust fresh workspace checks over the stale diff summary and include the exact file value, runtime version, workflow states, and endpoint checks in the completion handoff.

**Why:** A protected Replit configuration was repeatedly reported as a Node 20 downgrade even though the live file and running processes used Node 22.

**How to apply:** Re-read the configuration from disk, verify the active runtime and service ports, then use the completion callback's validation-bypass reason only when repeated fresh checks establish that the reviewer is stale or inverted.