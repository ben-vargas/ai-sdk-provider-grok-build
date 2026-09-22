import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  AcpAuthenticationError,
  AcpJsonRpcError,
  AcpProcessExitError,
  AcpProtocolError,
  AcpSpawnError,
  cloneAcpErrorWithContext,
  sanitizeDiagnosticLines,
  stderrTail,
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
        nested: {
          access_token: secret,
          safe: "visible",
          oversized: "x".repeat(100_000),
        },
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
    expect(
      Buffer.byteLength(JSON.stringify(cause.data), "utf8"),
    ).toBeLessThanOrEqual(8 * 1024);
    expect(JSON.stringify(cause.data)).toMatch(/TRUNCATED|__truncated__/);
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    expect(mapped.cause).toBe(cause);
    expect(mapped.message).not.toContain(secret);
    expect(mapped.message).not.toContain("grok login");
  });

  it("preserves already-sanitized diagnostic metadata when cloning", () => {
    const original = new AcpProtocolError("malformed initialize response", {
      data: { oversized: "x".repeat(100_000) },
    });
    const clone = cloneAcpErrorWithContext(original, {
      cause: original,
      stderr: "initialization failed",
    });

    expect(JSON.stringify(original.data)).toContain("[TRUNCATED]");
    expect(clone.data).toBe(original.data);
    expect(JSON.stringify(clone.data)).toContain("[TRUNCATED]");
    expect(clone.data).not.toHaveProperty("__truncated__#2");
  });

  it("does not progressively redact messages when ACP errors are cloned", () => {
    const original = new AcpJsonRpcError("initialize", {
      code: -32603,
      message:
        "Authorization: Bearer sk-clone-secret\nError: Authentication required",
    });
    const first = cloneAcpErrorWithContext(original, { cause: original });
    const second = cloneAcpErrorWithContext(first, { cause: first });

    expect(first.message).toBe(original.message);
    expect(second.message).toBe(original.message);
    expect((second as AcpJsonRpcError).rpcDiagnostics).toEqual(
      original.rpcDiagnostics,
    );
    expect(second.message).toContain("Authentication required");
    expect(second.message).not.toContain("sk-clone-secret");
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

  it("redacts a credential whose label was cut from a long stderr tail", () => {
    const jwt = `eyJ${"a".repeat(1_600)}.${"b".repeat(700)}.${"c".repeat(700)}`;
    const error = new AcpProcessExitError(9, null, {
      stderr: `Authorization: Bearer ${jwt}\n`,
    });

    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).not.toContain(jwt.slice(-700));
    expect(error.message).not.toContain(jwt.slice(-700));
  });

  it("redacts multiline quoted values whose labels precede the stderr tail", () => {
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "password: '",
        "part ''quoted''",
        "quoted-secret-1",
        "quoted-secret-2",
        "quoted-secret-3",
        "quoted-secret-4",
        "quoted-secret-5",
        "quoted-secret-6",
        "'",
        "FATAL: useful closing detail",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain("quoted-secret");
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL: useful closing detail");
  });

  it.each(["start", "end"] as const)(
    "redacts a separately opened multiline quoted value in %s diagnostics",
    (selection) => {
      const diagnostic = [
        "password:",
        '  "separate-diagnostic-secret-part-1',
        '  separate-diagnostic-secret-part-2"',
        "FATAL: useful closing detail",
      ].join("\n");
      const redacted = sanitizeDiagnosticLines(diagnostic, selection).join(
        "\n",
      );

      expect(redacted).not.toContain("separate-diagnostic-secret");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("FATAL: useful closing detail");
    },
  );

  it("tracks a separately opened quote on an oversized pending value line", () => {
    const diagnostic = [
      "password:",
      `  "${"oversized-opening-secret".repeat(150)}`,
      '  oversized-continuation-secret"',
      "FATAL: useful closing detail",
    ].join("\n");
    const leading = sanitizeDiagnosticLines(diagnostic, "start").join("\n");
    const trailing = stderrTail(diagnostic);

    for (const redacted of [leading, trailing]) {
      expect(redacted).not.toContain("oversized-opening-secret");
      expect(redacted).not.toContain("oversized-continuation-secret");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("FATAL: useful closing detail");
    }
  });

  it.each(
    (["start", "end"] as const).flatMap((selection) =>
      (['"', "'"] as const).map((quote) => [selection, quote] as const),
    ),
  )(
    "redacts a separately opened authorization quote in %s diagnostics with %s",
    (selection, quote) => {
      const diagnostic = [
        "Authorization:",
        `  ${quote}authorization-first-line-secret`,
        `  authorization-second-line-secret${quote}`,
        "FATAL: useful closing detail",
      ].join("\n");
      const redacted = sanitizeDiagnosticLines(diagnostic, selection).join(
        "\n",
      );

      expect(redacted).not.toContain("authorization-first-line-secret");
      expect(redacted).not.toContain("authorization-second-line-secret");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("FATAL: useful closing detail");
    },
  );

  it("tracks a trailing sensitive label after an earlier assignment", () => {
    const error = new AcpProtocolError(
      "Cookie: absent; api_key:\nnext-line-secret",
    );

    expect(error.message).not.toContain("next-line-secret");
    expect(error.message).toContain("[REDACTED]");
  });

  it("tracks a trailing authorization label after an earlier assignment", () => {
    const error = new AcpProtocolError(
      "Cookie: absent; Authorization:\nCustom short-secret",
    );

    expect(error.message).not.toContain("short-secret");
    expect(error.message).toContain("Custom [REDACTED]");
  });

  it.each([
    "api_key:\npassword:\nchained-secret",
    "Authorization:\npassword:\nchained-secret",
    "Authorization: Digest\nresponse=\ndigest-secret",
    'Authorization: Digest\nresponse="\nmultiline-digest-secret\n"',
    "Authorization: Digest foo=bar\nsig~v=digest-secret",
  ])("redacts chained sensitive diagnostic lines", (message) => {
    const error = new AcpProtocolError(message);

    expect(error.message).not.toMatch(
      /(?:chained|digest|multiline-digest)-secret/,
    );
    expect(error.message).toContain("[REDACTED]");
  });

  it.each([
    "-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY----- api_key:\nafter-pem-secret\nfiller-1\nfiller-2\nfiller-3\nFATAL",
    'password: "\nbody" api_key:\nafter-quote-secret\nfiller-1\nfiller-2\nFATAL',
    `${"x".repeat(8 * 1024 + 1)}\n-----END PRIVATE KEY----- api_key:\nafter-end-secret\nfiller-1\nfiller-2\nFATAL`,
  ])("carries sensitive state from a closing-line suffix", (stderr) => {
    const error = new AcpProcessExitError(9, null, { stderr });

    expect(error.stderr).not.toMatch(/after-(?:pem|quote|end)-secret/);
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL");
  });

  it("redacts armored PGP private-key bodies", () => {
    const error = new AcpProtocolError(
      "private_key:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\npgp-body-secret\n-----END PGP PRIVATE KEY BLOCK-----\nsafe diagnostic",
    );

    expect(error.message).not.toContain("pgp-body-secret");
    expect(error.message).toContain("safe diagnostic");
  });

  it.each([
    'Authoriza\u0000tion: Digest response="control-secret"',
    "api_\u0000key:\ncontrol-secret",
    "Authorization: Cus\u0000tom\ncontrol-secret",
    "Authorization: Digest foo=bar\nsig\u0000~v=control-secret",
    "-----BEGIN PRI\u0000VATE KEY-----\ncontrol-secret",
  ])("fails closed when controls split a sensitive label", (message) => {
    const error = new AcpProtocolError(message);

    expect(error.message).not.toContain("control-secret");
    expect(error.message).toContain("[REDACTED]");
  });

  it("redacts YAML-style credential blocks while retaining dedented diagnostics", () => {
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "password: |2",
        "  yaml-secret-1",
        "  yaml-secret-2",
        "  yaml-secret-3",
        "  yaml-secret-4",
        "  yaml-secret-5",
        "  yaml-secret-6",
        "FATAL: useful closing detail",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain("yaml-secret");
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL: useful closing detail");
  });

  it("redacts every parameter when a long authorization tail loses its label", () => {
    const secret = "digest-tail-secret";
    const error = new AcpProcessExitError(9, null, {
      stderr: `Authorization: Digest ${"a".repeat(3_000)}, response="${secret}"\n`,
    });

    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).not.toContain(secret);
    expect(error.message).not.toContain(secret);
  });

  it.each([
    ["Bearer", `${"a".repeat(3_000)}bearer-secret-tail`],
    ["Basic", "MnNuYTphZTIx".repeat(250)],
  ])(
    "redacts an oversized bare %s credential whose scheme is cut from the tail",
    (scheme, credential) => {
      const redacted = stderrTail(`request ${scheme} ${credential}`);

      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain(credential.slice(-24));
    },
  );

  it.each([
    ["control", "api_\u0001key="],
    ["ANSI", "api_\u001b[31mkey="],
  ])(
    "redacts oversized %s-obfuscated assignments before diagnostic normalization",
    (_kind, assignment) => {
      const leadingSecret = "leading-obfuscated-secret";
      const trailingSecret = "trailing-obfuscated-secret";
      const leading = sanitizeDiagnosticLines(
        `${assignment}${leadingSecret}${"x".repeat(3_000)}`,
        "start",
      ).join("\n");
      const trailing = stderrTail(
        `${assignment}${"x".repeat(3_000)}${trailingSecret}`,
      );

      expect(leading).toContain("[REDACTED]");
      expect(leading).not.toContain(leadingSecret);
      expect(trailing).toContain("[REDACTED]");
      expect(trailing).not.toContain(trailingSecret);
    },
  );

  it.each(["Bearer market rejected", "Basic auth rejected"])(
    "preserves oversized benign scheme prose: %s",
    (prose) => {
      const error = new AcpProtocolError(`${prose} ${"x".repeat(3_000)}`);

      expect(error.message).toContain(prose);
      expect(error.message).not.toContain("[REDACTED]");
      expect(Array.from(error.message)).toHaveLength(600);
    },
  );

  it.each([
    `https://alice:${"url-password-secret".repeat(300)}@example.test/path`,
    `https://${"url-username-secret".repeat(300)}:password@example.test/path`,
  ])(
    "redacts URL userinfo when a leading diagnostic is cut before @",
    (input) => {
      const error = new AcpProtocolError(input);

      expect(error.message).toContain("https://[REDACTED]:[REDACTED]");
      expect(error.message).not.toContain("url-password-secret");
      expect(error.message).not.toContain("url-username-secret");
      expect(Array.from(error.message).length).toBeLessThanOrEqual(600);
    },
  );

  it("redacts multiline credential labels with a preceding stderr context line", () => {
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "old line",
        "api_key:",
        "  xai-multiline-secret",
        "Authorization:",
        "Bearer short-secret",
        "FATAL: authentication failed",
        "",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain("xai-multiline-secret");
    expect(error.stderr).not.toContain("short-secret");
    expect(error.stderr).toContain("api_key:\n[REDACTED]");
    expect(error.stderr).toContain("Authorization:\nBearer [REDACTED]");
    expect(error.stderr).toContain("FATAL: authentication failed");
  });

  it("redacts the continuation after a truncated diagnostic line", () => {
    const secret = "short-secret";
    const stderrError = new AcpProcessExitError(9, null, {
      stderr: `${"x".repeat(3_000)} codex-diagnostic-continuation-probe api_key:\n${secret}\nFATAL: failed\n`,
    });
    const rpcError = new AcpJsonRpcError("initialize", {
      code: -32603,
      message: `${"x".repeat(3_000)} api_key:\n${secret}\nuseful detail`,
    });

    expect(stderrError.stderr).not.toContain(secret);
    expect(stderrError.stderr).toContain("FATAL: failed");
    expect(rpcError.rpcDiagnostics.join("\n")).not.toContain(secret);
    expect(rpcError.rpcDiagnostics.join("\n")).toContain("useful detail");
  });

  it("redacts private-key bodies whose BEGIN line precedes stderr tail context", () => {
    const bodyLines = Array.from(
      { length: 8 },
      (_, index) => `private-key-body-${String(index)}`,
    );
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "private_key:",
        `${"x".repeat(1_200)} -----BEGIN PRIVATE KEY-----`,
        ...bodyLines,
        "-----END PRIVATE KEY-----",
        "FATAL: key rejected",
        "",
      ].join("\n"),
    });

    for (const bodyLine of bodyLines) {
      expect(error.stderr).not.toContain(bodyLine);
    }
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL: key rejected");
  });

  it("redacts an unterminated private-key body beyond stderr tail context", () => {
    const bodyLines = Array.from(
      { length: 8 },
      (_, index) => `unterminated-private-key-body-${String(index)}`,
    );
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "private_key:",
        "-----BEGIN PRIVATE KEY-----",
        ...bodyLines,
        "",
      ].join("\n"),
    });

    for (const bodyLine of bodyLines) {
      expect(error.stderr).not.toContain(bodyLine);
    }
    expect(error.stderr).toContain("[REDACTED]");
  });

  it("redacts folded authorization parameters beyond stderr tail context", () => {
    const secret = "digest-folded-secret";
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        `${"x".repeat(1_200)} ERROR request failed Authorization:`,
        " Digest",
        ' username="u"',
        ' realm="r"',
        ' nonce="n"',
        ' uri="/"',
        ` response="${secret}"`,
        ' opaque="o"',
        "FATAL: authorization rejected",
        "",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain(secret);
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL: authorization rejected");
  });

  it("redacts unindented folded authorization parameters", () => {
    const secret = "unindented-digest-secret";
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "Authorization:",
        'Digest username="u",',
        `, response="${secret}"`,
        "FATAL: authorization rejected",
        "",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain(secret);
    expect(error.stderr).toContain("FATAL: authorization rejected");
  });

  it.each([
    ["Bearer", "eyJhbGciOiJIUzI1NiJ9"],
    ["Basic", "dXNlcjpwYXNz"],
    ["Custom_Scheme~1", "short-credential"],
  ])("redacts a credential folded after bare %s", (scheme, secret) => {
    const error = new AcpProcessExitError(9, null, {
      stderr: `Authorization: ${scheme}\n${secret}\nFATAL: authorization rejected\n`,
    });

    expect(error.stderr).not.toContain(secret);
    expect(error.stderr).toContain("[REDACTED]");
    expect(error.stderr).toContain("FATAL: authorization rejected");
  });

  it("fails closed after an uninspected long-line middle", () => {
    const secret = "middle-window-secret";
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        `${"x".repeat(5_000)} Authorization:${" ".repeat(5_000)}`,
        " Digest",
        ' username="u"',
        ' realm="r"',
        ' nonce="n"',
        ' uri="/"',
        ` response="${secret}"`,
        ' opaque="o"',
        "FATAL: authorization rejected",
        "",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain(secret);
    expect(error.stderr).toContain("[REDACTED]");
  });

  it("fails closed when a private-key BEGIN marker is in a long-line middle", () => {
    const bodyLines = Array.from(
      { length: 8 },
      (_, index) => `blind-private-key-body-${String(index)}`,
    );
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        `${"x".repeat(5_000)} -----BEGIN PRIVATE KEY----- ${"x".repeat(5_000)}`,
        ...bodyLines,
        "",
      ].join("\n"),
    });

    for (const bodyLine of bodyLines) {
      expect(error.stderr).not.toContain(bodyLine);
    }
    expect(error.stderr).toContain("[REDACTED]");
  });

  it("redacts diagnostic lines independently and classifies each RPC line", () => {
    const cause = new AcpJsonRpcError("initialize", {
      code: -32603,
      message: "Basic\nError: unauthorized",
    });
    const mapped = mapAcpError(cause);

    expect(cause.rpcDiagnostics).toEqual(["Basic", "Error: unauthorized"]);
    expect(cause.rpcMessage).toBe("Basic; Error: unauthorized");
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it("classifies raw legacy authentication diagnostics before public projection", () => {
    const cause = new AcpJsonRpcError("initialize", {
      code: -32603,
      message: [
        "detail one",
        "detail two",
        "detail three",
        "detail four",
        "detail five",
        "Authentication required",
      ].join("\n"),
    });
    const mapped = mapAcpError(cause);

    expect(cause.rpcDiagnostics).toHaveLength(5);
    expect(cause.rpcDiagnostics).not.toContain("Authentication required");
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it("keeps useful lines after oversized diagnostics and authorization headers", () => {
    const error = new AcpProcessExitError(9, null, {
      stderr: [
        "x".repeat(9_000),
        "Authorization: Bearer sk-stack-secret",
        "    at initialize (client.ts:1:1)",
        "Error: authentication required",
        "",
      ].join("\n"),
    });

    expect(error.stderr).not.toContain("sk-stack-secret");
    expect(error.stderr).toContain("at initialize (client.ts:1:1)");
    expect(error.stderr).toContain("Error: authentication required");
  });

  it("normalizes controls before redaction without corrupting ordinary prose", () => {
    const secret = "sk-tab-secret-123";
    const error = new AcpProtocolError(
      `Basic auth rejected\nBearer market rejected\nBearer\t${secret}`,
    );

    expect(error.message).toContain("Basic auth rejected");
    expect(error.message).toContain("Bearer market rejected");
    expect(error.message).toContain("Bearer [REDACTED]");
    expect(error.message).not.toContain(secret);
  });

  it("keeps the longer diagnostic when nested authentication messages overlap", () => {
    const detailed =
      "ACP request failed: Authentication required with detailed credential state";
    const mapped = mapAcpError(
      new AcpAuthenticationError("Authentication required", {
        cause: new Error(detailed),
      }),
    );
    const diagnosticLines = mapped.message.split("\n\n")[0]?.split("\n");

    expect(diagnosticLines).toContain(detailed);
    expect(diagnosticLines).not.toContain("Authentication required");
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

  it("prefers the authentication method recorded on the failure", () => {
    const mapped = mapAcpError(
      new AcpAuthenticationError("Authentication failed", {
        authenticationMethod: "api_key",
      }),
      undefined,
      { authenticationMode: "cached_token" },
    );

    expect(mapped.message).toContain(
      "Verify or replace the provider 'apiKey' value",
    );
    expect(mapped.message).not.toContain("grok login");
  });

  it("does not reference an advertised method list when Grok reported none", () => {
    const mapped = mapAcpError(
      new AcpAuthenticationError(
        "Grok did not advertise authentication method 'cached_token' and advertised no authentication methods.",
        {
          code: "AUTH_METHOD_NOT_AVAILABLE",
          authenticationMethod: "cached_token",
          availableAuthenticationMethods: [],
        },
      ),
    );

    expect(mapped.message).toContain(
      "advertised no ACP authentication methods",
    );
    expect(mapped.message).not.toContain("listed above");
    expect(mapped.message).not.toContain("reported in the diagnostic above");
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

  it("defensively sanitizes malformed-output diagnostics before mapping", () => {
    const secret = "sk-malformed-output-123";
    const cause = new AcpProtocolError(
      `Invalid JSON from Grok ACP stdout: Bearer\t${secret}`,
    );
    const mapped = mapAcpError(cause);

    expect(cause.message).toContain("[REDACTED]");
    expect(cause.message).not.toContain(secret);
    expect(mapped.message).not.toContain(secret);
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
  it("preserves semicolon-separated Grok CLI stderr while sharing redaction", () => {
    const failure = new GrokCliError("process failed", {
      code: "GROK_CLI_PROCESS_EXIT",
      stderr: "first line\nAuthorization: Bearer sk-cli-secret\n",
    });

    expect(failure.stderr).toBe("first line; Authorization: Bearer [REDACTED]");
    expect(failure.stderr).not.toContain("sk-cli-secret");
  });

  it("classifies labeled multiline stderr before composing its inline form", () => {
    const failure = new GrokCliError("process failed", {
      code: "GROK_CLI_PROCESS_EXIT",
      stderr:
        "Authorization: Bearer sk-cli-secret\nError: authentication required",
    });
    const mapped = mapGrokExecError(failure);

    expect(failure.stderr).toContain("Error: authentication required");
    expect(failure.stderr).not.toContain("sk-cli-secret");
    expect(mapped).toBeInstanceOf(LoadAPIKeyError);
  });

  it.each([
    "2026-07-13T03:48:09Z ERROR grok::token: Login required",
    "token:\nError: authentication required",
  ])(
    "preserves and classifies authentication diagnostics after %s",
    (stderr) => {
      const failure = new GrokCliError("process failed", {
        code: "GROK_CLI_PROCESS_EXIT",
        stderr,
      });
      const mapped = mapGrokExecError(failure);

      expect(failure.stderr).toMatch(/Login required|authentication required/);
      expect(mapped).toBeInstanceOf(LoadAPIKeyError);
    },
  );

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
