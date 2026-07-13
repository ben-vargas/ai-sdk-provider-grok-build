import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  AcpAuthenticationError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpSpawnError,
} from "./acp/errors.js";
import { isMissingExecutableError, mapAcpError } from "./errors.js";
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

  it("maps mid-prompt exits as retryable and retains stderr", () => {
    const mapped = mapAcpError(
      new AcpProcessExitError(9, null, { stderr: "agent crashed\n" }),
    );
    expect(mapped).toBeInstanceOf(APICallError);
    expect(mapped).toMatchObject({
      isRetryable: true,
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
