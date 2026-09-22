import {
  AcpClient,
  resolveAcpClientOptions,
  waitForAcpClientTerminalFailure,
  type AcpClientOptions,
} from "./client.js";
import { AcpError } from "./errors.js";

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function identity(value: object | undefined): number | undefined {
  if (!value) return undefined;
  let id = identities.get(value);
  if (!id) {
    id = nextIdentity++;
    identities.set(value, id);
  }
  return id;
}

function sortedEnvironment(env: NodeJS.ProcessEnv | undefined) {
  return env
    ? Object.fromEntries(
        Object.entries(env).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      )
    : undefined;
}

function settingIdentity(
  value: boolean | object | undefined,
): boolean | number | undefined {
  return typeof value === "boolean" ? value : identity(value);
}

/** A provider-local pool keyed only by options that affect process behavior. */
export class AcpClientPool {
  private readonly clients = new Map<
    string,
    { client: AcpClient; lastUsed: number }
  >();
  private readonly maxClients: number;
  private usageClock = 0;
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly retiredClients = new Set<AcpClient>();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(options: { maxClients?: number } = {}) {
    const maxClients = options.maxClients ?? 8;
    if (!Number.isInteger(maxClients) || maxClients <= 0) {
      throw new TypeError("maxClients must be a positive integer.");
    }
    this.maxClients = maxClients;
  }

  acquire(options: AcpClientOptions): AcpClient {
    if (this.closing) {
      throw new AcpError("The Grok Agent provider is closed.", {
        code: "PROVIDER_CLOSED",
      });
    }
    const resolved = resolveAcpClientOptions(options);
    const key = JSON.stringify({
      executable: resolved.executable,
      args: resolved.args,
      cwd: resolved.cwd,
      env: sortedEnvironment(resolved.env),
      requestTimeoutMs: resolved.requestTimeoutMs,
      stderrLimit: resolved.stderrLimit,
      cancelGraceMs: resolved.cancelGraceMs,
      terminateGraceMs: resolved.terminateGraceMs,
      killGraceMs: resolved.killGraceMs,
      authMethod: resolved.authMethod,
      permissionMode: resolved.permissionMode,
      alwaysApprove: resolved.alwaysApprove,
      permissionHandler: identity(resolved.onPermissionRequest),
      readTextFile: settingIdentity(resolved.fileSystem.readTextFile),
      writeTextFile: settingIdentity(resolved.fileSystem.writeTextFile),
      updateHandler: identity(resolved.onUpdate),
      extensionHandler: identity(resolved.onExtension),
      spawn: identity(resolved.spawn),
    });
    const existing = this.clients.get(key);
    if (existing?.client.isUsable) {
      existing.lastUsed = ++this.usageClock;
      return existing.client;
    }
    if (existing) {
      this.clients.delete(key);
      this.retire(existing.client);
    }
    for (const [staleKey, entry] of this.clients) {
      if (!entry.client.isUsable) {
        this.clients.delete(staleKey);
        this.retire(entry.client);
      }
    }
    if (this.clients.size >= this.maxClients) {
      const idle = [...this.clients.entries()]
        .filter(([, entry]) => entry.client.isIdle)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
      if (!idle) {
        throw new AcpError(
          `The Grok Agent client pool reached its ${String(this.maxClients)}-client capacity and all clients are active.`,
          { code: "POOL_CAPACITY_EXCEEDED" },
        );
      }
      this.clients.delete(idle[0]);
      this.disposeDetached(idle[1].client);
    }
    const client = new AcpClient(options);
    this.clients.set(key, { client, lastUsed: ++this.usageClock });
    return client;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= (async () => {
      const clients = new Set([
        ...[...this.clients.values()].map(({ client }) => client),
        ...this.retiredClients,
      ]);
      await Promise.allSettled([
        ...[...clients].map(async (client) => await client.dispose()),
        ...this.pendingDisposals,
      ]);
      this.clients.clear();
      this.retiredClients.clear();
    })();
    await this.closePromise;
  }

  private disposeDetached(client: AcpClient): void {
    const disposal = client.dispose().catch(() => undefined);
    this.pendingDisposals.add(disposal);
    void disposal.then(() => this.pendingDisposals.delete(disposal));
  }

  private retire(client: AcpClient): void {
    if (this.retiredClients.has(client)) return;
    this.retiredClients.add(client);
    const disposal = waitForAcpClientTerminalFailure(client)
      .then(async () => await client.dispose())
      .catch(() => undefined)
      .finally(() => this.retiredClients.delete(client));
    this.pendingDisposals.add(disposal);
    void disposal.then(() => this.pendingDisposals.delete(disposal));
  }
}
