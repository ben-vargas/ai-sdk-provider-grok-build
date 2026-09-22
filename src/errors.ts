import { AISDKError, APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  AcpAuthenticationError,
  AcpError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpSpawnError,
  AcpTimeoutError,
  isAcpAuthenticationRpcError,
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
    super(message, { cause: options.cause });
    this.name = "GrokCliError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
  }
}

export function createGrokBuildAuthenticationError(
  message: string,
): LoadAPIKeyError {
  return new LoadAPIKeyError({ message });
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
    .flatMap((source) => source.split(/[\r\n\u2028\u2029]+|;\s+/))
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
  options: { postDispatch?: boolean } = {},
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
    return createGrokBuildAuthenticationError(error.message);
  }
  if (isAcpAuthenticationRpcError(error)) {
    return createGrokBuildAuthenticationError(error.message);
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
        error.rpcCode === -32603 &&
        !isAcpAuthenticationRpcError(error)));

  return new APICallError({
    message:
      error instanceof Error
        ? error.message
        : `Grok ACP call failed: ${String(error)}`,
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
  const message = error instanceof Error ? error.message : String(error);
  const authenticationFailure =
    cliError !== undefined &&
    ["GROK_CLI_HEADLESS_ERROR", "GROK_CLI_PROCESS_EXIT"].includes(
      cliError.code,
    ) &&
    containsAuthenticationFailureDiagnostic(message, cliError.stderr ?? "");
  if (authenticationFailure) {
    return createGrokBuildAuthenticationError(message);
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
