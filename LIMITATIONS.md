# Known Limitations

This document covers the `main` branch and its AI SDK v7 `LanguageModelV4` / `ProviderV4` implementation. The provider uses Grok Build ACP over `grok agent stdio`; headless `streaming-json` is not a fallback transport.

## Tool ownership

### AI SDK-defined tools are not executed

ACP 1 has no channel for registering an AI SDK function tool and returning its application-produced result. Supplying `tools` produces an `unsupported` warning and the definitions are not sent to Grok. Non-default `toolChoice` values are also ignored with a warning.

Grok can still execute its own shell, filesystem, search, fetch, and MCP tools. Those calls and results are emitted as dynamic, `providerExecuted: true` AI SDK parts. Applications must not execute them a second time.

**Workaround:** configure a native Grok tool or expose the capability through an MCP server passed in `mcpServers`. A future SDK-to-MCP bridge would require different trust, lifecycle, and error semantics and is not included.

### Tool streaming depends on ACP and xAI extensions

Standard ACP tool-call and tool-result updates are mapped. Preliminary results may be emitted before the final result. The standard `tool_call` input snapshot becomes the AI SDK tool input. Version-specific xAI argument-delta notifications are available only as optional raw extension events; the provider does not merge them into the standard tool call.

Raw byte arrays, terminal handles, and diffs are normalized into JSON/text where possible and retained in provider metadata. They are not guaranteed to correspond one-for-one with user-visible terminal output.

## Structured output

Grok Build ACP has no output-schema or JSON-response field. JSON response format is implemented by appending a schema-derived instruction to the prompt. The provider emits a compatibility warning.

**Impact:** output is not constrained decoding. It can contain invalid JSON or fail the requested schema, and a streaming failure may be discovered only after text has already been emitted.

**Workaround:** validate the final output in the application and retry or repair failures. Do not rely on this provider when strict native schema enforcement is required.

## Prompt and media input

### Fresh-session roles are lossy

ACP prompt content does not provide an arbitrary role-history import channel. On a fresh session, the provider serializes system, assistant, tool-call, tool-result, and approval history into labeled text. These labels do not have native system-message precedence or recreate tool execution state. Private reasoning is omitted by default.

**Workaround:** load an explicit ACP session ID when native continuity matters. See [Session continuity](docs/session-continuity.md).

### Images and audio are unsupported

The captured Grok Build 0.2.99 initialization explicitly advertises `image: false` and `audio: false`. Image and audio parts are warned about and omitted.

**Workaround:** use `@ai-sdk/xai` or another multimodal provider, or extract text with a separate model before calling this provider.

### Binary and remote file input is unsupported

Textual inline data and local textual `file:` URLs/references can be mapped to ACP embedded resources. Arbitrary binary data is not proven by `embeddedContext: true` and is omitted. The provider does not fetch remote HTTP(S) file URLs.

Resource links, blobs, annotations, and embedded-resource replay are not fixture-verified.

**Workaround:** extract content to UTF-8 text and pass it inline or as a local textual file.

### Custom and reasoning-file prompt parts are unsupported

ACP has no standard input mapping for AI SDK v7 custom parts or reasoning files. They are skipped with warnings.

## Generation controls

Grok Build ACP exposes no input fields for these AI SDK options:

- `temperature`
- `topP`
- `topK`
- `presencePenalty`
- `frequencyPenalty`
- `stopSequences`
- `seed`
- `maxOutputTokens`

Each supplied option is ignored with an `unsupported` warning. A Grok `max_tokens` stop reason can be observed after completion but does not provide a client-side token-limit control.

`providerOptions['grok-build'].maxTurns` is also not enforceable. ACP exposes `max_turn_requests` as a completion reason, not as an input field, so the option is accepted but ignored with a warning.

**Workaround:** use Grok CLI/session policy where available or state a desired bound in the prompt. Prompt instructions are not exact enforcement.

## Model and reasoning effort

Session metadata advertises the current model and available reasoning efforts, but captured ACP traffic does not establish a setter for either value.

- A requested model that differs from Grok's resolved model is not applied and produces a compatibility warning.
- `low`, `medium`, and `high` reasoning effort values are accepted only as requests. A value equal to the current effort needs no change; a different advertised value produces a compatibility warning and the runtime effort is retained.
- Unsupported effort values produce an `unsupported` warning.

**Workaround:** configure the desired defaults in Grok Build itself and treat provider model/effort values as requests until a capability-advertised route is captured and implemented.

## Sessions

New session creation and returned IDs are fixture-verified. Grok advertises `session/load`, and the provider calls it for an explicit `session.id` or `session.resume`, but live captures do not yet prove restart replay, invalid-ID handling, cross-directory behavior, or concurrent prompts. Every load emits a compatibility warning.

`session.continue` cannot find the most recent session and is ignored with a warning. `session.fork` is not advertised by ACP and creates a new session with a warning instead of cloning the source.

Each AI SDK call starts and disposes its own ACP process. Continuity comes from explicit session loading, not a persistent client process.

## Cancellation

On abort, the provider sends the standard `session/cancel` notification, cancels local pending work, answers pending permission requests as cancelled, and disposes the child process. Captures do not yet verify final event ordering or whether every in-flight Grok tool stops before process cleanup.

**Impact:** cancellation is best-effort at the Grok runtime boundary. Applications should not assume that an external side effect is rolled back.

## Permissions

ACP permission requests require an immediate JSON-RPC response, which does not match AI SDK deferred `tool-approval-request` parts. The provider therefore does not emit deferred AI SDK approvals.

Public provider settings currently expose two modes:

- `default`: if Grok sends an unhandled live permission request, reject it clearly rather than hang;
- `bypassPermissions`: automatically select Grok's `allow_once` option, falling back to `allow_always` when that is the only allow choice.

The permission request path exists in the client and is unit-tested, but it was not observed in the captured Grok traces. Mode mutation and all option combinations remain compatibility-sensitive.

**Security:** use `bypassPermissions` only when the Grok process is allowed to perform every requested action in the configured working directory and environment.

## Usage accounting

The provider maps total input tokens, cache-read tokens, total output tokens, and reasoning tokens when Grok returns them. It derives no-cache input as `input - cacheRead`.

Grok does not currently provide mapped values for cache writes or independent text-output tokens, so those fields remain `undefined`. Per-model call details are retained in provider metadata when present.

## Generated content and provider surfaces

The provider does not synthesize AI SDK content from unrelated protocol records. It therefore has no mapped output for:

- verified source/citation parts;
- generated files;
- reasoning files;
- V4 custom content;
- tool approval output parts.

xAI extension notifications remain `raw` events when requested. A URL printed by a tool is not promoted to a verified source, and a file path or diff is not promoted to a generated file.

The provider also does not implement embeddings, image generation, transcription, speech, reranking, provider files, or provider skills. `embeddingModel()` and `imageModel()` throw `NoSuchModelError`; unsupported optional factories are absent.

No Harness adapter ships with this package. AI SDK v7 Harness lifecycle behavior such as suspend, destroy, host-tool submission, file changes, filtering, and compaction is outside the current provider surface.

## Stdio transport

ACP is local JSON-RPC over stdio, not HTTP. Generic request headers, response headers, HTTP request/response bodies, and direct HTTP proxy settings do not apply. The AI SDK `headers` call option is ignored with a warning.

Use process environment variables for any proxy behavior understood by Grok, and configure HTTP/SSE MCP headers explicitly on each MCP server.

The provider is Node-only because it spawns a local executable. It requires Node.js 22 or newer and is published as ESM-only.

## Protocol drift

The provider targets ACP protocol version 1 and is validated against real Grok Build 0.2.99 captures. Standard ACP records and `_x.ai/*` extensions can evolve in later CLI versions.

Optional extension records can be exposed as raw events. Unknown standard `session/update` variants are not converted into typed AI SDK parts, although `includeRawChunks` preserves the original update. Unknown agent-to-client requests receive a JSON-RPC error instead of being accepted. Revalidate behavior after upgrading Grok Build when your application depends on raw events or exact tool payloads.
