import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { abortError, waitAbortably } from "../abort.js";
import { isRecord } from "../type-guards.js";
import {
  AcpAuthenticationError,
  AcpError,
  AcpJsonRpcError,
  AcpPermissionError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSpawnError,
  AcpTimeoutError,
  isAcpAuthenticationRpcError,
} from "./errors.js";
import type {
  AcpAgentRequestMap,
  AcpAuthenticateResult,
  AcpCancelParams,
  AcpExtensionNotification,
  AcpInitializeResult,
  AcpLoadSessionParams,
  AcpLoadSessionResult,
  AcpNewSessionParams,
  AcpNotificationMap,
  AcpPromptParams,
  AcpPromptResultMeta,
  AcpReadTextFileParams,
  AcpReadTextFileResult,
  AcpRequestMap,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionResult,
  AcpSetConfigOptionParams,
  AcpSetConfigOptionResult,
  AcpSessionUpdateParams,
  AcpStopReason,
  AcpWriteTextFileParams,
  AcpWriteTextFileResult,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccess,
  JsonValue,
} from "./protocol.js";
import { validateAcpResponse } from "./validation.js";

const DEFAULT_ARGS = ["--no-auto-update", "agent", "stdio"];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_LIMIT = 32_768;
const CANCEL_GRACE_MS = 250;
const TERMINATE_GRACE_MS = 500;
const KILL_GRACE_MS = 250;
const PROCESS_OUTPUT_DRAIN_GRACE_MS = 500;
const TERMINAL_STDIN_FAILURE_GRACE_MS = 500;
const ACP_ABORT_MESSAGE = "The ACP operation was aborted.";
const SESSIONLESS_AGENT_REQUEST_QUEUE = Symbol("sessionless-agent-request");
const SESSIONLESS_CALLBACK_QUEUE = Symbol("sessionless-callback");
const TERMINAL_STDIN_FAILURE_CODES = new Set([
  "ECANCELED",
  "ECONNABORTED",
  "EPIPE",
  "ECONNRESET",
  "ENOTCONN",
  "ESHUTDOWN",
  "EOF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_STREAM_WRITE_AFTER_END",
  "STDIN_CLOSED",
  "STDIN_NOT_WRITABLE",
]);

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "plan";

export interface AcpChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface AcpSpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
}

export type AcpSpawnFactory = (
  executable: string,
  args: readonly string[],
  options: AcpSpawnOptions,
) => AcpChildProcess;

export type PermissionHandler = (
  request: AcpRequestPermissionParams,
) => AcpRequestPermissionResult | Promise<AcpRequestPermissionResult>;

export type ReadTextFileHandler = (
  request: AcpReadTextFileParams,
) => AcpReadTextFileResult | Promise<AcpReadTextFileResult>;

export type WriteTextFileHandler = (
  request: AcpWriteTextFileParams,
) => AcpWriteTextFileResult | Promise<AcpWriteTextFileResult>;

export interface AcpFileSystemSettings {
  readTextFile?: boolean | ReadTextFileHandler;
  writeTextFile?: boolean | WriteTextFileHandler;
}

export interface AcpClientOptions {
  executable?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs?: number;
  stderrLimit?: number;
  cancelGraceMs?: number;
  terminateGraceMs?: number;
  killGraceMs?: number;
  authMethod?: string | false;
  permissionMode?: PermissionMode;
  alwaysApprove?: boolean;
  onPermissionRequest?: PermissionHandler;
  fileSystem?: AcpFileSystemSettings;
  onUpdate?: (update: AcpSessionUpdateParams) => void | Promise<void>;
  onExtension?: (
    notification: AcpExtensionNotification,
  ) => void | Promise<void>;
  spawn?: AcpSpawnFactory;
}

/** @internal Effective process and callback settings shared by the client pool. */
export interface ResolvedAcpClientOptions {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  requestTimeoutMs: number;
  stderrLimit: number;
  cancelGraceMs: number;
  terminateGraceMs: number;
  killGraceMs: number;
  authMethod: string | false;
  permissionMode: PermissionMode;
  alwaysApprove: boolean;
  onPermissionRequest?: PermissionHandler;
  fileSystem: AcpFileSystemSettings;
  onUpdate?: AcpClientOptions["onUpdate"];
  onExtension?: AcpClientOptions["onExtension"];
  spawn: AcpSpawnFactory;
}

export interface AcpPromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onUpdate?: (update: AcpSessionUpdateParams) => void | Promise<void>;
}

export interface AcpPromptOutcome {
  stopReason: AcpStopReason;
  meta?: AcpPromptResultMeta | null;
}

type RequestHandler<Method extends keyof AcpAgentRequestMap> = (
  params: AcpAgentRequestMap[Method]["params"],
) =>
  | AcpAgentRequestMap[Method]["result"]
  | Promise<AcpAgentRequestMap[Method]["result"]>;

interface PendingRequest {
  method: keyof AcpRequestMap;
  sessionId?: string;
  responseReceived: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}

interface PromptUpdateRegistration {
  active: boolean;
  handler(update: AcpSessionUpdateParams): void | Promise<void>;
}

interface PendingPermission {
  sessionId: string;
  cancelled: boolean;
  cancellation: Promise<AcpRequestPermissionResult>;
  cancel(): void;
}

type ClientState = "idle" | "running" | "disposed" | "exited";
type CallbackQueueKey = string | typeof SESSIONLESS_CALLBACK_QUEUE;

interface AcpClientLifecycle {
  terminalFailure: Promise<Error>;
  resolveTerminalFailure(error: Error): void;
}

const clientLifecycles = new WeakMap<AcpClient, AcpClientLifecycle>();

function lifecycleFor(client: AcpClient): AcpClientLifecycle {
  const lifecycle = clientLifecycles.get(client);
  if (!lifecycle) throw new Error("AcpClient lifecycle was not initialized.");
  return lifecycle;
}

/** @internal Used by the provider-local pool to retire failed clients safely. */
export function waitForAcpClientTerminalFailure(
  client: AcpClient,
): Promise<Error> {
  return lifecycleFor(client).terminalFailure;
}

/** Incremental UTF-8 NDJSON framing, including split code points and split lines. */
export class NdjsonFramer {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string | Uint8Array): void {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.write(Buffer.from(chunk));
    this.drain(false);
  }

  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.push(chunk);
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  private drain(flush: boolean): void {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }

    if (flush && this.buffer.trim()) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.onLine(line);
    }
  }
}

function defaultSpawn(
  executable: string,
  args: readonly string[],
  options: AcpSpawnOptions,
): AcpChildProcess {
  return spawn(executable, [...args], options);
}

/** @internal Resolve defaults once so construction and pooling cannot drift. */
export function resolveAcpClientOptions(
  options: AcpClientOptions = {},
): ResolvedAcpClientOptions {
  return {
    executable: options.executable ?? "grok",
    args: options.args ?? DEFAULT_ARGS,
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    stderrLimit: Math.max(0, options.stderrLimit ?? DEFAULT_STDERR_LIMIT),
    cancelGraceMs: Math.max(0, options.cancelGraceMs ?? CANCEL_GRACE_MS),
    terminateGraceMs: Math.max(
      0,
      options.terminateGraceMs ?? TERMINATE_GRACE_MS,
    ),
    killGraceMs: Math.max(0, options.killGraceMs ?? KILL_GRACE_MS),
    authMethod:
      options.authMethod === undefined ? "cached_token" : options.authMethod,
    permissionMode: options.permissionMode ?? "default",
    alwaysApprove: options.alwaysApprove ?? false,
    onPermissionRequest: options.onPermissionRequest,
    fileSystem: options.fileSystem ?? {},
    onUpdate: options.onUpdate,
    onExtension: options.onExtension,
    spawn: options.spawn ?? defaultSpawn,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionIdFromParams(params: unknown): string | undefined {
  return isRecord(params) &&
    typeof params.sessionId === "string" &&
    params.sessionId.length > 0
    ? params.sessionId
    : undefined;
}

export class AcpClient {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly stderrLimit: number;
  private readonly cancelGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly killGraceMs: number;
  private readonly authMethod: string | false;
  private readonly permissionMode: PermissionMode;
  private readonly onPermissionRequest?: PermissionHandler;
  private readonly alwaysApprove: boolean;
  private readonly fileSystem: AcpFileSystemSettings;
  private readonly onUpdate?: AcpClientOptions["onUpdate"];
  private readonly extensionHandlers = new Set<
    NonNullable<AcpClientOptions["onExtension"]>
  >();
  private readonly spawnProcess: AcpSpawnFactory;

  private child?: AcpChildProcess;
  private state: ClientState = "idle";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown) => unknown
  >();
  private readonly promptHandlers = new Map<
    string,
    Set<PromptUpdateRegistration>
  >();
  private readonly activeSessions = new Set<string>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly agentRequestQueues = new Map<
    string | typeof SESSIONLESS_AGENT_REQUEST_QUEUE,
    Promise<void>
  >();
  private readonly pendingPermissions = new Map<JsonRpcId, PendingPermission>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readQueue: Promise<void> = Promise.resolve();
  private readonly callbackQueues = new Map<CallbackQueueKey, Promise<void>>();
  private initializePromise?: Promise<AcpInitializeResult>;
  private initialized?: AcpInitializeResult;
  private stderr = "";
  private lastFailure?: Error;
  private exitPromise?: Promise<void>;
  private resolveExit?: () => void;
  private stdoutEndPromise?: Promise<void>;
  private stderrEndPromise?: Promise<void>;
  private readFailure?: Error;
  private provisionalStdinFailure?: AcpError;
  private provisionalStdinFailureTimer?: NodeJS.Timeout;
  private childStarted = false;
  private childExited = false;
  private shutdownRequested = false;
  private shutdownError?: AcpError;
  private cancellationRequested = false;
  private disposePromise?: Promise<void>;
  private activeLeases = 0;

  constructor(options: AcpClientOptions = {}) {
    let resolveTerminalFailure!: (error: Error) => void;
    let terminalFailureSettled = false;
    const terminalFailure = new Promise<Error>((resolve) => {
      resolveTerminalFailure = resolve;
    });
    clientLifecycles.set(this, {
      terminalFailure,
      resolveTerminalFailure: (error) => {
        if (terminalFailureSettled) return;
        terminalFailureSettled = true;
        resolveTerminalFailure(error);
      },
    });

    const resolved = resolveAcpClientOptions(options);
    this.executable = resolved.executable;
    this.args = resolved.args;
    this.env = resolved.env;
    this.cwd = resolved.cwd;
    this.requestTimeoutMs = resolved.requestTimeoutMs;
    this.stderrLimit = resolved.stderrLimit;
    this.cancelGraceMs = resolved.cancelGraceMs;
    this.terminateGraceMs = resolved.terminateGraceMs;
    this.killGraceMs = resolved.killGraceMs;
    this.authMethod = resolved.authMethod;
    this.permissionMode = resolved.permissionMode;
    this.onPermissionRequest = resolved.onPermissionRequest;
    this.alwaysApprove = resolved.alwaysApprove;
    this.fileSystem = resolved.fileSystem;
    this.onUpdate = resolved.onUpdate;
    if (resolved.onExtension) this.extensionHandlers.add(resolved.onExtension);
    this.spawnProcess = resolved.spawn;
  }

  get capabilities(): AcpInitializeResult | undefined {
    return this.initialized;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  get failure(): Error | undefined {
    return this.lastFailure;
  }

  get isUsable(): boolean {
    return (
      !this.shutdownRequested &&
      !this.childExited &&
      this.provisionalStdinFailure === undefined &&
      this.state !== "disposed" &&
      this.state !== "exited"
    );
  }

  get isIdle(): boolean {
    return (
      this.isUsable &&
      this.activeLeases === 0 &&
      this.initializePromise === undefined &&
      this.pending.size === 0 &&
      this.activeSessions.size === 0 &&
      this.sessionQueues.size === 0 &&
      this.callbackQueues.size === 0 &&
      this.agentRequestQueues.size === 0 &&
      this.pendingPermissions.size === 0
    );
  }

  /**
   * Hold this client across a multi-request operation such as one generation.
   * This is primarily intended for integrations that pool AcpClient instances.
   */
  acquireLease(): () => void {
    if (
      this.shutdownRequested ||
      this.state === "disposed" ||
      this.state === "exited"
    ) {
      throw (
        this.lastFailure ??
        this.shutdownError ??
        new AcpError("Cannot lease an exited or disposed AcpClient.", {
          code: "CLIENT_DISPOSED",
        })
      );
    }
    this.activeLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLeases = Math.max(0, this.activeLeases - 1);
    };
  }

  registerExtensionHandler(
    handler: NonNullable<AcpClientOptions["onExtension"]>,
  ): () => void {
    this.extensionHandlers.add(handler);
    return () => this.extensionHandlers.delete(handler);
  }

  registerRequestHandler<Method extends keyof AcpAgentRequestMap>(
    method: Method,
    handler: RequestHandler<Method>,
  ): () => void {
    this.requestHandlers.set(method, handler as (params: unknown) => unknown);
    return () => {
      if (this.requestHandlers.get(method) === handler)
        this.requestHandlers.delete(method);
    };
  }

  async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
    if (signal?.aborted) throw abortError(signal, ACP_ABORT_MESSAGE);
    if (this.shutdownRequested) {
      throw (
        this.lastFailure ??
        this.shutdownError ??
        new AcpError("Cannot initialize a disposing AcpClient.", {
          code: "CLIENT_DISPOSED",
        })
      );
    }
    if (
      this.provisionalStdinFailure !== undefined ||
      (this.childExited && this.lastFailure === undefined)
    ) {
      throw await waitAbortably(
        waitForAcpClientTerminalFailure(this),
        signal,
        ACP_ABORT_MESSAGE,
      );
    }
    if (!this.isUsable) {
      throw (
        this.lastFailure ??
        this.shutdownError ??
        new AcpError("Cannot initialize an exited or disposed AcpClient.", {
          code: "CLIENT_DISPOSED",
        })
      );
    }
    if (this.initialized) return this.initialized;
    if (this.initializePromise) {
      return await waitAbortably(
        this.initializePromise,
        signal,
        ACP_ABORT_MESSAGE,
      );
    }

    this.initializePromise = this.initializeInternal()
      .catch((error: unknown) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.initializePromise = undefined;
      });
    return await waitAbortably(
      this.initializePromise,
      signal,
      ACP_ABORT_MESSAGE,
    );
  }

  async authenticate(
    methodId = this.authMethod,
    signal?: AbortSignal,
  ): Promise<AcpAuthenticateResult> {
    if (methodId === false) return {};
    const initialized = await this.initialize(signal);
    const advertised = initialized.authMethods.some(
      (method) => method.id === methodId,
    );
    if (!advertised) {
      throw new AcpAuthenticationError(
        `Grok did not advertise authentication method '${methodId}'. Available methods: ${initialized.authMethods.map((method) => method.id).join(", ") || "(none)"}.`,
        { stderr: this.stderr, code: "AUTH_METHOD_NOT_AVAILABLE" },
      );
    }
    try {
      return await this.requestInternal(
        "authenticate",
        { methodId },
        this.requestTimeoutMs,
        signal,
      );
    } catch (error) {
      if (isAcpAuthenticationRpcError(error)) {
        throw new AcpAuthenticationError(
          `Grok authentication with method '${methodId}' failed. Run 'grok login' to refresh the cached CLI login, or configure XAI_API_KEY as an alternative.`,
          { cause: error, stderr: this.stderr, code: "AUTHENTICATION_FAILED" },
        );
      }
      throw error;
    }
  }

  async request<Method extends keyof AcpRequestMap>(
    method: Method,
    params: AcpRequestMap[Method]["params"],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AcpRequestMap[Method]["result"]> {
    await this.initialize(signal);
    return await this.requestInternal(method, params, timeoutMs, signal);
  }

  async notify<Method extends keyof AcpNotificationMap>(
    method: Method,
    params: AcpNotificationMap[Method],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.initialize(signal);
    if (signal?.aborted) throw abortError(signal, ACP_ABORT_MESSAGE);
    await this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  async newSession(
    params: AcpNewSessionParams,
    signal?: AbortSignal,
  ): Promise<AcpSessionResult> {
    try {
      return await this.requestSessionWithAuthenticationRetry(
        "session/new",
        params,
        signal,
      );
    } catch (error) {
      if (isAcpAuthenticationRpcError(error)) {
        throw new AcpAuthenticationError(
          "Grok requires authentication. Run 'grok login' for cached subscription authentication or configure XAI_API_KEY.",
          { cause: error, stderr: this.stderr },
        );
      }
      throw error;
    }
  }

  async loadSession(
    params: AcpLoadSessionParams,
    signal?: AbortSignal,
  ): Promise<AcpLoadSessionResult> {
    const initialized = await this.initialize(signal);
    if (!initialized.agentCapabilities.loadSession) {
      throw new AcpProtocolError(
        "Grok did not advertise the ACP 'loadSession' capability.",
        {
          code: "CAPABILITY_NOT_SUPPORTED",
        },
      );
    }
    return await this.enqueueSessionOperation(
      params.sessionId,
      signal,
      async () =>
        await this.requestSessionWithAuthenticationRetry(
          "session/load",
          params,
          signal,
        ),
    );
  }

  async setConfigOption(
    params: AcpSetConfigOptionParams,
    signal?: AbortSignal,
  ): Promise<AcpSetConfigOptionResult> {
    return await this.enqueueSessionOperation(
      params.sessionId,
      signal,
      async () =>
        await this.request(
          "session/set_config_option",
          params,
          this.requestTimeoutMs,
          signal,
        ),
    );
  }

  async prompt(
    params: AcpPromptParams,
    options: AcpPromptOptions = {},
  ): Promise<AcpPromptOutcome> {
    return await this.enqueueSessionOperation(
      params.sessionId,
      options.signal,
      async () => await this.promptInternal(params, options),
    );
  }

  private async enqueueSessionOperation<T>(
    sessionId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId);
    const queued = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (signal?.aborted) throw abortError(signal, ACP_ABORT_MESSAGE);
        return await operation();
      });
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    this.sessionQueues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionQueues.get(sessionId) === tail) {
        this.sessionQueues.delete(sessionId);
      }
    });
    return await waitAbortably(queued, signal, ACP_ABORT_MESSAGE);
  }

  private async promptInternal(
    params: AcpPromptParams,
    options: AcpPromptOptions,
  ): Promise<AcpPromptOutcome> {
    await this.initialize(options.signal);
    const signal = options.signal;
    if (signal?.aborted) throw abortError(signal, ACP_ABORT_MESSAGE);

    const registration: PromptUpdateRegistration | undefined = options.onUpdate
      ? { active: true, handler: options.onUpdate }
      : undefined;
    const deactivateRegistration = (): void => {
      if (registration) registration.active = false;
    };
    signal?.addEventListener("abort", deactivateRegistration, { once: true });
    this.activeSessions.add(params.sessionId);
    if (registration) {
      const handlers = this.promptHandlers.get(params.sessionId) ?? new Set();
      handlers.add(registration);
      this.promptHandlers.set(params.sessionId, handlers);
    }

    try {
      const result = await this.requestInternal(
        "session/prompt",
        params,
        options.timeoutMs,
        signal,
      );
      return { stopReason: result.stopReason, meta: result._meta };
    } catch (error) {
      if (
        error instanceof AcpTimeoutError ||
        signal?.aborted ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        await this.cancelSession(params.sessionId).catch(() => undefined);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", deactivateRegistration);
      this.activeSessions.delete(params.sessionId);
      if (registration) {
        deactivateRegistration();
        const handlers = this.promptHandlers.get(params.sessionId);
        handlers?.delete(registration);
        if (handlers?.size === 0) this.promptHandlers.delete(params.sessionId);
      }
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.cancellationRequested = true;
    this.cancelPendingPermissions(sessionId);
    await this.notify("session/cancel", { sessionId });
  }

  async dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    await this.disposePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  private async initializeInternal(): Promise<AcpInitializeResult> {
    this.start();
    const result = await this.requestInternal(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: {
            readTextFile:
              (this.fileSystem.readTextFile !== undefined &&
                this.fileSystem.readTextFile !== false) ||
              this.requestHandlers.has("fs/read_text_file"),
            writeTextFile:
              (this.fileSystem.writeTextFile !== undefined &&
                this.fileSystem.writeTextFile !== false) ||
              this.requestHandlers.has("fs/write_text_file"),
          },
          terminal: false,
        },
      },
      this.requestTimeoutMs,
      undefined,
    );

    if (result.protocolVersion !== 1) {
      throw new AcpProtocolError(
        `Unsupported ACP protocol version ${result.protocolVersion}; this provider requires version 1.`,
        { code: "UNSUPPORTED_PROTOCOL_VERSION" },
      );
    }

    this.initialized = result;
    return result;
  }

  private async requestSessionWithAuthenticationRetry<
    Method extends "session/new" | "session/load",
  >(
    method: Method,
    params: AcpRequestMap[Method]["params"],
    signal?: AbortSignal,
  ): Promise<AcpRequestMap[Method]["result"]> {
    await this.initialize(signal);
    try {
      return await this.requestInternal(
        method,
        params,
        this.requestTimeoutMs,
        signal,
      );
    } catch (error) {
      if (!isAcpAuthenticationRpcError(error) || this.authMethod === false)
        throw error;
      await this.authenticate(this.authMethod, signal);
      return await this.requestInternal(
        method,
        params,
        this.requestTimeoutMs,
        signal,
      );
    }
  }

  private async disposeInternal(): Promise<void> {
    if (this.state === "disposed") return;
    const disposalError = new AcpError("AcpClient was disposed.", {
      code: "CLIENT_DISPOSED",
    });
    this.shutdownError = disposalError;
    if (this.state === "idle") {
      this.state = "disposed";
      this.rejectAll(disposalError);
      lifecycleFor(this).resolveTerminalFailure(disposalError);
      return;
    }
    if (this.state === "exited" && this.lastFailure instanceof AcpSpawnError) {
      this.state = "disposed";
      this.rejectAll(disposalError);
      lifecycleFor(this).resolveTerminalFailure(this.lastFailure);
      return;
    }

    this.shutdownRequested = true;
    this.clearProvisionalStdinFailureTimer();
    if (this.provisionalStdinFailure) {
      lifecycleFor(this).resolveTerminalFailure(this.provisionalStdinFailure);
    }
    this.cancelPendingPermissions();
    if (this.state === "running") {
      const sessionIds = [...this.activeSessions];
      await Promise.allSettled(
        sessionIds.map(async (sessionId) => {
          await this.writeMessage({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId },
          });
        }),
      );
      if (
        (sessionIds.length > 0 || this.cancellationRequested) &&
        !this.childExited
      ) {
        await this.waitForExit(this.cancelGraceMs);
      }
    }

    if (!this.childExited) {
      this.child?.kill("SIGTERM");
      await this.waitForExit(this.terminateGraceMs);
    }
    if (!this.childExited) {
      this.child?.kill("SIGKILL");
      await this.waitForExit(this.killGraceMs);
    }

    this.state = "disposed";
    this.rejectAll(disposalError);
    lifecycleFor(this).resolveTerminalFailure(disposalError);
    this.activeSessions.clear();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.childExited || !this.exitPromise) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const exited = await Promise.race([
      this.exitPromise.then(() => true as const),
      timedOut,
    ]);
    if (timer) clearTimeout(timer);
    return exited;
  }

  private async terminateAfterFailure(): Promise<void> {
    if (this.childExited || !this.child) return;
    this.child.kill("SIGTERM");
    if (!(await this.waitForExit(this.terminateGraceMs))) {
      this.child.kill("SIGKILL");
      await this.waitForExit(this.killGraceMs);
    }
  }

  private start(): void {
    if (this.shutdownRequested) {
      throw new AcpError("Cannot use a disposing AcpClient.", {
        code: "CLIENT_DISPOSED",
      });
    }
    if (this.state === "running") return;
    if (this.state === "disposed") {
      throw new AcpError("Cannot start a disposed AcpClient.", {
        code: "CLIENT_DISPOSED",
      });
    }
    if (this.state === "exited") {
      throw (
        this.lastFailure ?? new AcpError("The Grok ACP process has exited.")
      );
    }

    try {
      this.child = this.spawnProcess(this.executable, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw this.createSpawnError(error);
    }
    this.state = "running";
    this.childStarted = this.child.pid !== undefined;
    this.childExited = false;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    let resolveStdoutEnd: (() => void) | undefined;
    this.stdoutEndPromise = new Promise((resolve) => {
      resolveStdoutEnd = resolve;
    });
    let resolveStderrEnd: (() => void) | undefined;
    this.stderrEndPromise = new Promise((resolve) => {
      resolveStderrEnd = resolve;
    });

    let flushingUnterminatedLine = false;
    const framer = new NdjsonFramer((line) => {
      const unterminatedAtEof = flushingUnterminatedLine;
      this.readQueue = this.readQueue
        .then(async () => await this.handleLine(line, unterminatedAtEof))
        .catch((error: unknown) => {
          if (this.shutdownRequested) return;
          if (this.childExited) {
            this.readFailure ??=
              error instanceof Error
                ? error
                : new AcpError(errorMessage(error));
            return;
          }
          this.fail(error);
        });
    });
    this.child.stdout.on("data", (chunk: Buffer | string) => {
      this.childStarted = true;
      framer.push(chunk);
    });
    this.child.stdout.on("end", () => {
      flushingUnterminatedLine = true;
      try {
        framer.end();
      } finally {
        flushingUnterminatedLine = false;
      }
      resolveStdoutEnd?.();
    });
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.childStarted = true;
      this.captureStderr(chunk);
    });
    this.child.stderr.on("end", () => resolveStderrEnd?.());
    this.child.stdin.on("error", (error) => {
      if (
        !this.shutdownRequested &&
        !this.childExited &&
        this.state === "running"
      ) {
        void this.resolveStdinFailure(this.createStdinError(error));
      }
    });
    this.child.stdin.on("close", () => {
      if (
        !this.shutdownRequested &&
        !this.childExited &&
        this.state === "running"
      ) {
        void this.resolveStdinFailure(
          new AcpError("Grok ACP stdin closed while the process was running.", {
            code: "STDIN_CLOSED",
          }),
        );
      }
    });
    this.child.on("error", (error) => {
      if (this.shutdownRequested || this.childExited) return;
      this.fail(
        this.isSpawnFailure(error)
          ? this.createSpawnError(error)
          : this.createRuntimeProcessError(error),
      );
    });
    this.child.on("exit", (code, signal) => {
      this.childExited = true;
      this.clearProvisionalStdinFailureTimer();
      this.cancelPendingPermissions();
      this.resolveExit?.();
      void this.handleProcessExit(code, signal);
    });
  }

  private async handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    await this.waitForProcessOutputDrain();
    if (
      this.state === "disposed" ||
      this.state === "exited" ||
      this.shutdownRequested
    )
      return;
    if (this.readFailure) {
      const readFailure = this.readFailure;
      const protocolError = new AcpProtocolError(readFailure.message, {
        cause: readFailure,
        code:
          readFailure instanceof AcpError ? readFailure.code : "PROTOCOL_ERROR",
        data: readFailure instanceof AcpError ? readFailure.data : undefined,
        stderr: this.stderr,
        exitCode: code,
        signal,
      });
      const unterminatedAtEof =
        readFailure instanceof AcpError &&
        isRecord(readFailure.data) &&
        readFailure.data.unterminatedAtEof === true;
      this.fail(
        unterminatedAtEof && (code !== 0 || signal !== null)
          ? new AcpProcessExitError(code, signal, {
              cause: protocolError,
              stderr: this.stderr,
            })
          : protocolError,
      );
      return;
    }
    this.fail(
      new AcpProcessExitError(code, signal, {
        stderr: this.stderr,
      }),
    );
  }

  private async waitForProcessOutputDrain(): Promise<void> {
    const drained = Promise.all([
      this.stdoutEndPromise,
      this.stderrEndPromise,
    ]).then(async () => await this.readQueue);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PROCESS_OUTPUT_DRAIN_GRACE_MS);
    });
    await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);
  }

  private createSpawnError(error: unknown): AcpSpawnError {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError?.code === "ENOENT") {
      return new AcpSpawnError(
        `Could not find Grok Build executable '${this.executable}'. Install the Grok CLI and ensure 'grok' is on PATH, or set the AcpClient executable option.`,
        { cause: error, code: "ENOENT" },
      );
    }
    return new AcpSpawnError(
      `Failed to start Grok ACP process: ${errorMessage(error)}`,
      {
        cause: error,
        code: nodeError?.code,
      },
    );
  }

  private createStdinError(error: unknown): AcpError {
    if (error instanceof AcpError) return error;
    const nodeError = error as NodeJS.ErrnoException;
    return new AcpError(
      `Failed to write to Grok ACP stdin: ${errorMessage(error)}`,
      {
        cause: error,
        code: nodeError.code ?? "STDIN_WRITE_FAILED",
        stderr: this.stderr,
      },
    );
  }

  private createRuntimeProcessError(error: unknown): AcpError {
    const nodeError = error as NodeJS.ErrnoException | undefined;
    return new AcpError(
      `Grok ACP process emitted an error: ${errorMessage(error)}`,
      {
        cause: error,
        code: nodeError?.code ?? "PROCESS_ERROR",
        stderr: this.stderr,
      },
    );
  }

  private isSpawnFailure(error: unknown): boolean {
    const nodeError = error as NodeJS.ErrnoException | undefined;
    if (
      typeof nodeError?.syscall === "string" &&
      /^spawn(?:\s|$)/i.test(nodeError.syscall)
    ) {
      return true;
    }
    return !this.childStarted && this.child?.pid === undefined;
  }

  private requestInternal<Method extends keyof AcpRequestMap>(
    method: Method,
    params: AcpRequestMap[Method]["params"],
    timeoutMs = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<AcpRequestMap[Method]["result"]> {
    this.start();
    if (signal?.aborted)
      return Promise.reject(abortError(signal, ACP_ABORT_MESSAGE));
    const id = this.nextId++;

    return new Promise<AcpRequestMap[Method]["result"]>((resolve, reject) => {
      const cleanupAbort = (): void =>
        signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        this.settlePendingRequest(id, pending, () => {
          reject(abortError(signal as AbortSignal, ACP_ABORT_MESSAGE));
        });
      };
      const pending: PendingRequest = {
        method,
        sessionId: sessionIdFromParams(params),
        responseReceived: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settlePendingRequest(id, pending, () => {
            reject(
              new AcpTimeoutError(method, timeoutMs, { stderr: this.stderr }),
            );
          });
        }, timeoutMs),
        cleanup: cleanupAbort,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, pending);

      void this.writeMessage({ jsonrpc: "2.0", id, method, params }).catch(
        (error: unknown) => {
          this.settlePendingRequest(id, pending, () => {
            pending.reject(error);
          });
        },
      );
    });
  }

  private settlePendingRequest(
    id: JsonRpcId,
    pending: PendingRequest,
    settle: () => void,
  ): void {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (this.shutdownRequested && this.shutdownError) {
      pending.reject(this.shutdownError);
      return;
    }
    settle();
  }

  private writeMessage(message: object): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      if (!this.child || this.state !== "running" || this.childExited) {
        throw (
          this.lastFailure ?? new AcpError("Grok ACP process is not running.")
        );
      }
      const data = `${JSON.stringify(message)}\n`;
      const stdin = this.child.stdin;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          stdin.removeListener("error", onError);
          stdin.removeListener("close", onClose);
        };
        const settle = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined || error === null) {
            this.childStarted = true;
            resolve();
          } else {
            void this.resolveStdinFailure(this.createStdinError(error)).then(
              reject,
            );
          }
        };
        const onError = (error: Error): void => settle(error);
        const onClose = (): void =>
          settle(
            new AcpError("Grok ACP stdin closed before the write completed.", {
              code: "STDIN_CLOSED",
            }),
          );

        stdin.once("error", onError);
        stdin.once("close", onClose);
        if (stdin.destroyed || stdin.writableEnded || !stdin.writable) {
          settle(
            new AcpError("Grok ACP stdin is not writable.", {
              code: "STDIN_NOT_WRITABLE",
            }),
          );
          return;
        }
        try {
          stdin.write(data, (error) => settle(error));
        } catch (error) {
          settle(error);
        }
      });
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async handleLine(
    line: string,
    unterminatedAtEof = false,
  ): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AcpProtocolError(
        `Invalid JSON from Grok ACP stdout: ${line.slice(0, 200)}`,
        {
          cause: error,
          data: unterminatedAtEof ? { unterminatedAtEof: true } : undefined,
          stderr: this.stderr,
        },
      );
    }
    if (!isRecord(message)) {
      throw new AcpProtocolError(
        "Grok ACP emitted a non-object JSON-RPC message.",
        {
          data: message as JsonValue,
        },
      );
    }

    const record = message;
    if (
      "id" in record &&
      ("result" in record || "error" in record) &&
      !("method" in record)
    ) {
      this.handleResponse(record);
      return;
    }
    if (typeof record.method !== "string") {
      throw new AcpProtocolError(
        "Grok ACP emitted a message without a method or response body.",
      );
    }
    if ("id" in record) {
      if (!this.childExited) {
        this.enqueueAgentRequest(record as unknown as JsonRpcRequest);
      }
      return;
    }
    this.enqueueNotification(record as unknown as AcpExtensionNotification);
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id as JsonRpcId | null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.responseReceived) return;
    pending.responseReceived = true;

    if ("error" in record) {
      const failure = record as unknown as JsonRpcFailure;
      const error = new AcpJsonRpcError(pending.method, failure.error, {
        stderr: this.stderr,
      });
      const callbackBarrier = this.responseCallbackBarrier(pending, undefined);
      void callbackBarrier.then(() => {
        this.settlePendingRequest(id, pending, () => pending.reject(error));
      });
    } else {
      try {
        const result = validateAcpResponse(
          pending.method,
          (record as unknown as JsonRpcSuccess).result,
        );
        const callbackBarrier = this.responseCallbackBarrier(pending, result);
        void callbackBarrier.then(() => {
          this.settlePendingRequest(id, pending, () => pending.resolve(result));
        });
      } catch (error) {
        const callbackBarrier = this.responseCallbackBarrier(
          pending,
          undefined,
        );
        void callbackBarrier.then(() => {
          this.settlePendingRequest(id, pending, () => pending.reject(error));
        });
      }
    }
  }

  private responseCallbackBarrier(
    pending: PendingRequest,
    result: unknown,
  ): Promise<void> {
    const keys = new Set<CallbackQueueKey>();
    if (pending.sessionId) keys.add(pending.sessionId);
    else keys.add(SESSIONLESS_CALLBACK_QUEUE);
    if (pending.method === "session/new") {
      const resultSessionId = sessionIdFromParams(result);
      if (resultSessionId) keys.add(resultSessionId);
    }
    return Promise.all(
      [...keys].map(async (key) => await this.callbackBarrier(key)),
    ).then(() => undefined);
  }

  private callbackBarrier(key: CallbackQueueKey): Promise<void> {
    return this.callbackQueues.get(key) ?? Promise.resolve();
  }

  private enqueueNotification(notification: AcpExtensionNotification): void {
    const callbacks: Array<() => Promise<void>> = [];
    const notificationSessionId = sessionIdFromParams(notification.params);
    const queueKey = notificationSessionId ?? SESSIONLESS_CALLBACK_QUEUE;
    if (notification.method === "session/update") {
      const params = notification.params as AcpSessionUpdateParams;
      if (!params || typeof params.sessionId !== "string" || !params.update) {
        throw new AcpProtocolError("Malformed 'session/update' notification.");
      }
      if (this.onUpdate) {
        const handler = this.onUpdate;
        callbacks.push(async () => await this.invokeSafely(handler, params));
      }
      const handlers = this.promptHandlers.get(params.sessionId);
      if (handlers) {
        for (const registration of [...handlers]) {
          callbacks.push(async () => {
            if (!registration.active) return;
            await this.invokeSafely(registration.handler, params);
          });
        }
      }
    } else {
      for (const handler of [...this.extensionHandlers]) {
        callbacks.push(
          async () => await this.invokeSafely(handler, notification),
        );
      }
    }

    if (callbacks.length === 0) return;
    const task = this.callbackBarrier(queueKey).then(async () => {
      for (const callback of callbacks) await callback();
    });
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.callbackQueues.set(queueKey, tail);
    void tail.finally(() => {
      if (this.callbackQueues.get(queueKey) === tail) {
        this.callbackQueues.delete(queueKey);
      }
    });
  }

  private async invokeSafely<T>(
    callback: ((value: T) => void | Promise<void>) | undefined,
    value: T,
  ): Promise<void> {
    if (!callback) return;
    try {
      await callback(value);
    } catch {
      // Consumer hooks are observational and cannot corrupt protocol correlation.
    }
  }

  private async handleAgentRequest(
    request: JsonRpcRequest,
    pendingPermission?: PendingPermission,
  ): Promise<void> {
    const customHandler = this.requestHandlers.get(request.method);
    let response: object;
    try {
      let result: unknown;
      if (request.method === "session/request_permission") {
        result = await this.handlePermissionRequest(
          request.id,
          request.params as AcpRequestPermissionParams,
          pendingPermission,
          customHandler,
        );
      } else if (customHandler) {
        result = await customHandler(request.params);
      } else if (request.method === "fs/read_text_file") {
        result = await this.handleReadTextFile(
          request.params as AcpReadTextFileParams,
        );
      } else if (request.method === "fs/write_text_file") {
        result = await this.handleWriteTextFile(
          request.params as AcpWriteTextFileParams,
        );
      } else {
        throw new AcpProtocolError(
          `Unsupported agent-to-client ACP method '${request.method}'.`,
          {
            code: "METHOD_NOT_FOUND",
          },
        );
      }
      response = {
        jsonrpc: "2.0",
        id: request.id,
        result: result ?? null,
      };
    } catch (error) {
      const protocolError = error instanceof AcpError ? error : undefined;
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code:
            protocolError?.code === "METHOD_NOT_FOUND"
              ? -32601
              : error instanceof AcpPermissionError
                ? -32001
                : -32603,
          message: errorMessage(error),
        },
      };
    }
    await this.writeMessage(response);
  }

  private enqueueAgentRequest(request: JsonRpcRequest): void {
    const params = isRecord(request.params) ? request.params : undefined;
    const pendingPermission =
      request.method === "session/request_permission"
        ? this.registerPendingPermission(
            request.id,
            typeof params?.sessionId === "string" ? params.sessionId : "",
          )
        : undefined;
    const key =
      typeof params?.sessionId === "string" && params.sessionId.length > 0
        ? params.sessionId
        : SESSIONLESS_AGENT_REQUEST_QUEUE;
    const callbackKey =
      typeof key === "string" ? key : SESSIONLESS_CALLBACK_QUEUE;
    const callbackBarrier = this.callbackBarrier(callbackKey);
    const previous = this.agentRequestQueues.get(key);
    const task = Promise.all([
      (previous ?? Promise.resolve()).catch(() => undefined),
      callbackBarrier,
    ]).then(
      async () => await this.handleAgentRequest(request, pendingPermission),
    );
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.agentRequestQueues.set(key, tail);
    void task.catch((error: unknown) => {
      if (
        !this.shutdownRequested &&
        !this.childExited &&
        this.state === "running"
      ) {
        this.fail(error);
      }
    });
    void tail.finally(() => {
      if (
        pendingPermission &&
        this.pendingPermissions.get(request.id) === pendingPermission
      ) {
        this.pendingPermissions.delete(request.id);
      }
      if (this.agentRequestQueues.get(key) === tail) {
        this.agentRequestQueues.delete(key);
      }
    });
  }

  private async handlePermissionRequest(
    id: JsonRpcId,
    request: AcpRequestPermissionParams,
    pendingPermission: PendingPermission | undefined,
    customHandler: ((params: unknown) => unknown) | undefined,
  ): Promise<AcpRequestPermissionResult> {
    const pending =
      pendingPermission ??
      this.registerPendingPermission(id, request.sessionId);

    try {
      if (pending.cancelled) return await pending.cancellation;
      const decision = (
        customHandler
          ? Promise.resolve(
              customHandler(request) as AcpRequestPermissionResult,
            )
          : this.onPermissionRequest
            ? Promise.resolve(this.onPermissionRequest(request))
            : this.permissionMode === "bypassPermissions" || this.alwaysApprove
              ? Promise.resolve(this.selectAllowOption(request))
              : Promise.reject<AcpRequestPermissionResult>(
                  this.defaultPermissionError(request),
                )
      ).then((result) => this.validatePermissionResult(request, result));
      return await Promise.race([decision, pending.cancellation]);
    } finally {
      if (this.pendingPermissions.get(id) === pending) {
        this.pendingPermissions.delete(id);
      }
    }
  }

  private registerPendingPermission(
    id: JsonRpcId,
    sessionId: string,
  ): PendingPermission {
    let resolveCancellation!: (result: AcpRequestPermissionResult) => void;
    const pending: PendingPermission = {
      sessionId,
      cancelled: false,
      cancellation: new Promise((resolve) => {
        resolveCancellation = resolve;
      }),
      cancel: () => {
        if (pending.cancelled) return;
        pending.cancelled = true;
        resolveCancellation({ outcome: { outcome: "cancelled" } });
      },
    };
    this.pendingPermissions.set(id, pending);
    return pending;
  }

  private selectAllowOption(
    request: AcpRequestPermissionParams,
  ): AcpRequestPermissionResult {
    const option =
      request.options.find((candidate) => candidate.kind === "allow_once") ??
      request.options.find((candidate) => candidate.kind === "allow_always");
    if (!option) {
      throw new AcpPermissionError(
        `Permission bypass was requested, but Grok supplied no allow option. Options: ${this.describePermissionOptions(request)}.`,
      );
    }
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  private validatePermissionResult(
    request: AcpRequestPermissionParams,
    result: unknown,
  ): AcpRequestPermissionResult {
    if (!isRecord(result) || !isRecord(result.outcome)) {
      throw new AcpPermissionError(
        `Permission callback returned an invalid result. Expected a selected or cancelled outcome. Options: ${this.describePermissionOptions(request)}.`,
      );
    }
    if (result.outcome.outcome === "cancelled") {
      return result as unknown as AcpRequestPermissionResult;
    }
    if (
      result.outcome.outcome !== "selected" ||
      typeof result.outcome.optionId !== "string"
    ) {
      throw new AcpPermissionError(
        `Permission callback returned an invalid outcome. Expected a selected option or cancellation. Options: ${this.describePermissionOptions(request)}.`,
      );
    }
    const optionId = result.outcome.optionId;
    if (!request.options.some((option) => option.optionId === optionId)) {
      throw new AcpPermissionError(
        `Permission callback selected unknown option '${optionId}'. Options: ${this.describePermissionOptions(request)}.`,
      );
    }
    return result as unknown as AcpRequestPermissionResult;
  }

  private defaultPermissionError(
    request: AcpRequestPermissionParams,
  ): AcpPermissionError {
    return new AcpPermissionError(
      `Grok requested permission for tool call '${request.toolCall.toolCallId}', but permissionMode is '${this.permissionMode}' and no onPermissionRequest callback is configured. Options: ${this.describePermissionOptions(request)}.`,
    );
  }

  private describePermissionOptions(
    request: AcpRequestPermissionParams,
  ): string {
    return request.options
      .map((option) => `${option.optionId} (${option.kind}: ${option.name})`)
      .join(", ");
  }

  private async handleReadTextFile(
    request: AcpReadTextFileParams,
  ): Promise<AcpReadTextFileResult> {
    const setting = this.fileSystem.readTextFile;
    if (setting === undefined || setting === false) {
      throw new AcpProtocolError(
        "Grok called 'fs/read_text_file', but readTextFile is not enabled.",
        { code: "METHOD_NOT_FOUND" },
      );
    }
    if (typeof setting === "function") return await setting(request);
    if (!isAbsolute(request.path)) {
      throw new AcpProtocolError(
        "ACP read_text_file requires an absolute path.",
      );
    }
    const content = await fs.readFile(request.path, "utf8");
    if (request.line === undefined && request.limit === undefined)
      return { content };
    const lines = content.split(/(?<=\n)/);
    const start = Math.max(0, (request.line ?? 1) - 1);
    const end =
      request.limit === undefined || request.limit === null
        ? undefined
        : start + request.limit;
    return { content: lines.slice(start, end).join("") };
  }

  private async handleWriteTextFile(
    request: AcpWriteTextFileParams,
  ): Promise<AcpWriteTextFileResult> {
    const setting = this.fileSystem.writeTextFile;
    if (setting === undefined || setting === false) {
      throw new AcpProtocolError(
        "Grok called 'fs/write_text_file', but writeTextFile is not enabled.",
        { code: "METHOD_NOT_FOUND" },
      );
    }
    if (typeof setting === "function") return await setting(request);
    if (!isAbsolute(request.path)) {
      throw new AcpProtocolError(
        "ACP write_text_file requires an absolute path.",
      );
    }
    await fs.writeFile(request.path, request.content, "utf8");
    return null;
  }

  private captureStderr(chunk: Buffer | string): void {
    if (this.stderrLimit === 0) return;
    this.stderr = `${this.stderr}${chunk.toString()}`;
    if (this.stderr.length > this.stderrLimit)
      this.stderr = this.stderr.slice(-this.stderrLimit);
  }

  private cancelPendingPermissions(sessionId?: string): void {
    for (const [id, permission] of this.pendingPermissions) {
      if (sessionId !== undefined && permission.sessionId !== sessionId)
        continue;
      this.pendingPermissions.delete(id);
      permission.cancel();
    }
  }

  private isTerminalStdinFailure(error: AcpError): boolean {
    return TERMINAL_STDIN_FAILURE_CODES.has(error.code ?? "");
  }

  private async resolveStdinFailure(error: AcpError): Promise<Error> {
    if (this.shutdownRequested) {
      return this.lastFailure ?? this.shutdownError ?? error;
    }
    if (this.childExited) {
      return await waitForAcpClientTerminalFailure(this);
    }
    if (this.state !== "running") return this.lastFailure ?? error;
    if (!this.isTerminalStdinFailure(error)) {
      this.fail(error);
      return this.lastFailure ?? error;
    }

    this.provisionalStdinFailure ??= error;
    if (!this.childExited && !this.provisionalStdinFailureTimer) {
      this.provisionalStdinFailureTimer = setTimeout(() => {
        this.provisionalStdinFailureTimer = undefined;
        if (
          this.state === "running" &&
          !this.shutdownRequested &&
          !this.childExited
        ) {
          this.fail(this.provisionalStdinFailure ?? error);
        }
      }, TERMINAL_STDIN_FAILURE_GRACE_MS);
    }
    return await waitForAcpClientTerminalFailure(this);
  }

  private clearProvisionalStdinFailureTimer(): void {
    if (this.provisionalStdinFailureTimer) {
      clearTimeout(this.provisionalStdinFailureTimer);
      this.provisionalStdinFailureTimer = undefined;
    }
  }

  private fail(error: unknown): void {
    if (this.state === "disposed" || this.state === "exited") return;
    const resolved =
      error instanceof Error ? error : new AcpError(errorMessage(error));
    this.clearProvisionalStdinFailureTimer();
    this.lastFailure = resolved;
    this.state = "exited";
    lifecycleFor(this).resolveTerminalFailure(resolved);
    this.rejectAll(resolved);
    this.cancelPendingPermissions();
    if (!(resolved instanceof AcpSpawnError)) {
      void this.terminateAfterFailure();
    }
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
  }
}

export type { AcpCancelParams };
