import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  GrokExecLanguageModel,
  type ExecChildProcess,
  type ExecSpawnFactory,
} from "./grok-exec-language-model.js";

class FixtureExecChild extends EventEmitter implements ExecChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: NodeJS.Signals[] = [];
  private closed = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.finish(null, signal);
    return true;
  }

  writeChunks(output: string, pieces = 3): void {
    const size = Math.max(1, Math.floor(output.length / pieces));
    for (let offset = 0; offset < output.length; offset += size) {
      if (this.closed) break;
      this.stdout.write(output.slice(offset, offset + size));
    }
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

function callOptions(
  text = "hello",
  extra: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    ...extra,
  };
}

function headlessFixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/headless-1x/${name}`, import.meta.url),
    "utf8",
  );
}

function fixtureModel(
  output: string | ((child: FixtureExecChild) => void),
  settings: ConstructorParameters<
    typeof GrokExecLanguageModel
  >[0]["settings"] = {},
): {
  model: GrokExecLanguageModel;
  child: FixtureExecChild;
  args: string[];
  prompt: () => string;
} {
  const child = new FixtureExecChild();
  const args: string[] = [];
  let promptPath = "";
  let promptContents = "";
  const spawn: ExecSpawnFactory = (_command, passedArgs) => {
    args.push(...passedArgs);
    promptPath = passedArgs[passedArgs.indexOf("--prompt-file") + 1] ?? "";
    promptContents = readFileSync(promptPath, "utf8");
    queueMicrotask(() => {
      if (typeof output === "string") {
        child.writeChunks(output);
        child.finish();
      } else {
        output(child);
      }
    });
    return child;
  };
  return {
    model: new GrokExecLanguageModel({
      id: "grok-4.6",
      settings: { executablePath: "/fake/grok", ...settings },
      spawn,
    }),
    child,
    args,
    prompt: () => promptContents,
  };
}

const textToolFixture = [
  { type: "thought", data: "thinking" },
  { type: "text", data: "hello" },
  {
    type: "tool_call",
    toolCallId: "tool-1",
    toolName: "read_file",
    title: "Read file",
    rawInput: { path: "README.md", apiKey: "secret" },
  },
  {
    type: "tool_call_update",
    toolCallId: "tool-1",
    status: "in_progress",
    rawOutput: { status: "reading" },
  },
  {
    type: "tool_call_update",
    toolCallId: "tool-1",
    status: "completed",
    rawOutput: { text: "done" },
  },
  { type: "usage", usage: { input_tokens: 999 } },
  {
    type: "end",
    stopReason: "EndTurn",
    sessionId: "session-one",
    requestId: "request-one",
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      output_tokens: 3,
      reasoning_tokens: 2,
    },
    modelUsage: { "grok-4.6": { inputTokens: 10 } },
  },
]
  .map((value) => JSON.stringify(value))
  .join("\n");

describe("GrokExecLanguageModel", () => {
  it.each([
    {
      fixture: "text-only.jsonl",
      text: "Hello from Grok.",
      sessionId: "00000000-0000-4000-8000-000000000101",
    },
    {
      fixture: "tool-use.jsonl",
      text: "I read the file.",
      sessionId: "00000000-0000-4000-8000-000000000102",
    },
  ])("parses sanitized Grok 1.x $fixture", async (fixture) => {
    const { model } = fixtureModel(headlessFixture(fixture.fixture));
    const result = await model.doGenerate(callOptions());
    expect(result.content).toContainEqual({
      type: "text",
      text: fixture.text,
    });
    expect(result.providerMetadata?.["grok-build"]?.sessionId).toBe(
      fixture.sessionId,
    );
  });

  it("incrementally maps Grok 1.x text, reasoning, tools, terminal usage, and metadata", async () => {
    const { model } = fixtureModel(`${textToolFixture}\n`);
    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "thinking" }),
        expect.objectContaining({ type: "text", text: "hello" }),
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read_file",
        }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "tool-1",
        }),
      ]),
    );
    expect(result.usage).toMatchObject({
      inputTokens: {
        total: 16,
        noCache: 10,
        cacheRead: 4,
        cacheWrite: 2,
      },
      outputTokens: { total: 3, reasoning: 2 },
    });
    expect(result.finishReason).toEqual({ unified: "stop", raw: "EndTurn" });
    expect(result.providerMetadata?.["grok-build"]).toMatchObject({
      sessionId: "session-one",
      requestId: "request-one",
      resolvedModel: "grok-4.6",
    });
  });

  it("passes every supported headless flag and serializes transcript history", async () => {
    const { model, args, prompt } = fixtureModel(`${textToolFixture}\n`, {
      reasoningEffort: "xhigh",
      sandbox: "workspace-write",
      permissionMode: "dontAsk",
      alwaysApprove: true,
      allowRules: ["shell:git status"],
      denyRules: ["shell:rm"],
      allowedTools: ["shell", "read_file"],
      disallowedTools: ["write_file"],
      maxTurns: 4,
      webSearch: false,
      systemPromptOverride: "system",
      appendRules: "rules",
      noPlan: true,
      noSubagents: true,
      session: {
        resume: "source-session",
        fork: true,
        id: "00000000-0000-4000-8000-000000000001",
      },
    });
    await model.doGenerate(
      callOptions("next", {
        prompt: [
          { role: "system", content: "be concise" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "old-call",
                toolName: "read_file",
                input: { path: "a.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "old-call",
                toolName: "read_file",
                output: { type: "text", value: "contents" },
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: "next" }] },
        ],
      }),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-auto-update",
        "--output-format",
        "streaming-json",
        "--model",
        "grok-4.6",
        "--reasoning-effort",
        "xhigh",
        "--sandbox",
        "workspace-write",
        "--permission-mode",
        "dontAsk",
        "--always-approve",
        "--allow",
        "shell:git status",
        "--deny",
        "shell:rm",
        "--tools",
        "shell,read_file",
        "--disallowed-tools",
        "write_file",
        "--max-turns",
        "4",
        "--disable-web-search",
        "--system-prompt-override",
        "system",
        "--rules",
        "rules",
        "--no-plan",
        "--no-subagents",
        "--resume",
        "source-session",
        "--fork-session",
        "--session-id",
        "00000000-0000-4000-8000-000000000001",
      ]),
    );
    expect(prompt()).toContain("[SYSTEM]\nbe concise");
    expect(prompt()).toContain("[TOOL CALL read_file old-call]");
    expect(prompt()).toContain("[TOOL RESULT read_file old-call]");
  });

  it("uses the dangerous bypass flag instead of ordinary approval flags", async () => {
    const { model, args } = fixtureModel(`${textToolFixture}\n`, {
      dangerouslySkipPermissions: true,
      alwaysApprove: true,
      permissionMode: "plan",
    });
    await model.doGenerate(callOptions());
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--always-approve");
    expect(args).not.toContain("--permission-mode");
  });

  it("defaults headless execution to the non-interactive dontAsk mode", async () => {
    const { model, args } = fixtureModel(`${textToolFixture}\n`);
    await model.doGenerate(callOptions());
    const index = args.indexOf("--permission-mode");
    expect(args[index + 1]).toBe("dontAsk");
  });

  it("does not double-count OpenAI-style cached input tokens", async () => {
    const rows = [
      { type: "text", data: "done" },
      {
        type: "end",
        stopReason: "EndTurn",
        sessionId: "session-openai-usage",
        usage: {
          input_tokens: 125,
          cached_tokens: 98,
          output_tokens: 48,
        },
      },
    ];
    const { model } = fixtureModel(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const result = await model.doGenerate(callOptions());
    expect(result.usage.inputTokens).toEqual({
      total: 125,
      noCache: 27,
      cacheRead: 98,
      cacheWrite: undefined,
    });
  });

  it("keeps sequential and concurrent reasoning effort overrides call-local", async () => {
    const calls: string[][] = [];
    const spawn: ExecSpawnFactory = (_command, args) => {
      calls.push([...args]);
      const child = new FixtureExecChild();
      queueMicrotask(() => {
        child.writeChunks(`${textToolFixture}\n`);
        child.finish();
      });
      return child;
    };
    const model = new GrokExecLanguageModel({
      id: "grok-4.6",
      settings: {
        executablePath: "/fake/grok",
        reasoningEffort: "medium",
      },
      spawn,
    });
    await model.doGenerate(
      callOptions("high", {
        providerOptions: { "grok-build": { reasoningEffort: "high" } },
      }),
    );
    await model.doGenerate(callOptions("default"));
    await Promise.all([
      model.doGenerate(callOptions("low", { reasoning: "low" })),
      model.doGenerate(callOptions("xhigh", { reasoning: "xhigh" })),
    ]);
    const efforts = calls.map(
      (args) => args[args.indexOf("--reasoning-effort") + 1],
    );
    expect(efforts.slice(0, 2)).toEqual(["high", "medium"]);
    expect(efforts.slice(2).sort()).toEqual(["low", "xhigh"]);
  });

  it("does not erase configured defaults with undefined call options", async () => {
    const { model, args } = fixtureModel(`${textToolFixture}\n`, {
      permissionMode: "plan",
      maxTurns: 3,
    });
    await model.doGenerate(
      callOptions("defaults", {
        providerOptions: {
          "grok-build": { permissionMode: undefined, maxTurns: undefined },
        },
      }),
    );

    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
  });

  it.each([
    {
      session: { id: "00000000-0000-4000-8000-000000000201" },
      present: ["--session-id"],
      absent: ["--resume", "--continue", "--fork-session"],
    },
    {
      session: { resume: "source-session" },
      present: ["--resume"],
      absent: ["--continue", "--fork-session", "--session-id"],
    },
    {
      session: { continue: true },
      present: ["--continue"],
      absent: ["--resume", "--fork-session", "--session-id"],
    },
    {
      session: {
        continue: true,
        fork: true,
        id: "00000000-0000-4000-8000-000000000202",
      },
      present: ["--continue", "--fork-session", "--session-id"],
      absent: ["--resume"],
    },
  ])("maps session controls %#", async ({ session, present, absent }) => {
    const { model, args } = fixtureModel(`${textToolFixture}\n`, { session });
    await model.doGenerate(callOptions());
    for (const flag of present) expect(args).toContain(flag);
    for (const flag of absent) expect(args).not.toContain(flag);
  });

  it("passes an unchanged ref/defs schema and emits one final structured payload", async () => {
    const schema = {
      $ref: "#/$defs/result",
      $defs: {
        result: {
          type: "object" as const,
          properties: {
            value: { type: "string" as const, format: "email" },
          },
          required: ["value"],
          additionalProperties: false,
        },
      },
    };
    const wrapper = JSON.parse(headlessFixture("structured.json")) as object;
    const { model, args } = fixtureModel(JSON.stringify(wrapper));
    const result = await model.doGenerate(
      callOptions("json", {
        responseFormat: { type: "json", schema },
      }),
    );

    const schemaIndex = args.indexOf("--json-schema");
    expect(JSON.parse(args[schemaIndex + 1] ?? "null")).toEqual(schema);
    expect(args).not.toContain("streaming-json");
    expect(result.content).toContainEqual({
      type: "text",
      text: '{"value":"fixture@example.com"}',
    });
    expect(result.warnings).toEqual([]);
  });

  it("uses legacy text when the structured result value is null", async () => {
    const { model } = fixtureModel(
      JSON.stringify({ result: null, text: "fallback", stopReason: "EndTurn" }),
    );
    const result = await model.doGenerate(
      callOptions("json", {
        responseFormat: { type: "json", schema: { type: "null" } },
      }),
    );

    expect(result.content).toContainEqual({ type: "text", text: "fallback" });
  });

  it("serializes an explicit null result when no legacy text is present", async () => {
    const { model } = fixtureModel(
      JSON.stringify({ result: null, stopReason: "EndTurn" }),
    );
    const result = await model.doGenerate(
      callOptions("json", {
        responseFormat: { type: "json", schema: { type: "null" } },
      }),
    );

    expect(result.content).toContainEqual({ type: "text", text: "null" });
  });

  it("rejects structured wrappers with no generated payload", async () => {
    const { model } = fixtureModel(JSON.stringify({ stopReason: "EndTurn" }));

    await expect(
      model.doGenerate(
        callOptions("json", {
          responseFormat: { type: "json", schema: { type: "null" } },
        }),
      ),
    ).rejects.toThrow("omitted the generated JSON payload");
  });

  it("preserves an explicit null structured output", async () => {
    const { model } = fixtureModel(
      JSON.stringify({
        structuredOutput: null,
        text: "fallback",
        stopReason: "EndTurn",
      }),
    );
    const result = await model.doGenerate(
      callOptions("json", {
        responseFormat: { type: "json", schema: { type: "null" } },
      }),
    );

    expect(result.content).toContainEqual({ type: "text", text: "null" });
  });

  it("warns for schema-less JSON without claiming constrained decoding", async () => {
    const { model, prompt } = fixtureModel(`${textToolFixture}\n`);
    const result = await model.doGenerate(
      callOptions("json", { responseFormat: { type: "json" } }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ feature: "schema-less JSON responseFormat" }),
    );
    expect(prompt()).toContain("Return only valid JSON");
  });

  it("fails when streaming output has no valid terminal event", async () => {
    const { model } = fixtureModel(
      `${JSON.stringify({ type: "text", data: "partial" })}\n`,
    );
    await expect(model.doGenerate(callOptions())).rejects.toThrow(
      "terminal 'end' event",
    );
  });

  it("fails on malformed and completion-sensitive unknown events", async () => {
    const malformed = fixtureModel(headlessFixture("malformed.txt"));
    await expect(malformed.model.doGenerate(callOptions())).rejects.toThrow(
      "Invalid JSON",
    );
    const unknown = fixtureModel(
      `${JSON.stringify({ type: "permission_changed", data: {} })}\n`,
    );
    await expect(unknown.model.doGenerate(callOptions())).rejects.toThrow(
      "may affect completion",
    );
  });

  it("preserves benign unknown events as raw parts with one warning", async () => {
    const rows = [
      { type: "future_notice", data: 1 },
      { type: "future_notice", data: 2 },
      {
        type: "end",
        stopReason: "EndTurn",
        sessionId: "session",
        usage: {},
      },
    ];
    const { model } = fixtureModel(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const parts: LanguageModelV4StreamPart[] = [];
    const result = await model.doStream(callOptions());
    for await (const part of result.stream) parts.push(part);
    expect(
      parts.filter(
        (part) =>
          part.type === "raw" &&
          typeof part.rawValue === "object" &&
          part.rawValue !== null &&
          "type" in part.rawValue &&
          part.rawValue.type === "grok-build-compatibility-warning",
      ),
    ).toHaveLength(1);
  });

  it("preserves headless error messages and maps authentication failures", async () => {
    const generic = fixtureModel(
      `${JSON.stringify({ type: "error", message: "tool service unavailable" })}\n`,
    );
    await expect(generic.model.doGenerate(callOptions())).rejects.toMatchObject(
      {
        message: "tool service unavailable",
        isRetryable: false,
      },
    );
    const auth = fixtureModel(
      `${JSON.stringify({ type: "error", message: "Not signed in" })}\n`,
    );
    await expect(auth.model.doGenerate(callOptions())).rejects.toBeInstanceOf(
      LoadAPIKeyError,
    );
  });

  it("maps the sanitized cancelled terminal fixture without inventing success", async () => {
    const { model } = fixtureModel(headlessFixture("cancelled.jsonl"));
    const result = await model.doGenerate(callOptions());
    expect(result.finishReason).toEqual({
      unified: "other",
      raw: "cancelled",
    });
    expect(result.providerMetadata?.["grok-build"]?.sessionId).toBe(
      "00000000-0000-4000-8000-000000000104",
    );
  });

  it("enforces the configured structured output byte ceiling", async () => {
    const { model } = fixtureModel(
      JSON.stringify({
        structuredOutput: { value: "too long" },
        stopReason: "EndTurn",
      }),
      { maxOutputBytes: 8 },
    );
    await expect(
      model.doGenerate(
        callOptions("json", {
          responseFormat: {
            type: "json",
            schema: { type: "object" },
          },
        }),
      ),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "OUTPUT_LIMIT_EXCEEDED" }),
    });
  });

  it("preserves the caller abort reason and terminates the child", async () => {
    const { model, child } = fixtureModel(() => undefined, {
      timeouts: { terminateGraceMs: 0, killGraceMs: 0 },
    });
    const abort = new AbortController();
    const reason = new Error("caller stopped");
    const result = await model.doStream(
      callOptions("wait", { abortSignal: abort.signal }),
    );
    const reader = result.stream.getReader();
    await reader.read();
    abort.abort(reason);
    await expect(
      (async () => {
        while (true) await reader.read();
      })(),
    ).rejects.toBe(reason);
    await vi.waitFor(() => expect(child.kills).toContain("SIGTERM"));
  });

  it("enforces prompt timeout with TERM to KILL escalation", async () => {
    class StubbornExecChild extends FixtureExecChild {
      override kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
        this.kills.push(signal);
        return true;
      }
    }
    const child = new StubbornExecChild();
    const model = new GrokExecLanguageModel({
      id: "grok-4.6",
      settings: {
        executablePath: "/fake/grok",
        timeouts: { promptMs: 5, terminateGraceMs: 1, killGraceMs: 1 },
      },
      spawn: () => child,
    });
    await expect(model.doGenerate(callOptions("wait"))).rejects.toMatchObject({
      isRetryable: false,
      data: expect.objectContaining({ code: "GROK_CLI_PROMPT_TIMEOUT" }),
    });
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps concurrent request metadata isolated on one model instance", async () => {
    let call = 0;
    const children: FixtureExecChild[] = [];
    const spawn: ExecSpawnFactory = () => {
      const child = new FixtureExecChild();
      const id = ++call;
      children.push(child);
      queueMicrotask(() => {
        child.writeChunks(
          `${JSON.stringify({ type: "text", data: `call-${id}` })}\n${JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: `session-${id}`, requestId: `request-${id}`, usage: {} })}\n`,
        );
        child.finish();
      });
      return child;
    };
    const model = new GrokExecLanguageModel({
      id: "grok-4.6",
      settings: { executablePath: "/fake/grok" },
      spawn,
    });
    const [first, second] = await Promise.all([
      model.doGenerate(callOptions("one")),
      model.doGenerate(callOptions("two")),
    ]);
    const results = [first, second];
    expect(
      results.map(
        (result) => result.providerMetadata?.["grok-build"]?.sessionId,
      ),
    ).toEqual(expect.arrayContaining(["session-1", "session-2"]));
    for (const result of results) {
      const text = result.content.find((part) => part.type === "text");
      const sessionId = result.providerMetadata?.["grok-build"]?.sessionId;
      expect(
        text?.type === "text" ? text.text.replace("call-", "session-") : "",
      ).toBe(sessionId);
    }
    expect(children).toHaveLength(2);
  });

  it("maps a non-zero process exit with bounded stderr", async () => {
    const exitFixture = JSON.parse(headlessFixture("process-exit.json")) as {
      exitCode: number;
      stderr: string;
    };
    const { model } = fixtureModel((child) => {
      child.stderr.write(exitFixture.stderr);
      child.finish(exitFixture.exitCode);
    });
    const promise = model.doGenerate(callOptions());
    await expect(promise).rejects.toBeInstanceOf(APICallError);
    await expect(promise).rejects.toMatchObject({
      isRetryable: false,
      data: expect.objectContaining({ code: "GROK_CLI_PROCESS_EXIT" }),
    });
  });
});
