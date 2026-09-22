import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import {
  AcpClient,
  type AcpChildProcess,
  type AcpClientOptions,
} from "./acp/client.js";
import { AcpProtocolError } from "./acp/errors.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./acp/protocol.js";
import {
  buildAcpCommandArgs,
  GrokBuildLanguageModel,
} from "./grok-build-language-model.js";
import type { GrokBuildSettings } from "./settings.js";

interface FixtureRow {
  dir: "in" | "out" | "stderr";
  msg: unknown;
}

function readFixture(name: string): FixtureRow[] {
  return readFileSync(
    new URL(`../fixtures/acp/${name}`, import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FixtureRow);
}

class FixtureChild extends EventEmitter implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<
    JsonRpcRequest | JsonRpcNotification | JsonRpcResponse
  > = [];
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  private readonly groups = new Map<string, unknown[][]>();
  private readonly groupIndexes = new Map<string, number>();
  private readonly heldMethods: Set<string>;
  private exited = false;

  constructor(rows: FixtureRow[], heldMethods: Iterable<string> = []) {
    super();
    this.heldMethods = new Set(heldMethods);
    let currentGroup: unknown[] | undefined;
    for (const row of rows) {
      if (
        row.dir === "out" &&
        isRecord(row.msg) &&
        typeof row.msg.method === "string"
      ) {
        currentGroup = [];
        const methodGroups = this.groups.get(row.msg.method) ?? [];
        methodGroups.push(currentGroup);
        this.groups.set(row.msg.method, methodGroups);
      } else if (row.dir === "in" && currentGroup && isRecord(row.msg)) {
        currentGroup.push(row.msg);
      }
    }

    let input = "";
    this.stdin.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      let newline = input.indexOf("\n");
      while (newline !== -1) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        if (line) this.receive(JSON.parse(line) as JsonRpcRequest);
        newline = input.indexOf("\n");
      }
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (!this.exited) {
      this.exited = true;
      this.stdout.end();
      this.stderr.end();
      queueMicrotask(() =>
        this.emit("exit", null, typeof signal === "string" ? signal : null),
      );
    }
    return true;
  }

  send(message: unknown): void {
    const data = Buffer.from(`${JSON.stringify(message)}\n`);
    const split = Math.max(1, Math.floor(data.length / 2));
    this.stdout.write(data.subarray(0, split));
    this.stdout.write(data.subarray(split));
  }

  sendRaw(value: string): void {
    this.stdout.write(value);
  }

  private receive(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  ): void {
    this.requests.push(message);
    if (!("method" in message)) return;
    if (this.heldMethods.has(message.method)) return;
    const requestId = "id" in message ? message.id : undefined;
    if (message.method === "authenticate" && requestId !== undefined) {
      this.send({ jsonrpc: "2.0", id: requestId, result: {} });
      return;
    }
    if (
      message.method === "session/load" &&
      requestId !== undefined &&
      !this.groups.has("session/load")
    ) {
      this.send({ jsonrpc: "2.0", id: requestId, result: null });
      return;
    }
    const groups = this.groups.get(message.method) ?? [];
    const groupIndex = this.groupIndexes.get(message.method) ?? 0;
    const group =
      groups[Math.min(groupIndex, Math.max(0, groups.length - 1))] ?? [];
    this.groupIndexes.set(message.method, groupIndex + 1);
    for (const original of group) {
      const response = structuredClone(original) as Record<string, unknown>;
      if ("id" in response && ("result" in response || "error" in response)) {
        response.id = requestId;
      }
      this.send(response);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function promptOptions(
  text: string,
  extra: Partial<LanguageModelV4CallOptions> = {},
): LanguageModelV4CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
    ...extra,
  };
}

function fixtureModel(
  name: string,
  includeRawChunks = false,
  heldMethods: Iterable<string> = [],
  modelId = "grok-4.5",
): {
  model: GrokBuildLanguageModel;
  child: FixtureChild;
} {
  const child = new FixtureChild(readFixture(name), heldMethods);
  const model = new GrokBuildLanguageModel({
    id: modelId,
    settings: { cwd: "/fixture", includeRawChunks },
    clientFactory: (options: AcpClientOptions) =>
      new AcpClient({
        ...options,
        authMethod: false,
        spawn: () => child,
      }),
  });
  return { model, child };
}

async function collect(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe("GrokBuildLanguageModel", () => {
  it("passes the default permission mode explicitly in ACP argv", () => {
    expect(
      buildAcpCommandArgs([], {
        permissionMode: "default",
        dangerouslySkipPermissions: false,
        alwaysApprove: false,
      }),
    ).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "default",
      "agent",
      "stdio",
    ]);
  });

  it("lets dangerous bypass supersede ordinary ACP permission flags", () => {
    const args = buildAcpCommandArgs([], {
      permissionMode: "plan",
      dangerouslySkipPermissions: true,
      alwaysApprove: true,
    });

    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--always-approve");
  });

  it("leaves ACP arguments undefined for a custom client factory", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    let captured: AcpClientOptions | undefined;
    const model = new GrokBuildLanguageModel({
      id: "grok-4.5",
      settings: {
        cwd: "/fixture",
        permissionMode: "plan",
        alwaysApprove: true,
        xaiApiBaseUrl: "https://api.example.test",
      },
      clientFactory: (options) => {
        captured = options;
        return new AcpClient({
          ...options,
          authMethod: false,
          spawn: () => child,
        });
      },
    });

    await model.doGenerate(promptOptions("ping"));

    expect(captured?.args).toBeUndefined();
    expect(captured).toMatchObject({
      permissionMode: "plan",
      alwaysApprove: true,
      env: { XAI_API_BASE_URL: "https://api.example.test" },
    });
  });

  it.each([
    {
      label: "the provider apiKey option",
      settings: { cwd: "/fixture", apiKey: "provider-key" },
      expectedAuthMethod: false,
      expectedApiKey: "provider-key",
    },
    {
      label: "an explicit api_key method with an environment key",
      settings: {
        cwd: "/fixture",
        authMethod: "api_key",
        env: { XAI_API_KEY: "environment-key" },
      },
      expectedAuthMethod: false,
      expectedApiKey: "environment-key",
    },
    {
      label: "an environment key without an explicit method",
      settings: {
        cwd: "/fixture",
        env: { XAI_API_KEY: "environment-key" },
      },
      expectedAuthMethod: "cached_token",
      expectedApiKey: "environment-key",
    },
  ] satisfies Array<{
    label: string;
    settings: GrokBuildSettings;
    expectedAuthMethod: string | false;
    expectedApiKey: string;
  }>)(
    "resolves ACP authentication for $label",
    async ({ settings, expectedAuthMethod, expectedApiKey }) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"));
      let captured: AcpClientOptions | undefined;
      const model = new GrokBuildLanguageModel({
        id: "grok-4.5",
        settings,
        clientFactory: (options) => {
          captured = options;
          return new AcpClient({
            ...options,
            authMethod: false,
            spawn: () => child,
          });
        },
      });

      await model.doGenerate(promptOptions("ping"));

      expect(captured?.authMethod).toBe(expectedAuthMethod);
      expect(captured?.env?.XAI_API_KEY).toBe(expectedApiKey);
    },
  );

  it("requires explicit api_key mode for a process-environment key", async () => {
    const previousApiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "process-key";
    const captureOptions = async (
      settings: GrokBuildSettings,
    ): Promise<AcpClientOptions> => {
      const child = new FixtureChild(readFixture("text-only.jsonl"));
      let captured: AcpClientOptions | undefined;
      const model = new GrokBuildLanguageModel({
        id: "grok-4.5",
        settings,
        clientFactory: (options) => {
          captured = options;
          return new AcpClient({
            ...options,
            authMethod: false,
            spawn: () => child,
          });
        },
      });
      await model.doGenerate(promptOptions("ping"));
      if (!captured) throw new Error("Expected captured ACP client options.");
      return captured;
    };

    try {
      const cached = await captureOptions({ cwd: "/fixture" });
      expect(cached.authMethod).toBe("cached_token");

      const apiKey = await captureOptions({
        cwd: "/fixture",
        authMethod: "api_key",
      });
      expect(apiKey.authMethod).toBe(false);
      expect(apiKey.env?.XAI_API_KEY).toBe("process-key");
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it.skipIf(process.platform === "win32")(
    "opts a real-CLI custom factory into validation and generated arguments",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "grok-cli-fixture-"));
      const executablePath = join(directory, "grok");
      await writeFile(executablePath, '#!/bin/sh\nprintf "grok 1.2.3\\n"\n', {
        mode: 0o755,
      });
      try {
        const child = new FixtureChild(readFixture("text-only.jsonl"));
        let captured: AcpClientOptions | undefined;
        const model = new GrokBuildLanguageModel({
          id: "grok-4.5",
          settings: {
            cwd: directory,
            executablePath,
            permissionMode: "plan",
            alwaysApprove: true,
            xaiApiBaseUrl: "https://api.example.test",
          },
          validateCli: true,
          clientFactory: (options) => {
            captured = options;
            return new AcpClient({
              ...options,
              authMethod: false,
              spawn: () => child,
            });
          },
        });

        await model.doGenerate(promptOptions("ping"));

        expect(captured?.executable).toBe(executablePath);
        expect(captured?.args).toEqual([
          "--no-auto-update",
          "--permission-mode",
          "plan",
          "agent",
          "--always-approve",
          "--xai-api-base-url",
          "https://api.example.test",
          "stdio",
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      providerValue: undefined,
      callValue: undefined,
      expected: "default",
    },
    {
      providerValue: true,
      callValue: undefined,
      expected: "bypassPermissions",
    },
    { providerValue: true, callValue: false, expected: "default" },
    { providerValue: false, callValue: true, expected: "bypassPermissions" },
  ])(
    "resolves dangerous permission bypass with provider=$providerValue and call=$callValue",
    async ({ providerValue, callValue, expected }) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"));
      let captured: AcpClientOptions | undefined;
      const model = new GrokBuildLanguageModel({
        id: "grok-4.5",
        settings: {
          cwd: "/fixture",
          dangerouslySkipPermissions: providerValue,
        },
        clientFactory: (options) => {
          captured = options;
          return new AcpClient({
            ...options,
            authMethod: false,
            spawn: () => child,
          });
        },
      });
      await model.doGenerate(
        promptOptions("ping", {
          ...(callValue === undefined
            ? {}
            : {
                providerOptions: {
                  "grok-build": {
                    dangerouslySkipPermissions: callValue,
                  },
                },
              }),
        }),
      );

      expect(captured?.permissionMode).toBe(expected);
      expect(captured?.args).toBeUndefined();
    },
  );

  it("keeps permission mode and approval independent from a false dangerous override", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    let captured: AcpClientOptions | undefined;
    const model = new GrokBuildLanguageModel({
      id: "grok-4.5",
      settings: {
        cwd: "/fixture",
        dangerouslySkipPermissions: true,
        permissionMode: "plan",
        alwaysApprove: true,
      },
      clientFactory: (options) => {
        captured = options;
        return new AcpClient({
          ...options,
          authMethod: false,
          spawn: () => child,
        });
      },
    });

    await model.doGenerate(
      promptOptions("ping", {
        providerOptions: {
          "grok-build": { dangerouslySkipPermissions: false },
        },
      }),
    );

    expect(captured).toMatchObject({
      permissionMode: "plan",
      alwaysApprove: true,
    });
  });

  it("maps the captured ACP tool lifecycle into a complete V4 stream", async () => {
    const { model } = fixtureModel("tool-use.jsonl", true);
    const result = await model.doStream(promptOptions("inspect"));
    const parts = await collect(result.stream);

    expect(parts[0]).toMatchObject({ type: "stream-start", warnings: [] });
    expect(parts[1]).toMatchObject({
      type: "response-metadata",
      modelId: "grok-4.5",
    });
    expect(parts.map((part) => part.type)).toEqual(
      expect.arrayContaining([
        "reasoning-start",
        "reasoning-delta",
        "reasoning-end",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "tool-result",
        "text-start",
        "text-delta",
        "text-end",
        "raw",
        "finish",
      ]),
    );

    const toolCall = parts.find((part) => part.type === "tool-call");
    expect(toolCall).toMatchObject({
      type: "tool-call",
      toolCallId: "call-86f01966-bf6e-4c5e-b564-e57450e9eec1-0",
      toolName: "run_terminal_command",
      providerExecuted: true,
      dynamic: true,
    });
    if (toolCall?.type === "tool-call") {
      expect(JSON.parse(toolCall.input)).toMatchObject({
        command: expect.stringContaining("echo hello-acp"),
      });
    }

    const toolResults = parts.filter((part) => part.type === "tool-result");
    expect(toolResults.some((part) => part.preliminary === true)).toBe(true);
    const finalToolResult = toolResults.find((part) => !part.preliminary);
    expect(finalToolResult).toMatchObject({
      toolCallId: "call-86f01966-bf6e-4c5e-b564-e57450e9eec1-0",
      toolName: "run_terminal_command",
      dynamic: true,
      result: { exit_code: 0, truncated: false },
    });

    const finish = parts.find((part) => part.type === "finish");
    expect(finish).toMatchObject({
      type: "finish",
      finishReason: { unified: "stop", raw: "end_turn" },
      usage: {
        inputTokens: {
          total: 16297,
          noCache: undefined,
          cacheRead: 15616,
        },
        outputTokens: { total: 82, reasoning: 15 },
      },
      providerMetadata: {
        "grok-build": {
          sessionId: "019f58fd-189a-7f03-9fe2-e018704940ee",
          requestId: "a1f2fec5-c648-4228-8ea3-67e8c165d8a2",
          promptId: "a1f2fec5-c648-4228-8ea3-67e8c165d8a2",
          stopReason: "end_turn",
          resolvedModel: "grok-4.5",
          currentReasoningEffort: "high",
          supportedReasoningEfforts: ["high", "medium", "low"],
          agentVersion: "0.2.99",
          availableModels: expect.arrayContaining([
            expect.objectContaining({ modelId: "grok-4.5" }),
            expect.objectContaining({ modelId: "grok-composer-2.5-fast" }),
          ]),
          modelUsage: { "grok-4.5": { modelCalls: 2 } },
        },
      },
    });
    expect(
      parts.some(
        (part) =>
          part.type === "raw" &&
          isRecord(part.rawValue) &&
          part.rawValue.method === "_x.ai/session/prompt_complete",
      ),
    ).toBe(true);
  });

  it("aggregates the captured stream for doGenerate while preserving content order", async () => {
    const { model } = fixtureModel("tool-use.jsonl");
    const result = await model.doGenerate(promptOptions("inspect"));

    expect(result.content.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-call",
      "tool-result",
      "reasoning",
      "text",
    ]);
    expect(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toContain("Both confirmed");
    expect(result.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(result.usage.outputTokens.reasoning).toBe(15);
    const generatedToolResults = result.content.filter(
      (part) => part.type === "tool-result",
    );
    expect(generatedToolResults).toHaveLength(1);
    expect(generatedToolResults[0]).toMatchObject({
      result: { exit_code: 0, truncated: false },
    });
    expect(generatedToolResults[0]).not.toHaveProperty("preliminary");
    expect(result.warnings).toEqual([]);
  });

  it("keeps doGenerate and doStream semantically identical over the golden tool fixture", async () => {
    const generated = await fixtureModel("tool-use.jsonl").model.doGenerate(
      promptOptions("inspect"),
    );
    const streamed = await fixtureModel("tool-use.jsonl").model.doStream(
      promptOptions("inspect"),
    );
    const parts = await collect(streamed.stream);
    const finish = parts.find((part) => part.type === "finish");

    expect(
      generated.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toBe(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    );
    expect(
      generated.content
        .filter((part) => part.type === "reasoning")
        .map((part) => part.text)
        .join(""),
    ).toBe(
      parts
        .filter((part) => part.type === "reasoning-delta")
        .map((part) => part.delta)
        .join(""),
    );
    expect(
      generated.content
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolCallId),
    ).toEqual(
      parts
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolCallId),
    );
    expect(
      generated.content.filter((part) => part.type === "tool-result"),
    ).toEqual(
      parts.filter((part) => part.type === "tool-result" && !part.preliminary),
    );
    expect(finish).toMatchObject({
      type: "finish",
      finishReason: generated.finishReason,
      usage: generated.usage,
      providerMetadata: generated.providerMetadata,
    });
    const start = parts.find((part) => part.type === "stream-start");
    expect(start).toMatchObject({ warnings: generated.warnings });
  });

  it("keeps doGenerate and doStream identical over the golden text-only fixture", async () => {
    const generated = await fixtureModel("text-only.jsonl").model.doGenerate(
      promptOptions("ping"),
    );
    const streamed = await fixtureModel("text-only.jsonl").model.doStream(
      promptOptions("ping"),
    );
    const parts = await collect(streamed.stream);
    const finish = parts.find((part) => part.type === "finish");

    expect(
      generated.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toBe(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join(""),
    );
    expect(finish).toMatchObject({
      type: "finish",
      finishReason: generated.finishReason,
      usage: generated.usage,
      providerMetadata: generated.providerMetadata,
    });
  });

  it("maps an authentication-required initialize response at the model boundary", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "initialize",
    ]);
    const pending = model.doStream(promptOptions("ping"));
    await new Promise((resolve) => setImmediate(resolve));
    const initialize = child.requests.find(
      (request) => "method" in request && request.method === "initialize",
    ) as JsonRpcRequest | undefined;
    expect(initialize).toBeDefined();
    child.send({
      jsonrpc: "2.0",
      id: initialize?.id,
      error: {
        code: -32000,
        message: "Authentication required; run grok login",
      },
    });

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    {
      label: "cached-token mode",
      settings: { cwd: "/fixture" },
      expectedAdvice: "grok login",
      unexpectedAdvice: "Verify or replace the provider 'apiKey' value",
    },
    {
      label: "API-key mode",
      settings: { cwd: "/fixture", apiKey: "provider-key" },
      expectedAdvice: "Verify or replace the provider 'apiKey' value",
      unexpectedAdvice: "grok login",
    },
  ] satisfies Array<{
    label: string;
    settings: GrokBuildSettings;
    expectedAdvice: string;
    unexpectedAdvice: string;
  }>)(
    "preserves an empty-method session authentication failure at the model boundary in $label",
    async ({ settings, expectedAdvice, unexpectedAdvice }) => {
      const child = new FixtureChild(readFixture("config-options-1x.jsonl"), [
        "session/new",
      ]);
      const model = new GrokBuildLanguageModel({
        id: "grok-4.5",
        settings,
        clientFactory: (options) =>
          new AcpClient({ ...options, spawn: () => child }),
      });
      const pending = model.doStream(promptOptions("ping"));
      void pending.catch(() => undefined);
      await vi.waitFor(() => {
        expect(
          child.requests.filter(
            (request) =>
              "method" in request && request.method === "session/new",
          ),
        ).toHaveLength(1);
      });
      const sessionRequest = child.requests.find(
        (request): request is JsonRpcRequest =>
          "method" in request &&
          "id" in request &&
          request.method === "session/new",
      );
      expect(sessionRequest).toBeDefined();
      if (!sessionRequest) throw new Error("Expected a session/new request.");
      child.send({
        jsonrpc: "2.0",
        id: sessionRequest.id,
        error: { code: -32603, message: "token refresh failed" },
      });

      const error = await pending.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(LoadAPIKeyError);
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("session/new");
        expect(error.message).toContain("-32603");
        expect(error.message).toContain("token refresh failed");
        expect(error.message).toContain(
          "Provider error code: AUTHENTICATION_FAILED.",
        );
        expect(error.message).toContain(expectedAdvice);
        expect(error.message).not.toContain(unexpectedAdvice);
        expect(error.message).toContain("authMethod");
        expect(error.message).toContain("api_key");
        expect(error.message).toContain("XAI_API_KEY");
        expect(error.cause).toMatchObject({
          name: "AcpAuthenticationError",
          code: "AUTHENTICATION_FAILED",
          cause: {
            name: "AcpJsonRpcError",
            method: "session/new",
            rpcCode: -32603,
          },
        });
      }
      expect(
        child.requests
          .filter((request) => "method" in request)
          .map((request) => request.method),
      ).toEqual(["initialize", "session/new"]);
    },
  );

  it("maps malformed ACP JSON at the model boundary and terminates the agent", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "initialize",
    ]);
    const pending = model.doGenerate(promptOptions("ping"));
    await new Promise((resolve) => setImmediate(resolve));
    child.sendRaw('{"jsonrpc":"2.0",broken-json}\n');

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APICallError);
    expect(error).toMatchObject({
      isRetryable: false,
      data: { code: "PROTOCOL_ERROR" },
    });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain("Invalid JSON from Grok ACP stdout");
    }
    await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
  });

  it("cancels ACP and closes cleanly when the stream consumer aborts mid-prompt", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "session/prompt",
    ]);
    const { stream } = await model.doStream(promptOptions("wait"));
    const reader = stream.getReader();
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: { type: "stream-start" },
    });
    await reader.cancel("consumer stopped");
    await expect(reader.closed).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    const sessionNew = child.requests.find(
      (request) => "method" in request && request.method === "session/new",
    ) as JsonRpcRequest | undefined;
    const sessionResponse = readFixture("text-only.jsonl").find(
      (row) =>
        row.dir === "in" &&
        isRecord(row.msg) &&
        "result" in row.msg &&
        isRecord(row.msg.result) &&
        typeof row.msg.result.sessionId === "string",
    );
    expect(sessionNew).toBeDefined();
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: {
        sessionId:
          isRecord(sessionResponse?.msg) && isRecord(sessionResponse.msg.result)
            ? sessionResponse.msg.result.sessionId
            : undefined,
      },
    });
    await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
  });

  it("isolates a malformed update to its generation on a shared client", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const createModel = (): GrokBuildLanguageModel =>
      new GrokBuildLanguageModel({
        id: "grok-4.5",
        settings: { cwd: "/fixture" },
        clientFactory: () => client,
        disposeClient: false,
      });
    const failedPreparation = createModel().doStream(promptOptions("bad"));
    const healthyPreparation = createModel().doStream(promptOptions("good"));
    await vi.waitFor(() => {
      expect(
        child.requests.filter(
          (message) => "method" in message && message.method === "session/new",
        ),
      ).toHaveLength(2);
    });
    const sessionRequests = child.requests.filter(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest[];
    child.send({
      jsonrpc: "2.0",
      id: sessionRequests[0]?.id,
      result: { sessionId: "session-bad" },
    });
    child.send({
      jsonrpc: "2.0",
      id: sessionRequests[1]?.id,
      result: { sessionId: "session-good" },
    });
    const [failedStream, healthyStream] = await Promise.all([
      failedPreparation,
      healthyPreparation,
    ]);
    const failedResult = collect(failedStream.stream).catch(
      (error: unknown) => error,
    );
    const healthyResult = collect(healthyStream.stream);
    await vi.waitFor(() => {
      expect(
        child.requests.filter(
          (message) =>
            "method" in message && message.method === "session/prompt",
        ),
      ).toHaveLength(2);
    });
    const promptRequests = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    const healthyPrompt = promptRequests.find(
      (request) =>
        isRecord(request.params) && request.params.sessionId === "session-good",
    );

    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-bad",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: 42 },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-good",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "healthy" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: healthyPrompt?.id,
      result: { stopReason: "end_turn" },
    });

    const generationError = await failedResult;
    expect(generationError).toBeInstanceOf(APICallError);
    expect(generationError).toMatchObject({
      cause: expect.any(AcpProtocolError),
      isRetryable: false,
      data: { code: "PROTOCOL_ERROR" },
    });
    expect(await healthyResult).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text-delta", delta: "healthy" }),
        expect.objectContaining({ type: "finish" }),
      ]),
    );
    expect(client.isUsable).toBe(true);

    const finalPrompt = client.prompt({
      sessionId: "session-final",
      prompt: [{ type: "text", text: "still usable" }],
    });
    await vi.waitFor(() => {
      expect(
        child.requests.filter(
          (message) =>
            "method" in message && message.method === "session/prompt",
        ),
      ).toHaveLength(3);
    });
    const finalRequest = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    )[2] as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: finalRequest.id,
      result: { stopReason: "end_turn" },
    });
    await expect(finalPrompt).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    await client.dispose();
  });

  it("does not spawn for an already-aborted call", async () => {
    let spawned = false;
    const controller = new AbortController();
    controller.abort();
    const model = new GrokBuildLanguageModel({
      id: "grok-4.5",
      clientFactory: (options) =>
        new AcpClient({
          ...options,
          spawn: () => {
            spawned = true;
            return new FixtureChild(readFixture("text-only.jsonl"));
          },
        }),
    });

    await expect(
      model.doStream(
        promptOptions("cancelled", { abortSignal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(spawned).toBe(false);
  });

  it("aborts ACP initialization and disposes before creating a session", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "initialize",
    ]);
    const controller = new AbortController();
    const pending = model.doStream(
      promptOptions("cancelled", { abortSignal: controller.signal }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(
      child.requests.some(
        (request) => "method" in request && request.method === "session/new",
      ),
    ).toBe(false);
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("reports unsupported controls, tools, image input, and prompt-engineered JSON", async () => {
    const { model } = fixtureModel("text-only.jsonl");
    const { stream } = await model.doStream({
      ...promptOptions("describe"),
      temperature: 0.2,
      maxOutputTokens: 100,
      tools: [
        {
          type: "function",
          name: "lookup",
          inputSchema: { type: "object" },
        },
      ],
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "file",
              mediaType: "image/png",
              data: { type: "data", data: "aW1hZ2U=" },
            },
          ],
        },
      ],
    });
    const first = (await collect(stream))[0];
    expect(first?.type).toBe("stream-start");
    if (first?.type !== "stream-start") return;
    expect(first.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "unsupported",
          feature: "temperature",
        }),
        expect.objectContaining({
          type: "unsupported",
          feature: "maxOutputTokens",
        }),
        expect.objectContaining({ type: "unsupported", feature: "tools" }),
        expect.objectContaining({
          type: "unsupported",
          feature: "image input",
        }),
        expect.objectContaining({
          type: "compatibility",
          feature: "responseFormat json",
        }),
      ]),
    );
  });

  it("loads an explicit ACP session from strict providerOptions", async () => {
    const { model, child } = fixtureModel("text-only.jsonl");
    const result = await model.doGenerate(
      promptOptions("continue", {
        providerOptions: {
          "grok-build": { session: { id: "existing-session" } },
        },
      }),
    );

    expect(
      child.requests.some(
        (request) => "method" in request && request.method === "session/load",
      ),
    ).toBe(true);
    expect(
      child.requests.some(
        (request) => "method" in request && request.method === "session/new",
      ),
    ).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compatibility",
          feature: "session load",
        }),
      ]),
    );
  });

  it("quarantines replay extension events emitted by session/load", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", true, [
      "session/load",
    ]);
    const pending = model.doStream(
      promptOptions("continue", {
        providerOptions: {
          "grok-build": { session: { id: "existing-session" } },
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const load = child.requests.find(
      (message) => "method" in message && message.method === "session/load",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/session/update",
      params: {
        sessionId: "existing-session",
        update: { sessionUpdate: "agent_message_chunk", content: "old" },
        _meta: { isReplay: true },
      },
    });
    child.send({ jsonrpc: "2.0", id: load.id, result: null });
    const parts = await collect((await pending).stream);
    expect(
      parts.some(
        (part) =>
          part.type === "raw" &&
          isRecord(part.rawValue) &&
          isRecord(part.rawValue.params) &&
          isRecord(part.rawValue.params._meta) &&
          part.rawValue.params._meta.isReplay === true,
      ),
    ).toBe(false);
  });

  it("captures pre-session extensions and filters other session notifications", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", true, [
      "session/new",
    ]);
    const pending = model.doStream(promptOptions("inspect extensions"));
    await new Promise((resolve) => setImmediate(resolve));
    const sessionRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/global/update",
      params: { value: "initialization" },
    });
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/session/extension",
      params: { sessionId: "session-one", value: "matching" },
    });
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/session/extension",
      params: { sessionId: "session-other", value: "other" },
    });
    child.send({
      jsonrpc: "2.0",
      id: sessionRequest.id,
      result: { sessionId: "session-one" },
    });

    const parts = await collect((await pending).stream);
    const raw = parts
      .filter((part) => part.type === "raw")
      .map((part) => part.rawValue);
    expect(raw).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "_x.ai/global/update" }),
        expect.objectContaining({
          method: "_x.ai/session/extension",
          params: expect.objectContaining({ value: "matching" }),
        }),
      ]),
    );
    expect(raw).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ value: "other" }),
        }),
      ]),
    );
  });

  it("warns when a requested model is absent from the advertised catalog", async () => {
    const { model } = fixtureModel(
      "text-only.jsonl",
      false,
      [],
      "not-a-grok-model",
    );
    const result = await model.doGenerate(promptOptions("ping"));

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: "unsupported",
        feature: "model selection",
        details: expect.stringContaining("not present"),
      }),
    );
    expect(result.providerMetadata?.["grok-build"]).toMatchObject({
      resolvedModel: "grok-4.5",
      availableModels: expect.arrayContaining([
        expect.objectContaining({ modelId: "grok-4.5" }),
      ]),
    });
  });

  it("selects the model and effort through Grok 1.x session config options", async () => {
    const { model, child } = fixtureModel(
      "config-options-1x.jsonl",
      false,
      [],
      "grok-4.5",
    );
    const result = await model.doGenerate(
      promptOptions("ping", { reasoning: "low" }),
    );
    const configRequests = child.requests.filter(
      (request) =>
        "method" in request && request.method === "session/set_config_option",
    );
    expect(configRequests).toHaveLength(2);
    expect(configRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            configId: "model",
            value: "grok-4.5",
          }),
        }),
        expect.objectContaining({
          params: expect.objectContaining({
            configId: "reasoning_effort",
            value: "low",
          }),
        }),
      ]),
    );
    expect(result.providerMetadata?.["grok-build"]).toMatchObject({
      sessionId: "session-config-1x",
      resolvedModel: "grok-4.5",
      currentReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high"],
      agentVersion: "1.0.34",
    });
  });

  it("flattens grouped selects and ignores unrelated option kinds", async () => {
    const { model, child } = fixtureModel(
      "text-only.jsonl",
      false,
      ["session/new", "session/set_config_option"],
      "grok-4.5",
    );
    const configOptions = (modelId: string, effort: string) => [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: modelId,
        options: [
          {
            group: "frontier",
            name: "Frontier",
            options: [
              { value: "grok-4.6", name: "Grok 4.6" },
              { value: "grok-4.5", name: "Grok 4.5" },
            ],
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        type: "select",
        currentValue: effort,
        options: [
          {
            group: "effort",
            name: "Effort",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
        ],
      },
      {
        id: "streaming",
        name: "Streaming",
        type: "boolean",
        currentValue: true,
      },
      {
        id: "future",
        name: "Future",
        type: "range",
        currentValue: 2,
      },
    ];
    const pending = model.doGenerate(
      promptOptions("ping", { reasoning: "low" }),
    );
    await vi.waitFor(() =>
      expect(
        child.requests.some(
          (request) => "method" in request && request.method === "session/new",
        ),
      ).toBe(true),
    );
    const sessionRequest = child.requests.find(
      (request) => "method" in request && request.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: sessionRequest.id,
      result: {
        sessionId: "session-grouped-config",
        configOptions: configOptions("grok-4.6", "high"),
      },
    });

    await vi.waitFor(() =>
      expect(
        child.requests.filter(
          (request) =>
            "method" in request &&
            request.method === "session/set_config_option",
        ),
      ).toHaveLength(1),
    );
    const modelRequest = child.requests.find(
      (request) =>
        "method" in request && request.method === "session/set_config_option",
    ) as JsonRpcRequest;
    expect(modelRequest.params).toMatchObject({
      configId: "model",
      value: "grok-4.5",
    });
    child.send({
      jsonrpc: "2.0",
      id: modelRequest.id,
      result: { configOptions: configOptions("grok-4.5", "high") },
    });

    await vi.waitFor(() =>
      expect(
        child.requests.filter(
          (request) =>
            "method" in request &&
            request.method === "session/set_config_option",
        ),
      ).toHaveLength(2),
    );
    const configRequests = child.requests.filter(
      (request) =>
        "method" in request && request.method === "session/set_config_option",
    ) as JsonRpcRequest[];
    const effortRequest = configRequests[1] as JsonRpcRequest;
    expect(effortRequest.params).toMatchObject({
      configId: "reasoning_effort",
      value: "low",
    });
    child.send({
      jsonrpc: "2.0",
      id: effortRequest.id,
      result: { configOptions: configOptions("grok-4.5", "low") },
    });

    const result = await pending;
    expect(result.providerMetadata?.["grok-build"]).toMatchObject({
      resolvedModel: "grok-4.5",
      currentReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high"],
    });
  });

  it("rejects malformed session model catalogs with redacted protocol data", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "session/new",
    ]);
    const pending = model.doStream(promptOptions("ping"));
    await vi.waitFor(() => {
      expect(
        child.requests.some(
          (message) => "method" in message && message.method === "session/new",
        ),
      ).toBe(true);
    });
    const request = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "session-malformed-models",
        models: {
          currentModelId: "grok-4.5",
          availableModels: [
            { modelId: "", name: "Invalid", apiKey: "wire-secret" },
          ],
        },
      },
    });

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(APICallError);
    expect(error).toMatchObject({
      isRetryable: false,
      data: { code: "PROTOCOL_ERROR" },
      cause: expect.any(AcpProtocolError),
    });
    const cause = (error as { cause: AcpProtocolError }).cause;
    expect(JSON.stringify(cause.data)).not.toContain("wire-secret");
    expect(JSON.stringify(cause.data)).toContain("[REDACTED]");
  });

  it("rejects malformed session config-option collections", async () => {
    const { model, child } = fixtureModel("text-only.jsonl", false, [
      "session/new",
    ]);
    const pending = model.doStream(promptOptions("ping"));
    await vi.waitFor(() => {
      expect(
        child.requests.some(
          (message) => "method" in message && message.method === "session/new",
        ),
      ).toBe(true);
    });
    const request = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "session-malformed-config",
        configOptions: { id: "model" },
      },
    });

    await expect(pending).rejects.toMatchObject({
      cause: expect.any(AcpProtocolError),
      data: { code: "PROTOCOL_ERROR" },
    });
  });

  it("rejects malformed set_config_option responses", async () => {
    const { model, child } = fixtureModel("config-options-1x.jsonl", false, [
      "session/set_config_option",
    ]);
    const pending = model.doStream(promptOptions("ping"));
    await vi.waitFor(() => {
      expect(
        child.requests.some(
          (message) =>
            "method" in message &&
            message.method === "session/set_config_option",
        ),
      ).toBe(true);
    });
    const request = child.requests.find(
      (message) =>
        "method" in message && message.method === "session/set_config_option",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        configOptions: [
          {
            id: "model",
            type: "select",
            currentValue: "grok-4.5",
            options: [{ value: 42 }],
          },
        ],
      },
    });

    await expect(pending).rejects.toMatchObject({
      cause: expect.any(AcpProtocolError),
      data: { code: "PROTOCOL_ERROR" },
    });
  });

  it.each([
    { unknown: true },
    { reasoningEffort: "extreme" },
    { permissionMode: "unattended" },
    { maxTurns: 0 },
    { session: { id: "one", resume: "two" } },
    {
      mcpServers: [
        { name: "bad", command: "", args: [], env: [], extra: true },
      ],
    },
  ])(
    "rejects invalid grok-build provider options %# before spawning",
    async (value) => {
      let spawned = false;
      const model = new GrokBuildLanguageModel({
        id: "grok-4.5",
        clientFactory: (options) =>
          new AcpClient({
            ...options,
            spawn: () => {
              spawned = true;
              return new FixtureChild(readFixture("text-only.jsonl"));
            },
          }),
      });

      await expect(
        model.doStream(
          promptOptions("invalid", {
            providerOptions: { "grok-build": value },
          }),
        ),
      ).rejects.toThrow();
      expect(spawned).toBe(false);
    },
  );

  it("validates public constructor settings and model IDs before spawning", () => {
    expect(() => new GrokBuildLanguageModel({ id: "   " })).toThrow();
    expect(
      () =>
        new GrokBuildLanguageModel({
          id: "grok-4.5",
          settings: { timeouts: { requestMs: 0 } },
        }),
    ).toThrow();
  });
});
