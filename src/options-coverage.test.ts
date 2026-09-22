import { describe, expect, it } from "vitest";
import {
  grokBuildProviderOptionsSchema,
  grokBuildSettingsSchema,
  grokExecSettingsSchema,
  mergeGrokBuildSettings,
  mergeGrokExecSettings,
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
  alwaysApprove: true,
  dangerouslySkipPermissions: false,
} satisfies GrokBuildProviderOptions;

const coverage = {
  model: validOptions.model,
  reasoningEffort: validOptions.reasoningEffort,
  session: validOptions.session,
  permissionMode: validOptions.permissionMode,
  mcpServers: validOptions.mcpServers,
  maxTurns: validOptions.maxTurns,
  includeExtensionEvents: validOptions.includeExtensionEvents,
  alwaysApprove: validOptions.alwaysApprove,
  dangerouslySkipPermissions: validOptions.dangerouslySkipPermissions,
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
    [{ reasoningEffort: "ultra" }],
    [{ permissionMode: "unattended" }],
    [{ maxTurns: 0 }],
    [{ session: { id: "" } }],
    [{ mcpServers: [{ name: "bad", command: "", args: [], env: [] }] }],
  ])("rejects invalid options %#", (value) => {
    expect(grokBuildProviderOptionsSchema.safeParse(value).success).toBe(false);
  });
});

describe("Grok 1.x enum and session validation", () => {
  it.each([
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "bypassPermissions",
    "plan",
  ])("accepts permission mode %s", (permissionMode) => {
    expect(grokExecSettingsSchema.safeParse({ permissionMode }).success).toBe(
      true,
    );
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max"])(
    "accepts reasoning effort %s",
    (reasoningEffort) => {
      expect(
        grokExecSettingsSchema.safeParse({ reasoningEffort }).success,
      ).toBe(true);
    },
  );

  it.each([
    { id: "new-session" },
    { resume: "source-session" },
    { continue: true },
    { resume: "source-session", fork: true },
    { continue: true, fork: true },
    { resume: "source-session", fork: true, id: "named-fork" },
    { continue: true, fork: true, id: "named-fork" },
  ])("accepts valid session controls %#", (session) => {
    expect(grokExecSettingsSchema.safeParse({ session }).success).toBe(true);
  });

  it.each([
    { resume: "source-session", continue: true },
    { fork: true },
    { id: "invalid", resume: "source-session" },
    { id: "invalid", continue: true },
  ])("rejects invalid session controls %#", (session) => {
    expect(grokExecSettingsSchema.safeParse({ session }).success).toBe(false);
  });

  it("strictly validates filesystem capability fields", () => {
    expect(
      grokBuildSettingsSchema.safeParse({
        fileSystem: {
          readTextFile: true,
          writeTextFile: () => ({ content: "ok" }),
        },
      }).success,
    ).toBe(true);
    for (const fileSystem of [
      [],
      { readTextFile: "yes" },
      { writeTextFile: 1 },
      { unknown: true },
    ]) {
      expect(grokBuildSettingsSchema.safeParse({ fileSystem }).success).toBe(
        false,
      );
    }
  });

  it("accepts the explicit package-bin trust option", () => {
    expect(
      grokBuildSettingsSchema.safeParse({ allowPackageBin: true }).success,
    ).toBe(true);
    expect(
      grokExecSettingsSchema.safeParse({ allowPackageBin: false }).success,
    ).toBe(true);
  });
});

describe("settings merge semantics", () => {
  it("keeps top-level and nested defaults when overrides are undefined", () => {
    expect(
      mergeGrokBuildSettings(
        {
          cwd: "/default",
          permissionMode: "plan",
          timeouts: { requestMs: 1_000, terminateGraceMs: 50 },
        },
        {
          cwd: undefined,
          permissionMode: undefined,
          timeouts: { requestMs: undefined, promptMs: 2_000 },
        },
      ),
    ).toMatchObject({
      cwd: "/default",
      permissionMode: "plan",
      timeouts: {
        requestMs: 1_000,
        promptMs: 2_000,
        terminateGraceMs: 50,
      },
    });
  });

  it("preserves undefined environment entries as intentional unsets", () => {
    const merged = mergeGrokExecSettings(
      { env: { KEEP: "yes", REMOVE: "inherited" } },
      { env: { REMOVE: undefined } },
    );

    expect(merged.env).toEqual({ KEEP: "yes", REMOVE: undefined });
    expect(Object.hasOwn(merged.env ?? {}, "REMOVE")).toBe(true);
  });
});
