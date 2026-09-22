import { describe, expect, it } from "vitest";
import {
  redactSensitiveData,
  redactSensitiveDiagnosticData,
  redactSensitiveText,
} from "./redact.js";

describe("redactSensitiveData", () => {
  it("redacts credential fields, authorization headers, environment values, and inline secrets", () => {
    const redacted = redactSensitiveData({
      token: "top-secret",
      nested: { apiKey: "api-secret", safe: "visible" },
      headers: [
        { name: "Authorization", value: "Bearer header-secret" },
        { name: "X-Trace", value: "also-sensitive-header-value" },
      ],
      env: { MODE: "private-env-value" },
      command: "XAI_API_KEY=command-secret tool --password=pass-secret",
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "top-secret",
      "api-secret",
      "header-secret",
      "also-sensitive-header-value",
      "private-env-value",
      "command-secret",
      "pass-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted).toMatchObject({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "visible" },
    });
  });

  it("distinguishes ordinary authentication prose from credential-shaped values", () => {
    const redacted = redactSensitiveData(
      "Basic auth rejected; Bearer market rejected; " +
        "Bearer\tsk-secret-123; Authorization: Basic dXNlcjpwYXNz",
    );

    expect(redacted).toContain("Basic auth rejected");
    expect(redacted).toContain("Bearer market rejected");
    expect(redacted).not.toContain("sk-secret-123");
    expect(redacted).not.toContain("dXNlcjpwYXNz");
    expect(
      typeof redacted === "string" ? redacted.match(/\[REDACTED\]/g) : [],
    ).toHaveLength(2);
  });

  it("redacts quoted JSON keys, multiline labels, and complete authorization values", () => {
    const secrets = [
      "xai-multiline-secret",
      "token-secret",
      "digest-secret",
      "negotiate-secret",
      "aws-secret",
      "json-api-secret",
      "hunter2",
    ];
    const redacted = redactSensitiveText(
      [
        "api_key:\n  xai-multiline-secret",
        "Authorization:\nToken token-secret",
        'Authorization: Digest username="me", response="digest-secret"',
        "Authorization: Negotiate negotiate-secret",
        "Authorization: AWS4-HMAC-SHA256 Credential=aws-secret, Signature=sig",
        '{"api_key":"json-api-secret","password":"hunter2"}',
      ].join("\n"),
    );

    for (const secret of secrets) expect(redacted).not.toContain(secret);
    expect(redacted).toContain("api_key:\n  [REDACTED]");
    expect(redacted).toContain("Authorization:\nToken [REDACTED]");
    expect(redacted).toContain("Authorization: Digest [REDACTED]");
    expect(redacted).toContain("Authorization: Negotiate [REDACTED]");
    expect(redacted).toContain("Authorization: AWS4-HMAC-SHA256 [REDACTED]");
    expect(redacted).toContain('"api_key":"[REDACTED]"');
    expect(redacted).toContain('"password":"[REDACTED]"');
  });

  it("redacts complete labeled lines and multiline private-key blocks", () => {
    const redacted = redactSensitiveText(
      [
        "Cookie: session=abc; csrf=cookie-secret",
        "password:",
        "correct horse battery staple",
        "private_key:",
        "-----BEGIN PRIVATE KEY-----",
        "private-key-body",
        "-----END PRIVATE KEY-----",
        "safe diagnostic",
      ].join("\n"),
    );

    expect(redacted).not.toContain("cookie-secret");
    expect(redacted).not.toContain("correct horse battery staple");
    expect(redacted).not.toContain("private-key-body");
    expect(redacted).toContain("Cookie: [REDACTED]");
    expect(redacted).toContain("password:\n[REDACTED]");
    expect(redacted).toContain("private_key:\n[REDACTED]");
    expect(redacted).toContain("safe diagnostic");
  });

  it.each(['"', "'"])(
    "redacts a multiline %s-quoted value that starts after its label",
    (quote) => {
      const redacted = redactSensitiveText(
        [
          "password:",
          `  ${quote}separate-quote-secret-part-1`,
          `  separate-quote-secret-part-2${quote}`,
          "safe: visible",
        ].join("\n"),
      );

      expect(redacted).not.toContain("separate-quote-secret");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("safe: visible");
    },
  );

  it.each(['"', "'"])(
    "redacts the first line of a separately opened %s-quoted authorization value",
    (quote) => {
      const redacted = redactSensitiveText(
        [
          "Authorization:",
          `  ${quote}authorization-first-line-secret`,
          `  authorization-second-line-secret${quote}`,
          "safe: visible",
        ].join("\n"),
      );

      expect(redacted).not.toContain("authorization-first-line-secret");
      expect(redacted).not.toContain("authorization-second-line-secret");
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).toContain("safe: visible");
    },
  );

  it("retains ordinary scheme prose while keeping standalone heuristics unchanged", () => {
    expect(
      redactSensitiveText("Basic auth rejected; Bearer market rejected"),
    ).toBe("Basic auth rejected; Bearer market rejected");
  });

  it("preserves aggressive redaction for arbitrary code-like payload strings", () => {
    expect(redactSensitiveData("const token = getToken();")).toBe(
      "const token = [REDACTED]",
    );
  });

  it("redacts and hard-bounds public diagnostic data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const data = redactSensitiveDiagnosticData({
      authorization: "Bearer sk-diagnostic-secret",
      leading: "preserved",
      payload: "x".repeat(100_000),
      wide: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `field-${String(index)}`,
          `value-${String(index)}`,
        ]),
      ),
      deep: {
        one: { two: { three: { four: { five: { six: { seven: {} } } } } } },
      },
      cyclic,
    });
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(serialized).toContain("preserved");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-diagnostic-secret");
    expect(serialized).toMatch(/TRUNCATED|__truncated__/);
  });

  it("accounts exactly for nested and Unicode diagnostic data", () => {
    const data = redactSensitiveDiagnosticData({
      prefix: "visible",
      nested: {
        unicode: "🚀".repeat(300),
        payload: "x".repeat(20_000),
      },
      suffix: "retained when space permits",
    });
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(data).toMatchObject({ prefix: "visible", nested: {} });
    expect(serialized).toMatch(/TRUNCATED|__truncated__/);

    const exact = redactSensitiveDiagnosticData(
      Array.from({ length: 8 }, () => "x".repeat(5_000)),
    );
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(8 * 1024);
  });

  it.each([
    { bytes: 8_183, finalLength: 178 },
    { bytes: 8_192, finalLength: 187 },
  ])(
    "preserves a $bytes-byte array without reserving a marker",
    ({ bytes, finalLength }) => {
      const source = [
        ...Array.from({ length: 63 }, () => "x".repeat(124)),
        "y".repeat(finalLength),
      ];
      expect(Buffer.byteLength(JSON.stringify(source), "utf8")).toBe(bytes);

      const result = redactSensitiveDiagnosticData(source);

      expect(result).toEqual(source);
      expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBe(bytes);
    },
  );

  it("uses only markers that fit tiny nested budgets", () => {
    const source: Record<string, unknown> = {};
    for (let index = 0; index < 7; index++) {
      source[`${String(index)}${"p".repeat(127)}`] = "x".repeat(5_000);
    }
    const markerOnlyKey = "m".repeat(61);
    source[markerOnlyKey] = "too-large".repeat(1_000);
    const withMarker = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;

    expect(withMarker[markerOnlyKey]).toMatch(/\[TRUNCATED\]$/);
    expect(Buffer.byteLength(JSON.stringify(withMarker), "utf8")).toBe(
      8 * 1024,
    );

    delete source[markerOnlyKey];
    const omittedKey = "o".repeat(62);
    source[omittedKey] = "too-large".repeat(1_000);
    const withoutRoom = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;

    expect(Object.hasOwn(withoutRoom, omittedKey)).toBe(true);
    expect(withoutRoom[omittedKey]).toMatch(/\[TRUNCATED\]$/);
    expect(withoutRoom.__truncated__).toBeUndefined();
    expect(
      Buffer.byteLength(JSON.stringify(withoutRoom), "utf8"),
    ).toBeLessThanOrEqual(8 * 1024);
  });

  it("propagates nested truncation when the child marker cannot fit", () => {
    const source: Record<string, unknown> = {};
    for (let index = 0; index < 8; index++) {
      source[`k${String(index)}`] = "x".repeat(1_000);
    }
    source.pad = "p".repeat(107);
    source.z = [1, 2, 3];

    const result = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(result);

    expect(result.z).toBeUndefined();
    expect(result.__truncated__).toBe(true);
    expect(serialized).toContain("__truncated__");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it("preserves colliding sanitized keys, __proto__, and reserved metadata", () => {
    const source = JSON.parse(
      '{"Authorization: Bearer first-secret":"first","Authorization: Bearer second-secret":"second","__proto__":{"safe":true},"__truncated__":"agent-value"}',
    ) as Record<string, unknown>;
    const data = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(data);
    const authorizationKeys = keys.filter((key) =>
      key.startsWith("Authorization: Bearer [REDACTED]"),
    );

    expect(authorizationKeys).toEqual([
      "Authorization: Bearer [REDACTED]",
      "Authorization: Bearer [REDACTED]#2",
    ]);
    expect(authorizationKeys.map((key) => data[key])).toEqual([
      "first",
      "second",
    ]);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.hasOwn(data, "__proto__")).toBe(true);
    expect(data.__proto__).toEqual({ safe: true });
    expect(data.__truncated__).toBeUndefined();
    expect(data["__truncated__#2"]).toBe("agent-value");
  });

  it("stops before reading the 65th diagnostic property", () => {
    const source: Record<string, unknown> = {};
    for (let index = 0; index < 64; index++) {
      source[`field-${String(index)}`] = index;
    }
    let getterReads = 0;
    Object.defineProperty(source, "later", {
      enumerable: true,
      get() {
        getterReads++;
        throw new Error("the 65th property must not be read");
      },
    });

    const data = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;

    expect(getterReads).toBe(0);
    expect(data.__truncated__).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThanOrEqual(
      8 * 1024,
    );
  });

  it("bounds inherited-property enumeration", () => {
    const prototype: Record<string, unknown> = {};
    for (let index = 0; index < 1_000; index++) {
      prototype[`inherited-${String(index)}`] = index;
    }
    const source = Object.create(prototype) as Record<string, unknown>;
    source.own = "visible";

    expect(redactSensitiveDiagnosticData(source)).toEqual({ own: "visible" });
  });

  it("does not read getters for values that are redacted wholesale", () => {
    const source: Record<string, unknown> = { safe: "visible" };
    Object.defineProperty(source, "authorization", {
      enumerable: true,
      get() {
        throw new Error("authorization getter must not run");
      },
    });
    const env: Record<string, unknown> = {};
    Object.defineProperty(env, "XAI_API_KEY", {
      enumerable: true,
      get() {
        throw new Error("environment getter must not run");
      },
    });
    source.env = env;

    expect(redactSensitiveDiagnosticData(source)).toMatchObject({
      safe: "visible",
      authorization: "[REDACTED]",
      env: { XAI_API_KEY: "[REDACTED]" },
    });
  });

  it("does not invoke diagnostic accessors while classifying named values or arrays", () => {
    const named: Record<string, unknown> = { value: "named-secret" };
    Object.defineProperty(named, "name", {
      enumerable: true,
      get() {
        throw new Error("name getter must not run");
      },
    });
    const headers: unknown[] = [];
    Object.defineProperty(headers, "0", {
      enumerable: true,
      get() {
        throw new Error("array getter must not run");
      },
    });

    const data = redactSensitiveDiagnosticData({ named, headers });
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain("named-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("[TRUNCATED]");
  });

  it.each([
    {
      input: "Authorization: Bearer\neyJfolded-secret",
      secret: "eyJfolded-secret",
    },
    {
      input: "Authorization:\nBearer\neyJtwice-folded-secret",
      secret: "eyJtwice-folded-secret",
    },
    {
      input:
        'Authorization:\nDigest username="me",\nresponse="digest-folded-secret"',
      secret: "digest-folded-secret",
    },
  ])(
    "redacts folded authorization in diagnostic strings",
    ({ input, secret }) => {
      const serialized = JSON.stringify(redactSensitiveDiagnosticData(input));

      expect(serialized).not.toContain(secret);
      expect(serialized).toContain("[REDACTED]");
    },
  );

  it("redacts standalone private-key blocks in diagnostic strings", () => {
    const serialized = JSON.stringify(
      redactSensitiveDiagnosticData(
        "-----BEGIN PRIVATE KEY-----\nprivate-key-body-secret\n-----END PRIVATE KEY-----",
      ),
    );

    expect(serialized).not.toContain("private-key-body-secret");
    expect(serialized).toContain("[REDACTED]");
  });

  it.each([
    "api_key:\npassword:\nchained-secret",
    "Authorization:\npassword:\nchained-secret",
    "Authorization: Digest\nresponse=\ndigest-secret",
    'Authorization: Digest\nresponse="\nmultiline-digest-secret\n"',
    "Authorization: Digest foo=bar\nsig~v=digest-secret",
    "-----BEGIN PRIVATE KEY-----body-----END PRIVATE KEY----- api_key:\nafter-pem-secret",
    'password: "\nbody" api_key:\nafter-quote-secret',
  ])("redacts chained multiline sensitive state", (input) => {
    const text = redactSensitiveText(input);
    const structured = JSON.stringify(redactSensitiveDiagnosticData(input));

    expect(text).not.toMatch(
      /(?:chained|digest|multiline-digest|after-pem|after-quote)-secret/,
    );
    expect(structured).not.toMatch(
      /(?:chained|digest|multiline-digest|after-pem|after-quote)-secret/,
    );
  });

  it("redacts authorization after another assignment in diagnostic data", () => {
    const serialized = JSON.stringify(
      redactSensitiveDiagnosticData(
        "Cookie: absent; Authorization:\nCustom short-secret",
      ),
    );

    expect(serialized).not.toContain("short-secret");
    expect(serialized).toContain("Custom [REDACTED]");
  });

  it.each(["|", ">", "|-", ">+", "|2", ">2-", "|+2"])(
    "redacts YAML-style sensitive blocks using %s",
    (indicator) => {
      const input = `password: ${indicator}\n  yaml-secret\nsafe: visible`;
      const text = redactSensitiveText(input);
      const structured = JSON.stringify(redactSensitiveDiagnosticData(input));

      expect(text).not.toContain("yaml-secret");
      expect(text).toContain("safe: visible");
      expect(structured).not.toContain("yaml-secret");
      expect(structured).toContain("safe: visible");
    },
  );

  it("bounds diagnostic key and name classification work", () => {
    const longKey = "k".repeat(2_000_000);
    const source: Record<string, unknown> = {
      named: {
        name: "n".repeat(2_000_000),
        value: "name-associated-secret",
      },
    };
    Object.defineProperty(source, longKey, {
      enumerable: true,
      get() {
        throw new Error(
          "a conservatively redacted long-key getter must not run",
        );
      },
    });

    const data = redactSensitiveDiagnosticData(source) as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain("name-associated-secret");
    expect(serialized).toContain("[REDACTED]");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8 * 1024);
  });

  it.each([
    `https://alice:${"url-password-secret".repeat(300)}@example.test/path`,
    `https://${"url-username-secret".repeat(300)}:password@example.test/path`,
    `https://:${"url-password-secret".repeat(300)}@example.test/path`,
  ])("redacts URL userinfo cut by the diagnostic work window", (input) => {
    const data = redactSensitiveDiagnosticData(input);
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain("url-password-secret");
    expect(serialized).not.toContain("url-username-secret");
    expect(serialized).toContain("https://[REDACTED]:[REDACTED]");
    expect(serialized).toContain("TRUNCATED");
  });

  it("redacts exact sensitive names in name/value records", () => {
    for (const name of ["token", "id_token", "auth_token", "bearer_token"]) {
      const serialized = JSON.stringify(
        redactSensitiveDiagnosticData({ name, value: "named-secret" }),
      );
      expect(serialized).not.toContain("named-secret");
      expect(serialized).toContain("[REDACTED]");
    }
  });

  it.each([
    "api_\u0000key:\ncontrol-secret",
    "Authorization: Cus\u0000tom\ncontrol-secret",
    "Authorization: Digest foo=bar\nsig\u0000~v=control-secret",
    "-----BEGIN PRI\u0000VATE KEY-----\ncontrol-secret",
  ])("uses a control-stripped credential state probe", (input) => {
    const text = redactSensitiveText(input);
    const structured = JSON.stringify(redactSensitiveDiagnosticData(input));

    expect(text).not.toContain("control-secret");
    expect(structured).not.toContain("control-secret");
  });

  it.each([
    "api_\u001b[31mkey: ansi-secret",
    "-----BEGIN PRI\u001b[31mVATE KEY-----\nansi-secret\n-----END PRIVATE KEY-----",
  ])("uses an ANSI-stripped credential state probe", (input) => {
    const text = redactSensitiveText(input);
    const structured = JSON.stringify(redactSensitiveDiagnosticData(input));

    expect(text).not.toContain("ansi-secret");
    expect(structured).not.toContain("ansi-secret");
  });

  it("canonicalizes ANSI and controls in diagnostic keys and names", () => {
    const data = redactSensitiveDiagnosticData({
      "api_\u001b[31mkey": "ansi-key-secret",
      "api_\u0000key": "control-key-secret",
      named: {
        name: "api_\u001b[31mkey",
        value: "ansi-name-secret",
      },
      controlNamed: {
        name: "api_\u0000key",
        value: "control-name-secret",
      },
    });
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain("ansi-key-secret");
    expect(serialized).not.toContain("ansi-name-secret");
    expect(serialized).not.toContain("control-key-secret");
    expect(serialized).not.toContain("control-name-secret");
    expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it("bounds work for very large diagnostic strings without leaking cut secrets", () => {
    const secret = "xai-secret-inside-an-unclosed-value";
    const data = redactSensitiveDiagnosticData(
      `api_key: "${secret.repeat(600_000)}`,
    );
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(1024);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain("TRUNCATED");
  });
});
