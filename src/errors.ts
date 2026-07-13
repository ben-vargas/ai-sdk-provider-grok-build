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

export function createGrokBuildAuthenticationError(
  message: string,
): LoadAPIKeyError {
  return new LoadAPIKeyError({ message });
}

export function mapAcpError(
  error: unknown,
  requestBodyValues?: unknown,
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
    code: acpError?.code,
    exitCode: acpError?.exitCode,
    signal: acpError?.signal,
    stderr: acpError?.stderr,
    rpcCode: error instanceof AcpJsonRpcError ? error.rpcCode : undefined,
    method: error instanceof AcpJsonRpcError ? error.method : undefined,
  };
  const retryable =
    error instanceof AcpTimeoutError ||
    error instanceof AcpProcessExitError ||
    (error instanceof AcpJsonRpcError && error.rpcCode <= -32000);

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

export function missingApiKeyError(): LoadAPIKeyError {
  return createGrokBuildAuthenticationError(
    "Grok Build authMethod 'api_key' requires XAI_API_KEY in settings.env or the process environment.",
  );
}

export function isMissingExecutableError(error: unknown): boolean {
  return error instanceof AcpSpawnError && error.code === "ENOENT";
}

export * from "./acp/errors.js";
