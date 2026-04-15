---
"@ai-hero/sandcastle": patch
---

Fix Podman integration for rootless mode: add `--userns=keep-id` flag (configurable via `userns` option), pre-flight image existence check, Podman Machine detection on macOS/Windows, and 5s timeout on signal handler cleanup.
