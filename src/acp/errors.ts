import type { JsonRpcErrorObject, JsonValue } from "./protocol.js";
import {
  redactSensitiveDiagnosticData,
  visitRedactedSensitiveTextLines,
} from "../redact.js";
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
const MAX_AUTHENTICATION_DIAGNOSTIC_LINES = 32;
const MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS =
  MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS * 2;
const SANITIZED_STDERR = Symbol("sanitized-stderr");
const SANITIZED_MESSAGE = Symbol("sanitized-message");
const SANITIZED_DIAGNOSTIC_DATA = Symbol("sanitized-diagnostic-data");
const SANITIZED_RPC_DIAGNOSTICS = Symbol("sanitized-rpc-diagnostics");
const LEGACY_AUTHENTICATION_FAILURE = Symbol("legacy-authentication-failure");

const sanitizedDiagnosticErrors = new WeakSet<Error>();
const sanitizedStderrByError = new WeakMap<Error, SanitizedStderrDetails>();
const legacyAuthenticationFailures = new WeakSet<AcpJsonRpcError>();

interface SanitizedStderrDetails {
  multiline: string;
  inline: string;
}

interface NormalizedDiagnosticLine {
  value: string;
}

type InternalAcpErrorOptions = AcpErrorOptions & {
  [SANITIZED_DIAGNOSTIC_DATA]?: JsonValue;
  [SANITIZED_MESSAGE]?: string;
  [SANITIZED_RPC_DIAGNOSTICS]?: readonly string[];
  [SANITIZED_STDERR]?: SanitizedStderrDetails;
  [LEGACY_AUTHENTICATION_FAILURE]?: boolean;
};

function normalizeDiagnosticLine(
  line: string,
  selection: "start" | "end",
): NormalizedDiagnosticLine {
  const maxCodeUnits = MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS * 2;
  const window =
    line.length <= maxCodeUnits
      ? line
      : selection === "start"
        ? line.slice(0, maxCodeUnits)
        : line.slice(-maxCodeUnits);
  const codePoints = Array.from(window);
  const truncated =
    window.length !== line.length ||
    codePoints.length > MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS;
  let bounded = truncated
    ? selection === "start"
      ? codePoints.slice(0, MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS - 1).join("")
      : codePoints.slice(-(MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS - 1)).join("")
    : window;
  bounded = bounded
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f-\u009f]/g,
      " ",
    )
    .trim();
  if (truncated && selection === "end") {
    bounded = `…${bounded}`;
  } else if (truncated) {
    bounded = `${bounded}…`;
  }
  return { value: bounded };
}

export function sanitizeDiagnosticLines(
  raw: string,
  selection: "start" | "end" = "start",
): string[] {
  const selected: string[] = [];
  visitRedactedSensitiveTextLines(
    raw,
    { diagnosticContext: true },
    (line) => {
      const value = normalizeDiagnosticLine(
        stripAnsiEscapeSequences(line),
        selection,
      ).value;
      if (!value) return true;
      if (selection === "start") {
        selected.push(value);
        return selected.length < MAX_PUBLIC_DIAGNOSTIC_LINES;
      }
      selected.push(value);
      if (selected.length > MAX_PUBLIC_DIAGNOSTIC_LINES) selected.shift();
      return true;
    },
    {
      maxCodeUnits: MAX_DIAGNOSTIC_LINE_WORK_CODE_POINTS * 2,
      selection,
    },
  );
  return selected;
}

function visitDiagnosticLines(
  raw: string,
  visitor: (line: string) => boolean,
): void {
  const lineBreak = /\r\n|\r|\n|\u2028|\u2029/g;
  let start = 0;
  for (let match = lineBreak.exec(raw); match; match = lineBreak.exec(raw)) {
    if (!visitor(raw.slice(start, match.index))) return;
    start = match.index + match[0].length;
  }
  visitor(raw.slice(start));
}

function authenticationDiagnosticLines(raw: string): string[] {
  const selected: string[] = [];
  visitDiagnosticLines(raw, (line) => {
    const value = normalizeDiagnosticLine(
      stripAnsiEscapeSequences(line),
      "start",
    ).value;
    if (value) selected.push(value);
    return selected.length < MAX_AUTHENTICATION_DIAGNOSTIC_LINES;
  });
  return selected;
}

function limitDiagnosticStart(raw: string): string {
  const codePoints = Array.from(raw);
  return codePoints.length > MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS
    ? `${codePoints.slice(0, MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS - 1).join("")}…`
    : raw;
}

/** Sanitizes an agent-provided diagnostic while retaining its leading context. */
export function sanitizeDiagnosticMessage(raw: string): string {
  return limitDiagnosticStart(sanitizeDiagnosticLines(raw, "start").join("; "));
}

function limitDiagnosticEnd(raw: string): string {
  const codePoints = Array.from(raw);
  return codePoints.length > MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS
    ? `…${codePoints.slice(-(MAX_PUBLIC_DIAGNOSTIC_CODE_POINTS - 1)).join("")}`
    : raw;
}

export function sanitizeStderrDetails(raw: string): SanitizedStderrDetails {
  const hasTrailingLineBreak = /(?:\r\n|\r|\n|\u2028|\u2029)$/.test(raw);
  const lines = sanitizeDiagnosticLines(raw, "end");
  const multiline = `${lines.join("\n")}${
    hasTrailingLineBreak && lines.length > 0 ? "\n" : ""
  }`;
  return {
    multiline: limitDiagnosticEnd(multiline),
    inline: limitDiagnosticEnd(lines.join("; ")),
  };
}

export function stderrTail(raw: string): string {
  return sanitizeStderrDetails(raw).inline;
}

/** @internal Reuses a message that has already crossed the diagnostic sanitizer. */
export function markAcpErrorMessageSanitized<T extends AcpErrorOptions>(
  message: string,
  options: T,
): T {
  return {
    ...options,
    [SANITIZED_MESSAGE]: message,
  } as T;
}

/** @internal Indicates whether an ACP error message is already sanitized. */
export function isSanitizedAcpDiagnosticError(error: Error): boolean {
  return sanitizedDiagnosticErrors.has(error);
}

/** @internal Returns the stored inline form without sanitizing stderr again. */
export function stderrTailForAcpError(error: AcpError): string {
  return sanitizedStderrByError.get(error)?.inline ?? "";
}

export class AcpError extends Error {
  readonly code?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly data?: JsonValue;

  constructor(message: string, options: AcpErrorOptions = {}) {
    const internalOptions = options as InternalAcpErrorOptions;
    super(
      internalOptions[SANITIZED_MESSAGE] ?? sanitizeDiagnosticMessage(message),
      {
        cause: options.cause,
      },
    );
    sanitizedDiagnosticErrors.add(this);
    this.name = "AcpError";
    this.code = options.code;
    const sanitizedStderr =
      internalOptions[SANITIZED_STDERR] ??
      (options.stderr ? sanitizeStderrDetails(options.stderr) : undefined);
    this.stderr = sanitizedStderr?.multiline || undefined;
    if (sanitizedStderr) sanitizedStderrByError.set(this, sanitizedStderr);
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.data = Object.hasOwn(internalOptions, SANITIZED_DIAGNOSTIC_DATA)
      ? internalOptions[SANITIZED_DIAGNOSTIC_DATA]
      : redactSensitiveDiagnosticData(options.data);
  }
}

export interface AcpAuthenticationErrorOptions extends AcpErrorOptions {
  authenticationMethod?: string;
  availableAuthenticationMethods?: readonly string[];
}

export class AcpAuthenticationError extends AcpError {
  readonly authenticationMethod?: string;
  readonly availableAuthenticationMethods?: readonly string[];

  constructor(message: string, options: AcpAuthenticationErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "AUTHENTICATION_FAILED",
    });
    this.name = "AcpAuthenticationError";
    this.authenticationMethod = options.authenticationMethod;
    this.availableAuthenticationMethods = options.availableAuthenticationMethods
      ? [...options.availableAuthenticationMethods]
      : undefined;
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
  readonly rpcDiagnostics: readonly string[];
  readonly method: string;

  constructor(
    method: string,
    error: JsonRpcErrorObject,
    options: AcpErrorOptions = {},
  ) {
    const internalOptions = options as InternalAcpErrorOptions;
    const rpcDiagnostics =
      internalOptions[SANITIZED_RPC_DIAGNOSTICS] ??
      sanitizeDiagnosticLines(error.message, "start");
    const rpcMessage = limitDiagnosticStart(rpcDiagnostics.join("; "));
    const message = `ACP request '${method}' failed (${error.code}): ${rpcMessage}`;
    const legacyAuthenticationFailure =
      internalOptions[LEGACY_AUTHENTICATION_FAILURE] ??
      isLegacyGrokAuthenticationRpcFailure(
        method,
        authenticationDiagnosticLines(error.message),
      );
    super(message, {
      ...options,
      [SANITIZED_MESSAGE]: message,
      code: "JSON_RPC_ERROR",
      data: error.data,
    } as InternalAcpErrorOptions);
    this.name = "AcpJsonRpcError";
    if (legacyAuthenticationFailure) legacyAuthenticationFailures.add(this);
    this.rpcCode = error.code;
    this.rpcMessage = rpcMessage;
    this.rpcDiagnostics = rpcDiagnostics;
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
        legacyAuthenticationFailures.has(error)))
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
    const internalOptions = options as InternalAcpErrorOptions;
    const sanitizedStderr =
      internalOptions[SANITIZED_STDERR] ??
      (options.stderr ? sanitizeStderrDetails(options.stderr) : undefined);
    const tail = sanitizedStderr?.inline ?? "";
    const stderrSuffix = tail ? ` Stderr tail: ${tail}` : "";
    const message = `Grok ACP process exited unexpectedly with ${status}.${stderrSuffix}`;
    super(message, {
      ...options,
      [SANITIZED_MESSAGE]: message,
      [SANITIZED_STDERR]: sanitizedStderr,
      code: "PROCESS_EXIT",
      exitCode,
      signal,
    } as InternalAcpErrorOptions);
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

export interface AcpErrorContext {
  cause?: unknown;
  stderr?: string;
}

/** Creates a fresh error with additional context while preserving its ACP type. */
export function cloneAcpErrorWithContext(
  error: AcpError,
  context: AcpErrorContext,
): AcpError {
  const options: InternalAcpErrorOptions = {
    cause: Object.hasOwn(context, "cause") ? context.cause : error.cause,
    stderr: context.stderr ?? error.stderr,
    code: error.code,
    exitCode: error.exitCode,
    signal: error.signal,
    data: error.data,
    [SANITIZED_DIAGNOSTIC_DATA]: error.data,
    [SANITIZED_MESSAGE]: error.message,
  };
  const existingStderr = sanitizedStderrByError.get(error);
  if (context.stderr === undefined && existingStderr) {
    options[SANITIZED_STDERR] = existingStderr;
  }
  if (error instanceof AcpJsonRpcError) {
    options[LEGACY_AUTHENTICATION_FAILURE] =
      legacyAuthenticationFailures.has(error);
    options[SANITIZED_RPC_DIAGNOSTICS] = error.rpcDiagnostics;
    return new AcpJsonRpcError(
      error.method,
      {
        code: error.rpcCode,
        message: error.rpcDiagnostics.join("\n"),
        data: error.data,
      },
      options,
    );
  }
  if (error instanceof AcpAuthenticationError) {
    return new AcpAuthenticationError(error.message, {
      ...options,
      authenticationMethod: error.authenticationMethod,
      availableAuthenticationMethods: error.availableAuthenticationMethods,
    });
  }
  if (error instanceof AcpTimeoutError)
    return new AcpTimeoutError(error.method, error.timeoutMs, options);
  if (error instanceof AcpProcessExitError)
    return new AcpProcessExitError(
      error.exitCode ?? null,
      error.signal ?? null,
      options,
    );
  if (error instanceof AcpSpawnError)
    return new AcpSpawnError(error.message, options);
  if (error instanceof AcpPermissionError)
    return new AcpPermissionError(error.message, options);
  if (error instanceof AcpProtocolError)
    return new AcpProtocolError(error.message, options);
  return new AcpError(error.message, options);
}
