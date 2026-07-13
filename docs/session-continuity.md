# Session continuity

Grok Build ACP returns a session ID for each new session. The provider places that ID in final provider metadata so a later model call can load the same Grok session.

Persist the ID only after the call reaches its final step. An aborted or failed call may not produce terminal provider metadata.

## Continue an explicit session

```typescript
import { generateText } from "ai";
import { grokBuild } from "ai-sdk-provider-grok-build";

const first = await generateText({
  model: grokBuild(),
  prompt: "Review the project and remember the two highest-risk files.",
});

const sessionId = first.providerMetadata?.["grok-build"]?.sessionId;
if (typeof sessionId !== "string") {
  throw new Error("Missing Grok Build session ID");
}

const second = await generateText({
  model: grokBuild(),
  prompt: "Explain the first risk in more detail.",
  providerOptions: {
    "grok-build": {
      session: { id: sessionId },
    },
  },
});
```

`session.resume` accepts the same explicit ID and currently has the same load behavior. `session.id` and `session.resume` are mutually exclusive.

The provider does not keep an ACP process alive between these calls. The second call starts a new process and asks Grok to load the stored ID.

## Working directory and MCP servers

Each call starts a new `grok agent stdio` process. Loading a session sends the current resolved `cwd` and merged MCP server list with `session/load`:

```typescript
import { createGrokBuild } from "ai-sdk-provider-grok-build";

const provider = createGrokBuild({
  cwd: "/absolute/path/to/project",
  mcpServers: [],
});
```

Keep `cwd` and MCP configuration stable across calls. Cross-directory session loading and replay with changed MCP servers are not fixture-verified.

## Unsupported shortcuts

`session.continue: true` does not search for the most recent session. ACP exposes no verified most-recent-session lookup, so the provider warns and creates a new session unless an explicit ID is also supplied.

`session.fork: true` does not clone a session. ACP does not advertise a fork operation. The provider warns and creates a new session rather than loading or mutating the supplied source session.

## Current verification boundary

Real captures prove `session/new`, returned session IDs, and the presence of the advertised `loadSession` capability. Unit coverage verifies that an explicit ID selects `session/load` instead of `session/new`. Live fixture coverage does not yet establish:

- replay ordering after the original ACP process exits;
- behavior for missing, expired, or malformed IDs;
- cross-`cwd` loading;
- concurrent prompts against one session;
- whether every xAI extension event is replayed;
- fork or most-recent-session lookup semantics.

For that reason, every session load includes an AI SDK compatibility warning. Treat explicit continuity as an available but still compatibility-sensitive path, and store enough application state to recover by starting a fresh session if loading fails.

A practical recovery policy is to retain the user-visible transcript separately, attempt the explicit load once, and start a new session with a concise text summary if Grok rejects or cannot replay the ID. Replaying the entire AI SDK history is not equivalent to loading the ACP session, as described below.

## Fresh-session history is not native continuity

Passing prior AI SDK messages into a new call is different from loading the ACP session. ACP `session/prompt` has no arbitrary role-history import field. The provider therefore:

- wraps system, user, assistant, and tool history in labeled transcript text;
- omits private reasoning history with a warning;
- reduces tool calls/results and approval responses to textual audit markers;
- does not recreate provider-executed tool identity or live permission state.

Use an explicit ACP session ID when real Grok session continuity matters.
