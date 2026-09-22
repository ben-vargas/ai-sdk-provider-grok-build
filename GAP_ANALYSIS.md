# AI SDK v7 ↔ Grok CLI 1.x gap analysis

This analysis reflects package 1.1, sanitized fixtures under `fixtures/`, and live verification against Grok CLI 1.0.34. Normal CI never invokes Grok generation.

Status terms:

- **Mapped**: native behavior is translated without semantic fallback.
- **Partial**: useful behavior exists with a documented boundary.
- **Emulated**: implemented through prompt/transcript text.
- **Unsupported**: rejected or ignored with a typed warning.

| Capability | `grokBuild` / `grokAgent` ACP | `grokExec` headless | Status |
| ---------- | ------------------------------ | ------------------- | ------ |
| Text and reasoning streaming | ACP message/thought chunks | `text`/`thought` NDJSON | **Mapped** |
| Provider-executed tools | Correlated ACP calls/updates | Correlated `tool_call`/`tool_call_update` | **Mapped** |
| Finish reason | Required prompt result | Required terminal `end` | **Mapped** |
| Usage | Prompt result metadata | Terminal `end` is authoritative | **Mapped** |
| Session IDs | New/load ACP session | Request-local terminal metadata | **Mapped** |
| Model/effort | `session/set_config_option`, validated choices | CLI flags | **Mapped** |
| Native JSON Schema | No ACP schema channel | Unchanged `--json-schema` | ACP **emulated**, exec **mapped** |
| Schema-less JSON | Prompt instruction | Prompt instruction | **Emulated** with warning |
| MCP | Typed stdio/http/sse session config | CLI/runtime configuration | ACP **mapped** |
| AI SDK function tools | No registration/result channel | No registration/result channel | **Unsupported** |
| AI SDK sampling controls | No fields | No current flags | **Unsupported** |
| Maximum turns | Stop reason only | `--max-turns` | ACP **partial**, exec **mapped** |
| Resume | `session/load` | `--resume` / `--continue` | **Mapped** |
| Fork/new named ID | No ACP fork operation | `--fork-session` / `--session-id` | ACP **unsupported**, exec **mapped** |
| Cancellation | `session/cancel` plus bounded teardown | bounded TERM/KILL teardown | **Mapped** |
| Images/audio/binary | Advertised unsupported or omitted | Omitted from transcript | **Unsupported** |
| Text files | ACP embedded text resources | Explicit inlined transcript | **Mapped** |
| Arbitrary prior roles | Labeled transcript | Labeled transcript | **Emulated** |
| Raw events | Redacted raw parts | Redacted raw parts | **Mapped** |

## Transport evidence

ACP fixtures cover text, tool use, cancellation, permission routing, restart/load replay, and Grok 1.x config options. Headless fixtures/tests cover fragmented lines, text/reasoning, tools, structured output, malformed output, missing terminal events, process exit, output bounds, and cancellation.

Grok CLI 1.0.34 established that:

- model and effort are session config options and can be selected with `session/set_config_option`;
- streaming JSON includes `thought`, `text`, `tool_call`, `tool_call_update`, `usage`, and terminal `end` records;
- `$ref`/`$defs` schemas work in `--json-schema` mode and must not be rewritten;
- current resume/fork/session-ID and permission flag names match the package's validated schemas.

## Generation-neutral boundary

ACP and headless records normalize into text, reasoning, tool, raw, usage, finish, and metadata shapes before the thin AI SDK v7 adapter. Transport/pooling/normalization code does not depend on V4 prompt types, preserving a practical path to a thin V3 adapter on the `ai-sdk-v6` maintenance branch.

See [known limitations](LIMITATIONS.md) for operational impact and workarounds.
