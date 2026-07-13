# Known Limitations

This document covers the `ai-sdk-v6` branch and its `LanguageModelV3` / `ProviderV3` implementation. The provider uses Grok Build ACP over `grok agent stdio`; headless `streaming-json` is not a fallback transport.

## Tool ownership

### AI SDK-defined tools are not executed

ACP 1 has no channel for registering an AI SDK function tool and returning its application-produced result. Supplying `tools` produces an `unsupported` warning and the definitions are not sent to Grok. Non-default `toolChoice` values are also ignored with a warning.

Grok can still execute its own shell, filesystem, search, fetch, and MCP tools. Those calls and results are emitted as dynamic, `providerExecuted: true` AI SDK parts. Applications must not execute them a second time.

**Workaround:** configure a native Grok tool or expose the capability through an MCP server passed in `mcpServers`. A future SDK-to-MCP bridge would require different trust, lifecycle, and error semantics and is not included.

### Tool streaming depends on ACP and xAI extensions

Standard ACP tool-call and tool-result updates are mapped. Streams may emit replaceable preliminary results before the final result; non-streaming generation retains only the latest result for each tool call and replaces it with the final result. The redacted standard `tool_call` input snapshot becomes the AI SDK tool input. Version-specific xAI argument-delta notifications are available only as optional raw extension events; the provider does not merge them into the standard tool call.

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

Textual inline data and local textual `file:` URLs can be mapped to ACP embedded resources. Arbitrary binary data is not proven by `embeddedContext: true` and is omitted. The provider does not fetch remote HTTP(S) file URLs.

Resource links, blobs, annotations, and embedded-resource replay are not fixture-verified.

**Workaround:** extract content to UTF-8 text and pass it inline or as a local textual file.

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

- A requested model absent from Grok's advertised catalog is not applied and produces an `unsupported` warning. An advertised model that differs from Grok's resolved model is not applied and produces a compatibility warning.
- `low`, `medium`, and `high` reasoning effort values are accepted only as requests. A value equal to the current effort needs no change; a different advertised value produces a compatibility warning and the runtime effort is retained.
- Unsupported effort values produce an `unsupported` warning.

**Workaround:** configure the desired defaults in Grok Build itself and treat provider model/effort values as requests until a capability-advertised route is captured and implemented.

## Sessions

New session creation and returned IDs are fixture-verified. Restart replay is now also fixture-verified (`fixtures/acp/restart-load.jsonl`, captured with `scripts/acp-scenarios.mjs`): after the original process was killed, a new process initialized and called `session/load` with the session ID, `cwd`, and MCP servers; Grok replayed the prior conversation as `user_message_chunk` and `agent_message_chunk` `session/update` notifications before the load response returned; the load result included the models object; and a follow-up prompt correctly recalled earlier context. The provider calls `session/load` for an explicit `session.id` or `session.resume`. Invalid session IDs, cross-directory loads, and concurrent prompts remain unverified, and every load still emits a compatibility warning.

`session.continue` cannot find the most recent session and is ignored with a warning. `session.fork` is not advertised by ACP and creates a new session with a warning instead of cloning the source.

Each AI SDK call starts and disposes its own ACP process. Continuity comes from explicit session loading, not a persistent client process.

## Cancellation

On abort, the provider sends the standard `session/cancel` notification, cancels local pending work, answers pending permission requests as cancelled, and disposes the child process.

Final event ordering is now fixture-verified (`fixtures/acp/cancel.jsonl`, captured with `scripts/acp-scenarios.mjs`). After the client sends `session/cancel` mid-stream, Grok continues emitting `session/update` chunks while it drains the in-flight model turn (33 further chunks in the capture), then emits the `_x.ai/session/prompt_complete` extension notification with stop reason `cancelled`, may emit additional update chunks after it (one was observed), and finally resolves the `session/prompt` response with `stopReason: "cancelled"`. The provider already matches this ordering: it keeps consuming updates until the prompt response resolves and never treats `prompt_complete` as the last event. Consumers of the low-level `AcpClient` must do the same.

The capture was a pure text turn, so whether an in-flight Grok tool execution is terminated by cancellation remains unverified.

**Impact:** cancellation is best-effort at the Grok runtime boundary. Applications should not assume that an external side effect is rolled back.

## Permissions

**Grok Build 0.2.99 does not enforce permission modes over ACP.** Dedicated live captures (`fixtures/acp/permission-allow.jsonl` and `fixtures/acp/permission-plan.jsonl`, captured with `scripts/acp-scenarios.mjs`) probed `--permission-mode default` and `--permission-mode plan`, with session metadata confirming `yolo: false`. In every case Grok auto-executed terminal commands — including `curl` network access and `rm` — and file writes through its `write` tool, and never emitted `session/request_permission`. The effective ACP behavior in 0.2.99 is always-approve regardless of configuration.

ACP permission requests require an immediate JSON-RPC response, which does not match AI SDK deferred `tool-approval-request` parts. The provider therefore does not emit deferred AI SDK approvals.

Public provider settings currently expose two modes:

- `default`: if Grok sends an unhandled live permission request, reject it clearly rather than hang;
- `bypassPermissions`: automatically select Grok's `allow_once` option, falling back to `allow_always` when that is the only allow choice.

The permission request path stays implemented in the client, unit-tested, and capability-gated for future Grok versions, but Grok 0.2.99 never exercises it: no capture contains a `session/request_permission`, so in practice neither mode changes what Grok executes. Mode mutation and all option combinations remain compatibility-sensitive.

**Security:** treat every ACP session as if `bypassPermissions` were active, because in Grok Build 0.2.99 it effectively is. Isolate side effects with the working directory, the process environment, and Grok's `--sandbox` profiles — not with permission modes.

## Usage accounting

The provider maps total input tokens, cache-read tokens, total output tokens, and reasoning tokens when Grok returns them. It leaves no-cache input undefined because captured traces do not prove whether Grok's input total includes cached reads. Missing input or output totals remain undefined rather than being fabricated as zero.

Grok does not currently provide mapped values for cache writes or independent text-output tokens, so those fields remain `undefined`. Per-model call details are retained in provider metadata when present.

## Generated content and provider surfaces

The provider does not synthesize AI SDK content from unrelated protocol records. It therefore has no mapped output for:

- verified source/citation parts;
- generated files;
- tool approval output parts.

xAI extension notifications remain redacted `raw` events when requested. Credential-like fields, authorization headers, environment values, and inline token assignments are removed from raw and tool metadata. A URL printed by a tool is not promoted to a verified source, and a file path or diff is not promoted to a generated file.

The provider also does not implement embeddings, image generation, transcription, speech, reranking, provider files, or provider skills. `embeddingModel()` and `imageModel()` throw `NoSuchModelError`; unsupported optional factories are absent.

## Stdio transport

ACP is local JSON-RPC over stdio, not HTTP. Generic request headers, response headers, HTTP request/response bodies, and direct HTTP proxy settings do not apply. The AI SDK `headers` call option is ignored with a warning.

Use process environment variables for any proxy behavior understood by Grok, and configure HTTP/SSE MCP headers explicitly on each MCP server.

The provider is Node-only because it spawns a local executable. It requires Node.js 18 or newer and publishes ESM and CommonJS entry points.

## Protocol drift

The provider targets ACP protocol version 1 and is validated against real Grok Build 0.2.99 captures. Standard ACP records and `_x.ai/*` extensions can evolve in later CLI versions.

Optional extension records can be exposed as redacted raw events. Unknown optional standard `session/update` variants are preserved as redacted raw records and produce one compatibility warning per kind. Malformed required text/tool updates and unknown events that can affect completion, tool identity, permissions, or usage fail with an ACP protocol error. Unknown agent-to-client requests receive a JSON-RPC error instead of being accepted. Revalidate behavior after upgrading Grok Build when your application depends on raw events or exact tool payloads.
