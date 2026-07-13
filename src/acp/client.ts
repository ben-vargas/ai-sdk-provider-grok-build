import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import {
  AcpAuthenticationError,
  AcpError,
  AcpJsonRpcError,
  AcpPermissionError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSpawnError,
  AcpTimeoutError,
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

const DEFAULT_ARGS = ["--no-auto-update", "agent", "stdio"];
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_LIMIT = 32_768;

export type PermissionMode = "default" | "bypassPermissions";

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
  authMethod?: string | false;
  permissionMode?: PermissionMode;
  onPermissionRequest?: PermissionHandler;
  fileSystem?: AcpFileSystemSettings;
  onUpdate?: (update: AcpSessionUpdateParams) => void | Promise<void>;
  onExtension?: (
    notification: AcpExtensionNotification,
  ) => void | Promise<void>;
  spawn?: AcpSpawnFactory;
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
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}

interface PendingPermission {
  sessionId: string;
  cancel(): void;
}

type ClientState = "idle" | "running" | "disposed" | "exited";

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

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The ACP operation was aborted.");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationRpcError(error: unknown): boolean {
  if (!(error instanceof AcpJsonRpcError)) return false;
  const normalized = `${error.rpcCode} ${error.message}`.toLowerCase();
  return /auth|login|token|unauthori[sz]ed|401/.test(normalized);
}

export class AcpClient {
  private readonly executable: string;
  private readonly args: readonly string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd?: string;
  private readonly requestTimeoutMs: number;
  private readonly stderrLimit: number;
  private readonly authMethod: string | false;
  private readonly permissionMode: PermissionMode;
  private readonly onPermissionRequest?: PermissionHandler;
  private readonly fileSystem: AcpFileSystemSettings;
  private readonly onUpdate?: AcpClientOptions["onUpdate"];
  private readonly onExtension?: AcpClientOptions["onExtension"];
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
    Set<(update: AcpSessionUpdateParams) => void | Promise<void>>
  >();
  private readonly pendingPermissions = new Map<JsonRpcId, PendingPermission>();
  private writeQueue: Promise<void> = Promise.resolve();
  private readQueue: Promise<void> = Promise.resolve();
  private initializePromise?: Promise<AcpInitializeResult>;
  private initialized?: AcpInitializeResult;
  private stderr = "";
  private lastFailure?: Error;

  constructor(options: AcpClientOptions = {}) {
    this.executable = options.executable ?? "grok";
    this.args = options.args ?? DEFAULT_ARGS;
    this.env = { ...process.env, ...options.env };
    this.cwd = options.cwd;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stderrLimit = Math.max(0, options.stderrLimit ?? DEFAULT_STDERR_LIMIT);
    this.authMethod =
      options.authMethod === undefined ? "cached_token" : options.authMethod;
    this.permissionMode = options.permissionMode ?? "default";
    this.onPermissionRequest = options.onPermissionRequest;
    this.fileSystem = options.fileSystem ?? {};
    this.onUpdate = options.onUpdate;
    this.onExtension = options.onExtension;
    this.spawnProcess = options.spawn ?? defaultSpawn;
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

  async initialize(): Promise<AcpInitializeResult> {
    if (this.initialized) return this.initialized;
    if (this.initializePromise) return await this.initializePromise;

    this.initializePromise = this.initializeInternal()
      .catch((error: unknown) => {
        this.fail(error);
        throw error;
      })
      .finally(() => {
        this.initializePromise = undefined;
      });
    return await this.initializePromise;
  }

  async authenticate(
    methodId = this.authMethod,
  ): Promise<AcpAuthenticateResult> {
    if (methodId === false) return {};
    this.start();
    try {
      return await this.requestInternal("authenticate", { methodId });
    } catch (error) {
      throw new AcpAuthenticationError(
        `Grok authentication with method '${methodId}' failed. Run 'grok login' to refresh the cached CLI login, or configure XAI_API_KEY as an alternative.`,
        { cause: error, stderr: this.stderr, code: "AUTHENTICATION_FAILED" },
      );
    }
  }

  async request<Method extends keyof AcpRequestMap>(
    method: Method,
    params: AcpRequestMap[Method]["params"],
    timeoutMs?: number,
  ): Promise<AcpRequestMap[Method]["result"]> {
    await this.initialize();
    return await this.requestInternal(method, params, timeoutMs);
  }

  async notify<Method extends keyof AcpNotificationMap>(
    method: Method,
    params: AcpNotificationMap[Method],
  ): Promise<void> {
    await this.initialize();
    await this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  async newSession(params: AcpNewSessionParams): Promise<AcpSessionResult> {
    try {
      return await this.request("session/new", params);
    } catch (error) {
      if (isAuthenticationRpcError(error)) {
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
  ): Promise<AcpLoadSessionResult> {
    const initialized = await this.initialize();
    if (!initialized.agentCapabilities.loadSession) {
      throw new AcpProtocolError(
        "Grok did not advertise the ACP 'loadSession' capability.",
        {
          code: "CAPABILITY_NOT_SUPPORTED",
        },
      );
    }
    return await this.requestInternal("session/load", params);
  }

  async prompt(
    params: AcpPromptParams,
    options: AcpPromptOptions = {},
  ): Promise<AcpPromptOutcome> {
    await this.initialize();
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);

    const handler = options.onUpdate;
    if (handler) {
      const handlers = this.promptHandlers.get(params.sessionId) ?? new Set();
      handlers.add(handler);
      this.promptHandlers.set(params.sessionId, handlers);
    }

    const onAbort = (): void => {
      void this.cancelSession(params.sessionId).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await this.requestInternal(
        "session/prompt",
        params,
        options.timeoutMs,
        signal,
      );
      return { stopReason: result.stopReason, meta: result._meta };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (handler) {
        const handlers = this.promptHandlers.get(params.sessionId);
        handlers?.delete(handler);
        if (handlers?.size === 0) this.promptHandlers.delete(params.sessionId);
      }
    }
  }

  async cancelSession(sessionId: string): Promise<void> {
    for (const permission of this.pendingPermissions.values()) {
      if (permission.sessionId === sessionId) permission.cancel();
    }
    await this.notify("session/cancel", { sessionId });
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    const error = new AcpError("AcpClient was disposed.", {
      code: "CLIENT_DISPOSED",
    });
    this.rejectAll(error);
    this.pendingPermissions.forEach((permission) => permission.cancel());
    this.pendingPermissions.clear();
    this.child?.kill("SIGTERM");
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.dispose();
  }

  private async initializeInternal(): Promise<AcpInitializeResult> {
    this.start();
    const result = await this.requestInternal("initialize", {
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
    });

    if (result.protocolVersion !== 1) {
      throw new AcpProtocolError(
        `Unsupported ACP protocol version ${result.protocolVersion}; this provider requires version 1.`,
        { code: "UNSUPPORTED_PROTOCOL_VERSION" },
      );
    }

    if (this.authMethod !== false) {
      const advertised = result.authMethods.some(
        (method) => method.id === this.authMethod,
      );
      if (!advertised) {
        throw new AcpAuthenticationError(
          `Grok did not advertise authentication method '${this.authMethod}'. Available methods: ${result.authMethods.map((method) => method.id).join(", ") || "(none)"}.`,
          { stderr: this.stderr, code: "AUTH_METHOD_NOT_AVAILABLE" },
        );
      }
      await this.authenticate(this.authMethod);
    }

    this.initialized = result;
    return result;
  }

  private start(): void {
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

    const framer = new NdjsonFramer((line) => {
      this.readQueue = this.readQueue
        .then(async () => await this.handleLine(line))
        .catch((error: unknown) => this.fail(error));
    });
    this.child.stdout.on("data", (chunk: Buffer | string) =>
      framer.push(chunk),
    );
    this.child.stdout.on("end", () => framer.end());
    this.child.stderr.on("data", (chunk: Buffer | string) =>
      this.captureStderr(chunk),
    );
    this.child.on("error", (error) => this.fail(this.createSpawnError(error)));
    this.child.on("exit", (code, signal) => {
      if (this.state === "disposed") return;
      this.fail(new AcpProcessExitError(code, signal, { stderr: this.stderr }));
    });
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

  private requestInternal<Method extends keyof AcpRequestMap>(
    method: Method,
    params: AcpRequestMap[Method]["params"],
    timeoutMs = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<AcpRequestMap[Method]["result"]> {
    this.start();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const id = this.nextId++;

    return new Promise<AcpRequestMap[Method]["result"]>((resolve, reject) => {
      const cleanupAbort = (): void =>
        signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanupAbort();
        reject(new AcpTimeoutError(method, timeoutMs, { stderr: this.stderr }));
      }, timeoutMs);
      const onAbort = (): void => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.cleanup();
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        cleanup: cleanupAbort,
      });

      void this.writeMessage({ jsonrpc: "2.0", id, method, params }).catch(
        (error: unknown) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.cleanup();
          pending.reject(error);
        },
      );
    });
  }

  private writeMessage(message: object): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      if (!this.child || this.state !== "running") {
        throw (
          this.lastFailure ?? new AcpError("Grok ACP process is not running.")
        );
      }
      const data = `${JSON.stringify(message)}\n`;
      if (!this.child.stdin.write(data)) {
        await new Promise<void>((resolve, reject) => {
          this.child?.stdin.once("drain", resolve);
          this.child?.stdin.once("error", reject);
        });
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AcpProtocolError(
        `Invalid JSON from Grok ACP stdout: ${line.slice(0, 200)}`,
        {
          cause: error,
          stderr: this.stderr,
        },
      );
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new AcpProtocolError(
        "Grok ACP emitted a non-object JSON-RPC message.",
        {
          data: message as JsonValue,
        },
      );
    }

    const record = message as Record<string, unknown>;
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
      await this.handleAgentRequest(record as unknown as JsonRpcRequest);
      return;
    }
    await this.handleNotification(
      record as unknown as AcpExtensionNotification,
    );
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id as JsonRpcId | null;
    if (id === null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.cleanup();

    if ("error" in record) {
      const failure = record as unknown as JsonRpcFailure;
      pending.reject(
        new AcpJsonRpcError(pending.method, failure.error, {
          stderr: this.stderr,
        }),
      );
    } else {
      pending.resolve((record as unknown as JsonRpcSuccess).result);
    }
  }

  private async handleNotification(
    notification: AcpExtensionNotification,
  ): Promise<void> {
    if (notification.method === "session/update") {
      const params = notification.params as AcpSessionUpdateParams;
      if (!params || typeof params.sessionId !== "string" || !params.update) {
        throw new AcpProtocolError("Malformed 'session/update' notification.");
      }
      await this.invokeSafely(this.onUpdate, params);
      const handlers = this.promptHandlers.get(params.sessionId);
      if (handlers) {
        for (const handler of handlers)
          await this.invokeSafely(handler, params);
      }
      return;
    }
    await this.invokeSafely(this.onExtension, notification);
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

  private async handleAgentRequest(request: JsonRpcRequest): Promise<void> {
    const customHandler = this.requestHandlers.get(request.method);
    try {
      let result: unknown;
      if (customHandler) {
        result = await customHandler(request.params);
      } else if (request.method === "session/request_permission") {
        result = await this.handlePermissionRequest(
          request.id,
          request.params as AcpRequestPermissionParams,
        );
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
      await this.writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: result ?? null,
      });
    } catch (error) {
      const protocolError = error instanceof AcpError ? error : undefined;
      await this.writeMessage({
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
      });
    }
  }

  private async handlePermissionRequest(
    id: JsonRpcId,
    request: AcpRequestPermissionParams,
  ): Promise<AcpRequestPermissionResult> {
    let cancel!: () => void;
    const cancelled = new Promise<AcpRequestPermissionResult>((resolve) => {
      cancel = () => resolve({ outcome: { outcome: "cancelled" } });
    });
    this.pendingPermissions.set(id, { sessionId: request.sessionId, cancel });

    try {
      const decision = this.onPermissionRequest
        ? Promise.resolve(this.onPermissionRequest(request)).then((result) =>
            this.validatePermissionResult(request, result),
          )
        : this.permissionMode === "bypassPermissions"
          ? Promise.resolve(this.selectAllowOption(request))
          : Promise.reject(this.defaultPermissionError(request));
      return await Promise.race([decision, cancelled]);
    } finally {
      this.pendingPermissions.delete(id);
    }
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
    result: AcpRequestPermissionResult,
  ): AcpRequestPermissionResult {
    if (result.outcome.outcome === "cancelled") return result;
    const optionId = result.outcome.optionId;
    if (!request.options.some((option) => option.optionId === optionId)) {
      throw new AcpPermissionError(
        `Permission callback selected unknown option '${optionId}'. Options: ${this.describePermissionOptions(request)}.`,
      );
    }
    return result;
  }

  private defaultPermissionError(
    request: AcpRequestPermissionParams,
  ): AcpPermissionError {
    return new AcpPermissionError(
      `Grok requested permission for tool call '${request.toolCall.toolCallId}', but permissionMode is 'default' and no onPermissionRequest callback is configured. Options: ${this.describePermissionOptions(request)}.`,
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

  private fail(error: unknown): void {
    if (this.state === "disposed") return;
    const resolved =
      error instanceof Error ? error : new AcpError(errorMessage(error));
    this.lastFailure = resolved;
    this.state = "exited";
    this.rejectAll(resolved);
    this.pendingPermissions.forEach((permission) => permission.cancel());
    this.pendingPermissions.clear();
    this.child?.kill("SIGTERM");
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
