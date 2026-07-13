# AI SDK capability gap analysis

This document compares the union of the AI SDK v7 `LanguageModelV4` / `ProviderV4` contract and the AI SDK v6 `LanguageModelV3` / `ProviderV3` contract with Grok Build 0.2.99's ACP surface.

The analysis is based on real captures in `fixtures/acp/`, the working `scripts/acp-probe.mjs` client, the `scripts/acp-scenarios.mjs` scenario harness (which captured the permission, restart-load, and cancellation fixtures against Grok Build 0.2.99), and the local AI SDK contract snapshots. ACP over `grok agent stdio` is the provider transport. Headless `streaming-json` is not a second integration surface: the captured headless stream contains thought, text, and end events but no tool lifecycle.

The main branch targets:

- `ai` peer `^7.0.16`, `LanguageModelV4`, and `ProviderV4`
- `@ai-sdk/provider ^4.0.2`
- `@ai-sdk/provider-utils ^5.0.5`
- Zod 4
- Node.js 22 or newer
- ESM only

The future `ai-sdk-v6` branch will use `LanguageModelV3` / `ProviderV3`. The ACP process, JSON-RPC client, session state, normalized events, usage model, and cancellation machinery must not import either adapter generation.

## Dispositions

- **MAPPED** — ACP has a direct representation. The provider can translate it without changing the capability's meaning.
- **PARTIAL** — ACP exposes part of the capability, or the relevant Grok behavior is advertised but not fixture-verified. The missing behavior is stated in the row.
- **EMULATED** — the provider can approximate the capability outside a native ACP field. The approximation and its failure mode are stated in the row.
- **UNSUPPORTED-DOCUMENTED** — the provider will not claim the capability. Calls continue where safe, with a typed warning and a practical workaround.

“Advertised” below means returned by Grok during ACP initialization or session creation. It does not mean fixture-verified execution.

## Provider and model contract

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| Provider generation | `ProviderV4`, `specificationVersion: 'v4'` | `ProviderV3`, `specificationVersion: 'v3'` | Transport-independent | **MAPPED** — each branch supplies its native provider literal and adapter types over the same ACP core. |
| Language model generation | `LanguageModelV4`, `specificationVersion: 'v4'` | `LanguageModelV3`, `specificationVersion: 'v3'` | Transport-independent | **MAPPED** — both adapters expose `provider`, `modelId`, `supportedUrls`, `doGenerate`, and `doStream`. |
| Callable provider, `languageModel()`, and `chat()` | Required provider factory plus conventional aliases | Same established community-provider pattern | A session can be created for a selected model wrapper | **MAPPED** — all three entry points create the same branch-native language model. |
| `embeddingModel()` | Required factory | Required factory; deprecated `textEmbeddingModel()` is optional | No embedding ACP method | **UNSUPPORTED-DOCUMENTED** — throw `NoSuchModelError`. Use an embedding provider. |
| `imageModel()` | Required factory | Required factory | No image-generation ACP method | **UNSUPPORTED-DOCUMENTED** — throw `NoSuchModelError`. Use an image provider. |
| `transcriptionModel()`, `speechModel()`, and `rerankingModel()` | Optional | Optional | No corresponding ACP methods | **UNSUPPORTED-DOCUMENTED** — do not expose optional factories. |
| Provider `files()` and `skills()` | Optional in V4 | Not present in V3 | Grok reports commands/plugins through extensions, not the AI SDK file or skill contracts | **UNSUPPORTED-DOCUMENTED** — do not relabel Grok extensions as V4 file or skill providers. Use Grok CLI configuration for plugins and skills. |
| `supportedUrls` | Required; controls whether core downloads file URLs | Required with the same behavior | ACP image/audio support is false; embedded context does not establish arbitrary URL fetching | **MAPPED** — return `{}` so AI SDK resolves URLs before the provider sees them. Downloaded content is still subject to the media restrictions below. |
| `doGenerate()` | Required | Required | ACP is notification-streamed even for a non-streaming caller | **MAPPED** — consume one prompt to completion, preserve event order, and return accumulated content, finish reason, usage, warnings, and metadata. |
| `doStream()` | Required | Required | `session/update` plus terminal `session/prompt` result | **MAPPED** — expose a `ReadableStream` and emit exactly one terminal `finish` after the prompt result. |

## Call options and prompt input

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| User text | Ordered user `text` parts | Same | ACP `ContentBlock { type: 'text' }` is fixture-verified | **MAPPED** — preserve text-part order in the prompt. |
| System messages | Native `system` role | Same | `session/prompt` has content blocks but no role or system-instruction field | **EMULATED** — prefix a clearly delimited system section to the submitted text. It remains user-prompt text, so native system precedence and injection resistance are not preserved. |
| Assistant text history | Native assistant role | Same | No arbitrary role-history import on `session/prompt` | **EMULATED** — serialize prior turns as a delimited transcript for a new session. Role boundaries are advisory text, not native conversation records. Prefer ACP session continuity when a real Grok session ID is available. |
| Reasoning history | Native assistant `reasoning` parts | Same | ACP can output thoughts but has no input reasoning block proven by Grok | **EMULATED** — omit private reasoning by default; if explicitly retained, serialize it as labeled transcript text with a compatibility warning. It is not restored as model reasoning state. |
| Tool-call and tool-result history | Native assistant/tool roles; results may be text, JSON, execution-denied, error-text, error-JSON, or content containing text/file/custom parts | Same broad capability; V3 has legacy image/file result variants | ACP has runtime-owned live tools but no import channel for arbitrary prior AI SDK calls/results | **EMULATED** — serialize completed history as labeled text. Execution identity, approval state, and provider-executed semantics are not recreated; binary result content is reduced to a marker and warning. |
| Tool approval responses in prompt history | Native `tool-approval-response` | Same | ACP permission responses are live JSON-RPC responses, not prompt content | **EMULATED** — retain a textual audit marker only. It cannot answer a live ACP permission request. |
| Message- and part-level `providerOptions` | Supported on messages and parts | Supported on applicable V3 parts | ACP content blocks allow `_meta`, but Grok semantics for arbitrary metadata are unverified | **PARTIAL** — parse the `grok-build` call-level options described below. Preserve safe recognized metadata internally; warn and ignore unknown behavior-changing options instead of forwarding arbitrary JSON. |
| Text files / embedded file context | V4 file parts carry optional `filename`, `mediaType`, and tagged `data`, `url`, `reference`, or `text` data | V3 file data is bytes, base64 text, or `URL` | `promptCapabilities.embeddedContext: true`; ACP resource content is advertised but not exercised | **PARTIAL** — map UTF-8 text and resolvable textual file content to ACP embedded resources with stable URIs and MIME types. Blob handling, resource links, annotations, and replay behavior remain unverified. |
| Image input | General V4 file parts | V3 file/image-compatible inputs | `promptCapabilities.image: false` | **UNSUPPORTED-DOCUMENTED** — warn and omit the image. Use `@ai-sdk/xai` or another multimodal provider when image understanding is required. |
| Audio input | General file parts | General file inputs | `promptCapabilities.audio: false` | **UNSUPPORTED-DOCUMENTED** — warn and omit the audio. Use a transcription or multimodal provider first. |
| Other binary file input | General file parts | General file inputs | Embedded context is advertised, but binary file consumption is not fixture-verified | **UNSUPPORTED-DOCUMENTED** — do not treat `embeddedContext: true` as proof of arbitrary binary support. Extract text before calling the provider. |
| V4 file references and tagged text | Native `reference` and `text` file data | No generic V3 equivalent | ACP resources have URIs and inline text/blob fields | **PARTIAL** — V4 inline text can become an embedded resource. A provider reference is usable only when the `grok-build` reference resolves locally; opaque references warn and are skipped. The V3 adapter accepts only its native data forms. |
| Reasoning files | Native V4 prompt part | Not present in V3 | No Grok ACP input event for reasoning files | **UNSUPPORTED-DOCUMENTED** — warn and skip. Ordinary textual context can be supplied as an embedded resource instead. |
| Custom prompt parts | Native V4 `custom` part | No top-level V3 equivalent | No standard Grok ACP custom-content input | **UNSUPPORTED-DOCUMENTED** — warn and skip; put required data in text or a documented `grok-build` provider option. |
| `responseFormat: { type: 'text' }` | Native call option | Same | Normal ACP text output | **MAPPED** — no special transport behavior is required. |
| Structured output / `responseFormat: { type: 'json' }` | JSON mode with optional schema, name, and description | Same | No ACP output-schema or JSON-response field | **EMULATED** — append a schema-derived instruction, suppress non-JSON framing where possible, accumulate assistant text, parse it as JSON, and let AI SDK validation apply. Grok does not guarantee strict schema conformance; streamed JSON may fail late after text has already been emitted. A compatibility warning is always returned. |
| `maxOutputTokens` | Optional call control | Same | No ACP prompt parameter for output-token limits | **UNSUPPORTED-DOCUMENTED** — ignore with an `unsupported` warning. A Grok-side `max_tokens` stop reason is observable but does not create a client control channel. |
| `temperature`, `topP`, and `topK` | Optional sampling controls | Same | ACP exposes no sampling parameters | **UNSUPPORTED-DOCUMENTED** — ignore each supplied setting with an `unsupported` warning. |
| `presencePenalty` and `frequencyPenalty` | Optional sampling controls | Same | ACP exposes no penalty parameters | **UNSUPPORTED-DOCUMENTED** — ignore each supplied setting with an `unsupported` warning. |
| `stopSequences` | Optional generation control | Same | ACP exposes no stop-sequence parameter | **UNSUPPORTED-DOCUMENTED** — ignore with an `unsupported` warning. Prompt instructions are not an exact replacement. |
| `seed` | Optional determinism control | Same | ACP exposes no seed parameter | **UNSUPPORTED-DOCUMENTED** — ignore with an `unsupported` warning. |
| Top-level `reasoning` | Native V4 option | Not present in V3 | Model metadata advertises `high`, `medium`, and `low`, but no standard advertised setter was exercised | **PARTIAL** — `provider-default` leaves the resolved effort untouched. Report the current effort and supported choices. A requested value equal to the current effort is accepted; a different value, including unsupported `none`, `minimal`, or `xhigh`, warns until a Grok-advertised setting route is fixture-verified. V3 keeps any future effort control under typed `grok-build` options. |
| `maxTurns` provider option | Provider-specific extension | Provider-specific extension | `max_turn_requests` is a stop reason, not an ACP input; aggregate usage reports turns only after completion | **UNSUPPORTED-DOCUMENTED** — do not claim enforcement. Use Grok CLI/session configuration or an explicit prompt constraint; both remain runtime policy rather than a provider guarantee. |
| `abortSignal` | Required to handle deliberately | Same | Standard ACP defines `session/cancel`; ordering is fixture-verified: after the cancel notification Grok keeps streaming `session/update` chunks while the turn drains, emits `_x.ai/session/prompt_complete` with stop reason `cancelled`, may emit further chunks after it, then resolves `session/prompt` with `stopReason: "cancelled"` | **PARTIAL** — on abort, send `session/cancel`, keep consuming updates until the prompt response resolves (never treat `prompt_complete` as the last event), cancel outstanding local reads, answer pending permissions as cancelled, then use bounded process termination if the prompt does not settle. The capture was a pure text turn, so in-flight tool termination remains unverified. |
| `headers` | Optional, transport-specific | Same | ACP is stdio, not HTTP | **UNSUPPORTED-DOCUMENTED** — call-level HTTP headers are ignored. Use process environment variables for proxies and explicit MCP server headers for MCP traffic. |
| Call-level `providerOptions` | Provider-keyed JSON object | Same | ACP has standard fields plus xAI extensions | **PARTIAL** — recognize typed `grok-build` options for session ID/load, `cwd`, MCP servers, permission policy, raw events, and future capability-gated model settings. Unknown keys produce a compatibility warning. |

## Tools and permissions

Grok tools and AI SDK tools are different ownership models. Grok's shell, filesystem, search, fetch, and MCP tools execute inside the Grok Build runtime. An AI SDK function tool is application-owned and expects the model provider to return control to the application for execution. ACP 1 has no client-defined tool registration/result-submission channel.

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| AI SDK function-tool definitions | `name`, `inputSchema`, `description`, `inputExamples`, `strict`, and `providerOptions` | Same | No tool-definition field on `session/new` or `session/prompt` | **UNSUPPORTED-DOCUMENTED** — warn when a non-empty `tools` array is supplied and do not tell Grok those tools exist. A future SDK-to-MCP bridge could expose application tools as a temporary MCP server, but that changes trust, lifecycle, and error semantics and is not part of the initial provider. |
| AI SDK provider-defined tools | Provider tool ID, name, and args | Same | Grok exposes its own provider/runtime tools, not arbitrary AI SDK provider-tool declarations | **UNSUPPORTED-DOCUMENTED** — do not forward declarations. Configure native Grok or MCP tools through Grok settings. |
| `toolChoice: auto` | Core commonly supplies it by default | Same | Grok selects its own runtime tools | **PARTIAL** — treat default `auto` as a no-op without a warning when no AI SDK tools were supplied. It does not constrain the native Grok tool set. |
| `toolChoice: none`, `required`, or named | Native client-tool policy | Same | No ACP tool-choice control | **UNSUPPORTED-DOCUMENTED** — warn and ignore. Use Grok permission/tool configuration or a purpose-built MCP server. |
| Native Grok tool call | V4 `tool-call` may be provider-executed/dynamic | V3 has the same fields | Standard `tool_call` is fixture-verified with ID, title, raw input, and xAI tool metadata | **MAPPED** — emit a dynamic `tool-call` with `providerExecuted: true`; stringify normalized object input and preserve raw input in provider metadata. |
| Native Grok tool result | V4 `tool-result`; core treats emitted results as provider-executed | Same | `tool_call_update` with completed status, content, and raw output is fixture-verified | **MAPPED** — emit the result after its matching call, preserve preliminary/final ordering if observed, set `isError` for failed status, and retain raw output in provider metadata. |
| Tool-input streaming | `tool-input-start` / `tool-input-delta` / `tool-input-end` plus canonical completed call | Same | xAI extension `tool_call_delta_chunk` is fixture-verified; the standard call also carries complete `rawInput` | **PARTIAL** — stream extension argument deltas when present, then emit the canonical completed call from standard ACP data. The extension is non-standard and may be absent, duplicated, or incomplete after a CLI update. |
| Tool output streaming | Preliminary results may be emitted | Same | Standard updates have replacement semantics; fixture output arrived in in-progress/completed updates | **PARTIAL** — emit safe preliminary results only when a replacement can be correlated. Byte arrays, terminal handles, and diffs are normalized into JSON/text and also retained raw; not every runtime byte is a user-facing delta. |
| AI SDK `tool-approval-request` / response | Deferred approval parts supported | Same | ACP `session/request_permission` requires an immediate response on the live JSON-RPC connection | **UNSUPPORTED-DOCUMENTED** — do not emit a deferred AI SDK approval request that cannot answer the pending RPC. Use the provider's live permission callback or approval policy instead. |
| Always approve / yolo | Provider-specific runtime policy | Same | Permission fixtures probed `--permission-mode default` and `--permission-mode plan` with session metadata confirming `yolo: false`; Grok still auto-executed terminal commands (including `curl` and `rm`) and `write`-tool file writes with no permission request | **PARTIAL** — the effective 0.2.99 behavior is always-approve regardless of configuration: permission modes are not enforced for ACP sessions. The provider's `bypassPermissions` policy would select an allow option if a request arrived, but Grok never sends one, so treat every ACP session as if bypass were active and isolate side effects with `cwd`, environment, and Grok `--sandbox` profiles. |
| Interactive permissions | Provider-specific callback | Same | `session/request_permission` exists in the binary but is proven absent in 0.2.99: dedicated permission probes in `default` and `plan` modes executed terminal and file-write tools without ever emitting the request | **PARTIAL** — the standard request handler stays implemented behind a capability/version guard for future Grok versions, with allow/reject choices. If no callback is installed, reject or cancel safely rather than hanging. In 0.2.99 the handler is never invoked; Grok auto-executes all tools over ACP. |
| ACP filesystem/terminal callbacks | Not an AI SDK language-model feature | Same | ACP can call `fs/*` and `terminal/*` only when the client advertises those capabilities; Grok execution was not captured | **UNSUPPORTED-DOCUMENTED** — the initial provider advertises these client capabilities as false. Grok's runtime-owned tools remain available; host filesystem or terminal delegation can be added only with a separate security policy and fixtures. |

## Generated content and streaming events

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| Ordered result content | Required array preserving generation order | Same | ACP updates are ordered on stdout | **MAPPED** — normalize events serially and preserve observed text, reasoning, call, and result order in `doGenerate`. |
| Text output | Non-streaming text; `text-start` / `text-delta` / `text-end` stream lifecycle | Same | `agent_message_chunk` is fixture-verified | **MAPPED** — open a text block on the first chunk, emit deltas, and close it before `finish` or before switching to an incompatible block. |
| Reasoning output | Non-streaming reasoning; `reasoning-start` / `reasoning-delta` / `reasoning-end` lifecycle | Same | `agent_thought_chunk` is fixture-verified | **MAPPED** — emit reasoning blocks separately from assistant text and report reasoning tokens when supplied. |
| Generated file | V4 tagged data or URL | V3 inline string/bytes only | No standard ACP generated-file update was observed | **UNSUPPORTED-DOCUMENTED** — do not synthesize files from tool paths or diffs. Native mutations remain tool results/raw events. |
| Reasoning file | Native V4 output and stream part | Not present in V3 | No ACP reasoning-file update | **UNSUPPORTED-DOCUMENTED** — no output is fabricated. |
| Custom content | Native V4 output and stream part | Not present in V3 | xAI extension notifications are protocol events, not AI SDK custom model content | **UNSUPPORTED-DOCUMENTED** — preserve extensions as raw events/provider metadata instead of relabeling them as generated content. |
| Sources | URL or document source parts | Same | No standard ACP source/citation update was observed | **UNSUPPORTED-DOCUMENTED** — a URL printed by a tool is not promoted to a verified source. Consumers may inspect tool output or raw metadata. |
| Tool approval output | V4 approval request tied to a same-response call | Same | Live permission timing is incompatible with the deferred language-model part | **UNSUPPORTED-DOCUMENTED** — use the live permission path described above. |
| `stream-start` | Expected with warnings | Same | Provider-created event | **MAPPED** — emit first with all options known to be unsupported or emulated. |
| `response-metadata` | ID, timestamp, and model ID | Same | Prompt/session/request IDs and model ID are present in Grok metadata; timestamps occur on extension envelopes | **PARTIAL** — emit stable prompt/request ID and resolved model when known. Do not invent HTTP headers or treat an agent timestamp as a server response timestamp without labeling it in provider metadata. |
| `finish` | Exactly one successful terminal event | Same | `session/prompt` returns after updates with `stopReason` and usage metadata | **MAPPED** — wait for the correlated prompt result, close open blocks, and emit one `finish`. Process exit or protocol failure emits `error`, not a successful finish. |
| `error` | Zero or more error stream parts | Same | JSON-RPC errors, stderr diagnostics, malformed records, and process exits are observable | **MAPPED** — surface sanitized errors. Unknown required completion/tool events are protocol errors; unknown optional notifications are preserved raw. |
| `raw` / `includeRawChunks` | Conditional V4 stream part | Same in V3 | Every JSON-RPC record and extension notification is available | **MAPPED** — when enabled, emit redacted normalized raw records, including unknown standard and xAI extension notifications. Authentication values, MCP authorization headers, and other secrets must never be copied into raw output. |
| Request body | Optional metadata | Same | No HTTP request body exists | **UNSUPPORTED-DOCUMENTED** — omit it rather than inventing an HTTP-shaped request. |
| Response body and headers | Optional generate/stream metadata | Same | No HTTP response or headers exist | **UNSUPPORTED-DOCUMENTED** — omit headers/body. Use raw chunks for protocol diagnostics. |

V4-only `custom`, `reasoning-file`, tagged file references, provider `files()`, and provider `skills()` are isolated in the V4 adapter. The V3 adapter must not introduce non-contract discriminators. V3 file results use their legacy inline representation; any future V4 generated URL would require download or an explicit V3 downgrade warning.

## Usage and finish reasons

Both adapters always return the required `inputTokens` and `outputTokens` objects and all required nested keys. Unavailable numbers are `undefined`, not fabricated zeroes.

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| Input total | `inputTokens.total` | Same normalized usage shape | `_meta.inputTokens` is fixture-verified | **MAPPED** — copy the per-prompt value and preserve aggregate/model usage separately in `raw`. |
| Cache read | `inputTokens.cacheRead` | Same | `_meta.cachedReadTokens` is fixture-verified | **MAPPED** — copy directly. |
| No-cache input | `inputTokens.noCache` | Same | It is not proven whether Grok's input total includes cached reads | **PARTIAL** — leave undefined until trace semantics prove a safe calculation. Do not subtract on assumption. |
| Cache write | `inputTokens.cacheWrite` | Same | No cached-write field was observed | **PARTIAL** — return the required field with `undefined`. |
| Output total | `outputTokens.total` | Same | `_meta.outputTokens` is fixture-verified | **MAPPED** — copy directly. |
| Reasoning output | `outputTokens.reasoning` | Same | `_meta.reasoningTokens` is fixture-verified | **MAPPED** — copy directly. |
| Text output tokens | `outputTokens.text` | Same | No independent text-token field was observed | **PARTIAL** — leave undefined unless xAI documents whether output total includes reasoning and a safe derivation becomes possible. |
| Raw and aggregate usage | Optional `usage.raw` | Same | Aggregate usage includes totals, cache reads, reasoning, model calls, API duration, per-model usage, and turn count | **MAPPED** — preserve the complete JSON-compatible aggregate object under `raw`; do not conflate it with the per-result top-level counts. |
| `end_turn` | Unified finish reason required | Same | Observed | **MAPPED** — `{ unified: 'stop', raw: 'end_turn' }`. Native Grok tools have already executed, so their presence does not change this to `tool-calls`. |
| `max_tokens` | Unified finish reason required | Same | Standard ACP value, not fixture-observed | **MAPPED** — `{ unified: 'length', raw: 'max_tokens' }`. |
| `max_turn_requests` | Unified finish reason required | Same | Standard ACP value, not fixture-observed | **MAPPED** — `{ unified: 'length', raw: 'max_turn_requests' }`. |
| `refusal` | Unified finish reason required | Same | Standard ACP value, not fixture-observed | **MAPPED** — `{ unified: 'content-filter', raw: 'refusal' }`. |
| `cancelled` | No dedicated unified value | Same | Fixture-verified: after `session/cancel`, the `session/prompt` result resolves with `stopReason: "cancelled"` | **PARTIAL** — `{ unified: 'other', raw: 'cancelled' }`; the aborted promise/stream also observes the caller's abort. |
| Unknown stop reason | Unified fallback required | Same | Protocol may evolve | **MAPPED** — `{ unified: 'other', raw: value }` and preserve the raw value. JSON-RPC/process failure maps to `error`, not `other`. |

## Warnings and provider metadata

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| Unsupported-option warnings | `SharedV4Warning` | `SharedV3Warning` | Provider-created | **MAPPED** — return typed `unsupported` warnings from `doGenerate` and the stream's initial `stream-start`; return `[]` when none apply. Never silently accept a setting that Grok cannot honor. |
| Emulation warnings | Compatibility/other warning | Same concept | Provider-created | **MAPPED** — JSON-mode and role-history emulation identify the lost guarantee and workaround. |
| Protocol-drift warnings | Compatibility/other warning or error | Same | Unknown optional events are expected as Grok evolves | **MAPPED** — preserve optional unknown events as raw and warn once by event kind. Fail only when the unknown event controls completion, tool identity, permission state, or usage integrity. |
| Session metadata | Provider-keyed JSON metadata | Same | `session/new` returns `sessionId`; prompt metadata returns request/prompt IDs | **MAPPED** — expose `providerMetadata['grok-build']` with session, prompt, request, resolved model, effort, agent version, and safe usage fields when present. |
| Tool/raw metadata | Content-level provider metadata | Same | ACP exposes raw input/output and xAI tool metadata | **MAPPED** — attach JSON-safe, redacted metadata without changing canonical AI SDK fields. |
| Headers/proxy metadata | Optional response headers | Same | No provider HTTP hop | **UNSUPPORTED-DOCUMENTED** — no synthetic headers. Proxy configuration remains process/MCP configuration. |

## Sessions, models, authentication, and MCP

| Capability | AI SDK v7 | AI SDK v6 | Grok Build ACP | Provider disposition |
|---|---|---|---|---|
| Cached subscription authentication | Provider-specific | Same | `cached_token` is advertised first and returned as `defaultAuthMethodId`; fixtures proceed with an existing CLI login | **MAPPED** — reuse the user's `~/.grok/auth.json` login by default. Do not require `authenticate` before every session and never expose token material. |
| API-key authentication | Provider-specific | Same | The CLI can inherit `XAI_API_KEY`; it was not returned as an ACP auth method in these captures | **PARTIAL** — support it as an explicit environment-based alternative. Do not claim that `xai.api_key` is negotiated unless a future initialize response advertises it. |
| New session | Provider-specific continuity option | Same | `session/new` is fixture-verified | **MAPPED** — create a session with absolute `cwd` and configured MCP servers, then expose its ID in provider metadata. |
| Load existing session | Provider-specific continuity option | Same | `loadSession: true` is advertised and restart replay is fixture-verified: after a process restart, `session/load` replayed history as `user_message_chunk`/`agent_message_chunk` updates before the load response returned, the result carried the models object, and a follow-up prompt recalled prior context | **PARTIAL** — capability-gate `session/load`; restart replay ordering is proven, while invalid IDs, cross-CWD rules, and concurrent prompts still lack fixtures. Every load emits a compatibility warning. |
| Stateless AI SDK prompt history | Full prompt arrives on each call | Same | ACP session state is persistent rather than stateless | **EMULATED** — create a fresh session and serialize the supplied history. This is not identical to replaying native Grok session events. |
| Persistent continuity | Provider metadata/options | Same | Sessions are keyed by `sessionId` and advertised as loadable | **PARTIAL** — return the ID and allow an explicit subsequent load. No list, delete, fork, resume, close, or checkpoint operation is called because those capabilities were not advertised. |
| Concurrent prompts | Provider/runtime concern | Same | ACP queue extensions exist, but prompt concurrency semantics were not tested | **UNSUPPORTED-DOCUMENTED** — serialize prompts per session. Use separate sessions for concurrency. |
| Model discovery | Provider-specific model listing/metadata | Same | Initialize and `session/new` return current and available models | **MAPPED** — expose the observed catalog and resolved model as advisory runtime metadata; catalogs may change with the installed CLI. |
| Model selection | `modelId` selects a model wrapper | Same | `session/set_model` is binary-only and not advertised as a standard capability | **PARTIAL** — verify the requested ID exists, but use only the current resolved model unless a setting route is advertised and fixture-verified. A mismatch produces a compatibility warning or strict-mode error, never a silent substitution. |
| Reasoning-effort discovery/selection | Top-level V4 `reasoning`; provider-specific fallback | Provider-specific only | Model metadata supplies effort choices/current value; mutation channel unverified | **PARTIAL** — discovery is direct; selection is subject to the call-option restriction above. |
| MCP server passthrough | Provider-specific settings | Same | `session/new` accepts stdio, HTTP, and SSE server shapes; HTTP/SSE capabilities are true; stdio servers appear in loaded-server data | **PARTIAL** — pass standard MCP descriptors. HTTP/SSE are advertised; per-call stdio startup and error behavior still need fixtures. Preserve server status as metadata/raw and never expose authorization headers. |
| Generic call headers for MCP | AI SDK call headers | Same | MCP server descriptors have their own headers | **UNSUPPORTED-DOCUMENTED** — do not copy language-model `headers` into MCP. Configure headers on each MCP server. |
| Unknown standard/xAI notifications | Raw stream capability | Same | Many extensions are observed and more subtype names exist only in the binary | **MAPPED** — known events normalize into typed internal events; unknown events survive as redacted raw records. They are not discarded or promoted to unsupported AI SDK content types. |

## HarnessV1 adjunct (v7 only)

HarnessV1 is not part of AI SDK v6 and does not replace the language-model provider. If a separate `harness-grok-build` adapter is shipped, it uses the same ACP core and the following limits.

| Harness capability | Grok Build ACP | Disposition |
|---|---|---|
| `specificationVersion`, `harnessId`, and `doStart` | Adapter fields plus `session/new` / advertised `session/load` | **MAPPED** — identify the harness and create or capability-gated-load a session. |
| `builtinTools` | Grok owns the tool set; extension metadata reports available tools/commands | **PARTIAL** — expose only stable normalized tool identities. The list is dynamic and extension-owned. |
| Built-in tool approvals | Standard permission request is never emitted by 0.2.99; permission probes auto-executed tools | **PARTIAL** — advertise only after a future Grok version emits a live permission request that proves request/response ordering. |
| Built-in tool filtering | No ACP allowed-tool filter was advertised | **UNSUPPORTED-DOCUMENTED** — use Grok configuration or separate MCP composition. |
| Lifecycle schema/bootstrap | Session/model/config metadata is available | **PARTIAL** — return safe session/model bootstrap data; do not promise opaque Grok resident-process state can be reconstructed. |
| Work directory and sandbox session | `session/new.cwd` is native; no Harness sandbox-object binding exists | **PARTIAL** — map the working directory. Sandbox lifecycle remains owned by the caller/Grok process. |
| Skills | Grok commands/plugins are extension metadata | **PARTIAL** — configured Grok skills remain runtime-owned; Harness skill injection is not claimed without a proven plugin-directory route. |
| Permission mode | 0.2.99 auto-executes all tools regardless of permission mode | **PARTIAL** — same permission constraints as the language-model adapter: treat every session as always-approve until a Grok version enforces modes over ACP. |
| Abort and observability wiring | ACP has cancellation plus ordered JSON-RPC events | **PARTIAL** — reuse bounded cancellation; forward normalized events to Harness observability without treating unverified extensions as lifecycle facts. |
| `doPromptTurn` and `done` | `session/prompt`, updates, and correlated result | **MAPPED** — one ACP prompt is one Harness turn. |
| `doContinueTurn` | No standard client method for continuing without a new prompt | **UNSUPPORTED-DOCUMENTED** — submit a new user prompt; do not fabricate an empty continuation that may trigger unintended agent work. |
| `submitToolResult` | Grok executes its own tools; no host tool-result submission method | **UNSUPPORTED-DOCUMENTED** — use MCP for host capabilities. |
| `submitToolApproval` | ACP requires live response to `session/request_permission` | **PARTIAL** — can map only while that request is pending and after the request path is fixture-verified. |
| `submitUserMessage` | Queue/interjection extensions are agent-to-client observations, not an advertised client input | **UNSUPPORTED-DOCUMENTED** — no mid-turn user injection. |
| `doCompact` | `/compact` is advertised as an available command; compact extension events are not captured | **EMULATED** — a command prompt may request compaction, but completion, retained context, and cancellation semantics are not guaranteed. Mark experimental. |
| `doSuspendTurn` | `session/cancel` stops work but no resumable cursor is advertised | **UNSUPPORTED-DOCUMENTED** — cancellation is not suspension. |
| `doDetach` | Sessions are persisted and restart replay via `session/load` is fixture-verified; resident-process behavior is unverified | **PARTIAL** — release local listeners/process resources only under an explicit detach policy; retain the session ID for later load. |
| `doStop` | Standard `session/cancel` is fixture-verified for a text turn: updates drain, `prompt_complete` reports `cancelled`, then the prompt resolves | **PARTIAL** — send cancel and use bounded cleanup; in-flight tool termination is unverified. |
| `doDestroy` | No session delete capability was advertised | **UNSUPPORTED-DOCUMENTED** — stopping a client does not delete Grok's persisted session. |
| `stream-start` | Adapter-created event with warnings | **MAPPED** — emit before the first content event. |
| Text/reasoning stream | Verified message/thought chunks | **MAPPED** — same block lifecycle as V4. |
| Tool call/result stream | Verified standard tool updates | **MAPPED** — provider-executed runtime tools. |
| Approval stream | Live permission route proven absent in 0.2.99 | **PARTIAL** — only after a future Grok version emits live requests; otherwise raw diagnostics and explicit capability error. |
| `finish-step` and final `finish` | xAI `turn_completed` plus `session/prompt` result | **MAPPED** — preserve raw stop reason and usage. |
| `file-change` | `x.ai/fs_notify` is advertised; no file-change shape was captured | **PARTIAL** — emit only after fixtures prove path and operation semantics. Tool diffs are not automatically equivalent to a committed file mutation. |
| `compaction` stream | Compaction subtype names exist but shapes are unverified | **PARTIAL** — preserve raw until captured; do not synthesize a Harness compaction event from a command alone. |
| `error` and `raw` | JSON-RPC/process errors and all protocol records are available | **MAPPED** — use the shared sanitization and redaction rules. |

## Authoring utilities and packaging split

`@ai-sdk/provider-utils` is an implementation library, not an ACP capability. The provider will use its version-appropriate JSON parsing/validation, stream conversion, ID generation, abort/error helpers, provider-option parsing, media helpers, and tool-call tracking in the adapters. HTTP request/response, SSE, WebSocket, retry, header-combination, and API-key-loading helpers are not used for the ACP stdio hop. Shared message, schema, and tool types describe the adapter contract; they do not make an unsupported Grok feature available.

| Area | Main / AI SDK v7 | `ai-sdk-v6` branch | Disposition |
|---|---|---|---|
| SDK contract | `ai` peer `^7.0.16`, provider V4 | `ai ^6` for development/integration, provider V3 | **MAPPED** — branch-native types only. |
| Provider packages | `@ai-sdk/provider ^4.0.2`, `@ai-sdk/provider-utils ^5.0.5` | `@ai-sdk/provider ^3`, `@ai-sdk/provider-utils ^4` | **MAPPED** — adapters depend on their matching generation. |
| Zod | Zod 4 | Zod 3/4 compatibility follows the v6 branch policy | **MAPPED** — schemas remain adapter-local. |
| Runtime/modules | Node >=22, ESM only | Node >=18 and dual ESM/CommonJS, matching the v6 reference branches | **MAPPED** — packaging differs; ACP behavior does not. |
| V4-only custom/reasoning-file/tagged-file shapes | Native | Not representable | **UNSUPPORTED-DOCUMENTED** — V3 downgrades only where this document defines a safe text/file mapping; otherwise it warns and omits. |
| Usage, finish reasons, text/reasoning/tool stream | V4 shapes | Equivalent V3 shapes | **MAPPED** — normalize once in the ACP core, convert in the adapter. |

## Major gaps shipped

The initial provider ships with these gaps visible. They are not hidden behind broad “AI SDK compatible” wording.

- **No AI SDK-defined tool execution.** Grok tools are runtime-owned and provider-executed. Application tools require a future MCP bridge or a new ACP execution channel.
- **No native structured-output guarantee.** JSON response format is prompt-level emulation with parse/schema validation and a compatibility warning.
- **No image, audio, or arbitrary binary input.** Grok 0.2.99 explicitly advertises image and audio as false. Only textual embedded context is partially supported.
- **No sampling or ordinary generation controls.** Temperature, top-p, top-k, penalties, stop sequences, seed, and maximum output tokens are ignored with typed warnings.
- **No enforceable `maxTurns`.** ACP exposes a completion reason, not an input control.
- **Model and reasoning-effort mutation is not proven.** Discovery is supported; changing the current values waits for a capability-advertised, fixture-verified route.
- **Cancellation ordering is captured; tool termination is not.** After `session/cancel`, Grok drains the in-flight turn with further update chunks, emits `prompt_complete` with `cancelled`, may emit more chunks after it, then resolves the prompt with `stopReason: "cancelled"`. The provider consumes updates until the prompt result. Whether an in-flight Grok tool stops remains unverified; the capture was a pure text turn.
- **Session restart replay is proven; edge cases are not.** `session/load` after a process restart replays history before the load response and restores recall. Invalid IDs, cross-CWD behavior, and concurrent prompts remain unverified.
- **Interactive permissions are proven absent in 0.2.99 (auto-executes).** Grok never sends `session/request_permission` over ACP and executes terminal and file-write tools regardless of permission mode, even with `yolo: false`. Treat every ACP session as always-approve and isolate side effects with `cwd`, environment, and `--sandbox` profiles. The live request handler stays capability-gated for future versions; AI SDK's deferred approval parts still do not match ACP's immediate RPC response.
- **Prompt-history roles are lossy on fresh sessions.** System, assistant, reasoning, and tool history are serialized as text because ACP prompt content has no role-history import.
- **Usage is detailed but not complete.** Cache reads and reasoning tokens map; cache writes, no-cache input, and independent text-output tokens remain `undefined`. No-cache input is not derived because the captured traces do not prove whether total input includes cached reads.
- **No source, generated-file, reasoning-file, or V4 custom-content events.** Tool output and xAI extensions stay tool/raw metadata rather than being relabeled.
- **No HTTP request surface.** Generic headers, response headers, proxies, and request/response bodies do not apply to stdio; MCP headers and process proxy environment are configured explicitly.
- **ACP extension drift remains a compatibility risk.** Unknown optional records are preserved as redacted raw events. Unknown completion, tool-identity, or permission events fail clearly rather than being discarded.
- **Harness parity is separate and incomplete.** A future v7 Harness adapter can map native turns and runtime tools, but suspend, destroy, host-tool submission, filtering, file-change, compaction, and lifecycle behavior have explicit gaps.
