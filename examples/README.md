# Examples

Build the provider, then run an example against an authenticated Grok CLI 1.x:

```sh
npm run build
npx tsx examples/basic-generate-text.ts
```

Prompts are intentionally small. Examples that invoke tools can modify the selected `cwd`; inspect their prompt and permission settings before running them.

| Example                     | Demonstrates                                 |
| --------------------------- | -------------------------------------------- |
| `basic-generate-text.ts`    | Compatible per-call `grokBuild` generation   |
| `streaming.ts`              | Reasoning and answer deltas                  |
| `tool-activity.ts`          | Provider-executed tool calls/results         |
| `session-continuity.ts`     | ACP `session/load` continuity                |
| `pooled-agent.ts`           | Persistent `grokAgent` and required teardown |
| `model-and-effort.ts`       | Session-scoped model/effort selection        |
| `exec-structured-output.ts` | Native schema output with `Output.object()`  |
| `exec-session-resume.ts`    | Headless resume/fork session flags           |
| `exec-flags.ts`             | Sandbox, tools, rules, and permission flags  |
| `exec-cancellation.ts`      | Headless abort and child cleanup             |
| `binary-resolution.ts`      | Explicit, trusted-package, and `npx` paths   |
| `abort-signal.ts`           | ACP cancellation                             |
| `provider-options.ts`       | Strict `"grok-build"` call options           |
| `usage-and-cost.ts`         | Usage and provider metadata                  |
| `error-handling.ts`         | Typed provider/CLI errors                    |

Every transport passes `permissionMode` explicitly. The examples enable broader permissions only where their prompt needs them. `grokAgent` examples always use `try/finally` so the provider pool is closed.
