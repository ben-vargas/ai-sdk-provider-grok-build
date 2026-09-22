import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createGrokAgent, grokAgent } from "./grok-agent-provider.js";

describe("createGrokAgent", () => {
  it("creates callable pooled V4 model factories and supports async teardown", async () => {
    const provider = createGrokAgent({
      defaultSettings: { defaultModel: "grok-4.6", reasoningEffort: "high" },
    });
    expect(provider().modelId).toBe("grok-4.6");
    expect(provider.languageModel("grok-4.5")).toMatchObject({
      provider: "grok-build",
      specificationVersion: "v4",
      modelId: "grok-4.5",
    });
    await provider.close();
    await provider[Symbol.asyncDispose]();
  });

  it("rejects invalid settings and unsupported model families", () => {
    expect(() =>
      createGrokAgent({
        defaultSettings: { reasoningEffort: "ultra" as never },
      }),
    ).toThrow();
    expect(() => grokAgent.embeddingModel("embed")).toThrow(NoSuchModelError);
    expect(() => grokAgent.imageModel("image")).toThrow(NoSuchModelError);
    expect(() => grokAgent.languageModel("   ")).toThrow(NoSuchModelError);
    expect(() => Reflect.construct(grokAgent as never, [])).toThrow(
      "new keyword",
    );
    expect(() => createGrokAgent({ maxClients: 0 })).toThrow(
      "positive integer",
    );
    expect(() => createGrokAgent({ maxClients: 1.5 })).toThrow(
      "positive integer",
    );
  });
});
