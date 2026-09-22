import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createGrokBuild, grokBuild } from "./grok-build-provider.js";

describe("createGrokBuild", () => {
  it("creates callable, languageModel, and chat V4 model factories", () => {
    const provider = createGrokBuild({ defaultModel: "grok-4.5" });
    expect(provider.specificationVersion).toBe("v4");
    expect(provider().modelId).toBe("grok-4.5");
    expect(provider.languageModel("grok-composer-2.5-fast")).toMatchObject({
      specificationVersion: "v4",
      provider: "grok-build",
      modelId: "grok-composer-2.5-fast",
      supportedUrls: {},
    });
    expect(provider.chat("grok-4.5").modelId).toBe("grok-4.5");
    expect(grokBuild().modelId).toBe("default");
  });

  it("rejects unsupported provider model families", () => {
    expect(() => grokBuild.embeddingModel("embed")).toThrow(NoSuchModelError);
    expect(() => grokBuild.imageModel("image")).toThrow(NoSuchModelError);
  });

  it("strictly validates provider settings", () => {
    expect(() =>
      createGrokBuild({
        timeouts: { requestMs: 0 },
      }),
    ).toThrow();
    expect(() => grokBuild.languageModel("   ")).toThrow(NoSuchModelError);
    expect(() => Reflect.construct(grokBuild as never, [])).toThrow(
      "new keyword",
    );
  });
});
