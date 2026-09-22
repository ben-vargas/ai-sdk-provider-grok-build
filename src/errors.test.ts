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
      new AcpAuthenticationError("Authentication required"),
    );
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.message).toContain("grok login");
  });

  it("preserves ACP authentication diagnostics in the AI SDK error message", () => {
    const cause = new AcpJsonRpcError("session/new", {
      code: -32603,
      message: "token refresh failed",
    });
    const mapped = mapAcpError(
      new AcpAuthenticationError(cause.message, {
        cause,
        code: "AUTHENTICATION_FAILED",
        stderr:
          "\u001b[31mrefresh worker failed\u0000 Authorization: Bearer sk-stderr-secret\u001b[0m\n",
      }),
    );

    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.message).toContain("session/new");
    expect(mapped.message).toContain("-32603");
    expect(mapped.message).toContain("token refresh failed");
    expect(mapped.message).toContain(
      "Provider error code: AUTHENTICATION_FAILED.",
    );
    expect(mapped.message).toContain("Stderr tail: refresh worker failed");
    expect(mapped.message).toContain("[REDACTED]");
    expect(mapped.message).not.toContain("sk-stderr-secret");
    expect(mapped.message).not.toContain("\u001b");
    expect(mapped.message).not.toContain("\u0000");
    expect(mapped.message).toContain("authMethod");
    expect(mapped.message).toContain("api_key");
    expect(mapped.message).toContain("grok login");
    expect(mapped.message).toContain("XAI_API_KEY");
    expect(mapped.message.match(/token refresh failed/g)).toHaveLength(1);
    expect(mapped.message.match(/grok login/g)).toHaveLength(1);
    expect(mapped.cause).toBeInstanceOf(AcpAuthenticationError);
  });

  it("preserves unavailable-method diagnostics and code through mapping", () => {
    const cause = new AcpAuthenticationError(
      "Grok did not advertise authentication method 'cached-token'. Available methods: cached_token.",
      { code: "AUTH_METHOD_NOT_AVAILABLE" },
    );
    const mapped = mapAcpError(cause, undefined, {
      authenticationMode: "cached-token",
    });

    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.cause).toBe(cause);
    expect(mapped.message).toContain("AUTH_METHOD_NOT_AVAILABLE");
    expect(mapped.message).toContain("cached_token");
    expect(mapped.message).toContain(
      "'api_key' is not an ACP-advertised method",
    );
  });

  it("bounds and redacts agent RPC diagnostics and structured data", () => {
    const secret = "sk-agent-secret";
    const cause = new AcpJsonRpcError("session/new", {
      code: -32000,
      message: `\u001b[31mAuthentication required\u0000 Authorization: Bearer ${secret}\u001b[0m\n${"detail".repeat(200)}`,
      data: {
        authorization: `Bearer ${secret}`,
        nested: { access_token: secret, safe: "visible" },
      },
    });
    const mapped = mapAcpError(cause, undefined, {
      authenticationMode: "api_key",
    });

    expect(Array.from(cause.rpcMessage).length).toBeLessThanOrEqual(600);
    expect(cause.rpcMessage).toContain("Authentication required");
    expect(cause.rpcMessage).toContain("[REDACTED]");
    expect(cause.rpcMessage).not.toContain(secret);
    expect(cause.rpcMessage).not.toContain("\u001b");
    expect(cause.rpcMessage).not.toContain("\u0000");
    expect(JSON.stringify(cause.data)).toContain("[REDACTED]");
    expect(JSON.stringify(cause.data)).not.toContain(secret);
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.cause).toBe(cause);
    expect(mapped.message).not.toContain(secret);
    expect(mapped.message).not.toContain("grok login");
  });

  it("redacts and bounds stderr retained for process failures", () => {
    const secret = "sk-process-secret";
    const error = new AcpProcessExitError(9, null, {
      stderr: `${"old detail\n".repeat(10)}${"x".repeat(800)}\nAuthorization: Bearer ${secret}\n`,
    });

    expect(error.stderr).toBeDefined();
    expect(Array.from(error.stderr ?? "").length).toBeLessThanOrEqual(600);
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it.each([
    {
      authenticationMode: "cached_token",
      expected: "grok login",
      unexpected: "Verify or replace the provider 'apiKey' value",
    },
    {
      authenticationMode: "api_key",
      expected: "Verify or replace the provider 'apiKey' value",
      unexpected: "grok login",
    },
    {
      authenticationMode: "custom_sso",
      expected: "configured provider authentication method",
      unexpected: "grok login",
    },
  ])(
    "tailors provider remediation for $authenticationMode",
    ({ authenticationMode, expected, unexpected }) => {
      const mapped = mapAcpError(
        new AcpAuthenticationError("Authentication failed"),
        undefined,
        { authenticationMode },
      );
      expect(mapped.message).toContain(expected);
      expect(mapped.message).not.toContain(unexpected);
    },
  );

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

  it.each([
    "authenticate",
    "initialize",
    "session/new",
    "session/load",
    "session/prompt",
    "session/set_config_option",
    "future/request",
  ])(
    "maps the method-independent ACP auth_required code from %s to the auth surface",
    (method) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError(method, {
          code: -32000,
          message: "Upstream authentication detail",
        }),
      );
      expect(mapped).toBeInstanceOf(LoadAPIKeyError);
      expect(mapped.message).toContain(method);
      expect(mapped.message).toContain("-32000");
      expect(mapped.message).toContain("Upstream authentication detail");
      expect(mapped.message).toContain("grok login");
      expect(mapped.message).toContain("XAI_API_KEY");
      expect(mapped.message).toMatch(
        /Upstream authentication detail[\s\S]+Run 'grok login'/,
      );
      expect(mapped.message.match(/grok login/g)).toHaveLength(1);
      expect(mapped.cause).toMatchObject({
        name: "AcpJsonRpcError",
        method,
        rpcCode: -32000,
      });
    },
  );

  it.each([
    "authenticate",
    "initialize",
    "session/new",
    "session/load",
    "session/set_config_option",
  ])(
    "maps bounded legacy token-refresh failures from %s to the auth surface",
    (method) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError(method, {
          code: -32603,
          message: "token refresh failed",
        }),
      );

      expect(mapped).toBeInstanceOf(LoadAPIKeyError);
      expect(mapped).not.toBeInstanceOf(APICallError);
      expect(mapped.message).toContain("grok login");
    },
  );

  it.each([
    "token refresh failed",
    "Login is required",
    "Unauthorized",
    "Error: Unauthenticated.",
    "Internal error: Unauthorized: token expired",
    "Unauthenticated: please log in",
    "Invalid access token",
  ])(
    "recognizes a bounded legacy ACP authentication diagnostic: %s",
    (message) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError("initialize", {
          code: -32603,
          message,
        }),
      );
      expect(mapped).toBeInstanceOf(LoadAPIKeyError);
      expect(mapped).not.toBeInstanceOf(APICallError);
    },
  );

  it.each(["Invalid token at position 17", "HTTP 401 Unauthorized"])(
    "keeps an unrecognized internal-error diagnostic retryable: %s",
    (message) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError("initialize", {
          code: -32603,
          message,
        }),
      );

      expect(mapped).toBeInstanceOf(APICallError);
      expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
      expect(mapped).toMatchObject({ isRetryable: true });
    },
  );

  it.each([
    "token refresh failed",
    "Login is required",
    "Unauthorized",
    "Invalid token at position 17",
    "MCP server 'notion' failed: Authentication required",
    "HTTP 401 Unauthorized",
  ])(
    "keeps prompt-time internal failures non-retryable and off the auth surface: %s",
    (message) => {
      const mapped = mapAcpError(
        new AcpJsonRpcError("session/prompt", {
          code: -32603,
          message,
        }),
        undefined,
        { postDispatch: true },
      );

      expect(mapped).toBeInstanceOf(APICallError);
      expect(mapped).toMatchObject({
        isRetryable: false,
        data: {
          code: "JSON_RPC_ERROR",
          rpcCode: -32603,
          method: "session/prompt",
        },
      });
    },
  );

  it("does not infer legacy authentication for an unknown method", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("future/request", {
        code: -32603,
        message: "token refresh failed",
      }),
    );

    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
    expect(mapped).toMatchObject({ isRetryable: true });
  });

  it("maps pre-dispatch configuration auth_required to actionable guidance", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("session/set_config_option", {
        code: -32000,
        message: "Authentication required",
      }),
    );

    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.message).toContain("session/set_config_option");
    expect(mapped.message).toContain("Authentication required");
    expect(mapped.message).toContain("grok login");
    expect(mapped.message).toContain("XAI_API_KEY");
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

  it("does not reinterpret the non-ACP unauthorized code as provider auth", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("session/load", {
        code: -32002,
        message: "Unauthorized",
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
