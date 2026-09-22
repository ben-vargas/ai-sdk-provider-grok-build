import type { JsonRpcErrorObject, JsonValue } from "./protocol.js";
import { redactSensitiveData } from "../redact.js";
import {
  ACP_AUTHENTICATION_REQUIRED_CODE,
  JSON_RPC_INTERNAL_ERROR_CODE,
  isLegacyGrokAuthenticationRpcFailure,
} from "./authentication.js";

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

const MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS = 600;
const MAX_PUBLIC_DIAGNOSTIC_LINES = 5;

function sanitizedDiagnosticLines(raw: string): string[] {
  const normalized = stripAnsiEscapeSequences(raw)
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .map((line) =>
      Array.from(line)
        .filter((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return (
            codePoint >= 0x20 &&
            codePoint !== 0x7f &&
            (codePoint < 0x80 || codePoint > 0x9f)
          );
        })
        .join("")
        .trim(),
    );
  const redacted = redactSensitiveData(normalized.join("\n"));
  return (typeof redacted === "string" ? redacted : "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function limitDiagnosticStart(raw: string): string {
  const codePoints = Array.from(raw);
  return codePoints.length > MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS
    ? `${codePoints.slice(0, MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS - 1).join("")}…`
    : raw;
}

/** Sanitizes an agent-provided diagnostic while retaining its leading context. */
export function sanitizeDiagnosticMessage(raw: string): string {
  return limitDiagnosticStart(
    sanitizedDiagnosticLines(raw)
      .slice(0, MAX_PUBLIC_DIAGNOSTIC_LINES)
      .join("; "),
  );
}

function sanitizeStderr(raw: string): string {
  const hasTrailingLineBreak = /(?:\r\n|\r|\n|\u2028|\u2029)$/.test(raw);
  const lines = sanitizedDiagnosticLines(raw).slice(
    -MAX_PUBLIC_DIAGNOSTIC_LINES,
  );
  const value = `${lines.join("\n")}${
    hasTrailingLineBreak && lines.length > 0 ? "\n" : ""
  }`;
  const codePoints = Array.from(value);
  return codePoints.length > MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS
    ? `…${codePoints.slice(-(MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS - 1)).join("")}`
    : value;
}

export function stderrTail(raw: string): string {
  const lines = sanitizedDiagnosticLines(raw)
    .slice(-MAX_PUBLIC_DIAGNOSTIC_LINES)
    .join("; ");
  const codePoints = Array.from(lines);
  return codePoints.length > MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS
    ? `…${codePoints.slice(-(MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS - 1)).join("")}`
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
    const sanitizedStderr = options.stderr
      ? sanitizeStderr(options.stderr)
      : "";
    this.stderr = sanitizedStderr || undefined;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.data = options.data;
  }
}

export class AcpAuthenticationError extends AcpError {
  constructor(message: string, options: AcpErrorOptions = {}) {
    super(sanitizeDiagnosticMessage(message), {
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
    const rpcMessage = sanitizeDiagnosticMessage(error.message);
    super(`ACP request '${method}' failed (${error.code}): ${rpcMessage}`, {
      ...options,
      code: "JSON_RPC_ERROR",
      data: redactSensitiveData(error.data),
    });
    this.name = "AcpJsonRpcError";
    this.rpcCode = error.code;
    this.rpcMessage = rpcMessage;
    this.method = method;
  }
}

/** @internal Classify canonical ACP auth errors and bounded legacy Grok auth failures. */
export function isAcpAuthenticationRpcError(
  error: unknown,
): error is AcpJsonRpcError {
  return (
    error instanceof AcpJsonRpcError &&
    (error.rpcCode === ACP_AUTHENTICATION_REQUIRED_CODE ||
      (error.rpcCode === JSON_RPC_INTERNAL_ERROR_CODE &&
        isLegacyGrokAuthenticationRpcFailure(error.method, error.rpcMessage)))
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
