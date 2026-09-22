import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AcpChildProcess } from "./client.js";
import { AcpClientPool } from "./client-pool.js";

class HoldingChild extends EventEmitter implements AcpChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
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

  it("closes idempotently and rejects new acquisitions", async () => {
    const pool = new AcpClientPool();
    pool.acquire({ executable: "grok" });
    await Promise.all([pool.close(), pool.close()]);
    expect(() => pool.acquire({ executable: "grok" })).toThrow(
      "provider is closed",
    );
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
