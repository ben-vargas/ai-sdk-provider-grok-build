import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import type { AcpSessionUpdateParams } from "./acp/protocol.js";
import { GrokBuildV4StreamEmitter } from "./map-v4-events.js";

function harness(includeRawChunks = false): {
  emitter: GrokBuildV4StreamEmitter;
  parts: LanguageModelV4StreamPart[];
} {
  const parts: LanguageModelV4StreamPart[] = [];
  const controller = {
    enqueue: (part: LanguageModelV4StreamPart) => parts.push(part),
    close: () => undefined,
    error: () => undefined,
  } as unknown as ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  return {
    emitter: new GrokBuildV4StreamEmitter(controller, includeRawChunks),
    parts,
  };
}

function update(value: Record<string, unknown>): AcpSessionUpdateParams {
  return {
    sessionId: "session-1",
    update: value,
  } as AcpSessionUpdateParams;
}

describe("GrokBuildV4StreamEmitter edge cases", () => {
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

  it("ignores unknown and malformed session update variants", () => {
    const { emitter, parts } = harness();
    emitter.emitUpdate(update({ sessionUpdate: "future_update", value: 1 }));
    emitter.emitUpdate(
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "ignored" },
      }),
    );
    emitter.emitUpdate(
      update({
        sessionUpdate: "tool_call",
        toolCallId: "missing-title-and-input",
      }),
    );
    expect(parts).toEqual([]);
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
});
