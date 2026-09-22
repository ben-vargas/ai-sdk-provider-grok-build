# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added opt-in `allowPackageBin`, bounded/abortable version checks, headless prompt deadlines, strict filesystem settings, and a Windows Node 22 CI job.
- Added `maxClients` for pooled agents, with a default of eight, idle LRU eviction, and `POOL_CAPACITY_EXCEEDED` when every client is active.
- Added low-level, idempotent ACP client leases and an authenticated, opt-in `npm run test:live` smoke test.

### Changed

- CLI resolution no longer executes packages from `cwd` unless explicitly trusted. This is a security migration for the next minor release. Windows now requires a native executable and rejects `.cmd`, `.bat`, and `npx` launchers.
- Permission mode is always explicit: headless execution defaults to `dontAsk`, while ACP defaults to `default`. Version collection waits for process close, ACP initialization is abort-isolated, queued prompts cancel immediately, session loads/configuration serialize with prompts, and pooled teardown remains mandatory.
- Headless usage now handles both component-based Grok/Anthropic accounting and total-inclusive OpenAI accounting without double-counting. Optional event compatibility and error-message preservation are more precise.

### Fixed

- Prevented per-call reasoning effort from mutating model defaults, replayed session history from leaking into live output, and post-dispatch failures from being retried.
- Prompt timeouts now cancel or terminate their active work before releasing resources, and missing terminal records/non-zero exits are non-retryable.
- Pool identity now uses effective process and callback options; active generation leases prevent live clients from being evicted, and `close()` drains rejected detached disposals.
- Initialization/session extension notifications are captured before session creation and filtered to their owning session, while Windows PATH lookup continues past script shims to native executables.
- Metadata-only headless tool updates after a final result are ignored, while regressive pending/in-progress updates still fail; CI uses least-privilege tokens with commit-pinned actions.
- ACP callbacks and agent requests are FIFO within each session while independent sessions continue concurrently. Responses preserve update-before-result ordering, but timeout, abort, disposal, and process-failure settlement remain active while callbacks flush; stale queued prompt callbacks are skipped. Queued and running permission requests honor session cancellation, in-flight handlers keep pooled clients active, and consumer callback failures remain isolated.
- Terminal stdin failures defer briefly to process-exit diagnostics without blocking disposal, while other live-process stdin errors fail immediately. Pools retire diagnostic-pending clients and create replacements without interrupting their in-flight work, then include retired clients in bounded teardown. Process-output draining retains its independent bound, runtime child errors trigger termination, and crash-truncated JSON now preserves the process-exit diagnostic with the parse failure as its cause.
- ACP response validation now lives at the low-level client boundary, normalizes omitted and null protocol defaults and reasoning fields, accepts null authenticate responses, validates prompt results, accepts grouped/boolean/future configuration options, and redacts malformed payloads.
- Authentication is recognized only from known ANSI-safe, structured stderr diagnostics; diagnostic leads and qualified logger targets are distinguished, and optional low-severity API-key warnings are not promoted to login failures. ACP authentication-required `-32000` is method-independent, while the legacy `-32603` compatibility fallback accepts anchored credential diagnostics only from authentication, initialization, session creation/loading, and session configuration. Generic pre-dispatch internal errors remain retryable; prompt and unknown-method internal errors are never text-classified as provider authentication.
- ACP session authentication retries now run only when the configured method is advertised; a configured method missing from a non-empty advertised list retains `AUTH_METHOD_NOT_AVAILABLE`, while an empty list preserves the original wire failure. Retry context is attached to fresh errors without mutating shared failures or caller abort reasons, and aggregate causes retain both the initial and retry failures. Diagnostics are selected, redacted, and classified per line; structured diagnostic data has a hard 8 KiB serialized limit. Request failures no longer claim process-wide stderr except during exclusive initialization, and provider remediation now follows the authentication method actually used. Direct `AcpClient.loadSession()` calls retain their established `AcpJsonRpcError` contract.
- Labeled diagnostic credentials now remain redacted across quoted JSON keys, line breaks, long-line tail selection, and non-Bearer authorization schemes. Structured error data uses exact bounded accounting, collision-safe keys, and bounded string work, while initialization keeps authoritative terminal error identity and preserves request-local source errors as causes.
- Per-call `dangerouslySkipPermissions: false` overrides only that provider default. Custom client factories retain ownership of ACP arguments unless they opt into `validateCli`, and explicit null structured results and legacy `{ result: null }` output semantics remain unchanged while valid legacy text remains supported.

## [1.1.0] - 2026-09-16

### Added

- Pooled `grokAgent` ACP provider with per-session serialization, stale-client replacement, `close()`, and async disposal.
- Stateless `grokExec` provider with incremental Grok 1.x NDJSON parsing, full headless flag coverage, bounded structured output, and request-local session metadata.
- Native AI SDK 7 structured output through unchanged `--json-schema` payloads, including `$ref` and `$defs`.
- Shared Grok CLI resolver, cached `>=1.0.0` version gate, opt-in `npx` fallback, expanded settings, Grok 1.x fixtures, documentation validation, and package import smoke testing.

### Changed

- ACP model and reasoning effort selection now uses advertised `session/set_config_option` choices.
- Permission modes cover all six Grok CLI values while unhandled ACP permission requests remain fail-closed.
- Version metadata is synchronized at `1.1.0`; documentation and limitations now describe Grok CLI 1.x and all three provider modes.

## [1.0.0] - 2026-07-13

### Changed

- Adopted per-generation version lines: `1.x` tracks AI SDK v7 (`latest`), `0.2.x` tracks AI SDK v6 (dist-tag `ai-sdk-v6`). Functionally identical to `0.1.1`; the early `0.1.x` and `0.1.x-ai-sdk-v6` versions are deprecated because their prerelease-suffixed scheme broke caret-range updates for the v6 line.

## [0.1.1] - 2026-07-13

### Fixed

- Removed a spurious `headers` unsupported-setting warning emitted on every call: the AI SDK core injects a `user-agent` header into each request, which the provider mistook for caller-set headers. The warning now fires only for real caller-supplied header entries.
- `stopSequences: []` no longer warns; the warning fires only for non-empty stop sequences.

### Changed

- Examples hardened to self-verify their stated intent with clearer output; deliberate warning demonstration now lives only in `provider-options.ts`.

## [0.1.0] - 2026-07-12

### Added

- Initial AI SDK v7 `LanguageModelV4` / `ProviderV4` provider for Grok Build.
- ACP protocol v1 transport over `grok --no-auto-update agent stdio`, including JSON-RPC request correlation, NDJSON framing, cancellation, process cleanup, and typed errors.
- Cached Grok CLI authentication through ACP `cached_token` by default, with explicit `XAI_API_KEY` support through `authMethod: 'api_key'`.
- Streaming and non-streaming assistant text, reasoning, provider-executed Grok tool calls/results, finish reasons, usage, and provider metadata.
- ACP session creation and explicit session loading through call-level `providerOptions['grok-build']`.
- Provider settings and strict call options for working directory, environment, authentication, permissions, MCP servers, timeouts, raw events, model requests, and reasoning-effort requests.
- Textual embedded-resource input and prompt-level JSON response-format emulation with compatibility warnings.
- Documentation for cached-login and API-key authentication, ACP transport selection, settings, provider options, provider-executed tool visibility, explicit session continuity, version branches, and known limitations.

### Compatibility

- Requires Node.js 22 or newer, AI SDK `^7.0.16`, `@ai-sdk/provider ^4.0.2`, `@ai-sdk/provider-utils ^5.0.5`, and Zod 4.
- ESM-only package output.
- Validated against captured Grok Build 0.2.99 ACP traffic, including live fixtures for session restart/load replay, cancellation ordering (`stopReason: "cancelled"`), and the absence of `session/request_permission` enforcement over ACP in 0.2.99.
