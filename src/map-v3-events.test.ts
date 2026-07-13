import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type { AcpSessionUpdateParams } from "./acp/protocol.js";
import { GrokBuildV3StreamEmitter } from "./map-v3-events.js";

function harness(includeRawChunks = false): {
  emitter: GrokBuildV3StreamEmitter;
  parts: LanguageModelV3StreamPart[];
} {
  const parts: LanguageModelV3StreamPart[] = [];
  const controller = {
    enqueue: (part: LanguageModelV3StreamPart) => parts.push(part),
    close: () => undefined,
    error: () => undefined,
  } as unknown as ReadableStreamDefaultController<LanguageModelV3StreamPart>;
  return {
    emitter: new GrokBuildV3StreamEmitter(controller, includeRawChunks),
    parts,
  };
}

function update(value: Record<string, unknown>): AcpSessionUpdateParams {
  return {
    sessionId: "session-1",
    update: value,
  } as AcpSessionUpdateParams;
}

describe("GrokBuildV3StreamEmitter edge cases", () => {
  it("closes text before a tool call and resumes text with a new segment", () => {
    const { emitter, parts } = harness();
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-before",
        content: { type: "text", text: "before" },
      }),
    );
    emitter.emitUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Run command",
        rawInput: { command: "pwd" },
        _meta: { "x.ai/tool": { name: "run_terminal_command" } },
      }),
    );
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-after",
        content: { type: "text", text: "after" },
      }),
    );

    expect(parts.map((part) => part.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "text-start",
      "text-delta",
    ]);
    expect(parts[0]).toMatchObject({ id: "message-before" });
    expect(parts[7]).toMatchObject({ id: "message-after" });
  });

  it("preserves unknown optional updates and warns once per kind", () => {
    const { emitter, parts } = harness();
    const warnings: Array<{ type: string; feature?: string }> = [];
    emitter.emitStart(warnings as never[], "grok-4.5");
    emitter.emitUpdate(update({ sessionUpdate: "future_update", value: 1 }));
    emitter.emitUpdate(update({ sessionUpdate: "future_update", value: 2 }));
    expect(parts.filter((part) => part.type === "raw")).toHaveLength(3);
    expect(parts).toContainEqual({
      type: "raw",
      rawValue: expect.objectContaining({
        type: "grok-build-compatibility-warning",
      }),
    });
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "compatibility",
        feature: "ACP session/update 'future_update'",
      }),
    ]);
  });

  it("rejects malformed required and unknown completion-sensitive updates", () => {
    const { emitter } = harness();
    expect(() =>
      emitter.emitUpdate(
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "invalid" },
        }),
      ),
    ).toThrow("a text content block is required");
    expect(() =>
      emitter.emitUpdate(
        update({
          sessionUpdate: "tool_call",
          toolCallId: "missing-title-and-input",
        }),
      ),
    ).toThrow("'title' must be a non-empty string");
    expect(() =>
      emitter.emitUpdate(
        update({ sessionUpdate: "future_tool_complete", value: 1 }),
      ),
    ).toThrow("may affect completion");
  });

  it("segments consecutive chunks when ACP message IDs change", () => {
    const { emitter, parts } = harness();
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "first" },
      }),
    );
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "message-2",
        content: { type: "text", text: "second" },
      }),
    );
    expect(parts).toMatchObject([
      { type: "text-start", id: "message-1" },
      { type: "text-delta", id: "message-1", delta: "first" },
      { type: "text-end", id: "message-1" },
      { type: "text-start", id: "message-2" },
      { type: "text-delta", id: "message-2", delta: "second" },
    ]);
  });

  it("emits extension noise only when explicitly forwarded as raw", () => {
    const { emitter, parts } = harness();
    emitter.emitExtension({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: { update: { sessionUpdate: "hook_execution" } },
    });
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "still ordered" },
      }),
    );
    expect(parts.map((part) => part.type)).toEqual([
      "raw",
      "text-start",
      "text-delta",
    ]);
  });

  it("redacts secrets in raw extensions and canonical tool data", () => {
    const { emitter, parts } = harness(true);
    emitter.emitExtension({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      },
    });
    emitter.emitUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "secret-call",
        title: "Run",
        rawInput: {
          command: "XAI_API_KEY=secret-value run",
          env: [{ name: "SAFE_NAME", value: "secret-env-value" }],
        },
      }),
    );
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("secret-env-value");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it("deduplicates repeated terminal tool updates but preserves progress", () => {
    const { emitter, parts } = harness();
    emitter.emitUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Run",
        rawInput: {},
      }),
    );
    for (const status of ["in_progress", "completed", "completed"]) {
      emitter.emitUpdate(
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status,
          rawOutput: { status },
        }),
      );
    }
    const results = parts.filter((part) => part.type === "tool-result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ preliminary: true });
    expect(results[1]).not.toHaveProperty("preliminary");
  });

  it("rejects completion when a provider-executed tool has no final result", () => {
    const { emitter } = harness();
    emitter.emitUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "unfinished-call",
        title: "Run",
        rawInput: {},
      }),
    );
    expect(() =>
      emitter.emitFinish(
        { unified: "stop", raw: "end_turn" },
        {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined,
          },
        },
        {},
      ),
    ).toThrow("before tool call 'unfinished-call' emitted a final result");
  });
});
