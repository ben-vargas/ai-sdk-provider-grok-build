import { describe, expect, it } from "vitest";
import {
  HeadlessEventNormalizer,
  isHeadlessTerminalEvent,
} from "./headless-events.js";

describe("HeadlessEventNormalizer strictness", () => {
  it.each([[null], [[]], ["text"], [1]])(
    "rejects non-object output %#",
    (value) => {
      expect(() => new HeadlessEventNormalizer().normalize(value)).toThrow(
        "JSON objects",
      );
    },
  );

  it("rejects missing event types and malformed text", () => {
    expect(() =>
      new HeadlessEventNormalizer().normalize({ data: "x" }),
    ).toThrow("must be a non-empty string");
    expect(() =>
      new HeadlessEventNormalizer().normalize({ type: "text", data: 1 }),
    ).toThrow("'data' must be a string");
  });

  it("accepts snake-case tool fields and correlates failed results", () => {
    const normalizer = new HeadlessEventNormalizer();
    expect(
      normalizer.normalize({
        type: "tool_call",
        tool_call_id: "call",
        tool_name: "shell",
        raw_input: { command: "false" },
      }),
    ).toContainEqual(
      expect.objectContaining({
        kind: "tool-call",
        toolCallId: "call",
        toolName: "shell",
        title: "shell",
      }),
    );
    expect(
      normalizer.normalize({
        type: "tool_call_update",
        tool_call_id: "call",
        status: "failed",
      }),
    ).toContainEqual(
      expect.objectContaining({
        kind: "tool-result",
        isError: true,
        preliminary: false,
      }),
    );
    expect(normalizer.finish()).toEqual([]);
  });

  it("rejects malformed and uncorrelated tool records", () => {
    const normalizer = new HeadlessEventNormalizer();
    expect(() =>
      normalizer.normalize({ type: "tool_call", toolName: "shell" }),
    ).toThrow("toolCallId");
    expect(() =>
      normalizer.normalize({
        type: "tool_call_update",
        toolCallId: "missing",
        status: "completed",
      }),
    ).toThrow("cannot be correlated");
  });

  it("rejects duplicate tool-call IDs before replacing correlation state", () => {
    const normalizer = new HeadlessEventNormalizer();
    normalizer.normalize({
      type: "tool_call",
      id: "call",
      name: "first",
      input: {},
    });
    expect(() =>
      normalizer.normalize({
        type: "tool_call",
        id: "call",
        name: "second",
        input: {},
      }),
    ).toThrow("Duplicate Grok tool call ID 'call'");
    expect(
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        status: "completed",
      }),
    ).toContainEqual(expect.objectContaining({ toolName: "first" }));
  });

  it("rejects unknown statuses and non-final updates after completion", () => {
    const normalizer = new HeadlessEventNormalizer();
    normalizer.normalize({
      type: "tool_call",
      id: "call",
      name: "tool",
      input: {},
    });
    expect(() =>
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        status: "mystery",
      }),
    ).toThrow("Unknown Grok tool status");
    normalizer.normalize({
      type: "tool_call_update",
      id: "call",
      status: "completed",
      output: "done",
    });
    expect(
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        status: "completed",
      }),
    ).toHaveLength(1);
    expect(() =>
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        status: "pending",
      }),
    ).toThrow("after its final result");
    expect(
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        output: { progress: 100 },
      }),
    ).toEqual([expect.objectContaining({ kind: "raw", conditional: true })]);
  });

  it("fails completion when a tool call has no final result", () => {
    const normalizer = new HeadlessEventNormalizer();
    normalizer.normalize({
      type: "tool_call",
      id: "call",
      name: "tool",
      input: {},
    });
    expect(() => normalizer.finish()).toThrow("before tool call 'call'");
  });

  it("treats status-less tool updates as progress and still requires a final update", () => {
    const normalizer = new HeadlessEventNormalizer();
    normalizer.normalize({
      type: "tool_call",
      id: "call",
      name: "tool",
      input: {},
    });
    expect(
      normalizer.normalize({
        type: "tool_call_update",
        id: "call",
        output: { progress: 50 },
      }),
    ).toHaveLength(1);
    expect(() => normalizer.finish()).toThrow("before tool call 'call'");
    normalizer.normalize({
      type: "tool_call_update",
      id: "call",
      status: "completed",
    });
    expect(normalizer.finish()).toEqual([]);
  });

  it("preserves unrelated and auto-compact event names as optional", () => {
    const normalizer = new HeadlessEventNormalizer();
    for (const type of [
      "auto_compact_completed",
      "max_turns_reached",
      "weekend_notice",
    ]) {
      expect(normalizer.normalize({ type })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "compatibility-warning" }),
        ]),
      );
    }
  });

  it.each([
    "usage_delta",
    "completion_update",
    "session_end",
    "pre_tool_call",
    "permission-result",
  ])("rejects unknown semantic event family %s", (type) => {
    expect(() => new HeadlessEventNormalizer().normalize({ type })).toThrow(
      "may affect completion, usage, permissions, or tool correlation",
    );
  });

  it("surfaces explicit error event messages", () => {
    expect(() =>
      new HeadlessEventNormalizer().normalize({
        type: "error",
        message: "Not signed in",
      }),
    ).toThrow("Not signed in");
  });

  it("recognizes only valid terminal events", () => {
    expect(
      isHeadlessTerminalEvent({ type: "end", stopReason: "EndTurn" }),
    ).toBe(true);
    expect(isHeadlessTerminalEvent({ type: "end" })).toBe(false);
    expect(isHeadlessTerminalEvent({ type: "end", stopReason: "" })).toBe(
      false,
    );
    expect(isHeadlessTerminalEvent(null)).toBe(false);
  });
});
