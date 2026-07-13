import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { mapGrokBuildCallWarnings } from "./map-prompt.js";

const prompt: LanguageModelV3CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function warningFeatures(
  options: Partial<LanguageModelV3CallOptions>,
): string[] {
  return mapGrokBuildCallWarnings({ prompt, ...options }).flatMap((warning) =>
    "feature" in warning ? [warning.feature] : [],
  );
}

describe("mapGrokBuildCallWarnings", () => {
  it.each([
    ["maxOutputTokens", { maxOutputTokens: 1 }],
    ["temperature", { temperature: 0 }],
    ["topP", { topP: 0 }],
    ["topK", { topK: 1 }],
    ["presencePenalty", { presencePenalty: 0 }],
    ["frequencyPenalty", { frequencyPenalty: 0 }],
    ["stopSequences", { stopSequences: ["END"] }],
    ["seed", { seed: 0 }],
    ["headers", { headers: { "x-example": "set" } }],
  ] satisfies Array<[string, Partial<LanguageModelV3CallOptions>]>)(
    "warns for a supplied %s setting",
    (feature, options) => {
      expect(warningFeatures(options)).toContain(feature);
    },
  );

  it.each([
    ["absent headers and stop sequences", {}],
    ["empty headers", { headers: {} }],
    [
      "the AI SDK generated user-agent",
      { headers: { "user-agent": "ai/6.0.224" } },
    ],
    ["empty stop sequences", { stopSequences: [] }],
    ["both empty collections", { headers: {}, stopSequences: [] }],
  ] satisfies Array<[string, Partial<LanguageModelV3CallOptions>]>)(
    "does not warn for %s",
    (_label, options) => {
      expect(warningFeatures(options)).not.toContain("headers");
      expect(warningFeatures(options)).not.toContain("stopSequences");
    },
  );

  it("warns for a caller-supplied user-agent", () => {
    expect(
      warningFeatures({ headers: { "user-agent": "example/1.0 ai/6.0.224" } }),
    ).toContain("headers");
  });
});
