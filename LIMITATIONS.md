# Known limitations

This document covers package 1.1 on the AI SDK v7 `main` line and Grok CLI 1.x.

## Tool ownership

Grok executes its own shell, filesystem, search, fetch, and MCP tools. The provider emits correlated, dynamic `providerExecuted: true` tool calls and results; applications must not execute them again.

Neither ACP 1 nor Grok headless mode provides a channel for registering arbitrary AI SDK function tools and submitting application-produced results. AI SDK `tools` and non-default `toolChoice` therefore produce warnings. Configure Grok-native tools or MCP servers instead.

Tool side effects already started by Grok cannot be rolled back when a call is cancelled.

## Permissions

ACP permission requests need an immediate JSON-RPC answer, unlike AI SDK's deferred approval flow. The provider invokes `onPermissionRequest` when supplied. Without it, requests fail closed; only explicit `alwaysApprove`, `bypassPermissions`, or dangerous bypass can select an allow option automatically.

The provider always passes a permission mode explicitly. `grokExec` defaults to `dontAsk` because its headless child has no interactive permission-response channel; ACP defaults to `default` and answers permission requests through JSON-RPC. `dangerouslySkipPermissions` bypasses ordinary approval and sandbox protection and should be used only in an isolated environment. Permission behavior remains a Grok runtime boundary, so also constrain `cwd`, sandbox, tool lists, environment, and allow/deny rules.

## Structured output

Native constrained output exists only in `grokExec`, which passes an unchanged schema to `--json-schema`. `$ref`, `$defs`, formats, and validation keywords are retained. Grok schema mode is non-streaming, so the AI SDK stream receives one final JSON text payload. JSON output without a schema uses prompt guidance and emits a compatibility warning.

ACP (`grokBuild` and `grokAgent`) has no schema channel. Its JSON response format is prompt-engineered and may fail parsing or validation.

## Prompt and media input

Fresh AI SDK history is serialized into an explicit transcript. This does not reproduce native system precedence or provider-executed tool state. Private reasoning is omitted. Completed tool history is retained as text.

Inline and local textual files are supported. Images, audio, arbitrary binary files, remote HTTP file fetching, custom parts, and reasoning files are warned about and omitted. Use a multimodal provider or extract content to UTF-8 text first.

## Generation controls

Sampling controls, stop sequences, seeds, and maximum output tokens have no matching Grok CLI/ACP inputs and produce warnings. ACP cannot enforce `maxTurns`; headless mode can through `--max-turns`.

## Sessions

ACP supports explicit `session/load`. `grokBuild` starts a new process and loads the session; `grokAgent` can reuse its pool. ACP does not expose verified most-recent-session lookup or fork operations, so its `continue` and `fork` inputs warn and create a new session as documented.

Headless mode maps current Grok 1.x `--resume`, `--continue`, `--fork-session`, and `--session-id` semantics. Resume and continue are mutually exclusive, fork requires one of them, and an ID creates a new session or names a fork.

Invalid/expired IDs and cross-directory behavior are controlled by Grok and surface as typed process/protocol errors. Store an application transcript or summary as a recovery path.

## Usage

ACP maps Grok's total input, cache-read, total output, and reasoning tokens when present, while leaving no-cache and cache-write input undefined. For Grok/Anthropic-style headless records, `input_tokens` is non-cached input and total input is the sum of it, cache reads, and cache creation. For OpenAI-style records, `input_tokens`/`prompt_tokens` is already total and `cached_tokens` is subtracted for no-cache input when valid. Independent text-output counts remain undefined unless Grok reports them directly. Headless terminal `end` usage is authoritative; earlier `usage` records are diagnostic raw events.

## Protocol drift

The ACP client requires protocol version 1. Unknown benign ACP/headless events are redacted, emitted as raw data, and warn once per kind. Malformed required events or unknown records that can affect completion, usage, permission decisions, or tool correlation fail rather than guessing.

The provider is Node-only, ESM-only, and requires Grok CLI `>=1.0.0`. It does not implement embeddings, image generation, transcription, speech, reranking, provider files, or provider skills.

Windows requires a native Grok executable through `PATH` or `executablePath`; PATH lookup skips `.cmd`/`.bat` shims while explicit script paths remain typed errors, and the `npx` fallback is intentionally unsupported. Package-bin discovery rooted at `cwd` is disabled unless `allowPackageBin: true` explicitly trusts that directory.
