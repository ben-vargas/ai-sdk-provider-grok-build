# Session continuity

Every terminal finish exposes a request-local session ID under `providerMetadata["grok-build"].sessionId`. Persist it only after a call finishes successfully.

## ACP sessions

`grokBuild` and `grokAgent` load an explicit ID with ACP `session/load`:

```ts
import { generateText } from "ai";
import { createGrokAgent } from "ai-sdk-provider-grok-build";

const agent = createGrokAgent();
try {
  const first = await generateText({
    model: agent("grok-4.6"),
    prompt: "Remember the word marigold.",
  });
  const sessionId = first.finalStep.providerMetadata?.["grok-build"]?.sessionId;
  if (typeof sessionId !== "string") throw new Error("Missing session ID");

  await generateText({
    model: agent("grok-4.6"),
    prompt: "What word did I ask you to remember?",
    providerOptions: { "grok-build": { session: { id: sessionId } } },
  });
} finally {
  await agent.close();
}
```

`grokBuild` starts a fresh process for the second call and asks Grok to replay the stored session. `grokAgent` may reuse its provider-local client. Prompts targeting the same session are serialized; prompts for different sessions may run concurrently.

ACP has no verified most-recent-session lookup or fork operation. `continue` and `fork` therefore warn and create a new session. Use an explicit ID for ACP continuity.

## Headless sessions

`grokExec` maps Grok 1.x session flags directly:

```ts
import { grokExec } from "ai-sdk-provider-grok-build";

const resumed = grokExec("grok-4.6", {
  session: { resume: previousSessionId },
});

const forked = grokExec("grok-4.6", {
  session: {
    resume: previousSessionId,
    fork: true,
    id: "00000000-0000-4000-8000-000000000001",
  },
});
```

Validation matches the CLI:

- `resume` and `continue` cannot both be set;
- `fork` requires `resume` or `continue`;
- `id` creates a new session, or names the new fork when combined with resume/continue and fork.

Keep `cwd` stable when relying on most-recent sessions or title-based resume. Invalid, expired, ambiguous, and cross-directory session behavior is reported by Grok. Retain an application-level transcript or summary so a failed load can recover with a new session.
