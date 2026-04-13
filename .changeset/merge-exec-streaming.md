---
"@ai-hero/sandcastle": patch
---

Merge `exec` and `execStreaming` into a single `exec` method with an optional `onLine` callback in options.

**Breaking change (pre-1.0):** The `execStreaming` method has been removed from `BindMountSandboxHandle`, `IsolatedSandboxHandle`, and `SandboxService`. Use `exec(command, { onLine: (line) => ... })` instead.

**Migration:** Replace `handle.execStreaming(cmd, onLine, { cwd })` with `handle.exec(cmd, { onLine, cwd })`.
