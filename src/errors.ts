import { AISDKError, APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  grokAuthenticationRemediation,
  JSON_RPC_INTERNAL_ERROR_CODE,
} from "./acp/authentication.js";
import {
  AcpAuthenticationError,
  AcpError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpSpawnError,
  AcpTimeoutError,
  isAcpAuthenticationRpcError,
  isSanitizedAcpDiagnosticError,
  sanitizeDiagnosticMessage,
  sanitizeStderrDetails,
  stderrTailForAcpError,
  stripAnsiEscapeSequences,
} from "./acp/errors.js";

export interface GrokBuildErrorData {
  code?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  rpcCode?: number;
  method?: string;
}

const grokCliAuthenticationFailures = new WeakSet<GrokCliError>();

export class GrokCliError extends Error {
  readonly code: string;
  readonly exitCode?: number | null;
  readonly stderr?: string;

  constructor(
    message: string,
    options: {
      code: string;
      cause?: unknown;
      exitCode?: number | null;
      stderr?: string;
    },
  ) {
    const authenticationFailure = containsAuthenticationFailureDiagnostic(
      message,
      options.stderr ?? "",
    );
    super(sanitizeDiagnosticMessage(message), { cause: options.cause });
    if (authenticationFailure) grokCliAuthenticationFailures.add(this);
    this.name = "GrokCliError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    const sanitizedStderr = options.stderr
      ? sanitizeStderrDetails(options.stderr).inline
      : "";
    this.stderr = sanitizedStderr || undefined;
  }
}

export function createGrokBuildAuthenticationError(
  message: string,
  cause?: unknown,
): LoadAPIKeyError {
  const error = new LoadAPIKeyError({ message });
  if (cause !== undefined) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: true,
      value: cause,
      writable: true,
    });
  }
  return error;
}

function collectAuthenticationDiagnostics(error: Error): string[] {
  const MAX_AUTHENTICATION_DIAGNOSTICS = 4;
  const MAX_AUTHENTICATION_ERRORS_INSPECTED = 16;
  const diagnostics: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let inspected = 0;
  while (
    pending.length > 0 &&
    inspected < MAX_AUTHENTICATION_ERRORS_INSPECTED
  ) {
    const current = pending.shift();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    inspected++;
    if (current instanceof AggregateError) {
      pending.unshift(...current.errors);
      if (current.cause !== undefined) pending.push(current.cause);
      continue;
    }
    const diagnostic =
      current instanceof GrokCliError || isSanitizedAcpDiagnosticError(current)
        ? current.message
        : sanitizeDiagnosticMessage(current.message);
    if (diagnostic) {
      const covered = diagnostics.some(
        (existing) => existing === diagnostic || existing.includes(diagnostic),
      );
      if (!covered) {
        const containedIndexes = diagnostics
          .map((existing, index) =>
            diagnostic.includes(existing) ? index : -1,
          )
          .filter((index) => index >= 0);
        if (containedIndexes.length > 0) {
          const insertionIndex = containedIndexes[0] ?? diagnostics.length;
          for (const index of containedIndexes.reverse()) {
            diagnostics.splice(index, 1);
          }
          diagnostics.splice(insertionIndex, 0, diagnostic);
        } else if (diagnostics.length < MAX_AUTHENTICATION_DIAGNOSTICS) {
          diagnostics.push(diagnostic);
        }
      }
    }
    if (current.cause !== undefined) pending.push(current.cause);
  }
  return diagnostics;
}

function formatAcpAuthenticationError(
  error: AcpError,
  authenticationMode: string,
): string {
  const details = collectAuthenticationDiagnostics(error);
  const errorCode = error.code;
  if (errorCode && !details.some((detail) => detail.includes(errorCode))) {
    details.push(`Provider error code: ${errorCode}.`);
  }
  const tail = stderrTailForAcpError(error);
  if (tail && !details.some((detail) => detail.includes(tail))) {
    details.push(`Stderr tail: ${tail}`);
  }
  const authenticationError =
    error instanceof AcpAuthenticationError ? error : undefined;
  return `${details.join("\n")}\n\n${grokAuthenticationRemediation({
    authMethod: authenticationError?.authenticationMethod ?? authenticationMode,
    code: error.code,
    availableMethods: authenticationError?.availableAuthenticationMethods,
  })}`;
}

const STRONG_AUTHENTICATION_FAILURE_DIAGNOSTICS = [
  /^(?:error:\s*)?(?:authrequired|authorizationrequired)\b/i,
  /^(?:error:\s*)?(?:authentication|login)\s+(?:is\s+)?required\b/i,
  /^(?:error:\s*)?unauthorized\b/i,
  /^(?:error:\s*)?unauthenticated\b/i,
  /^(?:error:\s*)?(?:http(?:\s+status)?\s*)?401\b/i,
  /^(?:error:\s*)?not\s+(?:logged\s+in|signed\s+in)\b/i,
];

const API_KEY_FAILURE_DIAGNOSTICS = [
  /^(?:error:\s*)?(?:missing|invalid|expired)\s+(?:xai[_\s-]?)?api[_\s-]?key\b/i,
  /^(?:error:\s*)?(?:xai[_\s-]?)?api[_\s-]?key\s+(?:is\s+)?(?:missing|invalid|expired)\b/i,
];

type DiagnosticSeverity =
  | "TRACE"
  | "DEBUG"
  | "INFO"
  | "WARN"
  | "ERROR"
  | "FATAL";

function normalizeAuthenticationDiagnostic(diagnostic: string): {
  text: string;
  severity?: DiagnosticSeverity;
} {
  let text = stripAnsiEscapeSequences(diagnostic)
    .trim()
    .replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\s+/i,
      "",
    )
    .trim();

  let severity: string | undefined;
  while (true) {
    const bracketMatch = /^\[([^\]\r\n]+)\]\s*/.exec(text);
    if (!bracketMatch) break;
    const bracketSeverity =
      /(?:^|[\s:])(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?=$|[\s:])/i.exec(
        bracketMatch[1] ?? "",
      );
    severity ??= bracketSeverity?.[1]?.toUpperCase();
    text = text.slice(bracketMatch[0].length);
  }

  const unbracketedSeverityMatch =
    /^(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b[:\s-]*/i.exec(text);
  severity ??= unbracketedSeverityMatch?.[1]?.toUpperCase();
  if (unbracketedSeverityMatch) {
    text = text.slice(unbracketedSeverityMatch[0].length);
  }
  text = text
    .replace(/^(?:\[[^\]\r\n]+\]\s*)+/, "")
    .replace(/^[A-Za-z0-9_.-]+(?:::[A-Za-z0-9_.-]+)+:\s*/, "")
    .trim();
  return {
    text,
    severity:
      severity === "WARNING"
        ? "WARN"
        : (severity as DiagnosticSeverity | undefined),
  };
}

function containsAuthenticationFailureDiagnostic(
  ...sources: string[]
): boolean {
  return sources
    .flatMap((source) => {
      const maxCodeUnits = 16 * 1024;
      const half = maxCodeUnits / 2;
      const bounded =
        source.length <= maxCodeUnits
          ? source
          : `${source.slice(0, half)}\n${source.slice(-half)}`;
      return bounded.split(/[\r\n\u2028\u2029]+|;\s+/);
    })
    .map(normalizeAuthenticationDiagnostic)
    .filter(({ text }) => Boolean(text))
    .some(({ text, severity }) => {
      if (
        STRONG_AUTHENTICATION_FAILURE_DIAGNOSTICS.some((pattern) =>
          pattern.test(text),
        )
      ) {
        return true;
      }
      if (severity && severity !== "ERROR" && severity !== "FATAL") {
        return false;
      }
      return API_KEY_FAILURE_DIAGNOSTICS.some((pattern) => pattern.test(text));
    });
}

export function mapAcpError(
  error: unknown,
  requestBodyValues?: unknown,
  options: { authenticationMode?: string; postDispatch?: boolean } = {},
): Error {
  if (AISDKError.isInstance(error)) {
    return error;
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "ZodError")
  ) {
    return error;
  }
  if (error instanceof AcpAuthenticationError) {
    return createGrokBuildAuthenticationError(
      formatAcpAuthenticationError(
        error,
        options.authenticationMode ?? "cached_token",
      ),
      error,
    );
  }
  if (isAcpAuthenticationRpcError(error)) {
    return createGrokBuildAuthenticationError(
      formatAcpAuthenticationError(
        error,
        options.authenticationMode ?? "cached_token",
      ),
      error,
    );
  }

  const acpError = error instanceof AcpError ? error : undefined;
  const data: GrokBuildErrorData = {
    code:
      acpError?.code ??
      (error instanceof GrokCliError ? error.code : undefined),
    exitCode:
      acpError?.exitCode ??
      (error instanceof GrokCliError ? error.exitCode : undefined),
    signal: acpError?.signal,
    stderr:
      acpError?.stderr ??
      (error instanceof GrokCliError ? error.stderr : undefined),
    rpcCode: error instanceof AcpJsonRpcError ? error.rpcCode : undefined,
    method: error instanceof AcpJsonRpcError ? error.method : undefined,
  };
  const retryable =
    !options.postDispatch &&
    (error instanceof AcpTimeoutError ||
      error instanceof AcpProcessExitError ||
      (error instanceof AcpJsonRpcError &&
        error.rpcCode === JSON_RPC_INTERNAL_ERROR_CODE));

  return new APICallError({
    message:
      error instanceof Error
        ? isSanitizedAcpDiagnosticError(error)
          ? error.message
          : sanitizeDiagnosticMessage(error.message)
        : sanitizeDiagnosticMessage(`Grok ACP call failed: ${String(error)}`),
    url: "grok-build://acp",
    requestBodyValues,
    cause: error,
    isRetryable: retryable,
    data,
  });
}

export function mapGrokExecError(
  error: unknown,
  requestBodyValues?: unknown,
): Error {
  if (AISDKError.isInstance(error)) return error;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "ZodError")
  ) {
    return error;
  }
  const cliError = error instanceof GrokCliError ? error : undefined;
  const message = cliError
    ? cliError.message
    : sanitizeDiagnosticMessage(
        error instanceof Error ? error.message : String(error),
      );
  const authenticationFailure =
    cliError !== undefined &&
    ["GROK_CLI_HEADLESS_ERROR", "GROK_CLI_PROCESS_EXIT"].includes(
      cliError.code,
    ) &&
    grokCliAuthenticationFailures.has(cliError);
  if (authenticationFailure) {
    return createGrokBuildAuthenticationError(message, error);
  }
  return new APICallError({
    message,
    url: "grok-build://exec",
    requestBodyValues,
    cause: error,
    isRetryable: cliError?.code === "GROK_CLI_SPAWN_FAILED",
    data: {
      code: cliError?.code,
      exitCode: cliError?.exitCode,
      stderr: cliError?.stderr,
    } satisfies GrokBuildErrorData,
  });
}

export function missingApiKeyError(): LoadAPIKeyError {
  return createGrokBuildAuthenticationError(
    "Grok Build authMethod 'api_key' requires XAI_API_KEY in settings.env or the process environment.",
  );
}

export function isMissingExecutableError(error: unknown): boolean {
  return (
    (error instanceof AcpSpawnError && error.code === "ENOENT") ||
    (error instanceof GrokCliError &&
      ["ENOENT", "GROK_CLI_NOT_FOUND"].includes(error.code)) ||
    (APICallError.isInstance(error) &&
      error.data !== null &&
      typeof error.data === "object" &&
      "code" in error.data &&
      ["ENOENT", "GROK_CLI_NOT_FOUND"].includes(String(error.data.code)))
  );
}

export * from "./acp/errors.js";
