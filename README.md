# AI SDK Provider for Grok Build

[![npm version](https://img.shields.io/npm/v/ai-sdk-provider-grok-build.svg)](https://www.npmjs.com/package/ai-sdk-provider-grok-build)
[![npm downloads](https://img.shields.io/npm/dm/ai-sdk-provider-grok-build.svg)](https://www.npmjs.com/package/ai-sdk-provider-grok-build)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-43853d?logo=node.js&logoColor=white)
![AI SDK v6](https://img.shields.io/badge/AI%20SDK-v6-000?logo=vercel&logoColor=white)
![Modules: ESM + CJS](https://img.shields.io/badge/modules-ESM%20%2B%20CJS-3178c6)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/ben-vargas/ai-sdk-provider-grok-build/issues)

Use xAI's Grok Build CLI through the [Vercel AI SDK](https://ai-sdk.dev/). The provider starts `grok --no-auto-update agent stdio` and translates Agent Client Protocol (ACP) JSON-RPC messages into AI SDK v6 `LanguageModelV3` events.

The default authentication path reuses your Grok CLI login, including its renewable cached OAuth/session credentials. Log in once with `grok`, then it just works—no separate API key is required. `XAI_API_KEY` remains available as an alternative for CI and other non-interactive environments.

> **Community project:** This package is not affiliated with, maintained by, or endorsed by xAI or Vercel. Grok, Grok Build, and xAI are trademarks of their respective owners.

## Version compatibility

| Git branch  | AI SDK | Provider interfaces              | npm tag     | Status             |
| ----------- | ------ | -------------------------------- | ----------- | ------------------ |
| `main`      | v7     | `LanguageModelV4` / `ProviderV4` | `latest`    | Active line        |
| `ai-sdk-v6` | v6     | `LanguageModelV3` / `ProviderV3` | `ai-sdk-v6` | Compatibility line |

The ACP client, process lifecycle, protocol types, session handling, and normalized event mapping are independent of the AI SDK adapter generation. This branch changes the adapter and package surface, not the transport.

## Installation

### 1. Install Grok Build and log in once

macOS or Linux:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

The CLI also has an npm distribution:

```bash
npm install -g @xai-official/grok
grok login
```

For an SSH host without a browser, use `grok login --device-auth`.

### 2. Install the provider

```bash
npm install ai@^6 ai-sdk-provider-grok-build@ai-sdk-v6 zod@^4
```

Requirements: Node.js 18 or newer and AI SDK 6. Zod 3 and 4 are supported peer ranges. The package provides both ESM and CommonJS entry points.

## Quick start: cached Grok login

After `grok login`, no auth configuration is needed:

```typescript
import { generateText } from "ai";
import { grokBuild } from "ai-sdk-provider-grok-build";

const { text } = await generateText({
  model: grokBuild(),
  prompt: "Summarize this repository in three bullets.",
});

console.log(text);
```

`grokBuild()` uses the model currently resolved by Grok. A model ID can be supplied, but Grok Build 0.2.99 does not expose a fixture-verified ACP model setter; if the runtime resolves a different model, the provider keeps it and emits a compatibility warning.

### Streaming

```typescript
import { streamText } from "ai";
import { grokBuild } from "ai-sdk-provider-grok-build";

const result = streamText({
  model: grokBuild(),
  prompt: "Inspect the project and explain its entry points.",
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

### API key alternative

Cached CLI authentication is the default. To use an xAI API key instead, opt in explicitly:

```typescript
import { createGrokBuild } from "ai-sdk-provider-grok-build";

const grokBuildWithApiKey = createGrokBuild({
  authMethod: "api_key",
  env: { XAI_API_KEY: process.env.XAI_API_KEY },
});

const model = grokBuildWithApiKey();
```

When `authMethod` is `api_key`, `XAI_API_KEY` must exist in `settings.env` or the process environment.

## Why ACP is the transport

ACP is Grok Build's integration protocol: JSON-RPC over the stdin/stdout of `grok agent stdio`. It provides the initialization and authentication handshake, session creation/loading, incremental assistant and reasoning chunks, tool lifecycle updates, completion metadata, usage, cancellation, permissions, MCP configuration, and extension notifications.

The provider does **not** use `grok -p --output-format streaming-json`. Captured headless streams contain thought, text, and end records, but no tool-call or tool-result lifecycle. Using that format would hide Grok's agent activity and lose the protocol surface needed for an AI SDK provider.

Each model call currently owns one ACP child process. A new session is created unless an explicit session ID is loaded, and the process is disposed when the call finishes or fails.

## Provider API

```typescript
import { createGrokBuild, grokBuild } from "ai-sdk-provider-grok-build";

grokBuild(); // callable provider
grokBuild.languageModel(); // equivalent
grokBuild.chat(); // equivalent alias

const configured = createGrokBuild({ cwd: "/path/to/project" });
configured();
```

The provider exposes language models only. `embeddingModel()` and `imageModel()` throw `NoSuchModelError`; transcription, speech, reranking, files, and skills factories are not exposed.

The root entry also exports `AcpClient`, `AcpClientOptions`, `AcpClientFactory`, and the related client handler/spawn types as a supported low-level integration surface. `AcpClient.dispose()` is asynchronous and completes after bounded cancellation and process termination.

## Provider settings

Pass settings to `createGrokBuild(settings)`, or as the second argument to a provider model call. Per-model settings merge over provider defaults; `env` and `timeouts` are shallow-merged.

| Setting              | Type                               | Default                     | Behavior                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executablePath`     | `string`                           | `grok` from `PATH`          | Grok Build executable to spawn.                                                                                                                                                                                                      |
| `cwd`                | `string`                           | `process.cwd()`             | Process working directory and ACP session working directory.                                                                                                                                                                         |
| `env`                | `NodeJS.ProcessEnv`                | Current process environment | Environment additions/overrides passed to Grok.                                                                                                                                                                                      |
| `authMethod`         | `string`                           | `'cached_token'`            | Authentication route. Existing cached CLI state is tried first; after an authentication failure, ACP authenticates the advertised method and retries the session once. The special `'api_key'` value supplies `XAI_API_KEY` to Grok. |
| `permissionMode`     | `'default' \| 'bypassPermissions'` | `'default'`                 | In bypass mode, select `allow_once` (or `allow_always`) when Grok sends a permission request. Default mode rejects an unhandled live request rather than hanging.                                                                    |
| `defaultModel`       | `string`                           | `'default'`                 | Model ID requested when no ID is passed to the provider. Selection is advisory until Grok exposes a verified ACP setter.                                                                                                             |
| `mcpServers`         | `AcpMcpServer[]`                   | `[]`                        | MCP servers sent with every `session/new` or `session/load`. Per-call servers override same-named defaults.                                                                                                                          |
| `timeouts.requestMs` | positive integer                   | `30000`                     | Timeout for ordinary ACP JSON-RPC requests.                                                                                                                                                                                          |
| `timeouts.promptMs`  | positive integer                   | none                        | Timeout for `session/prompt`.                                                                                                                                                                                                        |
| `logger`             | logger object                      | no-op logger                | Object implementing `debug`, `info`, `warn`, and `error`. Current provider diagnostics use `debug`.                                                                                                                                  |
| `includeRawChunks`   | `boolean`                          | `false`                     | Emit redacted standard ACP updates and xAI extension notifications as AI SDK `raw` stream parts. Unknown optional updates are preserved as redacted raw data even when this is false.                                                |

Settings are strict and validated with Zod; unknown keys and invalid values throw before a call starts.

### MCP server shapes

```typescript
const provider = createGrokBuild({
  mcpServers: [
    {
      name: "local-tools",
      command: "node",
      args: ["./mcp-server.mjs"],
      env: [{ name: "MODE", value: "read-only" }],
    },
    {
      type: "http",
      name: "remote-tools",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer ..." }],
    },
  ],
});
```

Stdio servers require `name`, `command`, `args`, and `env`; `type: 'stdio'` is optional. HTTP and SSE servers require `type`, `name`, `url`, and `headers`.

## Call-level `providerOptions`

Put call overrides under the exact provider key `'grok-build'`:

```typescript
const result = await generateText({
  model: grokBuild(),
  prompt: "Continue the review.",
  providerOptions: {
    "grok-build": {
      session: { id: previousSessionId },
      permissionMode: "bypassPermissions",
      includeExtensionEvents: true,
    },
  },
});
```

| Option                   | Type                               | Behavior                                                                                                                |
| ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `model`                  | `string`                           | Requests a model for this call. If it differs from Grok's resolved model, the runtime value is retained with a warning. |
| `reasoningEffort`        | `'low' \| 'medium' \| 'high'`      | Requests an advertised effort. A differing current effort cannot yet be changed and produces a warning.                 |
| `session.id`             | `string`                           | Loads this ACP session instead of creating one. Mutually exclusive with `session.resume`.                               |
| `session.resume`         | `string`                           | Alias input for loading an explicit session ID. Mutually exclusive with `session.id`.                                   |
| `session.continue`       | `boolean`                          | Not implemented: warns and creates a new session unless an explicit ID is also supplied.                                |
| `session.fork`           | `boolean`                          | Not implemented: warns and creates a new session instead of loading the source ID.                                      |
| `permissionMode`         | `'default' \| 'bypassPermissions'` | Overrides the provider permission mode for this call.                                                                   |
| `mcpServers`             | `AcpMcpServer[]`                   | Merges with provider defaults by server name; call-level entries win.                                                   |
| `maxTurns`               | positive integer                   | Accepted for API stability but not enforceable through ACP; ignored with a warning.                                     |
| `includeExtensionEvents` | `boolean`                          | Emits xAI extension notifications as `raw` stream parts without also including every standard ACP update.               |

Unknown keys are rejected. Message- and part-level provider options are ignored with a compatibility warning; only call-level `providerOptions['grok-build']` are interpreted.

## Session continuity

The terminal `finish` event includes the ACP session ID at `providerMetadata['grok-build'].sessionId`. With AI SDK v6, read it from the generated result and pass it to the next call:

```typescript
const first = await generateText({
  model: grokBuild(),
  prompt: "Create a migration checklist.",
});

const sessionId = first.providerMetadata?.["grok-build"]?.sessionId;

if (typeof sessionId !== "string") {
  throw new Error("Grok Build did not return a session ID");
}

const second = await generateText({
  model: grokBuild(),
  prompt: "Continue with the next item.",
  providerOptions: {
    "grok-build": { session: { id: sessionId } },
  },
});
```

Grok advertises `session/load`, but captured fixtures do not yet prove restart replay ordering, invalid-ID behavior, cross-directory loading, or concurrent prompts. The provider emits a compatibility warning whenever it loads a session. See [Session continuity](docs/session-continuity.md) for the complete guide and constraints.

## Tool visibility and ownership

Grok's shell, filesystem, search, fetch, and MCP tools execute inside the Grok Build runtime. The provider surfaces their lifecycle as dynamic AI SDK `tool-call` and `tool-result` parts. Calls are marked `providerExecuted: true`, so your application should observe them—not execute them again.

```typescript
const result = streamText({
  model: grokBuild(),
  prompt: "List the TypeScript files and summarize the entry point.",
});

for await (const part of result.fullStream) {
  if (part.type === "tool-call") {
    console.log("Grok started:", part.toolName, part.input);
  } else if (part.type === "tool-result") {
    console.log("Grok result:", part.toolName, part.output);
  }
}
```

AI SDK function tools are a different ownership model: the application normally receives a tool call and executes it. ACP 1 has no client-defined tool registration/result-submission channel, so `tools` and non-default `toolChoice` values are ignored with typed warnings. Configure Grok-native tools or MCP servers instead.

Tool input snapshots and result updates are normalized from standard ACP notifications. Streams may contain replaceable preliminary tool results before the final result; `doGenerate` retains only the latest correlated result and always replaces it with the final result. Redacted input, output, status, title, and xAI tool metadata remain available in provider metadata. xAI extension argument deltas are not merged into the standard tool call; request extension events when that version-specific detail is needed.

## Output, usage, and metadata

- Assistant and reasoning chunks are emitted as separate AI SDK text and reasoning blocks.
- `doGenerate()` aggregates canonical content from the same ordered stream used by `doStream()`, replacing correlated preliminary tool results with the final result.
- Usage maps input, cache-read, output, and reasoning tokens when Grok supplies them. Cache-write and independent text-output counts remain unknown.
- Finish metadata uses the `'grok-build'` key and includes session/request/prompt IDs, the raw Grok stop reason, resolved model, advertised model catalog, current and supported reasoning efforts, agent version, and optional per-model usage when available.
- `responseFormat: { type: 'json' }` is prompt-engineered, not native constrained decoding. The provider emits a compatibility warning; parsing or schema validation can still fail.
- Textual file content can be mapped to ACP embedded resources. Images, audio, remote URLs, and arbitrary binary files are not supported by the captured Grok 0.2.99 ACP capabilities.

## Limitations

The largest differences from a direct HTTP model provider are:

- no AI SDK-defined tool execution;
- no native structured-output guarantee;
- no image, audio, or arbitrary binary input;
- no sampling controls, stop sequences, seed, maximum output token control, or enforceable maximum turns;
- model/reasoning mutation, session loading, cancellation ordering, and interactive permissions are not fully fixture-verified;
- fresh-session role history is serialized into prompt text rather than imported as native roles;
- no source, generated-file, reasoning-file, custom-content, embedding, or image-generation surface;
- ACP and xAI extension records can change with Grok CLI releases.

See [Known Limitations](LIMITATIONS.md) for exact behavior, warnings, impact, and workarounds.

## License

MIT. See [LICENSE](LICENSE).
