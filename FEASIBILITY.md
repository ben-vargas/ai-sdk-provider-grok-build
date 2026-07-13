# Feasibility assessment: `ai-sdk-provider-grok-build`

## Executive verdict

**FEASIBLE, initially experimental.** Grok Build exposes two viable local-agent transports: the official ACP stdio transport, `grok agent stdio`, and headless newline-delimited `streaming-json`. ACP should be the primary transport; `streaming-json` should remain an opt-in fallback until its complete event schema is captured and regression-tested. (`xai-llms.txt:119-175`; [xAI ACP documentation](https://docs.x.ai/build/cli/headless-scripting#acp))

The Code API should **not** become a third implementation mode. The documented direct Code API uses ordinary xAI Responses access—and alternatively ordinary Chat access—with `grok-4.5`; these APIs are already implemented by `@ai-sdk/xai`. That coverage does not expose the local Grok Build TUI, headless CLI, ACP, persisted sessions or agent-tool runtime. (`xai-llms.txt:1255-1259,1292-1299,1325-1377,15599-15606,23043-23129`; `packages/xai/src/xai-provider.ts:141-175,251-257`; `packages/xai/src/responses/xai-responses-language-model.ts:252-270,483-509`; `packages/xai/src/xai-chat-language-model.ts:240-261`)

The recommended product is:

1. A shared Grok Build transport/session core.
2. A native AI SDK v7 `ProviderV4`/`LanguageModelV4` compatibility provider.
3. A separate v7 `HarnessV1` adapter, documented as the preferred integration for agentic coding.
4. An `ai-sdk-v6` branch exposing `ProviderV3`/`LanguageModelV3`.
5. No duplicate REST provider.

The v7 release should ship **both** the language-model provider and `harness-grok-build`. HarnessV1 is AI SDK 7’s idiomatic, experimental adapter abstraction for stateful coding-agent runtimes, although it is not necessarily a lossless representation of every native capability. The language-model adapter preserves compatibility with `generateText`, `streamText`, existing provider registries and the v6 line. (`packages/harness/README.md:1-5`; `content/docs/03-ai-sdk-harnesses/01-overview.mdx:8-17,33-49`; `packages/provider/src/language-model/v4/language-model-v4.ts:5-60`; `packages/harness/src/v1/harness-v1-session.ts:216-279`)

## 1. Integration-option ranking

| Rank | Surface | Verdict | Streaming fidelity | Tool visibility | Usage | Sessions | Authentication | Stability |
|---:|---|---|---|---|---|---|---|---|
| 1 | `grok agent stdio` ACP | Primary | Documented incremental assistant text through `session/update` / `agent_message_chunk`. (`xai-llms.txt:143-175`) | Tool, reasoning, permission, file-change and plan-update unions remain undocumented. The installed binary contains `agent_thought_chunk`, `tool_call`, `tool_call_update` and `session/request_permission` symbols, but their complete wire shapes and behavior require live capture. (`xai-llms.txt:166-175`; command output: `strings ~/.local/bin/grok \| rg 'request_permission\|agent_thought_chunk\|tool_call_update'`) | No documented ACP usage payload; never fabricate token counts. (`xai-llms.txt:208-259`) | `session/new` returns `sessionId`; Grok persists sessions. The installed binary contains `session/load`, but ACP resume/load behavior was not reproduced. (`xai-llms.txt:237-245,864-887`; command output: `strings ~/.local/bin/grok \| rg 'session/(new\|load\|prompt\|cancel)'`) | Negotiated `xai.api_key` or `cached_token`; CLI also supports browser, device-code and token-provider authentication. (`xai-llms.txt:223-235,444-509`) | Official, version-negotiated JSON-RPC over stdin/stdout. Capability negotiation is stronger than parsing undocumented JSONL, but optional methods, ordering and cancellation behavior remain unverified. ([ACP protocol](https://github.com/agentclientprotocol/agent-client-protocol); [xAI ACP docs](https://docs.x.ai/build/cli/headless-scripting#acp)) |
| 2 | `grok -p … --output-format streaming-json` | Fallback | CLI 0.2.99 and xAI documentation identify an incremental NDJSON event stream, but successful text-event shapes and arbitrarily split pipe behavior were not captured locally. (`xai-llms.txt:104-141`; command output: `grok --version`; command output: `grok --help`) | Potentially rich, and community prior art reports reasoning/error support, but the first-party schema is unpublished. ([pi-grok-build](https://pi.dev/packages/%40ramarivera/pi-grok-build#integration-modes)) | Unknown until successful traces are collected. (`xai-llms.txt:130-141`) | CLI flags support resume, continue and fork; completed JSON includes `sessionId`. (`xai-llms.txt:302-310,871-887`) | Inherits CLI credential precedence and logged-in session state. (`xai-llms.txt:448-455`) | Brittle until fixtures cover text, reasoning, tool lifecycle, errors, completion, cancellation, ordering and partial pipe chunks. The only locally observed record was `{"type":"error","message":"…"}` after the read-only outer environment blocked mandatory session creation. (command output: `grok --no-auto-update -p ... --output-format streaming-json`) |
| 3 | Direct Code API / Responses | Do not implement | Stable SSE, including `response.output_text.delta`; Chat Completions supports usage-final chunks. (`xai-llms.txt:17256-17405,22883-22886,32416-32461`) | Rich client/server tool events, but they represent API-side inference rather than the local Grok Build runtime. (`xai-llms.txt:31859-31974,33164-33175`) | Best surface: input, cached, output, reasoning, tool, source and cost data. (`xai-llms.txt:23197-23248,33067-33089`) | `previous_response_id` continues stored Responses conversations, but it is not a local repository session. (`xai-llms.txt:23043-23129`) | Normal `XAI_API_KEY`; early access gates model availability at the account/team level. (`xai-llms.txt:10-16,19986-20052`) | Most stable protocol, but redundant with official `@ai-sdk/xai`. (`packages/xai/src/xai-provider.ts:141-175,251-257`; `packages/xai/src/responses/xai-responses-language-model.ts:252-270,483-509`; `packages/xai/src/xai-chat-language-model.ts:240-261`) |

ACP should default to a long-lived child process so request IDs, notifications and session state remain correlated. The implementation must negotiate `protocolVersion`, inspect returned capabilities, and reject unsupported operations explicitly rather than assuming all ACP agents expose the same surface. (`xai-llms.txt:208-245`; [ACP repository](https://github.com/agentclientprotocol/agent-client-protocol))

`streaming-json` should use a buffered NDJSON parser that preserves partial pipe chunks and flushes a final unterminated record, following the Codex provider’s proven framing design. (`src/exec-language-model.ts:473,1200,1258,1283`)

## 2. What this adds over `@ai-sdk/xai`

The package adds meaningful functionality only when it wraps **Grok Build as a local coding agent**:

- Local filesystem reading/writing, shell execution, editing, permissions, hooks and repository-aware execution. (`xai-llms.txt:566-595,706-758`)
- Persisted agent sessions containing prompts, responses, tool calls and file snapshots across TUI, headless and ACP surfaces. (`xai-llms.txt:864-899,1470-1473`)
- Resume, continue and fork semantics for CLI sessions. (`xai-llms.txt:302-310,871-887`)
- Local and remote MCP servers, project configuration, imported MCP definitions and `<server>__<tool>` naming. (`xai-llms.txt:761-812,1573-1601`)
- Grok-native permission modes and approval policy, including `default`, `dontAsk`, `acceptEdits`, `bypassPermissions` and `plan`. (`xai-llms.txt:568-575,1659-1666`)
- Browser/device/cached-token authentication in addition to API keys. This is a potential subscription-session advantage, not a confirmed redistribution right or billing entitlement. (`xai-llms.txt:444-509,1276-1282`)
- Model, agent-profile, reasoning-effort, sandbox, subagent, worktree and maximum-turn controls exposed by the installed CLI. (command output: `grok --help`; command output: `grok agent --help`)

The official provider already covers normal xAI Chat and Responses calls, reasoning, streaming, structured output, images, video, voice, files, server-side code execution, file search, web/X search and remote MCP. Reimplementing those calls would add maintenance without a distinct capability. (`packages/xai/src/xai-provider.ts:36-109,141-175,251-257`; `packages/xai/src/tool/index.ts:1-27`; `packages/xai/src/responses/xai-responses-language-model-options.ts:3-42`)

The distinction is therefore:

- `@ai-sdk/xai`: application calls an xAI model/API and owns the surrounding loop.
- `ai-sdk-provider-grok-build`: application delegates a repository task to a local Grok Build runtime that owns native tools, permissions and persisted agent state.
- `harness-grok-build`: exposes the principal capabilities of that runtime through HarnessV1 without forcing it into language-model semantics; some native behavior may require lossy translation or explicit capability errors. (`content/docs/03-ai-sdk-harnesses/01-overview.mdx:8-17,38-49`; `packages/harness/src/v1/harness-v1-session.ts:216-279`)

## 3. Recommended architecture

### Repository layout

```text
packages/
  grok-build-core/
    src/
      process/spawn-grok.ts
      process/ndjson-framer.ts
      protocol/acp-client.ts
      protocol/acp-types.ts
      protocol/jsonl-client.ts
      protocol/jsonl-schemas.ts
      protocol/normalized-events.ts
      sessions/session-store.ts
      sessions/session-options.ts
      auth/auth-methods.ts
      mcp/mcp-bridge.ts
      errors.ts
      version.ts

  ai-sdk-provider-grok-build/
    src/
      index.ts
      grok-build-provider.ts
      grok-build-language-model.ts
      map-prompt.ts
      map-v4-events.ts
      map-finish-reason.ts
      map-usage.ts
      settings.ts
      provider-options.ts

  harness-grok-build/
    src/
      index.ts
      grok-build-harness.ts
      grok-build-session.ts
      map-harness-events.ts
      capabilities.ts
      state.ts

examples/
  provider-stream.ts
  provider-resume.ts
  harness-repository-task.ts
  harness-mcp.ts

fixtures/
  acp/
  streaming-json/
```

The shared core should own spawning, authentication negotiation, framing, normalized events, abort handling and session state. V4, V3 and Harness adapters should map from the normalized internal event union rather than parse Grok output independently. This mirrors the reference providers’ separation of transport, settings, message mapping, errors and provider contracts. (`src/exec-language-model.ts:100-175,473-690,907-1050`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/claude-code-provider.ts:71-132`)

### Public API

```ts
const grokBuild = createGrokBuild({
  executablePath,
  transport: 'acp',           // 'acp' | 'streaming-json' | 'auto'
  cwd,
  env,
  authMethod: 'cached_token', // or 'xai.api_key'
  disableAutoUpdate: true,
  defaultModel,
  spawn,
  sessionStore,
});

const model = grokBuild('grok-build');

const harness = createGrokBuildHarness({
  executablePath,
  cwd,
  authMethod: 'cached_token',
});
```

Use provider ID and provider-options key `grok-build`. Do not call the package `xai`, because that would obscure its distinction from `@ai-sdk/xai`. The model ID should be a CLI-facing selector, not a hard-coded assertion that Grok Build always uses `grok-build-0.1`; current documentation and the installed CLI disagree about `grok-4.5`, `grok-build-0.1`, `grok-composer-2.5-fast` and aliases. (`xai-llms.txt:1327-1337,19691-19709,20352-20360`; command output: `grok --no-auto-update models`)

### Settings and provider options

Constructor settings should contain stable process-wide behavior:

- `executablePath`, `transport`, `cwd`, `env`, `spawn`.
- `authMethod`, but not serialized credential values.
- `disableAutoUpdate`, defaulting to true for automation.
- `defaultModel`, `defaultPermissionMode`, `defaultMcpServers`.
- `sessionStore`, `stderrLimit`, `timeoutMs`, `minimumCliVersion`.
- `includeRawChunks` for diagnostics.

Per-call `providerOptions['grok-build']` should contain:

```ts
interface GrokBuildProviderOptions {
  model?: string;
  reasoningEffort?: string;
  maxTurns?: number;
  permissionMode?: 'default' | 'dontAsk' | 'acceptEdits'
    | 'bypassPermissions' | 'plan';
  session?: {
    id?: string;
    resume?: string;
    continue?: boolean;
    fork?: boolean;
  };
  mcpServers?: GrokMcpServer[];
  agentProfile?: string;
  sandboxProfile?: string;
  pluginDirectories?: string[];
  allowedTools?: string[];
  includeRawChunks?: boolean;
  transport?: 'acp' | 'streaming-json';
}
```

Per-call values should override constructor defaults; structural fields such as MCP servers and plugin directories should merge predictably. This follows the Codex provider’s typed settings plus strict `providerOptions` escape hatch and the Claude provider’s layered defaults/model/call options. (`src/types-exec.ts:7`; `src/exec-language-model.ts:100-175,959`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/types.ts:786-797`)

API keys should be supplied through `XAI_API_KEY`, an injected environment object or an external token-provider command, not returned in metadata or written into session fixtures. The documented credential precedence includes configured key, configured environment key, active session token and `XAI_API_KEY`. (`xai-llms.txt:448-478`)

### Event-to-stream-part mapping

| Normalized Grok event | `LanguageModelV4` mapping | Harness mapping | Confidence |
|---|---|---|---|
| ACP `agent_message_chunk` | Open one `text-start`, emit `text-delta`, close with `text-end`. | Text delta inside current harness step. | Documented. (`xai-llms.txt:166-175`; `packages/provider/src/language-model/v4/language-model-v4-stream-part.ts:14-110`) |
| Reasoning/thinking chunk | `reasoning-start` / `reasoning-delta` / `reasoning-end`. | Native reasoning stream event. | Binary symbols suggest `agent_thought_chunk`, but the wire schema must be captured; V4 supports reasoning parts. (command output: `strings ~/.local/bin/grok \| rg 'agent_thought_chunk'`; `packages/provider/src/language-model/v4/language-model-v4-stream-part.ts:14-110`) |
| Native tool invocation | Dynamic provider-executed tool-input/tool-call parts with stable call ID. | Native tool call with `providerExecuted: true`. | Binary symbols suggest `tool_call` and `tool_call_update`, but complete shapes must be captured. Analogous mappings exist in Codex and Claude providers. (command output: `strings ~/.local/bin/grok \| rg 'tool_call_update'`; `src/exec-language-model.ts:503-647,1046`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/claude-code-language-model.ts:1576-1704`) |
| Native tool result | Dynamic provider-executed `tool-result`; failures use `isError: true`. | Native tool result. | Must be captured. V4 has no separate provider-level tool-error part. (`/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/claude-code-language-model.ts:1576-1704`) |
| Permission request | V4 approval-request only if ACP supplies a stable call/request ID and an answer channel; otherwise expose raw metadata and warn unsupported. | Harness approval event and response operation. | The binary contains `session/request_permission`, but the request/response wire contract was not reproduced. Harness has approval primitives. (command output: `strings ~/.local/bin/grok \| rg 'session/request_permission'`; `packages/harness/src/v1/harness-v1-stream-part.ts:14-123`; `content/docs/03-ai-sdk-harnesses/03-tools.mdx:94-141`) |
| File mutation | Optional custom/provider metadata in the language-model adapter. | Harness `file-change`, limited to the path-only opaque-mutation representation supported by HarnessV1. | Harness-specific but potentially lossy. (`packages/harness/src/v1/harness-v1-stream-part.ts:93-103`) |
| Step/turn boundary | Provider metadata or raw chunk. | `step-start` / `step-finish`. | Must be captured. (`packages/harness/src/v1/harness-v1-stream-part.ts:14-123`) |
| Session created/resumed | Response metadata plus `providerMetadata['grok-build'].sessionId`. | Harness native state/bootstrap data. | `session/new` and persisted IDs are documented; the binary contains `session/load`, but load/resume behavior was not reproduced. (`xai-llms.txt:237-245,864-887`; command output: `strings ~/.local/bin/grok \| rg 'session/(new\|load)'`) |
| Usage event | V4 nested input/cache/output/reasoning usage plus raw provider usage. | Reuse V4 usage. | Unsupported until observed; ACP docs do not establish it. (`packages/provider/src/language-model/v4/language-model-v4-usage.ts:6-58`) |
| `session/prompt` completion | Map `stopReason` to `stop`, `length`, `tool-calls`, `error` or `other`; emit terminal `finish`. | End current harness turn. | Completion and `stopReason` are documented; enum values are not. (`xai-llms.txt:237-259`) |
| Grok `{type:"error",message}` / JSON-RPC error / process failure | Sanitized `APICallError` or authentication-specific error; stream `error` when already streaming. | Terminal harness error. | Error record observed locally; reference normalization design is proven. (command output: Grok smoke tests; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/errors.ts:1-35,89-194`) |
| Raw protocol record | `raw` only when `includeRawChunks` is true. | Harness metadata/raw diagnostic event. | V4 explicitly supports raw chunks. (`packages/provider/src/language-model/v4/language-model-v4-call-options.ts:8-137`; `packages/provider/src/language-model/v4/language-model-v4-stream-part.ts:14-110`) |

Malformed records should produce an observable protocol-drift warning or error, not be silently discarded. The Codex provider’s silent-discard behavior is a known risk when an undocumented schema changes. (`src/exec-language-model.ts:1200-1283`)

AI SDK application-defined tools must not be advertised as automatically executable in the provider MVP. Grok-native tools are runtime-owned. Host-defined tools require either a temporary MCP bridge or a proven ACP result-submission callback; the Claude provider handles the analogous mismatch through an MCP bridge. (`/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/claude-code-language-model.ts:1810-1827`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/index.ts:107-113`)

### Harness decision

Ship `harness-grok-build` **also**, not instead:

- HarnessV1 is AI SDK 7’s adapter abstraction for stateful agent runtimes, including native sessions, sandbox state, prompt/continue, suspension, stop/destroy, runtime tools, approvals, file changes and step boundaries. Individual mappings may be lossy or unavailable. (`packages/harness/src/v1/harness-v1-session.ts:95-279`; `packages/harness/src/v1/harness-v1-stream-part.ts:14-123`)
- Grok substantially matches the abstraction through persistent sessions, ACP streaming, permission modes, filesystem/terminal capabilities, MCP and compaction. (`xai-llms.txt:118-126,151-173,214-220,237-245,564-595,761-783,871-899`)
- The provider remains useful for the broader `generateText`/`streamText` ecosystem and is necessary for a coherent v6 offering. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-60`; `content/docs/03-ai-sdk-harnesses/01-overview.mdx:15-17,48-49`)
- Harness is experimental and v7-only, so it should be a separate package/export with independent semver and capability guards. (`packages/harness/README.md:1-5`; `content/docs/03-ai-sdk-harnesses/01-overview.mdx:33-36`)
- Do not emulate unsupported Harness capabilities. Return explicit capability errors for host-tool relay, approvals, compaction, detach or resume until Grok exposes and fixtures prove the required channel, following the Codex harness precedent. (`packages/harness-codex/src/codex-harness.ts:616-1047`)
- Document known translation limits: Harness file-change events are path-only and intended for opaque mutations; Grok’s binary reports ACP filesystem deletion as unsupported; detach/stop/destroy require lifecycle translation; precise suspend-at-cursor/replay is unproven, while HarnessV1 permits lossy recomputation. (`packages/harness/src/v1/harness-v1-stream-part.ts:93-103`; `packages/harness/src/v1/harness-v1-session.ts:216-279`; command output: `strings ~/.local/bin/grok \| rg 'File deletion not supported'`)

## 4. Branch plan

### `main`: AI SDK v7

Target and test against:

```json
{
  "peerDependencies": {
    "ai": "^7.0.16",
    "zod": "^4.1.8"
  },
  "dependencies": {
    "@ai-sdk/provider": "^4.0.2",
    "@ai-sdk/provider-utils": "^5.0.5"
  },
  "engines": {
    "node": ">=22"
  }
}
```

Implement:

- `ProviderV4` and `LanguageModelV4`.
- `specificationVersion: 'v4'`.
- `doGenerate(options)` and `doStream(options)`.
- V4 prompt/content/file/provider-options/usage/stream-part types.
- ESM-only package exports.
- Separate `HarnessV1` package.
- Native V4 custom content, reasoning files, tagged file data and approval parts only where Grok supplies evidence. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-60`; `packages/provider/src/language-model/v4/language-model-v4-content.ts:11-20`; `packages/provider/package.json:4-8,26-32,44-46`)

These ranges mirror the inspected v7 reference-provider baseline: AI SDK `7.0.16`, provider `4.0.2`, provider-utils `5.0.5`, Zod 4 and Node 22. Node 22 and ESM-only output are selected release/package policies, not requirements established solely by the V4 contract. (`/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/package.json:2-4,23-33,79-105`)

AI SDK 7’s native provider/model contracts are V4, but AI SDK 7 also publicly accepts V3/V2 language models and converts them to V4 internally. Native V4 remains preferable for exposing current stream parts and avoiding compatibility conversion. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-60`; `packages/ai/src/types/language-model.ts:56-62`; `packages/ai/src/model/resolve-model.ts:29-44`; `packages/ai/src/model/as-language-model-v4.ts:8-24`)

### `ai-sdk-v6`: maintained compatibility line

Target the v6 generation with:

```json
{
  "peerDependencies": {
    "ai": "^6.0.3",
    "zod": "^3.25.76 || ^4.1.8"
  },
  "dependencies": {
    "@ai-sdk/provider": "^3.0.0",
    "@ai-sdk/provider-utils": "^4.0.1"
  },
  "engines": {
    "node": ">=18"
  }
}
```

The CI floor should additionally test the final v6 packages `ai@6.0.220`, `@ai-sdk/provider@3.0.13` and `@ai-sdk/provider-utils@4.0.36`. (`ai@6.0.220:packages/provider/package.json:1-4`; `ai@6.0.220:packages/provider-utils/package.json:1-4`)

Implement:

- `ProviderV3` and `LanguageModelV3`.
- `specificationVersion: 'v3'`.
- V3 stream, prompt, usage and provider-metadata shapes.
- Dual ESM/CommonJS output.
- No Harness package.
- Publish from the `ai-sdk-v6` dist-tag, matching the reference repositories. (`origin/ai-sdk-v6:package.json:2-4,23-40,81-110`; `origin/ai-sdk-v6:src/claude-code-provider.ts:1-24,142-155`)

### Concrete branch deltas

| Area | `main` | `ai-sdk-v6` |
|---|---|---|
| Provider contract | Native `ProviderV4`; AI SDK 7 also retains V3/V2 adapters | Native `ProviderV3` |
| Model contract | `LanguageModelV4`, `specificationVersion: 'v4'` | `LanguageModelV3`, `specificationVersion: 'v3'` |
| AI SDK | `^7.0.16` | `^6.0.3` |
| Provider packages | `@ai-sdk/provider ^4.0.2`, utilities `^5.0.5` | `@ai-sdk/provider ^3.0.0`, utilities `^4.0.1` |
| Zod peer | `^4.1.8` | `^3.25.76 \|\| ^4.1.8` |
| Runtime/package policy | Node 22+, ESM-only | Node 18+, ESM and CJS |
| Reasoning | Top-level V4 reasoning controls and V4 reasoning content | V3-compatible locations/shapes |
| Files | Tagged V4 file/provider-reference forms and canonical tool-result files | V3 file shapes |
| Provider utilities | V4 provider-defined/provider-executed factories and newer stream helpers | Older `createProviderToolFactory` family |
| Harness | `HarnessV1` package | Absent |
| Shared core | Same ACP/JSONL/session implementation | Same implementation, cherry-picked or workspace-shared |

The transport should remain structurally identical across branches; only type adapters, stream-part mapping, package metadata, chosen runtime floor and build output should diverge. That is the maintenance pattern used by both reference providers. (`docs/ai-sdk-v7/migration-v6-to-v7.md:1`; command output: `git diff --stat ai-sdk-v6..main`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/CHANGELOG.md:24-33`)

## 5. Gaps and risks

1. **Streaming JSON is undocumented beyond its framing and incremental nature.** Successful fixtures are missing for text, reasoning, tools, results, approvals, usage, completion, cancellation, ordering and arbitrarily split pipe chunks. The local smoke tests reached only the first-party error shape because the read-only outer environment blocked mandatory session creation. (`xai-llms.txt:130-141`; command output: `grok --version`; command output: `grok --help`; command output: Grok JSON and streaming-JSON smoke tests)

2. **ACP is documented only partially.** Initialize/authenticate/session-new/session-prompt and assistant text chunks are documented. The installed binary contains symbols for `session/load`, `session/cancel`, `session/request_permission`, `agent_thought_chunk`, `tool_call` and `tool_call_update`, but their complete schemas, ordering and runtime behavior were not reproduced. (`xai-llms.txt:208-259`; command output: `strings ~/.local/bin/grok \| rg 'session/(new\|load\|prompt\|cancel)\|request_permission\|agent_thought_chunk\|tool_call_update'`; [xAI ACP docs](https://docs.x.ai/build/cli/headless-scripting#acp))

3. **Authentication legality is unresolved.** Browser, device-code, cached-token and token-provider authentication exist, but the supplied evidence does not authorize third-party redistribution or automated consumption of subscription-backed credentials. Shipping should be gated on xAI terms review; API-key mode is the conservative default. (`xai-llms.txt:444-509`)

4. **Code API availability is account-dependent.** Early access controls model visibility through the normal account/team model list; there is no documented special Code API credential or distinct coding-agent protocol. (`xai-llms.txt:10-16,19986-20052,24498-24524`)

5. **Model identity is transitional.** Documentation variously identifies `grok-4.5` and `grok-build-0.1`, while the installed authenticated CLI reports `grok-composer-2.5-fast` and `grok-4.5`. Discover models and record the actual model in provider metadata rather than hard-coding an alias. (`xai-llms.txt:1327-1337,19691-19709,20352-20360`; command output: `grok --no-auto-update models`)

6. **Usage may be unavailable locally.** The REST Responses API has detailed usage and cost data, but ACP/headless usage is not documented. Return unknown/empty usage with raw metadata rather than estimating billing. (`xai-llms.txt:23197-23248,33067-33089`; `packages/provider/src/language-model/v4/language-model-v4-usage.ts:6-58`)

7. **Arbitrary AI SDK tools are not automatically bridgeable.** Runtime-native tools can be represented as provider-executed calls, but application-owned tool execution requires MCP or a proven ACP callback. The Claude provider documents the same limitation and exports an MCP bridge. (`/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/README.md:383-414`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/index.ts:107-113`)

8. **Image input is surface-dependent.** The API model documents image input, but Grok ACP prompt capabilities were not captured. Mark remote URLs and images unsupported until initialization capabilities and live prompts prove otherwise. ([grok-build-0.1 model documentation](https://docs.x.ai/developers/models/grok-build-0.1); `packages/provider/src/language-model/v4/language-model-v4-prompt.ts:99-188`)

9. **Structured output is promising but unverified.** Grok 0.2.99 exposes `--json-schema`, `--prompt-json` and output-format controls, while the Code API documents structured output; provider support still requires malformed-output, streaming and schema-validation fixtures. (command output: `grok --help`; [grok-build-0.1 model documentation](https://docs.x.ai/developers/models/grok-build-0.1))

10. **Process lifecycle may outlive an AI SDK turn.** Background commands, subagents and monitors complicate cancellation and finish ordering. The installed binary contains `session/cancel`, but behavior was not reproduced. Abort should first use a negotiated cancellation method when available, then bounded graceful termination, then process kill and cleanup. (`xai-llms.txt:143-175`; command output: `strings ~/.local/bin/grok \| rg 'session/cancel'`; `src/exec-language-model.ts:690,1116-1131`)

11. **CLI protocol drift is likely.** The installed version is `0.2.99`, machine-readable compatibility guarantees are absent, and community reports identify prior ACP regressions. Detect the version, negotiate ACP capabilities, retain raw fixtures and fail clearly on unknown required events. (command output: `grok --version`; [community compatibility reporting](https://www.grokbit.ai/))

12. **Harness itself is experimental and potentially lossy.** `HarnessV1` may change across AI SDK 7 releases and does not guarantee a lossless representation of every native runtime feature. Isolate it from the stable transport and provider packages. (`packages/harness/README.md:1-5`; `content/docs/03-ai-sdk-harnesses/01-overview.mdx:33-36`; `packages/harness/src/v1/harness-v1-stream-part.ts:93-103`; `packages/harness/src/v1/harness-v1-session.ts:216-279`)

The analogous reference-provider policy should be copied: explicitly document ignored sampling controls, partial media support, non-automatic AI SDK tools, session limitations, structured-output restrictions and non-incremental fallbacks instead of implying full language-model or Harness parity. (`LIMITATIONS.md:5,89,124,135`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/README.md:286-288,697-707`)

## 6. Ordered next steps

1. **Resolve terms and authentication policy.** Determine whether third-party libraries may launch Grok using cached browser/device credentials; until confirmed, document `XAI_API_KEY` as the supported automation mode and cached-token auth as experimental. (`xai-llms.txt:223-235,444-509`)

2. **Capture ACP initialization outside the restrictive outer sandbox.** Record the exact `initialize` result, negotiated protocol version, auth methods, capabilities and filesystem/terminal requests from Grok 0.2.99. ([xAI ACP docs](https://docs.x.ai/build/cli/headless-scripting#acp))

3. **Capture successful redacted traces for both transports.** Include trivial text, multiline text, reasoning, shell tool, file edit, failed command, MCP call, permission denial, maximum-turn stop, invalid model, authentication failure and abort. The current local tests captured only pre-inference `FS_PERMISSION_DENIED`. (command output: Grok smoke tests)

4. **Probe session semantics.** Test new, explicit ID, load/resume, continue, fork, restart after process exit, cross-CWD behavior and concurrent prompts. CLI session persistence and flags are documented, and the binary contains `session/load`, but ACP load behavior was not reproduced. (`xai-llms.txt:302-310,864-887`; command output: `strings ~/.local/bin/grok \| rg 'session/load'`)

5. **Probe completion and cancellation ordering.** Establish whether the `session/prompt` response arrives before or after the last notification, identify the full `stopReason` enum and verify the binary-indicated `session/cancel` method. (`xai-llms.txt:237-259`; command output: `strings ~/.local/bin/grok \| rg 'session/cancel'`)

6. **Probe capability gaps.** Test image parts, JSON Schema, usage/cost, reasoning, tool input deltas, tool errors, approvals, file changes, subagents and background commands. Advertise only independently observed features. (`packages/provider/src/language-model/v4/language-model-v4-call-options.ts:8-137`)

7. **Create a versioned fixture corpus and schema guards.** Redact prompts, paths and credentials; validate known records; preserve unknown optional events as raw chunks; fail on unknown events that affect completion or tool ownership.

8. **Implement `grok-build-core` with ACP first.** Use JSON-RPC request correlation, separate stderr diagnostics, capability negotiation, abort propagation and bounded process cleanup. (`xai-llms.txt:143-164`)

9. **Add `streaming-json` behind `transport: 'streaming-json'`.** Do not enable automatic fallback after a turn starts, because replay could duplicate tool execution or file edits. Use fallback only during transport startup/negotiation.

10. **Implement the v7 `LanguageModelV4` adapter.** Start with text, errors, session metadata and finish state; add tool, usage, reasoning and structured-output mappings only as fixtures prove them. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-60`)

11. **Implement `HarnessV1` on the same core.** Make it the primary README path for repository agents; explicitly reject unimplemented or unproven approval, host-tool, compaction, detach, resume and precise-suspension capabilities. (`packages/harness/src/v1/harness-v1.ts:8-93`; `packages/harness/src/v1/harness-v1-session.ts:95-279`)

12. **Create `ai-sdk-v6` after the transport stabilizes.** Port only the provider/type adapter to `ProviderV3`/`LanguageModelV3`; keep the fixture suite and normalized core behavior aligned. (`packages/provider/src/language-model/v3/language-model-v3.ts:5-60`)

13. **Add compatibility CI.** Test minimum and current Grok CLI versions, cached-token and API-key initialization where permitted, Node 22/v7, Node 18/v6, ESM/CJS branch packaging, aborts, split-pipe framing and unknown-event behavior. Reference providers use Vitest, typecheck, lint and protocol-drift validation. (`vitest.config.ts:3`; `scripts/sync-protocol-types.sh:1`; `/Users/ben/projects/ben-vargas/ai-sdk-provider-claude-code/src/options-coverage.test.ts:161`)

14. **Publish with an explicit experimental matrix.** Use `latest` for v7, `ai-sdk-v6` for v6, and document ACP as primary, JSONL as fallback, REST as delegated to `@ai-sdk/xai`, plus every unsupported or lossy capability.

## Load-bearing claims

- **Grok Build has an official machine-readable ACP stdio transport—not a network endpoint—that documents incremental assistant text through `session/update` notifications containing `agent_message_chunk` updates.** This makes a real streaming adapter feasible; a skeptic can run `grok agent stdio` and reproduce the documented `initialize` → `authenticate` → `session/new` → `session/prompt` sequence. The installed stable CLI is `grok 0.2.99 (b1b49ccb71a7)` and exposes `grok agent stdio`, although an authenticated exchange was not reproduced during the restricted verification. (`xai-llms.txt:143-175,208-259`; command output: `grok --version`; command output: `grok agent --help`; command output: `grok agent stdio --help`; [xAI ACP docs](https://docs.x.ai/build/cli/headless-scripting#acp))

- **Grok Build CLI 0.2.99 documents headless `--output-format streaming-json` as an incremental newline-delimited JSON event stream, but neither its CLI help nor the supplied xAI documentation publishes a complete event schema.** The transport should remain experimental until traces test text, reasoning, tool lifecycle, errors, completion, cancellation, ordering and arbitrarily split pipe chunks. (`xai-llms.txt:104-141`; command output: `grok --version`; command output: `grok --help`; command output: `strings /Users/ben/.grok/bin/grok`)

- **Grok Build comprises a local, stateful coding-agent runtime as well as API-accessible coding-model branding.** The CLI runtime—not merely the underlying API model—provides the distinctive filesystem, shell, permission, hook, MCP and persisted-session behavior. (`xai-llms.txt:10-16,566-595,706-812,864-909,1325-1378`; command output: `grok --help`; command output: `grok mcp --help`; command output: `grok agent --help`; command output: `grok inspect --json`)

- **The documented direct Code API surface uses ordinary xAI Responses access—and alternatively ordinary Chat access—with `grok-4.5`, and is already covered by `@ai-sdk/xai`; that coverage does not expose the local Grok Build TUI, headless CLI, ACP, session or agent-tool runtime.** This is why a duplicate REST mode is rejected. (`xai-llms.txt:1255-1259,1292-1299,1325-1377,15599-15606,23043-23129`; `packages/xai/src/xai-provider.ts:141-175,251-257`; `packages/xai/src/responses/xai-responses-language-model.ts:252-270,483-509`; `packages/xai/src/xai-chat-language-model.ts:240-261`; `packages/xai/src/responses/xai-responses-language-model-options.ts:3-8`)

- **AI SDK 7’s native provider and language-model contracts are `ProviderV4` and `LanguageModelV4`, while AI SDK 6 providers natively target `ProviderV3` and `LanguageModelV3`; AI SDK 7 nevertheless retains compatibility adapters for V3 and V2 models/providers.** This supports separate native v7/V4 and v6/V3 branches without implying that AI SDK 7 rejects older model contracts. Runtime floors and package output formats remain separate release policies. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-12`; `packages/provider/src/provider/v4/provider-v4.ts:10-26`; `packages/ai/src/types/language-model.ts:56-62`; `packages/ai/src/model/resolve-model.ts:29-44`; `packages/ai/src/model/as-language-model-v4.ts:8-24`; command output: `git show ai-sdk-v6:src/app-server/language-model.ts`; command output: `git show ai-sdk-v6:src/app-server/provider.ts`)

- **HarnessV1 is AI SDK 7’s idiomatic, experimental adapter abstraction for stateful coding-agent runtimes. It normalizes their principal runtime capabilities, but it is not necessarily a lossless or universally complete representation of every native feature.** This justifies shipping a v7 harness alongside, rather than replacing, the compatibility provider. (`content/docs/03-ai-sdk-harnesses/01-overview.mdx:8-17,33-49`; `packages/harness/src/v1/harness-v1.ts:8-25,88-93`; `packages/harness/src/v1/harness-v1-session.ts:95-279`; `packages/harness/src/v1/harness-v1-stream-part.ts:93-103`; `xai-llms.txt:118-126,151-173,214-220,237-245,564-595,761-783,871-899`)

## Verification

| Claim | Verdict | Confidence | Verification result |
|---|---|---|---|
| Official ACP transport with incremental text | Corrected, not refuted | High | Official documentation establishes JSON-RPC over stdin/stdout and incremental `agent_message_chunk` updates. “Endpoint” was corrected to “ACP stdio transport.” The installed CLI exposes the command, but an authenticated exchange was not reproduced. (`xai-llms.txt:143-172,208-245`; command output: `grok --version`; command output: `grok agent stdio --help`) |
| Headless newline-delimited `streaming-json` with unpublished complete schema | Confirmed, not refuted | High | CLI 0.2.99 and supplied documentation identify incremental NDJSON, but no first-party complete event union, ordering contract or successful trace corpus was found. (`xai-llms.txt:130-151`; command output: `grok --help`; command output: `strings /Users/ben/.grok/bin/grok`) |
| Stateful local coding runtime rather than merely an API model | Corrected, not refuted | High | Filesystem, shell, permissions, hooks, MCP and persisted sessions are documented and exposed by the CLI. Wording was corrected to distinguish the local runtime from the related API-accessible coding model. (`xai-llms.txt:566-595,706-812,864-909,1325-1378`; command output: `grok --help`; command output: `grok inspect --json`) |
| Code API uses ordinary Responses/Chat access already covered by `@ai-sdk/xai` | Corrected, not refuted | High | xAI documents `grok-4.5` through ordinary Responses and shows `xai.responses('grok-4.5')`; the official provider implements `/responses` and `/chat/completions`. Coverage does not include the local agent runtime. (`xai-llms.txt:1325-1377`; `packages/xai/src/xai-provider.ts:141-175,251-257`; `packages/xai/src/responses/xai-responses-language-model.ts:252-270,483-509`; `packages/xai/src/xai-chat-language-model.ts:240-261`) |
| AI SDK 7 native V4 versus AI SDK 6 native V3 | Corrected, not refuted | High | Native generations are V4 and V3 respectively, but AI SDK 7 also adapts V3/V2 models. Node floors and module formats are package-policy choices rather than consequences of contract generation alone. (`packages/provider/src/language-model/v4/language-model-v4.ts:5-12`; `packages/provider/src/provider/v4/provider-v4.ts:10-26`; `packages/ai/src/types/language-model.ts:56-62`; `packages/ai/src/model/as-language-model-v4.ts:8-24`; command output: `git show ai-sdk-v6:src/app-server/provider.ts`) |
| Harness as the idiomatic v7 stateful-runtime abstraction | Corrected, not refuted | High | HarnessV1 is the intended experimental runtime-adapter abstraction and Grok maps substantially to it, but file-change, lifecycle and suspension semantics can be lossy or require adapter-specific translation. (`content/docs/03-ai-sdk-harnesses/01-overview.mdx:8-17,33-49`; `packages/harness/src/v1/harness-v1-session.ts:216-279`; `packages/harness/src/v1/harness-v1-stream-part.ts:93-103`; `xai-llms.txt:118-126,151-173,564-595,761-783,871-899`) |
