import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpClient, NdjsonFramer, type AcpChildProcess } from "./client.js";
import { AcpProtocolError, AcpSpawnError } from "./errors.js";
import type {
  AcpSessionUpdateParams,
  AcpMessageChunkUpdate,
  AcpRequestPermissionResult,
  AcpToolCallProgressUpdate,
  AcpToolCallUpdate,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
} from "./protocol.js";

interface FixtureRow {
  dir: "in" | "out" | "stderr";
  msg: unknown;
}

function readFixture(name: string): FixtureRow[] {
  return readFileSync(
    new URL(`../../fixtures/acp/${name}`, import.meta.url),
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
  private readonly groups = new Map<string, unknown[]>();
  private readonly heldMethods: Set<string>;
  private exited = false;

  constructor(rows: FixtureRow[], heldMethods: Iterable<string> = []) {
    super();
    this.heldMethods = new Set(heldMethods);
    let currentMethod: string | undefined;
    for (const row of rows) {
      const message = row.msg;
      if (
        row.dir === "out" &&
        isRecord(message) &&
        typeof message.method === "string"
      ) {
        currentMethod = message.method;
        this.groups.set(currentMethod, []);
      } else if (row.dir === "in" && currentMethod && isRecord(message)) {
        this.groups.get(currentMethod)?.push(message);
      }
    }

    let inputBuffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      inputBuffer += chunk.toString("utf8");
      let newline = inputBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = inputBuffer.slice(0, newline);
        inputBuffer = inputBuffer.slice(newline + 1);
        if (line) {
          this.receive(
            JSON.parse(line) as
              | JsonRpcRequest
              | JsonRpcNotification
              | JsonRpcResponse,
          );
        }
        newline = inputBuffer.indexOf("\n");
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

  sendRaw(value: string | Uint8Array): void {
    this.stdout.write(value);
  }

  failWithStderr(
    stderr: string,
    code: number | null = 1,
    signal: NodeJS.Signals | null = null,
  ): void {
    this.stderr.write(stderr);
    this.exited = true;
    this.emit("exit", code, signal);
    this.stdout.end();
    this.stderr.end();
  }

  failToSpawn(error: NodeJS.ErrnoException): void {
    this.emit("error", error);
  }

  send(message: unknown): void {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    const first = Math.max(1, Math.floor(bytes.length / 3));
    const second = Math.max(first + 1, Math.floor((bytes.length * 2) / 3));
    this.stdout.write(bytes.subarray(0, first));
    this.stdout.write(bytes.subarray(first, second));
    this.stdout.write(bytes.subarray(second));
  }

  private receive(
    message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse,
  ): void {
    this.requests.push(message);
    if (!("method" in message)) return;
    if (this.heldMethods.has(message.method)) return;
    const requestId = "id" in message ? message.id : undefined;
    const group = this.groups.get(message.method);
    if (
      !group &&
      requestId !== undefined &&
      message.method === "authenticate"
    ) {
      this.send({ jsonrpc: "2.0", id: requestId, result: {} });
      return;
    }
    if (
      !group &&
      requestId !== undefined &&
      message.method === "session/load"
    ) {
      this.send({ jsonrpc: "2.0", id: requestId, result: null });
      return;
    }
    for (const original of group ?? []) {
      const response = structuredClone(original) as Record<string, unknown>;
      if ("id" in response && ("result" in response || "error" in response)) {
        response.id = requestId;
      }
      this.send(response);
    }
  }
}

class StubbornChild extends FixtureChild {
  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

class CustomStdinChild extends EventEmitter implements AcpChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  private exited = false;

  constructor(readonly stdin: Writable) {
    super();
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
}

class RunningFixtureChild extends FixtureChild {
  readonly pid = 12_345;
}

function initializeResult(extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: {},
    },
    authMethods: [],
    ...extra,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("NdjsonFramer", () => {
  it("preserves UTF-8 characters and JSON records split across arbitrary chunks", () => {
    const lines: string[] = [];
    const framer = new NdjsonFramer((line) => lines.push(line));
    const input = Buffer.from('{"text":"Grøk"}\r\n{"done":true}\n');

    for (const byte of input) framer.push(Uint8Array.of(byte));
    framer.end();

    expect(lines).toEqual(['{"text":"Grøk"}', '{"done":true}']);
  });

  it("flushes a final non-newline-terminated record", () => {
    const lines: string[] = [];
    const framer = new NdjsonFramer((line) => lines.push(line));
    framer.end('{"last":1}');
    expect(lines).toEqual(['{"last":1}']);
  });
});

describe("AcpClient fixture replay", () => {
  it("uses cached CLI state without eager authentication", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ spawn: () => child });
    await client.initialize();

    expect(
      child.requests
        .filter((request) => "method" in request)
        .map((request) => request.method),
    ).toEqual(["initialize"]);
    await client.dispose();
  });

  it("authenticates and retries a session once after an auth failure", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const firstSession = child.requests.find(
      (request) => "method" in request && request.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: firstSession.id,
      error: { code: -32000, message: "Authentication required" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const sessionRequests = child.requests.filter(
      (request) => "method" in request && request.method === "session/new",
    ) as JsonRpcRequest[];
    expect(sessionRequests).toHaveLength(2);
    child.send({
      jsonrpc: "2.0",
      id: sessionRequests[1]?.id,
      result: { sessionId: "retried-session" },
    });

    await expect(pending).resolves.toMatchObject({
      sessionId: "retried-session",
    });
    expect(
      child.requests
        .filter((request) => "method" in request)
        .map((request) => request.method),
    ).toEqual(["initialize", "session/new", "authenticate", "session/new"]);
    await client.dispose();
  });

  it.each(["session/new", "session/load"] as const)(
    "authenticates and retries %s once after a legacy token-refresh failure",
    async (method) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [method]);
      const client = new AcpClient({ spawn: () => child });
      const requestsForMethod = (): JsonRpcRequest[] =>
        child.requests.filter(
          (request): request is JsonRpcRequest =>
            "method" in request && "id" in request && request.method === method,
        );
      const waitForRequest = async (index: number): Promise<JsonRpcRequest> => {
        await vi.waitFor(() =>
          expect(requestsForMethod()).toHaveLength(index + 1),
        );
        const request = requestsForMethod()[index];
        expect(request).toBeDefined();
        if (!request) {
          throw new Error(`Expected request ${index + 1} for ${method}.`);
        }
        return request;
      };

      try {
        const pending =
          method === "session/new"
            ? client.newSession({ cwd: "/fixture", mcpServers: [] })
            : client.loadSession({
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              });
        const firstRequest = await waitForRequest(0);
        child.send({
          jsonrpc: "2.0",
          id: firstRequest.id,
          error: { code: -32603, message: "token refresh failed" },
        });

        const retriedRequest = await waitForRequest(1);
        child.send({
          jsonrpc: "2.0",
          id: retriedRequest.id,
          result:
            method === "session/new" ? { sessionId: "retried-session" } : null,
        });

        await expect(pending).resolves.toEqual(
          method === "session/new" ? { sessionId: "retried-session" } : null,
        );
        expect(
          child.requests
            .filter((request) => "method" in request)
            .map((request) => request.method),
        ).toEqual(["initialize", method, "authenticate", method]);
      } finally {
        await client.dispose();
      }
    },
  );

  it.each(["session/new", "session/load"] as const)(
    "preserves the original %s auth failure when Grok advertises no authentication methods",
    async (method) => {
      const child = new FixtureChild(readFixture("config-options-1x.jsonl"), [
        method,
      ]);
      const client = new AcpClient({ spawn: () => child });

      try {
        const pending =
          method === "session/new"
            ? client.newSession({ cwd: "/fixture", mcpServers: [] })
            : client.loadSession({
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              });
        void pending.catch(() => undefined);
        await vi.waitFor(() => {
          expect(
            child.requests.filter(
              (request) => "method" in request && request.method === method,
            ),
          ).toHaveLength(1);
        });
        const request = child.requests.find(
          (message): message is JsonRpcRequest =>
            "method" in message && "id" in message && message.method === method,
        );
        expect(request).toBeDefined();
        if (!request) throw new Error(`Expected a ${method} request.`);
        child.send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32603, message: "token refresh failed" },
        });

        const error = await pending.catch((value: unknown) => value);
        expect(error).toMatchObject(
          method === "session/new"
            ? {
                name: "AcpAuthenticationError",
                code: "AUTHENTICATION_FAILED",
                cause: {
                  name: "AcpJsonRpcError",
                  code: "JSON_RPC_ERROR",
                  rpcCode: -32603,
                  rpcMessage: "token refresh failed",
                  method,
                },
              }
            : {
                name: "AcpJsonRpcError",
                code: "JSON_RPC_ERROR",
                rpcCode: -32603,
                rpcMessage: "token refresh failed",
                method,
              },
        );
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain(method);
          expect(error.message).toContain("-32603");
          expect(error.message).toContain("token refresh failed");
          expect(error.message).not.toContain("grok login");
          expect(error.message).not.toContain("apiKey");
        }
        expect(
          child.requests
            .filter((message) => "method" in message)
            .map((message) => message.method),
        ).toEqual(["initialize", method]);
      } finally {
        await client.dispose();
      }
    },
  );

  it.each(["session/new", "session/load"] as const)(
    "reports an unavailable configured method before retrying %s",
    async (method) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [method]);
      const client = new AcpClient({
        authMethod: "cached-token",
        spawn: () => child,
      });
      try {
        const pending =
          method === "session/new"
            ? client.newSession({ cwd: "/fixture", mcpServers: [] })
            : client.loadSession({
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              });
        void pending.catch(() => undefined);
        await vi.waitFor(() => {
          expect(
            child.requests.filter(
              (request) => "method" in request && request.method === method,
            ),
          ).toHaveLength(1);
        });
        const request = child.requests.find(
          (message): message is JsonRpcRequest =>
            "method" in message && "id" in message && message.method === method,
        );
        if (!request) throw new Error(`Expected a ${method} request.`);
        child.stderr.write(
          "unrelated Authorization: Bearer sk-unrelated-request\n",
        );
        child.send({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "Authentication required" },
        });

        const error = await pending.catch((value: unknown) => value);
        expect(error).toMatchObject({
          name: "AcpAuthenticationError",
          code: "AUTH_METHOD_NOT_AVAILABLE",
          stderr: undefined,
          cause: {
            name: "AcpJsonRpcError",
            method,
            rpcCode: -32000,
            stderr: undefined,
          },
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.message).toContain("cached-token");
          expect(error.message).toContain("cached_token");
          expect(error.message).not.toContain("sk-unrelated-request");
          expect(error.message).not.toContain("api_key");
        }
        expect(client.stderrTail).toContain("[REDACTED]");
        expect(client.stderrTail).not.toContain("sk-unrelated-request");
        expect(
          child.requests
            .filter((message) => "method" in message)
            .map((message) => message.method),
        ).toEqual(["initialize", method]);
      } finally {
        await client.dispose();
      }
    },
  );

  it("does not authenticate or replay session configuration after auth_required", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/set_config_option",
    ]);
    const client = new AcpClient({ spawn: () => child });
    try {
      const pending = client.setConfigOption({
        sessionId: "session-config-auth",
        configId: "model",
        value: "grok-4.5",
      });
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AcpJsonRpcError",
        rpcCode: -32000,
        method: "session/set_config_option",
      });
      await vi.waitFor(() =>
        expect(
          child.requests.some(
            (message) =>
              "method" in message &&
              "id" in message &&
              message.method === "session/set_config_option",
          ),
        ).toBe(true),
      );
      const request = child.requests.find(
        (message) =>
          "method" in message &&
          "id" in message &&
          message.method === "session/set_config_option",
      );
      expect(request).toBeDefined();
      if (!request || !("id" in request)) {
        throw new Error("Expected a session/set_config_option request.");
      }
      child.send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Authentication required" },
      });

      await rejection;
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        child.requests
          .filter((message) => "method" in message)
          .map((message) => message.method),
      ).toEqual(["initialize", "session/set_config_option"]);
    } finally {
      await client.dispose();
    }
  });

  it("replays text-only ACP with correlated results, updates, and extensions", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const updates: AcpSessionUpdateParams[] = [];
    const extensions: string[] = [];
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onExtension: (notification) => {
        extensions.push(notification.method);
      },
    });

    const initialized = await client.initialize();
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.authMethods[0]?.id).toBe("cached_token");

    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const result = await client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "ping" }],
      },
      {
        onUpdate: (update) => {
          updates.push(update);
        },
      },
    );

    const text = updates
      .filter((item) => item.update.sessionUpdate === "agent_message_chunk")
      .map((item) => {
        const content = (item.update as AcpMessageChunkUpdate).content;
        return content && isRecord(content) && content.type === "text"
          ? content.text
          : "";
      })
      .join("");
    expect(text).toBe("ping");
    expect(result.stopReason).toBe("end_turn");
    expect(result.meta?.usage?.modelCalls).toBe(2);
    expect(extensions).toContain("_x.ai/models/update");
    expect(
      child.requests
        .filter((request) => "method" in request)
        .map((request) => request.method),
    ).toEqual(["initialize", "session/new", "session/prompt"]);
    await client.dispose();
  });

  it("preserves captured tool input, xAI metadata, content, raw output, and usage", async () => {
    const child = new FixtureChild(readFixture("tool-use.jsonl"));
    const updates: AcpSessionUpdateParams[] = [];
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const result = await client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "inspect" }],
      },
      {
        onUpdate: (update) => {
          updates.push(update);
        },
      },
    );

    const call = updates.find(
      (item) => item.update.sessionUpdate === "tool_call",
    )?.update as AcpToolCallUpdate | undefined;
    expect(call?.rawInput).toMatchObject({
      command: expect.stringContaining("echo hello-acp"),
      description: "Echo hello-acp and create acp-probe.txt",
    });
    expect(call?._meta?.["x.ai/tool"]).toMatchObject({
      name: "run_terminal_command",
      kind: "execute",
    });

    const completed = updates
      .filter((item) => item.update.sessionUpdate === "tool_call_update")
      .map((item) => item.update as AcpToolCallProgressUpdate)
      .find((update) => update.status === "completed");
    expect(completed?.content?.[0]).toMatchObject({
      type: "content",
      content: { type: "text" },
    });
    expect(completed?.rawOutput).toMatchObject({
      exit_code: 0,
      truncated: false,
    });
    expect(result.meta?.usage).toMatchObject({ modelCalls: 2, numTurns: 2 });
    await client.dispose();
  });

  it("frames arbitrarily split NDJSON across tool-call and extension boundaries", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const updates: AcpSessionUpdateParams[] = [];
    const extensions: string[] = [];
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onExtension: (notification) => {
        extensions.push(notification.method);
      },
    });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const pending = client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "inspect" }],
      },
      {
        onUpdate: (value) => {
          updates.push(value);
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) =>
        "method" in message &&
        message.method === "session/prompt" &&
        "id" in message,
    ) as JsonRpcRequest | undefined;
    expect(request).toBeDefined();

    const messages = [
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-split",
            title: "Run",
            rawInput: { command: "pwd" },
          },
        },
      },
      {
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId: session.sessionId,
          update: { sessionUpdate: "noise" },
        },
      },
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-split",
            status: "completed",
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: request?.id,
        result: {
          stopReason: "end_turn",
          _meta: { usage: { inputTokens: 1 } },
        },
      },
    ];
    const wire = Buffer.from(
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
    for (let offset = 0; offset < wire.length; offset += 7) {
      child.sendRaw(wire.subarray(offset, offset + 7));
    }

    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(updates.map((value) => value.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
    ]);
    expect(extensions).toContain("_x.ai/session_notification");
    expect(extensions.at(-1)).toBe("_x.ai/session_notification");
    await client.dispose();
  });

  it("routes unknown session/update variants without confusing xAI extensions", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const updates: string[] = [];
    const extensions: string[] = [];
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onUpdate: ({ update }) => {
        updates.push(update.sessionUpdate);
      },
      onExtension: ({ method }) => {
        extensions.push(method);
      },
    });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: { sessionUpdate: "future_update", payload: true },
      },
    });
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/future_notification",
      params: { payload: true },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(updates).toEqual(["future_update"]);
    expect(extensions).toEqual(["_x.ai/future_notification"]);
    await client.dispose();
  });

  it("propagates AbortSignal as session/cancel and rejects the prompt", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const controller = new AbortController();
    const pending = client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "wait" }],
      },
      { signal: controller.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: session.sessionId },
    });
    await client.dispose();
  });

  it("isolates an aborted caller from the shared initialization handshake", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const controller = new AbortController();
    const first = client.initialize(controller.signal);
    const second = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "initialize",
    ) as JsonRpcRequest;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const result = readFixture("text-only.jsonl").find(
      (row) =>
        row.dir === "in" &&
        isRecord(row.msg) &&
        "result" in row.msg &&
        isRecord(row.msg.result) &&
        row.msg.result.protocolVersion === 1,
    );
    expect(result).toBeDefined();
    child.send({ ...(result?.msg as object), id: request.id });
    await expect(second).resolves.toMatchObject({ protocolVersion: 1 });
    expect(child.killSignals).toEqual([]);
    await client.dispose();
  });

  it("rejects an aborted queued prompt immediately while retaining queue order", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const params = (text: string) => ({
      sessionId: session.sessionId,
      prompt: [{ type: "text" as const, text }],
    });
    const first = client.prompt(params("first"));
    const controller = new AbortController();
    const second = client.prompt(params("second"), {
      signal: controller.signal,
    });
    const third = client.prompt(params("third"));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    let promptRequests = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(promptRequests).toHaveLength(1);
    child.send({
      jsonrpc: "2.0",
      id: promptRequests[0]?.id,
      result: { stopReason: "end_turn" },
    });
    await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
    await new Promise((resolve) => setImmediate(resolve));
    promptRequests = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(promptRequests).toHaveLength(2);
    child.send({
      jsonrpc: "2.0",
      id: promptRequests[1]?.id,
      result: { stopReason: "end_turn" },
    });
    await expect(third).resolves.toMatchObject({ stopReason: "end_turn" });
    await client.dispose();
  });

  it("sends session/cancel before releasing a timed-out prompt", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    await expect(
      client.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "wait" }],
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ name: "AcpTimeoutError" });
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: session.sessionId },
    });
    await client.dispose();
  });

  it("serializes session/load behind a prompt for the same session", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    const prompt = client.prompt({
      sessionId: "existing-session",
      prompt: [{ type: "text", text: "wait" }],
    });
    const load = client.loadSession({
      sessionId: "existing-session",
      cwd: "/fixture",
      mcpServers: [],
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      child.requests.some(
        (message) => "method" in message && message.method === "session/load",
      ),
    ).toBe(false);
    const promptRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(load).resolves.toBeNull();
    await client.dispose();
  });

  it("serializes session configuration behind a prompt for the same session", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
      "session/set_config_option",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    const prompt = client.prompt({
      sessionId: "existing-session",
      prompt: [{ type: "text", text: "wait" }],
    });
    const configuration = client.setConfigOption({
      sessionId: "existing-session",
      configId: "model",
      value: "grok-4.5",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      child.requests.some(
        (message) =>
          "method" in message && message.method === "session/set_config_option",
      ),
    ).toBe(false);

    const promptRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });
    await prompt;
    await new Promise((resolve) => setImmediate(resolve));
    const configRequest = child.requests.find(
      (message) =>
        "method" in message && message.method === "session/set_config_option",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: configRequest.id,
      result: { configOptions: [] },
    });
    await expect(configuration).resolves.toEqual({ configOptions: [] });
    await client.dispose();
  });

  it("sends boolean session configuration values", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/set_config_option",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.setConfigOption({
      sessionId: "session-boolean",
      configId: "streaming",
      type: "boolean",
      value: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) =>
        "method" in message && message.method === "session/set_config_option",
    ) as JsonRpcRequest;
    expect(request.params).toEqual({
      sessionId: "session-boolean",
      configId: "streaming",
      type: "boolean",
      value: false,
    });
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        configOptions: [
          {
            id: "streaming",
            name: "Streaming",
            type: "boolean",
            currentValue: false,
          },
        ],
      },
    });
    await expect(pending).resolves.toMatchObject({
      configOptions: [
        { id: "streaming", type: "boolean", currentValue: false },
      ],
    });
    await client.dispose();
  });

  it("keeps a client non-idle until its generation lease is released", () => {
    const client = new AcpClient();
    const release = client.acquireLease();
    expect(client.isIdle).toBe(false);
    release();
    release();
    expect(client.isIdle).toBe(true);
  });

  it("allows prompts for different sessions to run concurrently", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    const prompts = ["one", "two"].map((sessionId) =>
      client.prompt({
        sessionId,
        prompt: [{ type: "text", text: sessionId }],
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    const requests = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      child.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { stopReason: "end_turn" },
      });
    }
    await expect(Promise.all(prompts)).resolves.toHaveLength(2);
    await client.dispose();
  });

  it("capability-gates and sends the documented session/load request", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const result = await client.loadSession({
      sessionId: "existing-session",
      cwd: "/fixture",
      mcpServers: [],
    });

    expect(result).toBeNull();
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/load",
      params: {
        sessionId: "existing-session",
        cwd: "/fixture",
        mcpServers: [],
      },
    });
    await client.dispose();
  });

  it.each(["session/new", "session/load"] as const)(
    "propagates abort through %s preparation",
    async (method) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [method]);
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      const controller = new AbortController();
      const pending =
        method === "session/new"
          ? client.newSession(
              { cwd: "/fixture", mcpServers: [] },
              controller.signal,
            )
          : client.loadSession(
              {
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              },
              controller.signal,
            );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await client.dispose();
    },
  );

  it.each(["session/new", "session/load"] as const)(
    "keeps abort active while %s waits for extension callbacks",
    async (method) => {
      let releaseExtension!: () => void;
      const extensionReleased = new Promise<void>((resolve) => {
        releaseExtension = resolve;
      });
      let extensionStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        extensionStarted = resolve;
      });
      const child = new FixtureChild(readFixture("text-only.jsonl"), [method]);
      const client = new AcpClient({
        authMethod: false,
        spawn: () => child,
        onExtension: async () => {
          extensionStarted();
          await extensionReleased;
        },
      });
      await client.initialize();
      const controller = new AbortController();
      const pending =
        method === "session/new"
          ? client.newSession(
              { cwd: "/fixture", mcpServers: [] },
              controller.signal,
            )
          : client.loadSession(
              {
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              },
              controller.signal,
            );
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AbortError",
      });
      await new Promise((resolve) => setImmediate(resolve));
      const request = child.requests.find(
        (message) => "method" in message && message.method === method,
      ) as JsonRpcRequest;
      child.send({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params:
          method === "session/load" ? { sessionId: "existing-session" } : {},
      });
      child.send({
        jsonrpc: "2.0",
        id: request.id,
        result:
          method === "session/new"
            ? { sessionId: "new-session" }
            : { configOptions: [] },
      });

      await started;
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      await rejection;
      releaseExtension();
      await client.dispose();
    },
  );

  it("waits for both sessionless and returned-session callbacks on session/new", async () => {
    let releaseSessionless!: () => void;
    const sessionlessReleased = new Promise<void>((resolve) => {
      releaseSessionless = resolve;
    });
    let releaseSession!: () => void;
    const sessionReleased = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const started = new Set<string>();
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
    ]);
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onExtension: async ({ params }) => {
        const key =
          isRecord(params) && typeof params.sessionId === "string"
            ? params.sessionId
            : "sessionless";
        started.add(key);
        await (key === "new-session" ? sessionReleased : sessionlessReleased);
      },
    });
    await client.initialize();
    const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) =>
        "method" in message &&
        message.method === "session/new" &&
        "id" in message,
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/settings/update",
      params: {},
    });
    child.send({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: { sessionId: "new-session" },
    });
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: "new-session" },
    });

    await vi.waitFor(() =>
      expect(started).toEqual(new Set(["sessionless", "new-session"])),
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    releaseSessionless();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSession();
    await expect(pending).resolves.toMatchObject({ sessionId: "new-session" });
    await client.dispose();
  });

  it("propagates abort through lazy authentication without retrying the session", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const controller = new AbortController();
    const pending = client.newSession(
      { cwd: "/fixture", mcpServers: [] },
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const session = child.requests.find(
      (request) => "method" in request && request.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: session.id,
      error: { code: -32000, message: "Authentication required" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const originalCause = new Error("original abort cause");
    const abortReason = new Error("caller cancelled authentication", {
      cause: originalCause,
    });
    controller.abort(abortReason);

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBe(abortReason);
    expect(abortReason.cause).toBe(originalCause);
    expect(
      child.requests.filter(
        (request) => "method" in request && request.method === "session/new",
      ),
    ).toHaveLength(1);
    await client.dispose();
  });
});

describe("AcpClient failures", () => {
  it("maps synchronous ENOENT spawn failures to an actionable AcpSpawnError", async () => {
    const cause = Object.assign(new Error("spawn grok ENOENT"), {
      code: "ENOENT",
    });
    const client = new AcpClient({
      executable: "/missing/grok",
      spawn: () => {
        throw cause;
      },
    });

    await expect(client.initialize()).rejects.toMatchObject({
      name: "AcpSpawnError",
      code: "ENOENT",
      cause,
    });
    await expect(client.initialize()).rejects.toThrow(
      "Could not find Grok Build executable",
    );
  });

  it("maps the asynchronous ENOENT error emitted by ChildProcess", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({
      executable: "/missing/grok",
      spawn: () => child,
    });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const cause = Object.assign(new Error("spawn /missing/grok ENOENT"), {
      code: "ENOENT",
      path: "/missing/grok",
      syscall: "spawn /missing/grok",
    });
    child.failToSpawn(cause);

    await expect(pending).rejects.toMatchObject({
      name: "AcpSpawnError",
      code: "ENOENT",
      cause,
    });
    expect(client.failure?.message).toContain(
      "Could not find Grok Build executable '/missing/grok'",
    );
    child.stdin.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.failure).toBeInstanceOf(AcpSpawnError);
    await expect(client.dispose()).resolves.toBeUndefined();
  });

  it.each(["EAGAIN", "EPERM", "EMFILE"])(
    "classifies pre-start %s from a PID-less child as a spawn failure",
    async (code) => {
      const stdin = new Writable({
        write() {
          // Keep the initial write pending so no startup evidence is recorded.
        },
      });
      const child = new CustomStdinChild(stdin);
      const client = new AcpClient({ spawn: () => child });
      const pending = client.initialize();
      const cause = Object.assign(new Error(`spawn failed with ${code}`), {
        code,
      });
      child.emit("error", cause);

      await expect(pending).rejects.toMatchObject({
        name: "AcpSpawnError",
        code,
        cause,
      });
      expect(child.killSignals).toEqual([]);
      await client.dispose();
    },
  );

  it("fails initialization on a malformed JSON line", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.stderr.write("initialization parser detail\n");
    child.sendRaw(
      '{"jsonrpc":"2.0",not-json,"authorization":"Bearer\tsk-malformed-secret"}\n',
    );

    const error = await pending.catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
      stderr: "initialization parser detail\n",
    });
    expect(error).toBe(client.failure);
    expect((error as Error).message).not.toContain("sk-malformed-secret");
    expect(client.failure?.message).toContain(
      "Invalid JSON from Grok ACP stdout",
    );
    expect(client.failure?.message).not.toContain("sk-malformed-secret");
    expect(child.killSignals).toContain("SIGTERM");
  });

  it("rejects EPIPE writes without emitting an unhandled stream error", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(pipeError);
      },
    });
    const child = new CustomStdinChild(stdin);
    const client = new AcpClient({ spawn: () => child });

    await expect(client.initialize()).rejects.toMatchObject({ code: "EPIPE" });
    expect(client.isUsable).toBe(false);
    await client.dispose();
  });

  it("prefers process-exit context when EPIPE is followed by child exit", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
    });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback(pipeError);
      },
    });
    const child = new CustomStdinChild(stdin);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 9, null);
    child.stdout.end();
    child.stderr.end("complete crash output\n");

    const error = await pending.catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 9,
      stderr: "complete crash output\n",
    });
    expect(error).toBe(client.failure);
  });

  it("keeps terminal stdin diagnosis independent from terminate grace", async () => {
    vi.useFakeTimers();
    try {
      const pipeError = Object.assign(new Error("write EPIPE"), {
        code: "EPIPE",
      });
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(pipeError);
        },
      });
      const child = new CustomStdinChild(stdin);
      const client = new AcpClient({
        terminateGraceMs: 0,
        spawn: () => child,
      });
      const pending = client.initialize();
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(client.isUsable).toBe(false);
      expect(settled).toBe(false);

      child.emit("exit", 9, null);
      child.stdout.end();
      child.stderr.end("complete crash output\n");

      await expect(pending).rejects.toMatchObject({
        name: "AcpProcessExitError",
        code: "PROCESS_EXIT",
        exitCode: 9,
        stderr: "complete crash output\n",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["EOF", "ENOTCONN", "ECONNABORTED", "ECANCELED"])(
    "defers terminal stdin error %s to process-exit details",
    async (code) => {
      const stdinError = Object.assign(new Error(`write ${code}`), { code });
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(stdinError);
        },
      });
      const child = new CustomStdinChild(stdin);
      const client = new AcpClient({ spawn: () => child });
      const pending = client.initialize();
      await new Promise((resolve) => setImmediate(resolve));

      expect(client.isUsable).toBe(false);
      child.emit("exit", 11, null);
      child.stdout.end();
      child.stderr.end(`${code} crash detail\n`);

      await expect(pending).rejects.toMatchObject({
        name: "AcpProcessExitError",
        code: "PROCESS_EXIT",
        exitCode: 11,
        stderr: `${code} crash detail\n`,
      });
    },
  );

  it("waits for terminal diagnostics when reused during provisional EPIPE", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const failedWrite = client.notify("session/cancel", {
      sessionId: "session-terminal",
    });
    const writeRejection = expect(failedWrite).rejects.toMatchObject({
      name: "AcpProcessExitError",
      exitCode: 14,
      stderr: "terminal crash detail\n",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.isUsable).toBe(false);

    const release = client.acquireLease();
    const reinitialize = client.initialize();
    const initializeRejection = expect(reinitialize).rejects.toMatchObject({
      name: "AcpProcessExitError",
      exitCode: 14,
      stderr: "terminal crash detail\n",
    });
    child.failWithStderr("terminal crash detail\n", 14);

    await Promise.all([writeRejection, initializeRejection]);
    release();
    await client.dispose();
  });

  it("unblocks disposal when EPIPE occurs during the terminal-failure grace window", async () => {
    vi.useFakeTimers();
    try {
      const child = new StubbornChild(readFixture("text-only.jsonl"), [
        "session/prompt",
      ]);
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      const session = await client.newSession({
        cwd: "/fixture",
        mcpServers: [],
      });
      vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
        throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "wait" }],
      });
      const promptRejection = expect(prompt).rejects.toMatchObject({
        code: "CLIENT_DISPOSED",
      });
      await vi.advanceTimersByTimeAsync(0);

      const disposal = client.dispose();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(disposal).resolves.toBeUndefined();
      await promptRejection;
      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: session.sessionId },
      });
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores stdin errors emitted after the child exit event", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const child = new CustomStdinChild(stdin);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("exit", 4, null);
    stdin.emit(
      "error",
      Object.assign(new Error("late EPIPE"), { code: "EPIPE" }),
    );
    child.stdout.end();
    child.stderr.end("exit detail\n");

    await expect(pending).rejects.toMatchObject({
      name: "AcpProcessExitError",
      exitCode: 4,
      stderr: "exit detail\n",
    });
    expect(client.failure).toMatchObject({ code: "PROCESS_EXIT" });
  });

  it("keeps process-exit context when a pending write reports late EIO", async () => {
    let finishWrite!: (error?: Error | null) => void;
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        finishWrite = callback;
      },
    });
    const child = new CustomStdinChild(stdin);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("exit", 13, null);
    finishWrite(Object.assign(new Error("late write EIO"), { code: "EIO" }));
    child.stdout.end();
    child.stderr.end("late write crash detail\n");

    await expect(pending).rejects.toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 13,
      stderr: "late write crash detail\n",
    });
    expect(client.failure).toMatchObject({ code: "PROCESS_EXIT" });
  });

  it("rejects writes immediately when stdin is already destroyed", async () => {
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    stdin.destroy();
    const child = new CustomStdinChild(stdin);
    const client = new AcpClient({ spawn: () => child });

    await expect(client.initialize()).rejects.toMatchObject({
      code: "STDIN_NOT_WRITABLE",
    });
    expect(client.isUsable).toBe(false);
    await client.dispose();
  });

  it.each([
    ["EIO", "EIO"],
    ["EBADF", "EBADF"],
    [undefined, "STDIN_WRITE_FAILED"],
  ])(
    "treats an unlisted stdin error code %s as a fatal client failure",
    async (code, expectedCode) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"));
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      await client.initialize();
      vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
        throw Object.assign(new Error("fatal write failure"), { code });
      });

      await expect(
        client.notify("session/cancel", { sessionId: "fatal" }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(client.isUsable).toBe(false);
      await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
      await client.dispose();
    },
  );

  it("treats an error event from a running child as a runtime failure", async () => {
    const child = new RunningFixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const cause = Object.assign(new Error("runtime process error"), {
      code: "EIO",
    });
    child.emit("error", cause);

    await expect(pending).rejects.toMatchObject({
      name: "AcpError",
      code: "EIO",
      cause,
    });
    expect(client.failure).not.toBeInstanceOf(AcpSpawnError);
    await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
    await client.dispose();
  });

  it.each(["EIO", "ENOENT"])(
    "treats %s from a started PID-less custom child as a runtime failure",
    async (code) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [
        "initialize",
      ]);
      const client = new AcpClient({ spawn: () => child });
      const pending = client.initialize();
      await new Promise((resolve) => setImmediate(resolve));
      const cause = Object.assign(new Error("runtime process error"), { code });

      child.emit("error", cause);

      await expect(pending).rejects.toMatchObject({
        name: "AcpError",
        code,
        cause,
      });
      expect(client.failure).not.toBeInstanceOf(AcpSpawnError);
      await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
      await client.dispose();
    },
  );

  it("handles a missing runtime child error payload", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));

    child.emit("error");

    await expect(pending).rejects.toMatchObject({
      name: "AcpError",
      code: "PROCESS_ERROR",
    });
    await vi.waitFor(() => expect(child.killSignals).toContain("SIGTERM"));
    await client.dispose();
  });

  it("keeps an authentication-retry timeout primary with the initial failure as its cause", async () => {
    vi.useFakeTimers();
    try {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [
        "session/new",
        "authenticate",
      ]);
      const client = new AcpClient({
        requestTimeoutMs: 25,
        spawn: () => child,
      });
      const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
      const observed = pending.catch((value: unknown) => value);
      await vi.advanceTimersByTimeAsync(0);
      const sessionRequest = child.requests.find(
        (message) => "method" in message && message.method === "session/new",
      ) as JsonRpcRequest;
      child.send({
        jsonrpc: "2.0",
        id: sessionRequest.id,
        error: { code: -32000, message: "Authentication required" },
      });
      await vi.advanceTimersByTimeAsync(25);

      const error = await observed;
      expect(error).toMatchObject({
        name: "AcpTimeoutError",
        code: "TIMEOUT",
        method: "authenticate",
        cause: expect.any(AggregateError),
      });
      const aggregate = (error as Error).cause as AggregateError;
      expect(aggregate.errors).toEqual([
        expect.objectContaining({
          name: "AcpJsonRpcError",
          method: "session/new",
          rpcCode: -32000,
        }),
        expect.objectContaining({
          name: "AcpTimeoutError",
          method: "authenticate",
          code: "TIMEOUT",
        }),
      ]);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps both RPC failures when an authentication retry is rejected", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    try {
      const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
      await new Promise((resolve) => setImmediate(resolve));
      const sessionRequest = child.requests.find(
        (message) => "method" in message && message.method === "session/new",
      ) as JsonRpcRequest;
      child.send({
        jsonrpc: "2.0",
        id: sessionRequest.id,
        error: { code: -32000, message: "Authentication required" },
      });
      await new Promise((resolve) => setImmediate(resolve));
      const authenticateRequest = child.requests.find(
        (message) => "method" in message && message.method === "authenticate",
      ) as JsonRpcRequest;
      child.send({
        jsonrpc: "2.0",
        id: authenticateRequest.id,
        error: { code: -32000, message: "Cached token rejected" },
      });

      const error = await pending.catch((value: unknown) => value);
      expect(error).toMatchObject({
        name: "AcpAuthenticationError",
        code: "AUTHENTICATION_FAILED",
        cause: expect.any(AggregateError),
      });
      const aggregate = (error as Error).cause as AggregateError;
      expect(aggregate.errors).toEqual([
        expect.objectContaining({
          name: "AcpJsonRpcError",
          method: "session/new",
          rpcCode: -32000,
        }),
        expect.objectContaining({
          name: "AcpAuthenticationError",
          code: "AUTHENTICATION_FAILED",
          cause: expect.objectContaining({
            name: "AcpJsonRpcError",
            method: "authenticate",
            rpcCode: -32000,
          }),
        }),
      ]);
    } finally {
      await client.dispose();
    }
  });

  it.each(["session/new", "session/load"] as const)(
    "keeps the initial auth failure when the retried %s request also fails",
    async (method) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [method]);
      const client = new AcpClient({ spawn: () => child });
      const requestsForMethod = (): JsonRpcRequest[] =>
        child.requests.filter(
          (request): request is JsonRpcRequest =>
            "method" in request && "id" in request && request.method === method,
        );
      try {
        const pending =
          method === "session/new"
            ? client.newSession({ cwd: "/fixture", mcpServers: [] })
            : client.loadSession({
                sessionId: "existing-session",
                cwd: "/fixture",
                mcpServers: [],
              });
        void pending.catch(() => undefined);
        await vi.waitFor(() => expect(requestsForMethod()).toHaveLength(1));
        child.send({
          jsonrpc: "2.0",
          id: requestsForMethod()[0]?.id,
          error: { code: -32000, message: "Authentication required" },
        });
        await vi.waitFor(() => expect(requestsForMethod()).toHaveLength(2));
        child.send({
          jsonrpc: "2.0",
          id: requestsForMethod()[1]?.id,
          error: { code: -32603, message: "Session service unavailable" },
        });

        const error = await pending.catch((value: unknown) => value);
        expect(error).toMatchObject({
          name: "AcpJsonRpcError",
          method,
          rpcCode: -32603,
          cause: expect.any(AggregateError),
        });
        const aggregate = (error as Error).cause as AggregateError;
        expect(aggregate.errors).toEqual([
          expect.objectContaining({
            name: "AcpJsonRpcError",
            method,
            rpcCode: -32000,
          }),
          expect.objectContaining({
            name: "AcpJsonRpcError",
            method,
            rpcCode: -32603,
          }),
        ]);
        expect(error).not.toBe(aggregate.errors[1]);
      } finally {
        await client.dispose();
      }
    },
  );

  it("explains how to recover when an authentication method is unavailable", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ spawn: () => child });

    try {
      const error = await client
        .authenticate("unsupported_method")
        .catch((value: unknown) => value);

      expect(error).toMatchObject({
        name: "AcpAuthenticationError",
        code: "AUTH_METHOD_NOT_AVAILABLE",
      });
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toContain("unsupported_method");
        expect(error.message).toContain("cached_token");
        expect(error.message).toContain("authMethod");
        expect(error.message).not.toContain("grok login");
        expect(error.message).not.toContain("apiKey");
      }
    } finally {
      await client.dispose();
    }
  });

  it("wraps an authentication JSON-RPC failure without provider remediation", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.authenticate();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "authenticate",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message:
          "Authorization: Bearer sk-authenticate-secret\nError: Authentication required",
      },
    });

    const error = await pending.catch((value: unknown) => value);
    expect(error).toMatchObject({
      name: "AcpAuthenticationError",
      code: "AUTHENTICATION_FAILED",
      cause: {
        name: "AcpJsonRpcError",
        code: "JSON_RPC_ERROR",
        method: "authenticate",
      },
    });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain("Authentication required");
      expect(error.message).not.toContain("sk-authenticate-secret");
    }
    await client.dispose();
  });

  it("preserves transient JSON-RPC errors from authenticate", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.authenticate();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "authenticate",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "Authentication service unavailable" },
    });

    await expect(pending).rejects.toMatchObject({
      name: "AcpJsonRpcError",
      code: "JSON_RPC_ERROR",
      rpcCode: -32603,
      method: "authenticate",
    });
    await client.dispose();
  });

  it("wraps token-refresh internal errors from authenticate", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.authenticate();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "authenticate",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: "token refresh failed" },
    });

    await expect(pending).rejects.toMatchObject({
      name: "AcpAuthenticationError",
      code: "AUTHENTICATION_FAILED",
      cause: {
        name: "AcpJsonRpcError",
        code: "JSON_RPC_ERROR",
        rpcCode: -32603,
        rpcMessage: "token refresh failed",
        method: "authenticate",
      },
    });
    await client.dispose();
  });

  it("does not turn a process exit during authentication retry into a login error", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
      "authenticate",
      "session/load",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
    const observed = pending.catch((value: unknown) => value);
    await new Promise((resolve) => setImmediate(resolve));
    const sessionRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: sessionRequest.id,
      error: { code: -32000, message: "Authentication required" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const unrelated = client
      .request("session/load", {
        sessionId: "unrelated-session",
        cwd: "/fixture",
        mcpServers: [],
      })
      .catch((value: unknown) => value);
    await new Promise((resolve) => setImmediate(resolve));
    child.failWithStderr("authentication worker crashed\n", 17);

    const [error, unrelatedError] = await Promise.all([observed, unrelated]);
    expect(error).toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 17,
      cause: expect.any(AggregateError),
    });
    expect(error).not.toBe(client.failure);
    expect(unrelatedError).toBe(client.failure);
    expect(client.failure).toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      cause: undefined,
    });
    const aggregate = (error as Error).cause as AggregateError;
    expect(aggregate.errors[1]).toBe(client.failure);
  });

  it("does not turn disposal during authentication retry into a login error", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
      "authenticate",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AcpError",
      code: "CLIENT_DISPOSED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const sessionRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: sessionRequest.id,
      error: { code: -32000, message: "Authentication required" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await client.dispose();
    await rejection;
  });

  it("normalizes nullable initialize model state before caching it", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests[0] as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: initializeResult({ _meta: { modelState: null } }),
    });

    const initialized = await pending;
    expect(initialized._meta).not.toHaveProperty("modelState");
    expect(await client.initialize()).toBe(initialized);
    await client.dispose();
  });

  it("rejects malformed initialize model metadata with redacted data", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests[0] as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: initializeResult({
        _meta: {
          modelState: {
            currentModelId: "grok-4.5",
            availableModels: [
              {
                modelId: "grok-4.5",
                name: "Grok 4.5",
                apiKey: "wire-secret",
                _meta: { reasoningEfforts: { invalid: true } },
              },
            ],
          },
        },
      }),
    });

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AcpProtocolError);
    expect(JSON.stringify((error as AcpProtocolError).data)).not.toContain(
      "wire-secret",
    );
    expect(JSON.stringify((error as AcpProtocolError).data)).toContain(
      "[REDACTED]",
    );
    expect(client.isUsable).toBe(false);
    await client.dispose();
  });

  it("validates and preserves grouped, boolean, and future config options", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.newSession({ cwd: "/fixture", mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    const configOptions = [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "grok-4.5",
        options: [
          {
            group: "grok",
            name: "Grok",
            options: [{ value: "grok-4.5", name: "Grok 4.5" }],
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
        id: "future-option",
        name: "Future option",
        type: "range",
        currentValue: 3,
        bounds: { minimum: 1, maximum: 5 },
      },
    ];
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: "session-config", configOptions },
    });

    await expect(pending).resolves.toMatchObject({ configOptions });
    await client.dispose();
  });

  it("keeps malformed session responses local to their request", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/new",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const malformed = client.newSession({ cwd: "/fixture", mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const first = child.requests.find(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: first.id,
      result: {
        sessionId: "bad-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "grok-4.5",
            options: [{ value: "grok-4.5" }],
          },
        ],
      },
    });
    await expect(malformed).rejects.toBeInstanceOf(AcpProtocolError);
    expect(client.isUsable).toBe(true);

    const healthy = client.newSession({ cwd: "/fixture", mcpServers: [] });
    await new Promise((resolve) => setImmediate(resolve));
    const requests = child.requests.filter(
      (message) => "method" in message && message.method === "session/new",
    ) as JsonRpcRequest[];
    child.send({
      jsonrpc: "2.0",
      id: requests[1]?.id,
      result: { sessionId: "healthy-session" },
    });
    await expect(healthy).resolves.toMatchObject({
      sessionId: "healthy-session",
    });
    await client.dispose();
  });

  it.each([
    ["missing message", { code: -32603 }],
    ["non-string message", { code: -32603, message: 17 }],
    ["null error", null],
    ["missing code", { message: "failure" }],
  ])(
    "keeps a malformed JSON-RPC error with %s local to its request",
    async (_label, malformedError) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"), [
        "session/new",
        "session/load",
      ]);
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      try {
        const malformed = client.newSession({
          cwd: "/fixture",
          mcpServers: [],
        });
        const healthy = client.request("session/load", {
          sessionId: "healthy-session",
          cwd: "/fixture",
          mcpServers: [],
        });
        void malformed.catch(() => undefined);
        await vi.waitFor(() =>
          expect(
            child.requests.filter(
              (message) => "method" in message && "id" in message,
            ),
          ).toHaveLength(3),
        );
        const sessionRequest = child.requests.find(
          (message) => "method" in message && message.method === "session/new",
        ) as JsonRpcRequest;
        const loadRequest = child.requests.find(
          (message) => "method" in message && message.method === "session/load",
        ) as JsonRpcRequest;
        child.send({
          jsonrpc: "2.0",
          id: sessionRequest.id,
          error: malformedError,
        });
        child.send({ jsonrpc: "2.0", id: loadRequest.id, result: null });

        await expect(malformed).rejects.toMatchObject({
          name: "AcpProtocolError",
          code: "PROTOCOL_ERROR",
        });
        await expect(healthy).resolves.toBeNull();
        expect(client.failure).toBeUndefined();
        expect(client.isUsable).toBe(true);
      } finally {
        await client.dispose();
      }
    },
  );

  it("retires malformed initialization while attaching only sanitized initialization stderr", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    void pending.catch(() => undefined);
    await vi.waitFor(() => expect(child.requests).toHaveLength(1));
    const request = child.requests[0] as JsonRpcRequest;
    child.stderr.write(
      "initialize detail Authorization: Bearer sk-initialize-secret\n",
    );
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603 },
    });

    const error = await pending.catch((value: unknown) => value);
    expect(error).toBe(client.failure);
    expect(error).toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
      stderr: "initialize detail Authorization: Bearer [REDACTED]\n",
    });
    expect((error as Error).message).not.toContain("sk-initialize-secret");
    expect((error as Error).cause).toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
      stderr: undefined,
    });
    expect((error as Error).cause).not.toBe(error);
    expect(((error as Error).cause as Error).stack).toContain(
      "AcpProtocolError",
    );
    expect(client.isUsable).toBe(false);
    await client.dispose();
  });

  it("normalizes null authentication results while rejecting null prompts", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "authenticate",
      "session/prompt",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const authentication = client.authenticate();
    await new Promise((resolve) => setImmediate(resolve));
    const authenticateRequest = child.requests.find(
      (message) => "method" in message && message.method === "authenticate",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: authenticateRequest.id,
      result: null,
    });
    await expect(authentication).resolves.toEqual({});

    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "test" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const promptRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: null,
    });
    await expect(prompt).rejects.toBeInstanceOf(AcpProtocolError);
    expect(client.isUsable).toBe(true);
    await client.dispose();
  });

  it("includes stderr when the agent exits before emitting any stdout", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.failWithStderr("login required on stderr only\n", 7);

    await expect(pending).rejects.toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 7,
      stderr: "login required on stderr only\n",
    });
    expect(client.failure?.message).toContain(
      "Stderr tail: login required on stderr only",
    );
  });

  it("bounds process-exit reporting when stderr remains open", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const child = new CustomStdinChild(stdin);
      const client = new AcpClient({
        authMethod: false,
        requestTimeoutMs: 10_000,
        terminateGraceMs: 0,
        spawn: () => child,
      });
      const pending = client.initialize();
      const rejection = expect(pending).rejects.toMatchObject({
        name: "AcpProcessExitError",
        code: "PROCESS_EXIT",
        exitCode: 6,
        stderr: "inherited stderr still open\n",
      });
      await vi.advanceTimersByTimeAsync(0);
      child.stderr.write("inherited stderr still open\n");
      child.emit("exit", 6, null);
      child.stdout.end();

      await vi.advanceTimersByTimeAsync(500);

      await rejection;
      child.stderr.end();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an in-flight prompt when the agent exits mid-prompt", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const pending = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.failWithStderr("agent crashed during prompt\n", 9);

    await expect(pending).rejects.toMatchObject({
      name: "AcpProcessExitError",
      exitCode: 9,
    });
    expect(client.failure?.message).toContain("agent crashed during prompt");
  });

  it("correlates a buffered terminal response before reporting child exit", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const pending = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) =>
        "method" in message &&
        message.method === "session/prompt" &&
        "id" in message,
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn", _meta: { outputTokens: 1 } },
    });
    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();

    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("keeps process failure authoritative while a response awaits callbacks", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const client = new AcpClient({
      authMethod: false,
      terminateGraceMs: 0,
      spawn: () => child,
      onUpdate: async () => {
        updateStarted();
        await updateReleased;
      },
    });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    const rejection = expect(prompt).rejects.toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 0,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) =>
        "method" in message &&
        message.method === "session/prompt" &&
        "id" in message,
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();

    await started;
    let settled = false;
    void prompt.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(true);
    expect(client.failure).toMatchObject({ code: "PROCESS_EXIT", exitCode: 0 });

    await rejection;
    releaseUpdate();
  });

  it("keeps malformed buffered output authoritative over process exit", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.sendRaw('{"jsonrpc":"2.0",not-json}\n');
    child.stderr.write("parser crash detail\n");
    child.emit("exit", 12, null);
    child.stdout.end();
    child.stderr.end();

    await expect(pending).rejects.toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
      exitCode: 12,
      stderr: "parser crash detail\n",
      cause: {
        name: "AcpProtocolError",
        code: "PROTOCOL_ERROR",
      },
    });
  });

  it("reports unterminated crash JSON as a process exit with the parse failure as its cause", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.sendRaw('{"jsonrpc":"2.0","id":');
    child.stderr.write("panic: stdout writer aborted\n");
    child.emit("exit", 17, null);
    child.stdout.end();
    child.stderr.end();

    await expect(pending).rejects.toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 17,
      stderr: "panic: stdout writer aborted\n",
      cause: {
        name: "AcpProtocolError",
        code: "PROTOCOL_ERROR",
        data: { unterminatedAtEof: true },
      },
    });
  });

  it("keeps unterminated JSON on a clean exit as a protocol error", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.sendRaw('{"jsonrpc":"2.0","id":');
    child.emit("exit", 0, null);
    child.stdout.end();
    child.stderr.end();

    await expect(pending).rejects.toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
      exitCode: 0,
      data: { unterminatedAtEof: true },
    });
  });

  it("bounds shutdown and escalates from cancellation through SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const child = new StubbornChild(readFixture("text-only.jsonl"), [
        "session/prompt",
      ]);
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      const session = await client.newSession({
        cwd: "/fixture",
        mcpServers: [],
      });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "wait" }],
      });
      await vi.advanceTimersByTimeAsync(0);
      const rejection = expect(prompt).rejects.toMatchObject({
        code: "CLIENT_DISPOSED",
      });
      const disposal = client.dispose();
      await vi.advanceTimersByTimeAsync(1_000);
      await disposal;
      await rejection;

      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: session.sessionId },
      });
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps CLIENT_DISPOSED authoritative when cancel writes fail with EIO", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({
      authMethod: false,
      cancelGraceMs: 0,
      spawn: () => child,
    });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    const rejection = expect(prompt).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    vi.spyOn(child.stdin, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("cancel write EIO"), { code: "EIO" });
    });

    await expect(client.dispose()).resolves.toBeUndefined();
    await rejection;
    expect(client.failure).toBeUndefined();
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("ignores kill errors emitted during disposal", async () => {
    class KillErrorChild extends FixtureChild {
      override kill(signal?: NodeJS.Signals | number): boolean {
        this.killSignals.push(signal);
        this.emit(
          "error",
          Object.assign(new Error("kill EPERM"), { code: "EPERM" }),
        );
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", null, typeof signal === "string" ? signal : null);
        return false;
      }
    }

    const child = new KillErrorChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({
      authMethod: false,
      cancelGraceMs: 0,
      spawn: () => child,
    });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    const rejection = expect(prompt).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await new Promise((resolve) => setImmediate(resolve));

    await expect(client.dispose()).resolves.toBeUndefined();
    await rejection;
    expect(client.failure).toBeUndefined();
    expect(child.killSignals).toEqual(["SIGTERM"]);
  });

  it("preserves an authentication-required initialize JSON-RPC response", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    const initialize = child.requests[0] as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      id: initialize.id,
      error: {
        code: -32001,
        message: "Authentication required; run grok login",
      },
    });

    await expect(pending).rejects.toMatchObject({
      name: "AcpJsonRpcError",
      code: "JSON_RPC_ERROR",
      rpcCode: -32001,
      method: "initialize",
    });
  });
});

describe("AcpClient agent requests", () => {
  it("continues another session while a permission decision is pending", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    let decidePermission!: (result: AcpRequestPermissionResult) => void;
    const updates: string[] = [];
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onPermissionRequest: () =>
        new Promise<AcpRequestPermissionResult>((resolve) => {
          decidePermission = resolve;
        }),
    });
    await client.initialize();
    const prompt = client.prompt(
      {
        sessionId: "session-b",
        prompt: [{ type: "text", text: "continue" }],
      },
      {
        onUpdate: ({ update }) => {
          updates.push(update.sessionUpdate);
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const promptRequest = child.requests.find(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest;

    child.send({
      jsonrpc: "2.0",
      id: "permission-pending",
      method: "session/request_permission",
      params: {
        sessionId: "session-a",
        toolCall: { sessionUpdate: "tool_call_update", toolCallId: "call-a" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-b",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "still moving" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: promptRequest.id,
      result: { stopReason: "end_turn" },
    });

    let promptSettled = false;
    void prompt.finally(() => {
      promptSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(promptSettled).toBe(true);
    expect(updates).toEqual(["agent_message_chunk"]);
    expect(
      child.requests.some(
        (message) =>
          !("method" in message) && message.id === "permission-pending",
      ),
    ).toBe(false);
    expect(client.isIdle).toBe(false);

    await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    decidePermission({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        id: "permission-pending",
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      }),
    );
    await vi.waitFor(() => expect(client.isIdle).toBe(true));
    await client.dispose();
  });

  it("delivers a tool update before its permission request", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const order: string[] = [];
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onUpdate: async () => {
        order.push("update-start");
        updateStarted();
        await updateReleased;
        order.push("update-finish");
      },
      onPermissionRequest: () => {
        order.push("permission");
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-order",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-order",
          title: "Run",
          rawInput: {},
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: "permission-order",
      method: "session/request_permission",
      params: {
        sessionId: "session-order",
        toolCall: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-order",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });

    await started;
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["update-start"]);
    releaseUpdate();
    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        id: "permission-order",
        result: { outcome: { outcome: "selected", optionId: "allow" } },
      }),
    );
    expect(order).toEqual(["update-start", "update-finish", "permission"]);
    await client.dispose();
  });

  it("cancels a queued permission before invoking approval logic", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    let releaseRead!: () => void;
    const heldRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const onPermissionRequest = vi.fn(
      (): AcpRequestPermissionResult => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    );
    const client = new AcpClient({
      authMethod: false,
      alwaysApprove: true,
      onPermissionRequest,
      spawn: () => child,
      fileSystem: {
        readTextFile: async () => {
          readStarted();
          await heldRead;
          return { content: "fixture" };
        },
      },
    });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      id: "held-read",
      method: "fs/read_text_file",
      params: {
        sessionId: "session-cancelled",
        path: "/fixture/file.txt",
      },
    });
    await started;
    child.send({
      jsonrpc: "2.0",
      id: "queued-permission",
      method: "session/request_permission",
      params: {
        sessionId: "session-cancelled",
        toolCall: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-cancelled",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await client.cancelSession("session-cancelled");
    releaseRead();

    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        id: "queued-permission",
        result: { outcome: { outcome: "cancelled" } },
      }),
    );
    expect(onPermissionRequest).not.toHaveBeenCalled();
    expect(child.requests).not.toContainEqual({
      jsonrpc: "2.0",
      id: "queued-permission",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await client.dispose();
  });

  it("cancels a pending permission before closing stdin during disposal", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    let decidePermission!: (result: AcpRequestPermissionResult) => void;
    let permissionStarted = false;
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      onPermissionRequest: () =>
        new Promise<AcpRequestPermissionResult>((resolve) => {
          permissionStarted = true;
          decidePermission = resolve;
        }),
    });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      id: "permission-dispose",
      method: "session/request_permission",
      params: {
        sessionId: "session-dispose",
        toolCall: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-dispose",
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    await vi.waitFor(() => expect(permissionStarted).toBe(true));

    await expect(client.dispose()).resolves.toBeUndefined();
    decidePermission({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.failure).toBeUndefined();
  });

  it("processes filesystem writes to the same path in FIFO order", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      fileSystem: {
        writeTextFile: async ({ content }) => {
          started.push(content);
          if (content === "first") await firstHeld;
          return null;
        },
      },
    });
    await client.initialize();
    for (const [id, content] of [
      ["write-first", "first"],
      ["write-second", "second"],
    ] as const) {
      child.send({
        jsonrpc: "2.0",
        id,
        method: "fs/write_text_file",
        params: {
          sessionId: "session-write",
          path: "/fixture/shared.txt",
          content,
        },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(["first"]);
    expect(client.isIdle).toBe(false);

    releaseFirst();
    await vi.waitFor(() =>
      expect(
        child.requests.filter(
          (message) =>
            !("method" in message) &&
            ["write-first", "write-second"].includes(String(message.id)),
        ),
      ).toHaveLength(2),
    );
    expect(started).toEqual(["first", "second"]);
    const responses = child.requests.filter(
      (message) =>
        !("method" in message) &&
        ["write-first", "write-second"].includes(String(message.id)),
    );
    expect(
      responses.map((response) => ("id" in response ? response.id : null)),
    ).toEqual(["write-first", "write-second"]);
    await vi.waitFor(() => expect(client.isIdle).toBe(true));
    await client.dispose();
  });

  it("reports process exit without waiting for a hung file handler", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      fileSystem: {
        readTextFile: async () => {
          handlerStarted();
          return await new Promise(() => undefined);
        },
      },
    });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    child.send({
      jsonrpc: "2.0",
      id: "hung-read",
      method: "fs/read_text_file",
      params: {
        sessionId: session.sessionId,
        path: "/fixture/hung.txt",
      },
    });
    await started;
    child.failWithStderr("agent exited while handler was pending\n", 17);

    await expect(prompt).rejects.toMatchObject({
      name: "AcpProcessExitError",
      exitCode: 17,
    });
    await client.dispose();
  });

  it("selects an allow option only in bypassPermissions mode", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({
      authMethod: false,
      permissionMode: "bypassPermissions",
      spawn: () => child,
    });
    await client.initialize();

    child.send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { sessionUpdate: "tool_call_update", toolCallId: "call-1" },
        options: [
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    const response = child.requests.find(
      (message) => !("method" in message) && message.id === "permission-1",
    ) as unknown as JsonRpcResponse | undefined;
    // Responses are written to child.stdin and recorded by the same fake transport.
    expect(response).toMatchObject({
      id: "permission-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await client.dispose();
  });

  it("selects an allow option when alwaysApprove is explicitly enabled", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({
      authMethod: false,
      alwaysApprove: true,
      spawn: () => child,
    });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      id: "permission-always",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { sessionUpdate: "tool_call_update", toolCallId: "call-1" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
        ],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      id: "permission-always",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await client.dispose();
  });

  it("returns a clear permission error in default mode", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    child.send({
      jsonrpc: "2.0",
      id: "permission-2",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { sessionUpdate: "tool_call_update", toolCallId: "call-2" },
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const response = child.requests.find(
      (message) => !("method" in message) && message.id === "permission-2",
    ) as unknown as JsonRpcResponse | undefined;
    expect(response).toMatchObject({
      id: "permission-2",
      error: { code: -32001 },
    });
    expect(
      isRecord(response) && isRecord(response.error)
        ? response.error.message
        : "",
    ).toContain("reject (reject_once: Reject)");
    await client.dispose();
  });

  it("validates custom permission handler selections", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    client.registerRequestHandler("session/request_permission", () => ({
      outcome: { outcome: "selected", optionId: "unknown" },
    }));
    await client.initialize();

    child.send({
      jsonrpc: "2.0",
      id: "permission-custom",
      method: "session/request_permission",
      params: {
        sessionId: "session-1",
        toolCall: { sessionUpdate: "tool_call_update", toolCallId: "call-3" },
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      },
    });

    await vi.waitFor(() =>
      expect(child.requests).toContainEqual({
        jsonrpc: "2.0",
        id: "permission-custom",
        error: {
          code: -32001,
          message:
            "Permission callback selected unknown option 'unknown'. Options: reject (reject_once: Reject).",
        },
      }),
    );
    await client.dispose();
  });

  it.each([
    ["undefined", undefined, "invalid result"],
    ["malformed", { outcome: {} }, "invalid outcome"],
  ])(
    "returns a clear permission error for a %s handler result",
    async (label, handlerResult, expectedMessage) => {
      const child = new FixtureChild(readFixture("text-only.jsonl"));
      const client = new AcpClient({ authMethod: false, spawn: () => child });
      client.registerRequestHandler(
        "session/request_permission",
        () => handlerResult as never,
      );
      await client.initialize();

      child.send({
        jsonrpc: "2.0",
        id: `permission-${label}`,
        method: "session/request_permission",
        params: {
          sessionId: "session-1",
          toolCall: {
            sessionUpdate: "tool_call_update",
            toolCallId: "call-4",
          },
          options: [
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });

      await vi.waitFor(() =>
        expect(child.requests).toContainEqual({
          jsonrpc: "2.0",
          id: `permission-${label}`,
          error: {
            code: -32001,
            message: expect.stringContaining(expectedMessage),
          },
        }),
      );
      await client.dispose();
    },
  );

  it("advertises and handles filesystem RPCs only when explicitly enabled", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"));
    const client = new AcpClient({
      authMethod: false,
      spawn: () => child,
      fileSystem: {
        readTextFile: ({ path }) => ({ content: `read:${path}` }),
      },
    });
    await client.initialize();
    expect(child.requests[0]).toMatchObject({
      params: {
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
        },
      },
    });

    child.send({
      jsonrpc: "2.0",
      id: "read-1",
      method: "fs/read_text_file",
      params: { sessionId: "session-1", path: "/fixture/file.txt" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.requests).toContainEqual({
      jsonrpc: "2.0",
      id: "read-1",
      result: { content: "read:/fixture/file.txt" },
    });
    await client.dispose();
  });

  it("maps synchronous ENOENT spawn failures to AcpSpawnError with an install hint", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT",
    });
    const client = new AcpClient({
      spawn: () => {
        throw missing;
      },
    });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "AcpSpawnError",
      code: "ENOENT",
    } satisfies Partial<AcpSpawnError>);
    await expect(client.initialize()).rejects.toThrow(
      "ensure 'grok' is on PATH",
    );
  });
});

describe("AcpClient prompt concurrency", () => {
  it("serializes prompts for one session", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    const first = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "first" }],
    });
    const second = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "second" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    let prompts = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(prompts).toHaveLength(1);
    child.send({
      jsonrpc: "2.0",
      id: prompts[0]?.id,
      result: { stopReason: "end_turn" },
    });
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    prompts = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(prompts).toHaveLength(2);
    child.send({
      jsonrpc: "2.0",
      id: prompts[1]?.id,
      result: { stopReason: "end_turn" },
    });
    await second;
    await client.dispose();
  });

  it("allows prompts on different sessions concurrently", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    const first = client.prompt({
      sessionId: "session-a",
      prompt: [{ type: "text", text: "first" }],
    });
    const second = client.prompt({
      sessionId: "session-b",
      prompt: [{ type: "text", text: "second" }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    const prompts = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      child.send({
        jsonrpc: "2.0",
        id: prompt.id,
        result: { stopReason: "end_turn" },
      });
    }
    await Promise.all([first, second]);
    await client.dispose();
  });

  it("keeps per-prompt update callback failures isolated", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    const healthyUpdates: string[] = [];
    const failedHandler = client.prompt(
      {
        sessionId: "session-failed-handler",
        prompt: [{ type: "text", text: "first" }],
      },
      {
        onUpdate: () => {
          throw new Error("consumer callback failed");
        },
      },
    );
    const healthy = client.prompt(
      {
        sessionId: "session-healthy-handler",
        prompt: [{ type: "text", text: "second" }],
      },
      {
        onUpdate: ({ update }) => {
          healthyUpdates.push(update.sessionUpdate);
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const prompts = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    for (const sessionId of [
      "session-failed-handler",
      "session-healthy-handler",
    ]) {
      child.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: sessionId },
          },
        },
      });
      const prompt = prompts.find(
        (request) =>
          isRecord(request.params) && request.params.sessionId === sessionId,
      );
      child.send({
        jsonrpc: "2.0",
        id: prompt?.id,
        result: { stopReason: "end_turn" },
      });
    }

    await expect(Promise.all([failedHandler, healthy])).resolves.toHaveLength(
      2,
    );
    expect(healthyUpdates).toEqual(["agent_message_chunk"]);
    expect(client.failure).toBeUndefined();
    expect(client.isUsable).toBe(true);
    await client.dispose();
  });

  it("does not let a blocked session callback delay another session", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondUpdates: string[] = [];
    const first = client.prompt(
      {
        sessionId: "session-a",
        prompt: [{ type: "text", text: "first" }],
      },
      {
        onUpdate: async () => {
          firstStarted();
          await firstReleased;
        },
      },
    );
    const second = client.prompt(
      {
        sessionId: "session-b",
        prompt: [{ type: "text", text: "second" }],
      },
      {
        onUpdate: ({ update }) => {
          secondUpdates.push(update.sessionUpdate);
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const requests = child.requests.filter(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest[];
    const requestFor = (sessionId: string) =>
      requests.find(
        (request) =>
          isRecord(request.params) && request.params.sessionId === sessionId,
      ) as JsonRpcRequest;

    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-a",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "blocked" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: requestFor("session-a").id,
      result: { stopReason: "end_turn" },
    });
    await started;
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-b",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "healthy" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: requestFor("session-b").id,
      result: { stopReason: "end_turn" },
    });

    await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(secondUpdates).toEqual(["agent_message_chunk"]);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ stopReason: "end_turn" });
    await client.dispose();
  });

  it("keeps prompt deadlines active and skips queued callbacks after timeout", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    vi.useFakeTimers();
    try {
      let releaseUpdate!: () => void;
      const updateReleased = new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      let updateStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        updateStarted = resolve;
      });
      let callbackCount = 0;
      const prompt = client.prompt(
        {
          sessionId: "session-timeout",
          prompt: [{ type: "text", text: "wait" }],
        },
        {
          timeoutMs: 25,
          onUpdate: async () => {
            callbackCount++;
            if (callbackCount === 1) {
              updateStarted();
              await updateReleased;
            }
          },
        },
      );
      const rejection = expect(prompt).rejects.toMatchObject({
        name: "AcpTimeoutError",
        code: "TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(0);
      const request = child.requests.find(
        (message) => "method" in message && message.method === "session/prompt",
      ) as JsonRpcRequest;
      for (const text of ["first", "second"]) {
        child.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-timeout",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        });
      }
      child.send({
        jsonrpc: "2.0",
        id: request.id,
        result: { stopReason: "end_turn" },
      });

      await started;
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      releaseUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(callbackCount).toBe(1);
    } finally {
      vi.useRealTimers();
      await client.dispose();
    }
  });

  it("deactivates queued prompt callbacks as soon as the prompt is aborted", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    await client.initialize();
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    let callbackCount = 0;
    const controller = new AbortController();
    const prompt = client.prompt(
      {
        sessionId: "session-abort",
        prompt: [{ type: "text", text: "wait" }],
      },
      {
        signal: controller.signal,
        onUpdate: async () => {
          callbackCount++;
          if (callbackCount === 1) {
            updateStarted();
            await updateReleased;
          }
        },
      },
    );
    const rejection = expect(prompt).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const text of ["first", "second"]) {
      child.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-abort",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
    }

    await started;
    controller.abort();
    releaseUpdate();
    await rejection;
    await new Promise((resolve) => setImmediate(resolve));
    expect(callbackCount).toBe(1);
    await client.dispose();
  });

  it("keeps disposal active while a response awaits callbacks", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "session/prompt",
    ]);
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    const client = new AcpClient({
      authMethod: false,
      cancelGraceMs: 0,
      spawn: () => child,
    });
    await client.initialize();
    const prompt = client.prompt(
      {
        sessionId: "session-dispose-callback",
        prompt: [{ type: "text", text: "wait" }],
      },
      {
        onUpdate: async () => {
          updateStarted();
          await updateReleased;
        },
      },
    );
    const rejection = expect(prompt).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = child.requests.find(
      (message) => "method" in message && message.method === "session/prompt",
    ) as JsonRpcRequest;
    child.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-dispose-callback",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "held" },
        },
      },
    });
    child.send({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn" },
    });
    await started;

    const disposal = client.dispose();
    releaseUpdate();
    await rejection;
    await disposal;
  });
});
