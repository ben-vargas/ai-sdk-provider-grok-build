import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AcpChildProcess } from "./client.js";
import { AcpClientPool } from "./client-pool.js";

class HoldingChild extends EventEmitter implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  private exited = false;

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

class InitializeChild extends HoldingChild {
  constructor(result: unknown) {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const request = JSON.parse(line) as {
          id?: string | number;
          method?: string;
        };
        if (request.method === "initialize") {
          this.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
          );
        } else if (request.method === "session/new") {
          this.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: { sessionId: "pool-session" },
            })}\n`,
          );
        }
        newline = buffer.indexOf("\n");
      }
    });
  }
}

describe("AcpClientPool", () => {
  it("reuses matching usable clients and separates process-affecting settings", async () => {
    const pool = new AcpClientPool();
    const first = pool.acquire({ executable: "grok", cwd: "/one" });
    expect(pool.acquire({ executable: "grok", cwd: "/one" })).toBe(first);
    expect(pool.acquire({ executable: "grok", cwd: "/two" })).not.toBe(first);
    await pool.close();
  });

  it("canonicalizes defaults and filesystem handler identities", async () => {
    const readTextFile = async () => ({ content: "fixture" });
    const pool = new AcpClientPool();
    const first = pool.acquire({ fileSystem: { readTextFile } });
    expect(
      pool.acquire({
        executable: "grok",
        requestTimeoutMs: 30_000,
        permissionMode: "default",
        alwaysApprove: false,
        fileSystem: { readTextFile },
      }),
    ).toBe(first);
    await pool.close();
  });

  it("separates constructor-bound update and extension handlers", async () => {
    const pool = new AcpClientPool();
    const first = pool.acquire({
      onUpdate: () => undefined,
      onExtension: () => undefined,
    });
    const second = pool.acquire({
      onUpdate: () => undefined,
      onExtension: () => undefined,
    });
    expect(second).not.toBe(first);
    await pool.close();
  });

  it("replaces disposed clients on the next acquisition", async () => {
    const pool = new AcpClientPool();
    const first = pool.acquire({ executable: "grok" });
    await first.dispose();
    const replacement = pool.acquire({ executable: "grok" });
    expect(replacement).not.toBe(first);
    await pool.close();
  });

  it("replaces clients that have exited on the next acquisition", async () => {
    const failure = Object.assign(new Error("spawn failed"), { code: "EIO" });
    const spawn = () => {
      throw failure;
    };
    const options = { executable: "grok", spawn };
    const pool = new AcpClientPool();
    const first = pool.acquire(options);
    await expect(first.initialize()).rejects.toMatchObject({ code: "EIO" });
    expect(first.isUsable).toBe(false);
    expect(pool.acquire(options)).not.toBe(first);
    await pool.close();
  });

  it("replaces a client after malformed initialization metadata", async () => {
    const valid = {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    };
    let spawned = 0;
    const spawn = () =>
      new InitializeChild(
        spawned++ === 0
          ? {
              ...valid,
              _meta: {
                modelState: {
                  currentModelId: "grok-4.5",
                  availableModels: [
                    {
                      modelId: "grok-4.5",
                      name: "Grok 4.5",
                      _meta: { reasoningEfforts: "invalid" },
                    },
                  ],
                },
              },
            }
          : valid,
      );
    const options = { spawn };
    const pool = new AcpClientPool();
    const first = pool.acquire(options);
    await expect(first.initialize()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });

    const replacement = pool.acquire(options);
    expect(replacement).not.toBe(first);
    await expect(replacement.initialize()).resolves.toMatchObject({
      protocolVersion: 1,
    });
    await pool.close();
  });

  it("closes idempotently and rejects new acquisitions", async () => {
    const pool = new AcpClientPool();
    pool.acquire({ executable: "grok" });
    await Promise.all([pool.close(), pool.close()]);
    expect(() => pool.acquire({ executable: "grok" })).toThrow(
      "provider is closed",
    );
  });

  it("replaces but does not dispose a client during provisional EPIPE diagnosis", async () => {
    const result = {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    };
    const firstChild = new InitializeChild(result);
    const replacementChild = new InitializeChild(result);
    const children = [firstChild, replacementChild];
    let spawned = 0;
    const pool = new AcpClientPool({ maxClients: 1 });
    const options = {
      authMethod: false,
      cancelGraceMs: 10,
      spawn: () => children[spawned++] as InitializeChild,
    } as const;
    const client = pool.acquire(options);
    const disposeSpy = vi.spyOn(client, "dispose");
    const release = client.acquireLease();
    const session = await client.newSession({
      cwd: "/fixture",
      mcpServers: [],
    });
    vi.spyOn(firstChild.stdin, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "wait" }],
    });
    const rejection = expect(prompt).rejects.toMatchObject({
      name: "AcpProcessExitError",
      code: "PROCESS_EXIT",
      exitCode: 9,
      stderr: "complete crash output\n",
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.isUsable).toBe(false);
    const replacement = pool.acquire(options);
    expect(replacement).not.toBe(client);
    expect(firstChild.killSignals).toEqual([]);
    expect(disposeSpy).not.toHaveBeenCalled();

    firstChild.stderr.write("complete crash output\n");
    firstChild.emit("exit", 9, null);
    firstChild.stdout.end();
    firstChild.stderr.end();

    await rejection;
    await vi.waitFor(() => expect(disposeSpy).toHaveBeenCalledOnce());
    release();
    expect(firstChild.killSignals).toEqual([]);
    await expect(pool.close()).resolves.toBeUndefined();
  });

  it("closes clients retired during provisional stdin diagnosis", async () => {
    const result = {
      protocolVersion: 1,
      agentCapabilities: {},
      authMethods: [],
    };
    const firstChild = new InitializeChild(result);
    const replacementChild = new InitializeChild(result);
    const children = [firstChild, replacementChild];
    let spawned = 0;
    const pool = new AcpClientPool({ maxClients: 1 });
    const options = {
      authMethod: false,
      terminateGraceMs: 0,
      spawn: () => children[spawned++] as InitializeChild,
    } as const;
    const client = pool.acquire(options);
    await client.initialize();
    vi.spyOn(firstChild.stdin, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });
    const failedWrite = client.notify("session/cancel", {
      sessionId: "retired-session",
    });
    const rejection = expect(failedWrite).rejects.toMatchObject({
      code: "EPIPE",
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.acquire(options)).not.toBe(client);
    await expect(pool.close()).resolves.toBeUndefined();
    await rejection;
    expect(firstChild.killSignals).toContain("SIGTERM");
  });

  it("evicts the least-recently-used idle client at capacity", async () => {
    const pool = new AcpClientPool({ maxClients: 2 });
    const first = pool.acquire({ executable: "grok", cwd: "/one" });
    const second = pool.acquire({ executable: "grok", cwd: "/two" });
    expect(pool.acquire({ executable: "grok", cwd: "/one" })).toBe(first);
    const third = pool.acquire({ executable: "grok", cwd: "/three" });
    expect(third).not.toBe(first);
    await vi.waitFor(() => expect(second.isUsable).toBe(false));
    expect(first.isUsable).toBe(true);
    await pool.close();
  });

  it("rejects a new identity when every client is active", async () => {
    const child = new HoldingChild();
    const pool = new AcpClientPool({ maxClients: 1 });
    const client = pool.acquire({ spawn: () => child });
    const initialization = client.initialize();
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => pool.acquire({ cwd: "/other" })).toThrowError(
      expect.objectContaining({ code: "POOL_CAPACITY_EXCEEDED" }),
    );
    await pool.close();
    await expect(initialization).rejects.toMatchObject({
      code: "CLIENT_DISPOSED",
    });
  });

  it("does not evict a leased client between generation requests", async () => {
    const pool = new AcpClientPool({ maxClients: 1 });
    const first = pool.acquire({ cwd: "/one" });
    const release = first.acquireLease();
    expect(() => pool.acquire({ cwd: "/two" })).toThrowError(
      expect.objectContaining({ code: "POOL_CAPACITY_EXCEEDED" }),
    );

    release();
    const second = pool.acquire({ cwd: "/two" });
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(first.isUsable).toBe(false));
    await pool.close();
  });

  it("does not evict a client while an agent request handler is running", async () => {
    const child = new InitializeChild({ protocolVersion: 1 });
    const pool = new AcpClientPool({ maxClients: 1 });
    const client = pool.acquire({
      authMethod: false,
      cwd: "/one",
      spawn: () => child,
    });
    await client.initialize();
    let releaseHandler!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    client.registerRequestHandler("fs/write_text_file", async () => {
      handlerStarted();
      await held;
      return null;
    });
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "write-held",
        method: "fs/write_text_file",
        params: {
          sessionId: "session-held",
          path: "/fixture/file.txt",
          content: "held",
        },
      })}\n`,
    );
    await started;

    expect(client.isIdle).toBe(false);
    expect(() => pool.acquire({ cwd: "/two" })).toThrowError(
      expect.objectContaining({ code: "POOL_CAPACITY_EXCEEDED" }),
    );

    releaseHandler();
    await vi.waitFor(() => expect(client.isIdle).toBe(true));
    const replacement = pool.acquire({ cwd: "/two" });
    expect(replacement).not.toBe(client);
    await pool.close();
  });

  it("handles and drains detached disposal failures", async () => {
    const pool = new AcpClientPool({ maxClients: 1 });
    const first = pool.acquire({ cwd: "/one" });
    let rejectDisposal!: (reason: unknown) => void;
    const disposal = new Promise<void>((_resolve, reject) => {
      rejectDisposal = reject;
    });
    const dispose = vi.spyOn(first, "dispose").mockReturnValue(disposal);
    pool.acquire({ cwd: "/two" });
    let closed = false;
    const closing = pool.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    rejectDisposal(new Error("teardown failed"));
    await expect(closing).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
