import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redact.js";

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
});
