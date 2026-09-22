import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  AcpAuthenticationError,
  AcpJsonRpcError,
  AcpProcessExitError,
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

  it("preserves authentication-required initialize RPC data", () => {
    const mapped = mapAcpError(
      new AcpJsonRpcError("initialize", {
        code: -32001,
        message: "Authentication required",
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).toMatchObject({
      isRetryable: true,
      data: {
        code: "JSON_RPC_ERROR",
        rpcCode: -32001,
        method: "initialize",
      },
    });
  });

  it.each([
    { rpcCode: -32001, postDispatch: false, retryable: true },
    { rpcCode: -32700, postDispatch: false, retryable: false },
    { rpcCode: -32601, postDispatch: false, retryable: false },
    { rpcCode: -32001, postDispatch: true, retryable: false },
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

  it("does not infer authentication from process-exit stderr", () => {
    const failure = new GrokCliError("Grok CLI exited with code 7", {
      code: "GROK_CLI_PROCESS_EXIT",
      exitCode: 7,
      stderr: "login required: configure API_KEY",
    });
    const mapped = mapGrokExecError(failure, { modelId: "grok-4.6" });

    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
    expect(mapped).toMatchObject({
      cause: failure,
      isRetryable: false,
      requestBodyValues: { modelId: "grok-4.6" },
      data: {
        code: "GROK_CLI_PROCESS_EXIT",
        exitCode: 7,
        stderr: "login required: configure API_KEY",
      },
    });
  });

  it("does not infer authentication from headless stderr alone", () => {
    const mapped = mapGrokExecError(
      new GrokCliError("tool service unavailable", {
        code: "GROK_CLI_HEADLESS_ERROR",
        stderr: "not signed in",
      }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).not.toBeInstanceOf(LoadAPIKeyError);
  });

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
