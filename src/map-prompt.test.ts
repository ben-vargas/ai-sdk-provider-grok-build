import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
  mapGrokBuildCallWarnings,
  mapGrokBuildPrompt,
  mapGrokExecCallWarnings,
  mapGrokExecPrompt,
} from "./map-prompt.js";

const prompt: LanguageModelV4CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

function warningFeatures(
  options: Partial<LanguageModelV4CallOptions>,
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
  ] satisfies Array<[string, Partial<LanguageModelV4CallOptions>]>)(
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
      { headers: { "user-agent": "ai/7.0.16" } },
    ],
    ["empty stop sequences", { stopSequences: [] }],
    ["both empty collections", { headers: {}, stopSequences: [] }],
  ] satisfies Array<[string, Partial<LanguageModelV4CallOptions>]>)(
    "does not warn for %s",
    (_label, options) => {
      expect(warningFeatures(options)).not.toContain("headers");
      expect(warningFeatures(options)).not.toContain("stopSequences");
    },
  );

  it("warns for a caller-supplied user-agent", () => {
    expect(
      warningFeatures({ headers: { "user-agent": "example/1.0 ai/7.0.16" } }),
    ).toContain("headers");
  });

  it("uses transport-neutral file-input warnings", async () => {
    const mapped = await mapGrokBuildPrompt([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data: "aW1hZ2U=" },
          },
        ],
      },
    ]);
    expect(mapped.warnings).toContainEqual(
      expect.objectContaining({
        feature: "image input",
        details: expect.stringContaining("This provider"),
      }),
    );
    const warning = mapped.warnings.find(
      (item) => "feature" in item && item.feature === "image input",
    );
    expect(
      warning && "details" in warning ? warning.details : "",
    ).not.toContain("CLI");
  });
});

describe("mapGrokExecPrompt", () => {
  it("maps headless-specific unsupported settings", () => {
    const warnings = mapGrokExecCallWarnings({
      prompt,
      maxOutputTokens: 1,
      temperature: 0,
      topP: 0,
      topK: 1,
      presencePenalty: 0,
      frequencyPenalty: 0,
      seed: 1,
      stopSequences: ["END"],
      headers: { authorization: "Bearer secret" },
      tools: [
        {
          type: "function",
          name: "demo",
          inputSchema: { type: "object" },
        },
      ],
      toolChoice: { type: "none" },
    });
    expect(
      warnings.flatMap((warning) =>
        "feature" in warning ? [warning.feature] : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        "maxOutputTokens",
        "temperature",
        "topP",
        "topK",
        "presencePenalty",
        "frequencyPenalty",
        "seed",
        "stopSequences",
        "headers",
        "tools",
        "toolChoice",
      ]),
    );
  });

  it("adds guidance only for schema-less JSON", async () => {
    const schemaLess = await mapGrokExecPrompt(prompt, { type: "json" });
    expect(schemaLess.prompt).toContain("Return only valid JSON");
    expect(schemaLess.warnings).toContainEqual(
      expect.objectContaining({ feature: "schema-less JSON responseFormat" }),
    );
    const schemaBacked = await mapGrokExecPrompt(prompt, {
      type: "json",
      schema: { type: "object" },
    });
    expect(schemaBacked.prompt).not.toContain("[OUTPUT FORMAT]");
  });
});
