import { describe, expect, it } from "vitest";
import {
  grokBuildProviderOptionsSchema,
  type GrokBuildProviderOptions,
} from "./settings.js";

const validOptions = {
  model: "grok-4.5",
  reasoningEffort: "medium",
  session: { id: "session-1" },
  permissionMode: "bypassPermissions",
  mcpServers: [
    {
      name: "local",
      command: "node",
      args: ["server.mjs"],
      env: [{ name: "MODE", value: "test" }],
    },
  ],
  maxTurns: 4,
  includeExtensionEvents: true,
} satisfies GrokBuildProviderOptions;

const coverage = {
  model: validOptions.model,
  reasoningEffort: validOptions.reasoningEffort,
  session: validOptions.session,
  permissionMode: validOptions.permissionMode,
  mcpServers: validOptions.mcpServers,
  maxTurns: validOptions.maxTurns,
  includeExtensionEvents: validOptions.includeExtensionEvents,
} satisfies Record<keyof Required<GrokBuildProviderOptions>, unknown>;

describe("grok-build provider options coverage", () => {
  for (const [name, value] of Object.entries(coverage)) {
    it(`validates ${name}`, () => {
      expect(
        grokBuildProviderOptionsSchema.safeParse({ [name]: value }).success,
      ).toBe(true);
    });
  }

  it("rejects unknown fields", () => {
    const result = grokBuildProviderOptionsSchema.safeParse({
      model: "grok-4.5",
      transport: "streaming-json",
    });
    expect(result.success).toBe(false);
  });

  it("rejects conflicting session IDs", () => {
    const result = grokBuildProviderOptionsSchema.safeParse({
      session: { id: "one", resume: "two" },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    [{ reasoningEffort: "xhigh" }],
    [{ permissionMode: "acceptEdits" }],
    [{ maxTurns: 0 }],
    [{ session: { id: "" } }],
    [{ mcpServers: [{ name: "bad", command: "", args: [], env: [] }] }],
  ])("rejects invalid options %#", (value) => {
    expect(grokBuildProviderOptionsSchema.safeParse(value).success).toBe(false);
  });
});
