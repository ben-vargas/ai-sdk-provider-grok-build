# AI SDK Provider for Grok Build

[![npm version](https://img.shields.io/npm/v/ai-sdk-provider-grok-build.svg)](https://www.npmjs.com/package/ai-sdk-provider-grok-build)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-43853d?logo=node.js&logoColor=white)
![AI SDK v7](https://img.shields.io/badge/AI%20SDK-v7-000?logo=vercel&logoColor=white)

Use the xAI Grok CLI through the Vercel AI SDK. Version 1.1 provides three deliberately different modes on one strict, redacting transport foundation:

| Provider    | Process lifetime          | Best for                                          |
| ----------- | ------------------------- | ------------------------------------------------- |
| `grokBuild` | One ACP process per call  | Existing integrations and automatic cleanup       |
| `grokAgent` | Pooled persistent ACP     | Repeated agent calls with lower startup overhead  |
| `grokExec`  | One headless process/call | Stateless generation and native structured output |

All three target Grok CLI `>=1.0.0`, pass `--no-auto-update`, expose provider metadata under the stable `"grok-build"` key, and require Node.js 22 or newer. This community package is not affiliated with xAI or Vercel.

## Install

Install and authenticate the current Grok CLI, then install this package:

```bash
npm install -g @xai-official/grok
grok login
npm install ai@^7 ai-sdk-provider-grok-build zod@^4
```

Cached CLI authentication is the default. For CI, set `apiKey` or `XAI_API_KEY`.

The provider resolves the CLI in this order:

1. `executablePath`.
2. A `@xai-official/grok` package binary resolved from `cwd`, only when the caller explicitly trusts that directory with `allowPackageBin: true`.
3. `grok` on `PATH`.
4. `npx -y @xai-official/grok@^1` only when `allowNpx: true` is explicit and the platform is not Windows.

Package discovery is disabled by default because repository-controlled `node_modules` content executes with the provider's environment, including `XAI_API_KEY`. On Windows, `.cmd` and `.bat` launchers are rejected and the `npx` fallback is disabled; use a native Grok executable on `PATH` or through `executablePath`. The first use performs a cached, bounded `grok --version` compatibility check and rejects pre-1.0 CLIs with a typed error. Grok is intentionally not an optional dependency of this package. See [binary resolution and security](docs/binary-resolution-security.md) for deployment guidance.

## Choose a mode

### `grokBuild`: compatible per-call ACP

`grokBuild` preserves the 1.0 API and tears down its ACP process after each call:

```ts
import { generateText } from "ai";
import { grokBuild } from "ai-sdk-provider-grok-build";

const result = await generateText({
  model: grokBuild("grok-4.6"),
  reasoning: "high",
  prompt: "Summarize this repository in three bullets.",
});

console.log(result.text);
```

After `session/new` or `session/load`, the provider uses ACP `session/set_config_option` to select an advertised model and reasoning effort. Precedence is call-level `providerOptions` → AI SDK `reasoning` → model/default settings → Grok default. A missing or rejected choice produces a warning or typed protocol error; it is never silently substituted.

### `grokAgent`: pooled persistent ACP

`grokAgent` reuses clients by effective process and callback configuration. Model and effort do not split the pool because Grok 1.x makes them session-scoped. Prompts, callback delivery, permission requests, and configuration changes for one session are serialized; different sessions continue concurrently.

```ts
import { generateText } from "ai";
import { createGrokAgent } from "ai-sdk-provider-grok-build";

const agent = createGrokAgent({
  defaultSettings: { cwd: process.cwd(), reasoningEffort: "medium" },
  maxClients: 8,
});

try {
  const result = await generateText({
    model: agent("grok-4.6"),
    prompt: "Inspect the entry points.",
  });
  console.log(result.text);
} finally {
  await agent.close();
}
```

`close()` stops new acquisitions, cancels active sessions, and awaits the bounded cancel → `SIGTERM` → `SIGKILL` ladder, including detached eviction and retirement work. `await agent[Symbol.asyncDispose]()` is equivalent. Calling one of them is mandatory for pooled providers, including the exported `grokAgent` singleton, because pooled child processes deliberately have no idle timer or shutdown hook. The pool defaults to eight process identities; at capacity it evicts the least-recently-used idle client and rejects a new identity with `POOL_CAPACITY_EXCEEDED` when all clients are active. Active generation leases prevent eviction between ACP requests. An unusable client is removed from lookup and replaced without interrupting its in-flight requests while terminal diagnostics are still being collected; the retired client is disposed after that bounded settlement completes.

### `grokExec`: headless and native schemas

`grokExec` spawns one headless CLI process per request. It incrementally parses Grok 1.x NDJSON (`thought`, `text`, `tool_call`, `tool_call_update`, `usage`, and `end`) and requires a valid terminal event.

```ts
import { streamText } from "ai";
import { grokExec } from "ai-sdk-provider-grok-build";

const result = streamText({
  model: grokExec("grok-4.6", { maxTurns: 4, webSearch: false }),
  prompt: "Inspect package.json and explain the scripts.",
});

for await (const part of result.fullStream) {
  if (part.type === "text-delta") process.stdout.write(part.text);
  if (part.type === "tool-call") console.log(part.toolName, part.input);
}
```

Every ordinary invocation passes `--permission-mode` explicitly, so ambient user or repository settings cannot silently substitute another mode. `grokExec` defaults to `"dontAsk"` because its child has no interactive input channel; ACP defaults to `"default"` because it can answer permission requests. `alwaysApprove` and `dangerouslySkipPermissions` must be explicit; dangerous bypass supersedes the ordinary permission-mode and approval flags.

## Structured output

AI SDK 7 structured generation uses `generateText` or `streamText` with `Output.object()`. `grokExec` passes the original JSON Schema unchanged to `--json-schema`, including `$ref`, `$defs`, formats, and validators:

```ts
import { generateText, Output } from "ai";
import { z } from "zod";
import { grokExec } from "ai-sdk-provider-grok-build";

const result = await generateText({
  model: grokExec("grok-4.6"),
  output: Output.object({
    schema: z.object({
      title: z.string(),
      risks: z.array(z.string()),
    }),
  }),
  prompt: "Return a release-risk summary.",
});

console.log(result.output);
```

Grok schema mode itself is non-streaming, so `streamText` receives one final JSON text payload. Schema-less JSON uses prompt guidance and emits a compatibility warning; it is not described as constrained decoding. Deprecated AI SDK `generateObject` remains compatible but is not used in current examples.

## Settings

Shared process settings are available in every mode:

| Setting                   | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `executablePath`          | Explicit Grok binary                                       |
| `allowPackageBin`         | Trust package-bin discovery rooted at `cwd`; default false |
| `allowNpx`                | Opt in to the final resolver fallback                      |
| `cwd`, `env`              | Child working directory and environment                    |
| `apiKey`, `xaiApiBaseUrl` | Populate `XAI_API_KEY` and `XAI_API_BASE_URL`              |
| `logger`, `verbose`       | Diagnostics (`logger: false` disables them)                |
| `timeouts`                | ACP request, prompt, terminate, and kill bounds            |
| `maxOutputBytes`          | JSON-mode output ceiling; defaults to 16 MiB               |
| `defaultModel`            | Model used when the provider is called without an argument |

ACP settings additionally include `authMethod`, `reasoningEffort`, `mcpServers`, `includeRawChunks`, `permissionMode`, `alwaysApprove`, `dangerouslySkipPermissions`, `onPermissionRequest`, and filesystem handlers.

`createGrokAgent` also accepts `maxClients`, a positive integer that defaults to `8`. ACP response validation happens before initialization or session state is cached. Select configuration options may be flat or grouped; boolean and future option kinds are retained without being mistaken for model selectors.

Exec settings additionally include:

- `reasoningEffort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`;
- all six Grok permission modes: `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, and `plan`;
- `sandbox`, `allowRules`, `denyRules`, `allowedTools`, and `disallowedTools`;
- `maxTurns`, `webSearch: false`, `systemPromptOverride`, `appendRules`, `noPlan`, and `noSubagents`;
- `alwaysApprove` and `dangerouslySkipPermissions`.

Settings use strict Zod schemas. Unknown keys and invalid session combinations fail before spawning.

## Call-level options

All provider options use the exact key `"grok-build"`:

```ts
const result = await generateText({
  model: grokAgent("grok-4.6"),
  prompt: "Continue the audit.",
  providerOptions: {
    "grok-build": {
      reasoningEffort: "low",
      session: { id: previousSessionId },
      includeExtensionEvents: true,
    },
  },
});
```

ACP options include `model`, `reasoningEffort`, `session`, `permissionMode`, `mcpServers`, `maxTurns`, `includeExtensionEvents`, `alwaysApprove`, and `dangerouslySkipPermissions`.

Call-level permission booleans use explicit precedence, so `dangerouslySkipPermissions: false` disables only a provider-level dangerous bypass for that call. It does not reset an independently configured `permissionMode` or `alwaysApprove` value.

Exec options override its flag settings and session controls. `session.resume` and `session.continue` are mutually exclusive; `session.fork` requires one of them; `session.id` creates a new ID or names a fork:

```ts
const resumed = grokExec("grok-4.6", {
  session: { resume: previousSessionId, fork: true, id: newSessionId },
});
```

These map to `--resume`, `--continue`, `--fork-session`, and `--session-id`.

## Sessions, metadata, and usage

Both generated and streamed finishes expose request-local metadata:

```ts
const metadata = result.finalStep.providerMetadata?.["grok-build"];
console.log(metadata?.sessionId, metadata?.requestId);
```

ACP metadata can also include `promptId`, resolved model, effort, advertised model catalog, agent version, and redacted per-model usage. ACP accounting retains Grok's total-input semantics. Headless metadata includes its session ID, request ID, stop reason, resolved model, and redacted model usage. Grok/Anthropic-style headless records treat `input_tokens` as non-cached input and add cache-read/cache-creation components for the total. OpenAI-style records treat `input_tokens` or `prompt_tokens` as the total and subtract `cached_tokens` for no-cache input when valid. Terminal `end` usage is authoritative.

## Tools, permissions, and cancellation

Grok-native shell, filesystem, search, fetch, and MCP tools are provider-executed. They are surfaced as dynamic AI SDK `tool-call` and `tool-result` parts with real correlated names; applications must not execute them again. AI SDK-defined tools cannot be registered through ACP or the headless CLI and produce warnings.

ACP permission requests fail closed when no callback is installed. Only explicit `alwaysApprove` or `bypassPermissions`/dangerous bypass selects an allow option automatically. Use `cwd`, sandbox policy, allow/deny rules, and an isolated environment as your primary side-effect boundary.

Abort and stream cancellation preserve the caller's reason, cancel the ACP session or terminate the headless child, and use bounded escalation so orphan processes are not left behind. Tool side effects already started by Grok cannot be rolled back.

Automatic retries are limited to failures proven to happen before prompt dispatch. ACP timeouts/process exits and generic JSON-RPC internal error `-32603` are retryable only before dispatch. Authentication-required `-32000` and credential-specific `-32603` responses (for example, token-refresh failures), missing-resource `-32002`, cancellation, prompt timeouts, missing terminal records, non-zero headless exits, explicit headless error events, and all post-dispatch failures are non-retryable because a tool side effect may already have occurred.

## Prompt and media behavior

Roles and completed tool history are serialized as an explicit transcript. Textual files are inlined. Images, audio, binary files, custom parts, reasoning files, and private reasoning history are warned about and omitted; this package intentionally has no unused image-conversion layer.

Raw ACP/headless events, tool inputs/outputs, usage, model catalogs, and extension metadata pass through credential redaction. Unknown benign events are preserved as redacted raw parts with one warning. Metadata-only updates after a tool's final result are ignored semantically; pending or in-progress regressions still fail. Unknown events that could affect completion, usage, permissions, or tool correlation fail with a protocol error.

## Live verification

`npm run test:live` builds the package and runs an opt-in smoke test against the installed, authenticated Grok CLI. It verifies the CLI version, native usage invariants, denial of a marker-writing shell command under implicit headless `dontAsk`, and a pooled ACP generation in a temporary directory. It is intentionally excluded from CI because it consumes account usage and may create ordinary Grok session metadata.

## More examples and limitations

See [examples](examples/README.md), [session continuity](docs/session-continuity.md), [known limitations](LIMITATIONS.md), and the fixture-backed [gap analysis](GAP_ANALYSIS.md).

The root export includes `AcpClient` and its protocol/process types as a supported low-level surface. Its idempotent `acquireLease()` method keeps a client non-idle across a multi-request lifecycle and is intended primarily for pooled integrations. Consumer update and extension callbacks are observational: their exceptions are isolated, but a request preserves update-before-result ordering by waiting for callbacks already queued for its session. The request's timeout, abort signal, disposal, and process-failure handling remain active during that wait, so callback flushing cannot make settlement unbounded. When constructing `GrokBuildLanguageModel` with a custom `clientFactory`, generated ACP `args` are omitted so the wrapper retains ownership of its command line. Such a factory must translate process-level permission settings into its own command line: client-side `permissionMode` and `alwaysApprove` control ACP permission responses but do not put the child CLI into plan mode. Real-CLI factories can opt into the built-in command resolution, version validation, and generated arguments with `validateCli: true`; built-in providers enable that path automatically. `embeddingModel()` and `imageModel()` throw `NoSuchModelError`; other non-language provider factories are not implemented.

## License

MIT. See [LICENSE](LICENSE).
