import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { generateText, Output, streamText } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  GrokExecLanguageModel,
  type ExecChildProcess,
  type ExecSpawnFactory,
} from "./grok-exec-language-model.js";

class IntegrationChild extends EventEmitter implements ExecChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

function modelWithOutput(
  output: string,
  capture: { args?: readonly string[] },
) {
  const spawn: ExecSpawnFactory = (_command, args) => {
    capture.args = [...args];
    const child = new IntegrationChild();
    queueMicrotask(() => {
      child.stdout.write(output);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  };
  return new GrokExecLanguageModel({
    id: "grok-4.6",
    settings: { executablePath: "/fake/grok", includeRawChunks: true },
    spawn,
  });
}

describe("AI SDK v7 integration", () => {
  it("uses generateText with Output.object and preserves ref-based schemas", async () => {
    const capture: { args?: readonly string[] } = {};
    const model = modelWithOutput(
      JSON.stringify({
        structuredOutput: { name: "Ada" },
        stopReason: "EndTurn",
        sessionId: "structured-session",
        requestId: "structured-request",
        usage: { input_tokens: 4, output_tokens: 2 },
      }),
      capture,
    );
    const schema = z.object({ name: z.string() });
    const result = await generateText({
      model,
      output: Output.object({ schema }),
      prompt: "Return a person.",
    });
    expect(result.output).toEqual({ name: "Ada" });
    expect(result.finishReason).toBe("stop");
    expect(result.finalStep.providerMetadata?.["grok-build"]).toMatchObject({
      sessionId: "structured-session",
      requestId: "structured-request",
    });
    const schemaIndex = capture.args?.indexOf("--json-schema") ?? -1;
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(JSON.parse(capture.args?.[schemaIndex + 1] ?? "null")).toMatchObject(
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    );
  });

  it("streams text, provider-executed tools, warnings, usage, and finish metadata", async () => {
    const capture: { args?: readonly string[] } = {};
    const output = [
      { type: "future_notice", value: true },
      { type: "text", data: "hello" },
      {
        type: "tool_call",
        toolCallId: "call",
        toolName: "read_file",
        rawInput: { path: "README.md" },
      },
      {
        type: "tool_call_update",
        toolCallId: "call",
        status: "completed",
        rawOutput: { text: "done" },
      },
      {
        type: "end",
        stopReason: "EndTurn",
        sessionId: "stream-session",
        requestId: "stream-request",
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    const result = streamText({
      model: modelWithOutput(`${output}\n`, capture),
      prompt: "Inspect a file.",
    });
    const types: string[] = [];
    for await (const part of result.fullStream) types.push(part.type);
    await expect(result.text).resolves.toBe("hello");
    await expect(result.finishReason).resolves.toBe("stop");
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
    });
    expect(types).toEqual(
      expect.arrayContaining(["text-delta", "tool-call", "tool-result"]),
    );
    await expect(result.warnings).resolves.toContainEqual(
      expect.objectContaining({
        type: "compatibility",
        feature: "Grok headless event 'future_notice'",
      }),
    );
  });
});
