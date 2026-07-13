# Examples

Build the provider, then run any example against the locally authenticated Grok CLI:

```sh
npm run build
npx tsx examples/basic-generate-text.ts
```

The default authentication method is `cached_token`, which reuses the login stored by the
Grok CLI. Run `grok login` first if needed. `XAI_API_KEY` is supported separately by creating
a provider with `authMethod: "api_key"`.

| Example                  | Demonstrates                                             |
| ------------------------ | -------------------------------------------------------- |
| `basic-generate-text.ts` | `generateText` and the returned ACP session ID           |
| `streaming.ts`           | visible reasoning and answer deltas                      |
| `tool-activity.ts`       | provider-executed tool calls and results                 |
| `session-continuity.ts`  | resuming an ACP session ID for a second call             |
| `abort-signal.ts`        | cancelling a stream with `AbortSignal`                   |
| `error-handling.ts`      | handling a bad requested model ID                        |
| `usage-and-cost.ts`      | AI SDK usage, per-model ACP usage, and cost availability |
| `provider-options.ts`    | call-level `reasoningEffort` and `permissionMode`        |

Prompts are intentionally small. `tool-activity.ts` permits provider-executed tools without an
interactive approval prompt and asks Grok to perform one read-only terminal operation.
