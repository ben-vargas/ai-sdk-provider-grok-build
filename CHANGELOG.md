# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- Initial AI SDK v6 `LanguageModelV3` / `ProviderV3` provider for Grok Build.
- ACP protocol v1 transport over `grok --no-auto-update agent stdio`, including JSON-RPC request correlation, NDJSON framing, cancellation, process cleanup, and typed errors.
- Cached Grok CLI authentication through ACP `cached_token` by default, with explicit `XAI_API_KEY` support through `authMethod: 'api_key'`.
- Streaming and non-streaming assistant text, reasoning, provider-executed Grok tool calls/results, finish reasons, usage, and provider metadata.
- ACP session creation and explicit session loading through call-level `providerOptions['grok-build']`.
- Provider settings and strict call options for working directory, environment, authentication, permissions, MCP servers, timeouts, raw events, model requests, and reasoning-effort requests.
- Textual embedded-resource input and prompt-level JSON response-format emulation with compatibility warnings.
- Documentation for cached-login and API-key authentication, ACP transport selection, settings, provider options, provider-executed tool visibility, explicit session continuity, version branches, and known limitations.

### Compatibility

- Requires Node.js 18 or newer, AI SDK 6 for integration, `@ai-sdk/provider ^3`, and `@ai-sdk/provider-utils ^4`; supports Zod 3 or 4.
- Dual ESM and CommonJS package output.
- Validated against captured Grok Build 0.2.99 ACP traffic.
