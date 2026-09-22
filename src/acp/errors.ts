import type { JsonRpcErrorObject, JsonValue } from "./protocol.js";

export interface AcpErrorOptions {
  code?: string;
  cause?: unknown;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  data?: JsonValue;
}

const ANSI_ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsiEscapeSequences(raw: string): string {
  return raw.replace(ANSI_ESCAPE_SEQUENCE, "");
}

export function stderrTail(raw: string): string {
  const lines = stripAnsiEscapeSequences(raw)
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((line) =>
      Array.from(line)
        .filter((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint >= 0x20 && codePoint !== 0x7f;
        })
        .join("")
        .trim(),
    )
    .filter(Boolean)
    .slice(-5)
    .join("; ");
  const codePoints = Array.from(lines);
  return codePoints.length > 600
    ? `…${codePoints.slice(-599).join("")}`
    : lines;
}

export class AcpError extends Error {
  readonly code?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly data?: JsonValue;

  constructor(message: string, options: AcpErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AcpError";
    this.code = options.code;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.data = options.data;
  }
}

export class AcpAuthenticationError extends AcpError {
  constructor(message: string, options: AcpErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "AUTHENTICATION_FAILED",
    });
    this.name = "AcpAuthenticationError";
  }
}

export class AcpSpawnError extends AcpError {
  constructor(message: string, options: AcpErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "SPAWN_FAILED" });
    this.name = "AcpSpawnError";
  }
}

export class AcpProtocolError extends AcpError {
  constructor(message: string, options: AcpErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "PROTOCOL_ERROR" });
    this.name = "AcpProtocolError";
  }
}

export class AcpJsonRpcError extends AcpProtocolError {
  readonly rpcCode: number;
  readonly rpcMessage: string;
  readonly method: string;

  constructor(
    method: string,
    error: JsonRpcErrorObject,
    options: AcpErrorOptions = {},
  ) {
    super(`ACP request '${method}' failed (${error.code}): ${error.message}`, {
      ...options,
      code: "JSON_RPC_ERROR",
      data: error.data,
    });
    this.name = "AcpJsonRpcError";
    this.rpcCode = error.code;
    this.rpcMessage = error.message;
    this.method = method;
  }
}

const AUTHENTICATION_RPC_DIAGNOSTIC =
  /\b(?:token|credential)\s+refresh\s+failed\b|\b(?:authentication|login)\s+(?:is\s+)?required\b|\bunauthorized\b|\bunauthenticated\b|\b(?:invalid|expired)\s+(?:access\s+)?token\b/i;

/** @internal Classify only explicit ACP authentication failures. */
export function isAcpAuthenticationRpcError(
  error: unknown,
): error is AcpJsonRpcError {
  return (
    error instanceof AcpJsonRpcError &&
    (error.rpcCode === -32000 ||
      (error.rpcCode === -32603 &&
        AUTHENTICATION_RPC_DIAGNOSTIC.test(error.rpcMessage)))
  );
}

export class AcpTimeoutError extends AcpError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(
    method: string,
    timeoutMs: number,
    options: AcpErrorOptions = {},
  ) {
    super(`ACP request '${method}' timed out after ${timeoutMs}ms`, {
      ...options,
      code: "TIMEOUT",
    });
    this.name = "AcpTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class AcpProcessExitError extends AcpError {
  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    options: AcpErrorOptions = {},
  ) {
    const status = signal
      ? `signal ${signal}`
      : `exit code ${String(exitCode)}`;
    const tail = options.stderr ? stderrTail(options.stderr) : "";
    const stderrSuffix = tail ? ` Stderr tail: ${tail}` : "";
    super(
      `Grok ACP process exited unexpectedly with ${status}.${stderrSuffix}`,
      {
        ...options,
        code: "PROCESS_EXIT",
        exitCode,
        signal,
      },
    );
    this.name = "AcpProcessExitError";
  }
}

export class AcpPermissionError extends AcpError {
  constructor(message: string, options: AcpErrorOptions = {}) {
    super(message, { ...options, code: options.code ?? "PERMISSION_DENIED" });
    this.name = "AcpPermissionError";
  }
}

export function isAcpAuthenticationError(
  error: unknown,
): error is AcpAuthenticationError {
  return error instanceof AcpAuthenticationError;
}

export function isAcpTimeoutError(error: unknown): error is AcpTimeoutError {
  return error instanceof AcpTimeoutError;
}
