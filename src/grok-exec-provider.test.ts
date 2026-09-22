import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createGrokExec, grokExec } from "./grok-exec-provider.js";

describe("createGrokExec", () => {
  it("creates callable V4 model factories with merged defaults", () => {
    const provider = createGrokExec({
      defaultSettings: { defaultModel: "grok-4.6", maxTurns: 2 },
    });
    expect(provider().modelId).toBe("grok-4.6");
    expect(provider.languageModel("grok-4.5")).toMatchObject({
      provider: "grok-build",
      specificationVersion: "v4",
      modelId: "grok-4.5",
    });
    expect(grokExec("grok-4.6").modelId).toBe("grok-4.6");
  });

  it("rejects invalid settings and unsupported model families", () => {
    expect(() =>
      createGrokExec({ defaultSettings: { maxTurns: 0 } }),
    ).toThrow();
    expect(() => grokExec.embeddingModel("embed")).toThrow(NoSuchModelError);
    expect(() => grokExec.imageModel("image")).toThrow(NoSuchModelError);
    expect(() => grokExec.languageModel("   ")).toThrow(NoSuchModelError);
    expect(() => Reflect.construct(grokExec as never, [])).toThrow(
      "new keyword",
    );
  });
});
