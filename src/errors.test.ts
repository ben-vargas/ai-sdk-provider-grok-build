import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  AcpAuthenticationError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSpawnError,
} from "./acp/errors.js";
import {
  GrokCliError,
  isMissingExecutableError,
  mapAcpError,
  mapGrokExecError,
} from "./errors.js";
import { createGrokBuild } from "./grok-build-provider.js";

describe("mapAcpError", () => {
  it("maps cached-login failures to the AI SDK authentication error surface", () => {
    const mapped = mapAcpError(
      new AcpAuthenticationError("Authentication required; run grok login"),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.message).toContain("grok login");
  });

  it("preserves ENOENT spawn diagnostics in a non-retryable APICallError", () => {
    const mapped = mapAcpError(
      new AcpSpawnError("Could not find Grok Build executable 'grok'.", {
        code: "ENOENT",
      }),
      { modelId: "grok-4.5" },
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).toMatchObject({
      isRetryable: false,
      requestBodyValues: { modelId: "grok-4.5" },
      data: { code: "ENOENT" },
    });
  });

  it("maps the ACP authentication-required code to the auth surface", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("initialize", {
        code: -32000,
        message: "Authentication required",
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it("maps bounded token-refresh failures to the auth surface", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("authenticate", {
        code: -32603,
        message: "token refresh failed",
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it("keeps transient authenticate service failures retryable", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("authenticate", {
        code: -32603,
        message: "Authentication service unavailable",
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
    expect(mapped).toMatchObject({ isRetryable: true });
  });

  it("does not reinterpret resource-not-found text as authentication", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("session/load", {
        code: -32002,
        message: "API key resource not found",
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
    expect(mapped).toMatchObject({ isRetryable: false });
  });

  it.each([
    { rpcCode: -32603, postDispatch: false, retryable: true },
    { rpcCode: -32002, postDispatch: false, retryable: false },
    { rpcCode: -32800, postDispatch: false, retryable: false },
    { rpcCode: -32700, postDispatch: false, retryable: false },
    { rpcCode: -32601, postDispatch: false, retryable: false },
    { rpcCode: -32603, postDispatch: true, retryable: false },
  ])(
    "maps JSON-RPC code $rpcCode with postDispatch=$postDispatch",
    ({ rpcCode, postDispatch, retryable }) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError("initialize", {
          code: rpcCode,
          message: "fixture failure",
        }),
        undefined,
        { postDispatch },
      );
      expect(mapped).toMatchObject({ isRetryable: retryable });
    },
  );

  it("maps mid-prompt exits as non-retryable and retains stderr", () => {
    const mapped = mapAcpError(
      new AcpProcessExitError(9, null, { stderr: "agent crashed\n" }),
      undefined,
      { postDispatch: true },
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).toMatchObject({
      isRetryable: false,
      data: { code: "PROCESS_EXIT", exitCode: 9, stderr: "agent crashed\n" },
    });
  });

  it("keeps malformed process output non-retryable with exit metadata", () => {
    const mapped = mapAcpError(
      new AcpProtocolError("Invalid JSON from Grok ACP stdout", {
        code: "PROTOCOL_ERROR",
        exitCode: 12,
        stderr: "parser crash detail\n",
      }),
    );

    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).toMatchObject({
      isRetryable: false,
      data: {
        code: "PROTOCOL_ERROR",
        exitCode: 12,
        stderr: "parser crash detail\n",
      },
    });
  });

  it("passes AbortError through unchanged", () => {
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    expect(mapAcpError(aborted)).toBe(aborted);
  });

  it("recognizes a missing executable through the public generateText failure path", async () => {
    const provider = createGrokBuild({
      executablePath: "/definitely-missing/grok-build-review-test",
    });
    const error = await generateText({
      model: provider(),
      prompt: "ping",
      maxRetries: 0,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(APICallError);
    expect(isMissingExecutableError(error)).toBe(true);
  });
});

describe("mapGrokExecError", () => {
  it("does not classify launch paths containing auth as credential failures", () => {
    const mapped = mapGrokExecError(
      new GrokCliError("Failed to start /opt/auth-tools/grok", {
        code: "ENOENT",
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
    expect(mapped).toMatchObject({ isRetryable: false });
  });

  it("uses bounded authentication phrases for headless failures", () => {
    expect(
      mapGrokExecError(
        new GrokCliError("AuthRequired", {
          code: "GROK_CLI_HEADLESS_ERROR",
        }),
      ),
    ).toBeInstanceOf(LoadAPIKeyError);
    expect(
      mapGrokExecError(
        new GrokCliError("authoring service unavailable", {
          code: "GROK_CLI_HEADLESS_ERROR",
        }),
      ),
    ).toBeInstanceOf(APICallError);
  });

  it("recognizes authentication in process-exit stderr", () => {
    const failure = new GrokCliError("Grok CLI exited with code 7", {
      code: "GROK_CLI_PROCESS_EXIT",
      exitCode: 7,
      stderr: "login required: configure API_KEY",
    });
    const mapped = mapGrokExecError(failure, { modelId: "grok-4.6" });

    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it("recognizes authentication in headless stderr", () => {
    const mapped = mapGrokExecError(
      new GrokCliError("tool service unavailable", {
        code: "GROK_CLI_HEADLESS_ERROR",
        stderr: "not signed in",
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "Authentication required",
    "Login is required",
    "AuthRequired",
    "AuthorizationRequired",
    "Unauthorized",
    "Unauthenticated",
    "HTTP 401 unauthorized",
    "not logged in",
    "not signed in",
    "Unauthorized: token expired",
    "Unauthenticated: please log in",
    "AuthRequired: run grok login",
    "missing XAI_API_KEY",
    "XAI_API_KEY is invalid",
    "expired api key",
  ])("recognizes the known authentication diagnostic %s", (diagnostic) => {
    const mapped = mapGrokExecError(
      new GrokCliError("Grok CLI exited with code 7", {
        code: "GROK_CLI_PROCESS_EXIT",
        exitCode: 7,
        stderr: diagnostic,
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "2026-07-13T03:48:09Z ERROR Not signed in",
    "2026-07-13T03:48:09.123456+00:00 [grok::auth] WARN Unauthenticated",
    "2026-07-13T03:48:09Z ERROR [grok::auth] Not signed in",
    "[worker-7] FATAL: Authentication required",
    "DEBUG AuthorizationRequired",
  ])("normalizes logging prefixes before auth matching: %s", (diagnostic) => {
    const mapped = mapGrokExecError(
      new GrokCliError("Grok CLI exited with code 7", {
        code: "GROK_CLI_PROCESS_EXIT",
        exitCode: 7,
        stderr: diagnostic,
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "2026-07-13T03:48:09Z ERROR grok::auth: Login required",
    "\u001b[31mERROR\u001b[0m grok::auth: Unauthenticated",
  ])("normalizes logger targets and ANSI colors: %s", (diagnostic) => {
    const mapped = mapGrokExecError(
      new GrokCliError("Grok CLI exited with code 7", {
        code: "GROK_CLI_PROCESS_EXIT",
        exitCode: 7,
        stderr: diagnostic,
      }),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "WARN api key missing for optional telemetry",
    "INFO invalid XAI_API_KEY for optional metrics export",
    "[WARN] api key missing for optional telemetry",
    "[INFO] invalid XAI_API_KEY for optional metrics export",
    "[worker WARN grok::telemetry] missing api key, skipping upload",
    "telemetry: missing api key, skipping upload",
  ])("does not promote optional credential diagnostics: %s", (diagnostic) => {
    const mapped = mapGrokExecError(
      new GrokCliError("Grok CLI exited with code 7", {
        code: "GROK_CLI_PROCESS_EXIT",
        exitCode: 7,
        stderr: diagnostic,
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "artifact was not signed",
    "authentication metadata was included in the response",
    "request field XAI_API_KEY was redacted",
    "rate limit reached while validating an API key field",
    "tool could not sign the generated artifact",
    "2026-07-13T03:48:09Z INFO artifact was not signed",
  ])(
    "keeps generic credential-related text as a process failure: %s",
    (text) => {
      const mapped = mapGrokExecError(
        new GrokCliError("Grok CLI exited with code 7", {
          code: "GROK_CLI_PROCESS_EXIT",
          exitCode: 7,
          stderr: text,
        }),
      );
      expect(mapped).toBeInstanceOf(APICallError);
      expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
      expect(mapped).toMatchObject({
        data: { exitCode: 7, stderr: text },
      });
    },
  );

  it("retries only pre-dispatch spawn failures", () => {
    expect(
      mapGrokExecError(
        new GrokCliError("spawn failed", {
          code: "GROK_CLI_SPAWN_FAILED",
        }),
      ),
    ).toMatchObject({ isRetryable: true });
    expect(
      mapGrokExecError(
        new GrokCliError("process exited", {
          code: "GROK_CLI_PROCESS_EXIT",
          exitCode: 9,
        }),
      ),
    ).toMatchObject({ isRetryable: false });
  });
});
