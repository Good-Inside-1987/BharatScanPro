---
name: Vite host binding
description: Artifact-managed workflows and the standard port-5000 workflow require different Vite host bindings
---

# Vite Host Binding

**Rule:** Use `--host ::` for artifact-managed Vite workflows that use Replit's IPv6 port check. Use `--host 0.0.0.0` for this project's standard port-5000 workflow in the current container.

**Why:** Replit's `waitForPort` health check for artifact-managed workflows (`artifacts/<name>: web`) uses IPv6 (`::1`). The current standard workflow's container does not support Vite's IPv6 bind and fails with `EAFNOSUPPORT`, so its port-5000 command must stay on IPv4.

**How to apply:**
- For artifact-managed workflows, set the Vite CLI and config host to `::`.
- For the standard `Frontend` workflow, keep the Vite CLI host at `0.0.0.0`; `allowedHosts: true` still permits the Replit proxy.

**Confirmed working:**
- The standard `Frontend` workflow starts on port 5000 with the IPv4 bind.
