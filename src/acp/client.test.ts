import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AcpClient, NdjsonFramer, type AcpChildProcess } from "./client.js";
import { AcpSpawnError } from "./errors.js";
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
      error: { code: -32001, message: "Authentication required" },
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
      error: { code: -32001, message: "Authentication required" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
  });

  it("fails initialization on a malformed JSON line", async () => {
    const child = new FixtureChild(readFixture("text-only.jsonl"), [
      "initialize",
    ]);
    const client = new AcpClient({ authMethod: false, spawn: () => child });
    const pending = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    child.sendRaw('{"jsonrpc":"2.0",not-json}\n');

    await expect(pending).rejects.toMatchObject({
      name: "AcpProtocolError",
      code: "PROTOCOL_ERROR",
    });
    expect(client.failure?.message).toContain(
      "Invalid JSON from Grok ACP stdout",
    );
    expect(child.killSignals).toContain("SIGTERM");
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

    await expect(pending).resolves.toMatchObject({ stopReason: "end_turn" });
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
      await vi.runAllTimersAsync();
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
  it("continues reading other sessions while a permission decision is pending", async () => {
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

    await expect(prompt).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(updates).toEqual(["agent_message_chunk"]);
    expect(
      child.requests.some(
        (message) =>
          !("method" in message) && message.id === "permission-pending",
      ),
    ).toBe(false);
    expect(client.isIdle).toBe(false);

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
});
