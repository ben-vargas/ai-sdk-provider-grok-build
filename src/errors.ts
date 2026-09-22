import { AISDKError, APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import {
  AcpAuthenticationError,
  AcpError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpSpawnError,
  AcpTimeoutError,
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
        error.rpcCode >= -32099 &&
        error.rpcCode <= -32000));

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
    cliError?.code === "GROK_CLI_HEADLESS_ERROR" &&
    /\b(?:login|unauthorized|authentication|authenticate|authrequired|authorizationrequired)\b|not\s+(?:logged|signed)(?:\s+in)?|api[_\s-]?key|\b401\b/i.test(
      message,
    );
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
