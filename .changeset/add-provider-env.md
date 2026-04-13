---
"@ai-hero/sandcastle": patch
---

Allow sandbox providers and agent providers to accept `env: Record<string, string>` at construction time. Provider env is merged with the `.sandcastle/.env` resolver output at launch, with provider values taking precedence. Agent and sandbox provider env must not have overlapping keys.
