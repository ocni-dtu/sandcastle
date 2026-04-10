---
"@ai-hero/sandcastle": patch
---

**BREAKING:** Make `sandbox` a required option on `run()` and `createSandbox()`. Remove `imageName` from top-level `RunOptions` and `CreateSandboxOptions` — image configuration now lives inside the sandbox provider (e.g. `docker({ imageName })`). The `docker()` factory is exported exclusively from `@ai-hero/sandcastle/sandboxes/docker`. Add pluggable sandbox provider abstraction with bind-mount and isolated provider types, `createBindMountSandboxProvider` and `createIsolatedSandboxProvider` factories, filesystem-based test isolated provider, and git bundle sync-in for isolated providers.
