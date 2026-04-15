---
"@ai-hero/sandcastle": patch
---

Add no-sandbox provider for interactive mode. `noSandbox()` runs the agent directly on the host with no container isolation — only accepted by `interactive()`, not `run()` or `createSandbox()`. The agent does not receive `--dangerously-skip-permissions`, so the user manages permissions themselves. Import from `@ai-hero/sandcastle/sandboxes/no-sandbox`.
